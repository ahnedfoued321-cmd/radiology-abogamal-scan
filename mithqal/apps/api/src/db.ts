import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 20 });
}

/**
 * Run `fn` in a transaction scoped to a tenant. `app.tenant_id` is set transaction-locally,
 * so Row-Level Security limits every statement to that tenant's rows.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(tx: Tx | Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await tx.query<T>(sql, params);
  const row = r.rows[0];
  if (!row) throw new NotFoundError("Record not found");
  return row;
}

export async function maybeOne<T extends pg.QueryResultRow>(tx: Tx | Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export class NotFoundError extends Error {
  statusCode = 404;
}
export class BusinessError extends Error {
  statusCode = 422;
}
