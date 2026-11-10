import { Money } from "@mithqal/money";
import { DEFAULT_GEOFENCE_METERS, distanceMeters, issue, planRoute, postCollection, receive, type CollectionMethod } from "@mithqal/domain";
import { BusinessError, maybeOne, one, type Tx } from "../db.js";
import { audit, emit, postJournal, type Actor } from "./core.js";
import { createTerminal } from "./onboarding.js";
import { requireCapacity, requireModule } from "./licensing.js";

/** Owner assigns a van (warehouse + POS terminal with its own e-invoice chain) to a sales rep. */
export async function setupVan(tx: Tx, actor: Actor, input: { userId: string; vehiclePlate?: string }) {
  const rep = await maybeOne<{ full_name: string; role: string }>(tx, "SELECT full_name, role FROM users WHERE id=$1", [input.userId]);
  if (!rep || rep.role !== "sales_rep") throw new BusinessError("المستخدم ليس مندوب مبيعات");
  const exists = await maybeOne(tx, "SELECT 1 FROM van_assignments WHERE user_id=$1", [input.userId]);
  if (exists) throw new BusinessError("هذا المندوب لديه سيارة بالفعل");
  await requireModule(tx, "van_sales");
  await requireCapacity(tx, "vans");
  const branch = await one<{ id: string }>(tx, "SELECT id FROM branches ORDER BY name LIMIT 1");
  const n = (await one<{ n: string }>(tx, "SELECT count(*) AS n FROM van_assignments")).n;
  const wh = await one<{ id: string }>(tx, "INSERT INTO warehouses (tenant_id, branch_id, name) VALUES ($1,$2,$3) RETURNING id", [
    actor.tenantId, branch.id, `سيارة ${rep.full_name}`,
  ]);
  const terminalId = await createTerminal(tx, actor.tenantId, branch.id, wh.id, `جوال ${rep.full_name}`, `VAN${Number(n) + 1}`);
  await tx.query("INSERT INTO van_assignments (user_id, tenant_id, warehouse_id, terminal_id, vehicle_plate) VALUES ($1,$2,$3,$4,$5)", [
    input.userId, actor.tenantId, wh.id, terminalId, input.vehiclePlate ?? null,
  ]);
  await audit(tx, actor, "van.assigned", "user", input.userId, { warehouseId: wh.id, terminalId });
  return { userId: input.userId, warehouseId: wh.id, terminalId };
}

export async function vanOf(tx: Tx, userId: string) {
  const v = await maybeOne<{ warehouse_id: string; terminal_id: string; vehicle_plate: string | null }>(
    tx, "SELECT warehouse_id, terminal_id, vehicle_plate FROM van_assignments WHERE user_id=$1", [userId],
  );
  if (!v) throw new BusinessError("لا توجد سيارة مخصصة لهذا المندوب");
  return v;
}

/** Move stock between warehouses (load / unload a van) at moving-average cost. No P&L impact. */
export async function transferStock(
  tx: Tx,
  actor: Actor,
  input: { fromWarehouseId: string; toWarehouseId: string; reference?: string; lines: { itemId: string; quantity: string }[] },
) {
  if (input.fromWarehouseId === input.toWarehouseId) throw new BusinessError("لا يمكن التحويل لنفس المستودع");
  const t = await one<{ id: string }>(
    tx,
    "INSERT INTO stock_transfers (tenant_id, from_warehouse_id, to_warehouse_id, reference, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [actor.tenantId, input.fromWarehouseId, input.toWarehouseId, input.reference ?? null, actor.userId],
  );
  for (const l of input.lines) {
    const item = await one<{ track_stock: boolean; track_batches: boolean; name_ar: string }>(tx, "SELECT track_stock, track_batches, name_ar FROM items WHERE id=$1", [l.itemId]);
    if (!item.track_stock) throw new BusinessError(`الصنف ${item.name_ar} خدمي ولا يُحوَّل`);
    if (item.track_batches) throw new BusinessError(`تحويل الأصناف ذات التشغيلات غير مدعوم بعد: ${item.name_ar}`);
    for (const w of [input.fromWarehouseId, input.toWarehouseId]) {
      await tx.query(
        "INSERT INTO stock_balances (tenant_id, item_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT (item_id, warehouse_id) DO NOTHING",
        [actor.tenantId, l.itemId, w],
      );
    }
    // lock in a stable order to avoid deadlocks between concurrent transfers
    const rows = await tx.query<{ warehouse_id: string; quantity: string; average_cost: string }>(
      "SELECT warehouse_id, quantity, average_cost FROM stock_balances WHERE item_id=$1 AND warehouse_id = ANY($2) ORDER BY warehouse_id FOR UPDATE",
      [l.itemId, [input.fromWarehouseId, input.toWarehouseId]],
    );
    const src = rows.rows.find((r) => r.warehouse_id === input.fromWarehouseId)!;
    const dst = rows.rows.find((r) => r.warehouse_id === input.toWarehouseId)!;
    let out;
    try {
      out = issue({ quantity: Money.of(src.quantity), averageCost: Money.of(src.average_cost) }, l.quantity, { allowNegative: false });
    } catch {
      throw new BusinessError(`الكمية غير متوفرة من ${item.name_ar}`);
    }
    const unitCost = Money.of(src.average_cost);
    const into = receive({ quantity: Money.of(dst.quantity), averageCost: Money.of(dst.average_cost) }, l.quantity, unitCost);
    await tx.query("UPDATE stock_balances SET quantity=$1 WHERE item_id=$2 AND warehouse_id=$3", [out.position.quantity.toStorage(), l.itemId, input.fromWarehouseId]);
    await tx.query("UPDATE stock_balances SET quantity=$1, average_cost=$2 WHERE item_id=$3 AND warehouse_id=$4", [
      into.quantity.toStorage(), into.averageCost.toStorage(), l.itemId, input.toWarehouseId,
    ]);
    await tx.query(
      `INSERT INTO stock_moves (tenant_id, item_id, warehouse_id, quantity, unit_cost, source_type, source_id)
       VALUES ($1,$2,$3,$4,$5,'TRANSFER_OUT',$7), ($1,$2,$6,$8,$5,'TRANSFER_IN',$7)`,
      [actor.tenantId, l.itemId, input.fromWarehouseId, Money.of(l.quantity).neg().toStorage(), unitCost.toStorage(), input.toWarehouseId, t.id, Money.of(l.quantity).toStorage()],
    );
  }
  await audit(tx, actor, "stock.transferred", "stock_transfer", t.id, input);
  return { transferId: t.id };
}

export async function checkIn(tx: Tx, actor: Actor, input: { customerId: string; lat: number; lng: number }) {
  const c = await maybeOne<{ latitude: string | null; longitude: string | null; name: string }>(
    tx, "SELECT latitude, longitude, name FROM customers WHERE id=$1", [input.customerId],
  );
  if (!c) throw new BusinessError("العميل غير موجود");
  const open = await maybeOne(tx, "SELECT 1 FROM visits WHERE user_id=$1 AND check_out_at IS NULL", [actor.userId]);
  if (open) throw new BusinessError("أنهِ الزيارة الحالية قبل بدء زيارة جديدة");
  let distance: number | null = null;
  if (c.latitude !== null && c.longitude !== null) {
    distance = distanceMeters({ lat: input.lat, lng: input.lng }, { lat: Number(c.latitude), lng: Number(c.longitude) });
  }
  const outside = distance !== null && distance > DEFAULT_GEOFENCE_METERS;
  const v = await one<{ id: string }>(
    tx,
    `INSERT INTO visits (tenant_id, user_id, customer_id, check_in_lat, check_in_lng, distance_m, outside_geofence)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [actor.tenantId, actor.userId, input.customerId, input.lat, input.lng, distance, outside],
  );
  if (outside) await emit(tx, actor.tenantId, "VisitOutsideGeofence", { visitId: v.id, userId: actor.userId, customer: c.name, distance });
  return { visitId: v.id, distanceMeters: distance, outsideGeofence: outside };
}

export async function checkOut(tx: Tx, actor: Actor, input: { visitId: string; outcome: string; note?: string }) {
  const r = await tx.query(
    "UPDATE visits SET check_out_at=now(), outcome=$1, note=$2 WHERE id=$3 AND user_id=$4 AND check_out_at IS NULL RETURNING id",
    [input.outcome, input.note ?? null, input.visitId, actor.userId],
  );
  if (!r.rowCount) throw new BusinessError("الزيارة غير موجودة أو مغلقة");
  return { visitId: input.visitId, closed: true };
}

/** Accounts-receivable balance for a customer: credit sales − credit refunds − collections. */
export async function customerBalance(tx: Tx, customerId: string): Promise<Money> {
  const r = await one<{ credit: string; collected: string }>(
    tx,
    `SELECT
       (SELECT coalesce(sum(p.amount),0) FROM payments p JOIN sales_invoices i ON i.id=p.invoice_id
         WHERE i.customer_id=$1 AND p.method='CREDIT') AS credit,
       (SELECT coalesce(sum(amount),0) FROM collections WHERE customer_id=$1) AS collected`,
    [customerId],
  );
  return Money.of(r.credit).sub(r.collected);
}

export async function collect(
  tx: Tx,
  actor: Actor,
  input: { clientUuid: string; customerId: string; method: CollectionMethod; amount: string; reference?: string; visitId?: string },
) {
  const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM collections WHERE client_uuid=$1", [input.clientUuid]);
  if (dup) return { collectionId: dup.id, replayed: true, balance: (await customerBalance(tx, input.customerId)).toFixed(2) };
  await tx.query("SELECT 1 FROM customers WHERE id=$1 FOR UPDATE", [input.customerId]);
  const balance = await customerBalance(tx, input.customerId);
  if (Money.of(input.amount).gt(balance)) {
    throw new BusinessError(`المبلغ أكبر من رصيد العميل المستحق (${balance.toFixed(2)})`);
  }
  const c = await one<{ id: string }>(
    tx,
    `INSERT INTO collections (tenant_id, client_uuid, customer_id, user_id, visit_id, method, amount, reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [actor.tenantId, input.clientUuid, input.customerId, actor.userId, input.visitId ?? null, input.method, input.amount, input.reference ?? null],
  );
  await postJournal(tx, actor, postCollection({ reference: input.reference ?? c.id, method: input.method, amount: input.amount }), {
    type: "COLLECTION", id: c.id, date: new Date().toISOString().slice(0, 10),
  });
  await emit(tx, actor.tenantId, "PaymentCollected", { collectionId: c.id, customerId: input.customerId, amount: input.amount });
  await audit(tx, actor, "collection.created", "collection", c.id, { customerId: input.customerId, amount: input.amount, method: input.method });
  return { collectionId: c.id, replayed: false, balance: balance.sub(input.amount).toFixed(2) };
}

/** Today's route: customers scheduled for this weekday plus anyone with an outstanding balance (priority). */
export async function todaysRoute(tx: Tx, start: { lat: number; lng: number }, day: Date) {
  const dow = day.getUTCDay();
  const rows = await tx.query<{ id: string; name: string; phone: string | null; latitude: string; longitude: string; route_day: number | null }>(
    "SELECT id, name, phone, latitude, longitude, route_day FROM customers WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
  );
  const stops: { id: string; lat: number; lng: number; priority: number; name: string; phone: string | null; balance: string }[] = [];
  for (const c of rows.rows) {
    const bal = await customerBalance(tx, c.id);
    if (c.route_day !== dow && !bal.gt(0)) continue;
    stops.push({ id: c.id, lat: Number(c.latitude), lng: Number(c.longitude), priority: bal.gt(0) ? Number(bal.toFixed(0)) : 0, name: c.name, phone: c.phone, balance: bal.toFixed(2) });
  }
  const plan = planRoute(start, stops);
  return {
    totalKm: (plan.totalMeters / 1000).toFixed(1),
    stops: plan.order.map((s, i) => {
      const full = stops.find((x) => x.id === s.id)!;
      return { seq: i + 1, customerId: s.id, name: full.name, phone: full.phone, balanceDue: full.balance, lat: s.lat, lng: s.lng };
    }),
  };
}

/** End-of-day van settlement: what the rep sold, collected, must hand over, and what is left in the van. */
export async function vanSettlement(tx: Tx, userId: string, day: string) {
  const van = await vanOf(tx, userId);
  const sales = await tx.query<{ method: string; amount: string }>(
    `SELECT p.method, sum(p.amount) AS amount FROM payments p JOIN sales_invoices i ON i.id=p.invoice_id
      WHERE i.terminal_id=$1 AND i.issued_at::date=$2 GROUP BY p.method`,
    [van.terminal_id, day],
  );
  const cols = await tx.query<{ method: string; amount: string }>(
    "SELECT method, sum(amount) AS amount FROM collections WHERE user_id=$1 AND collected_at::date=$2 GROUP BY method",
    [userId, day],
  );
  const visits = await one<{ total: string; outside: string; sold: string }>(
    tx,
    `SELECT count(*) AS total, count(*) FILTER (WHERE outside_geofence) AS outside, count(*) FILTER (WHERE outcome='SOLD') AS sold
       FROM visits WHERE user_id=$1 AND check_in_at::date=$2`,
    [userId, day],
  );
  const stock = await tx.query<{ name_ar: string; quantity: string; value: string }>(
    `SELECT i.name_ar, b.quantity, (b.quantity*b.average_cost) AS value FROM stock_balances b JOIN items i ON i.id=b.item_id
      WHERE b.warehouse_id=$1 AND b.quantity <> 0 ORDER BY i.name_ar`,
    [van.warehouse_id],
  );
  const amount = (rows: { method: string; amount: string }[], m: string) => Money.of(rows.find((r) => r.method === m)?.amount ?? 0);
  const cashToHandOver = amount(sales.rows, "CASH").add(amount(cols.rows, "CASH"));
  return {
    day,
    sales: sales.rows.map((r) => ({ method: r.method, amount: Money.of(r.amount).toFixed(2) })),
    collections: cols.rows.map((r) => ({ method: r.method, amount: Money.of(r.amount).toFixed(2) })),
    cashToHandOver: cashToHandOver.toFixed(2),
    visits: { total: Number(visits.total), sold: Number(visits.sold), outsideGeofence: Number(visits.outside) },
    vanStock: stock.rows.map((s) => ({ item: s.name_ar, quantity: Money.of(s.quantity).toString(), value: Money.of(s.value).toFixed(2) })),
  };
}
