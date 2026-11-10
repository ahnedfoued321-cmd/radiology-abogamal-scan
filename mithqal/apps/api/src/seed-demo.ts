/**
 * Demo data: a Riyadh café with a realistic menu and opening stock.
 * Usage: pnpm --filter @mithqal/api seed:demo   (API must be running on PORT, default 4000)
 * Login afterwards: demo@mithqal.app / Mithqal#2026
 */
const BASE = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.message ?? ""}`);
  return data;
}

const MENU: { sku: string; nameAr: string; category: string; price: string; cost: string; qty: string; barcode?: string }[] = [
  { sku: "ESP", nameAr: "إسبريسو", category: "قهوة ساخنة", price: "12.00", cost: "3.20", qty: "200" },
  { sku: "LAT", nameAr: "لاتيه", category: "قهوة ساخنة", price: "17.00", cost: "4.80", qty: "200", barcode: "6281000000011" },
  { sku: "CAP", nameAr: "كابتشينو", category: "قهوة ساخنة", price: "16.00", cost: "4.50", qty: "200" },
  { sku: "SAU", nameAr: "قهوة سعودية (دلة)", category: "قهوة ساخنة", price: "25.00", cost: "6.00", qty: "80" },
  { sku: "V60", nameAr: "V60 مقطرة", category: "قهوة مختصة", price: "22.00", cost: "6.50", qty: "100" },
  { sku: "ICL", nameAr: "آيس لاتيه", category: "مشروبات باردة", price: "19.00", cost: "5.20", qty: "150" },
  { sku: "ICS", nameAr: "آيس سبانش لاتيه", category: "مشروبات باردة", price: "21.00", cost: "5.80", qty: "150" },
  { sku: "MOJ", nameAr: "موهيتو", category: "مشروبات باردة", price: "18.00", cost: "4.00", qty: "100" },
  { sku: "CRO", nameAr: "كرواسون زبدة", category: "مخبوزات", price: "11.00", cost: "3.50", qty: "40" },
  { sku: "CKZ", nameAr: "كوكيز شوكولاتة", category: "مخبوزات", price: "9.00", cost: "2.40", qty: "4" },
  { sku: "SAN", nameAr: "سان سيباستيان", category: "حلويات", price: "28.00", cost: "9.00", qty: "20" },
  { sku: "DAT", nameAr: "تمر سكري (علبة)", category: "حلويات", price: "35.00", cost: "18.00", qty: "30" },
];

const signup = await call<{ token: string; warehouseId: string; terminalId: string }>("POST", "/v1/onboarding", undefined, {
  businessNameAr: "مقهى الريحان",
  businessNameEn: "Al Rayhan Cafe",
  country: "SA",
  industry: "cafe",
  vatNumber: "310122393500003",
  crNumber: "1010010000",
  address: { street: "طريق الملك فهد", buildingNumber: "1234", district: "العليا", city: "الرياض", postalCode: "12211" },
  owner: { fullName: "عبدالله المالك", email: "demo@mithqal.app", password: "Mithqal#2026" },
});

const lines: { itemId: string; quantity: string; unitCost: string }[] = [];
const ids: Record<string, string> = {};
for (const m of MENU) {
  const item = await call<{ id: string }>("POST", "/v1/items", signup.token, {
    sku: m.sku, nameAr: m.nameAr, category: m.category, price: m.price, barcode: m.barcode, reorderLevel: "10",
  });
  ids[m.sku] = item.id;
  lines.push({ itemId: item.id, quantity: m.qty, unitCost: m.cost });
}
await call("POST", "/v1/inventory/receipts", signup.token, { warehouseId: signup.warehouseId, reference: "رصيد افتتاحي", lines });

// A few morning sales so the dashboard has life.
const baskets: [string, number][][] = [
  [["LAT", 2], ["CRO", 1]],
  [["SAU", 1], ["DAT", 1]],
  [["ICS", 3]],
  [["ESP", 1], ["SAN", 1]],
  [["V60", 2], ["CKZ", 1]],
];
for (const [i, basket] of baskets.entries()) {
  const total = basket.reduce((s, [sku, q]) => s + Number(MENU.find((m) => m.sku === sku)!.price) * q, 0);
  await call("POST", "/v1/pos/sales", signup.token, {
    clientUuid: crypto.randomUUID(),
    terminalId: signup.terminalId,
    lines: basket.map(([sku, q]) => ({ itemId: ids[sku], quantity: String(q) })),
    payments: [{ method: i % 2 ? "CASH" : "CARD", amount: total.toFixed(2) }],
  });
}
console.log("Demo ready → login: demo@mithqal.app / Mithqal#2026");

// ── Van sales demo: a rep with a loaded van and three customers on today's route ──
const repUser = await call<{ id: string }>("POST", "/v1/users", signup.token, {
  fullName: "سالم المندوب", email: "rep@mithqal.app", password: "Mithqal#2026", role: "sales_rep",
});
const vanAssigned = await call<{ warehouseId: string }>("POST", "/v1/van/assign", signup.token, { userId: repUser.id, vehiclePlate: "ر س ط 4821" });
await call("POST", "/v1/inventory/transfers", signup.token, {
  fromWarehouseId: signup.warehouseId, toWarehouseId: vanAssigned.warehouseId, reference: "تحميل الصباح",
  lines: [{ itemId: ids.DAT, quantity: "20" }, { itemId: ids.SAU, quantity: "30" }, { itemId: ids.CRO, quantity: "15" }],
});
const dow = new Date().getUTCDay();
const shops = [
  { name: "سوبرماركت النخيل", vatNumber: "311111111111113", creditLimit: "2000.00", latitude: 24.7136, longitude: 46.6753,
    address: { street: "شارع العليا", buildingNumber: "12", district: "العليا", city: "الرياض", postalCode: "12241" } },
  { name: "بقالة الحي", latitude: 24.7300, longitude: 46.6900, creditLimit: "300.00" },
  { name: "مقهى الزاوية", latitude: 24.6950, longitude: 46.6850 },
];
for (const s of shops) await call("POST", "/v1/customers", signup.token, { ...s, routeDay: dow });
console.log("Van demo ready → rep login: rep@mithqal.app / Mithqal#2026");
