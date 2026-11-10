import type { Db } from "../db.js";

/**
 * ZATCA submission client. Phase 2:
 *  - Simplified (B2C) invoices → Reporting API within 24h.
 *  - Standard (B2B) invoices → Clearance API before sharing with the buyer.
 * Auth uses the device's Production CSID (binarySecurityToken + secret) via HTTP Basic.
 */
/** Thrown for transient failures (429, 5xx, network): the document stays PENDING and is retried later. */
export class RetryableSubmitError extends Error {}

export interface ZatcaClient {
  submit(doc: { hash: string; uuid: string; xmlBase64: string; mode: "REPORTING" | "CLEARANCE" | "RECEIPT"; authority: "ZATCA" | "ETA" }): Promise<{ status: "ACCEPTED" | "WARNING" | "REJECTED"; body: unknown }>;
}

export class MockZatcaClient implements ZatcaClient {
  async submit() {
    return { status: "ACCEPTED" as const, body: { reportingStatus: "REPORTED", mock: true } };
  }
}

export class HttpZatcaClient implements ZatcaClient {
  constructor(private readonly baseUrl: string, private readonly csidToken: string, private readonly csidSecret: string) {}

  async submit(doc: { hash: string; uuid: string; xmlBase64: string; mode: "REPORTING" | "CLEARANCE" | "RECEIPT"; authority: "ZATCA" | "ETA" }) {
    if (doc.authority !== "ZATCA") throw new Error("HttpZatcaClient only submits ZATCA documents");
    const clearance = doc.mode === "CLEARANCE";
    const res = await fetch(`${this.baseUrl}/invoices/${clearance ? "clearance" : "reporting"}/single`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Version": "V2",
        "Accept-Language": "ar",
        "Clearance-Status": clearance ? "1" : "0",
        Authorization: `Basic ${Buffer.from(`${this.csidToken}:${this.csidSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ invoiceHash: doc.hash, uuid: doc.uuid, invoice: doc.xmlBase64 }),
    });
    const body = (await res.json().catch(() => ({}))) as { reportingStatus?: string; clearanceStatus?: string };
    if (res.status === 200 && (body.reportingStatus === "REPORTED" || body.clearanceStatus === "CLEARED")) return { status: "ACCEPTED" as const, body };
    if (res.status === 202) return { status: "WARNING" as const, body };
    if (res.status === 429 || res.status >= 500) throw new RetryableSubmitError(`ZATCA ${res.status}`);
    return { status: "REJECTED" as const, body };
  }
}

/**
 * Drain due e-invoices across all tenants: B2B clearance first (the buyer is waiting), then reporting,
 * per device in ICV order. Each document is claimed and settled in its own short transaction
 * (FOR UPDATE SKIP LOCKED), so parallel workers are safe and a crash affects at most one document.
 * Transient failures back off exponentially (30 s → 1 h) and never give up silently; authorities with
 * no configured client are skipped. Runs as the owner role (trusted background worker, never over HTTP).
 */
export async function reportPending(
  ownerDb: Db,
  client: ZatcaClient,
  batchSize = 50,
  authorities: ("ZATCA" | "ETA")[] = ["ZATCA", "ETA"],
): Promise<{ processed: number; accepted: number; rejected: number; retrying: number }> {
  let processed = 0, accepted = 0, rejected = 0, retrying = 0;
  for (let i = 0; i < batchSize; i++) {
    const conn = await ownerDb.connect();
    try {
      await conn.query("BEGIN");
      const d = (await conn.query<{ id: string; invoice_id: string; hash: string; xml: string; mode: "REPORTING" | "CLEARANCE" | "RECEIPT"; authority: "ZATCA" | "ETA"; attempts: number }>(
        `SELECT id, invoice_id, hash, xml, mode, authority, attempts FROM e_invoice_documents
          WHERE status = 'PENDING' AND next_attempt_at <= now() AND authority = ANY($1)
          ORDER BY (mode = 'CLEARANCE') DESC, terminal_id, icv LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [authorities],
      )).rows[0];
      if (!d) {
        await conn.query("COMMIT");
        break;
      }
      processed++;
      try {
        const r = await client.submit({ hash: d.hash, uuid: d.invoice_id, mode: d.mode, authority: d.authority, xmlBase64: Buffer.from(d.xml, "utf8").toString("base64") });
        if (r.status === "REJECTED") rejected++;
        else accepted++;
        await conn.query(
          "UPDATE e_invoice_documents SET status=$1, attempts=attempts+1, response=$2, submitted_at=now(), last_error=NULL WHERE id=$3",
          [r.status, JSON.stringify(r.body), d.id],
        );
      } catch (e) {
        retrying++;
        const delaySec = Math.min(3600, 30 * 2 ** Math.min(d.attempts, 7));
        await conn.query(
          "UPDATE e_invoice_documents SET attempts=attempts+1, last_error=$1, next_attempt_at=now() + make_interval(secs => $2) WHERE id=$3",
          [(e as Error).message, delaySec, d.id],
        );
      }
      await conn.query("COMMIT");
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  }
  return { processed, accepted, rejected, retrying };
}

/** Routes each document to its authority's client (ZATCA for KSA, ETA for Egypt). */
export class RoutingClient implements ZatcaClient {
  constructor(private readonly clients: Partial<Record<"ZATCA" | "ETA", ZatcaClient>>) {}
  /** Authorities that have a client; the worker only claims documents for these. */
  get authorities(): ("ZATCA" | "ETA")[] {
    return (Object.keys(this.clients) as ("ZATCA" | "ETA")[]).filter((k) => this.clients[k]);
  }
  async submit(doc: Parameters<ZatcaClient["submit"]>[0]) {
    const c = this.clients[doc.authority];
    if (!c) throw new Error(`No submission client configured for ${doc.authority}`);
    return c.submit(doc);
  }
}
