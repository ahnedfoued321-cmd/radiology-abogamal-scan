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

let owner: string;
let rep: string;
let repId: string;
let mainWh: string;
let van: { warehouseId: string; terminalId: string };
let water: any;
let shop: any; // B2B customer, VAT registered, has credit
let kiosk: any; // B2C customer, no VAT number

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  ownerDb = createPool(config.migrationUrl);
  app = buildApp(db, config);
  await app.ready();

  const o = await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "شركة التوزيع الحديثة", country: "SA", industry: "distribution", vatNumber: "300000000000003",
    address: { street: "طريق الخرج", buildingNumber: "77", district: "المصانع", city: "الرياض", postalCode: "14321" },
    owner: { fullName: "المدير", email: "owner@dist.test", password: "OwnerPass#1" },
  });
  owner = o.body.token;
  mainWh = o.body.warehouseId;
  water = (await call("POST", "/v1/items", owner, { sku: "WTR-12", nameAr: "مياه 330 مل × 12", price: "11.50" })).body;
  await call("POST", "/v1/inventory/receipts", owner, { warehouseId: mainWh, reference: "PO-1", lines: [{ itemId: water.id, quantity: "500", unitCost: "6.00" }] });
});

afterAll(async () => {
  await app.close();
  await db.end();
  await ownerDb.end();
});

describe("van sales (Mithqal Khuta)", () => {
  it("assigns a van to a sales rep and loads it", async () => {
    const u = await call("POST", "/v1/users", owner, { fullName: "سالم المندوب", email: "rep@dist.test", password: "RepPass#123", role: "sales_rep" });
    repId = u.body.id;
    rep = (await call("POST", "/v1/auth/login", undefined, { email: "rep@dist.test", password: "RepPass#123" })).body.token;
    const v = await call("POST", "/v1/van/assign", owner, { userId: repId, vehiclePlate: "أ ب ج 1234" });
    expect(v.status).toBe(201);
    van = v.body;
    const t = await call("POST", "/v1/inventory/transfers", owner, {
      fromWarehouseId: mainWh, toWarehouseId: van.warehouseId, reference: "تحميل الصباح", lines: [{ itemId: water.id, quantity: "100" }],
    });
    expect(t.status).toBe(201);
    const me = await call("GET", "/v1/van/me", rep);
    expect(me.body.stock[0].quantity).toBe("100.0000");
    const over = await call("POST", "/v1/inventory/transfers", owner, {
      fromWarehouseId: mainWh, toWarehouseId: van.warehouseId, lines: [{ itemId: water.id, quantity: "9999" }],
    });
    expect(over.status).toBe(422);
  });

  it("registers customers; only the owner sets credit limits", async () => {
    shop = (await call("POST", "/v1/customers", owner, {
      name: "سوبرماركت النخيل", vatNumber: "311111111111113", creditLimit: "1000.00", routeDay: 1,
      latitude: 24.7136, longitude: 46.6753,
      address: { street: "شارع العليا", buildingNumber: "12", district: "العليا", city: "الرياض", postalCode: "12241" },
    })).body;
    kiosk = (await call("POST", "/v1/customers", rep, { name: "بقالة الحي", latitude: 24.75, longitude: 46.70 })).body;
    expect(shop.credit_limit).toBe("1000.0000");
    const denied = await call("POST", "/v1/customers", rep, { name: "x", creditLimit: "5000.00" });
    expect(denied.status).toBe(422);
  });

  it("checks in with GPS and flags visits outside the geofence", async () => {
    const far = await call("POST", "/v1/van/visits", rep, { customerId: shop.id, lat: 24.80, lng: 46.80 });
    expect(far.body.outsideGeofence).toBe(true);
    expect((await call("POST", `/v1/van/visits/${far.body.visitId}/checkout`, rep, { outcome: "OTHER", note: "خطأ" })).status).toBe(200);
    const near = await call("POST", "/v1/van/visits", rep, { customerId: shop.id, lat: 24.7137, lng: 46.6754 });
    expect(near.body.outsideGeofence).toBe(false);
    expect(near.body.distanceMeters).toBeLessThan(50);
    const twice = await call("POST", "/v1/van/visits", rep, { customerId: kiosk.id, lat: 24.75, lng: 46.70 });
    expect(twice.status).toBe(422); // must close the open visit first
    await call("POST", `/v1/van/visits/${near.body.visitId}/checkout`, rep, { outcome: "SOLD" });
  });

  it("sells on credit to a VAT-registered shop as a B2B standard invoice (clearance)", async () => {
    const r = await call("POST", "/v1/pos/sales", rep, {
      clientUuid: randomUUID(), terminalId: van.terminalId, customerId: shop.id,
      lines: [{ itemId: water.id, quantity: "40" }], payments: [{ method: "CREDIT", amount: "460.00" }],
    });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("STANDARD");
    expect(r.body.number).toBe("VAN1-000001");
    const doc = await withTenant(db, r.body.tenant_id, async (tx) =>
      (await tx.query("SELECT mode, xml FROM e_invoice_documents WHERE invoice_id=$1", [r.body.id])).rows[0],
    );
    expect(doc.mode).toBe("CLEARANCE");
    expect(doc.xml).toContain('name="0100000">388<');
    expect(doc.xml).toContain("<cac:AccountingCustomerParty>");
    expect(doc.xml).toContain("311111111111113");
  });

  it("blocks credit beyond the customer's limit", async () => {
    const r = await call("POST", "/v1/pos/sales", rep, {
      clientUuid: randomUUID(), terminalId: van.terminalId, customerId: shop.id,
      lines: [{ itemId: water.id, quantity: "50" }], payments: [{ method: "CREDIT", amount: "575.00" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain("حد الائتمان");
  });

  it("sells cash to a walk-in kiosk as a simplified invoice from the van stock", async () => {
    const r = await call("POST", "/v1/pos/sales", rep, {
      clientUuid: randomUUID(), terminalId: van.terminalId, customerId: kiosk.id,
      lines: [{ itemId: water.id, quantity: "10" }], payments: [{ method: "CASH", amount: "115.00" }],
    });
    expect(r.body.kind).toBe("SIMPLIFIED");
    const me = await call("GET", "/v1/van/me", rep);
    expect(me.body.stock[0].quantity).toBe("50.0000");
  });

  it("does not let a rep sell from another terminal", async () => {
    const meOwner = await call("GET", "/v1/me", owner);
    const shopTerminal = meOwner.body.terminals.find((t: any) => t.prefix === "POS1").id;
    const r = await call("POST", "/v1/pos/sales", rep, {
      clientUuid: randomUUID(), terminalId: shopTerminal, lines: [{ itemId: water.id, quantity: "1" }], payments: [{ method: "CASH", amount: "11.50" }],
    });
    expect(r.status).toBe(422);
  });

  it("collects payments idempotently and reduces the balance", async () => {
    const clientUuid = randomUUID();
    const c1 = await call("POST", "/v1/collections", rep, { clientUuid, customerId: shop.id, method: "CASH", amount: "200.00" });
    expect(c1.status).toBe(201);
    expect(c1.body.balance).toBe("260.00");
    const again = await call("POST", "/v1/collections", rep, { clientUuid, customerId: shop.id, method: "CASH", amount: "200.00" });
    expect(again.status).toBe(200);
    expect(again.body.balance).toBe("260.00");
    const tooMuch = await call("POST", "/v1/collections", rep, { clientUuid: randomUUID(), customerId: shop.id, method: "CASH", amount: "999.00" });
    expect(tooMuch.status).toBe(422);
    const list = await call("GET", "/v1/customers", owner);
    expect(list.body.find((c: any) => c.id === shop.id).balance).toBe("260.00");
  });

  it("plans today's route: customers with balances first, then nearest", async () => {
    const r = await call("GET", "/v1/van/route?lat=24.70&lng=46.68&day=2026-11-09", rep); // Monday = route day 1
    expect(r.status).toBe(200);
    expect(r.body.stops[0].name).toBe("سوبرماركت النخيل");
    expect(r.body.stops[0].balanceDue).toBe("260.00");
  });

  it("produces the end-of-day van settlement", async () => {
    const s = await call("GET", "/v1/van/settlement", rep);
    expect(s.status).toBe(200);
    expect(s.body.cashToHandOver).toBe("315.00"); // 115 cash sale + 200 cash collection
    expect(s.body.visits).toEqual({ total: 2, sold: 1, outsideGeofence: 1 });
    expect(s.body.vanStock[0].quantity).toBe("50");
    expect(s.body.vanStock[0].value).toBe("300.00");
  });

  it("clears B2B invoices before reporting B2C ones and keeps the ledger balanced", async () => {
    const r = await reportPending(ownerDb, new MockZatcaClient());
    expect(r.processed).toBe(2);
    const today = new Date().toISOString().slice(0, 10);
    const tb = await call("GET", `/v1/reports/trial-balance?from=${today}&to=${today}`, owner);
    expect(tb.body.balanced).toBe(true);
    const ar = tb.body.rows.find((x: any) => x.code === "1110");
    expect(ar.balance).toBe("260.00");
  });
});
