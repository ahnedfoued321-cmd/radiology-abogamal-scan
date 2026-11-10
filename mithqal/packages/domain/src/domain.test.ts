import { describe, expect, it } from "vitest";
import { Money } from "@mithqal/money";
import {
  EMPTY_POSITION,
  SA_RETAIL_CHART,
  allocateFefo,
  assertBalanced,
  cr,
  daysToExpiry,
  dr,
  issue,
  postPurchase,
  postSale,
  postSaleReturn,
  priceDocument,
  receive,
  validateChart,
} from "./index.js";

describe("pricing", () => {
  it("prices tax-inclusive POS lines so totals reconcile", () => {
    const doc = priceDocument(
      [
        { itemId: "a", name: "Latte", quantity: 2, unitPrice: "17", taxPercent: 15 },
        { itemId: "b", name: "Croissant", quantity: 1, unitPrice: "9.99", taxPercent: 15 },
      ],
      { currency: "SAR", pricesIncludeTax: true },
    );
    expect(doc.totalGross.toFixed()).toBe("43.99");
    expect(doc.totalNet.add(doc.totalTax).toFixed()).toBe("43.99");
    expect(doc.lines[0]!.net.toFixed()).toBe("29.57");
  });

  it("prices tax-exclusive B2B lines with discounts", () => {
    const doc = priceDocument(
      [{ itemId: "a", name: "Box", quantity: 10, unitPrice: "50", discount: "50", taxPercent: 15 }],
      { currency: "SAR", pricesIncludeTax: false },
    );
    expect(doc.totalNet.toFixed()).toBe("450.00");
    expect(doc.totalTax.toFixed()).toBe("67.50");
    expect(doc.totalGross.toFixed()).toBe("517.50");
  });

  it("treats 0% as zero-rated", () => {
    const doc = priceDocument([{ itemId: "m", name: "Medicine", quantity: 1, unitPrice: 30, taxPercent: 0 }], {
      currency: "SAR",
      pricesIncludeTax: true,
    });
    expect(doc.lines[0]!.taxCategory).toBe("Z");
    expect(doc.totalTax.isZero()).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => priceDocument([], { currency: "SAR", pricesIncludeTax: true })).toThrow();
    expect(() =>
      priceDocument([{ itemId: "a", name: "x", quantity: 0, unitPrice: 1, taxPercent: 15 }], { currency: "SAR", pricesIncludeTax: true }),
    ).toThrow();
    expect(() =>
      priceDocument([{ itemId: "a", name: "x", quantity: 1, unitPrice: 10, discount: 11, taxPercent: 15 }], {
        currency: "SAR",
        pricesIncludeTax: true,
      }),
    ).toThrow();
  });
});

describe("ledger", () => {
  it("posts a split-payment sale as a balanced journal", () => {
    const j = postSale({
      invoiceNumber: "S-1",
      totalNet: "100",
      totalTax: "15",
      totalGross: "115",
      costOfGoods: "40",
      payments: [
        { method: "CASH", amount: "15" },
        { method: "CARD", amount: "100" },
      ],
    });
    assertBalanced(j);
    const by = (role: string) => j.lines.find((l) => l.role === role)!;
    expect(by("VAT_OUTPUT").credit.toFixed()).toBe("15.00");
    expect(by("SALES_REVENUE").credit.toFixed()).toBe("100.00");
    expect(by("COST_OF_GOODS_SOLD").debit.toFixed()).toBe("40.00");
  });

  it("refuses a sale whose payments do not match", () => {
    expect(() =>
      postSale({ invoiceNumber: "S", totalNet: 100, totalTax: 15, totalGross: 115, costOfGoods: 0, payments: [{ method: "CASH", amount: 100 }] }),
    ).toThrow(/do not match/);
  });

  it("reverses a sale exactly on return", () => {
    const input = { invoiceNumber: "S-1", totalNet: 100, totalTax: 15, totalGross: 115, costOfGoods: 40, payments: [{ method: "CASH" as const, amount: 115 }] };
    const r = postSaleReturn(input);
    expect(r.lines.find((l) => l.role === "VAT_OUTPUT")!.debit.toFixed()).toBe("15.00");
    expect(r.lines.find((l) => l.role === "CASH")!.credit.toFixed()).toBe("115.00");
  });

  it("detects unbalanced or malformed journals", () => {
    expect(() => assertBalanced({ memo: "x", lines: [dr("CASH", 10), cr("SALES_REVENUE", 9)] })).toThrow(/Unbalanced/);
    expect(() => assertBalanced({ memo: "x", lines: [dr("CASH", 10)] })).toThrow();
    expect(() =>
      assertBalanced({ memo: "x", lines: [{ role: "CASH", debit: Money.of(1), credit: Money.of(1) }, cr("SALES_REVENUE", 0)] }),
    ).toThrow();
  });

  it("posts purchases with input VAT", () => {
    const j = postPurchase({ reference: "P-1", net: 200, tax: 30 });
    expect(j.lines.find((l) => l.role === "ACCOUNTS_PAYABLE")!.credit.toFixed()).toBe("230.00");
  });
});

describe("inventory", () => {
  it("maintains moving average cost", () => {
    let p = receive(EMPTY_POSITION, 10, "5");
    p = receive(p, 10, "7");
    expect(p.averageCost.toFixed()).toBe("6.00");
    const r = issue(p, 5, { allowNegative: false });
    expect(r.cost.toFixed()).toBe("30.00");
    expect(r.position.quantity.toFixed(0)).toBe("15");
  });

  it("blocks or flags negative stock by policy", () => {
    const p = receive(EMPTY_POSITION, 1, 10);
    expect(() => issue(p, 2, { allowNegative: false })).toThrow(/Insufficient/);
    expect(issue(p, 2, { allowNegative: true }).wentNegative).toBe(true);
  });

  it("resets average cost after negative stock is replenished", () => {
    const neg = issue(EMPTY_POSITION, 3, { allowNegative: true }).position;
    const p = receive(neg, 5, 8);
    expect(p.quantity.toFixed(0)).toBe("2");
    expect(p.averageCost.toFixed()).toBe("8.00");
  });

  it("allocates FEFO and skips expired batches", () => {
    const today = "2026-11-10";
    const alloc = allocateFefo(
      [
        { batchId: "B-late", expiryDate: "2027-06-01", quantity: 10 },
        { batchId: "B-expired", expiryDate: "2026-10-01", quantity: 50 },
        { batchId: "B-soon", expiryDate: "2026-12-01", quantity: 3 },
        { batchId: "B-none", expiryDate: null, quantity: 100 },
      ],
      5,
      today,
    );
    expect(alloc.map((a) => [a.batchId, a.quantity.toFixed(0)])).toEqual([
      ["B-soon", "3"],
      ["B-late", "2"],
    ]);
    expect(() => allocateFefo([{ batchId: "x", expiryDate: "2026-01-01", quantity: 9 }], 1, today)).toThrow();
    expect(daysToExpiry("2026-12-10", today)).toBe(30);
  });
});

describe("chart of accounts", () => {
  it("SA template is valid and maps every posting role", () => {
    validateChart(SA_RETAIL_CHART);
    const roles = SA_RETAIL_CHART.filter((a) => a.role).map((a) => a.role);
    for (const r of ["CASH", "BANK_CARD_CLEARING", "ACCOUNTS_RECEIVABLE", "INVENTORY", "VAT_OUTPUT", "VAT_INPUT", "SALES_REVENUE", "COST_OF_GOODS_SOLD", "ACCOUNTS_PAYABLE"]) {
      expect(roles).toContain(r);
    }
  });
});
