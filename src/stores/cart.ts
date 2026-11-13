import { create } from "zustand";
import { persist } from "zustand/middleware";
import { divRound, qtyToMilli, rateToBp, rupeesToPaise } from "@/lib/money";
import { computeSale, distributeDiscount, lineGross, type LineInput, type SaleTotals } from "@/lib/tax";
import type { Business, Customer, Product } from "@/lib/types";

export interface CartLine {
  productId: string;
  name: string;
  unit: string;
  hsn: string | null;
  qtyMilli: number;
  unitPricePaise: number;
  /** Discount typed on this line, in paise. */
  discountPaise: number;
  taxRateBp: number;
  priceIncludesTax: boolean;
}

export interface CartCustomer {
  id: string | null;
  name: string;
  phone: string;
  gstin: string;
  stateCode: string | null;
}

interface CartState {
  lines: CartLine[];
  /** Bill discount as a fixed amount… */
  billDiscountPaise: number;
  /** …or as a percentage (percent * 100). Only one of the two is non-zero. */
  billDiscountPctBp: number;
  customer: CartCustomer | null;
  note: string;
  addProduct: (p: Product, qtyMilli?: number) => void;
  setQty: (productId: string, qtyMilli: number) => void;
  setPrice: (productId: string, paise: number) => void;
  setLineDiscount: (productId: string, paise: number) => void;
  remove: (productId: string) => void;
  setBillDiscount: (paise: number) => void;
  setBillDiscountPct: (bp: number) => void;
  setCustomer: (c: CartCustomer | null) => void;
  setNote: (note: string) => void;
  clear: () => void;
}

/** The bill being built. Saved to localStorage so a refresh or crash does not lose it. */
export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      billDiscountPaise: 0,
      billDiscountPctBp: 0,
      customer: null,
      note: "",
      addProduct: (p, qtyMilli = 1000) =>
        set((s) => {
          const existing = s.lines.find((l) => l.productId === p.id);
          if (existing) {
            return { lines: s.lines.map((l) => (l.productId === p.id ? { ...l, qtyMilli: l.qtyMilli + qtyMilli } : l)) };
          }
          const line: CartLine = {
            productId: p.id, name: p.name, unit: p.unit, hsn: p.hsn_code, qtyMilli,
            unitPricePaise: rupeesToPaise(p.sale_price), discountPaise: 0,
            taxRateBp: rateToBp(p.tax_rate), priceIncludesTax: p.price_includes_tax,
          };
          return { lines: [...s.lines, line] };
        }),
      setQty: (id, qtyMilli) =>
        set((s) => ({ lines: s.lines.map((l) => (l.productId === id ? { ...l, qtyMilli: Math.max(1, qtyMilli) } : l)) })),
      setPrice: (id, paise) =>
        set((s) => ({ lines: s.lines.map((l) => (l.productId === id ? { ...l, unitPricePaise: Math.max(0, paise) } : l)) })),
      setLineDiscount: (id, paise) =>
        set((s) => ({ lines: s.lines.map((l) => (l.productId === id ? { ...l, discountPaise: Math.max(0, paise) } : l)) })),
      remove: (id) => set((s) => ({ lines: s.lines.filter((l) => l.productId !== id) })),
      setBillDiscount: (paise) => set({ billDiscountPaise: Math.max(0, paise), billDiscountPctBp: 0 }),
      setBillDiscountPct: (bp) => set({ billDiscountPctBp: Math.min(Math.max(0, bp), 10000), billDiscountPaise: 0 }),
      setCustomer: (customer) => set({ customer }),
      setNote: (note) => set({ note }),
      clear: () => set({ lines: [], billDiscountPaise: 0, billDiscountPctBp: 0, customer: null, note: "" }),
    }),
    { name: "ygpos-cart", version: 1 },
  ),
);

/** The bill discount in paise, resolving a percentage against the value left after line discounts. */
export function billDiscountOf(lines: CartLine[], amountPaise: number, pctBp: number): number {
  if (!pctBp) return amountPaise;
  const base = lines.reduce((a, l) => {
    const gross = lineGross(l.qtyMilli, l.unitPricePaise);
    return a + gross - Math.min(l.discountPaise, gross);
  }, 0);
  return divRound(BigInt(base) * BigInt(pctBp), 10000n);
}

export interface CartComputation {
  /** Per line: line discount plus this line's share of the bill discount. */
  inputs: LineInput[];
  totals: SaleTotals;
  interstate: boolean;
}

/** Price the cart exactly as the server will. */
export function computeCart(
  lines: CartLine[], billDiscountPaise: number, business: Business, customer: Pick<CartCustomer, "stateCode"> | null,
): CartComputation {
  const interstate =
    business.gst_registered && !!customer?.stateCode && !!business.state_code && customer.stateCode !== business.state_code;
  const afterLine = lines.map((l) => {
    const gross = lineGross(l.qtyMilli, l.unitPricePaise);
    return gross - Math.min(l.discountPaise, gross);
  });
  const shares = distributeDiscount(afterLine, billDiscountPaise);
  const inputs: LineInput[] = lines.map((l, i) => ({
    qtyMilli: l.qtyMilli,
    unitPricePaise: l.unitPricePaise,
    discountPaise: Math.min(l.discountPaise, lineGross(l.qtyMilli, l.unitPricePaise)) + shares[i],
    taxRateBp: business.gst_registered ? l.taxRateBp : 0,
    priceIncludesTax: l.priceIncludesTax,
  }));
  return { inputs, totals: computeSale(inputs, { interstate, roundOff: business.round_off_total }), interstate };
}

export const customerToCart = (c: Customer): CartCustomer => ({
  id: c.id, name: c.name, phone: c.phone ?? "", gstin: c.gstin ?? "", stateCode: c.state_code,
});
export { qtyToMilli };
