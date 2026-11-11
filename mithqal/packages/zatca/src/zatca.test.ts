import { describe, expect, it } from "vitest";
import {
  INITIAL_PIH,
  NEW_DEVICE_CHAIN,
  buildPhase1Qr,
  buildUblInvoice,
  decodeTlv,
  encodeTlvBase64,
  generateDeviceKeys,
  issueInvoice,
  verifyInvoiceHash,
  type IssueInput,
} from "./index.js";

const seller = {
  name: "مقهى مثقال",
  vatNumber: "310122393500003",
  crNumber: "1010010000",
  address: { street: "طريق الملك فهد", buildingNumber: "1234", district: "العليا", city: "الرياض", postalCode: "12211", countryCode: "SA" },
};

function sample(n: string): IssueInput {
  return {
    kind: "SIMPLIFIED",
    documentType: "INVOICE",
    number: n,
    uuid: "8d487816-70b8-4ade-a618-9d620b73814a",
    issueDate: "2026-11-10",
    issueTime: "22:15:00",
    timestamp: "2026-11-10T22:15:00Z",
    currency: "SAR",
    seller,
    paymentMeansCode: "10",
    lines: [{ id: 1, name: "كابتشينو", quantity: "2", unitPrice: "10.00", lineNet: "20.00", taxPercent: "15", taxAmount: "3.00" }],
    totals: { lineExtension: "20.00", taxExclusive: "20.00", taxTotal: "3.00", taxInclusive: "23.00", allowanceTotal: "0.00", payable: "23.00" },
  };
}

describe("TLV", () => {
  it("round-trips Arabic text and binary", () => {
    const b64 = encodeTlvBase64([
      { tag: 1, value: "مقهى" },
      { tag: 8, value: new Uint8Array([1, 2, 3]) },
    ]);
    const m = decodeTlv(b64);
    expect(m.get(1)?.toString("utf8")).toBe("مقهى");
    expect([...(m.get(8) ?? [])]).toEqual([1, 2, 3]);
  });

  it("encodes the well-known phase 1 sample exactly", () => {
    // Sample from ZATCA QR guidance: seller "Bobs Records", VAT 310122393500003
    const qr = buildPhase1Qr({
      sellerName: "Bobs Records",
      vatNumber: "310122393500003",
      timestamp: "2022-04-25T15:30:00Z",
      total: "1000.00",
      vatTotal: "150.00",
    });
    expect(qr).toBe(
      "AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==",
    );
  });

  it("rejects invalid KSA VAT numbers", () => {
    expect(() =>
      buildPhase1Qr({ sellerName: "x", vatNumber: "123", timestamp: "t", total: "1", vatTotal: "0" }),
    ).toThrow();
  });
});

describe("invoice chain", () => {
  it("uses ZATCA's initial PIH", () => {
    expect(INITIAL_PIH).toBe("NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==");
  });

  it("links ICV and PIH across invoices and signs verifiably", () => {
    const keys = generateDeviceKeys();
    const a = issueInvoice(sample("INV-1"), NEW_DEVICE_CHAIN, keys);
    expect(a.icv).toBe(1);
    expect(a.pih).toBe(INITIAL_PIH);
    expect(verifyInvoiceHash(a.hash, a.signature, keys.publicKeyPem)).toBe(true);

    const b = issueInvoice(sample("INV-2"), a.nextChain, keys);
    expect(b.icv).toBe(2);
    expect(b.pih).toBe(a.hash);
    expect(b.hash).not.toBe(a.hash);

    const qr = decodeTlv(b.qr);
    expect(qr.get(4)?.toString()).toBe("23.00");
    expect(qr.get(6)?.toString()).toBe(b.hash);
    expect(qr.get(7)?.toString()).toBe(b.signature);
    expect(b.xml).toContain(`<cbc:UUID>2</cbc:UUID>`);
    expect(b.xml).toContain(b.qr);
  });

  it("produces deterministic hashes for identical content", () => {
    const keys = generateDeviceKeys();
    const a = issueInvoice(sample("INV-1"), NEW_DEVICE_CHAIN, keys);
    const b = issueInvoice(sample("INV-1"), NEW_DEVICE_CHAIN, keys);
    expect(a.hash).toBe(b.hash);
  });
});

describe("UBL", () => {
  it("escapes XML special characters", () => {
    const s = sample("A&B<1>");
    const { hashable } = buildUblInvoice({ ...s, icv: 1, pih: INITIAL_PIH });
    expect(hashable).toContain("A&amp;B&lt;1&gt;");
  });

  it("uses reporting:1.0 for every type and adds the supply date on standard invoices", () => {
    const std = buildUblInvoice({ ...sample("X"), kind: "STANDARD", buyer: { name: "B", vatNumber: "311111111111113" }, icv: 1, pih: INITIAL_PIH });
    expect(std.hashable).toContain("<cbc:ProfileID>reporting:1.0</cbc:ProfileID>");
    expect(std.hashable).toContain("<cac:Delivery><cbc:ActualDeliveryDate>2026-11-10</cbc:ActualDeliveryDate></cac:Delivery>");
  });

  it("marks simplified invoices with reporting profile and 0200000", () => {
    const { hashable } = buildUblInvoice({ ...sample("X"), icv: 1, pih: INITIAL_PIH });
    expect(hashable).toContain("<cbc:ProfileID>reporting:1.0</cbc:ProfileID>");
    expect(hashable).toContain('name="0200000">388<');
  });

  it("requires a buyer on standard invoices and a reason on credit notes", () => {
    expect(() => buildUblInvoice({ ...sample("X"), kind: "STANDARD", icv: 1, pih: INITIAL_PIH })).toThrow();
    expect(() => buildUblInvoice({ ...sample("X"), documentType: "CREDIT_NOTE", icv: 1, pih: INITIAL_PIH })).toThrow();
  });
});
