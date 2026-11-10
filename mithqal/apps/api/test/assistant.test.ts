import { describe, expect, it } from "vitest";
import { countAr, detectDay, detectIntent, normalizeArabic } from "../src/services/assistant.js";

describe("assistant «ذهب» intent detection (Saudi + Egyptian dialects)", () => {
  const cases: [string, string][] = [
    ["كم بعنا اليوم؟", "SALES"],
    ["بعنا كام النهارده", "SALES"],
    ["كسبنا كام امبارح؟", "PROFIT"],
    ["وش الأرباح هاليوم", "PROFIT"],
    ["ايش الاكثر مبيعاً؟", "TOP_ITEMS"],
    ["إيه النواقص؟", "LOW_STOCK"],
    ["مين عليه فلوس؟", "RECEIVABLES"],
    ["العملاء المتأخرين في السداد", "RECEIVABLES"],
    ["كم الضريبة هالشهر", "VAT"],
    ["فيه ادوية قربت تنتهي صلاحيتها؟", "EXPIRING"],
    ["وضع زاتكا ايه", "COMPLIANCE"],
    ["في كاشير بيعمل مرتجعات كتير؟", "CASHIERS"],
    ["مرحبا", "HELP"],
  ];
  for (const [q, intent] of cases) {
    it(`${q} → ${intent}`, () => expect(detectIntent(q)).toBe(intent));
  }

  it("normalizes Arabic letter variants and diacritics", () => {
    expect(normalizeArabic("الضَّريبةُ إلى أحمد")).toBe("الضريبه الي احمد");
  });

  it("understands yesterday in both dialects", () => {
    const now = new Date("2026-11-10T09:00:00Z");
    expect(detectDay("مبيعات امبارح", now)).toBe("2026-11-09");
    expect(detectDay("مبيعات أمس", now)).toBe("2026-11-09");
    expect(detectDay("مبيعات اليوم", now)).toBe("2026-11-10");
  });
});

describe("Arabic counting", () => {
  it("uses correct plural forms", () => {
    const f = (n: number) => countAr(n, "فاتورة", "فاتورتين", "فواتير");
    expect([f(1), f(2), f(5), f(15)]).toEqual(["فاتورة واحدة", "فاتورتين", "5 فواتير", "15 فاتورة"]);
  });
});
