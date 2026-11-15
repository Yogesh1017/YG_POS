// End-to-end test of the whole workflow in a real browser, against the real core and a real
// SQLite database in a temporary folder. Run:  npm run build && npm run test:e2e
// (Playwright must be available; the desktop-shell specifics are covered by e2e/desktop.mjs.)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "ygpos-e2e-"));
const usbDir = mkdtempSync(path.join(tmpdir(), "ygpos-e2e-usb-"));
const PORT = 3217, APP = `http://127.0.0.1:${PORT}`;
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

let server;
async function startServer() {
  server = spawn(process.execPath, ["--no-warnings", path.join(root, "dist-desktop/dev-server.js")], { cwd: root, env: { ...process.env, YGPOS_DATA: dataDir, YGPOS_PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("running at") && resolve());
    server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}
const sql = (q, ...p) => {
  const db = new DatabaseSync(path.join(dataDir, "ygpos.db"), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};
const one = (q, ...p) => Object.values(sql(q, ...p)[0])[0];

let passed = 0;
const failures = [];
let page;
async function step(name, fn) {
  if (failures.length) return console.log(`  - ${name} (skipped: an earlier step failed)`);
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e.message).split("\n").slice(0, 8).join("\n      ")}`);
    if (shots && page) await page.screenshot({ path: path.join(shots, `FAIL.png`) }).catch(() => {});
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => expect(String(a) === String(b), `${msg}: expected ${b}, got ${a}`);
const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

await startServer();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 860 } });
context.setDefaultTimeout(8000);
page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) pageErrors.push(m.text().slice(0, 160)); });
page.on("dialog", (d) => d.accept());
await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints += 1; if (!window.__holdPrint) window.dispatchEvent(new Event("afterprint")); }; });

const L = (label, scope = page) => scope.getByLabel(label, { exact: true }).first();
const dialog = () => page.locator("dialog[open]").last();
const nav = (name) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const toast = (text) => page.getByText(text).first().waitFor();
const total = () => page.getByLabel("Invoice total").innerText();
async function signIn(username, password) {
  await page.goto(`${APP}/login/`);
  await L("Username").fill(username);
  await L("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
}
async function signOut() { await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL("**/login/"); }
async function pickCustomer(text) { await L("Select customer").fill(text); await page.keyboard.press("Enter"); }
async function addLine(search, qty) {
  await L("Search products").fill(search);
  await page.keyboard.press("Enter");
  if (qty !== undefined) { await page.keyboard.type(String(qty)); await page.keyboard.press("Enter"); }
}
async function saveInvoice() { await page.keyboard.press("F9"); }
const savedNo = async () => { await dialog().getByText("Invoice saved").waitFor(); return (await dialog().innerText()).match(/[A-Z0-9]+\/\d\d-\d\d\/\d+/)[0]; };
const newInvoice = async () => { await dialog().getByRole("button", { name: "New invoice" }).click(); await dialog().waitFor({ state: "detached" }); };

console.log("YG POS end-to-end (browser + local database)");

await step("first run opens setup, creates the owner and business, and shows a recovery key once", async () => {
  await page.goto(`${APP}/`);
  await page.waitForURL("**/setup/");
  await L("Your name").fill("Yogesh");
  await L("Username").fill("yogesh");
  await L("Password").fill("owner-pass");
  await L("Password again").fill("owner-pass");
  await L("Business name").fill("Gupta Ice Cream Agency");
  await L("Phone").fill("9876543210");
  await L("Address").fill("12 Market Road");
  await L("City").fill("Pune");
  await L("PIN code").fill("411001");
  await L("State").selectOption("27");
  await page.getByLabel("This business is registered for GST").check();
  await L("GSTIN").fill("27AAPFU0939F1ZA");
  await page.getByRole("button", { name: "Create and continue" }).click();
  await page.getByText("valid 15-character GSTIN").waitFor();
  expect(Number(one("select count(*) from users")) === 0, "nothing saved on a rejected setup");
  await L("GSTIN").fill("27AAPFU0939F1ZV");
  await page.getByRole("button", { name: "Create and continue" }).click();
  const key = await page.getByTestId("recovery-key").innerText();
  expect(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/.test(key), `recovery key shown (${key})`);
  await page.getByRole("button", { name: "I have written it down" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  eq(one("select business_name from settings"), "Gupta Ice Cream Agency", "business");
});

await step("settings: owner adds a manager and a cashier", async () => {
  await nav("Settings");
  await page.getByRole("tab", { name: "Users" }).click();
  for (const [name, user, pw, role] of [["Meena", "meena", "manager-pass", "manager"], ["Sunil", "sunil", "cashier-pass", "cashier"]]) {
    await L("Name").fill(name); await L("Username").fill(user); await L("Password").fill(pw); await L("Role").selectOption(role);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await toast(`${name} added`);
  }
  eq(one("select count(*) from users"), 3, "users");
});

await step("products: brand, then a product packed 10 pcs to a box and 12 boxes to a carton, with a quantity price and opening stock", async () => {
  await nav("Products");
  await page.getByRole("button", { name: "Brands" }).click();
  await L("New brand name", dialog()).fill("Amul");
  await dialog().getByRole("button", { name: "Add" }).click();
  await dialog().getByText("Amul").waitFor();
  await dialog().getByLabel("Close").click();
  await page.getByRole("button", { name: "Add product" }).click();
  const d = dialog();
  await L("Product name", d).fill("Vanilla Cup");
  await L("Brand", d).selectOption({ label: "Amul" });
  await L("Pack size", d).fill("100 ml");
  await L("HSN code", d).fill("2105");
  await L("GST %", d).fill("18");
  await L("Rate for 1 pcs (₹)", d).fill("10");
  await L("Cost of 1 pcs (₹)", d).fill("7");
  await d.getByRole("button", { name: /Add packing unit/ }).click();
  await L("Packing unit", d).fill("Box");
  await L("holds", d).fill("10");
  await L("Rate for 1 Box (₹)", d).fill("95");
  await d.getByRole("button", { name: /Add packing unit/ }).click();
  await d.getByLabel("Packing unit", { exact: true }).nth(1).fill("Carton");
  await d.getByLabel("holds", { exact: true }).nth(1).fill("12");
  await L("Rate for 1 Carton (₹)", d).fill("1080");
  await d.getByText("= 120 pcs").waitFor();                       // 12 boxes x 10 pcs
  await d.getByRole("button", { name: "+ quantity price for Carton" }).click();
  await L("Minimum Carton for quantity price 1", d).fill("5");
  await L("Rate for quantity price 1 of Carton", d).fill("1050");
  await L("Usually sold in", d).selectOption("Carton");
  await L("Usually bought in", d).selectOption("Carton");
  await L("Warn when stock falls to (pcs)", d).fill("240");
  await L("Stock in hand now (pcs)", d).fill("600");
  await d.getByRole("button", { name: "Add product", exact: true }).click();
  await d.getByText("Enter the expiry date").waitFor();           // expiry is tracked, so opening stock needs one
  await L("Its expiry date", d).fill("2027-06-30");
  await d.getByRole("button", { name: "Add product", exact: true }).click();
  await toast("Product added");
  eq(JSON.stringify(sql("select name, factor_m, sale_price from product_units order by factor_m").map((u) => [u.name, u.factor_m, u.sale_price])), JSON.stringify([["pcs", 1000, 1000], ["Box", 10000, 9500], ["Carton", 120000, 108000]]), "units");
  await page.getByRole("cell", { name: "5 Carton", exact: true }).waitFor();   // 600 pcs shown in its packing
  await shot("products");
});

await step("customers and suppliers: add a shop with a credit limit and opening balance, and a supplier", async () => {
  await nav("Customers");
  await page.getByRole("button", { name: "Add customer" }).click();
  await L("Shop / business name", dialog()).fill("Sharma Kirana");
  await L("Phone", dialog()).fill("9000000001");
  await L("City / area", dialog()).fill("Kothrud");
  await L("Opening balance they owe (₹)", dialog()).fill("500");
  await L("Credit limit (₹)", dialog()).fill("4000");
  await dialog().getByRole("button", { name: "Save" }).click();
  await toast("Saved");
  await nav("Suppliers");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await L("Supplier name", dialog()).fill("Amul Distributor");
  await dialog().getByRole("button", { name: "Save" }).click();
  await toast("Saved");
  eq(one("select balance from customers"), 50000, "opening balance");
});

await step("purchases: a supplier bill adds stock by the carton with batch and expiry, sets cost, and records what is owed", async () => {
  await nav("Purchases");
  await page.getByRole("button", { name: "New purchase" }).click();
  const d = dialog();
  await L("Supplier", d).selectOption({ label: "Amul Distributor" });
  await L("Supplier's bill no", d).fill("AM/441");
  await L("Search products", d).fill("vanilla");
  await page.keyboard.press("Enter");
  await L("Quantity of Vanilla Cup", d).fill("5");
  await L("Rate of Vanilla Cup", d).fill("900");
  await L("Batch number of Vanilla Cup", d).fill("B77");
  await d.getByRole("button", { name: "Save purchase" }).click();
  await d.getByText("enter a valid expiry date").waitFor();
  await L("Expiry date of Vanilla Cup", d).fill("2027-03-31");
  await d.getByText("= 600 pcs").waitFor();
  await L("Paid now (₹)", d).fill("2000");
  await d.getByRole("button", { name: "Save purchase" }).click();
  await toast("Purchase saved and stock added");
  eq(one("select sum(qty_m) from stock_batches"), 1200000, "stock in base units");
  eq(one("select cost4 from products"), 75000, "cost per piece 900/120 = 7.50");
  eq(one("select balance from suppliers"), 331000, "5310 - 2000 owed");
});

let firstInvoice;
await step("billing by keyboard: customer, product, quantity, Enter — 2 cartons take 240 pieces from the earliest-expiring batch", async () => {
  await page.keyboard.press("F1");
  await page.waitForURL("**/billing/");
  await pickCustomer("sharma");
  await page.getByText("Balance ₹500.00").waitFor();
  await addLine("van", 2);
  eq(await total(), "₹2,549.00", "2 x 1080 + 18% = 2548.80, rounded");
  await page.getByText("= 240 pcs").waitFor();
  await page.getByText(/will be added to Sharma Kirana's balance/).waitFor();
  await shot("billing");
  await saveInvoice();
  firstInvoice = await savedNo();
  expect(/^INV\/\d\d-\d\d\/1$/.test(firstInvoice), `final invoice number at once (${firstInvoice})`);
  const batches = sql("select batch_no, qty_m from stock_batches order by expiry_date");
  eq(JSON.stringify(batches.map((b) => [b.batch_no, b.qty_m])), JSON.stringify([["B77", 360000], [null, 600000]]), "taken from the batch expiring first");
  eq(one("select balance from customers"), 304900, "500 + 2549 on credit");
  eq(one("select cost_total from sales"), 180000, "cost from the batch used: 240 x 7.50");
});

await step("invoice printing: A4 tax invoice and thermal receipt carry the right details", async () => {
  await page.evaluate(() => { window.__holdPrint = true; });
  await dialog().getByRole("button", { name: "Print A4" }).click();
  await page.waitForFunction(() => window.__prints === 1);
  await page.emulateMedia({ media: "print" });
  const a4 = await page.locator("#print-root").innerText();
  for (const t of ["TAX INVOICE", "Gupta Ice Cream Agency", "27AAPFU0939F1ZV", firstInvoice, "Sharma Kirana", "Amul Vanilla Cup 100 ml", "2 Carton", "2105", "CGST", "194.40", "2,549.00", "Rupees Two Thousand Five Hundred Forty Nine Only", "Balance due"]) expect(a4.includes(t), `A4 invoice should contain "${t}"`);
  await shot("invoice-a4-print");
  await page.emulateMedia({ media: null });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await dialog().getByRole("button", { name: "Thermal" }).click();
  await page.waitForFunction(() => window.__prints === 2);
  expect((await page.locator("#print-root").innerText()).includes("BALANCE DUE"), "thermal receipt rendered");
  await page.evaluate(() => { window.__holdPrint = false; window.dispatchEvent(new Event("afterprint")); });
  await newInvoice();
});

await step("pricing: 5 cartons get the quantity price; a customer's special rate overrides it", async () => {
  await addLine("van", 5);
  await page.getByText("Qty price").waitFor();
  eq(await L("Rate for line 1").inputValue(), "1050.00", "slab rate");
  await page.getByRole("button", { name: "Clear" }).click();
  await nav("Customers");
  await page.getByLabel("Special prices for Sharma Kirana").click();
  await L("Search products", dialog()).fill("vanilla");
  await page.keyboard.press("Enter");
  await L("Special rate", dialog()).fill("1000");
  await dialog().getByRole("button", { name: "Set rate" }).click();
  await dialog().getByRole("cell", { name: "₹1,000.00" }).waitFor();
  await dialog().getByLabel("Close").click();
  await page.keyboard.press("F1");
  await pickCustomer("sharma");
  await addLine("van", 1);
  await page.getByText("Customer price").waitFor();
  eq(await L("Rate for line 1").inputValue(), "1000.00", "customer rate");
  await page.getByText("last 1,080.00").waitFor();                  // what they paid last time
});

await step("credit limit: going over it needs approval, which the owner gives and the audit log records", async () => {
  await L("Quantity for line 1").fill("2");                        // 2360 more -> 5409 > 4000
  await page.getByText("over their credit limit").waitFor();
  await saveInvoice();
  await dialog().getByText("Over the credit limit").waitFor();
  expect(Number(one("select count(*) from sales")) === 1, "not saved before approval");
  await dialog().getByRole("button", { name: "Approve and save" }).click();
  await savedNo();
  await newInvoice();
  expect(String(one("select details from audit_log where action = 'sale.approved_exceptions'")).includes('"credit"'), "approval audited");
});

await step("cash sale: mixed units, item discount, bill discount %, split payment; must be paid in full", async () => {
  await L("Name on bill").fill("Walk-in");
  await addLine("van", 1);
  await L("Unit for line 1").selectOption({ label: "Box" });
  await L("Quantity for line 1").fill("3");
  await L("Discount for line 1").fill("5");
  await page.locator("#bill-disc").fill("10%");
  eq(await total(), "₹297.00", "(285 - 5) less 10% = 252 + 18% = 297.36");
  await L("Amount received").fill("100");
  await saveInvoice();
  await toast("A cash sale must be paid in full");
  await page.getByRole("button", { name: "+ Split" }).click();
  await page.getByLabel("Amount received").nth(1).fill("197");
  await saveInvoice();
  await savedNo();
  await newInvoice();
  const s = sql("select grand_total, discount_total, paid_total, due_amount, customer_name from sales order by id desc limit 1")[0];
  eq(JSON.stringify(s), JSON.stringify({ grand_total: 29700, discount_total: 3300, paid_total: 29700, due_amount: 0, customer_name: "Walk-in" }), "cash sale");
  eq(one("select count(*) from payments where sale_id = (select max(id) from sales)"), 2, "split payment rows");
});

await step("a draft invoice survives a reload; the app survives being killed mid-use with nothing lost or half-saved", async () => {
  await pickCustomer("sharma");
  await addLine("van", 4);
  await page.reload();
  await page.getByText("= 480 pcs").waitFor();                     // the draft came back
  const before = sql("select count(*) as n, coalesce(sum(grand_total), 0) as t from sales")[0];
  server.kill("SIGKILL");                                           // power cut
  await new Promise((r) => setTimeout(r, 300));
  await startServer();
  eq(one("pragma integrity_check"), "ok", "database intact after a hard kill");
  eq(JSON.stringify(sql("select count(*) as n, coalesce(sum(grand_total), 0) as t from sales")[0]), JSON.stringify(before), "no invoice lost or half-written");
  await signIn("yogesh", "owner-pass");                             // sessions end when the app restarts
  await page.keyboard.press("F1");
  await page.getByText("= 480 pcs").waitFor();
  await page.getByRole("button", { name: "Clear" }).click();
});

await step("cashier: can bill at normal rates; a hand-typed rate or selling beyond stock needs a manager's password", async () => {
  await signOut();
  await signIn("sunil", "cashier-pass");
  expect((await page.getByRole("navigation").getByRole("link", { name: "Products" }).count()) === 0, "cashier has no Products screen");
  expect((await page.getByRole("navigation").getByRole("link", { name: "Reports" }).count()) === 0, "cashier has no Reports screen");
  expect(!(await page.locator("main").innerText()).includes("Gross profit"), "cashier does not see profit");
  await page.goto(`${APP}/purchases/`);
  await page.getByText("This screen is for the owner or a manager").waitFor();
  await page.keyboard.press("F1");
  await addLine("van", 1);
  await L("Rate for line 1").fill("900");
  await page.getByText("Manual").waitFor();
  await L("Amount received").fill("1062");
  await saveInvoice();
  await dialog().getByText("Rate changed by hand").waitFor();
  await L("Owner/manager username", dialog()).fill("sunil");
  await L("Their password", dialog()).fill("cashier-pass");
  await dialog().getByRole("button", { name: "Approve and save" }).click();
  await toast("not an owner/manager");
  await L("Owner/manager username", dialog()).fill("meena");
  await L("Their password", dialog()).fill("manager-pass");
  await dialog().getByRole("button", { name: "Approve and save" }).click();
  await savedNo();
  await newInvoice();
  eq(JSON.stringify(sql("select price_source, unit_price, list_price from sale_items order by id desc limit 1")[0]), JSON.stringify({ price_source: "manual", unit_price: 90000, list_price: 108000 }), "manual rate recorded");
  await signOut();
  await signIn("yogesh", "owner-pass");
});

await step("invoices: search by number and customer; cancel needs a reason and puts stock back", async () => {
  await nav("Invoices");
  await L("Search").fill("walk");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Showing 1 of 1").waitFor();
  await L("Search").fill(firstInvoice);
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Showing 1 of 1").waitFor();
  await page.getByRole("cell", { name: "Sharma Kirana" }).waitFor();
  await L("Search").fill("");
  await L("Status").selectOption("unpaid");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Showing 2 of 2").waitFor();
  await L("Status").selectOption("all");
  await page.getByRole("button", { name: "Show" }).click();
  const stockBefore = Number(one("select sum(qty_m) from stock_batches"));
  await page.getByRole("cell", { name: /\/2$/ }).click();
  await dialog().getByRole("button", { name: "Cancel invoice" }).click();
  expect(await dialog().getByRole("button", { name: "Cancel invoice" }).isDisabled(), "a reason is required");
  await dialog().getByLabel("Reason (required)").fill("Order withdrawn");
  await dialog().getByRole("button", { name: "Cancel invoice" }).click();
  await toast("Invoice cancelled");
  eq(Number(one("select sum(qty_m) from stock_batches")) - stockBefore, 240000, "2 cartons back in stock");
  eq(one("select balance from customers"), 304900, "its due removed from the customer");
  await page.locator("dialog[open]").first().getByLabel("Close").click();
  await shot("invoices");
});

await step("returns: part of a carton comes back melted — credit note, balance reduced, wastage recorded, stock unchanged", async () => {
  await page.getByRole("cell", { name: firstInvoice, exact: true }).click();
  await dialog().getByRole("button", { name: "Return goods" }).click();
  const stockBefore = Number(one("select sum(qty_m) from stock_batches"));
  await dialog().getByLabel("Quantity of Amul Vanilla Cup 100 ml returned").fill("24");
  await dialog().getByLabel("Condition of Amul Vanilla Cup 100 ml").selectOption("melted");
  await dialog().getByLabel("Reason").fill("Shop freezer failed");
  await dialog().getByRole("button", { name: "Record return" }).click();
  await toast(/Credit note CN\/\d\d-\d\d\/1 recorded/);
  eq(Number(one("select sum(qty_m) from stock_batches")), stockBefore, "melted goods do not re-enter stock");
  eq(one("select total from sale_returns"), 25488, "24 of 240 pcs of 2548.80");
  eq(one("select balance from customers"), 304900 - 25488, "balance reduced");
  eq(one("select sum(-qty_m) from stock_movements where reason = 'melted'"), 24000, "wastage logged");
  await page.locator("dialog[open]").first().getByText("Credit note").first().waitFor();
  await page.locator("dialog[open]").first().getByLabel("Close").click();
});

await step("customer ledger and payment: money received settles the opening balance first; the ledger agrees with the balance", async () => {
  await nav("Customers");
  await page.getByRole("row", { name: /Sharma Kirana/ }).getByRole("button", { name: "Receive" }).click();
  await L("Amount (₹)", dialog()).fill("99999");
  await dialog().getByRole("button", { name: "Record payment" }).click();
  await dialog().getByText("cannot record more than that").waitFor();
  await L("Amount (₹)", dialog()).fill("1000");
  await L("Paid by", dialog()).selectOption("upi");
  await dialog().getByRole("button", { name: "Record payment" }).click();
  await toast("Received ₹1,000.00 from Sharma Kirana");
  eq(JSON.stringify(sql("select balance, opening_due from customers")[0]), JSON.stringify({ balance: 179412, opening_due: 0 }), "balance and opening due");
  await page.getByLabel("Ledger of Sharma Kirana").click();
  await dialog().getByText("Opening balance").waitFor();
  const text = await dialog().innerText();
  for (const t of ["Invoice cancelled", "Credit note (return)", "Payment received", "Closing balance", "₹1,794.12"]) expect(text.includes(t), `ledger shows "${t}"`);
  await shot("ledger");
  await dialog().getByLabel("Close").click();
});

await step("stock: melted stock is written off in boxes; packing, batches and history all agree", async () => {
  await nav("Stock");
  const before = Number(one("select sum(qty_m) from stock_batches"));
  await page.getByRole("row", { name: /Vanilla Cup/ }).getByRole("button", { name: "Adjust" }).click();
  await L("What happened?", dialog()).selectOption("melted");
  await L("Quantity lost", dialog()).fill("2");
  await L("in", dialog()).selectOption({ label: "Box (10 pcs)" });
  await L("Note", dialog()).fill("Freezer 2 tripped");
  await dialog().getByRole("button", { name: "Save" }).click();
  await toast(/Vanilla Cup: stock is now/);
  eq(before - Number(one("select sum(qty_m) from stock_batches")), 20000, "2 boxes = 20 pcs removed");
  await page.getByLabel("Batches of Vanilla Cup").click();
  await dialog().getByRole("cell", { name: "B77" }).waitFor();
  await dialog().getByLabel("Close").click();
  await page.getByLabel("Stock history of Vanilla Cup").click();
  for (const t of ["Melted", "Purchase", "Opening stock", "Invoice cancelled", "Customer return"]) await dialog().getByRole("cell", { name: t, exact: true }).first().waitFor();
  await dialog().getByLabel("Close").click();
  await shot("stock");
});

await step("expenses and reports: profit, wastage, outstanding, GST and the invoice register all load and agree with the database", async () => {
  await nav("Expenses");
  await page.getByRole("button", { name: "Add expense" }).click();
  await L("Amount (₹)", dialog()).fill("300");
  await L("Note", dialog()).fill("Electricity");
  await dialog().getByRole("button", { name: "Save" }).click();
  await page.getByRole("cell", { name: "₹300.00" }).waitFor();
  await nav("Reports");
  await page.getByRole("heading", { name: "Profit" }).waitFor();
  const body = await page.locator("main").innerText();
  const revenue = Number(one("select sum(taxable_total) from sales where status = 'completed'")) - Number(one("select coalesce(sum(taxable_total),0) from sale_returns"));
  const fmt = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  for (const [label, value] of [["Revenue", revenue], ["Expenses", 30000]]) expect(body.includes(fmt(value)), `${label} ${fmt(value)} shown`);
  expect(body.includes("Net profit") && body.includes("Wastage"), "profit statement complete");
  await shot("reports");
  for (const [tab, text] of [["Products", "Sales by product"], ["Customers", "Sales by customer"], ["Purchases", "Purchases by supplier"], ["Wastage", "Wastage by reason"], ["Outstanding", "Customers who owe"], ["Stock", "Stock on hand"], ["GST", "HSN summary"], ["Invoice register", "No numbers are missing"]]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByText(text).first().waitFor();
  }
  await page.getByText(/Cancelled — Order withdrawn/).waitFor();
  await nav("Dashboard");
  await page.getByText("Today's sales").waitFor();
  await shot("dashboard");
});

await step("backup: a second location is set and tested, a backup is checked, and a restore brings back the earlier state", async () => {
  await nav("Settings");
  await page.getByRole("tab", { name: "Backup and restore" }).click();
  await page.getByText("No second backup location is set").waitFor();
  await L("Second backup location (USB or external drive)").fill(usbDir);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await toast("Backup saved and copied to the second location");
  await page.getByText("Backups are up to date in both locations").waitFor();
  expect(readdirSync(usbDir).some((f) => f.endsWith("-manual.db")), "copy exists on the second drive");
  const invoicesAtBackup = Number(one("select count(*) from sales"));
  await shot("backup");
  // more work after the backup…
  await page.keyboard.press("F1");
  await addLine("van", 1);
  await saveInvoice();
  await savedNo();
  await newInvoice();
  eq(one("select count(*) from sales"), invoicesAtBackup + 1, "one more invoice");
  // …then restore the backup
  await nav("Settings");
  await page.getByRole("tab", { name: "Backup and restore" }).click();
  await page.getByRole("row", { name: /manual/ }).first().getByRole("button", { name: "Check" }).click();
  await dialog().getByText("complete, undamaged YG POS backup").waitFor();
  await dialog().getByRole("button", { name: /Restore this backup/ }).click();
  await dialog().getByLabel("Type RESTORE to confirm").fill("RESTORE");
  await dialog().getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForURL("**/login/");
  eq(one("select count(*) from sales"), invoicesAtBackup, "back to the state at backup time");
  expect(readdirSync(path.join(dataDir, "backups")).some((f) => f.includes("pre-restore")), "the replaced data was kept as a safety copy");
  await signIn("yogesh", "owner-pass");
});

await step("books balance: stock equals its movements, balances equal unpaid amounts, invoice numbers are unique, no page errors", async () => {
  eq(one(`select count(*) from products p where (select coalesce(sum(qty_m),0) from stock_batches where product_id = p.id) - p.shortfall_m <> (select coalesce(sum(qty_m),0) from stock_movements where product_id = p.id)`), 0, "stock drift");
  eq(one("select count(*) from stock_batches where qty_m < 0 or qty_m % 1000 <> 0"), 0, "negative or fractional batches");
  eq(one(`select count(*) from customers c where c.balance <> c.opening_due + (select coalesce(sum(due_amount),0) from sales where customer_id = c.id and status = 'completed')`), 0, "customer balance drift");
  eq(one(`select count(*) from suppliers s where s.balance <> s.opening_due + (select coalesce(sum(due_amount),0) from purchases where supplier_id = s.id and status = 'completed')`), 0, "supplier balance drift");
  eq(one("select count(*) - count(distinct invoice_no) from sales"), 0, "duplicate invoice numbers");
  eq(one("pragma integrity_check"), "ok", "database integrity");
  expect(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
});

await browser.close();
server.kill("SIGTERM");
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
