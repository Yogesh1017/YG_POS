import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupNow, createCore, inspectBackup, prune, restoreBackup } from "../desktop/core";
import { MIGRATIONS } from "../desktop/core/migrations";
import { C4, Q, R, addStock, checkBooks, cup, customer, newShop, product, ref, stockOf, supplier } from "./helpers";

const line = (p: any, unit: number, qty: number, price: number) => ({ product_id: p.id, unit_id: unit, qty_m: Q(qty), unit_price: R(price) });
const TODAY = "2026-11-16";

describe("purchases and suppliers", () => {
  it("a purchase adds stock in base units, sets the real cost, and records what is owed", () => {
    const shop = newShop();
    const p = cup(shop, { track_expiry: true, cost4: 0 });
    const s = supplier(shop, { opening_balance: R(1000) });
    const base = { supplier_id: s.id, bill_no: "AM/441", bill_date: TODAY };
    expect(shop.fail(shop.manager, "purchases.create", { ...base, client_ref: ref(), items: [{ product_id: p.id, unit_id: p.carton, qty_m: Q(5), rate: R(840) }] }).message).toMatch(/expiry date for Vanilla Cup/);
    const purchase = { ...base, client_ref: ref(), items: [{ product_id: p.id, unit_id: p.carton, qty_m: Q(5), rate: R(840), batch_no: "B77", mfg_date: "2026-11-01", expiry_date: "2027-05-01" }],
      paid: { amount: R(2000), method: "bank", reference: "NEFT9" } };
    const r = shop.ok<any>(shop.manager, "purchases.create", purchase);
    expect(r).toMatchObject({ taxable_total: R(4200), tax_total: R(756), grand_total: R(4956), paid_total: R(2000), due_amount: R(2956) });
    expect(shop.ok<any>(shop.manager, "purchases.create", purchase).duplicate).toBe(true);
    expect(stockOf(shop, p.id)).toBe(600);                                      // 5 cartons x 120
    const prod = shop.ok<any[]>(shop.owner, "products.list")[0];
    expect(prod.cost4).toBe(C4(7));                                             // 4200 / 600, GST excluded (claimable)
    expect(shop.ok<any[]>(shop.owner, "stock.batches", { product_id: p.id })[0]).toMatchObject({ batch_no: "B77", expiry_date: "2027-05-01", qty_m: 600000 });
    expect(shop.sql("select balance from suppliers")[0].balance).toBe(R(1000 + 2956));
    expect(shop.fail(shop.manager, "purchases.create", { ...purchase, client_ref: ref() }).message).toMatch(/already been entered/);
    expect(shop.fail(shop.cashier, "purchases.create", purchase).code).toBe("forbidden");

    // pay the supplier: opening balance first, then the oldest bill
    expect(shop.fail(shop.manager, "suppliers.pay", { client_ref: ref(), supplier_id: s.id, amount: R(99999), method: "bank" }).message).toMatch(/cannot record more/);
    shop.ok(shop.manager, "suppliers.pay", { client_ref: ref(), supplier_id: s.id, amount: R(1500), method: "bank" });
    expect(shop.sql("select balance, opening_due from suppliers")[0]).toEqual({ balance: R(2456), opening_due: 0 });
    expect(shop.sql("select due_amount from purchases")[0].due_amount).toBe(R(2456));
    expect(checkBooks(shop)).toEqual([]);
  });
  it("buying in one unit and selling in another keeps stock and profit right", () => {
    const shop = newShop();
    const p = cup(shop, { cost4: 0 });
    const s = supplier(shop);
    shop.ok(shop.manager, "purchases.create", { client_ref: ref(), supplier_id: s.id, bill_date: TODAY, items: [{ product_id: p.id, unit_id: p.carton, qty_m: Q(2), rate: R(900) }], paid: { amount: R(2124), method: "cash" } });
    const sale = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 6, 95), line(p, p.pcs, 5, 10)], payments: [{ method: "cash", amount: R(732) }] });
    expect(stockOf(shop, p.id)).toBe(240 - 65);
    expect(sale.cost_total).toBe(R(65 * 7.5));                                  // 900 / 120 = 7.50 a piece
    const r = shop.ok<any>(shop.owner, "reports.summary", { from: TODAY, to: TODAY });
    expect(r.gross_profit).toBe(R(620 - 487.5));
    expect(r.purchases).toMatchObject({ count: 1, total: R(2124) });
  });
  it("a purchase can be cancelled only while none of its stock has moved", () => {
    const shop = newShop();
    const p = cup(shop);
    const s = supplier(shop);
    const mk = () => shop.ok<any>(shop.manager, "purchases.create", { client_ref: ref(), supplier_id: s.id, bill_date: TODAY, items: [{ product_id: p.id, unit_id: p.box, qty_m: Q(10), rate: R(70) }] });
    const a = mk();
    shop.ok(shop.manager, "purchases.cancel", { id: a.id, reason: "Entered twice" });
    expect(stockOf(shop, p.id)).toBe(0);
    expect(shop.sql("select balance from suppliers")[0].balance).toBe(0);
    const b = mk();
    shop.ok(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 1, 10)], payments: [{ method: "cash", amount: R(12) }] });
    expect(shop.fail(shop.manager, "purchases.cancel", { id: b.id, reason: "Mistake" }).message).toMatch(/already been sold or adjusted/);
    expect(checkBooks(shop)).toEqual([]);
  });
});

describe("damaged, melted, expired and returned stock", () => {
  it("write-offs need a reason, leave stock at once, and appear in the wastage report at cost", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 240);
    shop.ok(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(12), reason: "melted", note: "Freezer 2 tripped overnight" });
    shop.ok(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(3), reason: "damaged" });
    expect(stockOf(shop, p.id)).toBe(225);
    expect(shop.fail(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(9999), reason: "damaged" }).message).toMatch(/Not enough stock/);
    expect(shop.fail(shop.manager, "stock.adjust", { product_id: p.id, mode: "add", qty_m: Q(5), reason: "melted" }).message).toMatch(/only be added/);
    const w = shop.ok<any>(shop.owner, "reports.wastage", { from: TODAY, to: TODAY });
    expect(w.by_reason).toEqual(expect.arrayContaining([{ reason: "melted", cost: R(84), entries: 1 }, { reason: "damaged", cost: R(21), entries: 1 }]));
    const r = shop.ok<any>(shop.owner, "reports.summary", { from: TODAY, to: TODAY });
    expect(r).toMatchObject({ wastage: R(105), net_profit: -R(105) });
    // a stock count sets the real figure and records the difference
    expect(shop.ok<any>(shop.manager, "stock.adjust", { product_id: p.id, mode: "set", qty_m: Q(220), reason: "adjustment" }).on_hand_m).toBe(220000);
    expect(shop.ok<any[]>(shop.owner, "stock.movements", { product_id: p.id }).map((m) => [m.reason, m.qty_m])).toEqual([["adjustment", -5000], ["damaged", -3000], ["melted", -12000], ["opening", 240000]]);
    expect(() => shop.core.db.run("delete from stock_movements")).toThrow(/cannot be deleted/);
    expect(checkBooks(shop)).toEqual([]);
  });
  it("a return gives a credit note; good stock goes back to its batch, melted stock becomes wastage", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 600);
    const c = customer(shop);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: c.id, items: [line(p, p.carton, 2, 1080)], payments: [{ method: "cash", amount: R(1000) }] });
    expect(s.due_amount).toBe(R(1549));
    const item = s.items[0].id;
    expect(shop.fail(shop.cashier, "sales.return", {}).code).toBe("forbidden");
    expect(shop.fail(shop.manager, "sales.return", { client_ref: ref(), sale_id: s.id, items: [{ sale_item_id: item, base_qty_m: Q(999), disposition: "restock" }] }).message).toMatch(/Only 240 pcs/);

    // 1 carton + 5 pieces come back: the carton is fine, 5 pieces had melted
    const ret = { client_ref: ref(), sale_id: s.id, reason: "Shop freezer failed", items: [{ sale_item_id: item, base_qty_m: Q(120), disposition: "restock" }] };
    const r1 = shop.ok<any>(shop.manager, "sales.return", ret);
    expect(r1).toMatchObject({ credit_note_no: "CN/26-27/1", total: R(1274.4), due_reduced: R(1274.4), refund_paid: 0 });
    expect(shop.ok<any>(shop.manager, "sales.return", ret).duplicate).toBe(true);
    expect(stockOf(shop, p.id)).toBe(480);
    const r2 = shop.ok<any>(shop.manager, "sales.return", { client_ref: ref(), sale_id: s.id, refund_method: "cash", items: [{ sale_item_id: item, base_qty_m: Q(5), disposition: "melted" }] });
    expect(r2).toMatchObject({ credit_note_no: "CN/26-27/2", total: R(53.1), due_reduced: R(53.1), refund_paid: 0 });
    expect(stockOf(shop, p.id)).toBe(480);                                       // melted goods never re-enter stock
    expect(shop.ok<any>(shop.owner, "reports.wastage", { from: TODAY, to: TODAY }).by_reason).toEqual([{ reason: "melted", cost: R(35), entries: 1 }]);
    expect(shop.sql("select due_amount, returned_total from sales")[0]).toEqual({ due_amount: R(1549 - 1274.4 - 53.1), returned_total: R(1327.5) });
    expect(shop.fail(shop.manager, "sales.cancel", { id: s.id, reason: "Too late" }).message).toMatch(/already has returns/);
    expect(checkBooks(shop)).toEqual([]);
  });
  it("returning everything on a paid bill refunds exactly what was paid, never more", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [{ product_id: p.id, unit_id: p.pcs, qty_m: Q(3), unit_price: R(10) }], payments: [{ method: "cash", amount: R(35) }] }); // 35.40 -> 35
    const item = s.items[0].id;
    const one = () => shop.ok<any>(shop.manager, "sales.return", { client_ref: ref(), sale_id: s.id, refund_method: "cash", items: [{ sale_item_id: item, base_qty_m: Q(1), disposition: "restock" }] });
    expect([one().refund_paid, one().refund_paid, one().refund_paid]).toEqual([R(11.8), R(11.8), R(11.4)]);
    expect(shop.sql("select sum(amount) as a from payments where kind = 'refund'")[0].a).toBe(R(35));
    expect(stockOf(shop, p.id)).toBe(100);
  });
  it("cancelling a bill puts stock back in its batches, clears the due, and records the refund", () => {
    const shop = newShop();
    const p = cup(shop, { track_expiry: true });
    addStock(shop, p.id, 30, { expiry_date: "2027-01-01", batch_no: "A" });
    addStock(shop, p.id, 30, { expiry_date: "2027-02-01", batch_no: "B" });
    const c = customer(shop);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: c.id, items: [line(p, p.pcs, 40, 10)], payments: [{ method: "upi", amount: R(100) }] });
    expect(shop.fail(shop.cashier, "sales.cancel", { id: s.id, reason: "x" }).code).toBe("forbidden");
    expect(shop.fail(shop.manager, "sales.cancel", { id: s.id, reason: "" }).message).toMatch(/reason/);
    const cancelled = shop.ok<any>(shop.manager, "sales.cancel", { id: s.id, reason: "Order withdrawn" });
    expect(cancelled).toMatchObject({ status: "cancelled", due_amount: 0, invoice_no: "INV/26-27/1", cancel_reason: "Order withdrawn" });
    expect(shop.ok<any[]>(shop.owner, "stock.batches", { product_id: p.id }).map((b) => [b.batch_no, b.qty_m])).toEqual([["A", 30000], ["B", 30000]]);
    expect(shop.sql("select kind, method, amount from payments where kind = 'refund'")).toEqual([{ kind: "refund", method: "upi", amount: R(100) }]);
    expect(shop.sql("select balance from customers")[0].balance).toBe(0);
    shop.ok(shop.manager, "sales.cancel", { id: s.id, reason: "again" });        // repeating it changes nothing
    expect(stockOf(shop, p.id)).toBe(60);
    expect(checkBooks(shop)).toEqual([]);
  });
});

describe("reports", () => {
  it("separate revenue, gross profit, wastage, expenses and net profit, and list who owes what", () => {
    const shop = newShop();
    const p = cup(shop);
    const s = supplier(shop);
    shop.ok(shop.manager, "purchases.create", { client_ref: ref(), supplier_id: s.id, bill_date: TODAY, items: [{ product_id: p.id, unit_id: p.carton, qty_m: Q(10), rate: R(840) }] });
    const c = customer(shop);
    const sale = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: c.id, items: [line(p, p.carton, 4, 1080)], payments: [{ method: "cash", amount: R(3000) }] });
    shop.ok(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 2, 95)], payments: [{ method: "upi", amount: R(224) }] });
    shop.ok(shop.manager, "sales.return", { client_ref: ref(), sale_id: sale.id, items: [{ sale_item_id: sale.items[0].id, base_qty_m: Q(120), disposition: "restock" }] });
    shop.ok(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(10), reason: "melted" });
    const cat = shop.ok<any>(shop.owner, "expense_categories.save", { name: "Electricity" });
    shop.ok(shop.manager, "expenses.save", { category_id: cat.id, amount: R(500), method: "cash", spent_on: TODAY, note: "Freezer power" });

    const r = shop.ok<any>(shop.owner, "reports.summary", { from: TODAY, to: TODAY });
    expect(r.sales).toMatchObject({ count: 2, taxable: R(4320 + 190), tax: R(777.6 + 34.2) });
    expect(r.returns).toMatchObject({ count: 1, taxable: R(1080), cost: R(840) });
    expect(r.revenue).toBe(R(4510 - 1080));
    expect(r.gross_profit).toBe(R(3430) - (R(480 * 7 + 20 * 7) - R(840)));     // 3430 - 2660 = 770
    expect(r).toMatchObject({ wastage: R(70), expenses: R(500), net_profit: R(770 - 70 - 500), customer_dues: R(5098 - 3000 - 1274.4), supplier_dues: R(9912) });
    expect(r.by_method).toEqual([{ method: "cash", received: R(3000), refunded: 0 }, { method: "upi", received: R(224), refunded: 0 }]);

    expect(shop.ok<any[]>(shop.owner, "reports.products", { from: TODAY, to: TODAY })[0]).toMatchObject({ name: "Vanilla Cup", sold_base_m: 500000, returned_base_m: 120000 });
    expect(shop.ok<any[]>(shop.owner, "reports.customers", { from: TODAY, to: TODAY }).map((x) => x.name)).toEqual(["Sharma Kirana", "Cash sales"]);
    const out = shop.ok<any>(shop.owner, "reports.outstanding");
    expect(out.customers[0]).toMatchObject({ name: "Sharma Kirana", unpaid_invoices: 1 });
    expect(out.suppliers[0]).toMatchObject({ name: "Amul Distributor", balance: R(9912) });
    expect(shop.ok<any>(shop.owner, "reports.gst", { from: TODAY, to: TODAY })).toMatchObject({ by_rate: [{ tax_rate_bp: 1800, taxable: R(4510) }], input_tax: R(1512) });
    expect(shop.ok<any>(shop.owner, "reports.stock").stock_value).toBe(R((1200 - 500 + 120 - 10) * 7));
    const dash = shop.ok<any>(shop.cashier, "reports.dashboard");
    expect(dash.today.sales.count).toBe(2);
    expect(dash.today.gross_profit).toBeNull();                                  // cashiers do not see profit
    expect(shop.fail(shop.owner, "reports.summary", { from: "2026-12-01", to: "2026-11-01" }).message).toMatch(/start date is after/);
    expect(checkBooks(shop)).toEqual([]);
  });
});

describe("backup, verification and restore", () => {
  const seed = () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 600);
    const c = customer(shop);
    const bill = () => shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: c.id, items: [line(p, p.carton, 1, 1080)], payments: [] });
    return { shop, p, c, bill };
  };

  it("round trip: restoring a backup brings back exactly the state at backup time", () => {
    const { shop, p, c, bill } = seed();
    bill();
    const b = backupNow(shop.core, "manual");
    expect(b).toMatchObject({ last_invoice: "INV/26-27/1", invoices: 1, customer_dues: R(1274), second: "not_set" });
    bill(); bill();
    shop.ok(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(50), reason: "melted" });
    expect(stockOf(shop, p.id)).toBe(600 - 360 - 50);

    const info = shop.ok<any>(shop.owner, "backup.restore", { file: b.file });
    expect(info.last_invoice).toBe("INV/26-27/1");
    expect(shop.fail(shop.owner, "products.list").code).toBe("auth");            // everyone is signed out by a restore
    const owner = shop.ok<any>(null, "auth.login", { username: "yogesh", password: "owner-pass" }).token;
    expect(shop.ok<any>(owner, "sales.list", {}).rows).toHaveLength(1);
    expect(shop.ok<any[]>(owner, "products.list")[0].on_hand_m).toBe(480000);
    expect(shop.sql("select balance from customers where id = ?", c.id)[0].balance).toBe(R(1274));
    // the next invoice continues from the restored state, and the data that was replaced is kept as a safety copy
    shop.owner = owner; shop.cashier = shop.ok<any>(null, "auth.login", { username: "sunil", password: "cashier-pass" }).token;
    expect(bill().invoice_no).toBe("INV/26-27/2");
    const safety = readdirSync(path.join(shop.dir, "backups")).find((f) => f.includes("pre-restore"))!;
    expect(inspectBackup(path.join(shop.dir, "backups", safety))).toMatchObject({ last_invoice: "INV/26-27/3", invoices: 3 });
    expect(checkBooks(shop)).toEqual([]);
  });

  it("refuses damaged, truncated and unrelated files, leaving live data untouched", () => {
    const { shop, bill } = seed();
    bill();
    const good = backupNow(shop.core, "manual").file;
    const damaged = path.join(shop.dir, "damaged.db"), cut = path.join(shop.dir, "cut.db"), text = path.join(shop.dir, "notes.db"), other = path.join(shop.dir, "other.db");
    copyFileSync(good, damaged);
    const size = statSync(damaged).size;
    const fd = require("node:fs").openSync(damaged, "r+");
    require("node:fs").writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, Math.floor(size / 2));
    require("node:fs").closeSync(fd);
    copyFileSync(good, cut); truncateSync(cut, 5000);
    writeFileSync(text, "this is not a database");
    createCore({ dataDir: mkdtempSync(path.join(tmpdir(), "ygpos-x-")) }).db.exec(`vacuum into '${other}'`);
    for (const f of [damaged, cut, text, path.join(shop.dir, "missing.db")]) {
      const e = shop.fail(shop.owner, "backup.restore", { file: f });
      expect(e.code).toMatch(/invalid|not_found/);
    }
    expect(shop.ok<any>(shop.owner, "backup.inspect", { file: other })).toMatchObject({ invoices: 0 }); // a valid but empty YG POS file is recognised as such
    expect(shop.ok<any>(shop.owner, "sales.list", {}).rows).toHaveLength(1);   // still signed in, data intact
    expect(checkBooks(shop)).toEqual([]);
  });

  it("a backup from an older app version is restored and brought up to date; upgrades back up first", () => {
    const { shop, bill } = seed();
    bill();
    const old = backupNow(shop.core, "manual").file;
    shop.core.close();
    MIGRATIONS.push("alter table customers add column route text; create table delivery_routes (id integer primary key, name text not null) strict;");
    try {
      const upgraded = createCore({ dataDir: shop.dir });                        // the app was updated: existing data is migrated
      expect(upgraded.db.version).toBe(MIGRATIONS.length);
      expect(readdirSync(path.join(shop.dir, "backups")).some((f) => f.includes("pre-upgrade"))).toBe(true);
      expect(inspectBackup(old).schema_version).toBe(MIGRATIONS.length - 1);
      restoreBackup(upgraded, old);                                              // an old backup still restores…
      expect(upgraded.db.version).toBe(MIGRATIONS.length);                       // …and is upgraded on the way in
      expect(upgraded.db.all("select route from customers")).toHaveLength(1);
      expect(upgraded.db.get<any>("select count(*) as n from sales")!.n).toBe(1);
      upgraded.close();
      // an app OLDER than the data refuses to open it rather than risk damage
      MIGRATIONS.pop();
      expect(() => createCore({ dataDir: shop.dir })).toThrow(/newer version of YG POS/);
    } finally {
      if (MIGRATIONS.length > 1) MIGRATIONS.pop();
    }
  });

  it("a restore interrupted by a crash leaves the live database intact", () => {
    const { shop, bill } = seed();
    bill(); bill();
    const b = backupNow(shop.core, "manual").file;
    shop.core.close();
    // simulate power loss after the backup was copied next to the database but before the swap
    copyFileSync(b, path.join(shop.dir, "ygpos.db.restoring"));
    truncateSync(path.join(shop.dir, "ygpos.db.restoring"), 3000);
    const again = createCore({ dataDir: shop.dir });
    expect(existsSync(path.join(shop.dir, "ygpos.db.restoring"))).toBe(false);
    expect(again.db.get<any>("select count(*) as n from sales")!.n).toBe(2);
    expect(again.db.get<any>("pragma integrity_check")!.integrity_check).toBe("ok");
    again.close();
  });

  it("copies every backup to the second location and warns when it cannot", () => {
    const { shop, bill } = seed();
    bill();
    expect(shop.ok<any>(shop.owner, "backup.status").warning).toMatch(/No second backup location/);
    const usb = mkdtempSync(path.join(tmpdir(), "ygpos-usb-"));
    shop.ok(shop.owner, "config.set", { key: "backup_dir_2", value: usb });
    expect(shop.fail(shop.manager, "config.set", { key: "backup_dir_2", value: "/tmp" }).code).toBe("forbidden");
    const b = shop.ok<any>(shop.owner, "backup.now");
    expect(b.second).toBe("ok");
    expect(inspectBackup(path.join(usb, b.name)).last_invoice).toBe("INV/26-27/1");
    expect(shop.ok<any>(shop.owner, "backup.status").warning).toBeNull();
    writeFileSync(path.join(usb, "blocker"), "x");
    shop.ok(shop.owner, "config.set", { key: "backup_dir_2", value: path.join(usb, "blocker", "sub") });  // the drive is gone / unusable
    expect(shop.ok<any>(shop.owner, "backup.now").second).toBe("failed");
    expect(shop.ok<any>(shop.owner, "backup.status").warning).toMatch(/could not be copied/);
    shop.ok(shop.owner, "config.set", { key: "backup_dir_2", value: usb });
    shop.ok(shop.owner, "backup.now");
    shop.setDate("2026-11-18T10:00:00");
    expect(shop.ok<any>(shop.owner, "backup.status").warning).toMatch(/more than a day/);
  });

  it("keeps recent backups, thins older ones to one a day, then one a month", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ygpos-prune-"));
    const make = (d: string, t: string) => writeFileSync(path.join(dir, `ygpos-${d}-${t}-auto.db`), "x");
    for (const t of ["080000", "100000", "120000"]) { make("20261116", t); make("20261114", t); }   // within 7 days: all kept
    for (const t of ["080000", "100000", "120000"]) { make("20261020", t); make("20261019", t); }   // within 60 days: newest per day
    for (const d of ["20260705", "20260718", "20260729", "20260610"]) make(d, "090000");             // older: newest per month
    make("20231101", "090000");                                                                      // over 2 years: removed
    writeFileSync(path.join(dir, "my-notes.txt"), "not ours");
    prune(dir, new Date("2026-11-16T18:00:00"));
    expect(readdirSync(dir).sort()).toEqual([
      "my-notes.txt", "ygpos-20260610-090000-auto.db", "ygpos-20260729-090000-auto.db",
      "ygpos-20261019-120000-auto.db", "ygpos-20261020-120000-auto.db",
      "ygpos-20261114-080000-auto.db", "ygpos-20261114-100000-auto.db", "ygpos-20261114-120000-auto.db",
      "ygpos-20261116-080000-auto.db", "ygpos-20261116-100000-auto.db", "ygpos-20261116-120000-auto.db",
    ]);
  });

  it("data survives closing and reopening the app, and a damaged database is reported clearly", () => {
    const { shop, bill } = seed();
    bill();
    shop.core.close();
    const again = createCore({ dataDir: shop.dir });
    expect(again.db.get<any>("select invoice_no from sales")!.invoice_no).toBe("INV/26-27/1");
    again.close();
    const file = path.join(shop.dir, "ygpos.db");
    const fd = require("node:fs").openSync(file, "r+");
    require("node:fs").writeSync(fd, Buffer.alloc(20000, 0x5a), 0, 20000, 4096);
    require("node:fs").closeSync(fd);
    expect(() => createCore({ dataDir: shop.dir })).toThrow();
  });
});
