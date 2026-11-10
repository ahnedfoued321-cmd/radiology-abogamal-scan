import { describe, expect, it } from "vitest";
import { buildReceipt, isValidEgyptRin, receiptShareUrl, sealReceipt, serialize } from "./index.js";

describe("ETA canonical serialization", () => {
  it("upper-cases names, quotes values and repeats array names", () => {
    expect(serialize({ a: "x", n: 5 })).toBe('"A""x""N""5"');
    expect(serialize({ items: [{ c: "1" }, { c: "2" }] })).toBe('"ITEMS""ITEMS""C""1""ITEMS""C""2"');
    expect(serialize({ o: { p: true, q: null } })).toBe('"O""P""true""Q"""');
  });
});

const input = {
  receiptType: "S" as const,
  receiptNumber: "EG1-000001",
  dateTimeIssued: "2026-11-10T20:00:00Z",
  previousUUID: "",
  seller: {
    rin: "123456789",
    companyTradeName: "صيدلية النيل",
    branchCode: "0",
    deviceSerialNumber: "POS-EG-1",
    activityCode: "4772",
    address: { country: "EG" as const, governate: "القاهرة", regionCity: "مدينة نصر", street: "عباس العقاد", buildingNumber: "10" },
  },
  lines: [{
    internalCode: "PARA", description: "باراسيتامول", itemType: "EGS" as const, itemCode: "EG-123456789-PARA", unitType: "EA",
    quantity: 2, unitPrice: "50.00", netSale: "100.00", totalSale: "100.00", total: "114.00", taxAmount: "14.00", taxRate: 14,
  }],
  totals: { totalSales: "100.00", netAmount: "100.00", taxTotal: "14.00", totalAmount: "114.00" },
  paymentMethod: "C" as const,
};

describe("ETA e-receipt", () => {
  it("seals a receipt with a deterministic SHA-256 uuid", () => {
    const a = sealReceipt(buildReceipt(input));
    const b = sealReceipt(buildReceipt(input));
    expect(a.uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(a.uuid).toBe(b.uuid);
    expect((a.receipt.header as any).uuid).toBe(a.uuid);
  });

  it("chains receipts per device via previousUUID", () => {
    const first = sealReceipt(buildReceipt(input));
    const second = sealReceipt(buildReceipt({ ...input, receiptNumber: "EG1-000002", previousUUID: first.uuid }));
    expect((second.receipt.header as any).previousUUID).toBe(first.uuid);
    expect(second.uuid).not.toBe(first.uuid);
  });

  it("builds return receipts that reference the original", () => {
    const orig = sealReceipt(buildReceipt(input));
    const ret = buildReceipt({ ...input, receiptType: "R", referenceUUID: orig.uuid });
    expect((ret.header as any).referenceUUID).toBe(orig.uuid);
    expect((ret.documentType as any).receiptType).toBe("R");
  });

  it("validates RIN and builds the QR share URL", () => {
    expect(isValidEgyptRin("123456789")).toBe(true);
    expect(isValidEgyptRin("12345")).toBe(false);
    expect(receiptShareUrl("ab", "2026-11-10T20:00:00Z", "114.00", "123456789")).toBe(
      "https://invoicing.eta.gov.eg/receipts/search/ab/share/2026-11-10T20:00:00Z#Total:114.00,IssuerRIN:123456789",
    );
  });
});
