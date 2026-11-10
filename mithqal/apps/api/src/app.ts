import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { BusinessError, maybeOne, withTenant, type Db } from "./db.js";
import { audit, type Actor } from "./services/core.js";
import { onboard } from "./services/onboarding.js";
import { receiveGoods } from "./services/inventory.js";
import { createSale, getInvoice, refundSale } from "./services/sales.js";
import { dailySummary, expiringBatches, trialBalance, vatSummary } from "./services/reports.js";
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
    country: z.literal("SA"),
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

export function buildApp(db: Db, config: Config): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(cors, { origin: true });
  app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: "12h" } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "VALIDATION", issues: err.issues });
    const code = (err as { statusCode?: number }).statusCode;
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

  app.get("/health", async () => ({ ok: true, service: "mithqal-api", time: new Date().toISOString() }));

  // ───── Onboarding & auth ─────
  app.post("/v1/onboarding", async (req, reply) => {
    const input = schemas.onboarding.parse(req.body);
    const r = await onboard(db, input);
    const token = app.jwt.sign({ sub: r.userId, tid: r.tenantId, role: "owner" });
    return reply.status(201).send({ ...r, token });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const { email, password } = schemas.login.parse(req.body);
    const u = await maybeOne<{ user_id: string; tenant_id: string; password_hash: string; role: Role; full_name: string }>(
      db, "SELECT * FROM auth_lookup($1)", [email.toLowerCase()],
    );
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "بيانات الدخول غير صحيحة" });
    }
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
      const company = await tx.query<{ vat_percent: string }>("SELECT vat_percent FROM companies LIMIT 1");
      const r = await tx.query(
        `INSERT INTO items (tenant_id, sku, barcode, name_ar, name_en, category, price, tax_percent, track_stock, track_batches, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.user.tid, i.sku, i.barcode ?? null, i.nameAr, i.nameEn ?? null, i.category ?? null, i.price, i.taxPercent ?? company.rows[0]!.vat_percent,
          i.trackStock, i.trackBatches, i.reorderLevel],
      );
      await audit(tx, actorOf(req), "item.created", "item", r.rows[0].id, { sku: i.sku });
      return r.rows[0];
    });
    return reply.status(201).send(row);
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
    return reply.status(201).send(await T(req, (tx) => transferStock(tx, actorOf(req), b)));
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
    return T(req, (tx) => todaysRoute(tx, { lat: q.lat, lng: q.lng }, q.day ? new Date(`${q.day}T12:00:00Z`) : new Date()));
  });

  app.post("/v1/van/visits", { preHandler: auth("sales_rep") }, async (req, reply) => {
    const b = z.object({ customerId: z.string().uuid(), lat: z.number(), lng: z.number() }).parse(req.body);
    return reply.status(201).send(await T(req, (tx) => checkIn(tx, actorOf(req), b)));
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
