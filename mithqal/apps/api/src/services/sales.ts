import { Money } from "@mithqal/money";
import { postSale, postSaleReturn, priceDocument, type PaymentMethod } from "@mithqal/domain";
import { issueInvoice, type UblLine } from "@mithqal/zatca";
import { BusinessError, maybeOne, one, type Tx } from "../db.js";
import { audit, emit, postJournal, type Actor } from "./core.js";
import { issueForSale, returnToStock } from "./inventory.js";
import { customerBalance } from "./van.js";

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

interface CompanyRow {
  name_ar: string;
  vat_number: string | null;
  cr_number: string | null;
  street: string | null;
  building_number: string | null;
  district: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  currency: string;
  prices_include_tax: boolean;
  allow_negative_stock: boolean;
}

interface TerminalRow {
  id: string;
  branch_id: string;
  warehouse_id: string;
  prefix: string;
  invoice_seq: string;
  icv: string;
  last_hash: string;
  private_key_pem: string;
  public_key_pem: string;
}

const PAYMENT_MEANS: Record<PaymentMethod, string> = { CASH: "10", CARD: "48", CREDIT: "30" };

function sellerOf(c: CompanyRow) {
  if (!c.vat_number) throw new BusinessError("أضف الرقم الضريبي للمنشأة قبل إصدار الفواتير");
  return {
    name: c.name_ar,
    vatNumber: c.vat_number,
    crNumber: c.cr_number ?? undefined,
    address: c.street
      ? {
          street: c.street,
          buildingNumber: c.building_number ?? "",
          district: c.district ?? "",
          city: c.city ?? "",
          postalCode: c.postal_code ?? "",
          countryCode: c.country,
        }
      : undefined,
  };
}

function splitTimestamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BusinessError("Invalid issuedAt");
  const s = d.toISOString(); // 2026-11-10T22:15:00.000Z
  return { date: s.slice(0, 10), time: s.slice(11, 19), timestamp: `${s.slice(0, 19)}Z` };
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

  let cogs = Money.zero();
  const unitCosts: Money[] = [];
  for (const l of priced.lines) {
    const it = itemMap.get(l.itemId)!;
    if (!it.track_stock) {
      unitCosts.push(Money.zero());
      continue;
    }
    const c = await issueForSale(tx, actor.tenantId, {
      itemId: l.itemId, warehouseId: terminal.warehouse_id, quantity: l.quantity.toString(),
      allowNegative: company.allow_negative_stock, trackBatches: it.track_batches, today: ts.date, sourceId: invoiceId,
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
  const ublLines: UblLine[] = priced.lines.map((l) => ({
    id: l.index, name: l.name, quantity: l.quantity.toString(), unitPrice: l.unitNet.toFixed(2),
    lineNet: l.net.toFixed(2), taxPercent: l.taxPercent.toFixed(2), taxAmount: l.tax.toFixed(2), taxCategory: l.taxCategory,
  }));
  const signed = issueInvoice(
    {
      kind, documentType: "INVOICE", number, uuid: invoiceId, issueDate: ts.date, issueTime: ts.time, timestamp: ts.timestamp,
      currency: company.currency, seller: sellerOf(company), buyer: customer ? buyerOf(customer) : undefined,
      paymentMeansCode: PAYMENT_MEANS[mainMethod], lines: ublLines,
      totals: {
        lineExtension: priced.totalNet.toFixed(2), taxExclusive: priced.totalNet.toFixed(2), taxTotal: priced.totalTax.toFixed(2),
        taxInclusive: priced.totalGross.toFixed(2), allowanceTotal: "0.00", payable: priced.totalGross.toFixed(2),
      },
    },
    { icv: Number(terminal.icv), lastHash: terminal.last_hash },
    { privateKeyPem: terminal.private_key_pem, publicKeyPem: terminal.public_key_pem },
  );
  await tx.query(
    `INSERT INTO e_invoice_documents (tenant_id, invoice_id, terminal_id, authority, mode, icv, pih, hash, signature, qr, xml)
     VALUES ($1,$2,$3,'ZATCA',$10,$4,$5,$6,$7,$8,$9)`,
    [actor.tenantId, invoiceId, terminal.id, signed.icv, signed.pih, signed.hash, signed.signature, signed.qr, signed.xml,
      kind === "STANDARD" ? "CLEARANCE" : "REPORTING"],
  );
  await tx.query("UPDATE pos_terminals SET invoice_seq=$1, icv=$2, last_hash=$3 WHERE id=$4", [seq, signed.nextChain.icv, signed.nextChain.lastHash, terminal.id]);

  await emit(tx, actor.tenantId, "InvoicePosted", { invoiceId, number, kind, total: priced.totalGross.toFixed(2) });
  await audit(tx, actor, "sale.created", "sales_invoice", invoiceId, { number, total: priced.totalGross.toFixed(2) });
  return { ...(await getInvoice(tx, invoiceId)), replayed: false };
}

/** Full refund of a POS invoice as a ZATCA credit note (381), restocking at original cost. */
export async function refundSale(tx: Tx, actor: Actor, input: { invoiceId: string; clientUuid: string; reason: string; method?: PaymentMethod }) {
  const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM sales_invoices WHERE client_uuid=$1", [input.clientUuid]);
  if (dup) return { ...(await getInvoice(tx, dup.id)), replayed: true };

  const orig = await maybeOne<{ id: string; number: string; doc_type: string; terminal_id: string; customer_id: string | null; total_net: string; total_tax: string; total_gross: string; cost_of_goods: string; currency: string }>(
    tx, "SELECT * FROM sales_invoices WHERE id=$1", [input.invoiceId],
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
  const method: PaymentMethod = input.method ?? "CASH";

  await tx.query(
    `INSERT INTO sales_invoices (id, tenant_id, branch_id, terminal_id, customer_id, client_uuid, number, kind, doc_type, original_invoice_id, reason,
       currency, total_net, total_discount, total_tax, total_gross, cost_of_goods, issued_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SIMPLIFIED','CREDIT_NOTE',$8,$9,$10,$11,0,$12,$13,$14,$15,$16)`,
    [id, actor.tenantId, terminal.branch_id, terminal.id, orig.customer_id, input.clientUuid, number, orig.id, input.reason,
      orig.currency, orig.total_net, orig.total_tax, orig.total_gross, orig.cost_of_goods, ts.timestamp, actor.userId],
  );
  for (const l of lines.rows) {
    await tx.query(
      `INSERT INTO sales_invoice_lines (tenant_id, invoice_id, line_no, item_id, name, quantity, unit_net, discount_net, net, tax_percent, tax, gross, tax_category, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [actor.tenantId, id, l.line_no, l.item_id, l.name, l.quantity, l.unit_net, l.discount_net, l.net, l.tax_percent, l.tax, l.gross, l.tax_category, l.unit_cost],
    );
    const it = await one<{ track_stock: boolean; track_batches: boolean }>(tx, "SELECT track_stock, track_batches FROM items WHERE id=$1", [l.item_id]);
    if (it.track_stock && !it.track_batches) {
      await returnToStock(tx, actor.tenantId, { itemId: l.item_id, warehouseId: terminal.warehouse_id, quantity: l.quantity, unitCost: l.unit_cost, sourceId: id });
    }
  }
  await tx.query("INSERT INTO payments (tenant_id, invoice_id, method, amount) VALUES ($1,$2,$3,$4)", [actor.tenantId, id, method, Money.of(orig.total_gross).neg().toStorage()]);
  await postJournal(
    tx, actor,
    postSaleReturn({ invoiceNumber: orig.number, totalNet: orig.total_net, totalTax: orig.total_tax, totalGross: orig.total_gross, costOfGoods: orig.cost_of_goods, payments: [{ method, amount: orig.total_gross }] }),
    { type: "CREDIT_NOTE", id, date: ts.date },
  );

  const signed = issueInvoice(
    {
      kind: "SIMPLIFIED", documentType: "CREDIT_NOTE", number, uuid: id, issueDate: ts.date, issueTime: ts.time, timestamp: ts.timestamp,
      currency: company.currency, seller: sellerOf(company), paymentMeansCode: PAYMENT_MEANS[method], billingReference: orig.number, reason: input.reason,
      lines: lines.rows.map((l) => ({
        id: l.line_no, name: l.name, quantity: Money.of(l.quantity).toString(), unitPrice: Money.of(l.unit_net).toFixed(2),
        lineNet: Money.of(l.net).toFixed(2), taxPercent: Money.of(l.tax_percent).toFixed(2), taxAmount: Money.of(l.tax).toFixed(2),
        taxCategory: l.tax_category as UblLine["taxCategory"],
      })),
      totals: {
        lineExtension: Money.of(orig.total_net).toFixed(2), taxExclusive: Money.of(orig.total_net).toFixed(2), taxTotal: Money.of(orig.total_tax).toFixed(2),
        taxInclusive: Money.of(orig.total_gross).toFixed(2), allowanceTotal: "0.00", payable: Money.of(orig.total_gross).toFixed(2),
      },
    },
    { icv: Number(terminal.icv), lastHash: terminal.last_hash },
    { privateKeyPem: terminal.private_key_pem, publicKeyPem: terminal.public_key_pem },
  );
  await tx.query(
    `INSERT INTO e_invoice_documents (tenant_id, invoice_id, terminal_id, authority, mode, icv, pih, hash, signature, qr, xml)
     VALUES ($1,$2,$3,'ZATCA','REPORTING',$4,$5,$6,$7,$8,$9)`,
    [actor.tenantId, id, terminal.id, signed.icv, signed.pih, signed.hash, signed.signature, signed.qr, signed.xml],
  );
  await tx.query("UPDATE pos_terminals SET invoice_seq=$1, icv=$2, last_hash=$3 WHERE id=$4", [seq, signed.nextChain.icv, signed.nextChain.lastHash, terminal.id]);
  await emit(tx, actor.tenantId, "CreditNotePosted", { id, number, originalInvoiceId: orig.id });
  await audit(tx, actor, "sale.refunded", "sales_invoice", id, { number, original: orig.number, reason: input.reason });
  return { ...(await getInvoice(tx, id)), replayed: false };
}
