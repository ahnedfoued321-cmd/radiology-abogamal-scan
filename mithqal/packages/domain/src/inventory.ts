import { Money, type DecimalInput } from "@mithqal/money";

export interface StockPosition {
  quantity: Money;
  averageCost: Money; // moving weighted average unit cost
}

export const EMPTY_POSITION: StockPosition = { quantity: Money.zero(), averageCost: Money.zero() };

/** Receive stock: recompute moving weighted average cost. */
export function receive(pos: StockPosition, qty: DecimalInput, unitCost: DecimalInput): StockPosition {
  const q = Money.of(qty);
  const c = Money.of(unitCost);
  if (!q.gt(0)) throw new Error("Received quantity must be positive");
  if (c.isNegative()) throw new Error("Unit cost cannot be negative");
  const newQty = pos.quantity.add(q);
  // When on-hand was negative (sold before receiving), the incoming cost becomes the new average.
  if (!pos.quantity.gt(0)) return { quantity: newQty, averageCost: c.round(4) };
  const value = pos.quantity.mul(pos.averageCost).add(q.mul(c));
  return { quantity: newQty, averageCost: value.div(newQty).round(4) };
}

export interface IssueResult {
  position: StockPosition;
  cost: Money; // total cost of the issued quantity
  wentNegative: boolean;
}

/**
 * Issue stock at the current average cost. Negative stock is allowed (offline POS may sell before
 * a receipt syncs) but flagged so the system can raise an alert; the policy is per-tenant.
 */
export function issue(pos: StockPosition, qty: DecimalInput, opts: { allowNegative: boolean }): IssueResult {
  const q = Money.of(qty);
  if (!q.gt(0)) throw new Error("Issued quantity must be positive");
  const newQty = pos.quantity.sub(q);
  if (newQty.isNegative() && !opts.allowNegative) {
    throw new Error(`Insufficient stock: on hand ${pos.quantity.toFixed(3)}, requested ${q.toFixed(3)}`);
  }
  return {
    position: { quantity: newQty, averageCost: pos.averageCost },
    cost: q.mul(pos.averageCost).round(2),
    wentNegative: newQty.isNegative(),
  };
}

export interface Batch {
  batchId: string;
  expiryDate: string | null; // YYYY-MM-DD
  quantity: DecimalInput;
}

export interface BatchAllocation {
  batchId: string;
  quantity: Money;
}

/**
 * FEFO — First Expired, First Out (pharmacies, food). Expired batches are never allocated.
 * Batches without expiry go last.
 */
export function allocateFefo(batches: Batch[], qty: DecimalInput, today: string): BatchAllocation[] {
  let remaining = Money.of(qty);
  if (!remaining.gt(0)) throw new Error("Quantity must be positive");
  const usable = batches
    .filter((b) => Money.of(b.quantity).gt(0))
    .filter((b) => b.expiryDate === null || b.expiryDate >= today)
    .sort((a, b) => {
      if (a.expiryDate === b.expiryDate) return a.batchId.localeCompare(b.batchId);
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate.localeCompare(b.expiryDate);
    });
  const out: BatchAllocation[] = [];
  for (const b of usable) {
    if (remaining.isZero()) break;
    const avail = Money.of(b.quantity);
    const take = avail.lt(remaining) ? avail : remaining;
    out.push({ batchId: b.batchId, quantity: take });
    remaining = remaining.sub(take);
  }
  if (remaining.gt(0)) {
    throw new Error(`Not enough non-expired stock: short by ${remaining.toFixed(3)}`);
  }
  return out;
}

/** Days until expiry (negative when expired). */
export function daysToExpiry(expiryDate: string, today: string): number {
  const ms = Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
