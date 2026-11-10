/** Regression tests for the findings of the independent review (one test per finding). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, withTenant, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test", PLATFORM_KEY: "pk" });
let db: Db, ownerDb: Db, app: FastifyInstance;
async function call(method: "GET" | "POST", url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.statusCode, body: res.json() as any };
}

let owner: string, tenantId: string, terminalId: string, wh: string, item: any, cashier: string;

const glVsStock = () =>
  withTenant(db, tenantId, async (tx) => {
    const gl = (await tx.query(`SELECT coalesce(sum(l.debit-l.credit),0) AS v FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.role='INVENTORY'`)).rows[0].v;
    const st = (await tx.query("SELECT coalesce(sum(quantity*average_cost),0) AS v FROM stock_balances")).rows[0].v;
    return { gl: Number(gl).toFixed(2), stock: Number(st).toFixed(2) };
  });

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  ownerDb = createPool(config.migrationUrl);
  app = buildApp(db, config, ownerDb);
  await app.ready();
  const o = await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "متجر الاختبار", country: "SA", industry: "retail", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@hard.test", password: "OwnerPass#1" },
  });
  ({ token: owner, tenantId, terminalId, warehouseId: wh } = o.body);
  item = (await call("POST", "/v1/items", owner, { sku: "A", nameAr: "صنف", price: "115.00" })).body;
  await call("POST", "/v1/inventory/receipts", owner, { warehouseId: wh, reference: "open", lines: [{ itemId: item.id, quantity: "10", unitCost: "50" }] });
  await call("POST", "/v1/users", owner, { fullName: "كاشير", email: "c@hard.test", password: "CashPass#123", role: "cashier" });
  cashier = (await call("POST", "/v1/auth/login", undefined, { email: "c@hard.test", password: "CashPass#123" })).body.token;
});
afterAll(async () => {
  await app.close();
  await db.end();
  await ownerDb.end();
});

const sell = (token: string, extra: object = {}) =>
  call("POST", "/v1/pos/sales", token, {
    clientUuid: randomUUID(), terminalId, lines: [{ itemId: item.id, quantity: "1" }], payments: [{ method: "CASH", amount: "115.00" }], ...extra,
  });

describe("review findings", () => {
  it("#1 concurrent refunds of one invoice: exactly one succeeds", async () => {
    const s = await sell(owner);
    const rs = await Promise.all([1, 2, 3].map(() => call("POST", `/v1/pos/sales/${s.body.id}/refund`, owner, { clientUuid: randomUUID(), reason: "مرتجع مكرر" })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => [201, 409, 422].includes(r.status))).toBe(true);
  });

  it("#12 concurrent replays of the same offline sale return the same invoice", async () => {
    const body = { clientUuid: randomUUID(), terminalId, lines: [{ itemId: item.id, quantity: "1" }], payments: [{ method: "CASH", amount: "115.00" }] };
    const rs = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/pos/sales", owner, body)));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("#3 only the owner may change prices; staff discounts are capped", async () => {
    expect((await sell(cashier, { lines: [{ itemId: item.id, quantity: "1", unitPrice: "0.01" }], payments: [{ method: "CASH", amount: "0.01" }] })).status).toBe(422);
    expect((await sell(cashier, { lines: [{ itemId: item.id, quantity: "1", discount: "50.00" }], payments: [{ method: "CASH", amount: "65.00" }] })).status).toBe(422);
    expect((await sell(cashier, { lines: [{ itemId: item.id, quantity: "1", discount: "10.00" }], payments: [{ method: "CASH", amount: "105.00" }] })).status).toBe(201);
  });

  it("#10 bad input is a 422, never a 500", async () => {
    expect((await sell(owner, { payments: [{ method: "CARD", amount: "-100" }] })).status).toBe(400);
    expect((await sell(owner, { lines: [{ itemId: item.id, quantity: "1", discount: "999" }], payments: [{ method: "CASH", amount: "0" }] })).status).toBe(422);
  });

  it("#7 refunding a credit sale reduces the receivable instead of paying cash", async () => {
    const cust = (await call("POST", "/v1/customers", owner, { name: "عميل آجل", creditLimit: "1000.00" })).body;
    const s = await sell(owner, { customerId: cust.id, payments: [{ method: "CREDIT", amount: "115.00" }] });
    await call("POST", `/v1/pos/sales/${s.body.id}/refund`, owner, { clientUuid: randomUUID(), reason: "مرتجع" });
    const list = await call("GET", "/v1/customers", owner);
    expect(list.body.find((c: any) => c.id === cust.id).balance).toBe("0.00");
  });

  it("#4 selling below zero then receiving keeps Inventory GL equal to stock value", async () => {
    const neg = (await call("POST", "/v1/items", owner, { sku: "NEG", nameAr: "بلا رصيد", price: "23.00" })).body;
    await call("POST", "/v1/pos/sales", owner, { clientUuid: randomUUID(), terminalId, lines: [{ itemId: neg.id, quantity: "5" }], payments: [{ method: "CASH", amount: "115.00" }] });
    const sup = (await call("POST", "/v1/suppliers", owner, { name: "مورد" })).body;
    await call("POST", "/v1/inventory/receipts", owner, { warehouseId: wh, supplierId: sup.id, reference: "late", lines: [{ itemId: neg.id, quantity: "10", unitCost: "50" }] });
    const c = await glVsStock();
    expect(c.gl).toBe(c.stock);
  });

  it("cross-tenant ids are rejected even though foreign keys would accept them", async () => {
    const other = await call("POST", "/v1/onboarding", undefined, {
      businessNameAr: "منشأة أخرى", country: "SA", industry: "retail", vatNumber: "310122393500003",
      owner: { fullName: "آخر", email: "other@hard.test", password: "OtherPass#1" },
    });
    const r = await call("POST", "/v1/inventory/receipts", owner, { warehouseId: other.body.warehouseId, reference: "x", lines: [{ itemId: item.id, quantity: "1", unitCost: "1" }] });
    expect(r.status).toBe(422);
  });

  it("#13 a deactivated user is locked out immediately", async () => {
    await ownerDb.query("UPDATE users SET active=false WHERE email='c@hard.test'");
    expect((await call("GET", "/v1/items", cashier)).status).toBe(401);
    await ownerDb.query("UPDATE users SET active=true WHERE email='c@hard.test'");
  });

  it("#2 a suspended account can read but not trade", async () => {
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { status: "suspended" }, { "x-platform-key": "pk" });
    expect((await sell(owner)).status).toBe(402);
    expect((await call("GET", "/v1/items", owner)).status).toBe(200);
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { status: "active" }, { "x-platform-key": "pk" });
  });

  it("#15 device clock too far in the future or past is refused", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect((await sell(owner, { issuedAt: future })).status).toBe(422);
    expect((await sell(owner, { issuedAt: old })).status).toBe(422);
  });

  it("inventory GL still equals stock value after all of the above", async () => {
    const c = await glVsStock();
    expect(c.gl).toBe(c.stock);
  });
});

describe("e-invoice worker resilience (#8)", () => {
  it("keeps documents pending with backoff on transient failures, then submits them", async () => {
    const { reportPending, RetryableSubmitError, MockZatcaClient } = await import("../src/services/einvoice-worker.js");
    await sell(owner);
    const flaky = { submit: async () => { throw new RetryableSubmitError("ZATCA 503"); } };
    const r1 = await reportPending(ownerDb, flaky);
    expect(r1.retrying).toBeGreaterThan(0);
    const pending = await ownerDb.query("SELECT count(*)::int AS n FROM e_invoice_documents WHERE status='PENDING' AND next_attempt_at > now()");
    expect(pending.rows[0].n).toBeGreaterThan(0);
    // nothing is due yet: a second pass does not hammer the authority
    expect((await reportPending(ownerDb, new MockZatcaClient())).processed).toBe(0);
    await ownerDb.query("UPDATE e_invoice_documents SET next_attempt_at = now() WHERE status='PENDING'");
    const r2 = await reportPending(ownerDb, new MockZatcaClient());
    expect(r2.accepted).toBeGreaterThan(0);
    const left = await ownerDb.query("SELECT count(*)::int AS n FROM e_invoice_documents WHERE status='PENDING'");
    expect(left.rows[0].n).toBe(0);
  });

  it("skips authorities without a configured client instead of burning retries", async () => {
    const { reportPending, MockZatcaClient } = await import("../src/services/einvoice-worker.js");
    await sell(owner);
    const r = await reportPending(ownerDb, new MockZatcaClient(), 50, ["ETA"]);
    expect(r.processed).toBe(0);
  });
});
