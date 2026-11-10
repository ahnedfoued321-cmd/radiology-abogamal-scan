/**
 * @mithqal/eta — Egyptian Tax Authority (ETA) e-receipt (B2C) building blocks.
 *
 *  - Canonical serialization used by ETA for hashing/signing (property names upper-cased and quoted,
 *    values quoted, array items prefixed with the array's property name).
 *  - Receipt UUID = SHA-256 (hex) of the serialized receipt with an empty `uuid`, chained per POS
 *    device through `previousUUID`.
 *  - Receipt document builder (sale "S" and return "R") and the share/verification URL for the QR.
 *
 * NOTE: as with ZATCA, every document type must be validated against the ETA e-receipt SDK /
 * pre-production environment before go-live; field-level details follow the published receipt
 * schema but are kept in one place here so they can be corrected without touching business logic.
 */
import { createHash } from "node:crypto";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** ETA canonical serialization. */
export function serialize(value: Json, name?: string): string {
  if (value === null || typeof value !== "object") {
    return `"${value === null ? "" : String(value)}"`;
  }
  if (Array.isArray(value)) {
    const key = (name ?? "").toUpperCase();
    return value.map((v) => `"${key}"${serialize(v, name)}`).join("");
  }
  let out = "";
  for (const [k, v] of Object.entries(value)) {
    const key = k.toUpperCase();
    out += Array.isArray(v) ? `"${key}"${serialize(v, k)}` : `"${key}"${serialize(v, k)}`;
  }
  return out;
}

export interface EtaSeller {
  rin: string; // tax registration number (9 digits)
  companyTradeName: string;
  branchCode: string;
  deviceSerialNumber: string;
  activityCode: string;
  address: { country: "EG"; governate: string; regionCity: string; street: string; buildingNumber: string };
}

export interface EtaReceiptLine {
  internalCode: string;
  description: string;
  itemType: "EGS" | "GS1";
  itemCode: string;
  unitType: string;
  quantity: number;
  unitPrice: string; // net
  netSale: string;
  totalSale: string;
  total: string; // net + tax
  taxAmount: string;
  taxRate: number;
}

export interface EtaReceiptInput {
  receiptType: "S" | "R";
  receiptNumber: string;
  dateTimeIssued: string; // ISO UTC, no milliseconds
  previousUUID: string; // "" for the device's first receipt
  referenceUUID?: string; // original receipt for returns
  seller: EtaSeller;
  buyerName?: string;
  buyerId?: string;
  lines: EtaReceiptLine[];
  totals: { totalSales: string; netAmount: string; taxTotal: string; totalAmount: string };
  paymentMethod: "C" | "V" | "O"; // cash, visa/card, other
}

export function buildReceipt(i: EtaReceiptInput): { [k: string]: Json } {
  const header: { [k: string]: Json } = {
    dateTimeIssued: i.dateTimeIssued,
    receiptNumber: i.receiptNumber,
    uuid: "",
    previousUUID: i.previousUUID,
    referenceOldUUID: "",
    currency: "EGP",
    exchangeRate: 0,
    sOrderNameCode: "",
    orderdeliveryMode: "",
    grossWeight: 0,
    netWeight: 0,
  };
  if (i.receiptType === "R") header.referenceUUID = i.referenceUUID ?? "";
  return {
    header,
    documentType: { receiptType: i.receiptType, typeVersion: "1.2" },
    seller: {
      rin: i.seller.rin,
      companyTradeName: i.seller.companyTradeName,
      branchCode: i.seller.branchCode,
      branchAddress: {
        country: i.seller.address.country,
        governate: i.seller.address.governate,
        regionCity: i.seller.address.regionCity,
        street: i.seller.address.street,
        buildingNumber: i.seller.address.buildingNumber,
      },
      deviceSerialNumber: i.seller.deviceSerialNumber,
      activityCode: i.seller.activityCode,
    },
    buyer: { type: "P", id: i.buyerId ?? "", name: i.buyerName ?? "", mobileNumber: "" },
    itemData: i.lines.map((l) => ({
      internalCode: l.internalCode,
      description: l.description,
      itemType: l.itemType,
      itemCode: l.itemCode,
      unitType: l.unitType,
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      netSale: Number(l.netSale),
      totalSale: Number(l.totalSale),
      total: Number(l.total),
      taxableItems: [{ taxType: "T1", amount: Number(l.taxAmount), subType: "V009", rate: l.taxRate }],
    })),
    totalSales: Number(i.totals.totalSales),
    totalCommercialDiscount: 0,
    totalItemsDiscount: 0,
    netAmount: Number(i.totals.netAmount),
    feesAmount: 0,
    totalAmount: Number(i.totals.totalAmount),
    taxTotals: [{ taxType: "T1", amount: Number(i.totals.taxTotal) }],
    paymentMethod: i.paymentMethod,
  };
}

/** UUID = SHA-256 hex of the canonical serialization with header.uuid = "". Returns the receipt with uuid filled. */
export function sealReceipt(receipt: { [k: string]: Json }): { uuid: string; receipt: { [k: string]: Json } } {
  const header = { ...(receipt.header as { [k: string]: Json }), uuid: "" };
  const base = { ...receipt, header };
  const uuid = createHash("sha256").update(serialize(base), "utf8").digest("hex");
  return { uuid, receipt: { ...base, header: { ...header, uuid } } };
}

/** Public verification URL encoded in the printed QR code. */
export function receiptShareUrl(uuid: string, dateTimeIssued: string, total: string, rin: string): string {
  return `https://invoicing.eta.gov.eg/receipts/search/${uuid}/share/${dateTimeIssued}#Total:${total},IssuerRIN:${rin}`;
}

/** Egyptian tax registration number: 9 digits. */
export function isValidEgyptRin(rin: string): boolean {
  return /^\d{9}$/.test(rin);
}
