import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { Money } from "@mithqal/money";
import { entitlements, PlanError, requireCapacity, requireModule, type Module } from "./services/licensing.js";
import { BusinessError, maybeOne, withTenant, type Db } from "./db.js";
import { audit, type Actor } from "./services/core.js";
import { onboard } from "./services/onboarding.js";
import { receiveGoods } from "./services/inventory.js";
import { createSale, getInvoice, refundSale } from "./services/sales.js";
import { dailySummary, expiringBatches, trialBalance, vatSummary } from "./services/reports.js";
import { ask, cashierInsights } from "./services/assistant.js";
import {
  approvePurchaseOrder, createPurchaseOrder, getPurchaseOrder, paySupplier, receivePurchaseOrder, reorderSuggestions, supplierBalance,
} from "./services/purchasing.js";
import { checkIn, checkOut, collect, customerBalance, setupVan, todaysRoute, transferStock, vanOf, vanSettlement } from "./services/van.js";

type Role = "owner" | "accountant" | "cashier" | "storekeeper" | "sales_rep";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; tid: string; role: Role };
    user: { sub: string; tid: string; role: Role };
  }
}

const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "amount must be a decimal string");
const qty = z.string().regex(/^\d+(\.\d{1,4})?$/, "quantity must be a positive decimal string");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const schemas = {
  onboarding: z.object({
    businessNameAr: z.string().min(2),
    businessNameEn: z.string().optional(),
    country: z.enum(["SA", "EG"]),
    industry: z.enum(["retail", "cafe", "restaurant", "pharmacy", "distribution", "services"]),
    vatNumber: z.string().optional(),
    crNumber: z.string().optional(),
    address: z.object({ street: z.string(), buildingNumber: z.string(), district: z.string(), city: z.string(), postalCode: z.string() }).optional(),
    branchName: z.string().optional(),
    owner: z.object({ fullName: z.string().min(2), email: z.string().email(), password: z.string().min(8) }),
  }),
  login: z.object({ email: z.string().email(), password: z.string() }),
  item: z.object({
    sku: z.string().min(1),
    barcode: z.string().optional(),
    nameAr: z.string().min(1),
    nameEn: z.string().optional(),
    category: z.string().optional(),
    price: money,
    taxPercent: money.optional(),
    trackStock: z.boolean().default(true),
    trackBatches: z.boolean().default(false),
    reorderLevel: qty.default("0"),
    unit: z.enum(["pcs", "g", "kg", "ml", "l", "box", "strip", "carton"]).default("pcs"),
  }),
  receipt: z.object({
    warehouseId: z.string().uuid(),
    reference: z.string().min(1),
    paidCash: z.boolean().optional(),
    date: date.optional(),
    lines: z.array(z.object({ itemId: z.string().uuid(), quantity: qty, unitCost: money, batchNo: z.string().optional(), expiryDate: date.optional() })).min(1),
  }),
  sale: z.object({
    clientUuid: z.string().uuid(),
    terminalId: z.string().uuid(),
    issuedAt: z.string().datetime().optional(),
    customerId: z.string().uuid().optional(),
    lines: z.array(z.object({ itemId: z.string().uuid(), quantity: qty, unitPrice: money.optional(), discount: money.optional() })).min(1).max(500),
    payments: z.array(z.object({ method: z.enum(["CASH", "CARD", "CREDIT"]), amount: money })).min(1),
  }),
  refund: z.object({ clientUuid: z.string().uuid(), reason: z.string().min(2), method: z.enum(["CASH", "CARD", "CREDIT"]).optional() }),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    vatNumber: z.string().regex(/^3\d{13}3$/, "رقم ضريبي غير صحيح").optional(),
    crNumber: z.string().optional(),
    address: z.object({ street: z.string(), buildingNumber: z.string(), district: z.string(), city: z.string(), postalCode: z.string() }).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    creditLimit: money.optional(),
    routeDay: z.number().int().min(0).max(6).optional(),
  }),
  period: z.object({ from: date, to: date }),
};

export function buildApp(db: Db, config: Config, platformDb?: Db): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(cors, { origin: true });
  app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: "12h" } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "VALIDATION", issues: err.issues });
    const code = (err as { statusCode?: number }).statusCode;
    if (err instanceof PlanError) {
      return reply.status(402).send({ error: "PLAN_LIMIT", message: err.message, upgradeTo: err.upgradeTo ?? null });
    }
    if (err instanceof BusinessError || code === 404 || code === 401 || code === 403) {
      return reply.status(code ?? 422).send({ error: err.name, message: err.message });
    }
    const pg = err as { code?: string; message: string };
    if (pg.code === "23505") return reply.status(409).send({ error: "CONFLICT", message: "Duplicate record" });
    app.log.error(err);
    return reply.status(500).send({ error: "INTERNAL", message: "Unexpected error" });
  });

  const auth = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "سجّل الدخول أولًا" });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "ليس لديك صلاحية لهذه العملية" });
    }
  };
  const actorOf = (req: FastifyRequest): Actor => ({ userId: req.user.sub, tenantId: req.user.tid, role: req.user.role });
  const T = <R>(req: FastifyRequest, fn: Parameters<typeof withTenant<R>>[2]) => withTenant<R>(db, req.user.tid, fn);
  const today = () => new Date().toISOString().slice(0, 10);
  /** Tenant transaction that first checks the plan includes `module`. */
  const TM = <R>(req: FastifyRequest, module: Module, fn: Parameters<typeof withTenant<R>>[2]) =>
    withTenant<R>(db, req.user.tid, async (tx) => {
      await requireModule(tx, module);
      return fn(tx);
    });

  app.get("/health", async () => ({ ok: true, service: "mithqal-api", time: new Date().toISOString() }));

  // ───── Onboarding & auth ─────
  app.post("/v1/onboarding", async (req, reply) => {
    const input = schemas.onboarding.parse(req.body);
    const r = await onboard(db, input);
    const token = app.jwt.sign({ sub: r.userId, tid: r.tenantId, role: "owner" });
    return reply.status(201).send({ ...r, token });
  });

  const failures = new Map<string, { count: number; until: number }>();
  app.post("/v1/auth/login", async (req, reply) => {
    const { email, password } = schemas.login.parse(req.body);
    const key = `${email.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= 5 && f.until > Date.now()) {
      return reply.status(429).send({ error: "TOO_MANY_ATTEMPTS", message: "محاولات كثيرة — حاول بعد 15 دقيقة" });
    }
    const u = await maybeOne<{ user_id: string; tenant_id: string; password_hash: string; role: Role; full_name: string }>(
      db, "SELECT * FROM auth_lookup($1)", [email.toLowerCase()],
    );
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      const prev = failures.get(key);
      const count = prev && prev.until > Date.now() ? prev.count + 1 : 1;
      if (failures.size > 10_000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
      failures.set(key, { count, until: Date.now() + 15 * 60_000 });
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "بيانات الدخول غير صحيحة" });
    }
    failures.delete(key);
    return { token: app.jwt.sign({ sub: u.user_id, tid: u.tenant_id, role: u.role }), user: { id: u.user_id, fullName: u.full_name, role: u.role } };
  });

  app.get("/v1/me", { preHandler: auth() }, async (req) =>
    T(req, async (tx) => {
      const company = await tx.query("SELECT name_ar, name_en, vat_number, currency, vat_percent, industry, prices_include_tax FROM companies LIMIT 1");
      const terminals = await tx.query("SELECT id, name, prefix, warehouse_id, branch_id FROM pos_terminals ORDER BY prefix");
      const warehouses = await tx.query("SELECT id, name, branch_id FROM warehouses ORDER BY name");
      return { user: req.user, company: company.rows[0], terminals: terminals.rows, warehouses: warehouses.rows };
    }),
  );

  // ───── Subscription ─────
  app.get("/v1/subscription", { preHandler: auth("owner") }, async (req) =>
    T(req, async (tx) => {
      const e = await entitlements(tx);
      const usage = (await tx.query<{ users: number; terminals: number; vans: number }>(
        `SELECT (SELECT count(*)::int FROM users WHERE active) AS users, (SELECT count(*)::int FROM pos_terminals) AS terminals,
                (SELECT count(*)::int FROM van_assignments) AS vans`,
      )).rows[0];
      const plans = (await tx.query("SELECT code, name_ar, name_en, price_monthly, max_users, max_terminals, max_vans, modules FROM plans ORDER BY price_monthly, code")).rows;
      return { ...e, usage, plans };
    }),
  );

  // ───── Platform admin (Mithqal operator only) ─────
  const platform = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["x-platform-key"];
    const ok =
      typeof key === "string" && config.platformKey.length > 0 && key.length === config.platformKey.length &&
      timingSafeEqual(Buffer.from(key), Buffer.from(config.platformKey));
    if (!platformDb || !ok) {
      return reply.status(404).send({ error: "NOT_FOUND", message: "Not found" });
    }
  };
  app.get("/v1/platform/tenants", { preHandler: platform }, async () => {
    const r = await platformDb!.query(
      `SELECT t.id, t.name, t.country, t.plan, t.status, t.trial_ends_at, t.created_at, c.industry,
              (SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id) AS users,
              (SELECT count(*)::int FROM sales_invoices i WHERE i.tenant_id=t.id AND i.issued_at > now() - interval '30 days') AS invoices_30d,
              p.price_monthly
         FROM tenants t JOIN plans p ON p.code=t.plan LEFT JOIN companies c ON c.tenant_id=t.id
        ORDER BY t.created_at DESC`,
    );
    const mrr = r.rows.filter((x) => x.status === "active").reduce((s, x) => s.add(x.price_monthly), Money.zero());
    return {
      tenants: r.rows.length,
      payingTenants: r.rows.filter((x) => Number(x.price_monthly) > 0 && x.status === "active").length,
      onTrial: r.rows.filter((x) => x.trial_ends_at && new Date(x.trial_ends_at) > new Date()).length,
      mrrSar: mrr.toFixed(2),
      rows: r.rows,
    };
  });
  app.post("/v1/platform/tenants/:id/plan", { preHandler: platform }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ plan: z.enum(["free", "growth", "pro", "enterprise"]).optional(), status: z.enum(["active", "past_due", "suspended"]).optional(), endTrial: z.boolean().optional() }).parse(req.body);
    const r = await platformDb!.query(
      `UPDATE tenants SET plan = coalesce($2, plan), status = coalesce($3, status),
              trial_ends_at = CASE WHEN $4 THEN now() ELSE trial_ends_at END
        WHERE id=$1 RETURNING id, plan, status, trial_ends_at`,
      [id, b.plan ?? null, b.status ?? null, b.endTrial ?? false],
    );
    if (!r.rowCount) throw new BusinessError("Tenant not found");
    return r.rows[0];
  });

  // ───── Users (owner manages staff) ─────
  app.post("/v1/users", { preHandler: auth("owner") }, async (req, reply) => {
    const u = z
      .object({
        fullName: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(8),
        role: z.enum(["accountant", "cashier", "storekeeper", "sales_rep"]),
      })
      .parse(req.body);
    const exists = await db.query("SELECT 1 FROM auth_lookup($1)", [u.email.toLowerCase()]);
    if (exists.rowCount) throw new BusinessError("البريد الإلكتروني مسجل بالفعل");
    const hash = await bcrypt.hash(u.password, 10);
    const row = await T(req, async (tx) => {
      await requireCapacity(tx, "users");
      if (u.role === "sales_rep") await requireModule(tx, "van_sales");
      const r = await tx.query<{ id: string }>(
        "INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [req.user.tid, u.email.toLowerCase(), hash, u.fullName, u.role],
      );
      await audit(tx, actorOf(req), "user.created", "user", r.rows[0]!.id, { role: u.role });
      return { id: r.rows[0]!.id, email: u.email.toLowerCase(), fullName: u.fullName, role: u.role };
    });
    return reply.status(201).send(row);
  });

  // ───── Catalog ─────
  app.get("/v1/items", { preHandler: auth() }, async (req) => {
    const q = (req.query as { q?: string }).q ?? "";
    return T(req, async (tx) =>
      (await tx.query(
        `SELECT i.*, coalesce(sum(b.quantity),0) AS on_hand FROM items i LEFT JOIN stock_balances b ON b.item_id = i.id
          WHERE i.active AND ($1 = '' OR i.name_ar ILIKE '%'||$1||'%' OR i.name_en ILIKE '%'||$1||'%' OR i.sku = $1 OR i.barcode = $1)
          GROUP BY i.id ORDER BY i.category NULLS LAST, i.name_ar LIMIT 500`,
        [q],
      )).rows,
    );
  });

  app.post("/v1/items", { preHandler: auth("owner", "storekeeper") }, async (req, reply) => {
    const i = schemas.item.parse(req.body);
    const row = await T(req, async (tx) => {
      if (i.trackBatches) await requireModule(tx, "pharmacy");
      const company = await tx.query<{ vat_percent: string }>("SELECT vat_percent FROM companies LIMIT 1");
      const r = await tx.query(
        `INSERT INTO items (tenant_id, sku, barcode, name_ar, name_en, category, price, tax_percent, track_stock, track_batches, reorder_level, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.user.tid, i.sku, i.barcode ?? null, i.nameAr, i.nameEn ?? null, i.category ?? null, i.price, i.taxPercent ?? company.rows[0]!.vat_percent,
          i.trackStock, i.trackBatches, i.reorderLevel, i.unit],
      );
      await audit(tx, actorOf(req), "item.created", "item", r.rows[0].id, { sku: i.sku });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ───── F&B: recipes & live menu costing ─────
  app.put("/v1/items/:id/recipe", { preHandler: auth("owner") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: qty })).max(50) }).parse(req.body);
    return TM(req, "recipes", async (tx) => {
      const item = await maybeOne<{ track_stock: boolean }>(tx, "SELECT track_stock FROM items WHERE id=$1", [id]);
      if (!item) throw new BusinessError("الصنف غير موجود");
      if (item.track_stock) throw new BusinessError("الوصفة لأصناف المنيو فقط (أصناف لا يُتابع مخزونها مباشرة)");
      for (const l of b.lines) {
        const ing = await maybeOne<{ track_stock: boolean }>(tx, "SELECT track_stock FROM items WHERE id=$1", [l.ingredientId]);
        if (!ing?.track_stock) throw new BusinessError("مكوّن الوصفة يجب أن يكون صنفًا مخزنيًا");
        if (Number(l.quantity) <= 0) throw new BusinessError("كمية المكوّن يجب أن تكون أكبر من صفر");
      }
      await tx.query("DELETE FROM recipe_lines WHERE item_id=$1", [id]);
      for (const l of b.lines) {
        await tx.query("INSERT INTO recipe_lines (tenant_id, item_id, ingredient_id, quantity) VALUES ($1,$2,$3,$4)", [req.user.tid, id, l.ingredientId, l.quantity]);
      }
      await audit(tx, actorOf(req), "recipe.updated", "item", id, b);
      return { itemId: id, lines: b.lines.length };
    });
  });

  app.get("/v1/reports/menu-costing", { preHandler: auth("owner", "accountant") }, async (req) => {
    const { targetMargin } = z.object({ targetMargin: z.coerce.number().min(0).max(100).default(65) }).parse(req.query);
    return T(req, async (tx) => {
      const rows = (await tx.query<{ id: string; name_ar: string; price: string; tax_percent: string; cost: string }>(
        `SELECT i.id, i.name_ar, i.price, i.tax_percent,
                sum(r.quantity * coalesce((SELECT sum(b.quantity*b.average_cost)/nullif(sum(b.quantity),0)
                                             FROM stock_balances b WHERE b.item_id=r.ingredient_id AND b.quantity > 0), 0)) AS cost
           FROM items i JOIN recipe_lines r ON r.item_id = i.id
          GROUP BY i.id ORDER BY i.name_ar`,
      )).rows;
      const company = await tx.query<{ prices_include_tax: boolean }>("SELECT prices_include_tax FROM companies LIMIT 1");
      const inclusive = company.rows[0]!.prices_include_tax;
      return rows.map((r) => {
        const net = inclusive ? Money.of(r.price).div(Money.of(1).add(Money.of(r.tax_percent).div(100))) : Money.of(r.price);
        const cost = Money.of(r.cost);
        const margin = net.isZero() ? Money.zero() : net.sub(cost).div(net).mul(100);
        // price needed (incl. VAT) to hit the target margin
        const neededNet = cost.div(Money.of(1).sub(Money.of(targetMargin).div(100)));
        const neededGross = inclusive ? neededNet.mul(Money.of(1).add(Money.of(r.tax_percent).div(100))) : neededNet;
        return {
          itemId: r.id,
          name: r.name_ar,
          price: Money.of(r.price).toFixed(2),
          costPerUnit: cost.toFixed(2),
          marginPercent: margin.toFixed(1),
          belowTarget: margin.lt(targetMargin),
          suggestedPrice: margin.lt(targetMargin) ? neededGross.toFixed(2) : null,
        };
      });
    });
  });

  // ───── Customers ─────
  app.post("/v1/customers", { preHandler: auth() }, async (req, reply) => {
    const c = schemas.customer.parse(req.body);
    if (c.creditLimit && req.user.role !== "owner" && Number(c.creditLimit) > 0) {
      throw new BusinessError("تحديد حد الائتمان من صلاحية المالك فقط");
    }
    const a = c.address;
    const row = await T(req, async (tx) => {
      const r = await tx.query(
        `INSERT INTO customers (tenant_id, name, phone, vat_number, cr_number, street, building_number, district, city, postal_code, country,
                                latitude, longitude, credit_limit, route_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SA',$11,$12,$13,$14) RETURNING *`,
        [req.user.tid, c.name, c.phone ?? null, c.vatNumber ?? null, c.crNumber ?? null, a?.street ?? null, a?.buildingNumber ?? null,
          a?.district ?? null, a?.city ?? null, a?.postalCode ?? null, c.latitude ?? null, c.longitude ?? null, c.creditLimit ?? "0", c.routeDay ?? null],
      );
      await audit(tx, actorOf(req), "customer.created", "customer", r.rows[0].id, { name: c.name });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.get("/v1/customers", { preHandler: auth() }, async (req) =>
    T(req, async (tx) => {
      const rows = (await tx.query("SELECT id, name, phone, vat_number, credit_limit, latitude, longitude, route_day FROM customers ORDER BY name LIMIT 1000")).rows;
      return Promise.all(rows.map(async (r) => ({ ...r, balance: (await customerBalance(tx, r.id)).toFixed(2) })));
    }),
  );

  // ───── Van sales / field force ("Mithqal Khuta") ─────
  app.post("/v1/van/assign", { preHandler: auth("owner") }, async (req, reply) => {
    const b = z.object({ userId: z.string().uuid(), vehiclePlate: z.string().optional() }).parse(req.body);
    return reply.status(201).send(await T(req, (tx) => setupVan(tx, actorOf(req), b)));
  });

  app.post("/v1/inventory/transfers", { preHandler: auth("owner", "storekeeper") }, async (req, reply) => {
    const b = z
      .object({
        fromWarehouseId: z.string().uuid(),
        toWarehouseId: z.string().uuid(),
        reference: z.string().optional(),
        lines: z.array(z.object({ itemId: z.string().uuid(), quantity: qty })).min(1),
      })
      .parse(req.body);
    return reply.status(201).send(await TM(req, "inventory", (tx) => transferStock(tx, actorOf(req), b)));
  });

  app.get("/v1/van/me", { preHandler: auth("sales_rep") }, async (req) =>
    T(req, async (tx) => {
      const v = await vanOf(tx, req.user.sub);
      const stock = await tx.query(
        `SELECT i.id AS item_id, i.name_ar, i.price, b.quantity FROM stock_balances b JOIN items i ON i.id=b.item_id
          WHERE b.warehouse_id=$1 AND b.quantity > 0 ORDER BY i.name_ar`,
        [v.warehouse_id],
      );
      return { ...v, stock: stock.rows };
    }),
  );

  app.get("/v1/van/route", { preHandler: auth("sales_rep", "owner") }, async (req) => {
    const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), day: date.optional() }).parse(req.query);
    return TM(req, "van_sales", (tx) => todaysRoute(tx, { lat: q.lat, lng: q.lng }, q.day ? new Date(`${q.day}T12:00:00Z`) : new Date()));
  });

  app.post("/v1/van/visits", { preHandler: auth("sales_rep") }, async (req, reply) => {
    const b = z.object({ customerId: z.string().uuid(), lat: z.number(), lng: z.number() }).parse(req.body);
    return reply.status(201).send(await TM(req, "van_sales", (tx) => checkIn(tx, actorOf(req), b)));
  });

  app.post("/v1/van/visits/:id/checkout", { preHandler: auth("sales_rep") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ outcome: z.enum(["SOLD", "COLLECTED", "NO_ORDER", "CLOSED", "OTHER"]), note: z.string().optional() }).parse(req.body);
    return T(req, (tx) => checkOut(tx, actorOf(req), { visitId: id, ...b }));
  });

  app.post("/v1/collections", { preHandler: auth("sales_rep", "owner", "accountant", "cashier") }, async (req, reply) => {
    const b = z
      .object({
        clientUuid: z.string().uuid(),
        customerId: z.string().uuid(),
        method: z.enum(["CASH", "CARD", "BANK_TRANSFER", "CHEQUE"]),
        amount: money,
        reference: z.string().optional(),
        visitId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const out = await T(req, (tx) => collect(tx, actorOf(req), b));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  app.get("/v1/van/settlement", { preHandler: auth("sales_rep", "owner") }, async (req) => {
    const q = z.object({ userId: z.string().uuid().optional(), day: date.optional() }).parse(req.query);
    const userId = req.user.role === "sales_rep" ? req.user.sub : q.userId;
    if (!userId) throw new BusinessError("حدد المندوب");
    return T(req, (tx) => vanSettlement(tx, userId, q.day ?? today()));
  });

  // ───── Purchasing ─────
  app.post("/v1/suppliers", { preHandler: auth("owner", "storekeeper", "accountant") }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1), phone: z.string().optional(), vatNumber: z.string().optional(), paymentTermsDays: z.number().int().min(0).max(365).default(30) }).parse(req.body);
    const row = await T(req, async (tx) =>
      (await tx.query("INSERT INTO suppliers (tenant_id, name, phone, vat_number, payment_terms_days) VALUES ($1,$2,$3,$4,$5) RETURNING *", [
        req.user.tid, b.name, b.phone ?? null, b.vatNumber ?? null, b.paymentTermsDays,
      ])).rows[0],
    );
    return reply.status(201).send(row);
  });

  app.get("/v1/suppliers", { preHandler: auth("owner", "storekeeper", "accountant") }, async (req) =>
    T(req, async (tx) => {
      const rows = (await tx.query("SELECT id, name, phone, vat_number, payment_terms_days FROM suppliers ORDER BY name")).rows;
      return Promise.all(rows.map(async (r) => ({ ...r, balance: (await supplierBalance(tx, r.id)).toFixed(2) })));
    }),
  );

  app.get("/v1/purchasing/suggestions", { preHandler: auth("owner", "storekeeper") }, async (req) => {
    const { warehouseId } = z.object({ warehouseId: z.string().uuid() }).parse(req.query);
    return T(req, (tx) => reorderSuggestions(tx, warehouseId));
  });

  app.post("/v1/purchasing/orders", { preHandler: auth("owner", "storekeeper") }, async (req, reply) => {
    const b = z
      .object({
        supplierId: z.string().uuid(),
        warehouseId: z.string().uuid(),
        note: z.string().optional(),
        lines: z.array(z.object({ itemId: z.string().uuid(), quantity: qty, unitCost: money })).min(1),
      })
      .parse(req.body);
    return reply.status(201).send(await T(req, (tx) => createPurchaseOrder(tx, actorOf(req), b)));
  });

  app.get("/v1/purchasing/orders/:id", { preHandler: auth("owner", "storekeeper", "accountant") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return T(req, (tx) => getPurchaseOrder(tx, id));
  });

  app.post("/v1/purchasing/orders/:id/approve", { preHandler: auth("owner") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return T(req, (tx) => approvePurchaseOrder(tx, actorOf(req), id));
  });

  app.post("/v1/purchasing/orders/:id/receive", { preHandler: auth("owner", "storekeeper") }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        reference: z.string().min(1),
        lines: z.array(z.object({ itemId: z.string().uuid(), quantity: qty, batchNo: z.string().optional(), expiryDate: date.optional() })).min(1),
      })
      .parse(req.body);
    return reply.status(201).send(await T(req, (tx) => receivePurchaseOrder(tx, actorOf(req), id, b)));
  });

  app.post("/v1/suppliers/:id/payments", { preHandler: auth("owner", "accountant") }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ clientUuid: z.string().uuid(), method: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE"]), amount: money, reference: z.string().optional() }).parse(req.body);
    const out = await T(req, (tx) => paySupplier(tx, actorOf(req), { supplierId: id, ...b }));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  // ───── Inventory ─────
  app.post("/v1/inventory/receipts", { preHandler: auth("owner", "storekeeper", "accountant") }, async (req, reply) => {
    const r = schemas.receipt.parse(req.body);
    const out = await T(req, (tx) => receiveGoods(tx, actorOf(req), { ...r, date: r.date ?? today() }));
    return reply.status(201).send(out);
  });

  app.get("/v1/inventory/stock", { preHandler: auth() }, async (req) =>
    T(req, async (tx) =>
      (await tx.query(
        `SELECT i.id AS item_id, i.sku, i.name_ar, w.name AS warehouse, b.quantity, b.average_cost, (b.quantity * b.average_cost) AS value
           FROM stock_balances b JOIN items i ON i.id=b.item_id JOIN warehouses w ON w.id=b.warehouse_id ORDER BY i.name_ar`,
      )).rows,
    ),
  );

  // ───── POS ─────
  app.post("/v1/pos/sales", { preHandler: auth("owner", "cashier", "sales_rep") }, async (req, reply) => {
    const s = schemas.sale.parse(req.body);
    const out = await T(req, (tx) => createSale(tx, actorOf(req), s));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  app.post("/v1/pos/sales/:id/refund", { preHandler: auth("owner", "cashier") }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = schemas.refund.parse(req.body);
    const out = await T(req, (tx) => refundSale(tx, actorOf(req), { invoiceId: id, ...r }));
    return reply.status(out.replayed ? 200 : 201).send(out);
  });

  app.get("/v1/sales/:id", { preHandler: auth() }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return T(req, (tx) => getInvoice(tx, id));
  });

  app.get("/v1/sales", { preHandler: auth() }, async (req) => {
    const { day } = z.object({ day: date.optional() }).parse(req.query);
    return T(req, async (tx) =>
      (await tx.query(
        `SELECT i.id, i.number, i.doc_type, i.total_gross, i.issued_at, e.status AS einvoice_status
           FROM sales_invoices i LEFT JOIN e_invoice_documents e ON e.invoice_id = i.id
          WHERE i.issued_at::date = $1 ORDER BY i.issued_at DESC LIMIT 200`,
        [day ?? today()],
      )).rows,
    );
  });

  // ───── Reports ─────
  app.get("/v1/reports/daily", { preHandler: auth("owner", "accountant") }, async (req) => {
    const { day } = z.object({ day: date.optional() }).parse(req.query);
    return T(req, (tx) => dailySummary(tx, day ?? today()));
  });
  app.get("/v1/reports/trial-balance", { preHandler: auth("owner", "accountant") }, async (req) => {
    const p = schemas.period.parse(req.query);
    return T(req, (tx) => trialBalance(tx, p.from, p.to));
  });
  app.get("/v1/reports/vat", { preHandler: auth("owner", "accountant") }, async (req) => {
    const p = schemas.period.parse(req.query);
    return T(req, (tx) => vatSummary(tx, p.from, p.to));
  });
  app.get("/v1/reports/expiring", { preHandler: auth("owner", "storekeeper") }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }).parse(req.query);
    return T(req, (tx) => expiringBatches(tx, today(), days));
  });

  // ───── AI assistant «ذهب» & insights ─────
  app.post("/v1/assistant/ask", { preHandler: auth("owner", "accountant") }, async (req) => {
    const { question } = z.object({ question: z.string().min(1).max(500) }).parse(req.body);
    return TM(req, "assistant", (tx) => ask(tx, question));
  });

  app.get("/v1/insights/cashiers", { preHandler: auth("owner") }, async (req) => {
    const { day } = z.object({ day: date.optional() }).parse(req.query);
    return TM(req, "fraud_guard", (tx) => cashierInsights(tx, day ?? today()));
  });

  // ───── Compliance ─────
  app.get("/v1/einvoices", { preHandler: auth("owner", "accountant") }, async (req) => {
    const { status } = z.object({ status: z.enum(["PENDING", "ACCEPTED", "WARNING", "REJECTED"]).optional() }).parse(req.query);
    return T(req, async (tx) =>
      (await tx.query(
        `SELECT e.invoice_id, i.number, e.icv, e.status, e.attempts, e.last_error, e.submitted_at
           FROM e_invoice_documents e JOIN sales_invoices i ON i.id = e.invoice_id
          WHERE ($1::text IS NULL OR e.status = $1) ORDER BY e.created_at DESC LIMIT 200`,
        [status ?? null],
      )).rows,
    );
  });

  app.get("/v1/audit/verify", { preHandler: auth("owner") }, async (req) =>
    T(req, async (tx) => {
      const rows = (await tx.query<{ id: string; prev_hash: string; hash: string }>("SELECT id, prev_hash, hash FROM audit_logs ORDER BY id")).rows;
      let prev = "GENESIS";
      for (const r of rows) {
        if (r.prev_hash !== prev) return { intact: false, brokenAt: r.id };
        prev = r.hash;
      }
      return { intact: true, entries: rows.length };
    }),
  );

  return app;
}
