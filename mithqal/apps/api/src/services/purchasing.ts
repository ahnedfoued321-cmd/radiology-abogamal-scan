import { Money } from "@mithqal/money";
import { postSupplierPayment, suggestReorder } from "@mithqal/domain";
import { BusinessError, maybeOne, one, type Tx } from "../db.js";
import { assertVisible, audit, emit, lockKey, postJournal, type Actor } from "./core.js";
import { receiveGoods } from "./inventory.js";

/** Accounts payable to a supplier: unpaid receipts (gross) minus payments. */
export async function supplierBalance(tx: Tx, supplierId: string): Promise<Money> {
  const r = await one<{ owed: string; paid: string }>(
    tx,
    `SELECT (SELECT coalesce(sum(net+tax),0) FROM goods_receipts WHERE supplier_id=$1 AND NOT paid_cash) AS owed,
            (SELECT coalesce(sum(amount),0) FROM supplier_payments WHERE supplier_id=$1) AS paid`,
    [supplierId],
  );
  return Money.of(r.owed).sub(r.paid);
}

/** Items below their reorder level with a demand-based suggested quantity (last 14 days, 14 days cover). */
export async function reorderSuggestions(tx: Tx, warehouseId: string) {
  const rows = await tx.query<{ id: string; name_ar: string; on_hand: string; reorder_level: string; sold: string; last_cost: string }>(
    `SELECT i.id, i.name_ar, coalesce(b.quantity,0) AS on_hand, i.reorder_level, coalesce(b.average_cost,0) AS last_cost,
            coalesce((SELECT -sum(m.quantity) FROM stock_moves m
                       WHERE m.item_id=i.id AND m.warehouse_id=$1 AND m.source_type='SALE' AND m.created_at > now() - interval '14 days'),0) AS sold
       FROM items i LEFT JOIN stock_balances b ON b.item_id=i.id AND b.warehouse_id=$1
      WHERE i.active AND i.track_stock AND coalesce(b.quantity,0) <= i.reorder_level
      ORDER BY i.name_ar`,
    [warehouseId],
  );
  return rows.rows
    .map((r) => ({
      itemId: r.id,
      name: r.name_ar,
      onHand: Money.of(r.on_hand).toString(),
      soldLast14Days: Money.of(r.sold).toString(),
      suggestedQty: suggestReorder({ onHand: r.on_hand, soldLastNDays: r.sold, days: 14, coverDays: 14, reorderLevel: r.reorder_level }).toString(),
      estimatedUnitCost: Money.of(r.last_cost).toFixed(2),
    }))
    .filter((r) => Number(r.suggestedQty) > 0);
}

export async function createPurchaseOrder(
  tx: Tx,
  actor: Actor,
  input: { supplierId: string; warehouseId: string; note?: string; lines: { itemId: string; quantity: string; unitCost: string }[] },
) {
  await assertVisible(tx, "suppliers", input.supplierId, "المورد");
  await assertVisible(tx, "warehouses", input.warehouseId, "المستودع");
  for (const l of input.lines) await assertVisible(tx, "items", l.itemId, "الصنف");
  await lockKey(tx, `po-number:${actor.tenantId}`);
  const n = (await one<{ n: string }>(tx, "SELECT count(*) AS n FROM purchase_orders")).n;
  const number = `PO-${String(Number(n) + 1).padStart(5, "0")}`;
  const po = await one<{ id: string }>(
    tx,
    "INSERT INTO purchase_orders (tenant_id, supplier_id, warehouse_id, number, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [actor.tenantId, input.supplierId, input.warehouseId, number, input.note ?? null, actor.userId],
  );
  for (const l of input.lines) {
    await tx.query("INSERT INTO purchase_order_lines (tenant_id, po_id, item_id, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)", [
      actor.tenantId, po.id, l.itemId, l.quantity, l.unitCost,
    ]);
  }
  await audit(tx, actor, "po.created", "purchase_order", po.id, { number, lines: input.lines.length });
  return getPurchaseOrder(tx, po.id);
}

export async function getPurchaseOrder(tx: Tx, id: string) {
  const po = await one<Record<string, unknown>>(tx, "SELECT * FROM purchase_orders WHERE id=$1", [id]);
  const lines = await tx.query(
    `SELECT l.item_id, i.name_ar, l.quantity, l.unit_cost, l.received_qty FROM purchase_order_lines l JOIN items i ON i.id=l.item_id
      WHERE l.po_id=$1 ORDER BY i.name_ar`,
    [id],
  );
  const total = Money.sum(lines.rows.map((l) => Money.of(l.quantity).mul(l.unit_cost)));
  return { ...po, lines: lines.rows, totalNet: total.toFixed(2) };
}

export async function approvePurchaseOrder(tx: Tx, actor: Actor, id: string) {
  const r = await tx.query("UPDATE purchase_orders SET status='APPROVED', approved_by=$1, approved_at=now() WHERE id=$2 AND status='DRAFT' RETURNING id", [actor.userId, id]);
  if (!r.rowCount) throw new BusinessError("أمر الشراء غير موجود أو ليس مسودة");
  await emit(tx, actor.tenantId, "PurchaseOrderApproved", { id });
  await audit(tx, actor, "po.approved", "purchase_order", id, null);
  return getPurchaseOrder(tx, id);
}

/** Receive (fully or partially) against an approved PO; over-receipt is refused. */
export async function receivePurchaseOrder(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { reference: string; lines: { itemId: string; quantity: string; batchNo?: string; expiryDate?: string }[] },
) {
  const po = await maybeOne<{ status: string; supplier_id: string; warehouse_id: string; number: string }>(
    tx, "SELECT status, supplier_id, warehouse_id, number FROM purchase_orders WHERE id=$1 FOR UPDATE", [id],
  );
  if (!po) throw new BusinessError("أمر الشراء غير موجود");
  if (!["APPROVED", "PARTIAL"].includes(po.status)) throw new BusinessError("يجب اعتماد أمر الشراء قبل الاستلام");
  const receiptLines = [];
  for (const l of input.lines) {
    const pl = await maybeOne<{ quantity: string; received_qty: string; unit_cost: string }>(
      tx, "SELECT quantity, received_qty, unit_cost FROM purchase_order_lines WHERE po_id=$1 AND item_id=$2", [id, l.itemId],
    );
    if (!pl) throw new BusinessError("صنف غير موجود في أمر الشراء");
    if (Money.of(pl.received_qty).add(l.quantity).gt(pl.quantity)) throw new BusinessError("الكمية المستلمة أكبر من المطلوبة");
    await tx.query("UPDATE purchase_order_lines SET received_qty = received_qty + $1 WHERE po_id=$2 AND item_id=$3", [l.quantity, id, l.itemId]);
    receiptLines.push({ ...l, unitCost: pl.unit_cost });
  }
  const receipt = await receiveGoods(tx, actor, {
    warehouseId: po.warehouse_id, reference: `${po.number} / ${input.reference}`, lines: receiptLines,
    date: new Date().toISOString().slice(0, 10), supplierId: po.supplier_id, poId: id,
  });
  const open = await one<{ n: string }>(tx, "SELECT count(*) AS n FROM purchase_order_lines WHERE po_id=$1 AND received_qty < quantity", [id]);
  await tx.query("UPDATE purchase_orders SET status=$1 WHERE id=$2", [Number(open.n) === 0 ? "RECEIVED" : "PARTIAL", id]);
  return { ...receipt, po: await getPurchaseOrder(tx, id) };
}

export async function paySupplier(
  tx: Tx,
  actor: Actor,
  input: { clientUuid: string; supplierId: string; method: "CASH" | "BANK_TRANSFER" | "CHEQUE"; amount: string; reference?: string },
) {
  await lockKey(tx, `client:${actor.tenantId}:${input.clientUuid}`);
  const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM supplier_payments WHERE client_uuid=$1", [input.clientUuid]);
  if (dup) return { paymentId: dup.id, replayed: true, balance: (await supplierBalance(tx, input.supplierId)).toFixed(2) };
  await tx.query("SELECT 1 FROM suppliers WHERE id=$1 FOR UPDATE", [input.supplierId]);
  const bal = await supplierBalance(tx, input.supplierId);
  if (Money.of(input.amount).gt(bal)) throw new BusinessError(`المبلغ أكبر من المستحق للمورد (${bal.toFixed(2)})`);
  const p = await one<{ id: string }>(
    tx,
    `INSERT INTO supplier_payments (tenant_id, client_uuid, supplier_id, method, amount, reference, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [actor.tenantId, input.clientUuid, input.supplierId, input.method, input.amount, input.reference ?? null, actor.userId],
  );
  await postJournal(tx, actor, postSupplierPayment({ reference: input.reference ?? p.id, method: input.method, amount: input.amount }), {
    type: "SUPPLIER_PAYMENT", id: p.id, date: new Date().toISOString().slice(0, 10),
  });
  await audit(tx, actor, "supplier.paid", "supplier_payment", p.id, { supplierId: input.supplierId, amount: input.amount });
  return { paymentId: p.id, replayed: false, balance: bal.sub(input.amount).toFixed(2) };
}
