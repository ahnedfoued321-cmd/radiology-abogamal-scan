import { Money } from "@mithqal/money";
import { postSale, postSaleReturn, priceDocument, type PaymentMethod } from "@mithqal/domain";
import { BusinessError, maybeOne, one, type Tx } from "../db.js";
import { audit, emit, lockKey, postJournal, postRevaluation, type Actor } from "./core.js";
import { issueForSale, returnToStock } from "./inventory.js";
import { customerBalance } from "./van.js";
import { issueEDocument, type CompanyRow, type EDocLine, type TerminalRow } from "./edoc.js";

interface CustomerRow {
  id: string;
  name: string;
  vat_number: string | null;
  cr_number: string | null;
  street: string | null;
  building_number: string | null;
  district: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  credit_limit: string;
}

function buyerOf(c: CustomerRow) {
  if (!c.vat_number) return undefined;
  if (!c.street || !c.city) throw new BusinessError("الفاتورة الضريبية (B2B) تتطلب عنوان المشتري كاملًا");
  return {
    name: c.name,
    vatNumber: c.vat_number,
    crNumber: c.cr_number ?? undefined,
    address: {
      street: c.street, buildingNumber: c.building_number ?? "", district: c.district ?? "", city: c.city,
      postalCode: c.postal_code ?? "", countryCode: c.country ?? "SA",
    },
  };
}

export interface SaleInput {
  clientUuid: string; // generated on the device; makes offline sync idempotent
  terminalId: string;
  issuedAt?: string; // device time (ISO); defaults to now
  customerId?: string;
  lines: { itemId: string; quantity: string; unitPrice?: string; discount?: string }[];
  payments: { method: PaymentMethod; amount: string }[];
}

/** Max line discount a non-owner may give without approval. */
export const MAX_STAFF_DISCOUNT = 0.1;
/** Offline devices may submit sales up to this old; anything older needs a manual entry. */
const MAX_OFFLINE_AGE_MS = 7 * 24 * 3600_000;

function splitTimestamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BusinessError("Invalid issuedAt");
  const now = Date.now();
  if (d.getTime() > now + 5 * 60_000) throw new BusinessError("وقت الجهاز متقدم عن الوقت الفعلي — اضبط ساعة الجهاز");
  if (d.getTime() < now - MAX_OFFLINE_AGE_MS) throw new BusinessError("الفاتورة أقدم من 7 أيام — راجع المحاسب لإدخالها يدويًا");
  const s = d.toISOString(); // 2026-11-10T22:15:00.000Z
  return { date: s.slice(0, 10), time: s.slice(11, 19), timestamp: `${s.slice(0, 19)}Z` };
}

/** Expiry checks use the later of the device date and the server date, so a backdated device can't sell expired batches. */
function serverToday(deviceDate: string): string {
  const server = new Date().toISOString().slice(0, 10);
  return deviceDate > server ? deviceDate : server;
}

export async function getInvoice(tx: Tx, id: string) {
  const inv = await one<Record<string, unknown>>(tx, "SELECT * FROM sales_invoices WHERE id=$1", [id]);
  const lines = await tx.query("SELECT * FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY line_no", [id]);
  const payments = await tx.query("SELECT method, amount FROM payments WHERE invoice_id=$1", [id]);
  const einv = await maybeOne<Record<string, unknown>>(
    tx, "SELECT icv, hash, qr, status, attempts, last_error FROM e_invoice_documents WHERE invoice_id=$1", [id],
  );
  return { ...inv, lines: lines.rows, payments: payments.rows, eInvoice: einv };
}

/**
 * Create a simplified (B2C) tax invoice from the POS — one atomic transaction:
 * price → stock issue (avg cost / FEFO) → invoice → payments → journal → ZATCA sign + chain → outbox + audit.
 * Replaying the same clientUuid returns the original invoice (offline sync safety).
 */
export async function createSale(tx: Tx, actor: Actor, input: SaleInput) {
  await lockKey(tx, `client:${actor.tenantId}:${input.clientUuid}`);
  const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM sales_invoices WHERE client_uuid=$1", [input.clientUuid]);
  if (dup) return { ...(await getInvoice(tx, dup.id)), replayed: true };

  const terminal = await maybeOne<TerminalRow>(tx, "SELECT * FROM pos_terminals WHERE id=$1 FOR UPDATE", [input.terminalId]);
  if (!terminal) throw new BusinessError("نقطة البيع غير موجودة");
  const company = await one<CompanyRow>(tx, "SELECT * FROM companies LIMIT 1");
  const ts = splitTimestamp(input.issuedAt ?? new Date().toISOString());

  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const items = await tx.query<{ id: string; name_ar: string; price: string; tax_percent: string; track_stock: boolean; track_batches: boolean; active: boolean }>(
    "SELECT id, name_ar, price, tax_percent, track_stock, track_batches, active FROM items WHERE id = ANY($1)", [itemIds],
  );
  const itemMap = new Map(items.rows.map((i) => [i.id, i]));
  const priced = priceDocument(
    input.lines.map((l) => {
      const it = itemMap.get(l.itemId);
      if (!it || !it.active) throw new BusinessError(`الصنف غير موجود أو غير مفعل: ${l.itemId}`);
      // Only the owner may change a price; other roles may discount up to MAX_STAFF_DISCOUNT of the line.
      if (actor.role !== "owner") {
        if (l.unitPrice !== undefined && !Money.of(l.unitPrice).eq(it.price)) throw new BusinessError("تعديل السعر من صلاحية المالك فقط");
        if (l.discount && Money.of(l.discount).gt(Money.of(it.price).mul(l.quantity).mul(MAX_STAFF_DISCOUNT))) {
          throw new BusinessError(`الخصم يتجاوز الحد المسموح (${MAX_STAFF_DISCOUNT * 100}%) — يحتاج موافقة المالك`);
        }
      }
      return { itemId: it.id, name: it.name_ar, quantity: l.quantity, unitPrice: l.unitPrice ?? it.price, discount: l.discount, taxPercent: it.tax_percent };
    }),
    { currency: company.currency, pricesIncludeTax: company.prices_include_tax },
  );

  const paid = Money.sum(input.payments.map((p) => p.amount));
  if (!paid.eq(priced.totalGross)) {
    throw new BusinessError(`المدفوع ${paid.toFixed()} لا يساوي إجمالي الفاتورة ${priced.totalGross.toFixed()}`);
  }
  if (actor.role === "sales_rep") {
    const van = await maybeOne<{ terminal_id: string }>(tx, "SELECT terminal_id FROM van_assignments WHERE user_id=$1", [actor.userId]);
    if (!van || van.terminal_id !== terminal.id) throw new BusinessError("المندوب يبيع من سيارته فقط");
  }
  const creditAmount = Money.sum(input.payments.filter((p) => p.method === "CREDIT").map((p) => p.amount));
  if (creditAmount.gt(0) && !input.customerId) {
    throw new BusinessError("البيع الآجل يتطلب اختيار عميل");
  }
  const customer = input.customerId
    ? await maybeOne<CustomerRow>(tx, "SELECT * FROM customers WHERE id=$1 FOR UPDATE", [input.customerId])
    : null;
  if (input.customerId && !customer) throw new BusinessError("العميل غير موجود");
  if (customer && creditAmount.gt(0)) {
    const balance = await customerBalance(tx, customer.id);
    const limit = Money.of(customer.credit_limit);
    if (balance.add(creditAmount).gt(limit)) {
      throw new BusinessError(
        `تجاوز حد الائتمان: الرصيد ${balance.toFixed(2)} + ${creditAmount.toFixed(2)} > الحد ${limit.toFixed(2)}`,
      );
    }
  }
  // B2B: a VAT-registered buyer gets a standard tax invoice (ZATCA clearance), others a simplified one (reporting).
  const kind = customer?.vat_number ? "STANDARD" : "SIMPLIFIED";

  const invoiceId = crypto.randomUUID();
  const seq = Number(terminal.invoice_seq) + 1;
  const number = `${terminal.prefix}-${String(seq).padStart(6, "0")}`;

  // Pre-lock every stock row this sale touches (items + recipe ingredients) in item-id order,
  // so concurrent sales / receipts / transfers always acquire locks in the same order (no deadlocks).
  const touched = await tx.query<{ id: string }>(
    `SELECT id FROM items WHERE id = ANY($1) AND track_stock
     UNION SELECT ingredient_id FROM recipe_lines WHERE item_id = ANY($1)`,
    [itemIds],
  );
  for (const t of touched.rows.map((r) => r.id).sort()) {
    await tx.query(
      "INSERT INTO stock_balances (tenant_id, item_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT (item_id, warehouse_id) DO NOTHING",
      [actor.tenantId, t, terminal.warehouse_id],
    );
  }
  await tx.query(
    "SELECT 1 FROM stock_balances WHERE warehouse_id=$1 AND item_id = ANY($2) ORDER BY item_id FOR UPDATE",
    [terminal.warehouse_id, touched.rows.map((r) => r.id)],
  );

  let cogs = Money.zero();
  const unitCosts: Money[] = [];
  for (const l of priced.lines) {
    const it = itemMap.get(l.itemId)!;
    if (!it.track_stock) {
      // Menu items with a recipe consume their ingredients (live cost per cup); services cost nothing.
      const recipe = await tx.query<{ ingredient_id: string; quantity: string; track_batches: boolean }>(
        `SELECT r.ingredient_id, r.quantity, i.track_batches FROM recipe_lines r JOIN items i ON i.id = r.ingredient_id
          WHERE r.item_id=$1 ORDER BY r.ingredient_id`,
        [l.itemId],
      );
      let lineCost = Money.zero();
      for (const r of recipe.rows) {
        const c = await issueForSale(tx, actor.tenantId, {
          itemId: r.ingredient_id, warehouseId: terminal.warehouse_id, quantity: Money.of(r.quantity).mul(l.quantity).toStorage(),
          allowNegative: company.allow_negative_stock, trackBatches: r.track_batches, today: serverToday(ts.date), sourceId: invoiceId,
        });
        lineCost = lineCost.add(c.totalCost);
      }
      unitCosts.push(lineCost.div(l.quantity).round(4));
      cogs = cogs.add(lineCost);
      continue;
    }
    const c = await issueForSale(tx, actor.tenantId, {
      itemId: l.itemId, warehouseId: terminal.warehouse_id, quantity: l.quantity.toString(),
      allowNegative: company.allow_negative_stock, trackBatches: it.track_batches, today: serverToday(ts.date), sourceId: invoiceId,
    });
    unitCosts.push(c.unitCost);
    cogs = cogs.add(c.totalCost);
  }

  await tx.query(
    `INSERT INTO sales_invoices (id, tenant_id, branch_id, terminal_id, customer_id, client_uuid, number, kind, doc_type, currency,
       total_net, total_discount, total_tax, total_gross, cost_of_goods, issued_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$16,'INVOICE',$8,$9,$10,$11,$12,$13,$14,$15)`,
    [invoiceId, actor.tenantId, terminal.branch_id, terminal.id, input.customerId ?? null, input.clientUuid, number, company.currency,
      priced.totalNet.toStorage(), priced.totalDiscount.toStorage(), priced.totalTax.toStorage(), priced.totalGross.toStorage(),
      cogs.toStorage(), ts.timestamp, actor.userId, kind],
  );
  for (const [i, l] of priced.lines.entries()) {
    await tx.query(
      `INSERT INTO sales_invoice_lines (tenant_id, invoice_id, line_no, item_id, name, quantity, unit_net, discount_net, net, tax_percent, tax, gross, tax_category, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [actor.tenantId, invoiceId, l.index, l.itemId, l.name, l.quantity.toStorage(), l.unitNet.toStorage(), l.discountNet.toStorage(),
        l.net.toStorage(), l.taxPercent.toFixed(2), l.tax.toStorage(), l.gross.toStorage(), l.taxCategory, unitCosts[i]!.toStorage()],
    );
  }
  for (const p of input.payments) {
    await tx.query("INSERT INTO payments (tenant_id, invoice_id, method, amount) VALUES ($1,$2,$3,$4)", [actor.tenantId, invoiceId, p.method, Money.of(p.amount).toStorage()]);
  }

  await postJournal(
    tx, actor,
    postSale({ invoiceNumber: number, totalNet: priced.totalNet, totalTax: priced.totalTax, totalGross: priced.totalGross, costOfGoods: cogs, payments: input.payments }),
    { type: "SALES_INVOICE", id: invoiceId, date: ts.date },
  );

  const mainMethod = [...input.payments].sort((a, b) => (Money.of(b.amount).gt(a.amount) ? 1 : -1))[0]!.method;
  await issueEDocument(tx, {
    tenantId: actor.tenantId, terminal, company, invoiceId, number, seq, kind, documentType: "INVOICE", ts,
    buyer: customer ? buyerOf(customer) : undefined, paymentMethod: mainMethod,
    lines: priced.lines.map((l) => ({
      lineNo: l.index, itemId: l.itemId, name: l.name, quantity: l.quantity, unitNet: l.unitNet, net: l.net,
      taxPercent: l.taxPercent, tax: l.tax, gross: l.gross, taxCategory: l.taxCategory,
    })),
    totals: { net: priced.totalNet, tax: priced.totalTax, gross: priced.totalGross },
  });

  // Prepared menu items (made to order, not shelf stock) go to the kitchen / barista display.
  if (priced.lines.some((l) => !itemMap.get(l.itemId)!.track_stock)) {
    await tx.query("INSERT INTO kds_tickets (invoice_id, tenant_id) VALUES ($1,$2)", [invoiceId, actor.tenantId]);
  }
  await emit(tx, actor.tenantId, "InvoicePosted", { invoiceId, number, kind, total: priced.totalGross.toFixed(2) });
  await audit(tx, actor, "sale.created", "sales_invoice", invoiceId, { number, total: priced.totalGross.toFixed(2) });
  return { ...(await getInvoice(tx, invoiceId)), replayed: false };
}

/** Full refund of a POS invoice as a ZATCA credit note (381), restocking at original cost. */
export async function refundSale(tx: Tx, actor: Actor, input: { invoiceId: string; clientUuid: string; reason: string; method?: PaymentMethod }) {
  await lockKey(tx, `client:${actor.tenantId}:${input.clientUuid}`);
  const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM sales_invoices WHERE client_uuid=$1", [input.clientUuid]);
  if (dup) return { ...(await getInvoice(tx, dup.id)), replayed: true };

  const orig = await maybeOne<{ id: string; number: string; doc_type: string; kind: "SIMPLIFIED" | "STANDARD"; terminal_id: string; customer_id: string | null; total_net: string; total_tax: string; total_gross: string; cost_of_goods: string; currency: string }>(
    tx, "SELECT * FROM sales_invoices WHERE id=$1 FOR UPDATE", [input.invoiceId],
  );
  if (!orig) throw new BusinessError("الفاتورة غير موجودة");
  if (orig.doc_type !== "INVOICE") throw new BusinessError("لا يمكن إرجاع إشعار دائن");
  const already = await maybeOne(tx, "SELECT 1 FROM sales_invoices WHERE original_invoice_id=$1 AND doc_type='CREDIT_NOTE'", [orig.id]);
  if (already) throw new BusinessError("تم إرجاع هذه الفاتورة بالفعل");

  const terminal = await one<TerminalRow>(tx, "SELECT * FROM pos_terminals WHERE id=$1 FOR UPDATE", [orig.terminal_id]);
  const company = await one<CompanyRow>(tx, "SELECT * FROM companies LIMIT 1");
  const lines = await tx.query<{ item_id: string; name: string; quantity: string; unit_net: string; discount_net: string; net: string; tax_percent: string; tax: string; gross: string; tax_category: string; unit_cost: string; line_no: number }>(
    "SELECT * FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY line_no", [orig.id],
  );
  const ts = splitTimestamp(new Date().toISOString());
  const id = crypto.randomUUID();
  const seq = Number(terminal.invoice_seq) + 1;
  const number = `${terminal.prefix}-CN-${String(seq).padStart(6, "0")}`;
  // Refund the way the customer paid: a credit sale is refunded against the receivable, not in cash.
  const origPay = await tx.query<{ method: PaymentMethod; amount: string }>(
    "SELECT method, amount FROM payments WHERE invoice_id=$1 ORDER BY amount DESC", [orig.id],
  );
  const method: PaymentMethod = input.method ?? origPay.rows[0]?.method ?? "CASH";
  const customer = orig.customer_id ? await maybeOne<CustomerRow>(tx, "SELECT * FROM customers WHERE id=$1", [orig.customer_id]) : null;

  await tx.query(
    `INSERT INTO sales_invoices (id, tenant_id, branch_id, terminal_id, customer_id, client_uuid, number, kind, doc_type, original_invoice_id, reason,
       currency, total_net, total_discount, total_tax, total_gross, cost_of_goods, issued_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$17,'CREDIT_NOTE',$8,$9,$10,$11,0,$12,$13,$14,$15,$16)`,
    [id, actor.tenantId, terminal.branch_id, terminal.id, orig.customer_id, input.clientUuid, number, orig.id, input.reason,
      orig.currency, orig.total_net, orig.total_tax, orig.total_gross, orig.cost_of_goods, ts.timestamp, actor.userId, orig.kind],
  );
  for (const l of lines.rows) {
    await tx.query(
      `INSERT INTO sales_invoice_lines (tenant_id, invoice_id, line_no, item_id, name, quantity, unit_net, discount_net, net, tax_percent, tax, gross, tax_category, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [actor.tenantId, id, l.line_no, l.item_id, l.name, l.quantity, l.unit_net, l.discount_net, l.net, l.tax_percent, l.tax, l.gross, l.tax_category, l.unit_cost],
    );
  }
  // Restock by replaying the original sale's stock moves in reverse: plain items, recipe ingredients and batches
  // all return at the exact cost they left at, so inventory value and the ledger reversal stay in sync.
  const moves = await tx.query<{ item_id: string; warehouse_id: string; batch_id: string | null; quantity: string; unit_cost: string }>(
    "SELECT item_id, warehouse_id, batch_id, quantity, unit_cost FROM stock_moves WHERE source_id=$1 AND source_type='SALE'",
    [orig.id],
  );
  let revaluation = Money.zero();
  for (const m of moves.rows) {
    revaluation = revaluation.add(await returnToStock(tx, actor.tenantId, {
      itemId: m.item_id, warehouseId: m.warehouse_id, batchId: m.batch_id, quantity: Money.of(m.quantity).neg().toStorage(), unitCost: m.unit_cost, sourceId: id,
    }));
  }
  await tx.query("INSERT INTO payments (tenant_id, invoice_id, method, amount) VALUES ($1,$2,$3,$4)", [actor.tenantId, id, method, Money.of(orig.total_gross).neg().toStorage()]);
  await postJournal(
    tx, actor,
    postSaleReturn({ invoiceNumber: orig.number, totalNet: orig.total_net, totalTax: orig.total_tax, totalGross: orig.total_gross, costOfGoods: orig.cost_of_goods, payments: [{ method, amount: orig.total_gross }] }),
    { type: "CREDIT_NOTE", id, date: ts.date },
  );
  await postRevaluation(tx, actor, revaluation, { type: "CREDIT_NOTE", id, date: ts.date });

  await issueEDocument(tx, {
    tenantId: actor.tenantId, terminal, company, invoiceId: id, number, seq, kind: orig.kind, documentType: "CREDIT_NOTE", ts,
    buyer: orig.kind === "STANDARD" && customer ? buyerOf(customer) : undefined,
    paymentMethod: method, original: { invoiceId: orig.id, number: orig.number }, reason: input.reason,
    lines: lines.rows.map((l) => ({
      lineNo: l.line_no, itemId: l.item_id, name: l.name, quantity: Money.of(l.quantity), unitNet: Money.of(l.unit_net), net: Money.of(l.net),
      taxPercent: Money.of(l.tax_percent), tax: Money.of(l.tax), gross: Money.of(l.gross), taxCategory: l.tax_category as EDocLine["taxCategory"],
    })),
    totals: { net: Money.of(orig.total_net), tax: Money.of(orig.total_tax), gross: Money.of(orig.total_gross) },
  });
  await emit(tx, actor.tenantId, "CreditNotePosted", { id, number, originalInvoiceId: orig.id });
  await audit(tx, actor, "sale.refunded", "sales_invoice", id, { number, original: orig.number, reason: input.reason });
  return { ...(await getInvoice(tx, id)), replayed: false };
}
