import { randomUUID } from "node:crypto";
import { NEW_DEVICE_CHAIN, ZatcaApi, createCsr, issueInvoice, type DocumentType, type InvoiceKind, type ZatcaEnv } from "@mithqal/zatca";
import { BusinessError, one, withTenant, type Db } from "../db.js";
import { audit, type Actor } from "./core.js";

const SAMPLES: { kind: InvoiceKind; documentType: DocumentType }[] = [
  { kind: "STANDARD", documentType: "INVOICE" },
  { kind: "STANDARD", documentType: "CREDIT_NOTE" },
  { kind: "STANDARD", documentType: "DEBIT_NOTE" },
  { kind: "SIMPLIFIED", documentType: "INVOICE" },
  { kind: "SIMPLIFIED", documentType: "CREDIT_NOTE" },
  { kind: "SIMPLIFIED", documentType: "DEBIT_NOTE" },
];

/**
 * One-click ZATCA onboarding for a POS terminal (EGS unit):
 * CSR from the terminal's own key → compliance CSID (OTP from the Fatoora portal) → the six compliance
 * checks → production CSID, stored on the terminal. HTTP calls run outside database transactions.
 */
export async function onboardTerminal(db: Db, actor: Actor, terminalId: string, otp: string, env: ZatcaEnv, fetchImpl: typeof fetch = fetch) {
  const ctx = await withTenant(db, actor.tenantId, async (tx) => {
    const t = await one<{ id: string; prefix: string; name: string; private_key_pem: string; public_key_pem: string }>(
      tx, "SELECT id, prefix, name, private_key_pem, public_key_pem FROM pos_terminals WHERE id=$1", [terminalId],
    );
    const c = await one<{ name_ar: string; name_en: string | null; vat_number: string | null; cr_number: string | null; street: string | null; building_number: string | null; district: string | null; city: string | null; postal_code: string | null; country: string; industry: string }>(
      tx, "SELECT * FROM companies LIMIT 1",
    );
    const b = await one<{ name: string }>(tx, "SELECT b.name FROM branches b JOIN pos_terminals t ON t.branch_id=b.id WHERE t.id=$1", [terminalId]);
    return { t, c, branch: b.name };
  });
  const { t, c } = ctx;
  if (c.country !== "SA") throw new BusinessError("ربط ZATCA للمنشآت السعودية فقط");
  if (!c.vat_number) throw new BusinessError("أضف الرقم الضريبي أولًا");
  if (!c.street || !c.city || !c.building_number || !c.postal_code) throw new BusinessError("أكمل العنوان الوطني للمنشأة (الشارع، رقم المبنى، المدينة، الرمز البريدي) قبل الربط");

  const api = new ZatcaApi(env, fetchImpl);
  const setError = (msg: string) =>
    withTenant(db, actor.tenantId, (tx) => tx.query("UPDATE pos_terminals SET zatca_last_error=$1 WHERE id=$2", [msg, terminalId]));
  try {
    const csr = await createCsr(t.private_key_pem, {
      env,
      commonName: `MITHQAL-${t.prefix}-${c.vat_number}`,
      organization: c.name_en || c.name_ar,
      organizationUnit: ctx.branch,
      vatNumber: c.vat_number,
      serial: `1-Mithqal|2-1.0|3-${t.id}`,
      invoiceTypes: "1100",
      address: c.city,
      businessCategory: c.industry,
    });
    const ccsid = await api.complianceCsid(csr, otp);
    const keys = { privateKeyPem: t.private_key_pem, publicKeyPem: t.public_key_pem, certificate: ccsid.binarySecurityToken };
    const seller = {
      name: c.name_ar, vatNumber: c.vat_number, crNumber: c.cr_number ?? undefined,
      address: { street: c.street, buildingNumber: c.building_number, district: c.district ?? c.city, city: c.city, postalCode: c.postal_code, countryCode: "SA" },
    };
    const buyer = {
      name: "عميل اختبار الامتثال", vatNumber: "300000000000003",
      address: { street: "King Fahd Road", buildingNumber: "1234", district: "Al Olaya", city: "Riyadh", postalCode: "12211", countryCode: "SA" },
    };
    let chain = NEW_DEVICE_CHAIN;
    const checks: { type: string; status: number; result: string; errors: string[] }[] = [];
    for (const s of SAMPLES) {
      const now = new Date().toISOString();
      const uuid = randomUUID();
      const note = s.documentType !== "INVOICE";
      const doc = issueInvoice(
        {
          kind: s.kind, documentType: s.documentType, number: `CMP-${checks.length + 1}`, uuid,
          issueDate: now.slice(0, 10), issueTime: now.slice(11, 19), timestamp: now, currency: "SAR",
          seller, buyer: s.kind === "STANDARD" ? buyer : undefined, paymentMeansCode: "10",
          billingReference: note ? "CMP-1" : undefined, reason: note ? "Compliance check" : undefined,
          lines: [{ id: 1, name: "Compliance item", quantity: "1", unitPrice: "100.00", lineNet: "100.00", taxPercent: "15", taxAmount: "15.00" }],
          totals: { lineExtension: "100.00", taxExclusive: "100.00", taxTotal: "15.00", taxInclusive: "115.00", allowanceTotal: "0.00", payable: "115.00" },
        },
        chain,
        keys,
      );
      chain = doc.nextChain;
      const r = await api.complianceCheck(ccsid, { hash: doc.hash, uuid, xml: doc.xml });
      const body = r.body as { reportingStatus?: string; clearanceStatus?: string; validationResults?: { errorMessages?: { code: string; message: string }[] } };
      checks.push({
        type: `${s.kind}/${s.documentType}`,
        status: r.status,
        result: body.reportingStatus ?? body.clearanceStatus ?? "UNKNOWN",
        errors: (body.validationResults?.errorMessages ?? []).map((e) => `${e.code}: ${e.message}`),
      });
    }
    const failed = checks.filter((x) => x.status >= 400 || x.errors.length);
    if (failed.length) {
      await setError(`Compliance checks failed: ${failed.map((f) => f.type).join(", ")}`);
      return { onboarded: false, checks };
    }
    const pcsid = await api.productionCsid(ccsid);
    await withTenant(db, actor.tenantId, async (tx) => {
      await tx.query(
        `UPDATE pos_terminals SET zatca_env=$1, zatca_ccsid_token=$2, zatca_ccsid_secret=$3, zatca_pcsid_token=$4, zatca_pcsid_secret=$5,
                zatca_status='ONBOARDED', zatca_onboarded_at=now(), zatca_last_error=NULL WHERE id=$6`,
        [env, ccsid.binarySecurityToken, ccsid.secret, pcsid.binarySecurityToken, pcsid.secret, terminalId],
      );
      await audit(tx, actor, "terminal.zatca_onboarded", "pos_terminal", terminalId, { env, checks: checks.length });
    });
    return { onboarded: true, env, checks };
  } catch (e) {
    await setError((e as Error).message);
    throw e instanceof BusinessError ? e : new BusinessError(`فشل الربط مع ZATCA: ${(e as Error).message}`);
  }
}
