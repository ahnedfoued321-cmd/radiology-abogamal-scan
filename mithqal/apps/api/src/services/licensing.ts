import { one, type Tx } from "../db.js";

export type Module =
  | "pos" | "inventory" | "accounting" | "einvoicing" | "recipes" | "pharmacy"
  | "assistant" | "van_sales" | "fraud_guard" | "multi_branch" | "api" | "hr";

export class PlanError extends Error {
  statusCode = 402;
  constructor(message: string, public readonly upgradeTo?: string) {
    super(message);
  }
}

export interface Entitlements {
  plan: string;
  effectivePlan: string;
  onTrial: boolean;
  trialEndsAt: string | null;
  status: string;
  priceMonthly: string;
  limits: { users: number; terminals: number; vans: number };
  modules: Module[];
}

const MODULE_AR: Record<Module, string> = {
  pos: "نقطة البيع", inventory: "المخزون", accounting: "المحاسبة", einvoicing: "الفوترة الإلكترونية",
  recipes: "الوصفات وتكلفة الكوب", pharmacy: "الصيدليات (التشغيلات)", assistant: "المساعد «ذهب»",
  van_sales: "المناديب «خُطى»", fraud_guard: "كاشف التلاعب", multi_branch: "تعدد الفروع", api: "الربط البرمجي",
  hr: "الموارد البشرية والرواتب",
};

/** During the trial a tenant gets the Pro plan; afterwards its paid plan (or Free). */
export async function entitlements(tx: Tx): Promise<Entitlements> {
  const r = await one<{
    plan: string; trial_ends_at: Date | null; status: string; effective: string; price_monthly: string;
    max_users: number; max_terminals: number; max_vans: number; modules: Module[];
  }>(
    tx,
    `SELECT t.plan, t.trial_ends_at, t.status, p.code AS effective, p.price_monthly, p.max_users, p.max_terminals, p.max_vans, p.modules
       FROM tenants t
       JOIN plans p ON p.code = CASE WHEN t.trial_ends_at > now() AND t.plan = 'free' THEN 'pro' ELSE t.plan END`,
  );
  return {
    plan: r.plan,
    effectivePlan: r.effective,
    onTrial: r.effective !== r.plan,
    trialEndsAt: r.trial_ends_at ? r.trial_ends_at.toISOString() : null,
    status: r.status,
    priceMonthly: Number(r.price_monthly).toFixed(2),
    limits: { users: r.max_users, terminals: r.max_terminals, vans: r.max_vans },
    modules: r.modules,
  };
}

export async function requireModule(tx: Tx, module: Module): Promise<void> {
  const e = await entitlements(tx);
  if (e.status === "suspended") throw new PlanError("الحساب موقوف — جدّد الاشتراك للمتابعة");
  if (!e.modules.includes(module)) {
    throw new PlanError(`ميزة «${MODULE_AR[module]}» غير متاحة في باقتك الحالية — رقِّ باقتك لتفعيلها`, module === "fraud_guard" ? "pro" : "growth");
  }
}

export async function requireCapacity(tx: Tx, kind: "users" | "terminals" | "vans"): Promise<void> {
  const e = await entitlements(tx);
  const sql = {
    users: "SELECT count(*)::int AS n FROM users WHERE active",
    terminals: "SELECT count(*)::int AS n FROM pos_terminals",
    vans: "SELECT count(*)::int AS n FROM van_assignments",
  }[kind];
  const { n } = await one<{ n: number }>(tx, sql);
  if (n >= e.limits[kind]) {
    const label = { users: "المستخدمين", terminals: "نقاط البيع", vans: "سيارات المناديب" }[kind];
    throw new PlanError(`وصلت للحد الأقصى من ${label} في باقتك (${e.limits[kind]}) — رقِّ باقتك لإضافة المزيد`);
  }
}
