import { describe, expect, it } from "vitest";
import { C4, Q, R, addStock, checkBooks, cup, customer, newShop, product, ref, stockOf } from "./helpers";

const line = (p: any, unit: number, qty: number, price: number, discount = 0) => ({ product_id: p.id, unit_id: unit, qty_m: Q(qty), unit_price: R(price), discount: R(discount) });

describe("first-run setup, sign-in and roles", () => {
  it("can be set up only once, and signs the owner in", () => {
    const shop = newShop();
    expect(shop.ok<any>(shop.owner, "app.status").setup_complete).toBe(true);
    expect(shop.fail(null, "setup.create", { username: "evil", display_name: "E", password: "123456", business: { business_name: "X", gst_registered: false } }).message).toMatch(/already set up/);
  });
  it("rejects wrong passwords and locks out after repeated failures", () => {
    const shop = newShop();
    for (let i = 0; i < 5; i++) expect(shop.fail(null, "auth.login", { username: "sunil", password: "nope" }).code).toBe("auth");
    expect(shop.fail(null, "auth.login", { username: "sunil", password: "cashier-pass" }).message).toMatch(/Too many wrong attempts/);
  });
  it("refuses every call without a session, and enforces roles", () => {
    const shop = newShop();
    expect(shop.fail(null, "products.list").code).toBe("auth");
    expect(shop.fail("made-up-token", "sales.list").code).toBe("auth");
    expect(shop.fail(shop.cashier, "products.save", {}).code).toBe("forbidden");
    expect(shop.fail(shop.cashier, "stock.adjust", {}).code).toBe("forbidden");
    expect(shop.fail(shop.cashier, "reports.summary", { from: "2026-01-01", to: "2026-12-31" }).code).toBe("forbidden");
    expect(shop.fail(shop.cashier, "suppliers.list").code).toBe("forbidden");
    expect(shop.fail(shop.manager, "users.list").code).toBe("forbidden");
    expect(shop.fail(shop.manager, "settings.update", {}).code).toBe("forbidden");
    expect(shop.fail(shop.manager, "backup.restore", { file: "x" }).code).toBe("forbidden");
  });
  it("removing a user's access ends their session at once; the owner account cannot be edited away", () => {
    const shop = newShop();
    const users = shop.ok<any[]>(shop.owner, "users.list");
    const sunil = users.find((u) => u.username === "sunil");
    shop.ok(shop.owner, "users.update", { id: sunil.id, display_name: "Sunil", role: "cashier", is_active: false });
    expect(shop.fail(shop.cashier, "products.list").code).toBe("auth");
    expect(shop.fail(null, "auth.login", { username: "sunil", password: "cashier-pass" }).code).toBe("auth");
    expect(shop.fail(shop.owner, "users.update", { id: users.find((u) => u.role === "owner").id, display_name: "X", role: "cashier", is_active: false }).message).toMatch(/owner account/);
  });
  it("the recovery key resets the owner's password once, then a new key is issued", () => {
    const shop = newShop();
    expect(shop.fail(null, "auth.recover", { recovery_key: "AAAA-BBBB", password: "new-pass-1" }).code).toBe("auth");
    const r = shop.ok<any>(null, "auth.recover", { recovery_key: shop.recoveryKey, password: "new-pass-1" });
    expect(r.recovery_key).not.toBe(shop.recoveryKey);
    shop.ok(null, "auth.login", { username: "yogesh", password: "new-pass-1" });
    expect(shop.fail(null, "auth.recover", { recovery_key: shop.recoveryKey, password: "another-1" }).code).toBe("auth");
  });
  it("GST settings need a GSTIN that matches the state", () => {
    const shop = newShop();
    const base = { business_name: "X", gst_registered: true, state_code: "27" };
    expect(shop.fail(shop.owner, "settings.update", { ...base, gstin: "29AAPFU0939F1ZR" }).message).toMatch(/must match the state/);
    expect(shop.fail(shop.owner, "settings.update", { ...base, gstin: "BAD" }).message).toMatch(/valid 15-character GSTIN/);
    expect(shop.fail(shop.owner, "settings.update", { ...base, gstin: "27AAPFU0939F1ZA" }).message).toMatch(/valid 15-character GSTIN/);   // wrong check digit
    expect(shop.fail(shop.owner, "customers.save", { name: "X", gstin: "27AAPFU0939F1ZA" }).message).toMatch(/GSTIN is not valid/);
    // spaces and lower case from typing or pasting are tolerated; all 15 characters are kept
    expect(shop.ok<any>(shop.owner, "settings.update", { ...base, gstin: " 27aapfu0939f1zv " }).gstin).toBe("27AAPFU0939F1ZV");
    expect(shop.ok<any>(shop.owner, "customers.save", { name: "Spaced", gstin: "27 AAPFU 0939 F1ZV" }).gstin).toBe("27AAPFU0939F1ZV");
    expect(shop.ok<any>(shop.owner, "settings.update", { business_name: "No GST Shop", gst_registered: false }).gst_registered).toBe(0);
  });
});

describe("packaging and unit conversion", () => {
  it("selling 2 cartons of 12 boxes x 10 pieces takes 240 pieces from stock", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 1200);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.carton, 2, 1080)], payments: [{ method: "cash", amount: R(2549) }] });
    expect(s.items[0]).toMatchObject({ unit_name: "Carton", factor_m: 120000, qty_m: 2000, base_qty_m: 240000 });
    expect(stockOf(shop, p.id)).toBe(960);
    expect(s.grand_total).toBe(R(2549)); // 2160 + 18% = 2548.80, rounded
  });
  it("one bill can mix cartons, boxes and loose pieces of the same product", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 500);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.carton, 1, 1080), line(p, p.box, 3, 95), line(p, p.pcs, 7, 10)], payments: [{ method: "cash", amount: R(1693) }] });
    expect(s.items.map((i: any) => i.base_qty_m)).toEqual([120000, 30000, 7000]);
    expect(stockOf(shop, p.id)).toBe(500 - 157);
    expect(s.taxable_total).toBe(R(1080 + 285 + 70));
  });
  it("different products can have completely different packaging", () => {
    const shop = newShop();
    const cone = product(shop, { name: "Choco Cone", base_unit: "cone", base_price: R(20), units: [{ name: "Case", factor_m: Q(24), sale_price: R(440) }] });
    const tub = product(shop, { name: "Family Tub 1L", base_unit: "tub", base_price: R(180), units: [] });
    expect(cone.units.map((u: any) => [u.name, u.factor_m])).toEqual([["cone", 1000], ["Case", 24000]]);
    expect(tub.units).toHaveLength(1);
  });
  it("countable products refuse fractions everywhere; weighed products allow them", () => {
    const shop = newShop();
    const p = cup(shop);
    expect(shop.fail(shop.owner, "products.save", { ...p, base_price: R(10), units: [{ name: "Half", factor_m: 500, sale_price: 0 }] }).message).toMatch(/more than one pcs/);
    expect(shop.fail(shop.owner, "products.save", { ...p, base_price: R(10), units: [{ name: "Odd", factor_m: 2500, sale_price: 0 }] }).message).toMatch(/whole number of pcs/);
    expect(shop.fail(shop.owner, "stock.adjust", { product_id: p.id, mode: "add", qty_m: 1500, reason: "opening" }).message).toMatch(/whole pcs/);
    addStock(shop, p.id, 100);
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 1.5, 95)], payments: [] }).message).toMatch(/whole Box/);
    // the database itself refuses a fractional quantity, even if application code were wrong
    expect(() => shop.core.db.run("update stock_batches set qty_m = 1500 where product_id = ?", p.id)).toThrow(/fraction of a unit/);

    const kulfi = product(shop, { name: "Loose Kulfi Mix", base_unit: "kg", qty_decimals: 3, base_price: R(400), units: [{ name: "Can", factor_m: Q(4.5), sale_price: R(1700) }] });
    addStock(shop, kulfi.id, 20.75);
    const kg = kulfi.units.find((u: any) => u.name === "kg").id;
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(kulfi, kg, 1.25, 400)], payments: [{ method: "cash", amount: R(590) }] });
    expect(s.items[0].base_qty_m).toBe(1250);
    expect(stockOf(shop, kulfi.id)).toBe(19.5);
  });
  it("a unit already used on a bill keeps its size; packaging changes need a new unit", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 500);
    shop.ok(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.carton, 1, 1080)], payments: [{ method: "cash", amount: R(1274) }] });
    const units = (factor: number) => [{ id: p.box, name: "Box", factor_m: Q(10), sale_price: R(95) }, { id: p.carton, name: "Carton", factor_m: Q(factor), sale_price: R(1080) }];
    expect(shop.fail(shop.owner, "products.save", { ...p, base_price: R(10), units: units(144) }).message).toMatch(/size cannot change/);
    const updated = shop.ok<any>(shop.owner, "products.save", { ...p, base_price: R(10), units: [units(120)[0], { name: "Carton 144", factor_m: Q(144), sale_price: R(1290) }] });
    const old = updated.units.find((u: any) => u.id === p.carton);
    expect(old).toMatchObject({ is_active: 0, name: "Carton (old)" });   // kept for the old invoice, hidden from billing
    expect(shop.ok<any>(shop.owner, "sales.list", {}).rows).toHaveLength(1);
  });
});

describe("wholesale pricing", () => {
  it("uses quantity slabs, then customer prices, and records where each price came from", () => {
    const shop = newShop();
    const p = cup(shop, { units: [{ name: "Carton", factor_m: Q(120), sale_price: R(1080), tiers: [{ min_qty_m: Q(5), price: R(1050) }, { min_qty_m: Q(10), price: R(1020) }] }] });
    const carton = p.units.find((u: any) => u.name === "Carton").id;
    addStock(shop, p.id, 12000);
    const c = customer(shop);
    const bill = (qty: number, price: number, customer_id?: number) =>
      shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id, items: [line(p, carton, qty, price)], payments: [] , approved: [] });
    const cash = (qty: number, price: number) => shop.core.call("sales.create", { client_ref: ref(), items: [line(p, carton, qty, price)], payments: [{ method: "cash", amount: Math.round(qty * price * 1.18) * 100 }] }, shop.cashier);
    expect((cash(1, 1080) as any).data.items[0].price_source).toBe("list");
    expect((cash(5, 1050) as any).data.items[0].price_source).toBe("tier");
    expect((cash(12, 1020) as any).data.items[0].price_source).toBe("tier");
    expect((cash(5, 1080) as any).error.code).toBe("needs_approval"); // the slab price applies; 1080 would be a manual price

    shop.ok(shop.owner, "customers.setPrice", { customer_id: c.id, unit_id: carton, price: R(1000) });
    expect(bill(1, 1000, c.id).items[0]).toMatchObject({ price_source: "customer", list_price: R(1000) });
    expect(shop.fail(shop.cashier, "customers.setPrice", { customer_id: c.id, unit_id: carton, price: R(1) }).code).toBe("forbidden");
  });
  it("a hand-typed rate needs an owner or manager; a cashier can get one to approve", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 1200);
    const sale = { client_ref: ref(), items: [line(p, p.carton, 1, 1000)], payments: [{ method: "cash", amount: R(1180) }] };
    const refused = shop.fail(shop.cashier, "sales.create", sale);
    expect(refused).toMatchObject({ code: "needs_approval", data: { needs_manager: true } });
    expect(refused.data.problems[0]).toMatchObject({ type: "price" });
    expect(shop.fail(shop.cashier, "sales.create", { ...sale, approved: ["price"] }).code).toBe("needs_approval"); // a cashier cannot approve themselves
    expect(shop.fail(shop.cashier, "sales.create", { ...sale, approved: ["price"], approver: { username: "meena", password: "wrong" } }).code).toBe("forbidden");
    expect(shop.fail(shop.cashier, "sales.create", { ...sale, approved: ["price"], approver: { username: "sunil", password: "cashier-pass" } }).code).toBe("forbidden");
    const s = shop.ok<any>(shop.cashier, "sales.create", { ...sale, approved: ["price"], approver: { username: "meena", password: "manager-pass" } });
    expect(s.items[0]).toMatchObject({ price_source: "manual", unit_price: R(1000), list_price: R(1080) });
    expect(shop.sql("select details from audit_log where action = 'sale.approved_exceptions'")[0].details).toMatch(/"approved_by":"meena"/);
    // a manager confirms their own manual price
    shop.ok(shop.manager, "sales.create", { client_ref: ref(), items: [line(p, p.box, 1, 90)], payments: [{ method: "cash", amount: R(106) }], approved: ["price"] });
    expect(checkBooks(shop)).toEqual([]);
  });
  it("item discounts and a bill discount reduce the taxable value, and reports use the actual selling price", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 1200);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), bill_discount: R(100), items: [line(p, p.carton, 2, 1080, 60), line(p, p.box, 4, 95)], payments: [{ method: "cash", amount: R(2808) }] });
    expect(s).toMatchObject({ gross_total: R(2540), discount_total: R(160), taxable_total: R(2380), tax_total: R(428.4), grand_total: R(2808), round_off: -40 });
    const r = shop.ok<any>(shop.owner, "reports.summary", { from: "2026-11-16", to: "2026-11-16" });
    expect(r.revenue).toBe(R(2380));
    expect(r.gross_profit).toBe(R(2380) - R(280 * 7));
  });
});

describe("GST on invoices", () => {
  it("splits CGST/SGST in-state and charges IGST to a customer in another state", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 1200);
    const local = customer(shop, { name: "Local Shop", gstin: "27AAPFU0939F1ZV" });
    const away = customer(shop, { name: "Belgaum Traders", phone: "9000000001", state_code: "29" });
    const a = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: local.id, items: [line(p, p.carton, 1, 1080)], payments: [] });
    const b = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: away.id, items: [line(p, p.carton, 1, 1080)], payments: [] });
    expect(a).toMatchObject({ cgst_total: R(97.2), sgst_total: R(97.2), igst_total: 0, is_interstate: 0, customer_gstin: "27AAPFU0939F1ZV" });
    expect(b).toMatchObject({ cgst_total: 0, sgst_total: 0, igst_total: R(194.4), is_interstate: 1, place_of_supply: "29" });
  });
  it("supports a different rate per product, and tax-inclusive prices", () => {
    const shop = newShop();
    const five = product(shop, { name: "Kulfi Stick", tax_rate_bp: 500, base_price: R(21), price_includes_tax: true });
    const eighteen = product(shop, { name: "Choco Bar", tax_rate_bp: 1800, base_price: R(30) });
    addStock(shop, five.id, 100); addStock(shop, eighteen.id, 100);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(five, five.units[0].id, 10, 21), line(eighteen, eighteen.units[0].id, 10, 30)], payments: [{ method: "upi", amount: R(564) }] });
    expect(s.items[0]).toMatchObject({ taxable: R(200), cgst: R(5), sgst: R(5), line_total: R(210) });
    expect(s.items[1]).toMatchObject({ taxable: R(300), cgst: R(27), sgst: R(27), line_total: R(354) });
  });
  it("a business not registered for GST never charges tax", () => {
    const shop = newShop({ business_name: "Small Agency", gst_registered: false });
    const p = cup(shop);
    addStock(shop, p.id, 100);
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 2, 95)], payments: [{ method: "cash", amount: R(190) }] });
    expect(s).toMatchObject({ tax_total: 0, grand_total: R(190) });
  });
});

describe("invoice numbers", () => {
  it("are final at once, sequential, unique, and restart each financial year", () => {
    const shop = newShop(undefined, "2027-03-31T18:00:00");
    const p = cup(shop);
    addStock(shop, p.id, 1200);
    const bill = () => shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 1, 10)], payments: [{ method: "cash", amount: R(12) }] }).invoice_no;
    expect([bill(), bill(), bill()]).toEqual(["INV/26-27/1", "INV/26-27/2", "INV/26-27/3"]);
    shop.setDate("2027-04-01T09:00:00");
    expect(bill()).toBe("INV/27-28/1");
  });
  it("submitting the same bill twice creates one invoice", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    const sale = { client_ref: ref(), items: [line(p, p.box, 1, 95)], payments: [{ method: "cash", amount: R(112) }] };
    const first = shop.ok<any>(shop.cashier, "sales.create", sale);
    const again = shop.ok<any>(shop.cashier, "sales.create", sale);
    expect(again).toMatchObject({ duplicate: true, invoice_no: first.invoice_no });
    expect(stockOf(shop, p.id)).toBe(90);
    expect(shop.sql("select count(*) as n from payments")[0].n).toBe(1);
  });
  it("a bill that fails leaves nothing behind: no number used, no stock moved, no payment", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    shop.ok(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 1, 10)], payments: [{ method: "cash", amount: R(12) }] });
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 1, 95)], payments: [{ method: "cash", amount: R(5000) }] }).message).toMatch(/more than the bill total/);
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 1, 95), { product_id: 999, unit_id: 1, qty_m: 1000, unit_price: 0 }], payments: [] }).code).toBe("not_found");
    // force a failure deep inside the write, after the number was taken and the first line saved
    shop.core.db.exec("create trigger boom before insert on payments begin select raise(abort, 'disk full'); end");
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 2, 95)], payments: [{ method: "cash", amount: R(224) }] }).code).toBe("internal");
    shop.core.db.exec("drop trigger boom");
    expect(shop.sql("select count(*) as n from sales")[0].n).toBe(1);
    expect(shop.sql("select last_no from doc_counters where series = 'invoice'")[0].last_no).toBe(1);
    expect(stockOf(shop, p.id)).toBe(99);
    const next = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 1, 10)], payments: [{ method: "cash", amount: R(12) }] });
    expect(next.invoice_no).toBe("INV/26-27/2");
    expect(checkBooks(shop)).toEqual([]);
  });
  it("the invoice register lists every number with its status, including cancelled ones", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    const ids = [1, 2, 3].map(() => shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 1, 10)], payments: [{ method: "cash", amount: R(12) }] }).id);
    shop.ok(shop.manager, "sales.cancel", { id: ids[1], reason: "Wrong customer" });
    const reg = shop.ok<any>(shop.owner, "reports.invoiceRegister", { fy: "26-27" });
    expect(reg.rows.map((r: any) => [r.seq, r.status])).toEqual([[1, "completed"], [2, "cancelled"], [3, "completed"]]);
    expect(reg).toMatchObject({ last_no: 3, missing: [] });
  });
});

describe("stock safety when billing", () => {
  it("selling more than the stock on record needs approval, and is tracked as a shortfall", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    const sale = { client_ref: ref(), items: [line(p, p.carton, 1, 1080)], payments: [{ method: "cash", amount: R(1274) }] };
    const refused = shop.fail(shop.manager, "sales.create", sale);
    expect(refused.code).toBe("needs_approval");
    expect(refused.data.problems[0]).toMatchObject({ type: "stock", message: "Vanilla Cup: 120 pcs billed, 100 in stock" });
    expect(stockOf(shop, p.id)).toBe(100);
    shop.ok(shop.manager, "sales.create", { ...sale, approved: ["stock"] });
    expect(stockOf(shop, p.id)).toBe(-20);
    expect(shop.sql("select qty_m from stock_batches where product_id = ?", p.id)[0].qty_m).toBe(0); // no batch ever goes negative
    addStock(shop, p.id, 50, { reason: "adjustment" });   // the next stock-in settles the 20 first
    expect(stockOf(shop, p.id)).toBe(30);
    expect(checkBooks(shop)).toEqual([]);
  });
  it("many bills competing for the last units can never sell the same stock twice", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 50);
    const results = Array.from({ length: 12 }, () => shop.core.call("sales.create", { client_ref: ref(), items: [line(p, p.box, 1, 95)], payments: [{ method: "cash", amount: R(112) }] }, shop.cashier));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.error.code === "needs_approval")).toHaveLength(7);
    expect(stockOf(shop, p.id)).toBe(0);
    expect(checkBooks(shop)).toEqual([]);
  });
  it("takes the earliest-expiring batch first, costs the bill from the batches used, and never sells expired stock", () => {
    const shop = newShop();
    const p = cup(shop, { track_expiry: true });
    expect(shop.fail(shop.owner, "stock.adjust", { product_id: p.id, mode: "add", qty_m: Q(10), reason: "opening" }).message).toMatch(/needs an expiry date/);
    addStock(shop, p.id, 30, { expiry_date: "2027-03-01", cost4: C4(8), batch_no: "LATE" });
    addStock(shop, p.id, 20, { expiry_date: "2026-12-01", cost4: C4(6), batch_no: "SOON" });
    addStock(shop, p.id, 40, { expiry_date: "2026-11-10", cost4: C4(5), batch_no: "GONE" }); // already expired on 16 Nov
    const list = shop.ok<any[]>(shop.owner, "products.list")[0];
    expect(list).toMatchObject({ on_hand_m: 90000, expired_m: 40000, sellable_m: 50000 });
    const s = shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 25, 10)], payments: [{ method: "cash", amount: R(295) }] });
    const used = shop.sql("select b.batch_no, x.qty_m from sale_item_batches x join stock_batches b on b.id = x.batch_id order by x.id");
    expect(used).toEqual([{ batch_no: "SOON", qty_m: 20000 }, { batch_no: "LATE", qty_m: 5000 }]);
    expect(s.cost_total).toBe(R(20 * 6 + 5 * 8));
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.pcs, 30, 10)], payments: [{ method: "cash", amount: R(354) }] }).data.problems[0].message).toMatch(/25 in stock/);
    // expired stock stays visible until someone writes it off
    const gone = shop.ok<any[]>(shop.owner, "stock.expiring", { days: 0 });
    expect(gone).toHaveLength(1);
    shop.ok(shop.manager, "stock.adjust", { product_id: p.id, mode: "remove", qty_m: Q(40), reason: "expired", batch_id: gone[0].id });
    expect(shop.ok<any[]>(shop.owner, "products.list")[0]).toMatchObject({ on_hand_m: 25000, expired_m: 0 });
    expect(checkBooks(shop)).toEqual([]);
  });
});

describe("credit sales, payments and the customer ledger", () => {
  it("tracks paid, partly paid and unpaid invoices, and collects against the oldest dues first", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 2400);
    const c = customer(shop, { opening_balance: R(500) });
    expect(c.balance).toBe(R(500));
    const bill = (paid: number) => shop.ok<any>(shop.cashier, "sales.create", { client_ref: ref(), customer_id: c.id, items: [line(p, p.carton, 1, 1080)], payments: paid ? [{ method: "cash", amount: R(paid) }] : [] });
    const unpaid = bill(0), partial = bill(400), paid = bill(1274);
    expect([unpaid.due_amount, partial.due_amount, paid.due_amount]).toEqual([R(1274), R(874), 0]);
    const count = (status: string) => shop.ok<any>(shop.owner, "sales.list", { status }).rows.length;
    expect([count("unpaid"), count("partial"), count("paid")]).toEqual([1, 1, 1]);
    const bal = () => shop.sql("select balance, opening_due from customers where id = ?", c.id)[0];
    expect(bal()).toEqual({ balance: R(500 + 1274 + 874), opening_due: R(500) });

    expect(shop.fail(shop.cashier, "customers.collect", { client_ref: ref(), customer_id: c.id, amount: R(99999), method: "cash" }).message).toMatch(/cannot record more/);
    const pay = { client_ref: ref(), customer_id: c.id, amount: R(1000), method: "upi", reference: "UTR1" };
    expect(shop.ok<any>(shop.cashier, "customers.collect", pay)).toMatchObject({ balance: R(1648), duplicate: false });
    expect(shop.ok<any>(shop.cashier, "customers.collect", pay)).toMatchObject({ duplicate: true });      // double click
    expect(bal()).toEqual({ balance: R(1648), opening_due: 0 });                                          // opening balance settled first
    expect(shop.sql("select due_amount from sales where id = ?", unpaid.id)[0].due_amount).toBe(R(774)); // then the oldest invoice
    expect(shop.sql("select due_amount from sales where id = ?", partial.id)[0].due_amount).toBe(R(874));

    const ledger = shop.ok<any>(shop.owner, "customers.ledger", { customer_id: c.id });
    expect(ledger.entries[0]).toMatchObject({ type: "Opening balance", debit: R(500), balance: R(500) });
    expect(ledger.entries.filter((e: any) => e.type === "Invoice")).toHaveLength(3);
    expect(ledger.entries.filter((e: any) => e.type === "Payment received").reduce((a: number, e: any) => a + e.credit, 0)).toBe(R(400 + 1274 + 1000));
    expect(ledger.closing).toBe(R(1648));
    expect(checkBooks(shop)).toEqual([]);
  });
  it("a cash sale to an unnamed buyer must be paid in full", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 100);
    expect(shop.fail(shop.cashier, "sales.create", { client_ref: ref(), items: [line(p, p.box, 1, 95)], payments: [{ method: "cash", amount: R(50) }] }).message).toMatch(/paid in full/);
  });
  it("going over a customer's credit limit needs an owner or manager", () => {
    const shop = newShop();
    const p = cup(shop);
    addStock(shop, p.id, 2400);
    const c = customer(shop, { credit_limit: R(2000) });
    const sale = () => ({ client_ref: ref(), customer_id: c.id, items: [line(p, p.carton, 1, 1080)], payments: [] });
    shop.ok(shop.cashier, "sales.create", sale());
    const refused = shop.fail(shop.cashier, "sales.create", sale());
    expect(refused.data.problems[0]).toMatchObject({ type: "credit" });
    expect(refused.data.problems[0].message).toMatch(/would owe ₹2548.00, over their credit limit of ₹2000.00/);
    shop.ok(shop.manager, "sales.create", { ...sale(), approved: ["credit"] });
    expect(shop.fail(shop.cashier, "customers.save", { ...c, credit_limit: R(999999) }).code).toBe("forbidden");
  });
});
