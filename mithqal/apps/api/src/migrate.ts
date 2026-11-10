import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "./config.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Apply pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(url: string, opts: { reset?: boolean } = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (opts.reset) {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  migrate(cfg.migrationUrl, { reset: process.argv.includes("--reset") })
    .then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "Database is up to date"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
