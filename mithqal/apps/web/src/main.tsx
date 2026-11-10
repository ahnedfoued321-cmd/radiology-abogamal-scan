import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import { priceDocument } from "@mithqal/domain";
import { Money } from "@mithqal/money";
import { api, apiCached, ApiError, enqueue, flushOutbox, outbox, session, type Item, type Me, type SalePayload } from "./api";
import { VanApp } from "./van";
import { Admin } from "./admin";
import { Kitchen } from "./kitchen";
import "./styles.css";

const fmt = (v: string | Money, currency = "SAR") =>
  `${Number(typeof v === "string" ? v : v.toFixed(2)).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${({ SAR: "ر.س", EGP: "ج.م", AED: "د.إ", KWD: "د.ك", QAR: "ر.ق" } as Record<string, string>)[currency] ?? currency}`;

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/* ───────────────────────── Auth ───────────────────────── */

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        const r = await api<{ token: string }>("POST", "/v1/auth/login", { email: v("email"), password: v("password") });
        session.set(r.token);
      } else {
        const r = await api<{ token: string }>("POST", "/v1/onboarding", {
          businessNameAr: v("business"),
          country: v("country") || "SA",
          industry: v("industry"),
          vatNumber: v("vat") || undefined,
          crNumber: v("cr") || undefined,
          address: v("city") ? { street: v("street"), buildingNumber: v("building"), district: v("district"), city: v("city"), postalCode: v("postal") } : undefined,
          owner: { fullName: v("name"), email: v("email"), password: v("password") },
        });
        session.set(r.token);
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="modal form" onSubmit={submit}>
        <h1><span className="brand-mark">م</span> مِثقال</h1>
        <p className="muted" style={{ marginTop: 0 }}>كل مثقال في شغلك… محسوب.</p>
        {mode === "signup" && (
          <>
            <div className="two">
              <label>اسم النشاط<input name="business" required placeholder="مثال: مقهى الريحان" /></label>
              <label>الدولة
                <select name="country" defaultValue="SA">
                  <option value="SA">🇸🇦 السعودية (ZATCA)</option>
                  <option value="EG">🇪🇬 مصر (ETA)</option>
                </select>
              </label>
            </div>
            <div className="two">
              <label>النشاط
                <select name="industry" defaultValue="cafe">
                  <option value="cafe">كافيه</option>
                  <option value="restaurant">مطعم</option>
                  <option value="pharmacy">صيدلية</option>
                  <option value="retail">تجزئة</option>
                  <option value="distribution">توزيع</option>
                </select>
              </label>
              <label>اسمك<input name="name" required /></label>
            </div>
            <div className="two">
              <label>الرقم الضريبي (السعودية 15 رقم · مصر 9 أرقام)<input name="vat" inputMode="numeric" /></label>
              <label>السجل التجاري<input name="cr" inputMode="numeric" /></label>
            </div>
            <div className="two">
              <label>المدينة<input name="city" /></label>
              <label>الحي<input name="district" /></label>
            </div>
            <div className="two">
              <label>الشارع<input name="street" /></label>
              <label>رقم المبنى / الرمز البريدي
                <div className="two"><input name="building" /><input name="postal" /></div>
              </label>
            </div>
          </>
        )}
        <label>البريد الإلكتروني<input name="email" type="email" required autoComplete="username" /></label>
        <label>كلمة المرور<input name="password" type="password" required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>{mode === "login" ? "دخول" : "ابدأ مجانًا — جاهز في دقائق"}</button>
        <button type="button" className="btn ghost" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "منشأة جديدة؟ سجّل الآن" : "لديك حساب؟ سجّل الدخول"}
        </button>
      </form>
    </div>
  );
}

/* ───────────────────────── POS ───────────────────────── */

interface CartLine { item: Item; qty: number }
interface Receipt { number: string; total: string; qr: string | null; offline: boolean; change?: string }

function Pos({ me, items, reloadItems, toast }: { me: Me; items: Item[]; reloadItems: () => void; toast: (s: string) => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("الكل");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const terminal = me.terminals[0];
  const currency = me.company.currency;

  const cats = useMemo(() => ["الكل", ...new Set(items.map((i) => i.category ?? "أخرى"))], [items]);
  const visible = items.filter(
    (i) => (cat === "الكل" || (i.category ?? "أخرى") === cat) && (!q || i.name_ar.includes(q) || i.sku === q || i.barcode === q),
  );

  const priced = useMemo(() => {
    if (cart.length === 0) return null;
    return priceDocument(
      cart.map((l) => ({ itemId: l.item.id, name: l.item.name_ar, quantity: l.qty, unitPrice: l.item.price, taxPercent: l.item.tax_percent })),
      { currency, pricesIncludeTax: me.company.prices_include_tax },
    );
  }, [cart, currency, me.company.prices_include_tax]);

  const add = (item: Item) =>
    setCart((c) => {
      const ex = c.find((l) => l.item.id === item.id);
      return ex ? c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { item, qty: 1 }];
    });
  const bump = (id: string, d: number) => setCart((c) => c.map((l) => (l.item.id === id ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  // Barcode scanners type the code and press Enter.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const hit = items.find((i) => i.barcode === q || i.sku === q);
    if (hit) {
      add(hit);
      setQ("");
    }
  };

  async function checkout(method: "CASH" | "CARD", tendered?: string) {
    if (!priced || !terminal) return;
    setPaying(true);
    const sale: SalePayload = {
      clientUuid: crypto.randomUUID(),
      terminalId: terminal.id,
      issuedAt: new Date().toISOString(),
      lines: cart.map((l) => ({ itemId: l.item.id, quantity: String(l.qty) })),
      payments: [{ method, amount: priced.totalGross.toFixed(2) }],
    };
    const change = tendered ? Money.of(tendered).sub(priced.totalGross) : undefined;
    try {
      const r = await api<{ number: string; total_gross: string; eInvoice: { qr: string } }>("POST", "/v1/pos/sales", sale);
      setReceipt({ number: r.number, total: r.total_gross, qr: r.eInvoice.qr, offline: false, change: change?.toFixed(2) });
      reloadItems();
    } catch (e) {
      if (e instanceof TypeError || !navigator.onLine) {
        enqueue(sale);
        setReceipt({ number: "بانتظار المزامنة", total: priced.totalGross.toFixed(2), qr: null, offline: true, change: change?.toFixed(2) });
      } else {
        toast((e as Error).message);
        setPaying(false);
        return;
      }
    }
    setCart([]);
    setPaying(false);
  }

  return (
    <div className="pos">
      <section className="catalog">
        <input className="search" placeholder="ابحث بالاسم أو امسح الباركود…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} autoFocus />
        <div className="cats">
          {cats.map((c) => (
            <button key={c} className={`cat ${c === cat ? "active" : ""}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        <div className="grid">
          {visible.map((i) => {
            const onHand = Number(i.on_hand);
            return (
              <button key={i.id} className="tile" onClick={() => add(i)}>
                <span className="name">{i.name_ar}</span>
                {i.track_stock && <span className={`stock ${onHand <= 5 ? "low" : ""}`}>المتوفر: {onHand.toLocaleString("ar-SA")}</span>}
                <span className="price">{fmt(i.price, currency)}</span>
              </button>
            );
          })}
          {visible.length === 0 && <div className="empty">لا توجد أصناف. أضف أصنافك من تبويب «الأصناف».</div>}
        </div>
      </section>

      <aside className="cart">
        <h2>الفاتورة الحالية</h2>
        <div className="lines">
          {cart.length === 0 && <div className="empty">اختر صنفًا لبدء البيع</div>}
          {cart.map((l) => (
            <div key={l.item.id} className="line">
              <div>{l.item.name_ar}<div className="muted" style={{ fontSize: 12 }}>{fmt(l.item.price, currency)}</div></div>
              <div className="qty">
                <button onClick={() => bump(l.item.id, -1)} aria-label="إنقاص">−</button>
                <span>{l.qty.toLocaleString("ar-SA")}</span>
                <button onClick={() => bump(l.item.id, 1)} aria-label="زيادة">+</button>
              </div>
              <strong>{fmt(Money.of(l.item.price).mul(l.qty), currency)}</strong>
            </div>
          ))}
        </div>
        <div className="totals">
          <div className="row muted"><span>قبل الضريبة</span><span>{priced ? fmt(priced.totalNet, currency) : "—"}</span></div>
          <div className="row muted"><span>ضريبة القيمة المضافة</span><span>{priced ? fmt(priced.totalTax, currency) : "—"}</span></div>
          <div className="row big"><span>الإجمالي</span><span>{priced ? fmt(priced.totalGross, currency) : fmt("0", currency)}</span></div>
          <div className="pay">
            <button className="btn primary" disabled={!priced || paying} onClick={() => {
              const t = window.prompt("المبلغ المستلم نقدًا", priced?.totalGross.toFixed(2));
              if (t !== null) checkout("CASH", t);
            }}>نقدًا</button>
            <button className="btn gold" disabled={!priced || paying} onClick={() => checkout("CARD")}>شبكة / مدى</button>
          </div>
        </div>
      </aside>

      {receipt && <ReceiptModal r={receipt} currency={currency} onClose={() => setReceipt(null)} />}
    </div>
  );
}

function ReceiptModal({ r, currency, onClose }: { r: Receipt; currency: string; onClose: () => void }) {
  const [img, setImg] = useState<string>("");
  useEffect(() => {
    if (r.qr) QRCode.toDataURL(r.qr, { margin: 1, width: 360 }).then(setImg).catch(() => setImg(""));
  }, [r.qr]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal receipt" onClick={(e) => e.stopPropagation()}>
        <span className={`badge ${r.offline ? "" : "ok"}`}>{r.offline ? "محفوظة على الجهاز — ستُرسل تلقائيًا" : "فاتورة ضريبية مبسطة"}</span>
        <h2 style={{ margin: "12px 0 4px" }}>{fmt(r.total, currency)}</h2>
        <div className="muted">رقم الفاتورة: {r.number}</div>
        {r.change && Number(r.change) > 0 && <div style={{ marginTop: 8 }}>الباقي للعميل: <strong>{fmt(r.change, currency)}</strong></div>}
        {img && <img src={img} alt="رمز QR للفاتورة الإلكترونية" style={{ marginTop: 12 }} />}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => window.print()}>طباعة</button>
          <button className="btn primary" style={{ flex: 1 }} onClick={onClose}>فاتورة جديدة</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Dashboard ───────────────────────── */

interface Daily {
  invoices: number; creditNotes: number; netSales: string; vat: string; grossSales: string; grossProfit: string; grossMarginPercent: string;
  payments: { method: string; amount: string }[]; topItems: { name: string; quantity: string; gross: string }[];
  lowStock: { name: string; quantity: string }[]; eInvoicesNeedingAttention: number;
}

function Dashboard({ me }: { me: Me }) {
  const [d, setD] = useState<Daily | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Daily>("GET", "/v1/reports/daily").then(setD).catch((e) => setErr((e as Error).message));
  }, []);
  const c = me.company.currency;
  if (err) return <div className="page error">{err}</div>;
  if (!d) return <div className="page muted">جاري التحميل…</div>;
  const methodName: Record<string, string> = { CASH: "نقدًا", CARD: "شبكة", CREDIT: "آجل" };
  return (
    <div className="page">
      <h2 style={{ marginTop: 0 }}>صباح الخير 👋 هذا ملخص اليوم</h2>
      <div className="kpis">
        <div className="kpi"><div className="label">المبيعات (شامل الضريبة)</div><div className="value">{fmt(d.grossSales, c)}</div></div>
        <div className="kpi"><div className="label">مجمل الربح</div><div className="value">{fmt(d.grossProfit, c)}</div><div className="muted">هامش {Number(d.grossMarginPercent).toLocaleString("ar-SA")}٪</div></div>
        <div className="kpi"><div className="label">عدد الفواتير</div><div className="value">{d.invoices.toLocaleString("ar-SA")}</div><div className="muted">مرتجعات: {d.creditNotes.toLocaleString("ar-SA")}</div></div>
        <div className="kpi"><div className="label">ضريبة القيمة المضافة</div><div className="value">{fmt(d.vat, c)}</div></div>
      </div>
      <Assistant />
      <div className="panel">
        <h3>الامتثال (ZATCA)</h3>
        {d.eInvoicesNeedingAttention === 0
          ? <span className="badge ok">كل الفواتير الإلكترونية سليمة ✓</span>
          : <span className="badge">{d.eInvoicesNeedingAttention.toLocaleString("ar-SA")} فاتورة بانتظار الإرسال أو تحتاج تدخل</span>}
      </div>
      <div className="two">
        <div className="panel">
          <h3>الأكثر مبيعًا اليوم</h3>
          <table><tbody>{d.topItems.map((t) => <tr key={t.name}><td>{t.name}</td><td>{Number(t.quantity).toLocaleString("ar-SA")}</td><td>{fmt(t.gross, c)}</td></tr>)}</tbody></table>
          {d.topItems.length === 0 && <div className="muted">لا مبيعات بعد</div>}
        </div>
        <div className="panel">
          <h3>طرق الدفع</h3>
          <table><tbody>{d.payments.map((p) => <tr key={p.method}><td>{methodName[p.method] ?? p.method}</td><td>{fmt(p.amount, c)}</td></tr>)}</tbody></table>
          <h3 style={{ marginTop: 16 }}>نواقص المخزون</h3>
          {d.lowStock.length === 0 ? <div className="muted">لا توجد نواقص</div> :
            <table><tbody>{d.lowStock.map((l) => <tr key={l.name}><td>{l.name}</td><td className="error">{Number(l.quantity).toLocaleString("ar-SA")}</td></tr>)}</tbody></table>}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Assistant «ذهب» ───────────────────────── */

interface Answer { intent: string; answer: string; suggestion?: string }

function Assistant() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ q: string; a: Answer }[]>([]);
  const [busy, setBusy] = useState(false);
  const examples = ["كم بعنا النهارده؟", "كسبنا كام؟", "إيش الأكثر مبيعًا؟", "إيه النواقص؟", "مين عليه فلوس؟", "وضع زاتكا؟"];
  async function send(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const a = await api<Answer>("POST", "/v1/assistant/ask", { question });
      setLog((l) => [{ q: question, a }, ...l].slice(0, 6));
      setQ("");
    } catch (e) {
      setLog((l) => [{ q: question, a: { intent: "ERROR", answer: (e as Error).message } }, ...l]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel assistant">
      <h3><span className="brand-mark" style={{ width: 26, height: 26, fontSize: 13 }}>ذ</span> اسأل «ذهب»</h3>
      <form onSubmit={(e) => { e.preventDefault(); send(q); }} style={{ display: "flex", gap: 8 }}>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="اسأل عن شغلك بلهجتك…" />
        <button className="btn primary" disabled={busy} style={{ whiteSpace: "nowrap" }}>اسأل</button>
      </form>
      <div className="cats">{examples.map((x) => <button key={x} className="cat" onClick={() => send(x)}>{x}</button>)}</div>
      {log.map((m, i) => (
        <div key={i} className="qa">
          <div className="muted">{m.q}</div>
          <div>{m.a.answer}</div>
          {m.a.suggestion && <div className="suggest">💡 {m.a.suggestion}</div>}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Items & stock ───────────────────────── */

function Items({ me, items, reload, toast }: { me: Me; items: Item[]; reload: () => void; toast: (s: string) => void }) {
  async function addItem(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("POST", "/v1/items", {
        sku: String(f.get("sku")), nameAr: String(f.get("name")), category: String(f.get("category") || "") || undefined,
        price: String(f.get("price")), barcode: String(f.get("barcode") || "") || undefined, reorderLevel: String(f.get("reorder") || "0"),
      });
      form.reset();
      reload();
      toast("تمت إضافة الصنف");
    } catch (err) {
      toast((err as Error).message);
    }
  }
  async function receiveStock(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("POST", "/v1/inventory/receipts", {
        warehouseId: me.warehouses[0]?.id, reference: String(f.get("ref") || "استلام"),
        lines: [{ itemId: String(f.get("item")), quantity: String(f.get("qty")), unitCost: String(f.get("cost")) }],
      });
      form.reset();
      reload();
      toast("تم استلام البضاعة وترحيل القيد");
    } catch (err) {
      toast((err as Error).message);
    }
  }
  return (
    <div className="page">
      <div className="two">
        <form className="panel form" onSubmit={addItem}>
          <h3>صنف جديد</h3>
          <div className="two"><label>الاسم<input name="name" required /></label><label>الكود<input name="sku" required /></label></div>
          <div className="two"><label>السعر (شامل الضريبة)<input name="price" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" /></label><label>التصنيف<input name="category" /></label></div>
          <div className="two"><label>الباركود<input name="barcode" /></label><label>حد إعادة الطلب<input name="reorder" inputMode="decimal" /></label></div>
          <button className="btn primary">حفظ الصنف</button>
        </form>
        <form className="panel form" onSubmit={receiveStock}>
          <h3>استلام بضاعة</h3>
          <label>الصنف<select name="item" required>{items.filter((i) => i.track_stock).map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}</select></label>
          <div className="two"><label>الكمية<input name="qty" required inputMode="decimal" pattern="\d+(\.\d{1,4})?" /></label><label>تكلفة الوحدة (قبل الضريبة)<input name="cost" required inputMode="decimal" pattern="\d+(\.\d{1,4})?" /></label></div>
          <label>المرجع (رقم فاتورة المورد)<input name="ref" /></label>
          <button className="btn gold">استلام</button>
        </form>
      </div>
      <div className="panel">
        <h3>الأصناف ({items.length})</h3>
        <table>
          <thead><tr><th>الصنف</th><th>الكود</th><th>السعر</th><th>المتوفر</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.id}><td>{i.name_ar}</td><td>{i.sku}</td><td>{fmt(i.price, me.company.currency)}</td><td>{Number(i.on_hand).toLocaleString("ar-SA")}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────────────────── App shell ───────────────────────── */

function App() {
  const [authed, setAuthed] = useState(Boolean(session.token));
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [tab, setTab] = useState<"pos" | "dash" | "items" | "admin" | "kds">("pos");
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState(outbox().length);
  const online = useOnline();

  const toast = useCallback((s: string) => {
    setMsg(s);
    setTimeout(() => setMsg(""), 3500);
  }, []);
  const loadItems = useCallback(() => {
    apiCached<Item[]>("/v1/items", "items").then(setItems).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authed) return;
    apiCached<Me>("/v1/me", "me")
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setAuthed(false);
      });
    loadItems();
  }, [authed, loadItems]);

  // Offline sync loop
  useEffect(() => {
    if (!authed) return;
    const sync = async () => {
      if (outbox().length && navigator.onLine) {
        const r = await flushOutbox();
        if (r.sent) {
          toast(`تمت مزامنة ${r.sent} فاتورة`);
          loadItems();
        }
      }
      setPending(outbox().length);
    };
    const t = setInterval(sync, 8000);
    window.addEventListener("online", sync);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", sync);
    };
  }, [authed, toast, loadItems]);

  if (!authed) return <Auth onDone={() => setAuthed(true)} />;
  if (!me) return <div className="page muted">جاري التحميل…</div>;
  const isManager = me.user.role === "owner" || me.user.role === "accountant";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">م</span>مِثقال</div>
        <nav className="tabs">
          <button className={`tab ${tab === "pos" ? "active" : ""}`} onClick={() => setTab("pos")}>{me.user.role === "sales_rep" ? "خُطى — المندوب" : "نقطة البيع"}</button>
          {isManager && <button className={`tab ${tab === "dash" ? "active" : ""}`} onClick={() => setTab("dash")}>لوحة اليوم</button>}
          {!["cashier", "sales_rep"].includes(me.user.role) && <button className={`tab ${tab === "items" ? "active" : ""}`} onClick={() => setTab("items")}>الأصناف والمخزون</button>}
                  {["cafe", "restaurant"].includes(me.company.industry) && ["owner", "cashier"].includes(me.user.role) && (
            <button className={`tab ${tab === "kds" ? "active" : ""}`} onClick={() => setTab("kds")}>شاشة التحضير</button>
          )}
          {me.user.role === "owner" && <button className={`tab ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}>الإدارة</button>}
        </nav>
        <div className="spacer" />
        <span className="company" style={{ color: "#d7e2dc" }}>{me.company.name_ar}</span>
        <span className={`pill ${online ? "" : "offline"}`}>{online ? "متصل" : "غير متصل — البيع مستمر"}</span>
        {pending > 0 && <span className="pill offline">{pending} بانتظار المزامنة</span>}
        <button className="link" onClick={() => { session.clear(); setAuthed(false); setMe(null); }}>خروج</button>
      </header>
      {me.user.role === "sales_rep" ? <VanApp toast={toast} /> : tab === "pos" && <Pos me={me} items={items} reloadItems={loadItems} toast={toast} />}
      {tab === "dash" && <Dashboard me={me} />}
      {tab === "items" && <Items me={me} items={items} reload={loadItems} toast={toast} />}
      {tab === "admin" && <Admin me={me} toast={toast} />}
      {tab === "kds" && <Kitchen toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
