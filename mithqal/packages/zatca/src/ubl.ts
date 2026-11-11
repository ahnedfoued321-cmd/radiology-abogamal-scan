/**
 * UBL 2.1 invoice XML builder following the ZATCA e-invoicing data dictionary (KSA).
 *
 * The builder produces two forms:
 *  - `hashable`: the document WITHOUT ext:UBLExtensions, cac:Signature and the QR reference.
 *    Its SHA-256 is the invoice hash (and the next invoice's PIH).
 *  - `full`: the document with the QR reference and signature placeholders inserted.
 *
 * NOTE: before production, every generated document must pass the official ZATCA SDK
 * validator (`fatoora -validate`) and Compliance CSID checks. XAdES signature properties
 * are produced by the signing service (see README: "ZATCA production checklist").
 */

export type InvoiceKind = "SIMPLIFIED" | "STANDARD";
export type DocumentType = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";

export interface Address {
  street: string;
  buildingNumber: string;
  district: string;
  city: string;
  postalCode: string;
  countryCode: string; // ISO 3166-1 alpha-2
}

export interface Party {
  name: string;
  vatNumber?: string;
  crNumber?: string;
  address?: Address;
}

export interface UblLine {
  id: number;
  name: string;
  quantity: string;
  unitCode?: string;
  unitPrice: string; // net unit price
  lineNet: string; // quantity * price - discount
  taxPercent: string;
  taxAmount: string;
  taxCategory?: "S" | "Z" | "E" | "O";
}

export interface UblInvoice {
  kind: InvoiceKind;
  documentType: DocumentType;
  number: string;
  uuid: string;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  currency: string;
  icv: number;
  pih: string;
  seller: Party;
  buyer?: Party;
  paymentMeansCode: string; // 10 cash, 48 card, 30 credit transfer, 1 not defined
  lines: UblLine[];
  totals: {
    lineExtension: string;
    taxExclusive: string;
    taxTotal: string;
    taxInclusive: string;
    allowanceTotal: string;
    payable: string;
  };
  billingReference?: string; // original invoice number for credit/debit notes
  supplyDate?: string; // KSA-5, YYYY-MM-DD (defaults to issue date for standard invoices)
  reason?: string; // required for credit/debit notes
}

const TYPE_CODES: Record<DocumentType, string> = {
  INVOICE: "388",
  CREDIT_NOTE: "381",
  DEBIT_NOTE: "383",
};

/** Text-node escaping that matches XML C14N output (quotes stay literal), so our hash equals ZATCA's. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;");
}

const e = escapeXml;

function address(a: Address): string {
  return (
    `<cac:PostalAddress>` +
    `<cbc:StreetName>${e(a.street)}</cbc:StreetName>` +
    `<cbc:BuildingNumber>${e(a.buildingNumber)}</cbc:BuildingNumber>` +
    `<cbc:CitySubdivisionName>${e(a.district)}</cbc:CitySubdivisionName>` +
    `<cbc:CityName>${e(a.city)}</cbc:CityName>` +
    `<cbc:PostalZone>${e(a.postalCode)}</cbc:PostalZone>` +
    `<cac:Country><cbc:IdentificationCode>${e(a.countryCode)}</cbc:IdentificationCode></cac:Country>` +
    `</cac:PostalAddress>`
  );
}

function party(p: Party, role: "AccountingSupplierParty" | "AccountingCustomerParty"): string {
  return (
    `<cac:${role}><cac:Party>` +
    (p.crNumber ? `<cac:PartyIdentification><cbc:ID schemeID="CRN">${e(p.crNumber)}</cbc:ID></cac:PartyIdentification>` : "") +
    (p.address ? address(p.address) : "") +
    (p.vatNumber
      ? `<cac:PartyTaxScheme><cbc:CompanyID>${e(p.vatNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
      : "") +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${e(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    `</cac:Party></cac:${role}>`
  );
}

function taxSubtotals(inv: UblInvoice): string {
  const groups = new Map<string, { cat: string; pct: string; taxable: number; tax: number }>();
  // group by category+percent; values are already 2dp strings so summing cents is exact
  for (const l of inv.lines) {
    const cat = l.taxCategory ?? "S";
    const key = `${cat}|${l.taxPercent}`;
    const g = groups.get(key) ?? { cat, pct: l.taxPercent, taxable: 0, tax: 0 };
    g.taxable += Math.round(Number(l.lineNet) * 100);
    g.tax += Math.round(Number(l.taxAmount) * 100);
    groups.set(key, g);
  }
  const c = inv.currency;
  return [...groups.values()]
    .map(
      (g) =>
        `<cac:TaxSubtotal>` +
        `<cbc:TaxableAmount currencyID="${c}">${(g.taxable / 100).toFixed(2)}</cbc:TaxableAmount>` +
        `<cbc:TaxAmount currencyID="${c}">${(g.tax / 100).toFixed(2)}</cbc:TaxAmount>` +
        `<cac:TaxCategory><cbc:ID>${g.cat}</cbc:ID><cbc:Percent>${Number(g.pct).toFixed(2)}</cbc:Percent>` +
        `<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>` +
        `</cac:TaxSubtotal>`,
    )
    .join("");
}

function line(l: UblLine, c: string): string {
  const gross = (Math.round(Number(l.lineNet) * 100) + Math.round(Number(l.taxAmount) * 100)) / 100;
  return (
    `<cac:InvoiceLine>` +
    `<cbc:ID>${l.id}</cbc:ID>` +
    `<cbc:InvoicedQuantity unitCode="${escapeAttr(l.unitCode ?? "PCE")}">${e(l.quantity)}</cbc:InvoicedQuantity>` +
    `<cbc:LineExtensionAmount currencyID="${c}">${e(l.lineNet)}</cbc:LineExtensionAmount>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${c}">${e(l.taxAmount)}</cbc:TaxAmount>` +
    `<cbc:RoundingAmount currencyID="${c}">${gross.toFixed(2)}</cbc:RoundingAmount></cac:TaxTotal>` +
    `<cac:Item><cbc:Name>${e(l.name)}</cbc:Name>` +
    `<cac:ClassifiedTaxCategory><cbc:ID>${l.taxCategory ?? "S"}</cbc:ID><cbc:Percent>${Number(l.taxPercent).toFixed(2)}</cbc:Percent>` +
    `<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>` +
    `<cac:Price><cbc:PriceAmount currencyID="${c}">${e(l.unitPrice)}</cbc:PriceAmount></cac:Price>` +
    `</cac:InvoiceLine>`
  );
}

const NS =
  `xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ` +
  `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
  `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ` +
  `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"`;

/** Build the hashable XML and a function that inserts QR + signature into the full document. */
export function buildUblInvoice(inv: UblInvoice): { hashable: string; withQr: (qrBase64: string, signatureExtensionXml?: string) => string } {
  if (inv.lines.length === 0) throw new Error("Invoice must have at least one line");
  if (inv.documentType !== "INVOICE" && (!inv.billingReference || !inv.reason)) {
    throw new Error("Credit/debit notes require billingReference and reason");
  }
  if (inv.kind === "STANDARD" && !inv.buyer) throw new Error("Standard (B2B) tax invoices require a buyer");
  const c = inv.currency;
  const typeName = inv.kind === "SIMPLIFIED" ? "0200000" : "0100000";
  // ZATCA requires BT-23 = "reporting:1.0" for every invoice type (clearance vs reporting is decided by KSA-2).
  const profile = "reporting:1.0";

  const head =
    `<cbc:ProfileID>${profile}</cbc:ProfileID>` +
    `<cbc:ID>${e(inv.number)}</cbc:ID>` +
    `<cbc:UUID>${e(inv.uuid)}</cbc:UUID>` +
    `<cbc:IssueDate>${e(inv.issueDate)}</cbc:IssueDate>` +
    `<cbc:IssueTime>${e(inv.issueTime)}</cbc:IssueTime>` +
    `<cbc:InvoiceTypeCode name="${typeName}">${TYPE_CODES[inv.documentType]}</cbc:InvoiceTypeCode>` +
    `<cbc:DocumentCurrencyCode>${c}</cbc:DocumentCurrencyCode>` +
    `<cbc:TaxCurrencyCode>${c}</cbc:TaxCurrencyCode>` +
    (inv.billingReference
      ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${e(inv.billingReference)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`
      : "") +
    `<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${inv.icv}</cbc:UUID></cac:AdditionalDocumentReference>` +
    `<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment>` +
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${e(inv.pih)}</cbc:EmbeddedDocumentBinaryObject>` +
    `</cac:Attachment></cac:AdditionalDocumentReference>`;

  const body =
    party(inv.seller, "AccountingSupplierParty") +
    // UBL requires the element even for anonymous B2C buyers
    (inv.buyer ? party(inv.buyer, "AccountingCustomerParty") : `<cac:AccountingCustomerParty></cac:AccountingCustomerParty>`) +
    // BR-KSA-15: standard tax invoices carry the supply date (KSA-5)
    (inv.kind === "STANDARD" ? `<cac:Delivery><cbc:ActualDeliveryDate>${e(inv.supplyDate ?? inv.issueDate)}</cbc:ActualDeliveryDate></cac:Delivery>` : "") +
    `<cac:PaymentMeans><cbc:PaymentMeansCode>${e(inv.paymentMeansCode)}</cbc:PaymentMeansCode>` +
    (inv.reason ? `<cbc:InstructionNote>${e(inv.reason)}</cbc:InstructionNote>` : "") +
    `</cac:PaymentMeans>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${c}">${e(inv.totals.taxTotal)}</cbc:TaxAmount></cac:TaxTotal>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${c}">${e(inv.totals.taxTotal)}</cbc:TaxAmount>${taxSubtotals(inv)}</cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>` +
    `<cbc:LineExtensionAmount currencyID="${c}">${e(inv.totals.lineExtension)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxExclusiveAmount currencyID="${c}">${e(inv.totals.taxExclusive)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="${c}">${e(inv.totals.taxInclusive)}</cbc:TaxInclusiveAmount>` +
    `<cbc:AllowanceTotalAmount currencyID="${c}">${e(inv.totals.allowanceTotal)}</cbc:AllowanceTotalAmount>` +
    `<cbc:PrepaidAmount currencyID="${c}">0.00</cbc:PrepaidAmount>` +
    `<cbc:PayableAmount currencyID="${c}">${e(inv.totals.payable)}</cbc:PayableAmount>` +
    `</cac:LegalMonetaryTotal>` +
    inv.lines.map((l) => line(l, c)).join("");

  const hashable = `<Invoice ${NS}>${head}${body}</Invoice>`;

  const withQr = (qrBase64: string, signatureExtensionXml?: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Invoice ${NS}>` +
    (signatureExtensionXml
      ? `<ext:UBLExtensions>${signatureExtensionXml}</ext:UBLExtensions>`
      : // device not onboarded with ZATCA yet: unsigned placeholder (dev/test only)
        `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
        `<ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>`) +
    head +
    `<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment>` +
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrBase64}</cbc:EmbeddedDocumentBinaryObject>` +
    `</cac:Attachment></cac:AdditionalDocumentReference>` +
    `<cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>` +
    `<cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod></cac:Signature>` +
    body +
    `</Invoice>`;

  return { hashable, withQr };
}
