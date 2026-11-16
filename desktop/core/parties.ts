// Customers and suppliers: records, balances, payments and ledgers.
import { z } from "zod";
import { ANYONE, MANAGERS, audit, define, type Ctx } from "./core";
import { AppError, zBoolD, zDate, zGstin, zId, zMethod, zMoney, zOptText, zRef, zState, zText } from "./util";

const zParty = z.object({
  id: zId.nullish(),
  name: zText(120).min(1, "Name is required"),
  contact_person: zOptText(80),
  phone: zOptText(20).refine((v) => v === null || /^[0-9+ -]{6,20}$/.test(v), "Enter a valid phone number"),
  gstin: zGstin, state_code: zState, address: zOptText(400), notes: zOptText(400),
  opening_balance: zMoney.default(0),
  is_active: zBoolD(true),
});

interface Party { id: number; name: string; opening_balance: number; opening_due: number; balance: number }

function saveParty(ctx: Ctx, table: "customers" | "suppliers", a: z.output<typeof zParty>, extra: Record<string, string | number | null>): number {
  const state = a.state_code ?? (a.gstin ? a.gstin.slice(0, 2) : null);
  const cols: Record<string, string | number | null> = {
    name: a.name, contact_person: a.contact_person, phone: a.phone, gstin: a.gstin, state_code: state, address: a.address, notes: a.notes,
    is_active: a.is_active, ...extra,
  };
  const keys = Object.keys(cols);
  if (!a.id) {
    return ctx.db.run(`insert into ${table} (${keys.join(", ")}, opening_balance, opening_due, balance, created_at) values (${keys.map(() => "?").join(", ")}, ?, ?, ?, ?)`,
      ...Object.values(cols), a.opening_balance, a.opening_balance, a.opening_balance, ctx.now.toISOString()).id;
  }
  const old = ctx.db.get<Party>(`select * from ${table} where id = ?`, a.id);
  if (!old) throw new AppError("Record not found.", "not_found");
  // The opening balance may be corrected, but not below what has already been paid against it.
  const paid = old.opening_balance - old.opening_due;
  if (a.opening_balance < paid) throw new AppError(`₹${paid / 100} has already been paid against the opening balance, so it cannot be set lower than that.`);
  const delta = a.opening_balance - old.opening_balance;
  ctx.db.run(`update ${table} set ${keys.map((k) => `${k} = ?`).join(", ")}, opening_balance = ?, opening_due = opening_due + ?, balance = balance + ? where id = ?`,
    ...Object.values(cols), a.opening_balance, delta, delta, a.id);
  if (delta !== 0) audit(ctx, `${table}.opening_balance`, table, a.id, { from: old.opening_balance, to: a.opening_balance });
  return a.id;
}

// ------------------------------------------------------------------ customers
define("customers.list", ANYONE, z.object({}), (ctx) => ctx.db.all("select * from customers order by name collate nocase"));

define("customers.save", ANYONE, zParty.extend({ city: zOptText(80), credit_limit: zMoney.nullish() }), (ctx, a) => {
  // Cashiers may add customers at the counter, but credit terms and opening balances are for owner/manager.
  if (ctx.user.role === "cashier") {
    const old = a.id ? ctx.db.get<{ credit_limit: number | null; opening_balance: number; is_active: number }>("select * from customers where id = ?", a.id) : null;
    if ((a.credit_limit ?? null) !== (old?.credit_limit ?? null) || a.opening_balance !== (old?.opening_balance ?? 0) || (old && a.is_active !== old.is_active)) {
      throw new AppError("Only an owner or manager can set credit limits, opening balances or deactivate a customer.", "forbidden");
    }
  }
  const id = saveParty(ctx, "customers", a, { city: a.city, credit_limit: a.credit_limit ?? null });
  return ctx.db.get("select * from customers where id = ?", id);
});

define("customers.delete", MANAGERS, z.object({ id: zId }), (ctx, a) => {
  if (ctx.db.get("select 1 from sales where customer_id = ? union all select 1 from payments where customer_id = ? limit 1", a.id, a.id)) {
    throw new AppError("This customer has bills or payments on record, so they cannot be deleted. Mark them inactive instead.", "conflict");
  }
  ctx.db.run("delete from customers where id = ?", a.id);
  audit(ctx, "customer.delete", "customer", a.id);
});

define("customers.prices", ANYONE, z.object({ customer_id: zId }), (ctx, a) =>
  ctx.db.all(`select cp.unit_id, cp.price, u.name as unit_name, u.sale_price as list_price, p.id as product_id, p.name as product_name
              from customer_prices cp join product_units u on u.id = cp.unit_id join products p on p.id = u.product_id
              where cp.customer_id = ? order by p.name collate nocase, u.factor_m`, a.customer_id));

define("customers.setPrice", MANAGERS, z.object({ customer_id: zId, unit_id: zId, price: zMoney.nullable() }), (ctx, a) => {
  if (a.price === null) ctx.db.run("delete from customer_prices where customer_id = ? and unit_id = ?", a.customer_id, a.unit_id);
  else ctx.db.run("insert into customer_prices (customer_id, unit_id, price) values (?, ?, ?) on conflict (customer_id, unit_id) do update set price = excluded.price", a.customer_id, a.unit_id, a.price);
  audit(ctx, "customer.set_price", "customer", a.customer_id, { unit_id: a.unit_id, price: a.price });
});

// What this customer last paid for each unit, and their recent bills — shown while billing.
define("customers.recent", ANYONE, z.object({ customer_id: zId }), (ctx, a) => ({
  last_prices: ctx.db.all(`select i.unit_id, i.unit_price, s.sold_on from sale_items i join sales s on s.id = i.sale_id
                           where s.customer_id = ? and s.status = 'completed' and i.id in (
                             select max(i2.id) from sale_items i2 join sales s2 on s2.id = i2.sale_id where s2.customer_id = ? and s2.status = 'completed' group by i2.unit_id)`,
    a.customer_id, a.customer_id),
  sales: ctx.db.all("select id, invoice_no, sold_on, status, grand_total, due_amount from sales where customer_id = ? order by id desc limit 10", a.customer_id),
}));

/**
 * Record money received against a customer's dues (no payment is processed here). It settles the
 * opening balance first, then the oldest unpaid invoices. Safe to submit twice: client_ref makes it once.
 */
define("customers.collect", ANYONE, z.object({
  client_ref: zRef, customer_id: zId, amount: zMoney.min(1, "Enter the amount received"), method: zMethod,
  reference: zOptText(80), note: zOptText(200), paid_on: zDate.nullish(),
}), (ctx, a) => {
  const c = ctx.db.get<Party>("select * from customers where id = ?", a.customer_id);
  if (!c) throw new AppError("Customer not found.", "not_found");
  if (ctx.db.get("select 1 from payments where group_ref = ? limit 1", a.client_ref)) return { balance: c.balance, duplicate: true };
  if (a.amount > c.balance) throw new AppError(`${c.name} owes ₹${(c.balance / 100).toFixed(2)}; you cannot record more than that.`);
  const paidOn = a.paid_on ?? ctx.today;
  if (paidOn > ctx.today) throw new AppError("The payment date cannot be in the future.");
  const insert = (saleId: number | null, amount: number) =>
    ctx.db.run(`insert into payments (group_ref, customer_id, sale_id, kind, method, amount, reference, note, paid_on, created_at, created_by)
                values (?, ?, ?, 'collection', ?, ?, ?, ?, ?, ?, ?)`, a.client_ref, c.id, saleId, a.method, amount, a.reference, a.note, paidOn, ctx.now.toISOString(), ctx.user.id);
  let left = a.amount;
  const toOpening = Math.min(left, c.opening_due);
  if (toOpening > 0) {
    insert(null, toOpening);
    ctx.db.run("update customers set opening_due = opening_due - ? where id = ?", toOpening, c.id);
    left -= toOpening;
  }
  for (const s of ctx.db.all<{ id: number; due_amount: number }>("select id, due_amount from sales where customer_id = ? and status = 'completed' and due_amount > 0 order by sold_on, id", c.id)) {
    if (left <= 0) break;
    const pay = Math.min(left, s.due_amount);
    insert(s.id, pay);
    ctx.db.run("update sales set due_amount = due_amount - ?, paid_total = paid_total + ? where id = ?", pay, pay, s.id);
    left -= pay;
  }
  if (left > 0) throw new Error("customer balance does not match unpaid invoices");
  ctx.db.run("update customers set balance = balance - ? where id = ?", a.amount, c.id);
  return { balance: c.balance - a.amount, duplicate: false };
});

export interface LedgerEntry { date: string; at: string; type: string; ref: string; debit: number; credit: number; balance: number }
const RANK = ["Opening balance", "Invoice", "Purchase", "Payment received", "Payment made", "Credit note (return)", "Refund paid", "Refund received", "Invoice cancelled", "Purchase cancelled"];
function finishLedger(rows: Omit<LedgerEntry, "balance">[], from?: string | null, to?: string | null) {
  // Oldest first; things recorded at the same moment read in a natural order (invoice, then its payment).
  rows.sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at) || RANK.indexOf(x.type) - RANK.indexOf(y.type));
  let balance = 0, opening = 0;
  const entries: LedgerEntry[] = [];
  for (const r of rows) {
    balance += r.debit - r.credit;
    if (from && r.date < from) { opening = balance; continue; }
    if (to && r.date > to) continue;
    entries.push({ ...r, balance });
  }
  return { opening, entries, closing: entries.length ? entries[entries.length - 1].balance : opening };
}

/** Statement of account: every invoice, payment, return and cancellation, with a running balance. */
export function customerLedger(ctx: Ctx, customerId: number, from?: string | null, to?: string | null) {
  const c = ctx.db.get<Party & { created_at: string }>("select * from customers where id = ?", customerId);
  if (!c) throw new AppError("Customer not found.", "not_found");
  const rows: Omit<LedgerEntry, "balance">[] = [];
  if (c.opening_balance > 0) rows.push({ date: "0000-00-00", at: "", type: "Opening balance", ref: "", debit: c.opening_balance, credit: 0 });
  for (const s of ctx.db.all<{ invoice_no: string; sold_on: string; sold_at: string; grand_total: number; status: string; cancelled_at: string | null }>("select * from sales where customer_id = ?", customerId)) {
    rows.push({ date: s.sold_on, at: s.sold_at, type: "Invoice", ref: s.invoice_no, debit: s.grand_total, credit: 0 });
    if (s.status === "cancelled" && s.cancelled_at) {
      const d = new Date(s.cancelled_at);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      rows.push({ date, at: s.cancelled_at, type: "Invoice cancelled", ref: s.invoice_no, debit: 0, credit: s.grand_total });
    }
  }
  for (const p of ctx.db.all<{ kind: string; method: string; amount: number; paid_on: string; created_at: string; invoice_no: string | null; reference: string | null }>(
    "select p.*, s.invoice_no from payments p left join sales s on s.id = p.sale_id where p.customer_id = ?", customerId)) {
    const ref = [p.invoice_no, p.method.toUpperCase(), p.reference].filter(Boolean).join(" · ");
    if (p.kind === "refund") rows.push({ date: p.paid_on, at: p.created_at, type: "Refund paid", ref, debit: p.amount, credit: 0 });
    else rows.push({ date: p.paid_on, at: p.created_at, type: "Payment received", ref, debit: 0, credit: p.amount });
  }
  for (const r of ctx.db.all<{ credit_note_no: string; total: number; returned_on: string; created_at: string }>(
    "select r.* from sale_returns r join sales s on s.id = r.sale_id where s.customer_id = ?", customerId)) {
    rows.push({ date: r.returned_on, at: r.created_at, type: "Credit note (return)", ref: r.credit_note_no, debit: 0, credit: r.total });
  }
  return { party: c, ...finishLedger(rows, from, to) };
}
define("customers.ledger", ANYONE, z.object({ customer_id: zId, from: zDate.nullish(), to: zDate.nullish() }), (ctx, a) => customerLedger(ctx, a.customer_id, a.from, a.to));

// ------------------------------------------------------------------ suppliers
define("suppliers.list", MANAGERS, z.object({}), (ctx) => ctx.db.all("select * from suppliers order by name collate nocase"));
define("suppliers.save", MANAGERS, zParty, (ctx, a) => ctx.db.get("select * from suppliers where id = ?", saveParty(ctx, "suppliers", a, {})));
define("suppliers.delete", MANAGERS, z.object({ id: zId }), (ctx, a) => {
  if (ctx.db.get("select 1 from purchases where supplier_id = ? union all select 1 from supplier_payments where supplier_id = ? limit 1", a.id, a.id)) {
    throw new AppError("This supplier has purchases or payments on record, so they cannot be deleted. Mark them inactive instead.", "conflict");
  }
  ctx.db.run("delete from suppliers where id = ?", a.id);
});

/** Record a payment made to a supplier: opening balance first, then the oldest unpaid purchase bills. */
define("suppliers.pay", MANAGERS, z.object({
  client_ref: zRef, supplier_id: zId, amount: zMoney.min(1, "Enter the amount paid"), method: zMethod,
  reference: zOptText(80), note: zOptText(200), paid_on: zDate.nullish(),
}), (ctx, a) => {
  const s = ctx.db.get<Party>("select * from suppliers where id = ?", a.supplier_id);
  if (!s) throw new AppError("Supplier not found.", "not_found");
  if (ctx.db.get("select 1 from supplier_payments where group_ref = ? limit 1", a.client_ref)) return { balance: s.balance, duplicate: true };
  if (a.amount > s.balance) throw new AppError(`You owe ${s.name} ₹${(s.balance / 100).toFixed(2)}; you cannot record more than that.`);
  const paidOn = a.paid_on ?? ctx.today;
  if (paidOn > ctx.today) throw new AppError("The payment date cannot be in the future.");
  const insert = (purchaseId: number | null, amount: number) =>
    ctx.db.run(`insert into supplier_payments (group_ref, supplier_id, purchase_id, kind, method, amount, reference, note, paid_on, created_at, created_by)
                values (?, ?, ?, 'payment', ?, ?, ?, ?, ?, ?, ?)`, a.client_ref, s.id, purchaseId, a.method, amount, a.reference, a.note, paidOn, ctx.now.toISOString(), ctx.user.id);
  let left = a.amount;
  const toOpening = Math.min(left, s.opening_due);
  if (toOpening > 0) {
    insert(null, toOpening);
    ctx.db.run("update suppliers set opening_due = opening_due - ? where id = ?", toOpening, s.id);
    left -= toOpening;
  }
  for (const p of ctx.db.all<{ id: number; due_amount: number }>("select id, due_amount from purchases where supplier_id = ? and status = 'completed' and due_amount > 0 order by bill_date, id", s.id)) {
    if (left <= 0) break;
    const pay = Math.min(left, p.due_amount);
    insert(p.id, pay);
    ctx.db.run("update purchases set due_amount = due_amount - ?, paid_total = paid_total + ? where id = ?", pay, pay, p.id);
    left -= pay;
  }
  if (left > 0) throw new Error("supplier balance does not match unpaid purchases");
  ctx.db.run("update suppliers set balance = balance - ? where id = ?", a.amount, s.id);
  audit(ctx, "supplier.pay", "supplier", s.id, { amount: a.amount });
  return { balance: s.balance - a.amount, duplicate: false };
});

export function supplierLedger(ctx: Ctx, supplierId: number, from?: string | null, to?: string | null) {
  const s = ctx.db.get<Party>("select * from suppliers where id = ?", supplierId);
  if (!s) throw new AppError("Supplier not found.", "not_found");
  // From our side: a purchase is a credit to the supplier (we owe more); a payment is a debit.
  // To keep "balance = what we owe" positive, purchases go in the debit column here, like invoices do for customers.
  const rows: Omit<LedgerEntry, "balance">[] = [];
  if (s.opening_balance > 0) rows.push({ date: "0000-00-00", at: "", type: "Opening balance", ref: "", debit: s.opening_balance, credit: 0 });
  for (const p of ctx.db.all<{ id: number; bill_no: string | null; bill_date: string; created_at: string; grand_total: number; status: string; cancelled_at: string | null }>("select * from purchases where supplier_id = ?", supplierId)) {
    const ref = p.bill_no ?? `Purchase #${p.id}`;
    rows.push({ date: p.bill_date, at: p.created_at, type: "Purchase", ref, debit: p.grand_total, credit: 0 });
    if (p.status === "cancelled" && p.cancelled_at) rows.push({ date: p.bill_date, at: p.cancelled_at, type: "Purchase cancelled", ref, debit: 0, credit: p.grand_total });
  }
  for (const p of ctx.db.all<{ kind: string; method: string; amount: number; paid_on: string; created_at: string; reference: string | null }>("select * from supplier_payments where supplier_id = ?", supplierId)) {
    const ref = [p.method.toUpperCase(), p.reference].filter(Boolean).join(" · ");
    if (p.kind === "refund") rows.push({ date: p.paid_on, at: p.created_at, type: "Refund received", ref, debit: p.amount, credit: 0 });
    else rows.push({ date: p.paid_on, at: p.created_at, type: "Payment made", ref, debit: 0, credit: p.amount });
  }
  return { party: s, ...finishLedger(rows, from, to) };
}
define("suppliers.ledger", MANAGERS, z.object({ supplier_id: zId, from: zDate.nullish(), to: zDate.nullish() }), (ctx, a) => supplierLedger(ctx, a.supplier_id, a.from, a.to));

// ------------------------------------------------------------------- expenses
define("expenses.list", MANAGERS, z.object({ from: zDate, to: zDate }), (ctx, a) =>
  ctx.db.all(`select e.*, c.name as category_name, u.display_name as user_name from expenses e left join expense_categories c on c.id = e.category_id
              left join users u on u.id = e.created_by where e.spent_on between ? and ? order by e.spent_on desc, e.id desc`, a.from, a.to));
define("expenses.save", MANAGERS, z.object({ id: zId.nullish(), category_id: zId.nullish(), amount: zMoney.min(1, "Enter the amount"), method: zMethod, spent_on: zDate, note: zOptText(200) }), (ctx, a) => {
  if (a.spent_on > ctx.today) throw new AppError("The date cannot be in the future.");
  if (a.id) ctx.db.run("update expenses set category_id = ?, amount = ?, method = ?, spent_on = ?, note = ? where id = ?", a.category_id ?? null, a.amount, a.method, a.spent_on, a.note, a.id);
  else a.id = ctx.db.run("insert into expenses (category_id, amount, method, spent_on, note, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    a.category_id ?? null, a.amount, a.method, a.spent_on, a.note, ctx.user.id, ctx.now.toISOString()).id;
  audit(ctx, "expense.save", "expense", a.id, { amount: a.amount });
  return { id: a.id };
});
define("expenses.delete", MANAGERS, z.object({ id: zId }), (ctx, a) => {
  const e = ctx.db.get("select * from expenses where id = ?", a.id);
  if (!e) throw new AppError("Expense not found.", "not_found");
  ctx.db.run("delete from expenses where id = ?", a.id);
  audit(ctx, "expense.delete", "expense", a.id, e);
});
