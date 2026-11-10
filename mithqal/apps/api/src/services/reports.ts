import { Money } from "@mithqal/money";
import type { Tx } from "../db.js";

export async function trialBalance(tx: Tx, from: string, to: string) {
  const r = await tx.query<{ code: string; name_ar: string; name_en: string; type: string; debit: string; credit: string }>(
    `SELECT a.code, a.name_ar, a.name_en, a.type,
            coalesce(sum(l.debit),0) AS debit, coalesce(sum(l.credit),0) AS credit
       FROM accounts a
       JOIN journal_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.entry_date BETWEEN $1 AND $2
      GROUP BY a.code, a.name_ar, a.name_en, a.type
      ORDER BY a.code`,
    [from, to],
  );
  const rows = r.rows.map((x) => {
    const bal = Money.of(x.debit).sub(x.credit);
    return { ...x, debit: Money.of(x.debit).toFixed(2), credit: Money.of(x.credit).toFixed(2), balance: bal.toFixed(2) };
  });
  const totalDebit = Money.sum(r.rows.map((x) => x.debit));
  const totalCredit = Money.sum(r.rows.map((x) => x.credit));
  return { from, to, rows, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), balanced: totalDebit.eq(totalCredit) };
}

/** VAT return helper: output VAT on sales minus input VAT on purchases for the period (KSA quarterly/monthly filing). */
export async function vatSummary(tx: Tx, from: string, to: string) {
  const r = await tx.query<{ role: string; debit: string; credit: string }>(
    `SELECT a.role, coalesce(sum(l.debit),0) AS debit, coalesce(sum(l.credit),0) AS credit
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.role IN ('VAT_OUTPUT','VAT_INPUT') AND e.entry_date BETWEEN $1 AND $2
      GROUP BY a.role`,
    [from, to],
  );
  const get = (role: string) => r.rows.find((x) => x.role === role);
  const output = Money.of(get("VAT_OUTPUT")?.credit ?? 0).sub(get("VAT_OUTPUT")?.debit ?? 0);
  const input = Money.of(get("VAT_INPUT")?.debit ?? 0).sub(get("VAT_INPUT")?.credit ?? 0);
  const sales = await tx.query<{ net: string }>(
    `SELECT coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -total_net ELSE total_net END),0) AS net
       FROM sales_invoices WHERE issued_at::date BETWEEN $1 AND $2`,
    [from, to],
  );
  return {
    from, to,
    taxableSales: Money.of(sales.rows[0]!.net).toFixed(2),
    outputVat: output.toFixed(2),
    inputVat: input.toFixed(2),
    netVatDue: output.sub(input).toFixed(2),
  };
}

/** "Business health" daily summary — what the owner sees first in the morning. */
export async function dailySummary(tx: Tx, day: string) {
  const s = await tx.query<{ invoices: string; credit_notes: string; net: string; tax: string; gross: string; cogs: string }>(
    `SELECT count(*) FILTER (WHERE doc_type='INVOICE') AS invoices,
            count(*) FILTER (WHERE doc_type='CREDIT_NOTE') AS credit_notes,
            coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -total_net ELSE total_net END),0) AS net,
            coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -total_tax ELSE total_tax END),0) AS tax,
            coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -total_gross ELSE total_gross END),0) AS gross,
            coalesce(sum(CASE WHEN doc_type='CREDIT_NOTE' THEN -cost_of_goods ELSE cost_of_goods END),0) AS cogs
       FROM sales_invoices WHERE issued_at::date = $1`,
    [day],
  );
  const byMethod = await tx.query<{ method: string; amount: string }>(
    `SELECT p.method, sum(p.amount) AS amount FROM payments p JOIN sales_invoices i ON i.id = p.invoice_id
      WHERE i.issued_at::date = $1 GROUP BY p.method ORDER BY p.method`,
    [day],
  );
  const top = await tx.query<{ name: string; quantity: string; gross: string }>(
    `SELECT l.name, sum(l.quantity) AS quantity, sum(l.gross) AS gross FROM sales_invoice_lines l
       JOIN sales_invoices i ON i.id = l.invoice_id
      WHERE i.issued_at::date = $1 AND i.doc_type = 'INVOICE'
      GROUP BY l.name ORDER BY sum(l.gross) DESC LIMIT 5`,
    [day],
  );
  const lowStock = await tx.query<{ name_ar: string; quantity: string; reorder_level: string }>(
    `SELECT i.name_ar, b.quantity, i.reorder_level FROM stock_balances b JOIN items i ON i.id = b.item_id
      WHERE i.track_stock AND b.quantity <= i.reorder_level ORDER BY b.quantity ASC LIMIT 10`,
  );
  const pendingEinvoices = await tx.query<{ n: string }>("SELECT count(*) AS n FROM e_invoice_documents WHERE status IN ('PENDING','REJECTED')");
  const row = s.rows[0]!;
  const net = Money.of(row.net);
  const profit = net.sub(row.cogs);
  return {
    day,
    invoices: Number(row.invoices),
    creditNotes: Number(row.credit_notes),
    netSales: net.toFixed(2),
    vat: Money.of(row.tax).toFixed(2),
    grossSales: Money.of(row.gross).toFixed(2),
    costOfGoods: Money.of(row.cogs).toFixed(2),
    grossProfit: profit.toFixed(2),
    grossMarginPercent: net.isZero() ? "0.0" : profit.div(net).mul(100).toFixed(1),
    payments: byMethod.rows.map((p) => ({ method: p.method, amount: Money.of(p.amount).toFixed(2) })),
    topItems: top.rows.map((t) => ({ name: t.name, quantity: Money.of(t.quantity).toString(), gross: Money.of(t.gross).toFixed(2) })),
    lowStock: lowStock.rows.map((l) => ({ name: l.name_ar, quantity: Money.of(l.quantity).toString(), reorderLevel: Money.of(l.reorder_level).toString() })),
    eInvoicesNeedingAttention: Number(pendingEinvoices.rows[0]!.n),
  };
}

/** Pharmacy: batches expiring within N days, with suggested action. */
export async function expiringBatches(tx: Tx, today: string, withinDays: number) {
  const r = await tx.query<{ name_ar: string; batch_no: string; expiry_date: string; quantity: string; days: number }>(
    `SELECT i.name_ar, b.batch_no, to_char(b.expiry_date,'YYYY-MM-DD') AS expiry_date, b.quantity, (b.expiry_date - $1::date) AS days
       FROM item_batches b JOIN items i ON i.id = b.item_id
      WHERE b.quantity > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= $1::date + $2::int
      ORDER BY b.expiry_date`,
    [today, withinDays],
  );
  return r.rows.map((b) => ({
    item: b.name_ar,
    batchNo: b.batch_no,
    expiryDate: b.expiry_date,
    quantity: Money.of(b.quantity).toString(),
    daysLeft: b.days,
    suggestion: b.days < 0 ? "منتهي — اعزله وأرجعه للمورد" : b.days <= 30 ? "قارب على الانتهاء — عرض ترويجي أو إرجاع للمورد" : "انقله لفرع أسرع بيعًا أو ضعه في الواجهة",
  }));
}
