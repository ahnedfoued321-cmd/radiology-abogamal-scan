import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, withTenant, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { MockZatcaClient, reportPending } from "../src/services/einvoice-worker.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });
let db: Db;
let ownerDb: Db;
let app: FastifyInstance;

async function call(method: "GET" | "POST", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

const eg = {
  businessNameAr: "صيدلية النيل", country: "EG", industry: "pharmacy", vatNumber: "123456789",
  address: { street: "عباس العقاد", buildingNumber: "10", district: "مدينة نصر", city: "القاهرة", postalCode: "11765" },
  owner: { fullName: "د. أحمد", email: "owner@nile.test", password: "OwnerPass#1" },
};

let token: string, tenantId: string, terminalId: string, wh: string, item: any;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  ownerDb = createPool(config.migrationUrl);
  app = buildApp(db, config);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.end();
  await ownerDb.end();
});

const docOf = (invoiceId: string) =>
  withTenant(db, tenantId, async (tx) => (await tx.query("SELECT authority, mode, icv, pih, hash, qr, xml FROM e_invoice_documents WHERE invoice_id=$1", [invoiceId])).rows[0]);

describe("Egypt country pack (ETA e-receipt)", () => {
  it("validates the Egyptian tax registration number", async () => {
    const bad = await call("POST", "/v1/onboarding", undefined, { ...eg, vatNumber: "310122393500003" });
    expect(bad.status).toBe(422);
  });

  it("onboards an Egyptian business with EGP and 14% VAT", async () => {
    const r = await call("POST", "/v1/onboarding", undefined, eg);
    expect(r.status).toBe(201);
    ({ token, tenantId, terminalId, warehouseId: wh } = r.body);
    const me = await call("GET", "/v1/me", token);
    expect(me.body.company.currency).toBe("EGP");
    expect(me.body.company.vat_percent).toBe("14.00");
    item = (await call("POST", "/v1/items", token, { sku: "VITC", nameAr: "فيتامين سي", price: "114.00" })).body;
    await call("POST", "/v1/inventory/receipts", token, { warehouseId: wh, reference: "PO-EG", lines: [{ itemId: item.id, quantity: "50", unitCost: "60" }] });
  });

  it("issues chained ETA e-receipts", async () => {
    const s1 = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: item.id, quantity: "1" }], payments: [{ method: "CASH", amount: "114.00" }],
    });
    expect(s1.status).toBe(201);
    expect(s1.body.total_tax).toBe("14.0000");
    expect(s1.body.currency).toBe("EGP");
    const d1 = await docOf(s1.body.id);
    expect(d1.authority).toBe("ETA");
    expect(d1.mode).toBe("RECEIPT");
    expect(d1.pih).toBe("");
    expect(d1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d1.qr).toContain(`/receipts/search/${d1.hash}/share/`);
    expect(d1.qr).toContain("IssuerRIN:123456789");
    const receipt = JSON.parse(d1.xml);
    expect(receipt.documentType.receiptType).toBe("S");
    expect(receipt.taxTotals[0]).toEqual({ taxType: "T1", amount: 14 });

    const s2 = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: item.id, quantity: "2" }], payments: [{ method: "CARD", amount: "228.00" }],
    });
    const d2 = await docOf(s2.body.id);
    expect(d2.pih).toBe(d1.hash);
    expect(JSON.parse(d2.xml).paymentMethod).toBe("V");

    const ret = await call("POST", `/v1/pos/sales/${s1.body.id}/refund`, token, { clientUuid: randomUUID(), reason: "مرتجع" });
    const d3 = await docOf(ret.body.id);
    const r = JSON.parse(d3.xml);
    expect(r.documentType.receiptType).toBe("R");
    expect(r.header.referenceUUID).toBe(d1.hash);
    expect(d3.pih).toBe(d2.hash);
  });

  it("submits receipts through the worker and keeps the ledger balanced", async () => {
    const r = await reportPending(ownerDb, new MockZatcaClient());
    expect(r.processed).toBe(3);
    const today = new Date().toISOString().slice(0, 10);
    const tb = await call("GET", `/v1/reports/trial-balance?from=${today}&to=${today}`, token);
    expect(tb.body.balanced).toBe(true);
    const vat = await call("GET", `/v1/reports/vat?from=${today}&to=${today}`, token);
    expect(vat.body.outputVat).toBe("28.00");
  });
});
