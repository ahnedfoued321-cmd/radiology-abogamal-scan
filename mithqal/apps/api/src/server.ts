import Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { HttpZatcaClient, MockZatcaClient, reportPending, RoutingClient } from "./services/einvoice-worker.js";

const ZATCA_URLS = {
  sandbox: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  production: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
} as const;

const config = loadConfig();
await migrate(config.migrationUrl);
const db = createPool(config.appUrl);
const ownerDb = createPool(config.migrationUrl);
// «ذهب» v2: enabled when Anthropic credentials are configured (ANTHROPIC_API_KEY or an `ant auth` profile + ASSISTANT_LLM=on).
const llm = process.env.ANTHROPIC_API_KEY || process.env.ASSISTANT_LLM === "on" ? new Anthropic() : undefined;
const app = buildApp(db, config, ownerDb, llm);

const zatca = new RoutingClient({
  ZATCA:
    config.zatcaMode === "mock"
      ? new MockZatcaClient()
      : new HttpZatcaClient(ZATCA_URLS[config.zatcaMode], process.env.ZATCA_CSID_TOKEN ?? "", process.env.ZATCA_CSID_SECRET ?? ""),
  // ETA receipt submission (OAuth POS client credentials) is the next integration; receipts queue until then.
  ETA: config.zatcaMode === "mock" ? new MockZatcaClient() : undefined,
});

// E-invoice reporting loop (simplified invoices must reach ZATCA within 24h).
const timer = setInterval(() => {
  reportPending(ownerDb, zatca, 50, zatca.authorities).catch((e) => app.log.error(e, "e-invoice reporting failed"));
}, 15_000);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await db.end();
  await ownerDb.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
