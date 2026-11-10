/**
 * Electronic tax documents, dispatched by the company's country pack:
 *   SA → ZATCA Phase 2 (UBL 2.1, signed, ICV/PIH chain; reporting for B2C, clearance for B2B)
 *   EG → ETA e-receipt (canonical JSON, SHA-256 uuid chained by previousUUID)
 * The device chain is advanced in the same transaction as the business document.
 */
import { Money } from "@mithqal/money";
import type { PaymentMethod } from "@mithqal/domain";
import { issueInvoice, type Party, type UblLine } from "@mithqal/zatca";
import { buildReceipt, receiptShareUrl, sealReceipt } from "@mithqal/eta";
import { BusinessError, maybeOne, type Tx } from "../db.js";

export interface CompanyRow {
  name_ar: string;
  vat_number: string | null;
  cr_number: string | null;
  street: string | null;
  building_number: string | null;
  district: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  currency: string;
  prices_include_tax: boolean;
  allow_negative_stock: boolean;
}

export interface TerminalRow {
  id: string;
  branch_id: string;
  warehouse_id: string;
  prefix: string;
  invoice_seq: string;
  icv: string;
  last_hash: string;
  private_key_pem: string;
  public_key_pem: string;
}

export interface EDocLine {
  lineNo: number;
  itemId: string;
  name: string;
  quantity: Money;
  unitNet: Money;
  net: Money;
  taxPercent: Money;
  tax: Money;
  gross: Money;
  taxCategory: "S" | "Z" | "E" | "O";
}

export interface EDocInput {
  tenantId: string;
  terminal: TerminalRow;
  company: CompanyRow;
  invoiceId: string;
  number: string;
  seq: number;
  kind: "SIMPLIFIED" | "STANDARD";
  documentType: "INVOICE" | "CREDIT_NOTE";
  ts: { date: string; time: string; timestamp: string };
  buyer?: Party;
  paymentMethod: PaymentMethod;
  lines: EDocLine[];
  totals: { net: Money; tax: Money; gross: Money };
  original?: { invoiceId: string; number: string };
  reason?: string;
}

const ZATCA_PAYMENT_MEANS: Record<PaymentMethod, string> = { CASH: "10", CARD: "48", CREDIT: "30" };
const ETA_PAYMENT: Record<PaymentMethod, "C" | "V" | "O"> = { CASH: "C", CARD: "V", CREDIT: "O" };

function zatcaSeller(c: CompanyRow): Party {
  if (!c.vat_number) throw new BusinessError("أضف الرقم الضريبي للمنشأة قبل إصدار الفواتير");
  return {
    name: c.name_ar,
    vatNumber: c.vat_number,
    crNumber: c.cr_number ?? undefined,
    address: c.street
      ? { street: c.street, buildingNumber: c.building_number ?? "", district: c.district ?? "", city: c.city ?? "", postalCode: c.postal_code ?? "", countryCode: c.country }
      : undefined,
  };
}

export async function issueEDocument(tx: Tx, d: EDocInput): Promise<void> {
  let doc: { authority: "ZATCA" | "ETA"; mode: string; icv: number; pih: string; hash: string; signature: string; qr: string; body: string };

  if (d.company.country === "SA") {
    const lines: UblLine[] = d.lines.map((l) => ({
      id: l.lineNo, name: l.name, quantity: l.quantity.toString(), unitPrice: l.unitNet.toFixed(2),
      lineNet: l.net.toFixed(2), taxPercent: l.taxPercent.toFixed(2), taxAmount: l.tax.toFixed(2), taxCategory: l.taxCategory,
    }));
    const signed = issueInvoice(
      {
        kind: d.kind, documentType: d.documentType, number: d.number, uuid: d.invoiceId,
        issueDate: d.ts.date, issueTime: d.ts.time, timestamp: d.ts.timestamp, currency: d.company.currency,
        seller: zatcaSeller(d.company), buyer: d.buyer, paymentMeansCode: ZATCA_PAYMENT_MEANS[d.paymentMethod], lines,
        billingReference: d.original?.number, reason: d.reason,
        totals: {
          lineExtension: d.totals.net.toFixed(2), taxExclusive: d.totals.net.toFixed(2), taxTotal: d.totals.tax.toFixed(2),
          taxInclusive: d.totals.gross.toFixed(2), allowanceTotal: "0.00", payable: d.totals.gross.toFixed(2),
        },
      },
      { icv: Number(d.terminal.icv), lastHash: d.terminal.last_hash },
      { privateKeyPem: d.terminal.private_key_pem, publicKeyPem: d.terminal.public_key_pem },
    );
    doc = {
      authority: "ZATCA", mode: d.kind === "STANDARD" ? "CLEARANCE" : "REPORTING",
      icv: signed.icv, pih: signed.pih, hash: signed.hash, signature: signed.signature, qr: signed.qr, body: signed.xml,
    };
  } else if (d.company.country === "EG") {
    if (!d.company.vat_number) throw new BusinessError("أضف رقم التسجيل الضريبي (9 أرقام) قبل إصدار الإيصالات");
    const rin = d.company.vat_number;
    const skus = await tx.query<{ id: string; sku: string }>("SELECT id, sku FROM items WHERE id = ANY($1)", [d.lines.map((l) => l.itemId)]);
    const skuOf = new Map(skus.rows.map((r) => [r.id, r.sku]));
    let referenceUUID: string | undefined;
    if (d.original) {
      const o = await maybeOne<{ hash: string }>(tx, "SELECT hash FROM e_invoice_documents WHERE invoice_id=$1", [d.original.invoiceId]);
      referenceUUID = o?.hash;
    }
    const dateTimeIssued = d.ts.timestamp;
    const sealed = sealReceipt(
      buildReceipt({
        receiptType: d.documentType === "CREDIT_NOTE" ? "R" : "S",
        receiptNumber: d.number,
        dateTimeIssued,
        previousUUID: d.terminal.last_hash,
        referenceUUID,
        seller: {
          rin,
          companyTradeName: d.company.name_ar,
          branchCode: "0",
          deviceSerialNumber: d.terminal.prefix,
          activityCode: "4711",
          address: { country: "EG", governate: d.company.city ?? "", regionCity: d.company.district ?? "", street: d.company.street ?? "", buildingNumber: d.company.building_number ?? "" },
        },
        lines: d.lines.map((l) => ({
          internalCode: skuOf.get(l.itemId) ?? l.itemId,
          description: l.name,
          itemType: "EGS",
          itemCode: `EG-${rin}-${skuOf.get(l.itemId) ?? l.itemId}`,
          unitType: "EA",
          quantity: Number(l.quantity.toString()),
          unitPrice: l.unitNet.toFixed(2),
          netSale: l.net.toFixed(2),
          totalSale: l.net.toFixed(2),
          total: l.gross.toFixed(2),
          taxAmount: l.tax.toFixed(2),
          taxRate: Number(l.taxPercent.toString()),
        })),
        totals: { totalSales: d.totals.net.toFixed(2), netAmount: d.totals.net.toFixed(2), taxTotal: d.totals.tax.toFixed(2), totalAmount: d.totals.gross.toFixed(2) },
        paymentMethod: ETA_PAYMENT[d.paymentMethod],
      }),
    );
    doc = {
      authority: "ETA", mode: "RECEIPT", icv: Number(d.terminal.icv) + 1, pih: d.terminal.last_hash, hash: sealed.uuid, signature: "",
      qr: receiptShareUrl(sealed.uuid, dateTimeIssued, d.totals.gross.toFixed(2), rin), body: JSON.stringify(sealed.receipt),
    };
  } else {
    throw new BusinessError(`Country pack ${d.company.country} has no e-invoicing adapter yet`);
  }

  await tx.query(
    `INSERT INTO e_invoice_documents (tenant_id, invoice_id, terminal_id, authority, mode, icv, pih, hash, signature, qr, xml)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [d.tenantId, d.invoiceId, d.terminal.id, doc.authority, doc.mode, doc.icv, doc.pih, doc.hash, doc.signature, doc.qr, doc.body],
  );
  await tx.query("UPDATE pos_terminals SET invoice_seq=$1, icv=$2, last_hash=$3 WHERE id=$4", [d.seq, doc.icv, doc.hash, d.terminal.id]);
}
