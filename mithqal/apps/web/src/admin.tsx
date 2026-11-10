import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "./api";

const n = (v: string | number) => Number(v).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const roleAr: Record<string, string> = { owner: "مالك", accountant: "محاسب", cashier: "كاشير", storekeeper: "أمين مخزن", sales_rep: "مندوب" };
const statusAr: Record<string, string> = { DRAFT: "مسودة", APPROVED: "معتمد", PARTIAL: "استلام جزئي", RECEIVED: "مستلم", CANCELLED: "ملغي" };

type Section = "subscription" | "team" | "customers" | "purchasing" | "menu" | "payroll";

export function Admin({ me, toast }: { me: Me; toast: (s: string) => void }) {
  const [section, setSection] = useState<Section>("purchasing");
  const tabs: [Section, string][] = [
    ["purchasing", "المشتريات والموردين"],
    ["menu", "تكلفة المنيو"],
    ["customers", "العملاء والمستحقات"],
    ["team", "الفريق والمناديب"],
    ["payroll", "الرواتب"],
    ["subscription", "الباقة"],
  ];
  return (
    <div className="page">
      <div className="cats" style={{ marginTop: 0 }}>
        {tabs.map(([k, label]) => (
          <button key={k} className={`cat ${section === k ? "active" : ""}`} onClick={() => setSection(k)}>{label}</button>
        ))}
      </div>
      {section === "purchasing" && <Purchasing me={me} toast={toast} />}
      {section === "menu" && <MenuCosting />}
      {section === "customers" && <Customers toast={toast} />}
      {section === "team" && <Team toast={toast} />}
      {section === "subscription" && <Subscription />}
      {section === "payroll" && <Payroll toast={toast} />}
    </div>
  );
}

function useLoad<T>(path: string): [T | null, () => void, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<T>("GET", path).then((d) => { setData(d); setErr(""); }).catch((e) => setErr((e as Error).message));
  }, [path]);
  useEffect(load, [load]);
  return [data, load, err];
}

/* ───── Purchasing: smart reorder → PO → approve → receive ───── */

interface Suggestion { itemId: string; name: string; onHand: string; soldLast14Days: string; suggestedQty: string; estimatedUnitCost: string }
interface Supplier { id: string; name: string; balance: string; payment_terms_days: number }
interface PoRow { id: string; number: string; status: string; supplier: string; total_net: string }

function Purchasing({ me, toast }: { me: Me; toast: (s: string) => void }) {
  const wh = me.warehouses[0]?.id ?? "";
  const [sugs, reloadSugs] = useLoad<Suggestion[]>(`/v1/purchasing/suggestions?warehouseId=${wh}`);
  const [sups, reloadSups] = useLoad<Supplier[]>("/v1/suppliers");
  const [pos, reloadPos] = useLoad<PoRow[]>("/v1/purchasing/orders");
  const [supplierId, setSupplierId] = useState("");
  const reload = () => { reloadSugs(); reloadSups(); reloadPos(); };

  async function addSupplier(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("POST", "/v1/suppliers", { name: String(f.get("name")), phone: String(f.get("phone") || "") || undefined });
      form.reset();
      reloadSups();
    } catch (err) { toast((err as Error).message); }
  }

  async function orderSuggested() {
    if (!sugs?.length || !supplierId) return toast("اختر المورد أولًا");
    try {
      const po = await api<{ number: string }>("POST", "/v1/purchasing/orders", {
        supplierId, warehouseId: wh,
        lines: sugs.map((s) => ({ itemId: s.itemId, quantity: s.suggestedQty, unitCost: s.estimatedUnitCost === "0.00" ? "0" : s.estimatedUnitCost })),
      });
      toast(`تم إنشاء ${po.number} — بانتظار اعتمادك`);
      reload();
    } catch (err) { toast((err as Error).message); }
  }

  async function approve(id: string) {
    try { await api("POST", `/v1/purchasing/orders/${id}/approve`); reload(); toast("تم الاعتماد"); } catch (err) { toast((err as Error).message); }
  }

  async function receiveAll(id: string) {
    try {
      const po = await api<{ lines: { item_id: string; quantity: string; received_qty: string }[] }>("GET", `/v1/purchasing/orders/${id}`);
      const lines = po.lines
        .map((l) => ({ itemId: l.item_id, quantity: String(Number(l.quantity) - Number(l.received_qty)) }))
        .filter((l) => Number(l.quantity) > 0);
      await api("POST", `/v1/purchasing/orders/${id}/receive`, { reference: "استلام كامل", lines });
      toast("تم الاستلام وترحيل القيد");
      reload();
    } catch (err) { toast((err as Error).message); }
  }

  return (
    <>
      <div className="panel">
        <h3>💡 إعادة الطلب الذكية</h3>
        <p className="muted" style={{ marginTop: 0 }}>كميات مقترحة حسب سرعة البيع الفعلية آخر ١٤ يومًا + مخزون أمان.</p>
        {!sugs?.length ? <div className="muted">لا توجد أصناف تحتاج إعادة طلب الآن ✓</div> : (
          <>
            <table>
              <thead><tr><th>الصنف</th><th>المتوفر</th><th>مبيع ١٤ يوم</th><th>المقترح</th><th>تكلفة الوحدة</th></tr></thead>
              <tbody>{sugs.map((s) => (
                <tr key={s.itemId}><td>{s.name}</td><td>{Number(s.onHand).toLocaleString("ar-SA")}</td><td>{Number(s.soldLast14Days).toLocaleString("ar-SA")}</td>
                  <td><strong>{Number(s.suggestedQty).toLocaleString("ar-SA")}</strong></td><td>{n(s.estimatedUnitCost)}</td></tr>
              ))}</tbody>
            </table>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <select className="search" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— اختر المورد —</option>
                {sups?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="btn primary" style={{ whiteSpace: "nowrap" }} onClick={orderSuggested}>أنشئ أمر شراء</button>
            </div>
          </>
        )}
      </div>
      <div className="panel">
        <h3>أوامر الشراء</h3>
        {!pos?.length ? <div className="muted">لا توجد أوامر شراء بعد</div> : (
          <table>
            <thead><tr><th>الرقم</th><th>المورد</th><th>الإجمالي (قبل الضريبة)</th><th>الحالة</th><th /></tr></thead>
            <tbody>{pos.map((p) => (
              <tr key={p.id}><td>{p.number}</td><td>{p.supplier}</td><td>{n(p.total_net)}</td><td><span className="badge">{statusAr[p.status] ?? p.status}</span></td>
                <td>
                  {p.status === "DRAFT" && <button className="btn primary" onClick={() => approve(p.id)}>اعتماد</button>}
                  {(p.status === "APPROVED" || p.status === "PARTIAL") && <button className="btn gold" onClick={() => receiveAll(p.id)}>استلام</button>}
                </td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="two">
        <div className="panel">
          <h3>الموردون</h3>
          <table><tbody>{sups?.map((s) => <tr key={s.id}><td>{s.name}</td><td className={Number(s.balance) > 0 ? "error" : "muted"}>مستحق: {n(s.balance)}</td></tr>)}</tbody></table>
        </div>
        <form className="panel form" onSubmit={addSupplier}>
          <h3>مورد جديد</h3>
          <label>الاسم<input name="name" required /></label>
          <label>الجوال<input name="phone" inputMode="tel" /></label>
          <button className="btn primary">إضافة</button>
        </form>
      </div>
    </>
  );
}

/* ───── Menu costing ───── */

interface CostRow { itemId: string; name: string; price: string; costPerUnit: string; marginPercent: string; belowTarget: boolean; suggestedPrice: string | null }

function MenuCosting() {
  const [rows] = useLoad<CostRow[]>("/v1/reports/menu-costing?targetMargin=65");
  return (
    <div className="panel">
      <h3>تكلفة كل صنف وهامشه (الهدف ٦٥٪)</h3>
      {!rows?.length ? <div className="muted">أضف وصفات لأصناف المنيو لترى تكلفة الكوب الحية.</div> : (
        <table>
          <thead><tr><th>الصنف</th><th>السعر</th><th>التكلفة</th><th>الهامش</th><th>السعر المقترح</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.itemId}><td>{r.name}</td><td>{n(r.price)}</td><td>{n(r.costPerUnit)}</td>
              <td className={r.belowTarget ? "error" : ""}>{Number(r.marginPercent).toLocaleString("ar-SA")}٪</td>
              <td>{r.suggestedPrice ? <span className="badge">{n(r.suggestedPrice)}</span> : "✓"}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

/* ───── Customers ───── */

interface Customer { id: string; name: string; phone: string | null; vat_number: string | null; credit_limit: string; balance: string }

function Customers({ toast }: { toast: (s: string) => void }) {
  const [rows, reload] = useLoad<Customer[]>("/v1/customers");
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    try {
      await api("POST", "/v1/customers", {
        name: v("name"), phone: v("phone") || undefined, vatNumber: v("vat") || undefined, creditLimit: v("limit") || undefined,
        address: v("city") ? { street: v("street"), buildingNumber: v("building"), district: v("district"), city: v("city"), postalCode: v("postal") } : undefined,
      });
      form.reset();
      reload();
    } catch (err) { toast((err as Error).message); }
  }
  const total = (rows ?? []).reduce((s, r) => s + Number(r.balance), 0);
  return (
    <div className="two">
      <div className="panel">
        <h3>العملاء — إجمالي المستحقات {n(total)}</h3>
        <table>
          <thead><tr><th>العميل</th><th>حد الائتمان</th><th>الرصيد</th></tr></thead>
          <tbody>{rows?.map((c) => (
            <tr key={c.id}><td>{c.name}{c.vat_number && <span className="badge" style={{ marginInlineStart: 6 }}>B2B</span>}</td>
              <td>{n(c.credit_limit)}</td><td className={Number(c.balance) > 0 ? "error" : "muted"}>{n(c.balance)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <form className="panel form" onSubmit={add}>
        <h3>عميل جديد</h3>
        <div className="two"><label>الاسم<input name="name" required /></label><label>الجوال<input name="phone" inputMode="tel" /></label></div>
        <div className="two"><label>الرقم الضريبي (للفواتير B2B)<input name="vat" inputMode="numeric" /></label><label>حد الائتمان<input name="limit" inputMode="decimal" /></label></div>
        <div className="two"><label>المدينة<input name="city" /></label><label>الحي<input name="district" /></label></div>
        <div className="two"><label>الشارع<input name="street" /></label><label>المبنى / الرمز البريدي<div className="two"><input name="building" /><input name="postal" /></div></label></div>
        <button className="btn primary">إضافة</button>
      </form>
    </div>
  );
}

/* ───── Team & vans ───── */

interface UserRow { id: string; full_name: string; email: string; role: string; has_van: boolean; vehicle_plate: string | null }

function Team({ toast }: { toast: (s: string) => void }) {
  const [rows, reload] = useLoad<UserRow[]>("/v1/users");
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("POST", "/v1/users", { fullName: String(f.get("name")), email: String(f.get("email")), password: String(f.get("password")), role: String(f.get("role")) });
      form.reset();
      reload();
      toast("تمت إضافة الموظف");
    } catch (err) { toast((err as Error).message); }
  }
  async function assignVan(userId: string) {
    const plate = window.prompt("رقم لوحة السيارة") ?? undefined;
    try { await api("POST", "/v1/van/assign", { userId, vehiclePlate: plate || undefined }); reload(); toast("تم تخصيص السيارة"); } catch (err) { toast((err as Error).message); }
  }
  return (
    <div className="two">
      <div className="panel">
        <h3>الفريق</h3>
        <table>
          <tbody>{rows?.map((u) => (
            <tr key={u.id}><td>{u.full_name}<div className="muted" style={{ fontSize: 12 }}>{u.email}</div></td><td>{roleAr[u.role] ?? u.role}</td>
              <td>{u.role === "sales_rep" && (u.has_van ? <span className="badge ok">سيارة {u.vehicle_plate ?? ""}</span> : <button className="btn gold" onClick={() => assignVan(u.id)}>خصص سيارة</button>)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <form className="panel form" onSubmit={add}>
        <h3>موظف جديد</h3>
        <label>الاسم<input name="name" required /></label>
        <label>البريد<input name="email" type="email" required /></label>
        <label>كلمة المرور<input name="password" type="password" minLength={8} required /></label>
        <label>الدور
          <select name="role" defaultValue="cashier">
            <option value="cashier">كاشير</option>
            <option value="accountant">محاسب</option>
            <option value="storekeeper">أمين مخزن</option>
            <option value="sales_rep">مندوب مبيعات</option>
          </select>
        </label>
        <button className="btn primary">إضافة</button>
      </form>
    </div>
  );
}

/* ───── Subscription ───── */

interface Sub {
  plan: string; effectivePlan: string; onTrial: boolean; trialEndsAt: string | null; status: string;
  limits: { users: number; terminals: number; vans: number }; usage: { users: number; terminals: number; vans: number };
  plans: { code: string; name_ar: string; price_monthly: string; max_users: number; max_terminals: number; max_vans: number }[];
}

function Subscription() {
  const [s] = useLoad<Sub>("/v1/subscription");
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const days = s.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(s.trialEndsAt) - Date.now()) / 86_400_000)) : 0;
  return (
    <>
      <div className="panel">
        <h3>باقتك: {s.plans.find((p) => p.code === s.effectivePlan)?.name_ar}</h3>
        {s.onTrial && <div className="suggest">🎁 أنت في الفترة التجريبية لباقة «احترافي» — متبقي {days.toLocaleString("ar-SA")} يوم.</div>}
        <div className="kpis" style={{ marginTop: 12 }}>
          <div className="kpi"><div className="label">المستخدمون</div><div className="value">{s.usage.users} / {s.limits.users}</div></div>
          <div className="kpi"><div className="label">نقاط البيع</div><div className="value">{s.usage.terminals} / {s.limits.terminals}</div></div>
          <div className="kpi"><div className="label">سيارات المناديب</div><div className="value">{s.usage.vans} / {s.limits.vans}</div></div>
        </div>
      </div>
      <div className="kpis">
        {s.plans.filter((p) => p.code !== "enterprise").map((p) => (
          <div key={p.code} className="kpi" style={p.code === s.effectivePlan ? { borderColor: "var(--gold)", borderWidth: 2 } : undefined}>
            <div className="label">{p.name_ar}</div>
            <div className="value">{Number(p.price_monthly) === 0 ? "مجانًا" : `${Number(p.price_monthly).toLocaleString("ar-SA")} ر.س/شهر`}</div>
            <div className="muted">{p.max_users} مستخدم · {p.max_terminals} نقطة بيع · {p.max_vans} مندوب</div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ───── Payroll ───── */

interface Employee { id: string; full_name: string; nationality: string; basic_salary: string; housing: string; transport: string }
interface PayrollRun { period: string; gross: string; employeeContrib: string; employerContrib: string; netPay: string; payslips: { full_name: string; gross: string; employee_contrib: string; net_pay: string }[] }
interface ExpiringDoc { full_name: string; kind: string; expiry_date: string; days: number }
const docAr: Record<string, string> = { IQAMA: "الإقامة", PASSPORT: "الجواز", HEALTH_CERT: "الشهادة الصحية", DRIVING_LICENSE: "رخصة القيادة", CONTRACT: "العقد", OTHER: "مستند" };

function Payroll({ toast }: { toast: (s: string) => void }) {
  const [emps, reload] = useLoad<Employee[]>("/v1/hr/employees");
  const [docs] = useLoad<ExpiringDoc[]>("/v1/hr/expiring-documents?days=60");
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const [period, setPeriod] = useState(lastMonth);
  const [run, setRun] = useState<PayrollRun | null>(null);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    try {
      await api("POST", "/v1/hr/employees", {
        fullName: v("name"), nationality: v("nat").toUpperCase(), hireDate: v("hire"), basicSalary: v("basic"),
        housing: v("housing") || undefined, transport: v("transport") || undefined, iban: v("iban") || undefined,
        documents: v("iqama") ? [{ kind: "IQAMA", expiryDate: v("iqama") }] : undefined,
      });
      form.reset();
      reload();
    } catch (err) { toast((err as Error).message); }
  }
  async function runPayroll() {
    try {
      setRun(await api<PayrollRun>("POST", "/v1/hr/payroll", { period }));
      toast("تم تشغيل المسير وترحيل القيد");
    } catch (err) {
      try { setRun(await api<PayrollRun>("GET", `/v1/hr/payroll/${period}`)); } catch { /* none yet */ }
      toast((err as Error).message);
    }
  }
  async function download() {
    const res = await fetch(`/v1/hr/payroll/${period}/bank-file`, { headers: { authorization: `Bearer ${localStorage.getItem("mithqal.token") ?? ""}` } });
    if (!res.ok) return toast("لا يوجد مسير لهذا الشهر");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `salaries-${period}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      {!!docs?.length && (
        <div className="panel">
          <h3>⚠️ مستندات تنتهي خلال ٦٠ يومًا</h3>
          <table><tbody>{docs.map((d, i) => <tr key={i}><td>{d.full_name}</td><td>{docAr[d.kind] ?? d.kind}</td><td className={d.days < 15 ? "error" : ""}>{d.expiry_date} ({d.days.toLocaleString("ar-SA")} يوم)</td></tr>)}</tbody></table>
        </div>
      )}
      <div className="panel">
        <h3>مسير الرواتب</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="search" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ maxWidth: 220 }} />
          <button className="btn primary" onClick={runPayroll}>تشغيل المسير</button>
          <button className="btn ghost" onClick={download}>ملف تحويل البنك</button>
        </div>
        {run && (
          <>
            <div className="kpis" style={{ marginTop: 12 }}>
              <div className="kpi"><div className="label">إجمالي الرواتب</div><div className="value">{n(run.gross)}</div></div>
              <div className="kpi"><div className="label">التأمينات (الموظف / المنشأة)</div><div className="value">{n(run.employeeContrib)} / {n(run.employerContrib)}</div></div>
              <div className="kpi"><div className="label">صافي التحويل</div><div className="value">{n(run.netPay)}</div></div>
            </div>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>الموظف</th><th>الإجمالي</th><th>حصة التأمينات</th><th>الصافي</th></tr></thead>
              <tbody>{run.payslips.map((p) => <tr key={p.full_name}><td>{p.full_name}</td><td>{n(p.gross)}</td><td>{n(p.employee_contrib)}</td><td><strong>{n(p.net_pay)}</strong></td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>
      <div className="two">
        <div className="panel">
          <h3>الموظفون</h3>
          <table><tbody>{emps?.map((e) => <tr key={e.id}><td>{e.full_name}</td><td>{e.nationality}</td><td>{n(Number(e.basic_salary) + Number(e.housing) + Number(e.transport))}</td></tr>)}</tbody></table>
        </div>
        <form className="panel form" onSubmit={add}>
          <h3>موظف جديد</h3>
          <div className="two"><label>الاسم<input name="name" required minLength={2} /></label><label>الجنسية (رمز الدولة)<input name="nat" required maxLength={2} placeholder="SA" /></label></div>
          <div className="two"><label>تاريخ التعيين<input name="hire" type="date" required /></label><label>الراتب الأساسي<input name="basic" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" /></label></div>
          <div className="two"><label>بدل السكن<input name="housing" inputMode="decimal" /></label><label>بدل النقل<input name="transport" inputMode="decimal" /></label></div>
          <div className="two"><label>الآيبان<input name="iban" /></label><label>انتهاء الإقامة<input name="iqama" type="date" /></label></div>
          <button className="btn primary">إضافة</button>
        </form>
      </div>
    </>
  );
}
