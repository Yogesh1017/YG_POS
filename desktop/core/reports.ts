import { z } from "zod";
import { ANYONE, MANAGERS, define, type Ctx } from "./core";
import { AppError, zDate } from "./util";

const zRange = z.object({ from: zDate, to: zDate }).refine((r) => r.from <= r.to, "The start date is after the end date");
const WASTE = "('damaged', 'melted', 'expired')";
const n = (ctx: Ctx, sql: string, ...p: (string | number)[]): number => Number(Object.values(ctx.db.get<Record<string, number>>(sql, ...p) ?? { v: 0 })[0] ?? 0);

/** Current stock position: value at cost, low stock, expired stock awaiting write-off. */
function stockPosition(ctx: Ctx) {
  const rows = ctx.db.all<{ id: number; name: string; base_unit: string; low_stock_m: number; on_hand_m: number; expired_m: number; value: number; expired_value: number }>(
    `select p.id, p.name, p.base_unit, p.low_stock_m,
        coalesce((select sum(qty_m) from stock_batches where product_id = p.id), 0) - p.shortfall_m as on_hand_m,
        coalesce((select sum(qty_m) from stock_batches where product_id = p.id and expiry_date is not null and expiry_date < ?), 0) as expired_m,
        coalesce((select sum(qty_m * cost4) from stock_batches where product_id = p.id), 0) / 100000 as value,
        coalesce((select sum(qty_m * cost4) from stock_batches where product_id = p.id and expiry_date is not null and expiry_date < ?), 0) / 100000 as expired_value
     from products p where p.is_active = 1 order by p.name collate nocase`, ctx.today, ctx.today);
  return {
    rows,
    stock_value: rows.reduce((a, r) => a + r.value, 0),
    expired_value: rows.reduce((a, r) => a + r.expired_value, 0),
    low_stock: rows.filter((r) => r.on_hand_m - r.expired_m <= r.low_stock_m),
  };
}

/**
 * The profit picture for a period.
 *   revenue      = taxable value of invoices, less returns (tax is never revenue)
 *   gross profit = revenue - actual cost of the batches sold (cost of restocked returns added back)
 *   net profit   = gross profit - wastage (damaged/melted/expired at cost) - expenses
 */
export function summary(ctx: Ctx, from: string, to: string) {
  const sales = ctx.db.get<Record<string, number>>(
    `select count(*) as count, coalesce(sum(grand_total), 0) as billed, coalesce(sum(taxable_total), 0) as taxable, coalesce(sum(tax_total), 0) as tax,
            coalesce(sum(discount_total), 0) as discount, coalesce(sum(cost_total), 0) as cost, coalesce(sum(grand_total - paid_total), 0) as credit_given
     from sales where status = 'completed' and sold_on between ? and ?`, from, to)!;
  const returns = ctx.db.get<Record<string, number>>(
    `select count(*) as count, coalesce(sum(total), 0) as total, coalesce(sum(taxable_total), 0) as taxable, coalesce(sum(tax_total), 0) as tax, coalesce(sum(cost_total), 0) as cost
     from sale_returns where returned_on between ? and ?`, from, to)!;
  const wastage = n(ctx, `select coalesce(sum(-qty_m * cost4), 0) / 100000 as v from stock_movements where reason in ${WASTE} and moved_on between ? and ?`, from, to);
  const expenses = n(ctx, "select coalesce(sum(amount), 0) as v from expenses where spent_on between ? and ?", from, to);
  const purchases = ctx.db.get<Record<string, number>>(
    "select count(*) as count, coalesce(sum(grand_total), 0) as total, coalesce(sum(tax_total), 0) as tax from purchases where status = 'completed' and bill_date between ? and ?", from, to)!;
  const revenue = sales.taxable - returns.taxable;
  const gross = revenue - (sales.cost - returns.cost);
  return {
    from, to, sales, returns, purchases, revenue, gross_profit: gross, wastage, expenses, net_profit: gross - wastage - expenses,
    cancelled_count: n(ctx, "select count(*) as v from sales where status = 'cancelled' and sold_on between ? and ?", from, to),
    units_sold_lines: n(ctx, "select count(*) as v from sale_items i join sales s on s.id = i.sale_id where s.status = 'completed' and s.sold_on between ? and ?", from, to),
    by_day: ctx.db.all("select sold_on as day, sum(grand_total) as total, count(*) as count from sales where status = 'completed' and sold_on between ? and ? group by sold_on order by sold_on", from, to),
    by_method: ctx.db.all(`select method, coalesce(sum(case when kind <> 'refund' then amount end), 0) as received, coalesce(sum(case when kind = 'refund' then amount end), 0) as refunded
                           from payments where paid_on between ? and ? group by method order by method`, from, to),
    customer_dues: n(ctx, "select coalesce(sum(balance), 0) as v from customers"),
    supplier_dues: n(ctx, "select coalesce(sum(balance), 0) as v from suppliers"),
  };
}

define("reports.dashboard", ANYONE, z.object({}), (ctx) => {
  const month = `${ctx.today.slice(0, 8)}01`;
  const start = new Date(ctx.now.getTime() - 13 * 86400_000);
  const from14 = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  const stock = stockPosition(ctx);
  const today = summary(ctx, ctx.today, ctx.today);
  // Cashiers see activity, not profit.
  const hide = ctx.user.role === "cashier";
  const strip = <T extends Record<string, unknown>>(s: T) => (hide ? { ...s, gross_profit: null, net_profit: null, wastage: null, expenses: null, purchases: null, supplier_dues: null } : s);
  return {
    today: strip(today), month: strip(summary(ctx, month, ctx.today)),
    trend: ctx.db.all("select sold_on as day, sum(grand_total) as total, count(*) as count from sales where status = 'completed' and sold_on between ? and ? group by sold_on order by sold_on", from14, ctx.today),
    trend_from: from14,
    top_products: ctx.db.all(`select i.product_id, i.name, sum(i.base_qty_m - i.returned_base_m) as base_qty_m, p.base_unit, sum(i.line_total) as total
                              from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id
                              where s.status = 'completed' and s.sold_on between ? and ? group by i.product_id order by total desc limit 8`, month, ctx.today),
    low_stock: stock.low_stock.slice(0, 12), low_stock_count: stock.low_stock.length,
    stock_value: hide ? null : stock.stock_value, expired_value: stock.expired_value,
    expired_count: stock.rows.filter((r) => r.expired_m > 0).length,
  };
});

define("reports.summary", MANAGERS, zRange, (ctx, a) => summary(ctx, a.from, a.to));

define("reports.products", MANAGERS, zRange, (ctx, a) =>
  ctx.db.all(`select i.product_id, i.name, p.base_unit, b.name as brand_name,
                sum(i.base_qty_m) as sold_base_m, sum(i.returned_base_m) as returned_base_m,
                sum(i.taxable) as taxable, sum(i.line_total) as total, sum(i.cost_total) as cost,
                sum(i.taxable) - sum(i.cost_total) as profit
              from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id left join brands b on b.id = p.brand_id
              where s.status = 'completed' and s.sold_on between ? and ? group by i.product_id order by total desc`, a.from, a.to));

define("reports.customers", MANAGERS, zRange, (ctx, a) =>
  ctx.db.all(`select s.customer_id, coalesce(c.name, 'Cash sales') as name, count(*) as invoices, sum(s.grand_total) as billed, sum(s.taxable_total) as taxable,
                sum(s.taxable_total) - sum(s.cost_total) as profit, sum(s.returned_total) as returned, coalesce(c.balance, 0) as balance
              from sales s left join customers c on c.id = s.customer_id
              where s.status = 'completed' and s.sold_on between ? and ? group by s.customer_id order by billed desc`, a.from, a.to));

define("reports.purchases", MANAGERS, zRange, (ctx, a) => ({
  by_supplier: ctx.db.all(`select p.supplier_id, s.name, count(*) as bills, sum(p.grand_total) as total, sum(p.tax_total) as tax, sum(p.paid_total) as paid, s.balance
                           from purchases p join suppliers s on s.id = p.supplier_id where p.status = 'completed' and p.bill_date between ? and ? group by p.supplier_id order by total desc`, a.from, a.to),
  by_product: ctx.db.all(`select i.product_id, i.name, pr.base_unit, sum(i.base_qty_m) as base_qty_m, sum(i.taxable) as taxable, sum(i.line_total) as total
                          from purchase_items i join purchases p on p.id = i.purchase_id join products pr on pr.id = i.product_id
                          where p.status = 'completed' and p.bill_date between ? and ? group by i.product_id order by total desc`, a.from, a.to),
}));

define("reports.wastage", MANAGERS, zRange, (ctx, a) => ({
  rows: ctx.db.all(`select m.id, m.moved_on, m.reason, -m.qty_m as qty_m, (-m.qty_m * m.cost4) / 100000 as cost, m.note, p.name, p.base_unit, b.batch_no, b.expiry_date,
                      (m.ref_type = 'sale_return') as from_return
                    from stock_movements m join products p on p.id = m.product_id left join stock_batches b on b.id = m.batch_id
                    where m.reason in ${WASTE} and m.moved_on between ? and ? order by m.id desc`, a.from, a.to),
  by_reason: ctx.db.all(`select reason, sum(-qty_m * cost4) / 100000 as cost, count(*) as entries from stock_movements where reason in ${WASTE} and moved_on between ? and ? group by reason`, a.from, a.to),
}));

define("reports.outstanding", MANAGERS, z.object({}), (ctx) => ({
  customers: ctx.db.all(`select c.id, c.name, c.phone, c.balance, c.credit_limit, c.opening_due,
                           (select min(sold_on) from sales where customer_id = c.id and status = 'completed' and due_amount > 0) as oldest_due_on,
                           (select count(*) from sales where customer_id = c.id and status = 'completed' and due_amount > 0) as unpaid_invoices
                         from customers c where c.balance > 0 order by c.balance desc`),
  suppliers: ctx.db.all(`select s.id, s.name, s.phone, s.balance,
                           (select min(bill_date) from purchases where supplier_id = s.id and status = 'completed' and due_amount > 0) as oldest_due_on
                         from suppliers s where s.balance > 0 order by s.balance desc`),
}));

define("reports.stock", MANAGERS, z.object({}), (ctx) => stockPosition(ctx));

define("reports.gst", MANAGERS, zRange, (ctx, a) => ({
  by_rate: ctx.db.all(`select i.tax_rate_bp, sum(i.taxable) as taxable, sum(i.cgst) as cgst, sum(i.sgst) as sgst, sum(i.igst) as igst
                       from sale_items i join sales s on s.id = i.sale_id where s.status = 'completed' and s.sold_on between ? and ? group by i.tax_rate_bp order by i.tax_rate_bp`, a.from, a.to),
  by_hsn: ctx.db.all(`select coalesce(i.hsn_code, '') as hsn_code, i.tax_rate_bp, sum(i.base_qty_m) as base_qty_m, sum(i.taxable) as taxable, sum(i.cgst + i.sgst + i.igst) as tax
                      from sale_items i join sales s on s.id = i.sale_id where s.status = 'completed' and s.sold_on between ? and ? group by 1, 2 order by 1, 2`, a.from, a.to),
  credit_notes: ctx.db.get("select count(*) as count, coalesce(sum(taxable_total), 0) as taxable, coalesce(sum(tax_total), 0) as tax from sale_returns where returned_on between ? and ?", a.from, a.to),
  input_tax: n(ctx, "select coalesce(sum(tax_total), 0) as v from purchases where status = 'completed' and bill_date between ? and ?", a.from, a.to),
}));

/** Every invoice number in a financial year with its status, plus any number that is missing. */
define("reports.invoiceRegister", MANAGERS, z.object({ fy: z.string().regex(/^\d\d-\d\d$/) }), (ctx, a) => {
  const rows = ctx.db.all<{ seq: number }>("select seq, invoice_no, sold_on, status, customer_name, grand_total, cancel_reason from sales where fy = ? order by seq", a.fy);
  const last = ctx.db.get<{ last_no: number }>("select last_no from doc_counters where series = 'invoice' and fy = ?", a.fy)?.last_no ?? 0;
  const have = new Set(rows.map((r) => r.seq));
  const missing: number[] = [];
  for (let i = 1; i <= last; i++) if (!have.has(i)) missing.push(i);
  if (missing.length > 1000) throw new AppError("Too many missing numbers to list.");
  return { rows, last_no: last, missing, credit_notes: ctx.db.all("select credit_note_no, returned_on, total from sale_returns where credit_note_no like ? order by id", `CN/${a.fy}/%`) };
});
