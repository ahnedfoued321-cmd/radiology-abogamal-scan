/**
 * @mithqal/money — exact decimal arithmetic for every monetary value in Mithqal.
 *
 * Rules (ADR-007):
 *  - Never use JS `number` for money. All amounts are `Money` (decimal.js under the hood).
 *  - Amounts are stored as NUMERIC(19,4) and serialized as strings.
 *  - Rounding is ROUND_HALF_UP to the currency's minor unit (SAR/EGP/AED: 2).
 */
import { Decimal } from "decimal.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = string | number | Money;

export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  SAR: 2,
  EGP: 2,
  AED: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  QAR: 2,
  JOD: 3,
  USD: 2,
};

export function minorUnits(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency];
  if (units === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return units;
}

export class Money {
  private readonly v: Decimal;

  private constructor(v: Decimal) {
    this.v = v;
  }

  static of(input: DecimalInput): Money {
    if (input instanceof Money) return input;
    if (typeof input === "number" && !Number.isFinite(input)) {
      throw new Error(`Invalid amount: ${input}`);
    }
    const d = new D(input);
    if (d.isNaN()) throw new Error(`Invalid amount: ${String(input)}`);
    return new Money(d);
  }

  static zero(): Money {
    return new Money(new D(0));
  }

  static sum(values: DecimalInput[]): Money {
    return values.reduce<Money>((acc, x) => acc.add(x), Money.zero());
  }

  add(x: DecimalInput): Money {
    return new Money(this.v.plus(Money.of(x).v));
  }
  sub(x: DecimalInput): Money {
    return new Money(this.v.minus(Money.of(x).v));
  }
  mul(x: DecimalInput): Money {
    return new Money(this.v.times(Money.of(x).v));
  }
  div(x: DecimalInput): Money {
    const d = Money.of(x).v;
    if (d.isZero()) throw new Error("Division by zero");
    return new Money(this.v.div(d));
  }
  neg(): Money {
    return new Money(this.v.neg());
  }
  abs(): Money {
    return new Money(this.v.abs());
  }

  /** Round to `dp` decimal places, half-up. */
  round(dp = 2): Money {
    return new Money(this.v.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP));
  }
  /** Round to the currency's minor unit. */
  roundTo(currency: string): Money {
    return this.round(minorUnits(currency));
  }

  eq(x: DecimalInput): boolean {
    return this.v.eq(Money.of(x).v);
  }
  gt(x: DecimalInput): boolean {
    return this.v.gt(Money.of(x).v);
  }
  gte(x: DecimalInput): boolean {
    return this.v.gte(Money.of(x).v);
  }
  lt(x: DecimalInput): boolean {
    return this.v.lt(Money.of(x).v);
  }
  lte(x: DecimalInput): boolean {
    return this.v.lte(Money.of(x).v);
  }
  isZero(): boolean {
    return this.v.isZero();
  }
  isNegative(): boolean {
    return this.v.isNegative() && !this.v.isZero();
  }

  /** Fixed-point string, e.g. "115.00". */
  toFixed(dp = 2): string {
    return this.v.toFixed(dp, Decimal.ROUND_HALF_UP);
  }
  /** Full-precision string for storage (NUMERIC(19,4)). */
  toStorage(): string {
    return this.v.toFixed(4, Decimal.ROUND_HALF_UP);
  }
  toString(): string {
    return this.v.toString();
  }
  toJSON(): string {
    return this.toStorage();
  }
}

export interface TaxSplit {
  net: Money;
  tax: Money;
  gross: Money;
}

/**
 * Compute tax for a tax-EXCLUSIVE net amount. Tax is rounded to the currency minor unit.
 */
export function taxFromNet(net: DecimalInput, ratePercent: DecimalInput, currency = "SAR"): TaxSplit {
  const n = Money.of(net).roundTo(currency);
  const tax = n.mul(Money.of(ratePercent).div(100)).roundTo(currency);
  return { net: n, tax, gross: n.add(tax) };
}

/**
 * Split a tax-INCLUSIVE gross amount (typical for POS shelf prices in KSA) into net + tax.
 * The gross is preserved exactly; tax = gross - round(gross / (1 + rate)).
 */
export function taxFromGross(gross: DecimalInput, ratePercent: DecimalInput, currency = "SAR"): TaxSplit {
  const g = Money.of(gross).roundTo(currency);
  const divisor = Money.of(1).add(Money.of(ratePercent).div(100));
  const net = g.div(divisor).roundTo(currency);
  return { net, tax: g.sub(net), gross: g };
}

/** Allocate `total` across `weights` proportionally without losing or creating a cent. */
export function allocate(total: DecimalInput, weights: DecimalInput[], currency = "SAR"): Money[] {
  const t = Money.of(total).roundTo(currency);
  if (weights.length === 0) return [];
  const w = weights.map((x) => Money.of(x));
  const wSum = Money.sum(w);
  if (wSum.isZero()) throw new Error("Cannot allocate with zero total weight");
  const parts = w.map((x) => t.mul(x).div(wSum).roundTo(currency));
  const diff = t.sub(Money.sum(parts));
  if (!diff.isZero()) {
    // put the rounding remainder on the largest weight
    let idx = 0;
    w.forEach((x, i) => {
      if (x.gt(w[idx]!)) idx = i;
    });
    parts[idx] = parts[idx]!.add(diff);
  }
  return parts;
}
