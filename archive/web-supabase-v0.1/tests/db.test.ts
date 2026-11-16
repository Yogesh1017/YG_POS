// Integration tests for the database layer: they apply the real migrations to a
// scratch PostgreSQL database and call the functions as different signed-in users,
// with Row Level Security active (role "authenticated", JWT claims set per call).
//
// Needs a local PostgreSQL 15+ server. Set TEST_DATABASE_URL to an admin connection
// (default postgres://postgres:postgres@127.0.0.1:5432/postgres). Skipped if unreachable.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { computeSale, type LineInput } from "@/lib/tax";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = "ygpos_test";
const root = path.resolve(import.meta.dirname, "..");

pg.types.setTypeParser(1700, (v) => v); // numeric stays a string: compare exactly

let reachable = true;
try {
  const probe = new pg.Client({ connectionString: ADMIN_URL });
  await probe.connect();
  await probe.end();
} catch {
  reachable = false;
  console.warn("PostgreSQL not reachable — database tests skipped.");
}

let pool: pg.Pool;

/** Run fn in a transaction as the given signed-in user (or anonymous when uid is null). */
async function as<T>(uid: string | null, fn: (q: pg.ClientBase["query"]) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${uid ? "authenticated" : "anon"}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [uid ? JSON.stringify({ sub: uid }) : ""]);
    const out = await fn(client.query.bind(client) as pg.ClientBase["query"]);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
const rpc = async <T = any>(uid: string | null, sql: string, params: unknown[] = []): Promise<T> =>
  as(uid, async (q) => (await q(`select ${sql} as r`, params)).rows[0].r as T);
const rows = async <T = any>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> =>
  as(uid, async (q) => (await q(sql, params)).rows as T[]);
const admin = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await pool.query(sql, params)).rows as T[];

async function newUser(email: string): Promise<string> {
  return (await admin(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
}
async function newProduct(uid: string, bid: string, p: Record<string, unknown>): Promise<string> {
  const cols = { business_id: bid, name: "Item", sale_price: 100, ...p };
  const keys = Object.keys(cols);
  const r = await rows(uid, `insert into products (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(cols));
  return r[0].id;
}
const stockOf = async (id: string) => (await admin(`select stock_qty from products where id = $1`, [id]))[0].stock_qty;

describe.skipIf(!reachable)("database", () => {
  let owner: string, cashier: string, manager: string, outsider: string;
  let shop: string, otherShop: string;
  let soap: string, rice: string, service: string;
  let customer: string;

  beforeAll(async () => {
    const adminClient = new pg.Client({ connectionString: ADMIN_URL });
    await adminClient.connect();
    await adminClient.query(`drop database if exists ${DB_NAME} with (force)`);
    await adminClient.query(`create database ${DB_NAME}`);
    await adminClient.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DB_NAME}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    await pool.query(readFileSync(path.join(root, "supabase/tests/supabase_shim.sql"), "utf8"));
    const dir = path.join(root, "supabase/migrations");
    for (const f of readdirSync(dir).sort()) await pool.query(readFileSync(path.join(dir, f), "utf8"));

    owner = await newUser("owner@shop.test");
    cashier = await newUser("cashier@shop.test");
    manager = await newUser("manager@shop.test");
    outsider = await newUser("outsider@else.test");

    shop = await rpc(owner, `create_business($1)`, [{
      name: "Gupta General Store", gst_registered: true, gstin: "27AAPFU0939F1ZV", state_code: "27", owner_name: "Yogesh",
    }]);
    otherShop = await rpc(outsider, `create_business($1)`, [{ name: "Someone Else's Shop" }]);
    await rpc(owner, `add_member($1, $2, 'cashier', 'Cashier')`, [shop, "cashier@shop.test"]);
    await rpc(owner, `add_member($1, $2, 'manager', 'Manager')`, [shop, "MANAGER@shop.test"]);

    soap = await newProduct(owner, shop, { name: "Soap", sale_price: 118, purchase_price: 80, tax_rate: 18, price_includes_tax: true, hsn_code: "3401" });
    rice = await newProduct(owner, shop, { name: "Rice loose", unit: "kg", sale_price: 62.5, purchase_price: 50, tax_rate: 5, price_includes_tax: false });
    service = await newProduct(owner, shop, { name: "Gift wrap", sale_price: 20, tax_rate: 18, track_stock: false });
    await rpc(owner, `adjust_stock($1, 50, 'opening')`, [soap]);
    await rpc(owner, `adjust_stock($1, 25.5, 'opening')`, [rice]);
    customer = (await rows(cashier, `insert into customers (business_id, name, phone) values ($1, 'Ramesh', '9876543210') returning id`, [shop]))[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const sale = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(), business_id: shop,
    items: [{ product_id: soap, qty: 2, unit_price: 118 }],
    payments: [{ method: "cash", amount: 236 }],
    ...over,
  });

  describe("business isolation (RLS)", () => {
    it("members see only their own business", async () => {
      expect((await rows(owner, `select id from businesses`)).map((r) => r.id)).toEqual([shop]);
      expect((await rows(outsider, `select id from businesses`)).map((r) => r.id)).toEqual([otherShop]);
      expect(await rows(outsider, `select id from products`)).toEqual([]);
      expect(await rows(outsider, `select id from customers`)).toEqual([]);
      expect(await rows(outsider, `select user_id from business_members where business_id = $1`, [shop])).toEqual([]);
    });
    it("anonymous visitors can read nothing and call nothing", async () => {
      await expect(rows(null, `select id from products`)).rejects.toThrow(/permission denied/);
      await expect(rpc(null, `create_sale($1)`, [sale()])).rejects.toThrow(/permission denied/);
    });
    it("an outsider cannot write into another business", async () => {
      await expect(newProduct(outsider, shop, { name: "Planted" })).rejects.toThrow(/row-level security/);
      await expect(rpc(outsider, `create_sale($1)`, [sale()])).rejects.toThrow(/do not have access/);
      await expect(rpc(outsider, `adjust_stock($1, 5, 'stock_in')`, [soap])).rejects.toThrow(/not found/);
      expect((await rows(outsider, `update products set sale_price = 1 where id = $1 returning id`, [soap])).length).toBe(0);
    });
    it("a product cannot be sold through another business's bill", async () => {
      const theirs = await newProduct(outsider, otherShop, { name: "Theirs" });
      await expect(rpc(owner, `create_sale($1)`, [sale({ items: [{ product_id: theirs, qty: 1, unit_price: 100 }], payments: [] })]))
        .rejects.toThrow(/product not found/);
    });
    it("financial tables and stock levels cannot be written directly", async () => {
      await expect(rows(owner, `update products set stock_qty = 999 where id = $1`, [soap])).rejects.toThrow(/permission denied/);
      await expect(rows(owner, `update customers set balance = 0 where id = $1`, [customer])).rejects.toThrow(/permission denied/);
      await expect(rows(owner, `insert into payments (business_id, kind, method, amount, created_by) values ($1,'sale','cash',5,$2)`, [shop, owner])).rejects.toThrow(/permission denied/);
      await expect(rows(owner, `delete from sales`)).rejects.toThrow(/permission denied/);
      await expect(rows(owner, `select * from invoice_counters`)).rejects.toThrow(/permission denied/);
      await expect(rpc(owner, `next_doc_no($1, 'invoice', '26-27')`, [shop])).rejects.toThrow(/permission denied/);
    });
  });

  describe("roles", () => {
    it("cashier can bill but not edit the catalog, stock, settings or reports", async () => {
      expect((await rpc(cashier, `create_sale($1)`, [sale()])).invoice_no).toMatch(/^INV\/\d\d-\d\d\/\d+$/);
      await expect(newProduct(cashier, shop, { name: "X" })).rejects.toThrow(/row-level security/);
      expect((await rows(cashier, `update products set sale_price = 1 where id = $1 returning id`, [soap])).length).toBe(0);
      await expect(rpc(cashier, `adjust_stock($1, 5, 'stock_in')`, [soap])).rejects.toThrow(/owner or manager/);
      expect((await rows(cashier, `update businesses set name = 'Hacked' where id = $1 returning id`, [shop])).length).toBe(0);
      await expect(rpc(cashier, `report_summary($1, current_date, current_date)`, [shop])).rejects.toThrow(/owner or manager/);
      await expect(rpc(cashier, `add_member($1, 'outsider@else.test', 'manager', 'X')`, [shop])).rejects.toThrow(/Only the owner/);
    });
    it("manager can edit products but not business settings or staff", async () => {
      expect((await rows(manager, `update products set description = 'bar soap' where id = $1 returning id`, [soap])).length).toBe(1);
      expect((await rows(manager, `update businesses set name = 'Hacked' where id = $1 returning id`, [shop])).length).toBe(0);
      await expect(rpc(manager, `set_member($1, $2, 'manager', true)`, [shop, cashier])).rejects.toThrow(/Only the owner/);
    });
    it("a deactivated staff member loses access immediately", async () => {
      await rpc(owner, `set_member($1, $2, 'cashier', false)`, [shop, cashier]);
      expect(await rows(cashier, `select id from products`)).toEqual([]);
      await expect(rpc(cashier, `create_sale($1)`, [sale()])).rejects.toThrow(/do not have access/);
      await rpc(owner, `set_member($1, $2, 'cashier', true)`, [shop, cashier]);
      expect((await rows(cashier, `select id from products`)).length).toBeGreaterThan(0);
    });
    it("nobody can be made a second owner, and the owner cannot be demoted", async () => {
      await expect(rpc(owner, `add_member($1, 'cashier@shop.test', 'owner', 'X')`, [shop])).rejects.toThrow(/one owner/);
      await expect(rpc(owner, `set_member($1, $2, 'cashier', true)`, [shop, owner])).rejects.toThrow(/not found/);
    });
  });

  describe("create_sale", () => {
    it("computes GST-inclusive totals, splits CGST/SGST, reduces stock and numbers the invoice", async () => {
      const before = Number(await stockOf(soap));
      const s = sale();
      const r = await rpc(cashier, `create_sale($1)`, [s]);
      expect(r).toMatchObject({ taxable_total: 200, cgst_total: 18, sgst_total: 18, igst_total: 0, grand_total: 236, paid_total: 236, due_amount: 0, duplicate: false });
      expect(Number(await stockOf(soap))).toBe(before - 2);
      const [item] = await admin(`select * from sale_items where sale_id = $1`, [s.id]);
      expect(item).toMatchObject({ name: "Soap", hsn_code: "3401", unit_cost: "80.00", taxable_value: "200.00", line_total: "236.00" });
      const [mv] = await admin(`select qty_change, reason from stock_movements where ref_id = $1`, [s.id]);
      expect(mv).toMatchObject({ qty_change: "-2.000", reason: "sale" });
    });

    it("is idempotent: replaying a sale neither double-bills nor double-deducts stock", async () => {
      const s = sale();
      const first = await rpc(cashier, `create_sale($1)`, [s]);
      const stock = await stockOf(soap);
      const again = await rpc(cashier, `create_sale($1)`, [s]);
      expect(again.duplicate).toBe(true);
      expect(again.invoice_no).toBe(first.invoice_no);
      expect(await stockOf(soap)).toBe(stock);
      expect((await admin(`select count(*)::int as n from payments where sale_id = $1`, [s.id]))[0].n).toBe(1);
    });

    it("stays idempotent when the same sale is submitted concurrently", async () => {
      const s = sale();
      const stock = Number(await stockOf(soap));
      const results = await Promise.all(Array.from({ length: 6 }, () => rpc(cashier, `create_sale($1)`, [s])));
      expect(results.filter((r) => !r.duplicate).length).toBe(1);
      expect(new Set(results.map((r) => r.invoice_no)).size).toBe(1);
      expect(Number(await stockOf(soap))).toBe(stock - 2);
    });

    it("gives concurrent different sales distinct, gapless invoice numbers", async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => rpc(cashier, `create_sale($1)`, [sale()])));
      const nums = results.map((r) => Number(r.invoice_no.split("/")[2])).sort((a, b) => a - b);
      expect(new Set(nums).size).toBe(12);
      expect(nums[11] - nums[0]).toBe(11);
    });

    it("a failed sale leaves nothing behind (no invoice number gap, no stock change)", async () => {
      const [{ last_no }] = await admin(`select last_no from invoice_counters where business_id = $1 and series = 'invoice'`, [shop]);
      const stock = await stockOf(soap);
      const bad = sale({ payments: [{ method: "cash", amount: 9999 }] });
      await expect(rpc(cashier, `create_sale($1)`, [bad])).rejects.toThrow(/more than the bill total/);
      expect(await admin(`select id from sales where id = $1`, [bad.id])).toEqual([]);
      expect(await stockOf(soap)).toBe(stock);
      expect((await admin(`select last_no from invoice_counters where business_id = $1 and series = 'invoice'`, [shop]))[0].last_no).toBe(last_no);
    });

    it("ignores totals sent by the client and records the mismatch", async () => {
      const s = sale({ client_total: 1, grand_total: 1, tax_total: 0 });
      const r = await rpc(cashier, `create_sale($1)`, [s]);
      expect(r.grand_total).toBe(236);
      const audit = await admin(`select details from audit_log where entity_id = $1 and action = 'sale.total_mismatch'`, [s.id]);
      expect(audit.length).toBe(1);
    });

    it("audits a billed price that differs from the catalog", async () => {
      const s = sale({ items: [{ product_id: soap, qty: 1, unit_price: 100 }], payments: [{ method: "upi", amount: 100 }] });
      await rpc(cashier, `create_sale($1)`, [s]);
      const [a] = await admin(`select details from audit_log where entity_id = $1 and action like 'sale.price%'`, [s.id]);
      expect(a.details[0]).toMatchObject({ catalog_price: 118, billed_price: 100 });
    });

    it("rejects bad input", async () => {
      const bad = (items: unknown[], payments: unknown[] = []) => rpc(cashier, `create_sale($1)`, [sale({ items, payments })]);
      await expect(bad([])).rejects.toThrow(/at least one item/);
      await expect(bad([{ product_id: soap, qty: 0, unit_price: 118 }])).rejects.toThrow(/invalid quantity/);
      await expect(bad([{ product_id: soap, qty: -1, unit_price: 118 }])).rejects.toThrow(/invalid quantity/);
      await expect(bad([{ product_id: soap, qty: 1.0001, unit_price: 118 }])).rejects.toThrow(/invalid quantity/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: -5 }])).rejects.toThrow(/invalid price/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: 1.005 }])).rejects.toThrow(/invalid price/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: 118, discount: 200 }])).rejects.toThrow(/invalid discount/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: 118, tax_rate: 150 }])).rejects.toThrow(/invalid tax rate/);
      await expect(bad([{ product_id: randomUUID(), qty: 1, unit_price: 1 }])).rejects.toThrow(/product not found/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: 118 }], [{ method: "cash", amount: -1 }])).rejects.toThrow(/Invalid payment/);
      await expect(bad([{ product_id: soap, qty: 1, unit_price: 118 }], [{ method: "bitcoin", amount: 1 }])).rejects.toThrow(/payment_method/);
    });

    it("supports split payments", async () => {
      const s = sale({ payments: [{ method: "cash", amount: 100 }, { method: "upi", amount: 136, reference: "UTR123" }] });
      const r = await rpc(cashier, `create_sale($1)`, [s]);
      expect(r).toMatchObject({ paid_total: 236, due_amount: 0 });
      const pays = await admin(`select method, amount, reference from payments where sale_id = $1 order by amount`, [s.id]);
      expect(pays).toEqual([{ method: "cash", amount: "100.00", reference: null }, { method: "upi", amount: "136.00", reference: "UTR123" }]);
    });

    it("credit sale needs a customer and raises their balance", async () => {
      await expect(rpc(cashier, `create_sale($1)`, [sale({ payments: [{ method: "cash", amount: 100 }] })])).rejects.toThrow(/customer must be selected/);
      const r = await rpc(cashier, `create_sale($1)`, [sale({ customer_id: customer, payments: [{ method: "cash", amount: 100 }] })]);
      expect(r).toMatchObject({ paid_total: 100, due_amount: 136 });
      expect((await admin(`select balance from customers where id = $1`, [customer]))[0].balance).toBe("136.00");
    });

    it("charges IGST when the place of supply is another state", async () => {
      const r = await rpc(cashier, `create_sale($1)`, [sale({ place_of_supply: "29" })]);
      expect(r).toMatchObject({ cgst_total: 0, sgst_total: 0, igst_total: 36, grand_total: 236 });
    });

    it("does not track stock for untracked items and allows selling below zero stock", async () => {
      const s = sale({ items: [{ product_id: service, qty: 1, unit_price: 20 }, { product_id: rice, qty: 100, unit_price: 62.5 }], payments: [] , customer_id: customer });
      await rpc(cashier, `create_sale($1)`, [s]);
      expect((await admin(`select count(*)::int as n from stock_movements where ref_id = $1`, [s.id]))[0].n).toBe(1);
      expect(Number(await stockOf(rice))).toBe(25.5 - 100);
      await rpc(owner, `cancel_sale($1, 'test cleanup')`, [s.id]);
      expect(Number(await stockOf(rice))).toBe(25.5);
    });

    it("a business not registered for GST never charges tax, whatever the client sends", async () => {
      const p = await newProduct(outsider, otherShop, { name: "Tea", sale_price: 10, tax_rate: 18 });
      const r = await rpc(outsider, `create_sale($1)`, [{ id: randomUUID(), business_id: otherShop, items: [{ product_id: p, qty: 3, unit_price: 10, tax_rate: 28 }], payments: [{ method: "cash", amount: 30 }] }]);
      expect(r).toMatchObject({ tax_total: 0, taxable_total: 30, grand_total: 30 });
    });

    it("numbers invoices by Indian financial year of the sale date", async () => {
      const r = await rpc(cashier, `create_sale($1)`, [sale({ sold_at: "2025-03-31T23:00:00+05:30" })]);
      expect(r.invoice_no).toBe("INV/24-25/1");
      const r2 = await rpc(cashier, `create_sale($1)`, [sale({ sold_at: "2025-04-01T00:30:00+05:30" })]);
      expect(r2.invoice_no).toBe("INV/25-26/1");
    });

    it("matches the client-side arithmetic on randomised bills (TS and SQL agree to the paisa)", async () => {
      let seed = 42;
      const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
      const products = [soap, rice, service];
      for (let i = 0; i < 150; i++) {
        const interstate = rnd(4) === 0;
        const n = 1 + rnd(6);
        const lines: LineInput[] = [];
        const items: Record<string, unknown>[] = [];
        for (let j = 0; j < n; j++) {
          const qtyMilli = rnd(3) === 0 ? 1 + rnd(9999) : (1 + rnd(12)) * 1000;
          const unitPricePaise = 1 + rnd(250000);
          const taxRateBp = [0, 25, 300, 500, 1200, 1800, 2800][rnd(7)];
          const priceIncludesTax = rnd(2) === 0;
          const gross = Math.round((qtyMilli * unitPricePaise) / 1000);
          const discountPaise = rnd(3) === 0 ? rnd(Math.max(gross - 1, 1)) : 0;
          lines.push({ qtyMilli, unitPricePaise, discountPaise, taxRateBp, priceIncludesTax });
          items.push({ product_id: products[rnd(3)], qty: (qtyMilli / 1000).toFixed(3), unit_price: (unitPricePaise / 100).toFixed(2),
            discount: (discountPaise / 100).toFixed(2), tax_rate: (taxRateBp / 100).toFixed(2), price_includes_tax: priceIncludesTax });
        }
        const t = computeSale(lines, { interstate, roundOff: true });
        // discount is clamped client-side to gross; make the payload reflect that
        t.lines.forEach((l, k) => (items[k].discount = (l.discount / 100).toFixed(2)));
        const r = await rpc(cashier, `create_sale($1)`, [{ id: randomUUID(), business_id: shop, items, payments: [], customer_id: customer,
          place_of_supply: interstate ? "07" : "27", client_total: t.grand / 100 }]);
        const paise = (x: number) => Math.round(x * 100);
        expect({ gross: paise(r.gross_total), discount: paise(r.discount_total), taxable: paise(r.taxable_total), cgst: paise(r.cgst_total),
          sgst: paise(r.sgst_total), igst: paise(r.igst_total), roundOff: paise(r.round_off), grand: paise(r.grand_total) })
          .toEqual({ gross: t.gross, discount: t.discount, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, roundOff: t.roundOff, grand: t.grand });
        await rpc(owner, `cancel_sale($1, 'parity test')`, [r.id]);
      }
      expect((await admin(`select count(*)::int as n from audit_log where action = 'sale.total_mismatch' and details->>'client_total' <> '1'`))[0].n).toBe(0);
    });
  });

  describe("cancel, returns and dues", () => {
    it("only owner/manager can cancel; cancelling restores stock, clears dues and records refunds", async () => {
      const [{ balance: balBefore }] = await admin(`select balance from customers where id = $1`, [customer]);
      const stock = Number(await stockOf(soap));
      const s = sale({ customer_id: customer, payments: [{ method: "cash", amount: 36 }] });
      await rpc(cashier, `create_sale($1)`, [s]);
      await expect(rpc(cashier, `cancel_sale($1, 'mistake')`, [s.id])).rejects.toThrow(/owner or manager/);
      await expect(rpc(outsider, `cancel_sale($1, 'mistake')`, [s.id])).rejects.toThrow(/not found/);
      await expect(rpc(manager, `cancel_sale($1, '')`, [s.id])).rejects.toThrow(/reason is required/);
      await rpc(manager, `cancel_sale($1, 'billed twice')`, [s.id]);
      expect(Number(await stockOf(soap))).toBe(stock);
      expect((await admin(`select balance from customers where id = $1`, [customer]))[0].balance).toBe(balBefore);
      const [row] = await admin(`select status, due_amount, invoice_no, cancel_reason from sales where id = $1`, [s.id]);
      expect(row).toMatchObject({ status: "cancelled", due_amount: "0.00", cancel_reason: "billed twice" });
      expect(row.invoice_no).toBeTruthy();
      expect(await admin(`select kind, method, amount from payments where sale_id = $1 and kind = 'refund'`, [s.id])).toEqual([{ kind: "refund", method: "cash", amount: "36.00" }]);
      expect((await rpc(manager, `cancel_sale($1, 'again')`, [s.id])).duplicate).toBe(true); // idempotent
      expect(Number(await stockOf(soap))).toBe(stock);
    });

    it("partial returns refund proportionally, restock, and never exceed what was sold", async () => {
      const s = sale({ items: [{ product_id: soap, qty: 3, unit_price: 33.33 }], payments: [{ method: "cash", amount: 100 }] });
      const created = await rpc(cashier, `create_sale($1)`, [s]); // 99.99 -> rounds to 100
      expect(created.grand_total).toBe(100);
      const stock = Number(await stockOf(soap));
      const [item] = await admin(`select id from sale_items where sale_id = $1`, [s.id]);
      const ret = (qty: number, extra = {}) => ({ id: randomUUID(), sale_id: s.id, items: [{ sale_item_id: item.id, qty }], refund_method: "cash", restock: true, ...extra });

      await expect(rpc(cashier, `create_return($1)`, [ret(1)])).rejects.toThrow(/owner or manager/);
      await expect(rpc(manager, `create_return($1)`, [ret(4)])).rejects.toThrow(/only 3\.000 left/);

      const r1p = ret(1);
      const r1 = await rpc(manager, `create_return($1)`, [r1p]);
      expect(r1).toMatchObject({ total: 33.33, refund_paid: 33.33, due_reduced: 0 });
      expect(r1.credit_note_no).toMatch(/^CN\/\d\d-\d\d\/1$/);
      expect((await rpc(manager, `create_return($1)`, [r1p])).duplicate).toBe(true);
      expect(Number(await stockOf(soap))).toBe(stock + 1);

      const r2 = await rpc(manager, `create_return($1)`, [ret(2, { restock: false })]);
      expect(r2.total).toBe(66.66); // remainder of the line, no rounding drift
      expect(Number(await stockOf(soap))).toBe(stock + 1); // damaged goods are not restocked
      await expect(rpc(manager, `create_return($1)`, [ret(1)])).rejects.toThrow(/only 0\.000 left/);
      const [{ refunded }] = await admin(`select sum(amount) as refunded from payments where sale_id = $1 and kind = 'refund'`, [s.id]);
      expect(refunded).toBe("99.99");
      await expect(rpc(owner, `cancel_sale($1, 'nope')`, [s.id])).rejects.toThrow(/already has returns/);
    });

    it("a return on an unpaid bill reduces the due before refunding cash", async () => {
      const c = (await rows(owner, `insert into customers (business_id, name) values ($1, 'Sita') returning id`, [shop]))[0].id;
      const s = sale({ customer_id: c, payments: [{ method: "cash", amount: 36 }] }); // 236 bill, 200 due
      await rpc(cashier, `create_sale($1)`, [s]);
      const [item] = await admin(`select id from sale_items where sale_id = $1`, [s.id]);
      const r = await rpc(owner, `create_return($1)`, [{ id: randomUUID(), sale_id: s.id, items: [{ sale_item_id: item.id, qty: 1 }], restock: true }]);
      expect(r).toMatchObject({ total: 118, due_reduced: 118, refund_paid: 0 });
      expect((await admin(`select balance from customers where id = $1`, [c]))[0].balance).toBe("82.00");
    });

    it("collects dues oldest bill first, idempotently, and never more than is owed", async () => {
      const c = (await rows(owner, `insert into customers (business_id, name) values ($1, 'Mohan') returning id`, [shop]))[0].id;
      const a = sale({ customer_id: c, payments: [], sold_at: "2026-05-01T10:00:00+05:30" });
      const b = sale({ customer_id: c, payments: [], sold_at: "2026-05-02T10:00:00+05:30" });
      await rpc(cashier, `create_sale($1)`, [b]);
      await rpc(cashier, `create_sale($1)`, [a]);
      await expect(rpc(cashier, `record_customer_payment($1, $2, 500, 'cash')`, [randomUUID(), c])).rejects.toThrow(/more than the customer owes/);
      const pid = randomUUID();
      expect(await rpc(cashier, `record_customer_payment($1, $2, 300, 'upi')`, [pid, c])).toMatchObject({ balance: 172, duplicate: false });
      expect(await rpc(cashier, `record_customer_payment($1, $2, 300, 'upi')`, [pid, c])).toMatchObject({ balance: 172, duplicate: true });
      const dues = await admin(`select id, due_amount, paid_total from sales where id in ($1, $2)`, [a.id, b.id]);
      expect(dues.find((d) => d.id === a.id)).toMatchObject({ due_amount: "0.00", paid_total: "236.00" });
      expect(dues.find((d) => d.id === b.id)).toMatchObject({ due_amount: "172.00", paid_total: "64.00" });
      await expect(rpc(outsider, `record_customer_payment($1, $2, 1, 'cash')`, [randomUUID(), c])).rejects.toThrow(/not found/);
    });

    it("customer balance always equals the sum of unpaid dues on their bills", async () => {
      const bad = await admin(`
        select c.id from customers c
        left join (select customer_id, sum(due_amount) d from sales where status = 'completed' group by 1) s on s.customer_id = c.id
        where c.balance <> coalesce(s.d, 0)`);
      expect(bad).toEqual([]);
    });
  });

  describe("inventory", () => {
    it("stock level always equals the sum of its movements", async () => {
      const bad = await admin(`
        select p.id from products p
        left join (select product_id, sum(qty_change) q from stock_movements group by 1) m on m.product_id = p.id
        where p.stock_qty <> coalesce(m.q, 0)`);
      expect(bad).toEqual([]);
    });
    it("validates manual adjustments", async () => {
      await expect(rpc(owner, `adjust_stock($1, -5, 'stock_in')`, [soap])).rejects.toThrow(/must be positive/);
      await expect(rpc(owner, `adjust_stock($1, 5, 'damage')`, [soap])).rejects.toThrow(/must reduce stock/);
      await expect(rpc(owner, `adjust_stock($1, 5, 'sale')`, [soap])).rejects.toThrow(/reserved/);
      await expect(rpc(owner, `adjust_stock($1, 0, 'adjustment')`, [soap])).rejects.toThrow(/Invalid quantity/);
      await expect(rpc(owner, `adjust_stock($1, 5, 'stock_in')`, [service])).rejects.toThrow(/tracking is turned off/);
    });
    it("stock-in with a unit cost updates the purchase price", async () => {
      const before = Number(await stockOf(soap));
      expect(Number(await rpc(manager, `adjust_stock($1, 10, 'stock_in', 'new carton', 82.5)`, [soap]))).toBe(before + 10);
      expect((await admin(`select purchase_price from products where id = $1`, [soap]))[0].purchase_price).toBe("82.50");
      await rpc(manager, `adjust_stock($1, -1, 'damage', 'broken')`, [soap]);
      expect(Number(await stockOf(soap))).toBe(before + 9);
    });
    it("a product with sales cannot be deleted, an unsold one can", async () => {
      await expect(rows(owner, `delete from products where id = $1`, [soap])).rejects.toThrow(/foreign key/);
      const tmp = await newProduct(owner, shop, { name: "Temp" });
      await rpc(owner, `adjust_stock($1, 3, 'opening')`, [tmp]);
      expect((await rows(owner, `delete from products where id = $1 returning id`, [tmp])).length).toBe(1);
    });
    it("enforces unique barcode and SKU within a business", async () => {
      await newProduct(owner, shop, { name: "A", barcode: "8901234567890", sku: "SKU-1" });
      await expect(newProduct(owner, shop, { name: "B", barcode: "8901234567890" })).rejects.toThrow(/duplicate key/);
      await expect(newProduct(owner, shop, { name: "C", sku: "sku-1" })).rejects.toThrow(/duplicate key/);
      await newProduct(outsider, otherShop, { name: "D", barcode: "8901234567890" }); // other shops may reuse it
    });
  });

  describe("business settings", () => {
    it("requires a GSTIN matching the state when GST-registered", async () => {
      await expect(rows(owner, `update businesses set gstin = null where id = $1`, [shop])).rejects.toThrow(/gst_details_required/);
      await expect(rows(owner, `update businesses set state_code = '29' where id = $1`, [shop])).rejects.toThrow(/gst_details_required/);
      await expect(rows(owner, `update businesses set gstin = 'BADGSTIN' where id = $1`, [shop])).rejects.toThrow(/check constraint/);
    });
  });

  describe("report_summary", () => {
    it("separates revenue, tax and gross profit, net of cancellations and returns", async () => {
      const u = await newUser("report@shop.test");
      const b = await rpc(u, `create_business($1)`, [{ name: "Report Shop", gst_registered: true, gstin: "27AAPFU0939F1ZV", state_code: "27" }]);
      const p = await newProduct(u, b, { name: "Pen", sale_price: 118, purchase_price: 60, tax_rate: 18, price_includes_tax: true });
      await rpc(u, `adjust_stock($1, 100, 'opening')`, [p]);
      const mk = (qty: number) => ({ id: randomUUID(), business_id: b, items: [{ product_id: p, qty, unit_price: 118 }], payments: [{ method: "cash", amount: 118 * qty }] });
      const s1 = mk(5), s2 = mk(2), s3 = mk(1);
      for (const s of [s1, s2, s3]) await rpc(u, `create_sale($1)`, [s]);
      await rpc(u, `cancel_sale($1, 'void for test')`, [s3.id]);
      const [item] = await admin(`select id from sale_items where sale_id = $1`, [s2.id]);
      await rpc(u, `create_return($1)`, [{ id: randomUUID(), sale_id: s2.id, items: [{ sale_item_id: item.id, qty: 1 }], refund_method: "cash", restock: true }]);

      const r = await rpc(u, `report_summary($1, (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date)`, [b]);
      expect(r.sales).toMatchObject({ count: 2, billed_total: 826, taxable_total: 700, tax_total: 126, cost_total: 420 });
      expect(r.returns).toMatchObject({ count: 1, total: 118, taxable_total: 100, cost_total: 60 });
      expect(r.revenue).toBe(600);            // 700 - 100, tax excluded
      expect(r.gross_profit).toBe(240);       // 600 - (420 - 60)
      expect(r.cancelled_count).toBe(1);
      expect(r.by_method).toEqual([{ method: "cash", received: 944, refunded: 236 }]);
      expect(r.gst_by_rate).toEqual([{ tax_rate: 18, taxable: 700, cgst: 63, sgst: 63, igst: 0 }]);
      expect(r.top_products[0]).toMatchObject({ name: "Pen", qty: 7 });
      expect(r.stock_value).toBe((100 - 7 + 1) * 60);
      await expect(rpc(u, `report_summary($1, '2026-02-01', '2026-01-01')`, [b])).rejects.toThrow(/Invalid date range/);
    });
  });
});
