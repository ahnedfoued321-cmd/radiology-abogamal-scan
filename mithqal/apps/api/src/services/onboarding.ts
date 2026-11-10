import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { SA_RETAIL_CHART } from "@mithqal/domain";
import { NEW_DEVICE_CHAIN, generateDeviceKeys } from "@mithqal/zatca";
import { BusinessError, withTenant, type Db, type Tx } from "../db.js";
import { audit } from "./core.js";

export interface OnboardingInput {
  businessNameAr: string;
  businessNameEn?: string;
  country: "SA";
  industry: "retail" | "cafe" | "restaurant" | "pharmacy" | "distribution" | "services";
  vatNumber?: string;
  crNumber?: string;
  address?: { street: string; buildingNumber: string; district: string; city: string; postalCode: string };
  owner: { fullName: string; email: string; password: string };
  branchName?: string;
}

/** Country packs: everything country-specific lives here, not in the core. */
export const COUNTRY_PACKS = {
  SA: { currency: "SAR", vatPercent: "15", chart: SA_RETAIL_CHART },
} as const;

/** "10-minute onboarding": one call creates tenant, company, branch, warehouse, POS, chart, owner. */
export async function onboard(db: Db, input: OnboardingInput) {
  const pack = COUNTRY_PACKS[input.country];
  if (!pack) throw new BusinessError(`Country ${input.country} not supported yet`);
  if (input.vatNumber && !/^3\d{13}3$/.test(input.vatNumber)) {
    throw new BusinessError("رقم التسجيل الضريبي يجب أن يكون 15 رقمًا يبدأ وينتهي بالرقم 3");
  }
  const existing = await db.query("SELECT 1 FROM auth_lookup($1)", [input.owner.email.toLowerCase()]);
  if (existing.rowCount) throw new BusinessError("البريد الإلكتروني مسجل بالفعل");

  const tenantId = randomUUID();
  const passwordHash = await bcrypt.hash(input.owner.password, 10);

  return withTenant(db, tenantId, async (tx) => {
    // Every new business starts on Free with a 14-day Pro trial (all modules unlocked).
    await tx.query("INSERT INTO tenants (id, name, country, plan, trial_ends_at) VALUES ($1,$2,$3,'free', now() + interval '14 days')", [
      tenantId, input.businessNameAr, input.country,
    ]);
    const a = input.address;
    const company = await tx.query<{ id: string }>(
      `INSERT INTO companies (tenant_id, name_ar, name_en, vat_number, cr_number, street, building_number, district, city, postal_code,
                              country, currency, vat_percent, industry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [tenantId, input.businessNameAr, input.businessNameEn ?? null, input.vatNumber ?? null, input.crNumber ?? null,
        a?.street ?? null, a?.buildingNumber ?? null, a?.district ?? null, a?.city ?? null, a?.postalCode ?? null,
        input.country, pack.currency, pack.vatPercent, input.industry],
    );
    const branch = await tx.query<{ id: string }>(
      "INSERT INTO branches (tenant_id, company_id, name) VALUES ($1,$2,$3) RETURNING id",
      [tenantId, company.rows[0]!.id, input.branchName ?? "الفرع الرئيسي"],
    );
    const branchId = branch.rows[0]!.id;
    const wh = await tx.query<{ id: string }>(
      "INSERT INTO warehouses (tenant_id, branch_id, name) VALUES ($1,$2,$3) RETURNING id",
      [tenantId, branchId, "المستودع الرئيسي"],
    );
    for (const acc of pack.chart) {
      await tx.query(
        `INSERT INTO accounts (tenant_id, code, name_ar, name_en, type, parent_code, role, postable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, acc.code, acc.nameAr, acc.nameEn, acc.type, acc.parentCode ?? null, acc.role ?? null, acc.postable],
      );
    }
    const terminalId = await createTerminal(tx, tenantId, branchId, wh.rows[0]!.id, "كاشير 1", "POS1");
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id`,
      [tenantId, input.owner.email.toLowerCase(), passwordHash, input.owner.fullName],
    );
    const userId = user.rows[0]!.id;
    await audit(tx, { tenantId, userId }, "tenant.onboarded", "tenant", tenantId, { industry: input.industry });
    return { tenantId, userId, branchId, warehouseId: wh.rows[0]!.id, terminalId };
  });
}

export async function createTerminal(tx: Tx, tenantId: string, branchId: string, warehouseId: string, name: string, prefix: string): Promise<string> {
  const keys = generateDeviceKeys();
  const r = await tx.query<{ id: string }>(
    `INSERT INTO pos_terminals (tenant_id, branch_id, warehouse_id, name, prefix, icv, last_hash, private_key_pem, public_key_pem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, branchId, warehouseId, name, prefix, NEW_DEVICE_CHAIN.icv, NEW_DEVICE_CHAIN.lastHash, keys.privateKeyPem, keys.publicKeyPem],
  );
  return r.rows[0]!.id;
}
