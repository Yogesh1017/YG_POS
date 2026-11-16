// Bill arithmetic. This file and the create_sale() SQL function implement the
// same rules and are checked against each other in tests/db.test.ts:
//
//   gross    = round(qty * unit_price)                      (paise, half up)
//   net      = gross - discount
//   inclusive price:  taxable = round(net * 100 / (100 + rate)),  tax = net - taxable
//   exclusive price:  taxable = net,                             tax = round(net * rate / 100)
//   same state:  cgst = round(tax / 2), sgst = tax - cgst      other state: igst = tax
//   bill total = sum(taxable + tax), optionally rounded to the nearest rupee
import { divRound } from "./money";

export interface LineInput {
  qtyMilli: number;
  unitPricePaise: number;
  discountPaise: number;
  /** percent * 100, e.g. 18% = 1800. Pass 0 for a business not registered for GST. */
  taxRateBp: number;
  priceIncludesTax: boolean;
}

export interface LineAmounts {
  gross: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  total: number;
}

export interface SaleTotals {
  lines: LineAmounts[];
  gross: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  roundOff: number;
  grand: number;
}

export function lineGross(qtyMilli: number, unitPricePaise: number): number {
  return divRound(BigInt(qtyMilli) * BigInt(unitPricePaise), 1000n);
}

export function computeLine(line: LineInput, interstate: boolean): LineAmounts {
  const gross = lineGross(line.qtyMilli, line.unitPricePaise);
  const discount = Math.min(Math.max(line.discountPaise, 0), gross);
  const net = gross - discount;
  let taxable: number;
  let tax: number;
  if (line.priceIncludesTax) {
    taxable = divRound(BigInt(net) * 10000n, BigInt(10000 + line.taxRateBp));
    tax = net - taxable;
  } else {
    taxable = net;
    tax = divRound(BigInt(net) * BigInt(line.taxRateBp), 10000n);
  }
  const cgst = interstate ? 0 : Math.floor((tax + 1) / 2);
  const sgst = interstate ? 0 : tax - cgst;
  const igst = interstate ? tax : 0;
  return { gross, discount, taxable, cgst, sgst, igst, tax, total: taxable + tax };
}

export function computeSale(lines: LineInput[], opts: { interstate: boolean; roundOff: boolean }): SaleTotals {
  const computed = lines.map((l) => computeLine(l, opts.interstate));
  const sum = (k: keyof LineAmounts) => computed.reduce((a, l) => a + l[k], 0);
  const total = sum("total");
  // nearest rupee, half up (totals are never negative)
  const grand = opts.roundOff ? Math.floor((total + 50) / 100) * 100 : total;
  return {
    lines: computed,
    gross: sum("gross"),
    discount: sum("discount"),
    taxable: sum("taxable"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    tax: sum("tax"),
    roundOff: grand - total,
    grand,
  };
}

/**
 * Spread a bill-level discount across lines in proportion to each line's
 * remaining value, so tax is charged on the discounted value of every item.
 * Uses largest-remainder so the parts always add up to exactly the discount.
 */
export function distributeDiscount(lineValues: number[], discount: number): number[] {
  const total = lineValues.reduce((a, v) => a + v, 0);
  const d = Math.min(Math.max(discount, 0), total);
  if (total === 0 || d === 0) return lineValues.map(() => 0);
  const exact = lineValues.map((v) => (BigInt(v) * BigInt(d)) / BigInt(total));
  const parts = exact.map(Number);
  let left = d - parts.reduce((a, v) => a + v, 0);
  const order = lineValues
    .map((v, i) => ({ i, rem: (BigInt(v) * BigInt(d)) % BigInt(total) }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (left <= 0) break;
    if (parts[i] < lineValues[i]) {
      parts[i] += 1;
      left -= 1;
    }
  }
  return parts;
}
