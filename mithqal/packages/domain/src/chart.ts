import type { AccountRole } from "./ledger.js";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export interface AccountTemplate {
  code: string;
  nameAr: string;
  nameEn: string;
  type: AccountType;
  parentCode?: string;
  role?: AccountRole;
  postable: boolean;
}

/**
 * Default chart of accounts for a KSA retail / F&B business (country pack "SA").
 * Tenants can rename, extend or remap roles; posting rules only depend on roles.
 */
export const SA_RETAIL_CHART: AccountTemplate[] = [
  { code: "1", nameAr: "الأصول", nameEn: "Assets", type: "ASSET", postable: false },
  { code: "11", nameAr: "الأصول المتداولة", nameEn: "Current assets", type: "ASSET", parentCode: "1", postable: false },
  { code: "1101", nameAr: "الصندوق", nameEn: "Cash on hand", type: "ASSET", parentCode: "11", role: "CASH", postable: true },
  { code: "1102", nameAr: "مدفوعات الشبكة (مدى/بطاقات) تحت التسوية", nameEn: "Card payments clearing", type: "ASSET", parentCode: "11", role: "BANK_CARD_CLEARING", postable: true },
  { code: "1103", nameAr: "البنك", nameEn: "Bank", type: "ASSET", parentCode: "11", postable: true },
  { code: "1110", nameAr: "العملاء (ذمم مدينة)", nameEn: "Accounts receivable", type: "ASSET", parentCode: "11", role: "ACCOUNTS_RECEIVABLE", postable: true },
  { code: "1120", nameAr: "المخزون", nameEn: "Inventory", type: "ASSET", parentCode: "11", role: "INVENTORY", postable: true },
  { code: "1130", nameAr: "ضريبة القيمة المضافة - مدخلات", nameEn: "VAT input", type: "ASSET", parentCode: "11", role: "VAT_INPUT", postable: true },
  { code: "2", nameAr: "الالتزامات", nameEn: "Liabilities", type: "LIABILITY", postable: false },
  { code: "21", nameAr: "الالتزامات المتداولة", nameEn: "Current liabilities", type: "LIABILITY", parentCode: "2", postable: false },
  { code: "2101", nameAr: "الموردون (ذمم دائنة)", nameEn: "Accounts payable", type: "LIABILITY", parentCode: "21", role: "ACCOUNTS_PAYABLE", postable: true },
  { code: "2110", nameAr: "ضريبة القيمة المضافة - مخرجات", nameEn: "VAT output", type: "LIABILITY", parentCode: "21", role: "VAT_OUTPUT", postable: true },
  { code: "3", nameAr: "حقوق الملكية", nameEn: "Equity", type: "EQUITY", postable: false },
  { code: "3101", nameAr: "رأس المال", nameEn: "Capital", type: "EQUITY", parentCode: "3", postable: true },
  { code: "3190", nameAr: "أرصدة افتتاحية", nameEn: "Opening balance equity", type: "EQUITY", parentCode: "3", role: "OPENING_BALANCE_EQUITY", postable: true },
  { code: "4", nameAr: "الإيرادات", nameEn: "Revenue", type: "REVENUE", postable: false },
  { code: "4101", nameAr: "المبيعات", nameEn: "Sales", type: "REVENUE", parentCode: "4", role: "SALES_REVENUE", postable: true },
  { code: "4102", nameAr: "خصومات المبيعات", nameEn: "Sales discounts", type: "REVENUE", parentCode: "4", role: "SALES_DISCOUNTS", postable: true },
  { code: "5", nameAr: "المصروفات", nameEn: "Expenses", type: "EXPENSE", postable: false },
  { code: "5101", nameAr: "تكلفة البضاعة المباعة", nameEn: "Cost of goods sold", type: "EXPENSE", parentCode: "5", role: "COST_OF_GOODS_SOLD", postable: true },
  { code: "5102", nameAr: "تسويات وهالك المخزون", nameEn: "Inventory adjustments & waste", type: "EXPENSE", parentCode: "5", role: "INVENTORY_ADJUSTMENT", postable: true },
  { code: "5201", nameAr: "الرواتب والأجور", nameEn: "Salaries & wages", type: "EXPENSE", parentCode: "5", postable: true },
  { code: "5202", nameAr: "الإيجار", nameEn: "Rent", type: "EXPENSE", parentCode: "5", postable: true },
];

export function validateChart(chart: AccountTemplate[]): void {
  const codes = new Set<string>();
  const roles = new Set<string>();
  for (const a of chart) {
    if (codes.has(a.code)) throw new Error(`Duplicate account code ${a.code}`);
    codes.add(a.code);
    if (a.role) {
      if (roles.has(a.role)) throw new Error(`Role ${a.role} mapped twice`);
      if (!a.postable) throw new Error(`Role ${a.role} must map to a postable account`);
      roles.add(a.role);
    }
  }
  for (const a of chart) {
    if (a.parentCode && !codes.has(a.parentCode)) throw new Error(`Missing parent ${a.parentCode} for ${a.code}`);
  }
}
