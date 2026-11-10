import { Money } from "@mithqal/money";
import { allocateFefo, issue, postPurchase, receive } from "@mithqal/domain";
import { BusinessError, one, type Tx } from "../db.js";
import { audit, emit, postJournal, type Actor } from "./core.js";

interface BalanceRow {
  quantity: string;
  average_cost: string;
}

async function lockBalance(tx: Tx, tenantId: string, itemId: string, warehouseId: string): Promise<BalanceRow> {
  await tx.query(
    `INSERT INTO stock_balances (tenant_id, item_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT (item_id, warehouse_id) DO NOTHING`,
    [tenantId, itemId, warehouseId],
  );
  return one<BalanceRow>(tx, "SELECT quantity, average_cost FROM stock_balances WHERE item_id=$1 AND warehouse_id=$2 FOR UPDATE", [itemId, warehouseId]);
}

export interface ReceiptLine {
  itemId: string;
  quantity: string;
  unitCost: string; // net of VAT
  batchNo?: string;
  expiryDate?: string;
}

/** Goods receipt with supplier bill: updates moving average, batches, and posts Inventory/VAT/AP. */
export async function receiveGoods(
  tx: Tx,
  actor: Actor,
  input: { warehouseId: string; reference: string; lines: ReceiptLine[]; paidCash?: boolean; date: string },
): Promise<{ receiptId: string; net: string; tax: string }> {
  const company = await one<{ vat_percent: string; currency: string }>(tx, "SELECT vat_percent, currency FROM companies LIMIT 1");
  const receiptId = crypto.randomUUID();
  let net = Money.zero();
  for (const l of input.lines) {
    const item = await one<{ track_stock: boolean; track_batches: boolean }>(
      tx, "SELECT track_stock, track_batches FROM items WHERE id=$1", [l.itemId],
    );
    if (!item.track_stock) throw new BusinessError("لا يمكن استلام صنف خدمي في المخزون");
    if (item.track_batches && !l.batchNo) throw new BusinessError("هذا الصنف يتطلب رقم تشغيلة وتاريخ صلاحية");
    const bal = await lockBalance(tx, actor.tenantId, l.itemId, input.warehouseId);
    const pos = receive({ quantity: Money.of(bal.quantity), averageCost: Money.of(bal.average_cost) }, l.quantity, l.unitCost);
    await tx.query("UPDATE stock_balances SET quantity=$1, average_cost=$2 WHERE item_id=$3 AND warehouse_id=$4", [
      pos.quantity.toStorage(), pos.averageCost.toStorage(), l.itemId, input.warehouseId,
    ]);
    let batchId: string | null = null;
    if (item.track_batches && l.batchNo) {
      const b = await one<{ id: string }>(
        tx,
        `INSERT INTO item_batches (tenant_id, item_id, warehouse_id, batch_no, expiry_date, quantity) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (item_id, warehouse_id, batch_no) DO UPDATE SET quantity = item_batches.quantity + EXCLUDED.quantity
         RETURNING id`,
        [actor.tenantId, l.itemId, input.warehouseId, l.batchNo, l.expiryDate ?? null, l.quantity],
      );
      batchId = b.id;
    }
    await tx.query(
      `INSERT INTO stock_moves (tenant_id, item_id, warehouse_id, batch_id, quantity, unit_cost, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'GOODS_RECEIPT',$7)`,
      [actor.tenantId, l.itemId, input.warehouseId, batchId, l.quantity, l.unitCost, receiptId],
    );
    net = net.add(Money.of(l.quantity).mul(l.unitCost).roundTo(company.currency));
  }
  const tax = net.mul(Money.of(company.vat_percent).div(100)).roundTo(company.currency);
  await postJournal(tx, actor, postPurchase({ reference: input.reference, net, tax, paidCash: input.paidCash }), {
    type: "GOODS_RECEIPT", id: receiptId, date: input.date,
  });
  await emit(tx, actor.tenantId, "GoodsReceived", { receiptId, reference: input.reference });
  await audit(tx, actor, "stock.received", "goods_receipt", receiptId, { reference: input.reference, lines: input.lines.length });
  return { receiptId, net: net.toFixed(), tax: tax.toFixed() };
}

/** Issue stock for a sale line. Returns cost at moving average. Batch items are allocated FEFO. */
export async function issueForSale(
  tx: Tx,
  tenantId: string,
  opts: { itemId: string; warehouseId: string; quantity: string; allowNegative: boolean; trackBatches: boolean; today: string; sourceId: string },
): Promise<{ unitCost: Money; totalCost: Money }> {
  const bal = await lockBalance(tx, tenantId, opts.itemId, opts.warehouseId);
  const r = issue({ quantity: Money.of(bal.quantity), averageCost: Money.of(bal.average_cost) }, opts.quantity, {
    allowNegative: opts.allowNegative && !opts.trackBatches,
  });
  await tx.query("UPDATE stock_balances SET quantity=$1 WHERE item_id=$2 AND warehouse_id=$3", [
    r.position.quantity.toStorage(), opts.itemId, opts.warehouseId,
  ]);
  const unitCost = Money.of(bal.average_cost);
  if (opts.trackBatches) {
    const batches = await tx.query<{ id: string; expiry_date: string | null; quantity: string }>(
      `SELECT id, to_char(expiry_date,'YYYY-MM-DD') AS expiry_date, quantity FROM item_batches
       WHERE item_id=$1 AND warehouse_id=$2 AND quantity > 0 FOR UPDATE`,
      [opts.itemId, opts.warehouseId],
    );
    let alloc;
    try {
      alloc = allocateFefo(batches.rows.map((b) => ({ batchId: b.id, expiryDate: b.expiry_date, quantity: b.quantity })), opts.quantity, opts.today);
    } catch (e) {
      throw new BusinessError(`لا توجد كمية صالحة كافية: ${(e as Error).message}`);
    }
    for (const a of alloc) {
      await tx.query("UPDATE item_batches SET quantity = quantity - $1 WHERE id=$2", [a.quantity.toStorage(), a.batchId]);
      await tx.query(
        `INSERT INTO stock_moves (tenant_id, item_id, warehouse_id, batch_id, quantity, unit_cost, source_type, source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'SALE',$7)`,
        [tenantId, opts.itemId, opts.warehouseId, a.batchId, a.quantity.neg().toStorage(), unitCost.toStorage(), opts.sourceId],
      );
    }
  } else {
    await tx.query(
      `INSERT INTO stock_moves (tenant_id, item_id, warehouse_id, quantity, unit_cost, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,'SALE',$6)`,
      [tenantId, opts.itemId, opts.warehouseId, Money.of(opts.quantity).neg().toStorage(), unitCost.toStorage(), opts.sourceId],
    );
  }
  if (r.wentNegative) {
    await emit(tx, tenantId, "StockWentNegative", { itemId: opts.itemId, warehouseId: opts.warehouseId, quantity: r.position.quantity.toFixed(3) });
  }
  return { unitCost, totalCost: r.cost };
}

/** Return goods to stock at their original unit cost (credit notes). */
export async function returnToStock(
  tx: Tx,
  tenantId: string,
  opts: { itemId: string; warehouseId: string; quantity: string; unitCost: string; sourceId: string; batchId?: string | null },
): Promise<void> {
  if (opts.batchId) {
    await tx.query("UPDATE item_batches SET quantity = quantity + $1 WHERE id=$2", [opts.quantity, opts.batchId]);
  }
  const bal = await lockBalance(tx, tenantId, opts.itemId, opts.warehouseId);
  const pos = receive({ quantity: Money.of(bal.quantity), averageCost: Money.of(bal.average_cost) }, opts.quantity, opts.unitCost);
  await tx.query("UPDATE stock_balances SET quantity=$1, average_cost=$2 WHERE item_id=$3 AND warehouse_id=$4", [
    pos.quantity.toStorage(), pos.averageCost.toStorage(), opts.itemId, opts.warehouseId,
  ]);
  await tx.query(
    `INSERT INTO stock_moves (tenant_id, item_id, warehouse_id, batch_id, quantity, unit_cost, source_type, source_id)
     VALUES ($1,$2,$3,$7,$4,$5,'SALE_RETURN',$6)`,
    [tenantId, opts.itemId, opts.warehouseId, opts.quantity, opts.unitCost, opts.sourceId, opts.batchId ?? null],
  );
}
