import { z } from "zod";
import { ANYONE, MANAGERS, audit, define, type Ctx } from "./core";
import { AppError, divRound, zDate, zId, zOptText } from "./util";

export interface ProductRow {
  id: number; name: string; base_unit: string; qty_decimals: number; track_expiry: number;
  cost4: number; shortfall_m: number; is_active: number; tax_rate_bp: number; price_includes_tax: number; hsn_code: string | null;
}
export interface Allocation { batch_id: number | null; qty_m: number; cost4: number }
type Reason = "opening" | "purchase" | "purchase_cancel" | "sale" | "sale_cancel" | "sale_return" | "adjustment" | "damaged" | "melted" | "expired";
interface Ref { type: string | null; id: number | null; note?: string | null }

export function getProduct(ctx: Ctx, id: number): ProductRow {
  const p = ctx.db.get<ProductRow>("select * from products where id = ?", id);
  if (!p) throw new AppError("Product not found.", "not_found");
  return p;
}
/** The product's full name as printed on documents: brand, name and pack size. */
export function printName(ctx: Ctx, productId: number): string {
  const r = ctx.db.get<{ name: string; pack_size: string | null; brand: string | null }>(
    "select p.name, p.pack_size, b.name as brand from products p left join brands b on b.id = p.brand_id where p.id = ?", productId)!;
  return [r.brand, r.name, r.pack_size].filter(Boolean).join(" ");
}
export function assertWhole(p: ProductRow, qtyM: number): void {
  if (p.qty_decimals === 0 && qtyM % 1000 !== 0) throw new AppError(`${p.name} is counted in whole ${p.base_unit}; a fraction is not allowed.`);
}
/** Cost in paise of qty_m base units at cost4 per unit. */
export const costOf = (qtyM: number, cost4: number): number => divRound(BigInt(qtyM) * BigInt(cost4), 100_000n);

function move(ctx: Ctx, productId: number, batchId: number | null, qtyM: number, reason: Reason, ref: Ref, cost4: number): void {
  ctx.db.run(`insert into stock_movements (product_id, batch_id, qty_m, reason, ref_type, ref_id, cost4, note, moved_on, created_by, created_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, batchId, qtyM, reason, ref.type, ref.id, cost4, ref.note ?? null, ctx.today, ctx.user.id || null, ctx.now.toISOString());
}

/**
 * Put stock in as a new batch. If this product was earlier sold without stock on record
 * (a "shortfall"), the incoming quantity settles that first, so the books and the freezer agree.
 */
export function stockIn(ctx: Ctx, a: {
  product: ProductRow; qty_m: number; cost4: number; reason: Reason; ref: Ref; source: "opening" | "purchase" | "adjustment";
  batch_no?: string | null; mfg_date?: string | null; expiry_date?: string | null; purchase_id?: number | null;
}): number {
  assertWhole(a.product, a.qty_m);
  if (a.qty_m <= 0) throw new AppError("Quantity must be more than zero.");
  const shortfall = ctx.db.get<{ shortfall_m: number }>("select shortfall_m from products where id = ?", a.product.id)!.shortfall_m;
  const absorbed = Math.min(shortfall, a.qty_m);
  const { id } = ctx.db.run(`insert into stock_batches (product_id, batch_no, mfg_date, expiry_date, received_m, qty_m, cost4, source, purchase_id, created_at)
                             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.product.id, a.batch_no ?? null, a.mfg_date ?? null, a.expiry_date ?? null, a.qty_m, a.qty_m - absorbed, a.cost4, a.source, a.purchase_id ?? null, ctx.now.toISOString());
  if (absorbed > 0) ctx.db.run("update products set shortfall_m = shortfall_m - ? where id = ?", absorbed, a.product.id);
  move(ctx, a.product.id, id, a.qty_m, a.reason, a.ref, a.cost4);
  return id;
}

/** Put a quantity back into the batch it came from (cancelled bill, returned goods). */
export function stockBack(ctx: Ctx, product: ProductRow, alloc: Allocation, qtyM: number, reason: Reason, ref: Ref): void {
  if (alloc.batch_id !== null) {
    ctx.db.run("update stock_batches set qty_m = qty_m + ? where id = ?", qtyM, alloc.batch_id);
    move(ctx, product.id, alloc.batch_id, qtyM, reason, ref, alloc.cost4);
  } else {
    // It was sold without stock on record. Coming back, it first cancels that shortfall.
    stockIn(ctx, { product, qty_m: qtyM, cost4: alloc.cost4, reason, ref, source: "adjustment" });
  }
}

/**
 * Take stock out, earliest expiry first. Batches past their expiry date are never used for a sale.
 * Runs inside the caller's transaction; SQLite allows one writer at a time, so two bills can never be
 * given the same stock, and the qty_m >= 0 constraint is a final guard.
 */
export function stockOut(ctx: Ctx, a: {
  product: ProductRow; qty_m: number; reason: Reason; ref: Ref;
  /** sale: skip expired batches. writeoff: oldest first, expired included. */
  mode: "sale" | "writeoff"; batch_id?: number | null; allow_shortfall?: boolean;
}): Allocation[] {
  assertWhole(a.product, a.qty_m);
  if (a.qty_m <= 0) throw new AppError("Quantity must be more than zero.");
  const batches = a.batch_id
    ? ctx.db.all<{ id: number; qty_m: number; cost4: number }>("select id, qty_m, cost4 from stock_batches where id = ? and product_id = ? and qty_m > 0", a.batch_id, a.product.id)
    : ctx.db.all<{ id: number; qty_m: number; cost4: number }>(
        `select id, qty_m, cost4 from stock_batches where product_id = ? and qty_m > 0
           ${a.mode === "sale" ? "and (expiry_date is null or expiry_date >= ?)" : "and ? is not null"}
         order by expiry_date is null, expiry_date, id`, a.product.id, ctx.today);
  const out: Allocation[] = [];
  let left = a.qty_m;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.qty_m);
    ctx.db.run("update stock_batches set qty_m = qty_m - ? where id = ?", take, b.id);
    move(ctx, a.product.id, b.id, -take, a.reason, a.ref, b.cost4);
    out.push({ batch_id: b.id, qty_m: take, cost4: b.cost4 });
    left -= take;
  }
  if (left > 0) {
    if (!a.allow_shortfall) {
      throw new AppError(`Not enough stock of ${a.product.name}: ${(a.qty_m - left) / 1000} ${a.product.base_unit} available, ${a.qty_m / 1000} needed.`, "conflict");
    }
    ctx.db.run("update products set shortfall_m = shortfall_m + ? where id = ?", left, a.product.id);
    move(ctx, a.product.id, null, -left, a.reason, a.ref, a.product.cost4);
    out.push({ batch_id: null, qty_m: left, cost4: a.product.cost4 });
  }
  return out;
}

/** Stock a sale can use right now: unexpired batches, less anything already sold without stock. */
export function sellableM(ctx: Ctx, productId: number): number {
  const r = ctx.db.get<{ q: number; s: number }>(
    `select coalesce((select sum(qty_m) from stock_batches where product_id = p.id and qty_m > 0 and (expiry_date is null or expiry_date >= ?)), 0) as q,
            p.shortfall_m as s from products p where p.id = ?`, ctx.today, productId)!;
  return r.q - r.s;
}

const zCost4 = z.number().int().min(0).max(1_000_000_000_000);

// Manual stock changes. Every one needs a reason, and is written to the stock ledger.
define("stock.adjust", MANAGERS, z.object({
  product_id: zId,
  mode: z.enum(["add", "remove", "set"]),
  qty_m: z.number().int().min(0).max(100_000_000_000),
  reason: z.enum(["opening", "adjustment", "damaged", "melted", "expired"]),
  batch_id: zId.nullish(), batch_no: zOptText(40), mfg_date: zDate.nullish(), expiry_date: zDate.nullish(),
  cost4: zCost4.nullish(), note: zOptText(200),
}), (ctx, a) => {
  const product = getProduct(ctx, a.product_id);
  const ref = { type: "adjustment", id: null, note: a.note };
  const onHand = () => ctx.db.get<{ q: number }>("select coalesce(sum(qty_m), 0) as q from stock_batches where product_id = ?", product.id)!.q - getProduct(ctx, product.id).shortfall_m;
  let mode = a.mode, qty = a.qty_m, reason = a.reason;
  if (mode === "set") {
    const diff = qty - onHand();
    if (diff === 0) throw new AppError("That is the same as the current stock — nothing to change.");
    mode = diff > 0 ? "add" : "remove";
    qty = Math.abs(diff);
    reason = "adjustment";
  }
  if (qty <= 0) throw new AppError("Quantity must be more than zero.");
  if (mode === "add") {
    if (!["opening", "adjustment"].includes(reason)) throw new AppError("Stock can only be added as opening stock or a count correction. Use Purchases for deliveries.");
    if (product.track_expiry && !a.expiry_date) throw new AppError(`${product.name} needs an expiry date.`);
    const cost4 = a.cost4 ?? product.cost4;
    stockIn(ctx, { product, qty_m: qty, cost4, reason, ref, source: reason === "opening" ? "opening" : "adjustment", batch_no: a.batch_no, mfg_date: a.mfg_date, expiry_date: a.expiry_date });
    if (a.cost4 != null && product.cost4 === 0) ctx.db.run("update products set cost4 = ? where id = ?", a.cost4, product.id);
  } else {
    if (reason === "opening") throw new AppError("Opening stock can only add stock.");
    stockOut(ctx, { product, qty_m: qty, reason, ref, mode: "writeoff", batch_id: a.batch_id });
  }
  audit(ctx, "stock.adjust", "product", product.id, { mode: a.mode, qty_m: a.qty_m, reason });
  return { on_hand_m: onHand() };
});

define("stock.batches", ANYONE, z.object({ product_id: zId }), (ctx, a) =>
  ctx.db.all(`select b.*, (b.expiry_date is not null and b.expiry_date < ?) as is_expired from stock_batches b
              where b.product_id = ? and b.qty_m > 0 order by b.expiry_date is null, b.expiry_date, b.id`, ctx.today, a.product_id));

define("stock.movements", ANYONE, z.object({ product_id: zId, limit: z.number().int().min(1).max(500).default(200) }), (ctx, a) =>
  ctx.db.all(`select m.id, m.qty_m, m.reason, m.note, m.moved_on, m.created_at, m.ref_type, m.ref_id, b.batch_no, b.expiry_date, u.display_name as user_name
              from stock_movements m left join stock_batches b on b.id = m.batch_id left join users u on u.id = m.created_by
              where m.product_id = ? order by m.id desc limit ?`, a.product_id, a.limit));

// Batches that have expired or will within `days`. Expired stock stays here, unsellable, until written off.
define("stock.expiring", ANYONE, z.object({ days: z.number().int().min(0).max(365).default(30) }), (ctx, a) => {
  const until = new Date(ctx.now.getTime() + a.days * 86400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const limit = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;
  return ctx.db.all(`select b.id, b.product_id, p.name, p.base_unit, b.batch_no, b.expiry_date, b.qty_m, b.cost4, (b.expiry_date < ?) as is_expired
                     from stock_batches b join products p on p.id = b.product_id
                     where b.qty_m > 0 and b.expiry_date is not null and b.expiry_date <= ? order by b.expiry_date, b.id`, ctx.today, limit);
});
