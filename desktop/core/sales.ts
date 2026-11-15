import { z } from "zod";
import { resolvePrice } from "../../src/lib/pricing";
import { computeSale, distributeDiscount, lineGross, type LineInput } from "../../src/lib/tax";
import { toBaseM } from "../../src/lib/units";
import { ANYONE, MANAGERS, audit, authoriser, define, zApprover, type Ctx } from "./core";
import { costOf, getProduct, sellableM, stockBack, stockIn, stockOut, type Allocation, type ProductRow } from "./stock";
import { AppError, divRound, fyOf, zDate, zId, zMethod, zMoney, zOptText, zQtyM, zRef } from "./util";

interface Settings { gst_registered: number; state_code: string | null; round_off_total: number; invoice_prefix: string }
interface Unit { id: number; product_id: number; name: string; factor_m: number; sale_price: number; is_active: number }
interface Customer { id: number; name: string; phone: string | null; gstin: string | null; address: string | null; city: string | null; state_code: string | null; credit_limit: number | null; balance: number; is_active: number }
interface SaleRow { id: number; invoice_no: string; status: string; customer_id: number | null; grand_total: number; paid_total: number; due_amount: number; sold_on: string }

export function nextDocNo(ctx: Ctx, series: "invoice" | "credit_note", fy: string): number {
  ctx.db.run("insert into doc_counters (series, fy, last_no) values (?, ?, 1) on conflict (series, fy) do update set last_no = last_no + 1", series, fy);
  return ctx.db.get<{ last_no: number }>("select last_no from doc_counters where series = ? and fy = ?", series, fy)!.last_no;
}

export function loadSale(ctx: Ctx, id: number) {
  const sale = ctx.db.get("select s.*, u.display_name as cashier from sales s left join users u on u.id = s.created_by where s.id = ?", id);
  if (!sale) throw new AppError("Invoice not found.", "not_found");
  return {
    ...sale,
    items: ctx.db.all("select * from sale_items where sale_id = ? order by line_no", id),
    payments: ctx.db.all("select * from payments where sale_id = ? order by id", id),
    returns: ctx.db.all("select * from sale_returns where sale_id = ? order by id", id),
  };
}

const zSale = z.object({
  client_ref: zRef,
  customer_id: zId.nullish(),
  cash_customer_name: zOptText(120), cash_customer_phone: zOptText(20),
  note: zOptText(300),
  bill_discount: zMoney.default(0),
  items: z.array(z.object({ product_id: zId, unit_id: zId, qty_m: zQtyM, unit_price: zMoney, discount: zMoney.default(0) })).min(1, "Add at least one item").max(500),
  payments: z.array(z.object({ method: zMethod, amount: zMoney.min(1), reference: zOptText(80) })).max(6).default([]),
  /** Things the user has confirmed after being warned: manual prices, selling beyond stock, exceeding the credit limit. */
  approved: z.array(z.enum(["price", "stock", "credit"])).default([]),
  approver: zApprover,
});

/**
 * Create an invoice. One transaction: number, lines, stock (earliest expiry first), payments and
 * the customer's balance are saved together or not at all.
 */
define("sales.create", ANYONE, zSale, (ctx, a) => {
  const dup = ctx.db.get<{ id: number }>("select id from sales where client_ref = ?", a.client_ref);
  if (dup) return { ...loadSale(ctx, dup.id), duplicate: true };

  const settings = ctx.db.get<Settings>("select gst_registered, state_code, round_off_total, invoice_prefix from settings where id = 1")!;
  let customer: Customer | null = null;
  if (a.customer_id) {
    customer = ctx.db.get<Customer>("select * from customers where id = ?", a.customer_id) ?? null;
    if (!customer) throw new AppError("Customer not found.", "not_found");
    if (!customer.is_active) throw new AppError(`${customer.name} is marked inactive.`);
  }
  const interstate = !!settings.gst_registered && !!customer?.state_code && !!settings.state_code && customer.state_code !== settings.state_code;

  // ---- price every line the way the rules say, and note anything that needs an owner/manager
  const problems: { type: "price" | "stock" | "credit"; message: string }[] = [];
  const lines = a.items.map((it, i) => {
    const product = getProduct(ctx, it.product_id);
    const unit = ctx.db.get<Unit>("select * from product_units where id = ? and product_id = ?", it.unit_id, it.product_id);
    if (!unit) throw new AppError(`Line ${i + 1}: unit not found for ${product.name}.`, "not_found");
    if (!product.is_active || !unit.is_active) throw new AppError(`Line ${i + 1}: ${product.name} (${unit.name}) is inactive.`);
    if (product.qty_decimals === 0 && it.qty_m % 1000 !== 0) throw new AppError(`Line ${i + 1}: ${product.name} is sold in whole ${unit.name}.`);
    const baseQtyM = toBaseM(it.qty_m, unit.factor_m);
    if (baseQtyM === null || baseQtyM <= 0) throw new AppError(`Line ${i + 1}: that quantity does not make a whole number of ${product.base_unit}.`);
    const tiers = ctx.db.all<{ min_qty_m: number; price: number }>("select min_qty_m, price from price_tiers where unit_id = ?", unit.id);
    const special = customer ? ctx.db.get<{ price: number }>("select price from customer_prices where customer_id = ? and unit_id = ?", customer.id, unit.id)?.price : undefined;
    const rule = resolvePrice(unit.sale_price, tiers, special, it.qty_m);
    const manual = it.unit_price !== rule.price;
    if (manual) problems.push({ type: "price", message: `${product.name}: rate ₹${(it.unit_price / 100).toFixed(2)} per ${unit.name} instead of ₹${(rule.price / 100).toFixed(2)}` });
    const gross = lineGross(it.qty_m, it.unit_price);
    if (it.discount > gross) throw new AppError(`Line ${i + 1}: the discount is more than the line amount.`);
    return { it, product, unit, baseQtyM, gross, listPrice: rule.price, source: manual ? ("manual" as const) : rule.source };
  });

  // ---- totals (same arithmetic as the billing screen; nothing from the screen's totals is trusted)
  const afterLine = lines.map((l) => l.gross - l.it.discount);
  const shares = distributeDiscount(afterLine, a.bill_discount);
  if (a.bill_discount > afterLine.reduce((x, y) => x + y, 0)) throw new AppError("The bill discount is more than the bill.");
  const inputs: LineInput[] = lines.map((l, i) => ({
    qtyMilli: l.it.qty_m, unitPricePaise: l.it.unit_price, discountPaise: l.it.discount + shares[i],
    taxRateBp: settings.gst_registered ? l.product.tax_rate_bp : 0, priceIncludesTax: !!l.product.price_includes_tax,
  }));
  const totals = computeSale(inputs, { interstate, roundOff: !!settings.round_off_total });

  const paid = a.payments.reduce((x, p) => x + p.amount, 0);
  if (paid > totals.grand) throw new AppError("The payments add up to more than the bill total.");
  const due = totals.grand - paid;
  if (due > 0 && !customer) throw new AppError("A cash sale must be paid in full. Select a customer to sell on credit.");
  if (customer && due > 0 && customer.credit_limit !== null && customer.balance + due > customer.credit_limit) {
    problems.push({ type: "credit", message: `${customer.name} would owe ₹${((customer.balance + due) / 100).toFixed(2)}, over their credit limit of ₹${(customer.credit_limit / 100).toFixed(2)}` });
  }

  // ---- stock check, per product across all lines
  const needed = new Map<number, { product: ProductRow; qty: number }>();
  for (const l of lines) {
    const n = needed.get(l.product.id) ?? { product: l.product, qty: 0 };
    n.qty += l.baseQtyM;
    needed.set(l.product.id, n);
  }
  for (const n of needed.values()) {
    const have = Math.max(sellableM(ctx, n.product.id), 0);
    if (n.qty > have) problems.push({ type: "stock", message: `${n.product.name}: ${n.qty / 1000} ${n.product.base_unit} billed, ${have / 1000} in stock` });
  }

  // ---- anything unusual must be confirmed, and by someone allowed to
  if (problems.length > 0) {
    const unconfirmed = problems.filter((p) => !a.approved.includes(p.type));
    const who = unconfirmed.length === 0 ? authoriser(ctx, a.approver) : null;
    if (!who) {
      throw new AppError("This bill needs approval before it can be saved.", "needs_approval",
        { problems, needs_manager: ctx.user.role === "cashier" });
    }
    audit(ctx, "sale.approved_exceptions", "sale", null, { approved_by: who.username, problems, client_ref: a.client_ref });
  }

  // ---- write
  const fy = fyOf(ctx.today);
  const seq = nextDocNo(ctx, "invoice", fy);
  const invoiceNo = `${settings.invoice_prefix}/${fy}/${seq}`;
  const saleId = ctx.db.run(`insert into sales (client_ref, invoice_no, fy, seq, customer_id, customer_name, customer_phone, customer_gstin, customer_address,
      place_of_supply, is_interstate, gross_total, discount_total, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total,
      paid_total, due_amount, note, sold_on, sold_at, created_by)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.client_ref, invoiceNo, fy, seq, customer?.id ?? null, customer?.name ?? a.cash_customer_name, customer?.phone ?? a.cash_customer_phone, customer?.gstin ?? null,
    customer ? [customer.address, customer.city].filter(Boolean).join(", ") || null : null,
    customer?.state_code ?? settings.state_code, interstate ? 1 : 0, totals.gross, totals.discount, totals.taxable, totals.cgst, totals.sgst, totals.igst, totals.tax,
    totals.roundOff, totals.grand, paid, due, a.note, ctx.today, ctx.now.toISOString(), ctx.user.id).id;

  let costTotal = 0;
  lines.forEach((l, i) => {
    const t = totals.lines[i];
    const itemId = ctx.db.run(`insert into sale_items (sale_id, line_no, product_id, unit_id, name, unit_name, factor_m, hsn_code, qty_m, base_qty_m, unit_price, list_price,
        price_source, price_includes_tax, gross, discount, tax_rate_bp, taxable, cgst, sgst, igst, line_total)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      saleId, i + 1, l.product.id, l.unit.id, l.product.name, l.unit.name, l.unit.factor_m, l.product.hsn_code, l.it.qty_m, l.baseQtyM, l.it.unit_price, l.listPrice,
      l.source, l.product.price_includes_tax, t.gross, t.discount, inputs[i].taxRateBp, t.taxable, t.cgst, t.sgst, t.igst, t.total).id;
    const allocations = stockOut(ctx, { product: l.product, qty_m: l.baseQtyM, reason: "sale", ref: { type: "sale", id: saleId }, mode: "sale", allow_shortfall: true });
    let lineCost = 0;
    for (const al of allocations) {
      ctx.db.run("insert into sale_item_batches (sale_item_id, batch_id, qty_m, cost4) values (?, ?, ?, ?)", itemId, al.batch_id, al.qty_m, al.cost4);
      lineCost += costOf(al.qty_m, al.cost4);
    }
    ctx.db.run("update sale_items set cost_total = ? where id = ?", lineCost, itemId);
    costTotal += lineCost;
  });
  ctx.db.run("update sales set cost_total = ? where id = ?", costTotal, saleId);

  for (const p of a.payments) {
    ctx.db.run(`insert into payments (group_ref, customer_id, sale_id, kind, method, amount, reference, paid_on, created_at, created_by) values (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?)`,
      a.client_ref, customer?.id ?? null, saleId, p.method, p.amount, p.reference, ctx.today, ctx.now.toISOString(), ctx.user.id);
  }
  if (due > 0 && customer) ctx.db.run("update customers set balance = balance + ? where id = ?", due, customer.id);
  return { ...loadSale(ctx, saleId), duplicate: false };
});

define("sales.list", ANYONE, z.object({
  from: zDate.nullish(), to: zDate.nullish(), q: zOptText(80), customer_id: zId.nullish(),
  status: z.enum(["all", "paid", "partial", "unpaid", "cancelled"]).default("all"),
  limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).default(0),
}), (ctx, a) => {
  const where: string[] = [], params: (string | number)[] = [];
  if (a.from) { where.push("s.sold_on >= ?"); params.push(a.from); }
  if (a.to) { where.push("s.sold_on <= ?"); params.push(a.to); }
  if (a.customer_id) { where.push("s.customer_id = ?"); params.push(a.customer_id); }
  if (a.q) { where.push("(s.invoice_no like ? or s.customer_name like ? or s.customer_phone like ?)"); const like = `%${a.q.replace(/[%_]/g, "")}%`; params.push(like, like, like); }
  if (a.status === "cancelled") where.push("s.status = 'cancelled'");
  if (a.status === "paid") where.push("s.status = 'completed' and s.due_amount = 0");
  if (a.status === "unpaid") where.push("s.status = 'completed' and s.due_amount > 0 and s.paid_total = 0");
  if (a.status === "partial") where.push("s.status = 'completed' and s.due_amount > 0 and s.paid_total > 0");
  const w = where.length ? `where ${where.join(" and ")}` : "";
  return {
    rows: ctx.db.all(`select s.id, s.invoice_no, s.status, s.sold_on, s.sold_at, s.customer_id, s.customer_name, s.grand_total, s.paid_total, s.due_amount, s.returned_total
                      from sales s ${w} order by s.id desc limit ? offset ?`, ...params, a.limit, a.offset),
    ...ctx.db.get<{ count: number; total: number }>(`select count(*) as count, coalesce(sum(case when s.status = 'completed' then s.grand_total else 0 end), 0) as total from sales s ${w}`, ...params)!,
  };
});

define("sales.get", ANYONE, z.object({ id: zId }), (ctx, a) => loadSale(ctx, a.id));

/** Cancel a whole invoice. The number stays in the register as cancelled; nothing is deleted. */
define("sales.cancel", MANAGERS, z.object({ id: zId, reason: z.string().trim().min(3, "Give a reason for cancelling").max(200) }), (ctx, a) => {
  const s = ctx.db.get<SaleRow>("select * from sales where id = ?", a.id);
  if (!s) throw new AppError("Invoice not found.", "not_found");
  if (s.status === "cancelled") return loadSale(ctx, s.id);
  if (ctx.db.get("select 1 from sale_returns where sale_id = ? limit 1", s.id)) throw new AppError("This invoice already has returns, so it cannot be cancelled. Return the remaining items instead.");
  const ref = { type: "sale", id: s.id };
  for (const al of ctx.db.all<Allocation & { product_id: number }>(
    "select b.batch_id, b.qty_m, b.cost4, i.product_id from sale_item_batches b join sale_items i on i.id = b.sale_item_id where i.sale_id = ? order by b.id", s.id)) {
    stockBack(ctx, getProduct(ctx, al.product_id), al, al.qty_m, "sale_cancel", ref);
  }
  if (s.due_amount > 0 && s.customer_id) ctx.db.run("update customers set balance = balance - ? where id = ?", s.due_amount, s.customer_id);
  for (const p of ctx.db.all<{ method: string; amount: number }>("select method, sum(amount) as amount from payments where sale_id = ? and kind in ('sale', 'collection') group by method", s.id)) {
    ctx.db.run(`insert into payments (group_ref, customer_id, sale_id, kind, method, amount, note, paid_on, created_at, created_by) values (?, ?, ?, 'refund', ?, ?, 'Invoice cancelled', ?, ?, ?)`,
      `cancel-${s.id}`, s.customer_id, s.id, p.method, p.amount, ctx.today, ctx.now.toISOString(), ctx.user.id);
  }
  ctx.db.run("update sales set status = 'cancelled', due_amount = 0, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? where id = ?", ctx.now.toISOString(), ctx.user.id, a.reason, s.id);
  audit(ctx, "sale.cancel", "sale", s.id, { invoice_no: s.invoice_no, reason: a.reason, grand_total: s.grand_total });
  return loadSale(ctx, s.id);
});

/**
 * Return some or all of an invoice's goods. Creates a credit note. Quantities are in the product's
 * base unit, so part of a carton can come back. Goods can go back on sale, or be recorded as
 * damaged / melted / expired (they then show in the wastage report and never re-enter stock).
 */
define("sales.return", MANAGERS, z.object({
  client_ref: zRef, sale_id: zId, reason: zOptText(200), refund_method: zMethod.nullish(),
  items: z.array(z.object({ sale_item_id: zId, base_qty_m: zQtyM, disposition: z.enum(["restock", "damaged", "melted", "expired"]) })).min(1, "Choose at least one item to return"),
}), (ctx, a) => {
  const dup = ctx.db.get("select * from sale_returns where client_ref = ?", a.client_ref);
  if (dup) return { ...dup, duplicate: true };
  const s = ctx.db.get<SaleRow>("select * from sales where id = ?", a.sale_id);
  if (!s) throw new AppError("Invoice not found.", "not_found");
  if (s.status !== "completed") throw new AppError("A cancelled invoice cannot have returns.");

  const fy = fyOf(ctx.today);
  const cnNo = `CN/${fy}/${nextDocNo(ctx, "credit_note", fy)}`;
  const returnId = ctx.db.run(`insert into sale_returns (client_ref, sale_id, credit_note_no, reason, taxable_total, tax_total, total, returned_on, created_at, created_by)
                               values (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`, a.client_ref, s.id, cnNo, a.reason, ctx.today, ctx.now.toISOString(), ctx.user.id).id;
  const ref = { type: "sale_return", id: returnId, note: a.reason };
  let tAmount = 0, tTaxable = 0, tCost = 0;

  for (const r of a.items) {
    const item = ctx.db.get<{ id: number; product_id: number; name: string; base_qty_m: number; returned_base_m: number; line_total: number; taxable: number }>(
      "select * from sale_items where id = ? and sale_id = ?", r.sale_item_id, s.id);
    if (!item) throw new AppError("That item is not on this invoice.", "not_found");
    const product = getProduct(ctx, item.product_id);
    const remaining = item.base_qty_m - item.returned_base_m;
    if (product.qty_decimals === 0 && r.base_qty_m % 1000 !== 0) throw new AppError(`${item.name} is returned in whole ${product.base_unit}.`);
    if (r.base_qty_m > remaining) throw new AppError(`Only ${remaining / 1000} ${product.base_unit} of ${item.name} can still be returned.`);

    // Value: this share of the line. The last of a line takes the remainder so paise never drift.
    const prev = ctx.db.get<{ amount: number; taxable: number }>("select coalesce(sum(amount), 0) as amount, coalesce(sum(taxable), 0) as taxable from sale_return_items where sale_item_id = ?", item.id)!;
    const last = r.base_qty_m === remaining;
    const amount = last ? item.line_total - prev.amount : divRound(BigInt(item.line_total) * BigInt(r.base_qty_m), BigInt(item.base_qty_m));
    const taxable = last ? item.taxable - prev.taxable : divRound(BigInt(item.taxable) * BigInt(r.base_qty_m), BigInt(item.base_qty_m));
    ctx.db.run("insert into sale_return_items (return_id, sale_item_id, base_qty_m, disposition, taxable, tax, amount) values (?, ?, ?, ?, ?, ?, ?)",
      returnId, item.id, r.base_qty_m, r.disposition, taxable, amount - taxable, amount);
    ctx.db.run("update sale_items set returned_base_m = returned_base_m + ? where id = ?", r.base_qty_m, item.id);

    // Stock: undo the newest batch allocations first.
    let left = r.base_qty_m;
    for (const al of ctx.db.all<{ id: number; batch_id: number | null; qty_m: number; returned_m: number; cost4: number }>(
      "select * from sale_item_batches where sale_item_id = ? and returned_m < qty_m order by id desc", item.id)) {
      if (left <= 0) break;
      const take = Math.min(left, al.qty_m - al.returned_m);
      ctx.db.run("update sale_item_batches set returned_m = returned_m + ? where id = ?", take, al.id);
      if (r.disposition === "restock") {
        stockBack(ctx, product, al, take, "sale_return", ref);
        tCost += costOf(take, al.cost4);
      } else {
        // Came back unsellable: logged in and straight out again, so it is counted as wastage and never on sale.
        const insert = (qty: number, reason: string) => ctx.db.run(
          `insert into stock_movements (product_id, batch_id, qty_m, reason, ref_type, ref_id, cost4, note, moved_on, created_by, created_at) values (?, ?, ?, ?, 'sale_return', ?, ?, ?, ?, ?, ?)`,
          product.id, al.batch_id, qty, reason, returnId, al.cost4, a.reason, ctx.today, ctx.user.id, ctx.now.toISOString());
        insert(take, "sale_return");
        insert(-take, r.disposition);
      }
      left -= take;
    }
    if (left > 0) throw new Error("return quantity exceeds batch allocations");
    tAmount += amount;
    tTaxable += taxable;
  }

  // Settle: first reduce what is still owed on this invoice, then refund — never more than was received.
  const prevRefunds = ctx.db.get<{ r: number }>("select coalesce(sum(refund_paid), 0) as r from sale_returns where sale_id = ?", s.id)!.r;
  const dueReduced = Math.min(s.due_amount, tAmount);
  const refund = Math.max(Math.min(tAmount - dueReduced, s.paid_total - prevRefunds), 0);
  if (dueReduced > 0 && s.customer_id) ctx.db.run("update customers set balance = balance - ? where id = ?", dueReduced, s.customer_id);
  if (refund > 0) {
    if (!a.refund_method) throw new AppError("Choose how the refund is paid.");
    ctx.db.run(`insert into payments (group_ref, customer_id, sale_id, kind, method, amount, note, paid_on, created_at, created_by) values (?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
      a.client_ref, s.customer_id, s.id, a.refund_method, refund, `Return ${cnNo}`, ctx.today, ctx.now.toISOString(), ctx.user.id);
  }
  // A return paid back less than its value only when round-off made the invoice smaller than its lines.
  const settled = dueReduced + refund;
  ctx.db.run("update sale_returns set taxable_total = ?, tax_total = ?, total = ?, due_reduced = ?, refund_paid = ?, refund_method = ?, cost_total = ? where id = ?",
    tTaxable, tAmount - tTaxable, settled, dueReduced, refund, refund > 0 ? a.refund_method! : null, tCost, returnId);
  ctx.db.run("update sales set due_amount = due_amount - ?, returned_total = returned_total + ? where id = ?", dueReduced, settled, s.id);
  audit(ctx, "sale.return", "sale", s.id, { credit_note_no: cnNo, total: settled, refund_paid: refund });
  return { ...ctx.db.get("select * from sale_returns where id = ?", returnId)!, duplicate: false };
});

define("returns.get", ANYONE, z.object({ id: zId }), (ctx, a) => {
  const r = ctx.db.get("select * from sale_returns where id = ?", a.id);
  if (!r) throw new AppError("Credit note not found.", "not_found");
  return { ...r, items: ctx.db.all(`select ri.*, i.name, i.unit_name, i.hsn_code, i.tax_rate_bp, p.base_unit from sale_return_items ri
                                    join sale_items i on i.id = ri.sale_item_id join products p on p.id = i.product_id where ri.return_id = ?`, a.id) };
});
