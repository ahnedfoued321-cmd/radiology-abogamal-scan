import { DomainError } from "./errors.js";
import { Money, type DecimalInput } from "@mithqal/money";
import { assertBalanced, cr, dr, type JournalDraft } from "./ledger.js";

export interface ContributionRule {
  code: string;
  employeePct: DecimalInput;
  employerPct: DecimalInput;
}

export interface PayslipInput {
  basic: DecimalInput;
  housing: DecimalInput;
  transport: DecimalInput;
  other: DecimalInput;
  deductions?: DecimalInput; // loans, penalties, absence
  rules: ContributionRule[]; // already filtered for the employee (national/expat) and period
  currency?: string;
}

export interface Payslip {
  basic: Money;
  allowances: Money;
  gross: Money;
  contributionBase: Money;
  employeeContrib: Money;
  employerContrib: Money;
  deductions: Money;
  net: Money;
  lines: { code: string; employee: Money; employer: Money }[];
}

/** Compute one payslip. Contributions are on basic + housing (KSA GOSI base), rounded per rule. */
export function computePayslip(i: PayslipInput): Payslip {
  const cur = i.currency ?? "SAR";
  const basic = Money.of(i.basic).roundTo(cur);
  const allowances = Money.of(i.housing).add(i.transport).add(i.other).roundTo(cur);
  const gross = basic.add(allowances);
  const base = basic.add(i.housing).roundTo(cur);
  const lines = i.rules.map((r) => ({
    code: r.code,
    employee: base.mul(r.employeePct).div(100).roundTo(cur),
    employer: base.mul(r.employerPct).div(100).roundTo(cur),
  }));
  const employeeContrib = Money.sum(lines.map((l) => l.employee));
  const employerContrib = Money.sum(lines.map((l) => l.employer));
  const deductions = Money.of(i.deductions ?? 0).roundTo(cur);
  if (deductions.isNegative()) throw new DomainError("Deductions cannot be negative");
  const net = gross.sub(employeeContrib).sub(deductions);
  if (net.isNegative()) throw new DomainError("Deductions exceed gross pay");
  return { basic, allowances, gross, contributionBase: base, employeeContrib, employerContrib, deductions, net, lines };
}

/**
 * Posting rule: payroll run.
 *   Dr Salaries expense (gross) · Dr Employer social insurance expense
 *   Cr Salaries payable (net + other deductions retained) · Cr Social insurance payable (employee + employer)
 */
export function postPayroll(i: { period: string; gross: DecimalInput; employeeContrib: DecimalInput; employerContrib: DecimalInput; deductions?: DecimalInput }): JournalDraft {
  // Deductions (absence, penalties) reduce the salary cost; the payable equals exactly what the bank file pays.
  const deductions = Money.of(i.deductions ?? 0);
  if (deductions.isNegative()) throw new DomainError("Deductions cannot be negative");
  const payable = Money.of(i.gross).sub(i.employeeContrib).sub(deductions);
  const insurance = Money.of(i.employeeContrib).add(i.employerContrib);
  const j: JournalDraft = {
    memo: `Payroll ${i.period}`,
    lines: [
      dr("SALARIES_EXPENSE", Money.of(i.gross).sub(deductions)),
      dr("SOCIAL_INSURANCE_EXPENSE", i.employerContrib),
      cr("SALARIES_PAYABLE", payable),
      cr("SOCIAL_INSURANCE_PAYABLE", insurance),
    ].filter((l) => !(l.debit.isZero() && l.credit.isZero())),
  };
  assertBalanced(j);
  return j;
}
