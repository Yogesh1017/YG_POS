// Money is handled as integer paise and quantities as integer thousandths
// ("milli") everywhere on the client. Floats only appear at the edges
// (parsing user input, talking to the API) and are converted immediately.

/** Round-half-up integer division for non-negative operands, done in BigInt so it cannot lose precision. */
export function divRound(n: bigint, d: bigint): number {
  return Number((2n * n + d) / (2n * d));
}

export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);
export const paiseToRupees = (paise: number): number => paise / 100;
export const qtyToMilli = (qty: number): number => Math.round(qty * 1000);
export const milliToQty = (milli: number): number => milli / 1000;
/** Tax rate in percent (max 2 decimals) to basis points. */
export const rateToBp = (rate: number): number => Math.round(rate * 100);

/** Parse user-typed rupees ("1,250.50") to paise. Returns null when it is not a valid non-negative amount. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, "");
  if (!/^\d{0,9}(\.\d{0,2})?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole || "0") * 100 + Number(frac.padEnd(2, "0"));
}

/** Parse a quantity with up to 3 decimals to milli-units. Null when invalid or not positive. */
export function parseQty(input: string): number | null {
  const s = input.trim();
  if (!/^\d{0,7}(\.\d{0,3})?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  const milli = Number(whole || "0") * 1000 + Number(frac.padEnd(3, "0"));
  return milli > 0 ? milli : null;
}

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1,23,456.50" (Indian digit grouping, no symbol). */
export const formatPaise = (paise: number): string => inr.format(paise / 100);
/** "₹1,23,456.50" */
export const formatINR = (paise: number): string => (paise < 0 ? "-₹" : "₹") + inr.format(Math.abs(paise) / 100);
/** Paise to the plain decimal string the API expects, e.g. 12050 -> "120.50". */
export const paiseToDecimal = (paise: number): string => (paise / 100).toFixed(2);
export const formatQty = (milli: number): string => String(milli / 1000);
export const milliToDecimal = (milli: number): string => (milli / 1000).toFixed(3);
