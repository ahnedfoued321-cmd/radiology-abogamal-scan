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
  let body: any = res.body;
  try { body = res.json(); } catch { /* csv */ }
  return { status: res.statusCode, body, headers: res.headers };
}

let token: string;
let saudiId: string;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  app = buildApp(db, config);
  await app.ready();
  token = (await call("POST", "/v1/onboarding", undefined, {
    businessNameAr: "شركة الرواتب", country: "SA", industry: "services", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@hr.test", password: "OwnerPass#1" },
  })).body.token;
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("HR & payroll (KSA)", () => {
  it("registers employees with documents and validates IBAN", async () => {
    const bad = await call("POST", "/v1/hr/employees", token, { fullName: "xx", nationality: "SA", hireDate: "2025-01-01", basicSalary: "1000", iban: "123" });
    expect(bad.status).toBe(422);
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    saudiId = (await call("POST", "/v1/hr/employees", token, {
      fullName: "فهد العتيبي", nationality: "SA", hireDate: "2025-01-01", basicSalary: "8000.00", housing: "2000.00", transport: "800.00",
      iban: "SA0380000000608010167519",
    })).body.id;
    const expat = await call("POST", "/v1/hr/employees", token, {
      fullName: "Ramesh Kumar", nationality: "IN", hireDate: "2025-06-01", basicSalary: "4000.00", housing: "1000.00", transport: "500.00",
      iban: "SA4420000001234567891234", documents: [{ kind: "IQAMA", number: "2400000000", expiryDate: soon }],
    });
    expect(expat.status).toBe(201);
    const docs = await call("GET", "/v1/hr/expiring-documents?days=30", token);
    expect(docs.body).toHaveLength(1);
    expect(docs.body[0].kind).toBe("IQAMA");
  });

  it("runs payroll with GOSI for nationals and hazards-only for expats, posted to the ledger", async () => {
    const r = await call("POST", "/v1/hr/payroll", token, { period: "2026-10", deductions: { [saudiId]: "250.00" } });
    expect(r.status).toBe(201);
    expect(r.body.gross).toBe("16300.00");          // 10800 + 5500
    expect(r.body.employeeContrib).toBe("975.00");  // national only: 9.75% of 10000
    expect(r.body.employerContrib).toBe("1275.00"); // 1175 + expat hazards 2% of 5000
    expect(r.body.netPay).toBe("15075.00");         // 16300 − 975 − 250
    const fahd = r.body.payslips.find((p: any) => p.full_name === "فهد العتيبي");
    expect(fahd.net_pay).toBe("9575.00");
    expect((await call("POST", "/v1/hr/payroll", token, { period: "2026-10" })).status).toBe(422); // once per period

    const tb = await call("GET", "/v1/reports/trial-balance?from=2026-10-01&to=2026-10-31", token);
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.rows.find((x: any) => x.code === "2130").balance).toBe("-2250.00");
    expect(tb.body.rows.find((x: any) => x.code === "2120").balance).toBe("-15075.00"); // salaries payable = bank file total
  });

  it("applies the 2024 social insurance law (10% annuities in 2026) to new Saudi entrants only", async () => {
    const t2 = (await call("POST", "/v1/onboarding", undefined, {
      businessNameAr: "شركة القانون الجديد", country: "SA", industry: "services", vatNumber: "310122393500003",
      owner: { fullName: "مالك", email: "owner2@hr.test", password: "OwnerPass#1" },
    })).body.token;
    await call("POST", "/v1/hr/employees", t2, { fullName: "سارة (نظام قديم)", nationality: "SA", hireDate: "2020-01-01", basicSalary: "8000.00", housing: "2000.00" });
    await call("POST", "/v1/hr/employees", t2, {
      fullName: "خالد (نظام جديد)", nationality: "SA", hireDate: "2025-01-01", gosiFirstRegistered: "2025-01-01", basicSalary: "8000.00", housing: "2000.00",
    });
    const oct = (await call("POST", "/v1/hr/payroll", t2, { period: "2026-10" })).body;
    const old = oct.payslips.find((p: any) => p.full_name.includes("قديم"));
    const neu = oct.payslips.find((p: any) => p.full_name.includes("جديد"));
    expect(old.employee_contrib).toBe("975.00");   // 9% + 0.75% of 10,000
    expect(neu.employee_contrib).toBe("1075.00");  // 10% + 0.75% (step from 3 Jul 2026)
    expect(neu.employer_contrib).toBe("1275.00");  // 10% + 0.75% + 2%
    // June 2026 is still on the 9.5% step
    const jun = (await call("POST", "/v1/hr/payroll", t2, { period: "2026-06" })).body;
    expect(jun.payslips.find((p: any) => p.full_name.includes("جديد")).employee_contrib).toBe("1025.00");
  });

  it("exports the salary bank file", async () => {
    const f = await call("GET", "/v1/hr/payroll/2026-10/bank-file", token);
    expect(f.headers["content-type"]).toContain("text/csv");
    expect(f.body).toContain('"فهد العتيبي","SA0380000000608010167519","9575.00"');
  });
});
