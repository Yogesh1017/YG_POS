import { z } from "zod";
import { computeLine } from "../../src/lib/tax";
import { toBaseM } from "../../src/lib/units";
import { MANAGERS, audit, define, type Ctx } from "./core";
import { getProduct, printName, stockIn } from "./stock";
import { AppError, divRound, zBoolD, zDate, zId, zMethod, zMoney, zOptText, zQtyM, zRef } from "./util";

export function loadPurchase(ctx: Ctx, id: number) {
  const p = ctx.db.get("select p.*, s.name as supplier_name, u.display_name as user_name from purchases p join suppliers s on s.id = p.supplier_id left join users u on u.id = p.created_by where p.id = ?", id);
  if (!p) throw new AppError("Purchase not found.", "not_found");
  return {
    ...p,
    items: ctx.db.all("select i.*, b.batch_no, b.mfg_date, b.expiry_date, b.qty_m as batch_left_m from purchase_items i left join stock_batches b on b.id = i.batch_id where i.purchase_id = ? order by i.line_no", id),
    payments: ctx.db.all("select * from supplier_payments where purchase_id = ? order by id", id),
  };
}

/**
 * Enter a supplier's bill. One transaction: the bill, a stock batch per line (with batch number and
 * expiry), the product's latest cost, any payment made, and the amount now owed to the supplier.
 */
define("purchases.create", MANAGERS, z.object({
  client_ref: zRef, supplier_id: zId, bill_no: zOptText(40), bill_date: zDate, note: zOptText(300),
  rates_include_tax: zBoolD(false),
  /** Small difference between our arithmetic and the supplier's printed total (at most ₹1 either way). */
  round_off: z.number().int().min(-100).max(100).default(0),
  items: z.array(z.object({
    product_id: zId, unit_id: zId, qty_m: zQtyM, rate: zMoney, discount: zMoney.default(0),
    tax_rate_bp: z.number().int().min(0).max(10000).nullish(),
    batch_no: zOptText(40), mfg_date: zDate.nullish(), expiry_date: zDate.nullish(),
  })).min(1, "Add at least one item").max(500),
  paid: z.object({ amount: zMoney.min(1), method: zMethod, reference: zOptText(80) }).nullish(),
}), (ctx, a) => {
  const dup = ctx.db.get<{ id: number }>("select id from purchases where client_ref = ?", a.client_ref);
  if (dup) return { ...loadPurchase(ctx, dup.id), duplicate: true };
  const supplier = ctx.db.get<{ id: number; name: string }>("select id, name from suppliers where id = ?", a.supplier_id);
  if (!supplier) throw new AppError("Supplier not found.", "not_found");
  if (a.bill_date > ctx.today) throw new AppError("The bill date cannot be in the future.");
  if (a.bill_no && ctx.db.get("select 1 from purchases where supplier_id = ? and bill_no = ? and status = 'completed'", supplier.id, a.bill_no)) {
    throw new AppError(`Bill ${a.bill_no} from ${supplier.name} has already been entered.`, "conflict");
  }
  const gst = !!ctx.db.get<{ gst_registered: number }>("select gst_registered from settings where id = 1")!.gst_registered;

  const lines = a.items.map((it, i) => {
    const product = getProduct(ctx, it.product_id);
    const unit = ctx.db.get<{ id: number; name: string; factor_m: number }>("select * from product_units where id = ? and product_id = ?", it.unit_id, it.product_id);
    if (!unit) throw new AppError(`Line ${i + 1}: unit not found for ${product.name}.`, "not_found");
    if (product.qty_decimals === 0 && it.qty_m % 1000 !== 0) throw new AppError(`Line ${i + 1}: ${product.name} is bought in whole ${unit.name}.`);
    const baseQtyM = toBaseM(it.qty_m, unit.factor_m);
    if (baseQtyM === null || baseQtyM <= 0) throw new AppError(`Line ${i + 1}: that quantity does not make a whole number of ${product.base_unit}.`);
    if (product.track_expiry && !it.expiry_date) throw new AppError(`Line ${i + 1}: enter the expiry date for ${product.name}.`);
    if (it.expiry_date && it.mfg_date && it.expiry_date < it.mfg_date) throw new AppError(`Line ${i + 1}: the expiry date is before the manufacturing date.`);
    const amounts = computeLine({ qtyMilli: it.qty_m, unitPricePaise: it.rate, discountPaise: it.discount, taxRateBp: it.tax_rate_bp ?? product.tax_rate_bp, priceIncludesTax: !!a.rates_include_tax }, true);
    if (it.discount > amounts.gross) throw new AppError(`Line ${i + 1}: the discount is more than the line amount.`);
    // What a base unit really cost us. GST we can claim back is not a cost; if we are not registered, it is.
    const costPaise = gst ? amounts.taxable : amounts.total;
    const cost4 = divRound(BigInt(costPaise) * 100_000n, BigInt(baseQtyM));
    return { it, product, unit, baseQtyM, amounts, cost4, taxRateBp: it.tax_rate_bp ?? product.tax_rate_bp };
  });

  const taxable = lines.reduce((x, l) => x + l.amounts.taxable, 0);
  const tax = lines.reduce((x, l) => x + l.amounts.tax, 0);
  const grand = taxable + tax + a.round_off;
  const paid = a.paid?.amount ?? 0;
  if (paid > grand) throw new AppError("The amount paid is more than the bill total.");
  const due = grand - paid;

  const id = ctx.db.run(`insert into purchases (client_ref, supplier_id, bill_no, bill_date, rates_include_tax, taxable_total, tax_total, round_off, grand_total, paid_total, due_amount, note, created_by, created_at)
                         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.client_ref, supplier.id, a.bill_no, a.bill_date, a.rates_include_tax, taxable, tax, a.round_off, grand, paid, due, a.note, ctx.user.id, ctx.now.toISOString()).id;
  lines.forEach((l, i) => {
    const batchId = stockIn(ctx, { product: l.product, qty_m: l.baseQtyM, cost4: l.cost4, reason: "purchase", ref: { type: "purchase", id }, source: "purchase",
      batch_no: l.it.batch_no, mfg_date: l.it.mfg_date, expiry_date: l.it.expiry_date, purchase_id: id });
    ctx.db.run(`insert into purchase_items (purchase_id, line_no, product_id, unit_id, name, unit_name, factor_m, qty_m, base_qty_m, rate, discount, tax_rate_bp, taxable, tax, line_total, batch_id)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, i + 1, l.product.id, l.unit.id, printName(ctx, l.product.id), l.unit.name, l.unit.factor_m, l.it.qty_m, l.baseQtyM, l.it.rate, l.amounts.discount, l.taxRateBp, l.amounts.taxable, l.amounts.tax, l.amounts.total, batchId);
    ctx.db.run("update products set cost4 = ? where id = ?", l.cost4, l.product.id);
  });
  if (a.paid) {
    ctx.db.run(`insert into supplier_payments (group_ref, supplier_id, purchase_id, kind, method, amount, reference, paid_on, created_at, created_by) values (?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?)`,
      a.client_ref, supplier.id, id, a.paid.method, a.paid.amount, a.paid.reference, ctx.today, ctx.now.toISOString(), ctx.user.id);
  }
  if (due > 0) ctx.db.run("update suppliers set balance = balance + ? where id = ?", due, supplier.id);
  audit(ctx, "purchase.create", "purchase", id, { supplier: supplier.name, grand_total: grand });
  return { ...loadPurchase(ctx, id), duplicate: false };
});

define("purchases.list", MANAGERS, z.object({ from: zDate.nullish(), to: zDate.nullish(), supplier_id: zId.nullish(), limit: z.number().int().min(1).max(500).default(200) }), (ctx, a) => {
  const where: string[] = [], params: (string | number)[] = [];
  if (a.from) { where.push("p.bill_date >= ?"); params.push(a.from); }
  if (a.to) { where.push("p.bill_date <= ?"); params.push(a.to); }
  if (a.supplier_id) { where.push("p.supplier_id = ?"); params.push(a.supplier_id); }
  return ctx.db.all(`select p.id, p.bill_no, p.bill_date, p.status, p.grand_total, p.paid_total, p.due_amount, s.name as supplier_name
                     from purchases p join suppliers s on s.id = p.supplier_id ${where.length ? `where ${where.join(" and ")}` : ""} order by p.bill_date desc, p.id desc limit ?`, ...params, a.limit);
});
define("purchases.get", MANAGERS, z.object({ id: zId }), (ctx, a) => loadPurchase(ctx, a.id));

/** Undo a purchase entered by mistake. Only possible while none of its stock has been sold or written off. */
define("purchases.cancel", MANAGERS, z.object({ id: zId, reason: z.string().trim().min(3, "Give a reason for cancelling").max(200) }), (ctx, a) => {
  const p = ctx.db.get<{ id: number; status: string; supplier_id: number; due_amount: number; grand_total: number; bill_no: string | null }>("select * from purchases where id = ?", a.id);
  if (!p) throw new AppError("Purchase not found.", "not_found");
  if (p.status === "cancelled") return loadPurchase(ctx, p.id);
  const batches = ctx.db.all<{ id: number; product_id: number; qty_m: number; received_m: number; cost4: number; name: string }>(
    "select b.*, pr.name from stock_batches b join products pr on pr.id = b.product_id where b.purchase_id = ?", p.id);
  const touched = batches.find((b) => b.qty_m !== b.received_m);
  if (touched) throw new AppError(`Some of the ${touched.name} from this purchase has already been sold or adjusted, so the purchase cannot be cancelled. Correct the stock with an adjustment instead.`, "conflict");
  for (const b of batches) {
    ctx.db.run("update stock_batches set qty_m = 0 where id = ?", b.id);
    ctx.db.run(`insert into stock_movements (product_id, batch_id, qty_m, reason, ref_type, ref_id, cost4, note, moved_on, created_by, created_at) values (?, ?, ?, 'purchase_cancel', 'purchase', ?, ?, ?, ?, ?, ?)`,
      b.product_id, b.id, -b.received_m, p.id, b.cost4, a.reason, ctx.today, ctx.user.id, ctx.now.toISOString());
  }
  if (p.due_amount > 0) ctx.db.run("update suppliers set balance = balance - ? where id = ?", p.due_amount, p.supplier_id);
  for (const pay of ctx.db.all<{ method: string; amount: number }>("select method, sum(amount) as amount from supplier_payments where purchase_id = ? and kind in ('purchase', 'payment') group by method", p.id)) {
    ctx.db.run(`insert into supplier_payments (group_ref, supplier_id, purchase_id, kind, method, amount, note, paid_on, created_at, created_by) values (?, ?, ?, 'refund', ?, ?, 'Purchase cancelled', ?, ?, ?)`,
      `pcancel-${p.id}`, p.supplier_id, p.id, pay.method, pay.amount, ctx.today, ctx.now.toISOString(), ctx.user.id);
  }
  ctx.db.run("update purchases set status = 'cancelled', due_amount = 0, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? where id = ?", ctx.now.toISOString(), ctx.user.id, a.reason, p.id);
  audit(ctx, "purchase.cancel", "purchase", p.id, { reason: a.reason, grand_total: p.grand_total });
  return loadPurchase(ctx, p.id);
});
