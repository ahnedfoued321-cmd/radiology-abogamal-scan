import { describe, expect, it } from "vitest";
import { computePayslip, postPayroll } from "./payroll.js";
import { assertBalanced } from "./ledger.js";

const NATIONAL = [
  { code: "ANNUITIES", employeePct: 9, employerPct: 9 },
  { code: "SANED", employeePct: 0.75, employerPct: 0.75 },
  { code: "HAZARDS", employeePct: 0, employerPct: 2 },
];

describe("payroll", () => {
  it("computes a Saudi national's payslip on basic + housing", () => {
    const p = computePayslip({ basic: 8000, housing: 2000, transport: 800, other: 0, rules: NATIONAL });
    expect(p.gross.toFixed()).toBe("10800.00");
    expect(p.contributionBase.toFixed()).toBe("10000.00");
    expect(p.employeeContrib.toFixed()).toBe("975.00"); // 9% + 0.75%
    expect(p.employerContrib.toFixed()).toBe("1175.00"); // 9% + 0.75% + 2%
    expect(p.net.toFixed()).toBe("9825.00");
  });

  it("applies only occupational hazards (employer) for expats, and deductions", () => {
    const p = computePayslip({ basic: 4000, housing: 1000, transport: 500, other: 0, deductions: 300, rules: [{ code: "HAZARDS", employeePct: 0, employerPct: 2 }] });
    expect(p.employeeContrib.isZero()).toBe(true);
    expect(p.employerContrib.toFixed()).toBe("100.00");
    expect(p.net.toFixed()).toBe("5200.00");
    expect(() => computePayslip({ basic: 100, housing: 0, transport: 0, other: 0, deductions: 500, rules: [] })).toThrow();
  });

  it("posts a balanced payroll journal", () => {
    const j = postPayroll({ period: "2026-11", gross: "10800", employeeContrib: "975", employerContrib: "1175" });
    assertBalanced(j);
    expect(j.lines.find((l) => l.role === "SOCIAL_INSURANCE_PAYABLE")!.credit.toFixed()).toBe("2150.00");
    expect(j.lines.find((l) => l.role === "SALARIES_PAYABLE")!.credit.toFixed()).toBe("9825.00");
  });
});
