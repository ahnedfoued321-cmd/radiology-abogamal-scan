import { Money, taxFromGross, taxFromNet, type DecimalInput } from "@mithqal/money";

export interface PriceLineInput {
  itemId: string;
  name: string;
  quantity: DecimalInput;
  unitPrice: DecimalInput; // as entered (inclusive or exclusive of VAT, per `pricesIncludeTax`)
  discount?: DecimalInput; // absolute line discount, same basis as unitPrice
  taxPercent: DecimalInput;
  taxCategory?: "S" | "Z" | "E" | "O";
}

export interface PricedLine {
  index: number;
  itemId: string;
  name: string;
  quantity: Money;
  unitNet: Money;
  discountNet: Money;
  net: Money;
  taxPercent: Money;
  tax: Money;
  gross: Money;
  taxCategory: "S" | "Z" | "E" | "O";
}

export interface PricedDocument {
  currency: string;
  lines: PricedLine[];
  totalNet: Money;
  totalDiscount: Money;
  totalTax: Money;
  totalGross: Money;
}

/**
 * Price a sales document. Line-level rounding to the currency minor unit; document totals are the
 * exact sum of rounded lines, so totals always reconcile with the e-invoice XML.
 */
export function priceDocument(lines: PriceLineInput[], opts: { currency: string; pricesIncludeTax: boolean }): PricedDocument {
  if (lines.length === 0) throw new Error("Document must contain at least one line");
  const priced = lines.map((l, index): PricedLine => {
    const qty = Money.of(l.quantity);
    if (!qty.gt(0)) throw new Error(`Line ${index + 1}: quantity must be positive`);
    const price = Money.of(l.unitPrice);
    if (price.isNegative()) throw new Error(`Line ${index + 1}: price cannot be negative`);
    const discount = Money.of(l.discount ?? 0);
    const extended = price.mul(qty);
    if (discount.isNegative() || discount.gt(extended)) {
      throw new Error(`Line ${index + 1}: invalid discount`);
    }
    const rate = Money.of(l.taxPercent);
    const cat = l.taxCategory ?? (rate.isZero() ? "Z" : "S");
    const amount = extended.sub(discount);
    const split = opts.pricesIncludeTax
      ? taxFromGross(amount, rate, opts.currency)
      : taxFromNet(amount, rate, opts.currency);
    const unitNet = opts.pricesIncludeTax
      ? price.div(Money.of(1).add(rate.div(100))).round(4)
      : price.round(4);
    const discountNet = opts.pricesIncludeTax
      ? discount.div(Money.of(1).add(rate.div(100))).roundTo(opts.currency)
      : discount.roundTo(opts.currency);
    return {
      index: index + 1,
      itemId: l.itemId,
      name: l.name,
      quantity: qty,
      unitNet,
      discountNet,
      net: split.net,
      taxPercent: rate,
      tax: split.tax,
      gross: split.gross,
      taxCategory: cat,
    };
  });
  return {
    currency: opts.currency,
    lines: priced,
    totalNet: Money.sum(priced.map((l) => l.net)),
    totalDiscount: Money.sum(priced.map((l) => l.discountNet)),
    totalTax: Money.sum(priced.map((l) => l.tax)),
    totalGross: Money.sum(priced.map((l) => l.gross)),
  };
}
