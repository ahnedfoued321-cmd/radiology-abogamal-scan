/**
 * «ذهب» — Mithqal's business assistant (v1).
 *
 * v1 is deterministic: Arabic (Saudi + Egyptian dialect) intent matching over the tenant's own data,
 * read-only, with the caller's permissions. It never invents numbers — every answer is computed by
 * the same report functions the dashboard uses. A pluggable LLM layer (v2) will sit in front of this
 * as a router + phraser, using these intents as tools; financial actions stay human-approved.
 */
import { Money } from "@mithqal/money";
import type { Tx } from "../db.js";
import { dailySummary, expiringBatches, vatSummary } from "./reports.js";
import { customerBalance } from "./van.js";

export type Intent =
  | "SALES"
  | "PROFIT"
  | "TOP_ITEMS"
  | "LOW_STOCK"
  | "VAT"
  | "RECEIVABLES"
  | "EXPIRING"
  | "COMPLIANCE"
  | "CASHIERS"
  | "HELP";

/** Normalize Arabic: strip diacritics/tatweel, unify alef/ya/ta-marbuta/hamza forms. */
export function normalizeArabic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[؟?!.,،]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RULES: { intent: Intent; words: string[] }[] = [
  { intent: "CASHIERS", words: ["كاشير", "الكاشيرات", "تلاعب", "سرقه", "مرتجعات الموظفين", "الموظفين"] },
  { intent: "EXPIRING", words: ["صلاحيه", "تنتهي", "منتهي", "هتخلص صلاحيتها", "اكسباير", "expiry"] },
  { intent: "RECEIVABLES", words: ["مين عليه", "عليهم فلوس", "مديونيه", "ديون", "ذمم", "متاخر", "المستحقات", "الاجل", "تحصيل"] },
  { intent: "COMPLIANCE", words: ["زاتكا", "zatca", "فاتوره الكترونيه", "الفواتير الالكترونيه", "الامتثال", "فوتره"] },
  { intent: "VAT", words: ["ضريبه", "الضريبه", "vat", "الاقرار"] },
  { intent: "LOW_STOCK", words: ["نواقص", "ناقص", "يخلص", "خلصان", "المخزون", "قرب يخلص", "اطلب ايه"] },
  { intent: "TOP_ITEMS", words: ["اكثر", "افضل", "الاكثر مبيع", "بيتباع", "ينباع", "مطلوب", "top"] },
  { intent: "PROFIT", words: ["ربح", "ارباح", "كسبت", "كسبنا", "مكسب", "هامش", "الربحيه"] },
  { intent: "SALES", words: ["مبيعات", "بعت", "بعنا", "بيعنا", "دخل", "الدخل", "ايراد", "كم بعنا", "الكاش", "sales"] },
];

export function detectIntent(question: string): Intent {
  const q = normalizeArabic(question);
  for (const r of RULES) {
    if (r.words.some((w) => q.includes(normalizeArabic(w)))) return r.intent;
  }
  return "HELP";
}

/** Resolve the day the user means: today (default), yesterday (أمس/امبارح). */
export function detectDay(question: string, now: Date): string {
  const q = normalizeArabic(question);
  const d = new Date(now);
  if (/(امس|امبارح|البارحه)/.test(q)) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface AssistantAnswer {
  intent: Intent;
  answer: string;
  data?: unknown;
  suggestion?: string;
}

/** Arabic counted noun: 1 فاتورة واحدة، 2 فاتورتان، 3–10 فواتير، 11+ فاتورة. */
export function countAr(n: number, one: string, two: string, few: string): string {
  if (n === 0) return `لا ${few}`;
  if (n === 1) return `${one} واحدة`;
  if (n === 2) return two;
  if (n <= 10) return `${n} ${few}`;
  return `${n} ${one}`;
}

const sar = (v: string | Money) => `${Money.of(v).toFixed(2)} ر.س`;

export async function ask(tx: Tx, question: string, now = new Date()): Promise<AssistantAnswer> {
  const intent = detectIntent(question);
  const day = detectDay(question, now);
  const label = day === now.toISOString().slice(0, 10) ? "اليوم" : `يوم ${day}`;

  switch (intent) {
    case "SALES": {
      const d = await dailySummary(tx, day);
      return {
        intent,
        answer: `مبيعات ${label}: ${sar(d.grossSales)} شامل الضريبة من ${countAr(d.invoices, "فاتورة", "فاتورتين", "فواتير")}` + (d.creditNotes ? ` (و${d.creditNotes} مرتجع)` : "") + ".",
        data: { payments: d.payments },
        suggestion: d.invoices === 0 ? "لا مبيعات بعد — جرّب عرضًا سريعًا على الأصناف الأكثر طلبًا." : undefined,
      };
    }
    case "PROFIT": {
      const d = await dailySummary(tx, day);
      const margin = Number(d.grossMarginPercent);
      return {
        intent,
        answer: `مجمل ربح ${label}: ${sar(d.grossProfit)} بهامش ${d.grossMarginPercent}% على صافي مبيعات ${sar(d.netSales)}.`,
        suggestion: margin && margin < 55 ? "الهامش أقل من 55% — راجع تكلفة الوصفات أو أسعار الأصناف منخفضة الهامش." : undefined,
      };
    }
    case "TOP_ITEMS": {
      const d = await dailySummary(tx, day);
      if (!d.topItems.length) return { intent, answer: `لا توجد مبيعات ${label} بعد.` };
      return {
        intent,
        answer: `الأكثر مبيعًا ${label}: ` + d.topItems.map((t, i) => `${i + 1}) ${t.name} (${t.quantity})`).join("، ") + ".",
        data: d.topItems,
        suggestion: `تأكد من توفر «${d.topItems[0]!.name}» بكمية كافية لباقي اليوم.`,
      };
    }
    case "LOW_STOCK": {
      const d = await dailySummary(tx, day);
      if (!d.lowStock.length) return { intent, answer: "المخزون سليم، لا توجد أصناف تحت حد إعادة الطلب." };
      return {
        intent,
        answer: "أصناف تحت حد الطلب: " + d.lowStock.map((l) => `${l.name} (${l.quantity})`).join("، ") + ".",
        data: d.lowStock,
        suggestion: "أجهّز لك أمر شراء بهذه الأصناف؟ (يحتاج موافقتك قبل الإرسال للمورد)",
      };
    }
    case "VAT": {
      const from = `${day.slice(0, 7)}-01`;
      const v = await vatSummary(tx, from, day);
      return {
        intent,
        answer: `ضريبة القيمة المضافة من ${from} إلى ${day}: مخرجات ${sar(v.outputVat)}، مدخلات ${sar(v.inputVat)}، الصافي المستحق ${sar(v.netVatDue)}.`,
        data: v,
      };
    }
    case "RECEIVABLES": {
      const rows = (await tx.query<{ id: string; name: string; phone: string | null }>("SELECT id, name, phone FROM customers")).rows;
      const owing = [];
      for (const c of rows) {
        const b = await customerBalance(tx, c.id);
        if (b.gt(0)) owing.push({ name: c.name, phone: c.phone, balance: b });
      }
      owing.sort((a, b) => (b.balance.gt(a.balance) ? 1 : -1));
      if (!owing.length) return { intent, answer: "لا توجد مستحقات على العملاء حاليًا 👌" };
      const total = Money.sum(owing.map((o) => o.balance));
      return {
        intent,
        answer: `إجمالي المستحقات ${sar(total)} على ${owing.length} عميل. الأعلى: ` + owing.slice(0, 5).map((o) => `${o.name} ${sar(o.balance)}`).join("، ") + ".",
        data: owing.map((o) => ({ ...o, balance: o.balance.toFixed(2) })),
        suggestion: "أرسل تذكير سداد مهذب عبر واتساب لأعلى 3 عملاء؟ (بموافقتك)",
      };
    }
    case "EXPIRING": {
      const b = await expiringBatches(tx, day, 90);
      if (!b.length) return { intent, answer: "لا توجد تشغيلات تنتهي صلاحيتها خلال 90 يومًا." };
      return {
        intent,
        answer: `${b.length} تشغيلة تنتهي خلال 90 يومًا. أقربها: ${b[0]!.item} (${b[0]!.batchNo}) بعد ${b[0]!.daysLeft} يوم.`,
        data: b,
        suggestion: b[0]!.suggestion,
      };
    }
    case "COMPLIANCE": {
      const r = await tx.query<{ status: string; n: string }>("SELECT status, count(*) AS n FROM e_invoice_documents GROUP BY status");
      const get = (s: string) => Number(r.rows.find((x) => x.status === s)?.n ?? 0);
      const bad = get("REJECTED");
      const pending = get("PENDING");
      return {
        intent,
        answer: bad === 0 && pending === 0
          ? `كل الفواتير الإلكترونية سليمة ✓ (${get("ACCEPTED") + get("WARNING")} فاتورة مقبولة).`
          : `فواتير مقبولة: ${get("ACCEPTED")}، بانتظار الإرسال: ${pending}، مرفوضة: ${bad}.`,
        suggestion: bad ? "افتح الفواتير المرفوضة وسأشرح لك سبب الرفض وطريقة الإصلاح." : undefined,
      };
    }
    case "CASHIERS": {
      const flags = await cashierInsights(tx, day);
      const risky = flags.filter((f) => f.flags.length);
      return {
        intent,
        answer: risky.length
          ? `تنبيه: ${risky.length} موظف لديه نشاط غير معتاد ${label}: ` + risky.map((r) => `${r.name} (${r.flags.join("، ")})`).join(" — ")
          : `لا يوجد نشاط غير معتاد للكاشيرات ${label}.`,
        data: flags,
      };
    }
    default:
      return {
        intent: "HELP",
        answer: "أنا «ذهب»، مساعدك في مثقال. اسألني مثلًا: «كم بعنا النهارده؟»، «كسبنا كام امبارح؟»، «إيش الأكثر مبيعًا؟»، «إيه النواقص؟»، «مين عليه فلوس؟»، «كم الضريبة هالشهر؟»، «فيه أدوية قربت تنتهي؟»، «وضع زاتكا؟».",
      };
  }
}

export interface CashierInsight {
  userId: string;
  name: string;
  invoices: number;
  sales: string;
  refunds: number;
  refundAmount: string;
  refundRatePercent: string;
  flags: string[];
}

/**
 * Fraud Guard v1: rule-based anomaly flags per cashier for a day.
 *  - refund rate above 10% of sales value
 *  - 3 or more refunds in a day
 *  - refund issued within 10 minutes of the original sale (classic "sale then void" pattern)
 */
export async function cashierInsights(tx: Tx, day: string): Promise<CashierInsight[]> {
  const r = await tx.query<{ user_id: string; full_name: string; invoices: string; sales: string; refunds: string; refund_amount: string; quick_refunds: string }>(
    `SELECT u.id AS user_id, u.full_name,
            count(*) FILTER (WHERE i.doc_type='INVOICE') AS invoices,
            coalesce(sum(i.total_gross) FILTER (WHERE i.doc_type='INVOICE'),0) AS sales,
            count(*) FILTER (WHERE i.doc_type='CREDIT_NOTE') AS refunds,
            coalesce(sum(i.total_gross) FILTER (WHERE i.doc_type='CREDIT_NOTE'),0) AS refund_amount,
            count(*) FILTER (WHERE i.doc_type='CREDIT_NOTE' AND o.issued_at > i.issued_at - interval '10 minutes') AS quick_refunds
       FROM sales_invoices i
       JOIN users u ON u.id = i.created_by
       LEFT JOIN sales_invoices o ON o.id = i.original_invoice_id
      WHERE i.issued_at::date = $1
      GROUP BY u.id, u.full_name
      ORDER BY u.full_name`,
    [day],
  );
  return r.rows.map((x) => {
    const sales = Money.of(x.sales);
    const refunds = Money.of(x.refund_amount);
    const rate = sales.isZero() ? (refunds.isZero() ? Money.zero() : Money.of(100)) : refunds.div(sales).mul(100);
    const flags: string[] = [];
    if (rate.gt(10)) flags.push(`نسبة مرتجعات ${rate.toFixed(1)}%`);
    if (Number(x.refunds) >= 3) flags.push(`${x.refunds} مرتجعات`);
    if (Number(x.quick_refunds) > 0) flags.push(`${x.quick_refunds} مرتجع خلال دقائق من البيع`);
    return {
      userId: x.user_id,
      name: x.full_name,
      invoices: Number(x.invoices),
      sales: sales.toFixed(2),
      refunds: Number(x.refunds),
      refundAmount: refunds.toFixed(2),
      refundRatePercent: rate.toFixed(1),
      flags,
    };
  });
}
