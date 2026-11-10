import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, withTenant, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });
let db: Db;
let app: FastifyInstance;

async function call(method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

let token: string;
let tenantId: string;
let terminalId: string;
let wh: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  app = buildApp(db, config);
  await app.ready();
  const o = await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "مقهى الوصفات", country: "SA", industry: "cafe", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@recipes.test", password: "OwnerPass#1" },
  });
  ({ token, tenantId, terminalId, warehouseId: wh } = o.body);
  const mk = async (sku: string, nameAr: string, price: string, extra: object) =>
    (ids[sku] = (await call("POST", "/v1/items", token, { sku, nameAr, price, ...extra })).body.id);
  await mk("BEANS", "بن مختص (جرام)", "0", { unit: "g" });
  await mk("MILK", "حليب (مل)", "0", { unit: "ml" });
  await mk("CUP", "كوب 12oz", "0", {});
  await mk("LATTE", "لاتيه", "17.25", { trackStock: false, category: "قهوة" });
  await mk("ESP", "إسبريسو", "6.90", { trackStock: false, category: "قهوة" });
  await call("POST", "/v1/inventory/receipts", token, {
    warehouseId: wh, reference: "PO-RAW",
    lines: [
      { itemId: ids.BEANS, quantity: "1000", unitCost: "0.12" }, // 120 SAR/kg
      { itemId: ids.MILK, quantity: "10000", unitCost: "0.006" }, // 6 SAR/L
      { itemId: ids.CUP, quantity: "500", unitCost: "0.40" },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

const stockOf = async (itemId: string) =>
  withTenant(db, tenantId, async (tx) => (await tx.query("SELECT quantity FROM stock_balances WHERE item_id=$1", [itemId])).rows[0]?.quantity);

describe("F&B recipes: live cost per cup", () => {
  it("validates recipes", async () => {
    expect((await call("PUT", `/v1/items/${ids.BEANS}/recipe`, token, { lines: [] })).status).toBe(422); // stock item can't have a recipe
    expect((await call("PUT", `/v1/items/${ids.LATTE}/recipe`, token, { lines: [{ ingredientId: ids.ESP, quantity: "1" }] })).status).toBe(422);
  });

  it("saves recipes and reports cost per cup and margin", async () => {
    await call("PUT", `/v1/items/${ids.LATTE}/recipe`, token, {
      lines: [{ ingredientId: ids.BEANS, quantity: "18" }, { ingredientId: ids.MILK, quantity: "200" }, { ingredientId: ids.CUP, quantity: "1" }],
    });
    await call("PUT", `/v1/items/${ids.ESP}/recipe`, token, { lines: [{ ingredientId: ids.BEANS, quantity: "18" }] });
    const r = await call("GET", "/v1/reports/menu-costing?targetMargin=80", token);
    const latte = r.body.find((x: any) => x.name === "لاتيه");
    // 18g*0.12 + 200ml*0.006 + 0.40 = 2.16 + 1.20 + 0.40 = 3.76 ; net price 17.25/1.15 = 15.00 ; margin 74.9%
    expect(latte.costPerUnit).toBe("3.76");
    expect(latte.marginPercent).toBe("74.9");
    expect(latte.belowTarget).toBe(true);
    expect(latte.suggestedPrice).toBe("21.62"); // 3.76 / 0.2 * 1.15
    const esp = r.body.find((x: any) => x.name === "إسبريسو");
    expect(esp.costPerUnit).toBe("2.16");
  });

  it("selling a latte consumes ingredients and books real COGS", async () => {
    const s = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: ids.LATTE, quantity: "2" }], payments: [{ method: "CARD", amount: "34.50" }],
    });
    expect(s.status).toBe(201);
    expect(s.body.cost_of_goods).toBe("7.5200");
    expect(s.body.lines[0].unit_cost).toBe("3.7600");
    expect(await stockOf(ids.BEANS)).toBe("964.0000");
    expect(await stockOf(ids.MILK)).toBe("9600.0000");
    expect(await stockOf(ids.CUP)).toBe("498.0000");
  });

  it("refunding restocks the exact ingredients and keeps inventory value = ledger", async () => {
    const s = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: ids.LATTE, quantity: "1" }], payments: [{ method: "CASH", amount: "17.25" }],
    });
    const r = await call("POST", `/v1/pos/sales/${s.body.id}/refund`, token, { clientUuid: randomUUID(), reason: "طلب خطأ قبل التحضير" });
    expect(r.status).toBe(201);
    expect(await stockOf(ids.BEANS)).toBe("964.0000");
    expect(await stockOf(ids.MILK)).toBe("9600.0000");

    const check = await withTenant(db, tenantId, async (tx) => {
      const gl = (await tx.query(
        `SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.role='INVENTORY'`,
      )).rows[0].v;
      const stock = (await tx.query("SELECT coalesce(sum(quantity*average_cost),0) AS v FROM stock_balances")).rows[0].v;
      return { gl: Number(gl).toFixed(2), stock: Number(stock).toFixed(2) };
    });
    expect(check.gl).toBe(check.stock);
  });
});

describe("kitchen / barista display", () => {
  it("routes prepared drinks to the KDS and tracks ready → served", async () => {
    const s = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: ids.LATTE, quantity: "2" }, { itemId: ids.ESP, quantity: "1" }],
      payments: [{ method: "CASH", amount: "41.40" }],
    });
    expect(s.status).toBe(201);
    let t = await call("GET", "/v1/kds/tickets", token);
    const ticket = t.body.find((x: any) => x.invoice_id === s.body.id);
    expect(ticket.status).toBe("NEW");
    expect(ticket.items).toEqual([{ name: "لاتيه", quantity: 2 }, { name: "إسبريسو", quantity: 1 }]);
    expect((await call("POST", `/v1/kds/tickets/${s.body.id}/status`, token, { status: "READY" })).body.status).toBe("READY");
    await call("POST", `/v1/kds/tickets/${s.body.id}/status`, token, { status: "SERVED" });
    t = await call("GET", "/v1/kds/tickets", token);
    expect(t.body.find((x: any) => x.invoice_id === s.body.id)).toBeUndefined();
    expect((await call("POST", `/v1/kds/tickets/${s.body.id}/status`, token, { status: "READY" })).status).toBe(422);
    const prep = await call("GET", "/v1/reports/prep-times", token);
    expect(prep.body.tickets).toBeGreaterThanOrEqual(1);
  });
});

describe("pharmacy refunds restock the original batches", () => {
  it("returns sold units to the same batch and keeps GL = stock", async () => {
    const drug = (await call("POST", "/v1/items", token, { sku: "AMOX", nameAr: "أموكسيسيلين", price: "20.00", taxPercent: "0", trackBatches: true })).body;
    await call("POST", "/v1/inventory/receipts", token, {
      warehouseId: wh, reference: "PO-D",
      lines: [{ itemId: drug.id, quantity: "5", unitCost: "10", batchNo: "B1", expiryDate: "2099-01-01" }],
    });
    const s = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: drug.id, quantity: "2" }], payments: [{ method: "CASH", amount: "40.00" }],
    });
    await call("POST", `/v1/pos/sales/${s.body.id}/refund`, token, { clientUuid: randomUUID(), reason: "إرجاع" });
    const b = await withTenant(db, tenantId, async (tx) => (await tx.query("SELECT quantity FROM item_batches WHERE batch_no='B1'")).rows[0].quantity);
    expect(b).toBe("5.0000");
    expect(await stockOf(drug.id)).toBe("5.0000");
    const check = await withTenant(db, tenantId, async (tx) => {
      const gl = (await tx.query(
        `SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.role='INVENTORY'`,
      )).rows[0].v;
      const stock = (await tx.query("SELECT coalesce(sum(quantity*average_cost),0) AS v FROM stock_balances")).rows[0].v;
      return { gl: Number(gl).toFixed(2), stock: Number(stock).toFixed(2) };
    });
    expect(check.gl).toBe(check.stock);
  });
});
