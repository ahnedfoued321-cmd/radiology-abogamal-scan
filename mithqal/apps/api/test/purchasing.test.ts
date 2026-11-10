import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });
let db: Db;
let app: FastifyInstance;
async function call(method: "GET" | "POST", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

let owner: string, keeper: string, wh: string, terminalId: string, milk: any, supplier: any, po: any;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  app = buildApp(db, config);
  await app.ready();
  const o = await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "مقهى المشتريات", country: "SA", industry: "cafe", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@po.test", password: "OwnerPass#1" },
  });
  owner = o.body.token; wh = o.body.warehouseId; terminalId = o.body.terminalId;
  await call("POST", "/v1/users", owner, { fullName: "أمين المخزن", email: "keeper@po.test", password: "KeeperPass#1", role: "storekeeper" });
  keeper = (await call("POST", "/v1/auth/login", undefined, { email: "keeper@po.test", password: "KeeperPass#1" })).body.token;
  milk = (await call("POST", "/v1/items", owner, { sku: "MILK1L", nameAr: "حليب 1 لتر", price: "8.05", reorderLevel: "10" })).body;
  await call("POST", "/v1/inventory/receipts", owner, { warehouseId: wh, reference: "OPEN", lines: [{ itemId: milk.id, quantity: "40", unitCost: "5.00" }] });
  for (let i = 0; i < 3; i++) {
    await call("POST", "/v1/pos/sales", owner, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: milk.id, quantity: "10" }], payments: [{ method: "CASH", amount: "80.50" }],
    });
  }
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("purchasing cycle", () => {
  it("suggests reorder quantities from real sales velocity", async () => {
    const r = await call("GET", `/v1/purchasing/suggestions?warehouseId=${wh}`, keeper);
    // on hand 10 (= reorder level), sold 30 in 14 days → 2.142/day × 14 = 30 + safety 10 − 10 on hand = 30
    expect(r.body).toHaveLength(1);
    expect(r.body[0].suggestedQty).toBe("30");
    expect(r.body[0].estimatedUnitCost).toBe("5.00");
  });

  it("storekeeper drafts a PO; only the owner approves; receiving requires approval", async () => {
    supplier = (await call("POST", "/v1/suppliers", keeper, { name: "مزارع الألبان", paymentTermsDays: 30 })).body;
    po = (await call("POST", "/v1/purchasing/orders", keeper, {
      supplierId: supplier.id, warehouseId: wh, lines: [{ itemId: milk.id, quantity: "30", unitCost: "5.00" }],
    })).body;
    expect(po.number).toBe("PO-00001");
    expect(po.status).toBe("DRAFT");
    expect(po.totalNet).toBe("150.00");
    expect((await call("POST", `/v1/purchasing/orders/${po.id}/receive`, keeper, { reference: "DN-1", lines: [{ itemId: milk.id, quantity: "10" }] })).status).toBe(422);
    expect((await call("POST", `/v1/purchasing/orders/${po.id}/approve`, keeper)).status).toBe(403);
    expect((await call("POST", `/v1/purchasing/orders/${po.id}/approve`, owner)).body.status).toBe("APPROVED");
  });

  it("receives partially, refuses over-receipt, then completes", async () => {
    const r1 = await call("POST", `/v1/purchasing/orders/${po.id}/receive`, keeper, { reference: "DN-1", lines: [{ itemId: milk.id, quantity: "20" }] });
    expect(r1.status).toBe(201);
    expect(r1.body.po.status).toBe("PARTIAL");
    expect((await call("POST", `/v1/purchasing/orders/${po.id}/receive`, keeper, { reference: "DN-2", lines: [{ itemId: milk.id, quantity: "11" }] })).status).toBe(422);
    const r2 = await call("POST", `/v1/purchasing/orders/${po.id}/receive`, keeper, { reference: "DN-2", lines: [{ itemId: milk.id, quantity: "10" }] });
    expect(r2.body.po.status).toBe("RECEIVED");
  });

  it("tracks what we owe the supplier and pays it down", async () => {
    const list = await call("GET", "/v1/suppliers", owner);
    expect(list.body[0].balance).toBe("172.50"); // 150 + 15% VAT
    const pay = await call("POST", `/v1/suppliers/${supplier.id}/payments`, owner, { clientUuid: randomUUID(), method: "BANK_TRANSFER", amount: "100.00" });
    expect(pay.status).toBe(201);
    expect(pay.body.balance).toBe("72.50");
    expect((await call("POST", `/v1/suppliers/${supplier.id}/payments`, owner, { clientUuid: randomUUID(), method: "CASH", amount: "500.00" })).status).toBe(422);
    const today = new Date().toISOString().slice(0, 10);
    const tb = await call("GET", `/v1/reports/trial-balance?from=${today}&to=${today}`, owner);
    expect(tb.body.balanced).toBe(true);
    // AP = this supplier (172.50) − payment (100); the opening receipt had no supplier, so it is equity, not AP
    expect(tb.body.rows.find((r: any) => r.code === "2101").balance).toBe("-72.50");
  });
});
