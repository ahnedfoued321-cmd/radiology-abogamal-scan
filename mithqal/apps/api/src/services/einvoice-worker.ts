import type { Db } from "../db.js";

/**
 * ZATCA submission client. Phase 2:
 *  - Simplified (B2C) invoices → Reporting API within 24h.
 *  - Standard (B2B) invoices → Clearance API before sharing with the buyer.
 * Auth uses the device's Production CSID (binarySecurityToken + secret) via HTTP Basic.
 */
export interface ZatcaClient {
  submit(doc: { hash: string; uuid: string; xmlBase64: string; mode: "REPORTING" | "CLEARANCE" }): Promise<{ status: "ACCEPTED" | "WARNING" | "REJECTED"; body: unknown }>;
}

export class MockZatcaClient implements ZatcaClient {
  async submit() {
    return { status: "ACCEPTED" as const, body: { reportingStatus: "REPORTED", mock: true } };
  }
}

export class HttpZatcaClient implements ZatcaClient {
  constructor(private readonly baseUrl: string, private readonly csidToken: string, private readonly csidSecret: string) {}

  async submit(doc: { hash: string; uuid: string; xmlBase64: string; mode: "REPORTING" | "CLEARANCE" }) {
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
    return { status: "REJECTED" as const, body };
  }
}

/**
 * Drain pending e-invoices across all tenants: B2B clearance first (the buyer is waiting), then reporting, per device in ICV order.
 * Uses SKIP LOCKED so several workers can run in parallel safely. Runs as the migration/owner role
 * (a trusted background worker), never exposed over HTTP.
 */
export async function reportPending(ownerDb: Db, client: ZatcaClient, batchSize = 50): Promise<{ processed: number; accepted: number; rejected: number }> {
  const conn = await ownerDb.connect();
  let processed = 0, accepted = 0, rejected = 0;
  try {
    await conn.query("BEGIN");
    const docs = await conn.query<{ id: string; invoice_id: string; hash: string; xml: string; mode: "REPORTING" | "CLEARANCE" }>(
      `SELECT id, invoice_id, hash, xml, mode FROM e_invoice_documents
        WHERE status = 'PENDING' AND attempts < 10
        ORDER BY (mode = 'CLEARANCE') DESC, terminal_id, icv LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const d of docs.rows) {
      processed++;
      try {
        const r = await client.submit({ hash: d.hash, uuid: d.invoice_id, mode: d.mode, xmlBase64: Buffer.from(d.xml, "utf8").toString("base64") });
        if (r.status === "REJECTED") rejected++;
        else accepted++;
        await conn.query(
          "UPDATE e_invoice_documents SET status=$1, attempts=attempts+1, response=$2, submitted_at=now(), last_error=NULL WHERE id=$3",
          [r.status, JSON.stringify(r.body), d.id],
        );
      } catch (e) {
        await conn.query("UPDATE e_invoice_documents SET attempts=attempts+1, last_error=$1 WHERE id=$2", [(e as Error).message, d.id]);
      }
    }
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }
  return { processed, accepted, rejected };
}
