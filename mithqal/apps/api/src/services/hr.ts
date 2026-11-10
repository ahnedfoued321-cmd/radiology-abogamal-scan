import { Money } from "@mithqal/money";
import { computePayslip, postPayroll, type ContributionRule } from "@mithqal/domain";
import { BusinessError, maybeOne, one, type Tx } from "../db.js";
import { audit, emit, postJournal, type Actor } from "./core.js";

export interface EmployeeInput {
  fullName: string;
  nationality: string;
  nationalId?: string;
  iban?: string;
  hireDate: string;
  basicSalary: string;
  housing?: string;
  transport?: string;
  otherAllowances?: string;
  documents?: { kind: string; number?: string; expiryDate: string }[];
}

export async function createEmployee(tx: Tx, actor: Actor, e: EmployeeInput) {
  if (e.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(e.iban.replace(/\s/g, ""))) throw new BusinessError("رقم الآيبان غير صحيح");
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO employees (tenant_id, full_name, nationality, national_id, iban, hire_date, basic_salary, housing, transport, other_allowances)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [actor.tenantId, e.fullName, e.nationality.toUpperCase(), e.nationalId ?? null, e.iban?.replace(/\s/g, "") ?? null, e.hireDate,
      e.basicSalary, e.housing ?? "0", e.transport ?? "0", e.otherAllowances ?? "0"],
  );
  for (const d of e.documents ?? []) {
    await tx.query("INSERT INTO employee_documents (tenant_id, employee_id, kind, number, expiry_date) VALUES ($1,$2,$3,$4,$5)", [
      actor.tenantId, row.id, d.kind, d.number ?? null, d.expiryDate,
    ]);
  }
  await audit(tx, actor, "employee.created", "employee", row.id, { fullName: e.fullName });
  return { id: row.id };
}

/** Rules in force for the period end, latest effective_from per code. */
async function rulesFor(tx: Tx, country: string, appliesTo: "NATIONAL" | "EXPAT", periodEnd: string): Promise<ContributionRule[]> {
  const r = await tx.query<{ code: string; employee_pct: string; employer_pct: string }>(
    `SELECT DISTINCT ON (code) code, employee_pct, employer_pct FROM contribution_rules
      WHERE country=$1 AND applies_to=$2 AND effective_from <= $3 ORDER BY code, effective_from DESC`,
    [country, appliesTo, periodEnd],
  );
  return r.rows.map((x) => ({ code: x.code, employeePct: x.employee_pct, employerPct: x.employer_pct }));
}

/** Run and post payroll for a month. One run per period (re-running is refused; corrections go in the next period). */
export async function runPayroll(tx: Tx, actor: Actor, input: { period: string; deductions?: Record<string, string> }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new BusinessError("الفترة يجب أن تكون بصيغة YYYY-MM");
  if (await maybeOne(tx, "SELECT 1 FROM payroll_runs WHERE period=$1", [input.period])) throw new BusinessError("تم تشغيل رواتب هذا الشهر بالفعل");
  const company = await one<{ country: string; currency: string }>(tx, "SELECT country, currency FROM companies LIMIT 1");
  const [y, m] = input.period.split("-").map(Number) as [number, number];
  const periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const emps = await tx.query<{ id: string; full_name: string; nationality: string; basic_salary: string; housing: string; transport: string; other_allowances: string }>(
    "SELECT * FROM employees WHERE active AND hire_date <= $1 ORDER BY full_name", [periodEnd],
  );
  if (!emps.rowCount) throw new BusinessError("لا يوجد موظفون نشطون لهذه الفترة");
  const runId = crypto.randomUUID();
  const slips: { employee: (typeof emps.rows)[number]; p: ReturnType<typeof computePayslip> }[] = [];
  for (const e of emps.rows) {
    const rules = await rulesFor(tx, company.country, e.nationality === company.country ? "NATIONAL" : "EXPAT", periodEnd);
    const p = computePayslip({
      basic: e.basic_salary, housing: e.housing, transport: e.transport, other: e.other_allowances,
      deductions: input.deductions?.[e.id], rules, currency: company.currency,
    });
    slips.push({ employee: e, p });
  }
  const tot = (f: (s: (typeof slips)[number]["p"]) => Money) => Money.sum(slips.map((s) => f(s.p)));
  const gross = tot((p) => p.gross), ee = tot((p) => p.employeeContrib), er = tot((p) => p.employerContrib);
  const ded = tot((p) => p.deductions), net = tot((p) => p.net);
  await tx.query(
    `INSERT INTO payroll_runs (id, tenant_id, period, gross, employee_contrib, employer_contrib, deductions, net_pay, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, actor.tenantId, input.period, gross.toStorage(), ee.toStorage(), er.toStorage(), ded.toStorage(), net.toStorage(), actor.userId],
  );
  for (const { employee, p } of slips) {
    await tx.query(
      `INSERT INTO payslips (tenant_id, run_id, employee_id, basic, allowances, gross, employee_contrib, employer_contrib, deductions, net_pay, breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [actor.tenantId, runId, employee.id, p.basic.toStorage(), p.allowances.toStorage(), p.gross.toStorage(), p.employeeContrib.toStorage(),
        p.employerContrib.toStorage(), p.deductions.toStorage(), p.net.toStorage(),
        JSON.stringify(p.lines.map((l) => ({ code: l.code, employee: l.employee.toFixed(2), employer: l.employer.toFixed(2) })))],
    );
  }
  await postJournal(tx, actor, postPayroll({ period: input.period, gross, employeeContrib: ee, employerContrib: er, deductions: ded }), {
    type: "PAYROLL", id: runId, date: periodEnd,
  });
  await emit(tx, actor.tenantId, "PayrollPosted", { runId, period: input.period, net: net.toFixed(2) });
  await audit(tx, actor, "payroll.posted", "payroll_run", runId, { period: input.period, employees: slips.length });
  return payrollRun(tx, input.period);
}

export async function payrollRun(tx: Tx, period: string) {
  const run = await one<Record<string, string>>(tx, "SELECT * FROM payroll_runs WHERE period=$1", [period]);
  const slips = await tx.query(
    `SELECT e.full_name, e.iban, s.gross, s.employee_contrib, s.employer_contrib, s.deductions, s.net_pay, s.breakdown
       FROM payslips s JOIN employees e ON e.id=s.employee_id WHERE s.run_id=$1 ORDER BY e.full_name`,
    [run.id],
  );
  const f = (v: string) => Money.of(v).toFixed(2);
  return {
    period, gross: f(run.gross!), employeeContrib: f(run.employee_contrib!), employerContrib: f(run.employer_contrib!),
    deductions: f(run.deductions!), netPay: f(run.net_pay!),
    payslips: slips.rows.map((s) => ({ ...s, gross: f(s.gross), employee_contrib: f(s.employee_contrib), employer_contrib: f(s.employer_contrib), deductions: f(s.deductions), net_pay: f(s.net_pay) })),
  };
}

/** Generic salary transfer file (CSV) for the bank / WPS upload. Bank-specific formats are mapped from this. */
export async function bankFile(tx: Tx, period: string): Promise<string> {
  const r = await payrollRun(tx, period);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = r.payslips.map((s) => [s.full_name, s.iban ?? "", s.net_pay].map(esc).join(","));
  return ["employee_name,iban,net_amount", ...rows].join("\n") + "\n";
}

export async function expiringDocuments(tx: Tx, today: string, days: number) {
  const r = await tx.query<{ full_name: string; kind: string; number: string | null; expiry_date: string; days: number }>(
    `SELECT e.full_name, d.kind, d.number, to_char(d.expiry_date,'YYYY-MM-DD') AS expiry_date, (d.expiry_date - $1::date) AS days
       FROM employee_documents d JOIN employees e ON e.id=d.employee_id
      WHERE e.active AND d.expiry_date <= $1::date + $2::int ORDER BY d.expiry_date`,
    [today, days],
  );
  return r.rows;
}
