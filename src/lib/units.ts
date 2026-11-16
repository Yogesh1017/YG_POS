// Packaging helpers. Stock is always held in the product's smallest (base) unit, in thousandths.
export interface UnitLike { name: string; factor_m: number; is_base?: number | boolean; is_active?: number | boolean }

/** Quantity in a packaging unit -> base units (both in thousandths). Null if it does not come out whole. */
export function toBaseM(qtyM: number, factorM: number): number | null {
  const n = BigInt(qtyM) * BigInt(factorM);
  return n % 1000n === 0n ? Number(n / 1000n) : null;
}

const trim = (m: number): string => String(m / 1000);

/**
 * Stock in words people use: 1234 pieces with Carton=120, Box=10 -> "10 Carton 3 Box 4 pcs".
 * Largest packaging first; whatever is left over is shown in the base unit.
 */
export function formatStock(baseM: number, baseUnit: string, units: UnitLike[]): string {
  if (baseM === 0) return `0 ${baseUnit}`;
  const sign = baseM < 0 ? "-" : "";
  let left = Math.abs(baseM);
  const packs = units.filter((u) => !u.is_base && u.is_active !== 0 && u.is_active !== false && u.factor_m > 1000).sort((a, b) => b.factor_m - a.factor_m);
  const parts: string[] = [];
  for (const u of packs) {
    const n = Math.floor(left / u.factor_m);
    if (n > 0) {
      parts.push(`${n} ${u.name}`);
      left -= n * u.factor_m;
    }
  }
  if (left > 0 || parts.length === 0) parts.push(`${trim(left)} ${baseUnit}`);
  return sign + parts.join(" ");
}

/** Plain quantity text, e.g. 2500 -> "2.5", 3000 -> "3". */
export const formatQtyM = trim;
