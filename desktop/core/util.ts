import { z } from "zod";

/** An error whose message is meant for the person using the app. */
export class AppError extends Error {
  constructor(message: string, readonly code: "invalid" | "forbidden" | "not_found" | "conflict" | "auth" | "needs_approval" = "invalid", readonly data?: unknown) {
    super(message);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Calendar date on this computer, 'YYYY-MM-DD'. */
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Indian financial year (April–March) of a 'YYYY-MM-DD' date, e.g. '26-27'. */
export function fyOf(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${pad(start % 100)}-${pad((start + 1) % 100)}`;
}

/** Round-half-up integer division for non-negative operands, exact for any size. */
export function divRound(n: bigint, d: bigint): number {
  return Number((2n * n + d) / (2n * d));
}

export const zId = z.number().int().positive();
export const zMoney = z.number().int().min(0).max(100_000_000_000);       // paise, up to ₹100 crore
export const zQtyM = z.number().int().positive().max(100_000_000_000);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");
export const zText = (max: number) => z.string().trim().max(max);
export const zOptText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
/** true/false, stored as 1/0. Also accepts 1/0, so a record read from the database can be sent straight back. */
const zFlag = z.union([z.boolean(), z.literal(0), z.literal(1)]);
export const zBool = zFlag.transform((b) => (b ? 1 : 0));
export const zMethod = z.enum(["cash", "upi", "card", "bank", "cheque", "other"]);
export const zRef = z.string().min(8).max(64);
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const zGstin = z.string().trim().toUpperCase().nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || GSTIN_RE.test(v), "This GSTIN is not valid");
export const zState = z.string().regex(/^\d{2}$/).nullish().transform((v) => (v ? v : null));
/** Boolean with a default, stored as 0/1. */
export const zBoolD = (def: boolean) => zFlag.default(def).transform((b) => (b ? 1 : 0));
