import { z } from "zod";
import { ANYONE, MANAGERS, audit, define, type Ctx } from "./core";
import { getProduct, stockIn } from "./stock";
import { AppError, zBool, zBoolD, zDate, zId, zMoney, zOptText, zQtyM, zText } from "./util";

// ----------------------------------------------------- brands and categories
for (const table of ["brands", "categories", "expense_categories"] as const) {
  define(`${table}.list`, ANYONE, z.object({}), (ctx) => ctx.db.all(`select id, name from ${table} order by name collate nocase`));
  define(`${table}.save`, MANAGERS, z.object({ id: zId.nullish(), name: zText(80).min(1, "Name is required") }), (ctx, a) => {
    if (a.id) ctx.db.run(`update ${table} set name = ? where id = ?`, a.name, a.id);
    else return { id: ctx.db.run(`insert into ${table} (name) values (?)`, a.name).id };
    return { id: a.id };
  });
  define(`${table}.delete`, MANAGERS, z.object({ id: zId }), (ctx, a) => void ctx.db.run(`delete from ${table} where id = ?`, a.id));
}

// ------------------------------------------------------------------ products
const PRODUCT_SELECT = `
  select p.*, b.name as brand_name, c.name as category_name,
    coalesce((select sum(qty_m) from stock_batches where product_id = p.id), 0) - p.shortfall_m as on_hand_m,
    coalesce((select sum(qty_m) from stock_batches where product_id = p.id and expiry_date is not null and expiry_date < ?), 0) as expired_m
  from products p left join brands b on b.id = p.brand_id left join categories c on c.id = p.category_id`;

/** Products with their packaging units and quantity slabs. `sellable_m` is what a bill may use today. */
export function loadProducts(ctx: Ctx, where = "", ...params: (string | number)[]) {
  // the first placeholder in PRODUCT_SELECT is today's date (for expired stock)
  const products = ctx.db.all<Record<string, number | string | null> & { id: number; on_hand_m: number; expired_m: number }>(
    `${PRODUCT_SELECT} ${where} order by p.name collate nocase`, ctx.today, ...params);
  const units = ctx.db.all<{ id: number; product_id: number }>("select * from product_units order by is_base desc, factor_m");
  const tiers = ctx.db.all<{ unit_id: number }>("select * from price_tiers order by min_qty_m");
  const tiersByUnit = Map.groupBy(tiers, (t) => t.unit_id);
  const unitsByProduct = Map.groupBy(units, (u) => u.product_id);
  return products.map((p) => ({
    ...p,
    sellable_m: p.on_hand_m - p.expired_m,
    units: (unitsByProduct.get(p.id) ?? []).map((u) => ({ ...u, tiers: tiersByUnit.get(u.id) ?? [] })),
  }));
}

define("products.list", ANYONE, z.object({}), (ctx) => loadProducts(ctx));

const zUnit = z.object({
  id: zId.nullish(),
  name: zText(20).min(1, "Unit name is required"),
  factor_m: z.number().int().positive().max(1_000_000_000),   // base units inside, x1000
  sale_price: zMoney,
  is_default_sale: zBoolD(false), is_default_purchase: zBoolD(false), is_active: zBoolD(true),
  tiers: z.array(z.object({ min_qty_m: zQtyM, price: zMoney })).max(10).default([]),
});
const zProduct = z.object({
  id: zId.nullish(),
  name: zText(200).min(1, "Name is required"),
  brand_id: zId.nullish(), category_id: zId.nullish(),
  flavour: zOptText(80), pack_size: zOptText(40), sku: zOptText(60), barcode: zOptText(60),
  hsn_code: zOptText(8).refine((v) => v === null || /^[0-9]{4,8}$/.test(v), "HSN/SAC is 4 to 8 digits"),
  tax_rate_bp: z.number().int().min(0).max(10000),
  price_includes_tax: zBool,
  base_unit: zText(20).min(1, "Base unit is required"),
  qty_decimals: z.union([z.literal(0), z.literal(3)]),
  track_expiry: zBool,
  low_stock_m: z.number().int().min(0).max(100_000_000_000),
  cost4: z.number().int().min(0).max(1_000_000_000_000),
  description: zOptText(1000), is_active: zBool,
  /** Packaging units other than the base unit. The base unit's price is `base_price`. */
  base_price: zMoney, base_tiers: z.array(z.object({ min_qty_m: zQtyM, price: zMoney })).max(10).default([]),
  units: z.array(zUnit).max(8),
  default_sale_unit: z.string().nullish(), default_purchase_unit: z.string().nullish(),
  opening: z.object({ qty_m: zQtyM, batch_no: zOptText(40), expiry_date: zDate.nullish() }).nullish(),
});

define("products.save", MANAGERS, zProduct, (ctx, a) => {
  const names = [a.base_unit, ...a.units.map((u) => u.name)].map((n) => n.toLowerCase());
  if (new Set(names).size !== names.length) throw new AppError("Each unit of a product needs a different name.");
  for (const u of a.units) {
    if (u.factor_m <= 1000 && a.qty_decimals === 0) throw new AppError(`"${u.name}" must hold more than one ${a.base_unit}.`);
    if (a.qty_decimals === 0 && u.factor_m % 1000 !== 0) throw new AppError(`"${u.name}" must hold a whole number of ${a.base_unit}.`);
  }
  const cols = ["name", "brand_id", "category_id", "flavour", "pack_size", "sku", "barcode", "hsn_code", "tax_rate_bp", "price_includes_tax",
    "base_unit", "qty_decimals", "track_expiry", "low_stock_m", "cost4", "description", "is_active"] as const;
  const values = cols.map((c) => a[c] ?? null);
  const now = ctx.now.toISOString();
  let id = a.id ?? 0;
  if (id) {
    const old = getProduct(ctx, id);
    const hasStock = !!ctx.db.get("select 1 from stock_movements where product_id = ? limit 1", id);
    if (hasStock && (old.qty_decimals !== a.qty_decimals)) {
      throw new AppError("This product already has stock history, so it cannot switch between counted and weighed. Create a new product instead.");
    }
    ctx.db.run(`update products set ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? where id = ?`, ...values, now, id);
  } else {
    id = ctx.db.run(`insert into products (${cols.join(", ")}, created_at, updated_at) values (${cols.map(() => "?").join(", ")}, ?, ?)`, ...values, now, now).id;
  }

  // Units. A unit that already appears on bills or purchases keeps its size forever (old documents
  // depend on it); to change packaging, add a new unit and switch the old one off.
  const existing = ctx.db.all<{ id: number; name: string; factor_m: number; is_base: number }>("select * from product_units where product_id = ?", id);
  const used = (unitId: number) => !!ctx.db.get("select 1 from sale_items where unit_id = ? union all select 1 from purchase_items where unit_id = ? limit 1", unitId, unitId);
  const wanted = [
    { id: existing.find((u) => u.is_base)?.id ?? null, name: a.base_unit, factor_m: 1000, sale_price: a.base_price, is_base: 1, is_active: 1, tiers: a.base_tiers },
    ...a.units.map((u) => ({ ...u, is_base: 0 })),
  ];
  const keep = new Set<number>();
  // Free up names first so two units can swap names in one save.
  ctx.db.run("update product_units set name = '~' || id where product_id = ?", id);
  for (const u of wanted) {
    const isSale = (a.default_sale_unit ?? a.base_unit).toLowerCase() === u.name.toLowerCase() ? 1 : 0;
    const isPurchase = (a.default_purchase_unit ?? a.base_unit).toLowerCase() === u.name.toLowerCase() ? 1 : 0;
    let unitId = u.id ?? 0;
    const prev = existing.find((e) => e.id === unitId);
    if (unitId && !prev) throw new AppError("Unit not found.", "not_found");
    if (prev) {
      if (prev.factor_m !== u.factor_m && used(prev.id)) {
        throw new AppError(`"${prev.name}" is already on bills or purchases, so its size cannot change. Add a new unit and switch this one off.`);
      }
      ctx.db.run("update product_units set name = ?, factor_m = ?, sale_price = ?, is_default_sale = ?, is_default_purchase = ?, is_active = ? where id = ?",
        u.name, u.factor_m, u.sale_price, isSale, isPurchase, u.is_active, prev.id);
    } else {
      unitId = ctx.db.run("insert into product_units (product_id, name, factor_m, sale_price, is_base, is_default_sale, is_default_purchase, is_active) values (?, ?, ?, ?, ?, ?, ?, ?)",
        id, u.name, u.factor_m, u.sale_price, u.is_base, isSale, isPurchase, u.is_active).id;
    }
    keep.add(unitId);
    ctx.db.run("delete from price_tiers where unit_id = ?", unitId);
    const seen = new Set<number>();
    for (const t of u.tiers) {
      if (seen.has(t.min_qty_m)) throw new AppError("Two quantity prices have the same minimum quantity.");
      seen.add(t.min_qty_m);
      ctx.db.run("insert into price_tiers (unit_id, min_qty_m, price) values (?, ?, ?)", unitId, t.min_qty_m, t.price);
    }
  }
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    if (used(e.id)) ctx.db.run("update product_units set name = ?, is_active = 0, is_default_sale = 0, is_default_purchase = 0 where id = ?", `${e.name} (old)`, e.id);
    else ctx.db.run("delete from product_units where id = ?", e.id);
  }

  if (a.opening && !a.id) {
    const product = getProduct(ctx, id);
    if (product.track_expiry && !a.opening.expiry_date) throw new AppError("Enter the expiry date of the opening stock.");
    stockIn(ctx, { product, qty_m: a.opening.qty_m, cost4: a.cost4, reason: "opening", ref: { type: "opening", id: null }, source: "opening",
      batch_no: a.opening.batch_no, expiry_date: a.opening.expiry_date });
  }
  audit(ctx, a.id ? "product.update" : "product.create", "product", id);
  return loadProducts(ctx, "where p.id = ?", id)[0];
});

define("products.delete", MANAGERS, z.object({ id: zId }), (ctx, a) => {
  getProduct(ctx, a.id);
  if (ctx.db.get("select 1 from stock_movements where product_id = ? limit 1", a.id)) {
    throw new AppError("This product has stock or bill history, so it cannot be deleted. Mark it inactive instead to hide it from billing.", "conflict");
  }
  ctx.db.run("delete from products where id = ?", a.id);
  audit(ctx, "product.delete", "product", a.id);
});
