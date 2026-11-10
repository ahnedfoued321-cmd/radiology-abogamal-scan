import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });
let db: Db, app: FastifyInstance, token: string;
async function call(method: "GET" | "POST", url: string, payload?: unknown, t = token) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${t}` } });
  return { status: res.statusCode, body: res.json() as any };
}
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  app = buildApp(db, config);
  await app.ready();
  const o = (await app.inject({ method: "POST", url: "/v1/onboarding", payload: {
    businessNameAr: "محاسبة", country: "SA", industry: "retail", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@acc.test", password: "OwnerPass#1" },
  } })).json() as any;
  token = o.token;
  const item = (await call("POST", "/v1/items", { sku: "X", nameAr: "صنف", price: "115.00" })).body;
  const sup = (await call("POST", "/v1/suppliers", { name: "مورد" })).body;
  await call("POST", "/v1/inventory/receipts", { warehouseId: o.warehouseId, supplierId: sup.id, reference: "R", lines: [{ itemId: item.id, quantity: "10", unitCost: "40" }] });
  await call("POST", "/v1/pos/sales", { clientUuid: randomUUID(), terminalId: o.terminalId, lines: [{ itemId: item.id, quantity: "3" }], payments: [{ method: "CASH", amount: "345.00" }] });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("accounting", () => {
  it("posts a balanced manual journal and refuses bad ones", async () => {
    // owner injects capital into the bank, pays rent from the bank
    const ok = await call("POST", "/v1/accounting/journals", { date: today, memo: "رأس مال ودفع إيجار", lines: [
      { accountCode: "1103", debit: "10000" }, { accountCode: "3101", credit: "10000" },
      { accountCode: "5202", debit: "2500" }, { accountCode: "1103", credit: "2500" },
    ] });
    expect(ok.status).toBe(201);
    expect((await call("POST", "/v1/accounting/journals", { date: today, memo: "غير متوازن", lines: [{ accountCode: "1103", debit: "1" }, { accountCode: "3101", credit: "2" }] })).status).toBe(422);
    expect((await call("POST", "/v1/accounting/journals", { date: today, memo: "تجميعي", lines: [{ accountCode: "11", debit: "1" }, { accountCode: "3101", credit: "1" }] })).status).toBe(422);
    expect((await call("POST", "/v1/accounting/journals", { date: today, memo: "مخزون", lines: [{ accountCode: "1120", debit: "1" }, { accountCode: "3101", credit: "1" }] })).status).toBe(422);
    expect((await call("POST", "/v1/accounting/journals", { date: today, memo: "عملاء", lines: [{ accountCode: "1110", debit: "1" }, { accountCode: "3101", credit: "1" }] })).status).toBe(422);
  });

  it("income statement: sales 300 − COGS 120 − rent 2500", async () => {
    const r = await call("GET", `/v1/reports/income-statement?from=${today}&to=${today}`);
    expect(r.body.totalRevenue).toBe("300.00");
    expect(r.body.totalExpenses).toBe("2620.00");
    expect(r.body.netProfit).toBe("-2320.00");
  });

  it("balance sheet balances with current earnings in equity", async () => {
    const r = await call("GET", "/v1/reports/balance-sheet");
    expect(r.body.balanced).toBe(true);
    expect(r.body.retainedEarnings).toBe("-2320.00");
  });

  it("account statement shows running balance", async () => {
    const r = await call("GET", `/v1/reports/account/1103?from=${today}&to=${today}`);
    expect(r.body.lines.map((l: any) => l.balance)).toEqual(["10000.00", "7500.00"]);
    expect(r.body.closingBalance).toBe("7500.00");
  });
});
