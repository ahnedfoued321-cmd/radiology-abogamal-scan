/**
 * «ذهب» v2 — optional Claude layer over the deterministic assistant.
 *
 * Design rules (ADR-006 — AI suggests, humans approve):
 *  - The model only gets READ-ONLY tools, each backed by the same report functions as the dashboard,
 *    executed inside the caller's tenant transaction (RLS) — it cannot see other tenants or write data.
 *  - Numbers come only from tool results; the system prompt forbids inventing figures.
 *  - Any failure (no key, network, refusal, loop limit) falls back to the rule-based engine (v1).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { Money } from "@mithqal/money";
import type { Tx } from "../db.js";
import { dailySummary, expiringBatches, vatSummary } from "./reports.js";
import { cashierInsights } from "./assistant.js";
import { customerBalance } from "./van.js";

export const ASSISTANT_MODEL = "claude-opus-5-5";

/** Minimal client surface we use — lets tests inject a scripted fake. */
export interface LlmClient {
  beta: { messages: { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> } };
}

const SYSTEM = `أنت «ذهب»، المساعد الذكي داخل نظام «مِثقال» لإدارة الأعمال في السعودية ومصر.
- أجب بلهجة المستخدم (سعودية أو مصرية) بإيجاز ووضوح، وبالعربية دائمًا.
- لا تذكر أي رقم إلا إذا جاء من نتيجة أداة. إن لم تتوفر البيانات فقل ذلك صراحة.
- أنت للقراءة والتحليل فقط: لا تنفّذ أي عملية. يمكنك اقتراح خطوة، مع التنبيه أنها تحتاج موافقة المالك.
- استخدم الأدوات المتاحة للحصول على البيانات؛ يمكنك استدعاء أكثر من أداة عند الحاجة.
- التواريخ بصيغة YYYY-MM-DD. "اليوم/النهارده" = تاريخ اليوم المعطى، "أمس/امبارح" = اليوم السابق.`;

type ToolDef = Anthropic.Beta.BetaTool;
const obj = (properties: Record<string, unknown>, required: string[]): ToolDef["input_schema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const day = { type: "string", description: "التاريخ بصيغة YYYY-MM-DD" };

export const TOOLS: ToolDef[] = [
  { name: "daily_summary", description: "ملخص يوم: المبيعات، الضريبة، مجمل الربح والهامش، طرق الدفع، الأكثر مبيعًا، النواقص.", input_schema: obj({ day }, ["day"]), strict: true },
  { name: "vat_summary", description: "ضريبة القيمة المضافة لفترة: المخرجات والمدخلات والصافي المستحق.", input_schema: obj({ from: day, to: day }, ["from", "to"]), strict: true },
  { name: "receivables", description: "العملاء الذين عليهم مبالغ مستحقة وأرصدتهم.", input_schema: obj({}, []), strict: true },
  { name: "expiring_batches", description: "التشغيلات التي تنتهي صلاحيتها خلال عدد أيام.", input_schema: obj({ days: { type: "integer", description: "عدد الأيام (1-365)" } }, ["days"]), strict: true },
  { name: "einvoice_status", description: "حالة الفواتير الإلكترونية لدى ZATCA أو ETA (مقبولة/معلقة/مرفوضة).", input_schema: obj({}, []), strict: true },
  { name: "cashier_insights", description: "مؤشرات التلاعب لكل كاشير في يوم (المرتجعات ونسبتها).", input_schema: obj({ day }, ["day"]), strict: true },
];

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Execute a tool call against the tenant's data. Validates input; never throws to the model. */
export async function runTool(tx: Tx, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const i = (input ?? {}) as Record<string, unknown>;
  try {
    let out: unknown;
    switch (name) {
      case "daily_summary":
        if (!isDay(i.day)) throw new Error("day must be YYYY-MM-DD");
        out = await dailySummary(tx, i.day);
        break;
      case "vat_summary":
        if (!isDay(i.from) || !isDay(i.to)) throw new Error("from/to must be YYYY-MM-DD");
        out = await vatSummary(tx, i.from, i.to);
        break;
      case "receivables": {
        const rows = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM customers")).rows;
        const owing = [];
        for (const c of rows) {
          const b = await customerBalance(tx, c.id);
          if (b.gt(0)) owing.push({ name: c.name, balance: b.toFixed(2) });
        }
        out = { total: Money.sum(owing.map((o) => o.balance)).toFixed(2), customers: owing };
        break;
      }
      case "expiring_batches": {
        const days = Number(i.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("days must be 1..365");
        out = await expiringBatches(tx, new Date().toISOString().slice(0, 10), days);
        break;
      }
      case "einvoice_status":
        out = (await tx.query("SELECT authority, status, count(*)::int AS count FROM e_invoice_documents GROUP BY authority, status")).rows;
        break;
      case "cashier_insights":
        if (!isDay(i.day)) throw new Error("day must be YYYY-MM-DD");
        out = await cashierInsights(tx, i.day);
        break;
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
    return { content: JSON.stringify(out), isError: false };
  } catch (e) {
    return { content: (e as Error).message, isError: true };
  }
}

export interface LlmAnswer {
  answer: string;
  toolsUsed: string[];
}

/** Run the tool loop. Returns null when the model refused or the loop didn't finish — caller falls back. */
export async function askLlm(client: LlmClient, tx: Tx, question: string, now = new Date(), maxTurns = 6): Promise<LlmAnswer | null> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `تاريخ اليوم: ${now.toISOString().slice(0, 10)}\n\nالسؤال: ${question}` },
  ];
  const toolsUsed: string[] = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.beta.messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") return null;
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "tool_use" && toolUses.length) {
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        const r = await runTool(tx, t.name, t.input);
        toolsUsed.push(t.name);
        results.push({ type: "tool_result", tool_use_id: t.id, content: r.content, is_error: r.isError });
      }
      messages.push({ role: "user", content: results }); // all results in one message
      continue;
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text ? { answer: text, toolsUsed } : null;
  }
  return null;
}
