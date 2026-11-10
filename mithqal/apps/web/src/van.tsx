import { useCallback, useEffect, useState } from "react";
import { Money } from "@mithqal/money";
import { api } from "./api";

interface VanStock { item_id: string; name_ar: string; price: string; quantity: string }
interface VanInfo { warehouse_id: string; terminal_id: string; vehicle_plate: string | null; stock: VanStock[] }
interface Stop { seq: number; customerId: string; name: string; phone: string | null; balanceDue: string; lat: number; lng: number }
interface Route { totalKm: string; stops: Stop[] }
interface Settlement {
  cashToHandOver: string;
  sales: { method: string; amount: string }[];
  collections: { method: string; amount: string }[];
  visits: { total: number; sold: number; outsideGeofence: number };
  vanStock: { item: string; quantity: string; value: string }[];
}

const RIYADH = { lat: 24.7136, lng: 46.6753 };
const fmt = (v: string | Money) => `${Number(typeof v === "string" ? v : v.toFixed(2)).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
const methodAr: Record<string, string> = { CASH: "نقدًا", CARD: "شبكة", CREDIT: "آجل", BANK_TRANSFER: "تحويل", CHEQUE: "شيك" };

function position(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(RIYADH);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(RIYADH),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

export function VanApp({ toast }: { toast: (s: string) => void }) {
  const [view, setView] = useState<"route" | "settle">("route");
  const [van, setVan] = useState<VanInfo | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [active, setActive] = useState<{ stop: Stop; visitId: string; outside: boolean; distance: number | null } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const pos = await position();
      const [v, r] = await Promise.all([api<VanInfo>("GET", "/v1/van/me"), api<Route>("GET", `/v1/van/route?lat=${pos.lat}&lng=${pos.lng}`)]);
      setVan(v);
      setRoute(r);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function start(stop: Stop) {
    try {
      const pos = await position();
      const r = await api<{ visitId: string; outsideGeofence: boolean; distanceMeters: number | null }>("POST", "/v1/van/visits", { customerId: stop.customerId, ...pos });
      setActive({ stop, visitId: r.visitId, outside: r.outsideGeofence, distance: r.distanceMeters });
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (err) return <div className="page error">{err}</div>;
  if (!van || !route) return <div className="page muted">جاري تجهيز مسار اليوم…</div>;

  return (
    <div className="page van">
      <div className="cats" style={{ marginTop: 0 }}>
        <button className={`cat ${view === "route" ? "active" : ""}`} onClick={() => setView("route")}>مسار اليوم</button>
        <button className={`cat ${view === "settle" ? "active" : ""}`} onClick={() => setView("settle")}>تسوية آخر اليوم</button>
      </div>
      {view === "route" && !active && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="label">زيارات اليوم</div><div className="value">{route.stops.length.toLocaleString("ar-SA")}</div><div className="muted">{Number(route.totalKm).toLocaleString("ar-SA")} كم تقريبًا</div></div>
            <div className="kpi"><div className="label">أصناف في السيارة</div><div className="value">{van.stock.length.toLocaleString("ar-SA")}</div><div className="muted">{van.vehicle_plate ?? ""}</div></div>
          </div>
          <div className="panel">
            <h3>العملاء بالترتيب الأمثل</h3>
            {route.stops.length === 0 && <div className="muted">لا توجد زيارات مجدولة اليوم.</div>}
            {route.stops.map((s) => (
              <div key={s.customerId} className="stop">
                <span className="seq">{s.seq.toLocaleString("ar-SA")}</span>
                <div style={{ flex: 1 }}>
                  <strong>{s.name}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {Number(s.balanceDue) > 0 ? <span className="error">مستحق: {fmt(s.balanceDue)}</span> : "لا مستحقات"}
                  </div>
                </div>
                <a className="btn ghost" href={`https://maps.google.com/?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">خريطة</a>
                <button className="btn primary" onClick={() => start(s)}>ابدأ الزيارة</button>
              </div>
            ))}
          </div>
        </>
      )}
      {view === "route" && active && (
        <Visit van={van} active={active} toast={toast} onDone={() => { setActive(null); load(); }} />
      )}
      {view === "settle" && <SettlementView />}
    </div>
  );
}

function Visit({ van, active, toast, onDone }: {
  van: VanInfo;
  active: { stop: Stop; visitId: string; outside: boolean; distance: number | null };
  toast: (s: string) => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [collectAmt, setCollectAmt] = useState("");
  const [sold, setSold] = useState(false);
  const [collected, setCollected] = useState(false);
  const [busy, setBusy] = useState(false);
  const lines = van.stock.filter((s) => (qty[s.item_id] ?? 0) > 0);
  const total = Money.sum(lines.map((l) => Money.of(l.price).mul(qty[l.item_id] ?? 0)));

  async function sell(method: "CASH" | "CREDIT") {
    setBusy(true);
    try {
      const r = await api<{ number: string; kind: string }>("POST", "/v1/pos/sales", {
        clientUuid: crypto.randomUUID(), terminalId: van.terminal_id, customerId: active.stop.customerId,
        lines: lines.map((l) => ({ itemId: l.item_id, quantity: String(qty[l.item_id]) })),
        payments: [{ method, amount: total.toFixed(2) }],
      });
      toast(`تم إصدار ${r.kind === "STANDARD" ? "فاتورة ضريبية" : "فاتورة مبسطة"} ${r.number}`);
      setSold(true);
      setQty({});
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function collect() {
    setBusy(true);
    try {
      const r = await api<{ balance: string }>("POST", "/v1/collections", {
        clientUuid: crypto.randomUUID(), customerId: active.stop.customerId, method: "CASH", amount: Money.of(collectAmt).toFixed(2), visitId: active.visitId,
      });
      toast(`تم التحصيل. الرصيد المتبقي ${fmt(r.balance)}`);
      setCollected(true);
      setCollectAmt("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    const outcome = sold ? "SOLD" : collected ? "COLLECTED" : "NO_ORDER";
    await api("POST", `/v1/van/visits/${active.visitId}/checkout`, { outcome });
    onDone();
  }

  return (
    <div className="panel">
      <h3>زيارة: {active.stop.name}</h3>
      {active.outside && <div className="suggest">⚠️ أنت على بُعد {active.distance?.toLocaleString("ar-SA")} م من موقع العميل المسجل — سيتم إبلاغ المشرف.</div>}
      <h3 style={{ marginTop: 16 }}>بيع من السيارة</h3>
      {van.stock.map((s) => (
        <div key={s.item_id} className="line">
          <div>{s.name_ar}<div className="muted" style={{ fontSize: 12 }}>{fmt(s.price)} · متوفر {Number(s.quantity).toLocaleString("ar-SA")}</div></div>
          <div className="qty">
            <button onClick={() => setQty((q) => ({ ...q, [s.item_id]: Math.max(0, (q[s.item_id] ?? 0) - 1) }))}>−</button>
            <span>{(qty[s.item_id] ?? 0).toLocaleString("ar-SA")}</span>
            <button onClick={() => setQty((q) => ({ ...q, [s.item_id]: Math.min(Number(s.quantity), (q[s.item_id] ?? 0) + 1) }))}>+</button>
          </div>
          <strong>{fmt(Money.of(s.price).mul(qty[s.item_id] ?? 0))}</strong>
        </div>
      ))}
      <div className="row big" style={{ marginTop: 12 }}><span>الإجمالي</span><span>{fmt(total)}</span></div>
      <div className="pay">
        <button className="btn primary" disabled={!lines.length || busy} onClick={() => sell("CASH")}>بيع نقدًا</button>
        <button className="btn gold" disabled={!lines.length || busy} onClick={() => sell("CREDIT")}>بيع آجل</button>
      </div>
      {Number(active.stop.balanceDue) > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>تحصيل (المستحق {fmt(active.stop.balanceDue)})</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="search" inputMode="decimal" placeholder="المبلغ" value={collectAmt} onChange={(e) => setCollectAmt(e.target.value)} />
            <button className="btn primary" disabled={!collectAmt || busy} onClick={collect}>تحصيل</button>
          </div>
        </>
      )}
      <button className="btn ghost" style={{ width: "100%", marginTop: 20 }} onClick={finish}>إنهاء الزيارة</button>
    </div>
  );
}

function SettlementView() {
  const [s, setS] = useState<Settlement | null>(null);
  useEffect(() => {
    api<Settlement>("GET", "/v1/van/settlement").then(setS).catch(() => undefined);
  }, []);
  if (!s) return <div className="muted">جاري الحساب…</div>;
  return (
    <>
      <div className="kpis">
        <div className="kpi"><div className="label">النقدية المطلوب تسليمها</div><div className="value">{fmt(s.cashToHandOver)}</div></div>
        <div className="kpi"><div className="label">الزيارات</div><div className="value">{s.visits.total.toLocaleString("ar-SA")}</div><div className="muted">بيع في {s.visits.sold.toLocaleString("ar-SA")} · خارج النطاق {s.visits.outsideGeofence.toLocaleString("ar-SA")}</div></div>
      </div>
      <div className="panel">
        <h3>المبيعات</h3>
        <table><tbody>{s.sales.map((x) => <tr key={x.method}><td>{methodAr[x.method]}</td><td>{fmt(x.amount)}</td></tr>)}</tbody></table>
        <h3 style={{ marginTop: 16 }}>التحصيلات</h3>
        <table><tbody>{s.collections.map((x) => <tr key={x.method}><td>{methodAr[x.method]}</td><td>{fmt(x.amount)}</td></tr>)}</tbody></table>
        <h3 style={{ marginTop: 16 }}>المتبقي في السيارة</h3>
        <table><tbody>{s.vanStock.map((x) => <tr key={x.item}><td>{x.item}</td><td>{Number(x.quantity).toLocaleString("ar-SA")}</td><td>{fmt(x.value)}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}
