import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCore, type Core } from "../desktop/core";

export const R = (rupees: number): number => Math.round(rupees * 100);          // rupees -> paise
export const Q = (qty: number): number => Math.round(qty * 1000);              // quantity -> thousandths
export const C4 = (rupees: number): number => Math.round(rupees * 10000);      // cost per base unit
export const ref = () => randomUUID();

export interface Shop {
  core: Core; dir: string; setDate: (iso: string) => void;
  owner: string; manager: string; cashier: string; recoveryKey: string;
  ok: <T = any>(token: string | null, method: string, args?: unknown) => T;
  fail: (token: string | null, method: string, args?: unknown) => { code: string; message: string; data?: any };
  sql: <T = any>(q: string, ...p: (string | number)[]) => T[];
}

export const BUSINESS = { business_name: "Gupta Ice Cream Agency", address: "12 Market Road", city: "Pune", pincode: "411001", state_code: "27", gst_registered: true, gstin: "27AAPFU0939F1ZV" };

/** A fresh shop in a temporary folder, with an owner, a manager and a cashier signed in. */
export function newShop(business: Record<string, unknown> = BUSINESS, startDate = "2026-11-16T10:00:00"): Shop {
  const dir = mkdtempSync(path.join(tmpdir(), "ygpos-test-"));
  let now = new Date(startDate);
  const core = createCore({ dataDir: dir, clock: () => new Date(now) });
  const ok = <T,>(token: string | null, method: string, args: unknown = {}): T => {
    const r = core.call(method, args, token);
    if (!r.ok) throw new Error(`${method} failed: [${r.error.code}] ${r.error.message}`);
    return r.data as T;
  };
  const fail = (token: string | null, method: string, args: unknown = {}) => {
    const r = core.call(method, args, token);
    if (r.ok) throw new Error(`${method} was expected to fail but succeeded`);
    return r.error;
  };
  const setup = ok<{ token: string; recovery_key: string }>(null, "setup.create", { username: "yogesh", display_name: "Yogesh", password: "owner-pass", business });
  ok(setup.token, "users.create", { username: "meena", display_name: "Meena", role: "manager", password: "manager-pass" });
  ok(setup.token, "users.create", { username: "sunil", display_name: "Sunil", role: "cashier", password: "cashier-pass" });
  return {
    core, dir, ok, fail, owner: setup.token, recoveryKey: setup.recovery_key,
    manager: ok<{ token: string }>(null, "auth.login", { username: "meena", password: "manager-pass" }).token,
    cashier: ok<{ token: string }>(null, "auth.login", { username: "sunil", password: "cashier-pass" }).token,
    setDate: (iso) => { now = new Date(iso); },
    sql: (q, ...p) => core.db.all(q, ...p) as never,
  };
}

const PRODUCT = { tax_rate_bp: 1800, price_includes_tax: false, base_unit: "pcs", qty_decimals: 0, track_expiry: false, low_stock_m: 0, cost4: 0, is_active: true, base_price: 0, units: [] };

/** Vanilla cup: base piece ₹10, Box = 10 pcs ₹95, Carton = 120 pcs ₹1080. Cost ₹7 a piece. */
export function cup(shop: Shop, over: Record<string, unknown> = {}) {
  const p = shop.ok<any>(shop.owner, "products.save", {
    ...PRODUCT, name: "Vanilla Cup", pack_size: "100 ml", hsn_code: "2105", cost4: C4(7), base_price: R(10),
    units: [{ name: "Box", factor_m: Q(10), sale_price: R(95) }, { name: "Carton", factor_m: Q(120), sale_price: R(1080) }],
    default_sale_unit: "Carton", ...over,
  });
  const unit = (name: string) => p.units.find((u: any) => u.name === name)?.id as number;
  return { ...p, pcs: unit("pcs"), box: unit("Box"), carton: unit("Carton") };
}
export const product = (shop: Shop, over: Record<string, unknown>) => shop.ok<any>(shop.owner, "products.save", { ...PRODUCT, ...over });
export const customer = (shop: Shop, over: Record<string, unknown> = {}) => shop.ok<any>(shop.owner, "customers.save", { name: "Sharma Kirana", phone: "9876543210", ...over });
export const supplier = (shop: Shop, over: Record<string, unknown> = {}) => shop.ok<any>(shop.owner, "suppliers.save", { name: "Amul Distributor", ...over });
export const addStock = (shop: Shop, productId: number, qty: number, over: Record<string, unknown> = {}) =>
  shop.ok(shop.owner, "stock.adjust", { product_id: productId, mode: "add", qty_m: Q(qty), reason: "opening", ...over });
export const stockOf = (shop: Shop, productId: number): number =>
  shop.ok<any[]>(shop.owner, "products.list").find((p) => p.id === productId).on_hand_m / 1000;

/** Totals that must always hold, whatever happened before. */
export function checkBooks(shop: Shop): string[] {
  const problems: string[] = [];
  for (const p of shop.sql("select id, name, shortfall_m from products")) {
    const batches = shop.sql("select coalesce(sum(qty_m), 0) as q from stock_batches where product_id = ?", p.id)[0].q;
    const moved = shop.sql("select coalesce(sum(qty_m), 0) as q from stock_movements where product_id = ?", p.id)[0].q;
    if (batches - p.shortfall_m !== moved) problems.push(`${p.name}: batches ${batches} - shortfall ${p.shortfall_m} != movements ${moved}`);
  }
  if (shop.sql("select 1 from stock_batches where qty_m < 0").length) problems.push("a batch is below zero");
  for (const c of shop.sql("select id, name, balance, opening_due from customers")) {
    const due = shop.sql("select coalesce(sum(due_amount), 0) as d from sales where customer_id = ? and status = 'completed'", c.id)[0].d;
    if (c.balance !== c.opening_due + due) problems.push(`${c.name}: balance ${c.balance} != opening due ${c.opening_due} + invoice dues ${due}`);
    const ledger = shop.ok<any>(shop.owner, "customers.ledger", { customer_id: c.id });
    if (ledger.closing !== c.balance) problems.push(`${c.name}: ledger closes at ${ledger.closing}, balance is ${c.balance}`);
  }
  for (const s of shop.sql("select id, name, balance, opening_due from suppliers")) {
    const due = shop.sql("select coalesce(sum(due_amount), 0) as d from purchases where supplier_id = ? and status = 'completed'", s.id)[0].d;
    if (s.balance !== s.opening_due + due) problems.push(`${s.name}: balance ${s.balance} != opening due ${s.opening_due} + purchase dues ${due}`);
    const ledger = shop.ok<any>(shop.owner, "suppliers.ledger", { supplier_id: s.id });
    if (ledger.closing !== s.balance) problems.push(`${s.name}: ledger closes at ${ledger.closing}, balance is ${s.balance}`);
  }
  for (const s of shop.sql("select id, invoice_no, grand_total, paid_total, due_amount, status from sales where status = 'completed'")) {
    const items = shop.sql("select coalesce(sum(line_total), 0) as t from sale_items where sale_id = ?", s.id)[0].t;
    const row = shop.sql("select round_off, returned_total from sales where id = ?", s.id)[0];
    if (items + row.round_off !== s.grand_total) problems.push(`${s.invoice_no}: lines + round-off != total`);
  }
  return problems;
}
