// Wholesale price rules, shared by the billing screen and the core (which re-checks every bill).
//   1. a price agreed with this customer for this unit
//   2. otherwise the best quantity slab the quantity reaches
//   3. otherwise the unit's list price
// A price typed by hand overrides all three, and needs an owner or manager.
export type PriceSource = "list" | "tier" | "customer" | "manual";
export interface Tier { min_qty_m: number; price: number }

export function resolvePrice(listPrice: number, tiers: Tier[], customerPrice: number | null | undefined, qtyM: number): { price: number; source: PriceSource } {
  if (customerPrice !== null && customerPrice !== undefined) return { price: customerPrice, source: "customer" };
  let best: Tier | null = null;
  for (const t of tiers) if (qtyM >= t.min_qty_m && (!best || t.min_qty_m > best.min_qty_m)) best = t;
  if (best) return { price: best.price, source: "tier" };
  return { price: listPrice, source: "list" };
}
