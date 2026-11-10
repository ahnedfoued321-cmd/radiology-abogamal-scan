import { Money, type DecimalInput } from "@mithqal/money";

/** System account roles. Each tenant maps roles to its own chart-of-accounts codes. */
export type AccountRole =
  | "CASH"
  | "BANK_CARD_CLEARING"
  | "BANK"
  | "ACCOUNTS_RECEIVABLE"
  | "INVENTORY"
  | "ACCOUNTS_PAYABLE"
  | "VAT_OUTPUT"
  | "VAT_INPUT"
  | "SALES_REVENUE"
  | "SALES_DISCOUNTS"
  | "COST_OF_GOODS_SOLD"
  | "INVENTORY_ADJUSTMENT"
  | "OPENING_BALANCE_EQUITY";

export interface JournalLineDraft {
  role: AccountRole;
  debit: Money;
  credit: Money;
  memo?: string;
}

export interface JournalDraft {
  memo: string;
  lines: JournalLineDraft[];
}

export function dr(role: AccountRole, amount: DecimalInput, memo?: string): JournalLineDraft {
  return { role, debit: Money.of(amount), credit: Money.zero(), memo };
}
export function cr(role: AccountRole, amount: DecimalInput, memo?: string): JournalLineDraft {
  return { role, debit: Money.zero(), credit: Money.of(amount), memo };
}

/** Enforce double-entry: non-negative sides, one side per line, debits == credits, no empty journal. */
export function assertBalanced(j: JournalDraft): void {
  const lines = j.lines.filter((l) => !(l.debit.isZero() && l.credit.isZero()));
  if (lines.length < 2) throw new Error("Journal must have at least two non-zero lines");
  for (const l of lines) {
    if (l.debit.isNegative() || l.credit.isNegative()) throw new Error("Journal amounts must be non-negative");
    if (!l.debit.isZero() && !l.credit.isZero()) throw new Error("A journal line cannot have both debit and credit");
  }
  const d = Money.sum(lines.map((l) => l.debit));
  const c = Money.sum(lines.map((l) => l.credit));
  if (!d.round(4).eq(c.round(4))) {
    throw new Error(`Unbalanced journal: debit ${d.toFixed(4)} != credit ${c.toFixed(4)}`);
  }
}

/** Drop zero lines and merge lines with the same role+side to keep journals tidy. */
export function compact(j: JournalDraft): JournalDraft {
  const merged = new Map<string, JournalLineDraft>();
  for (const l of j.lines) {
    if (l.debit.isZero() && l.credit.isZero()) continue;
    const side = l.debit.isZero() ? "C" : "D";
    const key = `${l.role}|${side}`;
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? { ...prev, debit: prev.debit.add(l.debit), credit: prev.credit.add(l.credit) }
        : { ...l },
    );
  }
  return { memo: j.memo, lines: [...merged.values()] };
}

export type PaymentMethod = "CASH" | "CARD" | "CREDIT";

export interface SalePostingInput {
  invoiceNumber: string;
  totalNet: DecimalInput;
  totalTax: DecimalInput;
  totalGross: DecimalInput;
  costOfGoods: DecimalInput;
  payments: { method: PaymentMethod; amount: DecimalInput }[];
}

/**
 * Posting rule: sales invoice.
 *   Dr Cash / Card clearing / AR   (gross, split by payment)
 *     Cr Sales revenue              (net)
 *     Cr VAT output                 (tax)
 *   Dr COGS / Cr Inventory          (cost of goods at moving average)
 */
export function postSale(i: SalePostingInput): JournalDraft {
  const gross = Money.of(i.totalGross);
  const paid = Money.sum(i.payments.map((p) => p.amount));
  if (!paid.round(2).eq(gross.round(2))) {
    throw new Error(`Payments ${paid.toFixed()} do not match invoice total ${gross.toFixed()}`);
  }
  const roleFor: Record<PaymentMethod, AccountRole> = {
    CASH: "CASH",
    CARD: "BANK_CARD_CLEARING",
    CREDIT: "ACCOUNTS_RECEIVABLE",
  };
  const j: JournalDraft = {
    memo: `Sales invoice ${i.invoiceNumber}`,
    lines: [
      ...i.payments.map((p) => dr(roleFor[p.method], p.amount)),
      cr("SALES_REVENUE", i.totalNet),
      cr("VAT_OUTPUT", i.totalTax),
      dr("COST_OF_GOODS_SOLD", i.costOfGoods),
      cr("INVENTORY", i.costOfGoods),
    ],
  };
  const out = compact(j);
  assertBalanced(out);
  return out;
}

/** Posting rule: sales return / credit note — the exact reverse of the sale. */
export function postSaleReturn(i: SalePostingInput): JournalDraft {
  const sale = postSale(i);
  const out: JournalDraft = {
    memo: `Credit note for ${i.invoiceNumber}`,
    lines: sale.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
  assertBalanced(out);
  return out;
}

/**
 * Posting rule: goods received with supplier bill.
 *   Dr Inventory (net) · Dr VAT input (tax) · Cr Accounts payable / Cash (gross)
 */
export function postPurchase(i: { reference: string; net: DecimalInput; tax: DecimalInput; paidCash?: boolean }): JournalDraft {
  const gross = Money.of(i.net).add(i.tax);
  const j = compact({
    memo: `Purchase ${i.reference}`,
    lines: [
      dr("INVENTORY", i.net),
      dr("VAT_INPUT", i.tax),
      cr(i.paidCash ? "CASH" : "ACCOUNTS_PAYABLE", gross),
    ],
  });
  assertBalanced(j);
  return j;
}

export type CollectionMethod = "CASH" | "CARD" | "BANK_TRANSFER" | "CHEQUE";

/** Posting rule: customer collection — Dr Cash / Card clearing / Bank, Cr Accounts receivable. */
export function postCollection(i: { reference: string; method: CollectionMethod; amount: DecimalInput }): JournalDraft {
  const role: AccountRole = i.method === "CASH" ? "CASH" : i.method === "CARD" ? "BANK_CARD_CLEARING" : "BANK";
  const j = { memo: `Collection ${i.reference}`, lines: [dr(role, i.amount), cr("ACCOUNTS_RECEIVABLE", i.amount)] };
  assertBalanced(j);
  return j;
}
