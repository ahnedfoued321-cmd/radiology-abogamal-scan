import { describe, expect, it } from "vitest";
import { Money, allocate, taxFromGross, taxFromNet } from "./index.js";

describe("Money", () => {
  it("avoids floating point errors", () => {
    expect(Money.of("0.1").add("0.2").eq("0.3")).toBe(true);
  });

  it("rounds half up", () => {
    expect(Money.of("1.005").round(2).toFixed()).toBe("1.01");
    expect(Money.of("2.345").roundTo("SAR").toFixed()).toBe("2.35");
    expect(Money.of("2.3455").roundTo("KWD").toFixed(3)).toBe("2.346");
  });

  it("rejects invalid input", () => {
    expect(() => Money.of(Number.NaN)).toThrow();
    expect(() => Money.of("abc")).toThrow();
    expect(() => Money.of(1).div(0)).toThrow();
  });

  it("serializes for storage with 4dp", () => {
    expect(Money.of("12.5").toStorage()).toBe("12.5000");
    expect(JSON.stringify({ a: Money.of(3) })).toBe('{"a":"3.0000"}');
  });
});

describe("VAT", () => {
  it("computes 15% KSA VAT on net", () => {
    const s = taxFromNet("100", 15);
    expect(s.tax.toFixed()).toBe("15.00");
    expect(s.gross.toFixed()).toBe("115.00");
  });

  it("splits tax-inclusive price exactly", () => {
    const s = taxFromGross("23", 15);
    expect(s.net.toFixed()).toBe("20.00");
    expect(s.tax.toFixed()).toBe("3.00");
    expect(s.net.add(s.tax).eq("23")).toBe(true);
  });

  it("keeps gross intact for awkward inclusive prices", () => {
    const s = taxFromGross("9.99", 15);
    expect(s.net.add(s.tax).toFixed()).toBe("9.99");
    expect(s.net.toFixed()).toBe("8.69");
  });

  it("computes 14% Egypt VAT", () => {
    expect(taxFromNet("200", 14, "EGP").tax.toFixed()).toBe("28.00");
  });
});

describe("allocate", () => {
  it("never loses a cent", () => {
    const parts = allocate("100", [1, 1, 1]);
    expect(parts.map((p) => p.toFixed())).toEqual(["33.34", "33.33", "33.33"]);
    expect(Money.sum(parts).toFixed()).toBe("100.00");
  });
  it("allocates proportionally", () => {
    const parts = allocate("10", [3, 1]);
    expect(parts.map((p) => p.toFixed())).toEqual(["7.50", "2.50"]);
  });
});
