import { describe, expect, it } from "vitest";
import { computeLine, computeSale, distributeDiscount, lineGross } from "@/lib/tax";
import { parseQty, parseRupees, formatINR, divRound } from "@/lib/money";
import { isValidGstin } from "@/lib/gst";

describe("money parsing and formatting", () => {
  it("parses rupees to paise without float error", () => {
    expect(parseRupees("1,250.50")).toBe(125050);
    expect(parseRupees("0.1")).toBe(10);
    expect(parseRupees("19.99")).toBe(1999);
    expect(parseRupees(".5")).toBe(50);
    expect(parseRupees("12.345")).toBeNull();
    expect(parseRupees("-5")).toBeNull();
    expect(parseRupees("abc")).toBeNull();
    expect(parseRupees("")).toBeNull();
  });
  it("parses quantities to thousandths", () => {
    expect(parseQty("1")).toBe(1000);
    expect(parseQty("0.250")).toBe(250);
    expect(parseQty("2.5")).toBe(2500);
    expect(parseQty("0")).toBeNull();
    expect(parseQty("1.2345")).toBeNull();
  });
  it("formats with Indian grouping", () => {
    expect(formatINR(12345650)).toBe("₹1,23,456.50");
    expect(formatINR(-500)).toBe("-₹5.00");
  });
  it("rounds half up", () => {
    expect(divRound(5n, 10n)).toBe(1);
    expect(divRound(4n, 10n)).toBe(0);
    expect(divRound(15n, 10n)).toBe(2);
  });
});

describe("line tax", () => {
  it("GST-inclusive price: ₹118 at 18% is ₹100 + ₹9 CGST + ₹9 SGST", () => {
    const l = computeLine({ qtyMilli: 1000, unitPricePaise: 11800, discountPaise: 0, taxRateBp: 1800, priceIncludesTax: true }, false);
    expect(l).toMatchObject({ gross: 11800, taxable: 10000, cgst: 900, sgst: 900, igst: 0, total: 11800 });
  });
  it("GST-exclusive price: ₹100 at 18% totals ₹118", () => {
    const l = computeLine({ qtyMilli: 1000, unitPricePaise: 10000, discountPaise: 0, taxRateBp: 1800, priceIncludesTax: false }, false);
    expect(l).toMatchObject({ taxable: 10000, tax: 1800, cgst: 900, sgst: 900, total: 11800 });
  });
  it("inter-state supply charges IGST only", () => {
    const l = computeLine({ qtyMilli: 2000, unitPricePaise: 5000, discountPaise: 0, taxRateBp: 1200, priceIncludesTax: false }, true);
    expect(l).toMatchObject({ cgst: 0, sgst: 0, igst: 1200, total: 11200 });
  });
  it("an odd paisa of tax goes to CGST so CGST + SGST always equals the tax", () => {
    const l = computeLine({ qtyMilli: 1000, unitPricePaise: 1010, discountPaise: 0, taxRateBp: 500, priceIncludesTax: false }, false);
    expect(l.tax).toBe(51); // 50.5 rounds half up
    expect(l.cgst + l.sgst).toBe(l.tax);
    expect(l.cgst).toBe(26);
  });
  it("discount reduces the taxable value", () => {
    const l = computeLine({ qtyMilli: 1000, unitPricePaise: 10000, discountPaise: 1000, taxRateBp: 1800, priceIncludesTax: false }, false);
    expect(l).toMatchObject({ gross: 10000, discount: 1000, taxable: 9000, tax: 1620, total: 10620 });
  });
  it("weighed goods: 0.375 kg at ₹249.99", () => {
    expect(lineGross(375, 24999)).toBe(9375); // 93.74625 -> 93.75
  });
  it("zero-rated and non-GST lines carry no tax", () => {
    const l = computeLine({ qtyMilli: 3000, unitPricePaise: 3333, discountPaise: 0, taxRateBp: 0, priceIncludesTax: true }, false);
    expect(l).toMatchObject({ taxable: 9999, tax: 0, total: 9999 });
  });
});

describe("bill totals", () => {
  const lines = [
    { qtyMilli: 1000, unitPricePaise: 4999, discountPaise: 0, taxRateBp: 500, priceIncludesTax: true },
    { qtyMilli: 2000, unitPricePaise: 12050, discountPaise: 0, taxRateBp: 1800, priceIncludesTax: true },
  ];
  it("rounds the bill to the nearest rupee and reports the round-off", () => {
    const t = computeSale(lines, { interstate: false, roundOff: true });
    expect(t.taxable + t.tax).toBe(29099);
    expect(t.grand).toBe(29100);
    expect(t.roundOff).toBe(1);
  });
  it("keeps paise when round-off is disabled", () => {
    const t = computeSale(lines, { interstate: false, roundOff: false });
    expect(t.grand).toBe(29099);
    expect(t.roundOff).toBe(0);
  });
  it("parts always add up: taxable + cgst + sgst + igst + roundOff = grand", () => {
    const t = computeSale(lines, { interstate: false, roundOff: true });
    expect(t.taxable + t.cgst + t.sgst + t.igst + t.roundOff).toBe(t.grand);
  });
});

describe("bill discount distribution", () => {
  it("splits proportionally and sums exactly", () => {
    const parts = distributeDiscount([10000, 20000, 3333], 1000);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(parts).toEqual([300, 600, 100]);
  });
  it("never discounts more than the bill", () => {
    expect(distributeDiscount([500, 500], 5000)).toEqual([500, 500]);
  });
  it("handles empty and zero bills", () => {
    expect(distributeDiscount([], 100)).toEqual([]);
    expect(distributeDiscount([0, 0], 100)).toEqual([0, 0]);
  });
});

describe("GSTIN validation", () => {
  it("accepts a GSTIN with a correct check digit and rejects a wrong one", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZA")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
  });
});
