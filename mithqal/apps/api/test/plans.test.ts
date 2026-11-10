import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test", PLATFORM_KEY: "platform-secret" });
let db: Db;
let ownerDb: Db;
let app: FastifyInstance;

async function call(method: "GET" | "POST", url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.statusCode, body: res.json() as any };
}
const P = { "x-platform-key": "platform-secret" };

let token: string;
let tenantId: string;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  ownerDb = createPool(config.migrationUrl);
  app = buildApp(db, config, ownerDb);
  await app.ready();
  const o = await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "بقالة التجربة", country: "SA", industry: "retail", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@plans.test", password: "OwnerPass#1" },
  });
  ({ token, tenantId } = o.body);
});

afterAll(async () => {
  await app.close();
  await db.end();
  await ownerDb.end();
});

describe("plans & module licensing", () => {
  it("starts every new business on a 14-day Pro trial", async () => {
    const s = await call("GET", "/v1/subscription", token);
    expect(s.body.plan).toBe("free");
    expect(s.body.effectivePlan).toBe("pro");
    expect(s.body.onTrial).toBe(true);
    expect(s.body.modules).toContain("van_sales");
    expect(s.body.plans.map((p: any) => p.code)).toEqual(["enterprise", "free", "growth", "pro"]);
  });

  it("locks paid modules and limits after the trial on the Free plan", async () => {
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { endTrial: true }, P);
    const s = await call("GET", "/v1/subscription", token);
    expect(s.body.effectivePlan).toBe("free");

    const ask = await call("POST", "/v1/assistant/ask", token, { question: "كم بعنا؟" });
    expect(ask.status).toBe(402);
    expect(ask.body.upgradeTo).toBe("growth");
    const batch = await call("POST", "/v1/items", token, { sku: "D", nameAr: "دواء", price: "5", trackBatches: true });
    expect(batch.status).toBe(402);
    const rep = await call("POST", "/v1/users", token, { fullName: "مندوب", email: "rep@plans.test", password: "RepPass#123", role: "sales_rep" });
    expect(rep.status).toBe(402);

    // Free allows 2 users: owner + 1
    expect((await call("POST", "/v1/users", token, { fullName: "كاشير", email: "c1@plans.test", password: "CashPass#12", role: "cashier" })).status).toBe(201);
    const third = await call("POST", "/v1/users", token, { fullName: "كاشير 2", email: "c2@plans.test", password: "CashPass#12", role: "cashier" });
    expect(third.status).toBe(402);
    expect(third.body.message).toContain("الأقصى");
  });

  it("unlocks modules immediately on upgrade", async () => {
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { plan: "growth" }, P);
    expect((await call("POST", "/v1/assistant/ask", token, { question: "كم بعنا؟" })).status).toBe(200);
    expect((await call("POST", "/v1/branches", token, { name: "فرع" })).status).toBe(402); // multi-branch is Pro
    expect((await call("GET", "/v1/insights/cashiers", token)).status).toBe(402); // Fraud Guard is Pro
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { plan: "pro" }, P);
    expect((await call("GET", "/v1/insights/cashiers", token)).status).toBe(200);
  });

  it("opens a new branch with its own warehouse and POS (Pro), compared in the branch report", async () => {
    const r = await call("POST", "/v1/branches", token, { name: "فرع جدة" });
    expect(r.status).toBe(201);
    const me = await call("GET", "/v1/me", token);
    expect(me.body.terminals.map((t: any) => t.prefix)).toEqual(["POS1", "POS2"]);
    const rep = await call("GET", "/v1/reports/branches", token);
    expect(rep.body.map((b: any) => b.name)).toContain("فرع جدة");
  });

  it("blocks module use for suspended accounts", async () => {
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { status: "suspended" }, P);
    const r = await call("POST", "/v1/assistant/ask", token, { question: "كم بعنا؟" });
    expect(r.status).toBe(402);
    expect(r.body.message).toContain("موقوف");
    await call("POST", `/v1/platform/tenants/${tenantId}/plan`, undefined, { status: "active" }, P);
  });

  it("platform API is invisible without the operator key and reports MRR", async () => {
    expect((await call("GET", "/v1/platform/tenants")).status).toBe(404);
    expect((await call("GET", "/v1/platform/tenants", undefined, undefined, { "x-platform-key": "wrong" })).status).toBe(404);
    const r = await call("GET", "/v1/platform/tenants", undefined, undefined, P);
    expect(r.body.tenants).toBe(1);
    expect(r.body.payingTenants).toBe(1);
    expect(r.body.mrrSar).toBe("349.00");
  });
});
