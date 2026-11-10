/** Thin API client + offline outbox for POS sales. */

export interface Item {
  id: string;
  sku: string;
  barcode: string | null;
  name_ar: string;
  category: string | null;
  price: string;
  tax_percent: string;
  on_hand: string;
  track_stock: boolean;
}

export interface Me {
  user: { sub: string; tid: string; role: string };
  company: { name_ar: string; vat_number: string | null; currency: string; vat_percent: string; industry: string; prices_include_tax: boolean };
  terminals: { id: string; name: string; prefix: string; warehouse_id: string }[];
  warehouses: { id: string; name: string }[];
}

export interface SalePayload {
  clientUuid: string;
  terminalId: string;
  issuedAt: string;
  lines: { itemId: string; quantity: string }[];
  payments: { method: "CASH" | "CARD" | "CREDIT"; amount: string }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const TOKEN_KEY = "mithqal.token";
const OUTBOX_KEY = "mithqal.outbox";

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const session = {
  get token(): string | null {
    return store()?.getItem(TOKEN_KEY) ?? null;
  },
  set(token: string) {
    store()?.setItem(TOKEN_KEY, token);
  },
  clear() {
    store()?.removeItem(TOKEN_KEY);
  },
};

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { message?: string; issues?: { message: string }[] };
  if (!res.ok) {
    if (res.status === 401) session.clear();
    throw new ApiError(res.status, data.message ?? data.issues?.map((i) => i.message).join("، ") ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/* ─────────── Offline outbox ─────────── */

export function outbox(): SalePayload[] {
  try {
    return JSON.parse(store()?.getItem(OUTBOX_KEY) ?? "[]") as SalePayload[];
  } catch {
    return [];
  }
}

function saveOutbox(items: SalePayload[]) {
  try {
    store()?.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    /* storage full or blocked — sale stays in memory for this session */
  }
}

export function enqueue(sale: SalePayload) {
  saveOutbox([...outbox(), sale]);
}

/** Try to push queued sales. Server dedupes by clientUuid, so retries are always safe. */
export async function flushOutbox(): Promise<{ sent: number; failed: number }> {
  const queue = outbox();
  let sent = 0;
  const remaining: SalePayload[] = [];
  for (const sale of queue) {
    try {
      await api("POST", "/v1/pos/sales", sale);
      sent++;
    } catch (e) {
      // Business rejections (4xx) are dropped from the queue to avoid blocking it; network errors are retried.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401) {
        console.warn("Dropped rejected offline sale", sale.clientUuid, e.message);
      } else {
        remaining.push(sale);
      }
    }
  }
  saveOutbox(remaining);
  return { sent, failed: remaining.length };
}
