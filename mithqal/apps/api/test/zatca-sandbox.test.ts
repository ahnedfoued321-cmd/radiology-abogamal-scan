/**
 * Live test against the ZATCA developer-portal sandbox (opt-in: ZATCA_SANDBOX_TEST=1).
 * Onboards a real POS terminal through the API, sells, and submits the signed invoices to ZATCA.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { HttpZatcaClient, reportPending } from "../src/services/einvoice-worker.js";

const live = process.env.ZATCA_SANDBOX_TEST === "1";
process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });

describe.skipIf(!live)("ZATCA sandbox (live)", () => {
  let db: Db, ownerDb: Db, app: FastifyInstance;
  let token: string, terminalId: string, item: any, customer: any;
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.json() as any };
  };

  beforeAll(async () => {
    await migrate(config.migrationUrl, { reset: true });
    db = createPool(config.appUrl);
    ownerDb = createPool(config.migrationUrl);
    app = buildApp(db, config, ownerDb);
    await app.ready();
    const o = await call("POST", "/v1/onboarding", {
      businessNameAr: "مقهى مثقال التجريبي", businessNameEn: "Mithqal Demo Cafe", country: "SA", industry: "cafe",
      // The developer-portal sandbox always issues its fixed sample certificate (VAT 399999999900003),
      // whatever the CSR says, and production endpoints check the seller VAT against it.
      vatNumber: "399999999900003", crNumber: "1010010000",
      address: { street: "King Fahd Road", buildingNumber: "1234", district: "Al Olaya", city: "Riyadh", postalCode: "12211" },
      owner: { fullName: "مالك", email: "owner@zatca.test", password: "OwnerPass#1" },
    });
    token = o.body.token;
    terminalId = o.body.terminalId;
    item = (await call("POST", "/v1/items", { sku: "LAT", nameAr: "لاتيه", price: "17.25", trackStock: false })).body;
    customer = (await call("POST", "/v1/customers", {
      name: "شركة النخيل", vatNumber: "311111111111113", creditLimit: "1000.00",
      address: { street: "Salah Al-Din", buildingNumber: "1111", district: "Al-Murooj", city: "Riyadh", postalCode: "12222" },
    })).body;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await ownerDb.end();
  });

  it("onboards the terminal: CSR → compliance CSID → 6 compliance checks → production CSID", async () => {
    const r = await call("POST", `/v1/terminals/${terminalId}/zatca/onboard`, { otp: "123345", env: "sandbox" });
    expect(r.status).toBe(200);
    for (const c of r.body.checks) expect(c.errors, c.type).toEqual([]);
    expect(r.body.onboarded).toBe(true);
    const t = await call("GET", "/v1/terminals");
    expect(t.body[0].zatca_status).toBe("ONBOARDED");
  }, 120_000);

  it("reports a B2C sale and clears a B2B sale with ZATCA", async () => {
    await call("POST", "/v1/pos/sales", { clientUuid: randomUUID(), terminalId, lines: [{ itemId: item.id, quantity: "2" }], payments: [{ method: "CARD", amount: "34.50" }] });
    await call("POST", "/v1/pos/sales", { clientUuid: randomUUID(), terminalId, customerId: customer.id, lines: [{ itemId: item.id, quantity: "4" }], payments: [{ method: "CREDIT", amount: "69.00" }] });
    const r = await reportPending(ownerDb, new HttpZatcaClient(), 10, ["ZATCA"]);
    expect(r.processed).toBe(2);
    expect(r.rejected).toBe(0);
    const docs = await ownerDb.query("SELECT mode, status, response FROM e_invoice_documents ORDER BY icv");
    for (const d of docs.rows) {
      expect(["ACCEPTED", "WARNING"], JSON.stringify(d.response)).toContain(d.status);
    }
    expect(docs.rows.map((d) => d.mode).sort()).toEqual(["CLEARANCE", "REPORTING"]);
  }, 120_000);
});
