import { createHash } from "node:crypto";
import { assertBalanced, type AccountRole, type JournalDraft } from "@mithqal/domain";
import { BusinessError, type Tx } from "../db.js";

export interface Actor {
  userId: string;
  tenantId: string;
  role: string;
}

/** Append-only, hash-chained audit log (tamper-evident). Serialized per tenant via advisory lock. */
export async function audit(tx: Tx, actor: Actor | { tenantId: string; userId?: string }, action: string, entity: string, entityId: string | null, data: unknown): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${actor.tenantId}`]);
  const prev = await tx.query<{ hash: string }>("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1");
  const prevHash = prev.rows[0]?.hash ?? "GENESIS";
  const payload = JSON.stringify({ prevHash, action, entity, entityId, data, actor: actor.userId ?? null });
  const hash = createHash("sha256").update(payload).digest("hex");
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, entity, entity_id, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.tenantId, actor.userId ?? null, action, entity, entityId, JSON.stringify(data ?? null), prevHash, hash],
  );
}

/** Transactional outbox: events are committed with the business change and published by a worker. */
export async function emit(tx: Tx, tenantId: string, type: string, payload: unknown): Promise<void> {
  await tx.query("INSERT INTO domain_events (tenant_id, type, payload) VALUES ($1,$2,$3)", [tenantId, type, JSON.stringify(payload)]);
}

/** Resolve account roles to this tenant's accounts and write a balanced journal entry. */
export async function postJournal(
  tx: Tx,
  actor: { tenantId: string; userId?: string },
  draft: JournalDraft,
  source: { type: string; id: string | null; date: string },
): Promise<string> {
  assertBalanced(draft);
  const roles = [...new Set(draft.lines.map((l) => l.role))];
  const accs = await tx.query<{ id: string; role: AccountRole }>("SELECT id, role FROM accounts WHERE role = ANY($1)", [roles]);
  const byRole = new Map(accs.rows.map((a) => [a.role, a.id]));
  for (const r of roles) {
    if (!byRole.has(r)) throw new BusinessError(`No account mapped to role ${r}`);
  }
  const entry = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (tenant_id, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [actor.tenantId, source.date, draft.memo, source.type, source.id, actor.userId ?? null],
  );
  const entryId = entry.rows[0]!.id;
  for (const l of draft.lines) {
    await tx.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit, credit, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor.tenantId, entryId, byRole.get(l.role), l.debit.toStorage(), l.credit.toStorage(), l.memo ?? null],
    );
  }
  return entryId;
}
