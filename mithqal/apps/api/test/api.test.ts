import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { decodeTlv, verifyInvoiceHash, INITIAL_PIH } from "@mithqal/zatca";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, withTenant, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { MockZatcaClient, reportPending } from "../src/services/einvoice-worker.js";

process.env.NODE_ENV = "test";
const config = loadConfig({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? "mithqal_test" });
let db: Db;
let ownerDb: Db;
let app: FastifyInstance;

const cafe = {
  businessNameAr: "مقهى مثقال",
  businessNameEn: "Mithqal Cafe",
  country: "SA",
  industry: "cafe",
  vatNumber: "310122393500003",
  crNumber: "1010010000",
  address: { street: "طريق الملك فهد", buildingNumber: "1234", district: "العليا", city: "الرياض", postalCode: "12211" },
  owner: { fullName: "مالك المقهى", email: "owner@cafe.test", password: "StrongPass#1" },
};

async function call(method: "GET" | "POST", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

let token: string;
let tenantId: string;
let terminalId: string;
let warehouseId: string;
let latte: any;
let croissant: any;
let firstSale: any;

beforeAll(async () => {
  await migrate(config.migrationUrl, { reset: true });
  db = createPool(config.appUrl);
  ownerDb = createPool(config.migrationUrl);
  app = buildApp(db, config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.end();
  await ownerDb.end();
});

describe("onboarding & auth", () => {
  it("onboards a café in one call", async () => {
    const r = await call("POST", "/v1/onboarding", undefined, cafe);
    expect(r.status).toBe(201);
    ({ token, tenantId, terminalId, warehouseId } = r.body);
    expect(token).toBeTruthy();
  });

  it("rejects an invalid KSA VAT number", async () => {
    const r = await call("POST", "/v1/onboarding", undefined, { ...cafe, vatNumber: "123", owner: { ...cafe.owner, email: "x@y.test" } });
    expect(r.status).toBe(422);
  });

  it("logs in and rejects wrong passwords", async () => {
    expect((await call("POST", "/v1/auth/login", undefined, { email: cafe.owner.email, password: cafe.owner.password })).status).toBe(200);
    expect((await call("POST", "/v1/auth/login", undefined, { email: cafe.owner.email, password: "nope" })).status).toBe(401);
  });

  it("throttles repeated failed logins", async () => {
    for (let i = 0; i < 5; i++) await call("POST", "/v1/auth/login", undefined, { email: "victim@cafe.test", password: "guess" + i });
    const r = await call("POST", "/v1/auth/login", undefined, { email: "victim@cafe.test", password: "guess" });
    expect(r.status).toBe(429);
  });

  it("requires authentication", async () => {
    expect((await call("GET", "/v1/items")).status).toBe(401);
  });
});

describe("catalog & stock", () => {
  it("creates items with default 15% VAT", async () => {
    const a = await call("POST", "/v1/items", token, { sku: "LAT", barcode: "6281000000011", nameAr: "لاتيه", category: "قهوة", price: "17.00", reorderLevel: "5" });
    const b = await call("POST", "/v1/items", token, { sku: "CRO", nameAr: "كرواسون", category: "مخبوزات", price: "9.99" });
    expect(a.status).toBe(201);
    latte = a.body;
    croissant = b.body;
    expect(latte.tax_percent).toBe("15.00");
  });

  it("treats receipts without a supplier as opening stock (no VAT, no payable)", async () => {
    const extra = (await call("POST", "/v1/items", token, { sku: "OPEN1", nameAr: "صنف افتتاحي", price: "5.00" })).body;
    const r = await call("POST", "/v1/inventory/receipts", token, { warehouseId, reference: "رصيد افتتاحي", lines: [{ itemId: extra.id, quantity: "4", unitCost: "2.00" }] });
    expect(r.body.tax).toBe("0.00");
  });

  it("receives goods and posts inventory + input VAT", async () => {
    const supplier = (await call("POST", "/v1/suppliers", token, { name: "محمصة الرياض" })).body;
    const r = await call("POST", "/v1/inventory/receipts", token, {
      warehouseId, reference: "PO-1", supplierId: supplier.id,
      lines: [
        { itemId: latte.id, quantity: "20", unitCost: "5.00" },
        { itemId: croissant.id, quantity: "10", unitCost: "3.00" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.net).toBe("130.00");
    expect(r.body.tax).toBe("19.50");
  });
});

describe("POS sale → ledger → stock → ZATCA", () => {
  it("creates a split-payment simplified tax invoice", async () => {
    const r = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId,
      lines: [{ itemId: latte.id, quantity: "2" }, { itemId: croissant.id, quantity: "1" }],
      payments: [{ method: "CASH", amount: "20.00" }, { method: "CARD", amount: "23.99" }],
    });
    expect(r.status).toBe(201);
    firstSale = r.body;
    expect(firstSale.number).toBe("POS1-000001");
    expect(firstSale.total_gross).toBe("43.9900");
    expect(firstSale.eInvoice.icv).toBe("1");
    expect(firstSale.eInvoice.status).toBe("PENDING");

    const qr = decodeTlv(firstSale.eInvoice.qr);
    expect(qr.get(1)!.toString()).toBe("مقهى مثقال");
    expect(qr.get(2)!.toString()).toBe("310122393500003");
    expect(qr.get(4)!.toString()).toBe("43.99");
    expect(qr.get(5)!.toString()).toBe(firstSale.total_tax.slice(0, -2));
    expect(qr.get(6)!.toString()).toBe(firstSale.eInvoice.hash);
  });

  it("signature verifies against the terminal's public key and PIH starts the chain", async () => {
    const t = await withTenant(db, tenantId, async (tx) =>
      (await tx.query("SELECT public_key_pem FROM pos_terminals WHERE id=$1", [terminalId])).rows[0],
    );
    const doc = await withTenant(db, tenantId, async (tx) =>
      (await tx.query("SELECT pih, hash, signature, xml FROM e_invoice_documents WHERE invoice_id=$1", [firstSale.id])).rows[0],
    );
    expect(doc.pih).toBe(INITIAL_PIH);
    expect(verifyInvoiceHash(doc.hash, doc.signature, t.public_key_pem)).toBe(true);
    expect(doc.xml).toContain("<cbc:InvoiceTypeCode name=\"0200000\">388</cbc:InvoiceTypeCode>");
  });

  it("is idempotent for offline replays (same clientUuid)", async () => {
    const clientUuid = randomUUID();
    const body = { clientUuid, terminalId, lines: [{ itemId: latte.id, quantity: "1" }], payments: [{ method: "CASH", amount: "17.00" }] };
    const a = await call("POST", "/v1/pos/sales", token, body);
    const b = await call("POST", "/v1/pos/sales", token, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.replayed).toBe(true);
    expect(a.body.eInvoice.icv).toBe("2");
    const doc = await withTenant(db, tenantId, async (tx) =>
      (await tx.query("SELECT pih FROM e_invoice_documents WHERE invoice_id=$1", [a.body.id])).rows[0],
    );
    expect(doc.pih).toBe(firstSale.eInvoice.hash); // chain links to previous invoice
  });

  it("decrements stock once and costs at moving average", async () => {
    const r = await call("GET", "/v1/inventory/stock", token);
    const l = r.body.find((x: any) => x.item_id === latte.id);
    expect(l.quantity).toBe("17.0000"); // 20 - 2 - 1 (replay not double counted)
  });

  it("rejects payments that do not match the total", async () => {
    const r = await call("POST", "/v1/pos/sales", token, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: latte.id, quantity: "1" }], payments: [{ method: "CASH", amount: "10.00" }],
    });
    expect(r.status).toBe(422);
  });

  it("refunds as a credit note (381) and restocks", async () => {
    const r = await call("POST", `/v1/pos/sales/${firstSale.id}/refund`, token, { clientUuid: randomUUID(), reason: "طلب العميل" });
    expect(r.status).toBe(201);
    expect(r.body.doc_type).toBe("CREDIT_NOTE");
    expect(r.body.number).toBe("POS1-CN-000003");
    const again = await call("POST", `/v1/pos/sales/${firstSale.id}/refund`, token, { clientUuid: randomUUID(), reason: "مرة أخرى" });
    expect(again.status).toBe(422);
    const doc = await withTenant(db, tenantId, async (tx) =>
      (await tx.query("SELECT xml FROM e_invoice_documents WHERE invoice_id=$1", [r.body.id])).rows[0],
    );
    expect(doc.xml).toContain(">381</cbc:InvoiceTypeCode>");
    expect(doc.xml).toContain("<cbc:ID>POS1-000001</cbc:ID></cac:InvoiceDocumentReference>");
    const stock = await call("GET", "/v1/inventory/stock", token);
    expect(stock.body.find((x: any) => x.item_id === latte.id).quantity).toBe("19.0000");
  });
});

describe("reports", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("trial balance is balanced", async () => {
    const r = await call("GET", `/v1/reports/trial-balance?from=${today}&to=${today}`, token);
    expect(r.status).toBe(200);
    expect(r.body.balanced).toBe(true);
    expect(r.body.totalDebit).toBe(r.body.totalCredit);
  });

  it("VAT summary nets output (after credit note) against input VAT", async () => {
    const r = await call("GET", `/v1/reports/vat?from=${today}&to=${today}`, token);
    // only the 17.00 latte sale remains: VAT = 17 - 14.78 = 2.22
    expect(r.body.outputVat).toBe("2.22");
    expect(r.body.inputVat).toBe("19.50");
    expect(r.body.netVatDue).toBe("-17.28");
  });

  it("daily summary shows profit and payment mix", async () => {
    const r = await call("GET", `/v1/reports/daily?day=${today}`, token);
    expect(r.body.invoices).toBe(2);
    expect(r.body.creditNotes).toBe(1);
    expect(r.body.netSales).toBe("14.78");
    expect(r.body.costOfGoods).toBe("5.00");
    expect(r.body.grossProfit).toBe("9.78");
  });
});

describe("compliance worker", () => {
  it("reports pending e-invoices and marks them accepted", async () => {
    const r = await reportPending(ownerDb, new MockZatcaClient());
    expect(r.processed).toBe(3);
    const list = await call("GET", "/v1/einvoices?status=ACCEPTED", token);
    expect(list.body.length).toBe(3);
  });
});

describe("security & integrity", () => {
  it("isolates tenants with row-level security", async () => {
    const other = await call("POST", "/v1/onboarding", undefined, {
      ...cafe, businessNameAr: "صيدلية الشفاء", industry: "pharmacy", owner: { ...cafe.owner, email: "owner@pharmacy.test" },
    });
    const items = await call("GET", "/v1/items", other.body.token);
    expect(items.body).toEqual([]);
    const peek = await call("GET", `/v1/sales/${firstSale.id}`, other.body.token);
    expect(peek.status).toBe(404);
    // Without a tenant context the app role sees nothing at all
    const raw = await db.query("SELECT count(*)::int AS n FROM sales_invoices");
    expect(raw.rows[0].n).toBe(0);
  });

  it("enforces role permissions", async () => {
    const u = await call("POST", "/v1/users", token, { fullName: "كاشير", email: "cashier@cafe.test", password: "CashierPass#1", role: "cashier" });
    expect(u.status).toBe(201);
    const login = await call("POST", "/v1/auth/login", undefined, { email: "cashier@cafe.test", password: "CashierPass#1" });
    const ct = login.body.token;
    expect((await call("POST", "/v1/items", ct, { sku: "X", nameAr: "x", price: "1" })).status).toBe(403);
    expect((await call("GET", "/v1/reports/daily", ct)).status).toBe(403);
    const sale = await call("POST", "/v1/pos/sales", ct, {
      clientUuid: randomUUID(), terminalId, lines: [{ itemId: croissant.id, quantity: "1" }], payments: [{ method: "CARD", amount: "9.99" }],
    });
    expect(sale.status).toBe(201);
  });

  it("makes posted invoices and the ledger immutable in the database", async () => {
    await expect(
      withTenant(db, tenantId, (tx) => tx.query("UPDATE sales_invoices SET total_gross = 0 WHERE id=$1", [firstSale.id])),
    ).rejects.toThrow(/append-only/);
    await expect(withTenant(db, tenantId, (tx) => tx.query("DELETE FROM journal_lines"))).rejects.toThrow(/append-only/);
  });

  it("refuses an unbalanced journal at commit time", async () => {
    await expect(
      withTenant(db, tenantId, async (tx) => {
        const acc = (await tx.query("SELECT id FROM accounts WHERE role='CASH'")).rows[0];
        const e = (await tx.query("INSERT INTO journal_entries (tenant_id, entry_date, memo, source_type) VALUES ($1, current_date, 'bad', 'TEST') RETURNING id", [tenantId])).rows[0];
        await tx.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit) VALUES ($1,$2,$3,100)", [tenantId, e.id, acc.id]);
      }),
    ).rejects.toThrow(/not balanced/);
  });

  it("keeps an intact hash-chained audit log", async () => {
    const r = await call("GET", "/v1/audit/verify", token);
    expect(r.body.intact).toBe(true);
    expect(r.body.entries).toBeGreaterThan(5);
  });
});

describe("pharmacy: batches & FEFO", () => {
  let ptoken: string;
  let pwh: string;
  let pterm: string;
  let drug: any;

  it("sells from the earliest-expiring valid batch and never from expired stock", async () => {
    const login = await call("POST", "/v1/auth/login", undefined, { email: "owner@pharmacy.test", password: cafe.owner.password });
    ptoken = login.body.token;
    const me = await call("GET", "/v1/me", ptoken);
    pwh = me.body.warehouses[0].id;
    pterm = me.body.terminals[0].id;
    drug = (await call("POST", "/v1/items", ptoken, { sku: "PARA500", nameAr: "باراسيتامول 500 مجم", price: "12.00", taxPercent: "0", trackBatches: true })).body;

    const missingBatch = await call("POST", "/v1/inventory/receipts", ptoken, { warehouseId: pwh, reference: "PO-X", lines: [{ itemId: drug.id, quantity: "1", unitCost: "5" }] });
    expect(missingBatch.status).toBe(422);

    await call("POST", "/v1/inventory/receipts", ptoken, {
      warehouseId: pwh, reference: "PO-P1",
      lines: [
        { itemId: drug.id, quantity: "5", unitCost: "6.00", batchNo: "EXPIRED", expiryDate: "2020-01-01" },
        { itemId: drug.id, quantity: "3", unitCost: "6.00", batchNo: "SOON", expiryDate: "2099-01-01" },
        { itemId: drug.id, quantity: "10", unitCost: "6.00", batchNo: "LATER", expiryDate: "2099-12-31" },
      ],
    });
    const sale = await call("POST", "/v1/pos/sales", ptoken, {
      clientUuid: randomUUID(), terminalId: pterm, lines: [{ itemId: drug.id, quantity: "4" }], payments: [{ method: "CASH", amount: "48.00" }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.lines[0].tax_category).toBe("Z");
    const batches = await withTenant(db, sale.body.tenant_id, async (tx) =>
      (await tx.query("SELECT batch_no, quantity FROM item_batches ORDER BY batch_no")).rows,
    );
    expect(batches).toEqual([
      { batch_no: "EXPIRED", quantity: "5.0000" },
      { batch_no: "LATER", quantity: "9.0000" },
      { batch_no: "SOON", quantity: "0.0000" },
    ]);
    const tooMuch = await call("POST", "/v1/pos/sales", ptoken, {
      clientUuid: randomUUID(), terminalId: pterm, lines: [{ itemId: drug.id, quantity: "10" }], payments: [{ method: "CASH", amount: "120.00" }],
    });
    expect(tooMuch.status).toBe(422);

    const exp = await call("GET", "/v1/reports/expiring?days=30", ptoken);
    expect(exp.body[0].batchNo).toBe("EXPIRED");
    expect(exp.body[0].daysLeft).toBeLessThan(0);
  });
});

describe("assistant & fraud guard (end-to-end)", () => {
  it("answers business questions from live data", async () => {
    const r = await call("POST", "/v1/assistant/ask", token, { question: "كم بعنا النهارده؟" });
    expect(r.status).toBe(200);
    expect(r.body.intent).toBe("SALES");
    expect(r.body.answer).toMatch(/فاتور|فواتير/);
    const c = await call("POST", "/v1/assistant/ask", token, { question: "وضع زاتكا؟" });
    expect(c.body.intent).toBe("COMPLIANCE");
  });

  it("flags a cashier who refunds right after selling", async () => {
    const login = await call("POST", "/v1/auth/login", undefined, { email: "cashier@cafe.test", password: "CashierPass#1" });
    const ct = login.body.token;
    for (let i = 0; i < 3; i++) {
      const s = await call("POST", "/v1/pos/sales", ct, {
        clientUuid: randomUUID(), terminalId, lines: [{ itemId: croissant.id, quantity: "1" }], payments: [{ method: "CASH", amount: "9.99" }],
      });
      await call("POST", `/v1/pos/sales/${s.body.id}/refund`, ct, { clientUuid: randomUUID(), reason: "إلغاء" });
    }
    const r = await call("GET", "/v1/insights/cashiers", token);
    const cashier = r.body.find((x: any) => x.name === "كاشير");
    expect(cashier.refunds).toBe(3);
    expect(cashier.flags.length).toBeGreaterThanOrEqual(2);
    const a = await call("POST", "/v1/assistant/ask", token, { question: "في تلاعب من الكاشيرات؟" });
    expect(a.body.answer).toContain("كاشير");
  });
});
