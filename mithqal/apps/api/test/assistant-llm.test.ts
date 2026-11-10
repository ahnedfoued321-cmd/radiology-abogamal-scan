import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import type { LlmClient } from "../src/services/assistant-llm.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });

/** Scripted fake of client.beta.messages.create that records every request. */
function fakeClient(script: (req: Anthropic.Beta.MessageCreateParamsNonStreaming, n: number) => Partial<Anthropic.Beta.BetaMessage>) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: LlmClient = {
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          return script(params, calls.length) as Anthropic.Beta.BetaMessage;
        },
      },
    },
  };
  return { client, calls };
}

let db: Db;
const apps: FastifyInstance[] = [];
async function appWith(llm: LlmClient | undefined) {
  const app = buildApp(db, config, undefined, llm);
  await app.ready();
  apps.push(app);
  return app;
}
async function call(app: FastifyInstance, method: "GET" | "POST", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

let token: string;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  const app = await appWith(undefined);
  const o = await call(app, "POST", "/v1/onboarding", undefined, {
    businessNameAr: "مقهى الذكاء", country: "SA", industry: "cafe", vatNumber: "310122393500003",
    owner: { fullName: "مالك", email: "owner@llm.test", password: "OwnerPass#1" },
  });
  token = o.body.token;
  const item = (await call(app, "POST", "/v1/items", token, { sku: "LAT", nameAr: "لاتيه", price: "23.00" })).body;
  await call(app, "POST", "/v1/inventory/receipts", token, { warehouseId: o.body.warehouseId, reference: "R", lines: [{ itemId: item.id, quantity: "10", unitCost: "5" }] });
  await call(app, "POST", "/v1/pos/sales", token, {
    clientUuid: randomUUID(), terminalId: o.body.terminalId, lines: [{ itemId: item.id, quantity: "2" }], payments: [{ method: "CASH", amount: "46.00" }],
  });
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await db.end();
});

describe("assistant «ذهب» v2 (Claude tool loop)", () => {
  it("calls a read-only tool on the tenant's data and answers from the result", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { client, calls } = fakeClient((req, n) =>
      n === 1
        ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "daily_summary", input: { day: today } } as Anthropic.Beta.BetaToolUseBlock] }
        : { stop_reason: "end_turn", content: [{ type: "text", text: "بعتوا اليوم ٤٦ ريال من فاتورة واحدة 👌", citations: null } as Anthropic.Beta.BetaTextBlock] },
    );
    const app = await appWith(client);
    const r = await call(app, "POST", "/v1/assistant/ask", token, { question: "وش وضع المبيعات اليوم؟" });
    expect(r.status).toBe(200);
    expect(r.body.engine).toBe("llm");
    expect(r.body.toolsUsed).toEqual(["daily_summary"]);
    expect(r.body.answer).toContain("٤٦");

    // request shape: model, fallbacks, strict read-only tools, cached system prompt
    expect(calls[0]!.model).toBe("claude-opus-5-5");
    expect(calls[0]!.fallbacks).toBe("default");
    expect(calls[0]!.tools!.every((t) => (t as Anthropic.Beta.BetaTool).strict === true)).toBe(true);
    // the tool result sent back contains the real numbers from the database
    const toolMsg = calls[1]!.messages.at(-1)!;
    const result = (toolMsg.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    expect(result.tool_use_id).toBe("tu_1");
    expect(JSON.parse(result.content as string).grossSales).toBe("46.00");
  });

  it("returns invalid tool input to the model as an error instead of crashing", async () => {
    const { client, calls } = fakeClient((req, n) =>
      n === 1
        ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_x", name: "vat_summary", input: { from: "bad", to: "x" } } as Anthropic.Beta.BetaToolUseBlock] }
        : { stop_reason: "end_turn", content: [{ type: "text", text: "تعذر حساب الضريبة لهذه الفترة.", citations: null } as Anthropic.Beta.BetaTextBlock] },
    );
    const app = await appWith(client);
    const r = await call(app, "POST", "/v1/assistant/ask", token, { question: "الضريبة؟" });
    expect(r.body.engine).toBe("llm");
    expect((calls[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!.is_error).toBe(true);
  });

  it("falls back to the rule engine on refusal or API failure", async () => {
    const refused = await appWith(fakeClient(() => ({ stop_reason: "refusal", content: [] })).client);
    const a = await call(refused, "POST", "/v1/assistant/ask", token, { question: "كم بعنا اليوم؟" });
    expect(a.body.engine).toBe("rules");
    expect(a.body.intent).toBe("SALES");

    const broken = await appWith({ beta: { messages: { create: async () => { throw new Error("network down"); } } } });
    const b = await call(broken, "POST", "/v1/assistant/ask", token, { question: "كم بعنا اليوم؟" });
    expect(b.status).toBe(200);
    expect(b.body.engine).toBe("rules");
  });
});
