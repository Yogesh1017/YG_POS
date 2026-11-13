// End-to-end test: drives the production build in Chromium against a real PostgreSQL
// database (through e2e/supabase-emulator.mjs). Run with:  npm run build && npm run test:e2e
// The build must use NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 (see README, "Testing").
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
import { startEmulator } from "./supabase-emulator.mjs";

// Playwright is expected to be installed globally (or as a dev dependency); require() finds both.
const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "..");
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const APP = "http://127.0.0.1:3100";
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

// ---------- database with the real migrations
const adminClient = new pg.Client({ connectionString: ADMIN_URL });
await adminClient.connect();
await adminClient.query("drop database if exists ygpos_e2e with (force)");
await adminClient.query("create database ygpos_e2e");
await adminClient.end();
const dbUrl = new URL(ADMIN_URL);
dbUrl.pathname = "/ygpos_e2e";
const pool = new pg.Pool({ connectionString: dbUrl.toString() });
await pool.query(readFileSync(path.join(root, "supabase/tests/supabase_shim.sql"), "utf8"));
for (const f of readdirSync(path.join(root, "supabase/migrations")).sort()) await pool.query(readFileSync(path.join(root, "supabase/migrations", f), "utf8"));
const sql = async (q, p = []) => (await pool.query(q, p)).rows;

// ---------- servers: API stand-in + static file server for the built app
const api = await startEmulator({ pool, port: 54321 });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain", ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json" };
// Serve with the same security headers as production (vercel.json), pointing the CSP at the test API.
const securityHeaders = Object.fromEntries(JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")).headers[0].headers
  .map((h) => [h.key, h.value.replace("https://*.supabase.co wss://*.supabase.co", "http://127.0.0.1:54321")]));
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, APP).pathname);
  let file = path.join(root, "out", p);
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404, { "content-type": "text/html" }); return res.end(readFileSync(path.join(root, "out/404.html"))); }
  res.writeHead(200, { ...securityHeaders, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => web.listen(3100, "127.0.0.1", r));

// ---------- tiny test harness
let passed = 0;
const failures = [];
let page;
async function step(name, fn) {
  if (failures.length) return console.log(`  - ${name} (skipped: an earlier step failed)`);
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`);
    if (shots && page) await page.screenshot({ path: path.join(shots, `FAIL-${failures.length}.png`) }).catch(() => {});
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => expect(String(a) === String(b), `${msg}: expected ${b}, got ${a}`);
const shot = async (name, p = page) => { if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`) }); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
page = await context.newPage();
context.setDefaultTimeout(8000);
const consoleErrors = [];
const cspViolations = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text().slice(0, 200)); });
page.on("dialog", (d) => d.accept());
await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints += 1; if (!window.__holdPrint) window.dispatchEvent(new Event("afterprint")); }; });

const field = (label) => page.getByLabel(label, { exact: true }).first();
const dialog = () => page.locator("dialog[open]").last();
const total = () => page.getByLabel("Bill total").innerText();

async function addProduct({ name, price, cost, gst, stock, barcode, unit, exclusive }) {
  await page.getByRole("button", { name: "Add product" }).click();
  await dialog().getByLabel("Name", { exact: true }).fill(name);
  await dialog().getByLabel("Selling price (₹)").fill(String(price));
  await dialog().getByLabel("Cost price (₹)").fill(String(cost));
  if (unit) await dialog().getByLabel("Unit", { exact: true }).fill(unit);
  await dialog().getByLabel("GST rate (%)").fill(String(gst));
  if (exclusive) await dialog().getByLabel("Selling price includes GST").uncheck();
  if (barcode) await dialog().getByLabel("Barcode", { exact: true }).fill(barcode);
  if (stock) await dialog().getByLabel("Stock in hand now").fill(String(stock));
  await dialog().getByRole("button", { name: "Add product" }).click();
  await page.getByText("Product added").first().waitFor();
  await dialog().waitFor({ state: "detached" });
}
async function pay({ tendered, method } = {}) {
  await page.keyboard.press("F9");
  await dialog().getByText("To collect").waitFor();
  if (method) await dialog().getByRole("button", { name: method, exact: true }).click();
  if (tendered) await dialog().getByLabel("Cash handed over").fill(String(tendered));
  await dialog().getByRole("button", { name: "Save bill" }).click();
  await page.getByText("Bill saved").waitFor();
}
const stock = async (name) => Number((await sql("select stock_qty from products where name = $1", [name]))[0].stock_qty);

console.log("YG POS end-to-end");

await step("visiting the app signed out redirects to sign in", async () => {
  await page.goto(`${APP}/`);
  await page.waitForURL("**/login/");
});

await step("sign-up validates input, then creates the account", async () => {
  await page.goto(`${APP}/register/`);
  await field("Email").fill("not-an-email");
  await field("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Enter a valid email address").waitFor();
  await page.getByText("Use at least 8 characters").waitFor();
  await field("Email").fill("owner@shop.test");
  await field("Password").fill("correct-horse-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/setup/");
});

await step("shop setup rejects a bad GSTIN and creates the business", async () => {
  await field("Your name").fill("Yogesh");
  await field("Shop name").fill("Gupta General Store");
  await field("Phone").fill("9876543210");
  await field("Address").fill("12 Market Road");
  await field("City").fill("Pune");
  await field("PIN code").fill("411001");
  await field("State").selectOption("27");
  await page.getByLabel("My shop is registered for GST").check();
  await field("GSTIN").fill("27AAPFU0939F1ZA");
  await page.getByRole("button", { name: "Create shop" }).click();
  await page.getByText("This GSTIN is not valid").waitFor();
  await field("GSTIN").fill("27AAPFU0939F1ZV");
  await page.getByRole("button", { name: "Create shop" }).click();
  await page.getByRole("heading", { name: "Today" }).waitFor();
  eq((await sql("select count(*) from businesses"))[0].count, 1, "businesses");
  eq((await sql("select role from business_members"))[0].role, "owner", "role");
});

await step("products: add a category and two products with opening stock", async () => {
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByRole("button", { name: "Categories" }).click();
  await dialog().getByLabel("New category name").fill("Grocery");
  await dialog().getByRole("button", { name: "Add" }).click();
  await dialog().getByText("Grocery").waitFor();
  await dialog().getByLabel("Close").click();
  await addProduct({ name: "Lux Soap", price: 118, cost: 80, gst: 18, stock: 10, barcode: "8901030865278" });
  await addProduct({ name: "Basmati Rice", price: 100, cost: 70, gst: 5, stock: 25.5, unit: "kg", exclusive: true });
  eq(await stock("Lux Soap"), 10, "soap stock");
  eq(await stock("Basmati Rice"), 25.5, "rice stock");
  await shot("products");
});

await step("products: duplicate barcode is refused with a clear message", async () => {
  await page.getByRole("button", { name: "Add product" }).click();
  await dialog().getByLabel("Name", { exact: true }).fill("Copy");
  await dialog().getByLabel("Selling price (₹)").fill("10");
  await dialog().getByLabel("Barcode", { exact: true }).fill("8901030865278");
  await dialog().getByRole("button", { name: "Add product" }).click();
  await page.getByText("Another product already uses this barcode").waitFor();
  await dialog().getByRole("button", { name: "Cancel" }).click();
});

await step("billing: scan a barcode, change quantity, totals match the GST rules", async () => {
  await page.getByRole("link", { name: "Billing" }).click();
  await page.getByRole("button", { name: /Lux Soap/ }).first().waitFor();
  await page.getByRole("heading", { name: "Bill is empty" }).or(page.getByText("Bill is empty")).first().waitFor();
  await page.locator("body").click({ position: { x: 600, y: 600 } });   // focus is nowhere in particular
  await page.keyboard.type("8901030865278");   // a scanner types the code then Enter, wherever focus is
  await page.keyboard.press("Enter");
  await page.getByLabel("Increase Lux Soap").click();
  eq(await total(), "₹236.00", "2 x 118 inclusive");
  await page.getByRole("button", { name: /Basmati Rice/ }).first().click();
  await page.getByLabel("Quantity of Basmati Rice").click();
  await dialog().getByLabel("Quantity (kg)").fill("1.5");
  await dialog().getByRole("button", { name: "Update" }).click();
  eq(await total(), "₹394.00", "236 + 150 + 5% = 393.50, rounded");   // 157.50 + 236 = 393.50 -> 394
  await shot("pos");
});

await step("billing: cash payment shows change, saves, uploads and gets an invoice number", async () => {
  await pay({ tendered: 500 });
  await dialog().getByText("Return change").waitFor();
  expect((await dialog().innerText()).includes("₹106.00"), "change of 106 shown");
  await dialog().getByText(/Invoice\s+INV\/\d\d-\d\d\/1/).waitFor();
  const [s] = await sql("select grand_total, taxable_total, cgst_total, sgst_total, round_off, paid_total, due_amount from sales");
  eq(JSON.stringify(s), JSON.stringify({ grand_total: "394.00", taxable_total: "350.00", cgst_total: "21.75", sgst_total: "21.75", round_off: "0.50", paid_total: "394.00", due_amount: "0.00" }), "sale row");
  eq(await stock("Lux Soap"), 8, "soap stock after sale");
  eq(await stock("Basmati Rice"), 24, "rice stock after sale");
});

await step("billing: printing renders the tax invoice", async () => {
  await dialog().getByRole("button", { name: "Print bill" }).click();
  await page.waitForFunction(() => window.__prints === 1);
  await page.evaluate(() => { window.__holdPrint = true; });   // keep the print job open so it can be inspected
  await dialog().getByRole("button", { name: "Print bill" }).click();
  await page.waitForFunction(() => window.__prints === 2);
  await page.emulateMedia({ media: "print" });
  await page.locator("#print-root").getByText("TAX INVOICE").waitFor();
  const text = await page.locator("#print-root").innerText();
  for (const t of ["Gupta General Store", "GSTIN: 27AAPFU0939F1ZV", "INV/", "Lux Soap", "394.00", "CGST", "change", "106.00"]) expect(text.includes(t), `receipt should contain "${t}"`);
  await shot("receipt-80mm");
  await page.emulateMedia({ media: null });
  await page.evaluate(() => { window.__holdPrint = false; window.dispatchEvent(new Event("afterprint")); });
  await page.getByRole("button", { name: "New bill" }).click();
});

await step("billing: bill discount as a percentage, split payment across UPI and cash", async () => {
  await page.getByRole("button", { name: /Lux Soap/ }).first().click();
  await page.getByPlaceholder("₹ or %").fill("10%");
  await page.getByPlaceholder("₹ or %").press("Enter");
  eq(await total(), "₹106.00", "118 less 10% = 106.20, rounded");
  await page.keyboard.press("F9");
  await dialog().getByLabel("Amount", { exact: true }).first().fill("50");
  await dialog().getByRole("button", { name: "Split payment" }).click();
  eq(await dialog().getByLabel("Amount", { exact: true }).nth(1).inputValue(), "56.00", "remaining amount prefilled");
  await dialog().getByRole("button", { name: "Save bill" }).click();
  await dialog().getByText(/Invoice\s+INV/).waitFor();
  const pays = await sql("select method, amount from payments order by created_at desc, amount limit 2");
  eq(JSON.stringify(pays.map((p) => [p.method, p.amount]).sort()), JSON.stringify([["cash", "50.00"], ["upi", "56.00"]]), "split payments");
  const [s] = await sql("select discount_total, grand_total from sales order by created_at desc limit 1");
  eq(s.discount_total, "11.80", "discount");
  await page.getByRole("button", { name: "New bill" }).click();
});

await step("billing: a part-paid bill is refused without a customer", async () => {
  await page.getByRole("button", { name: /Lux Soap/ }).first().click();
  await page.keyboard.press("F9");
  await dialog().getByLabel("Amount", { exact: true }).first().fill("18");
  await dialog().getByRole("button", { name: "Save bill" }).click();
  await dialog().getByText("Select a saved customer to sell on credit").waitFor();
  await dialog().getByRole("button", { name: "Back" }).click();
});

await step("billing: create a customer at the counter and sell on credit", async () => {
  await page.getByRole("button", { name: /Walk-in customer/ }).click();
  await dialog().getByLabel("Search customers").fill("Ramesh");
  await dialog().getByRole("button", { name: "New customer" }).click();
  await dialog().getByLabel("Phone", { exact: true }).fill("9988776655");
  await dialog().getByRole("button", { name: "Save and select" }).click();
  await page.getByRole("button", { name: /Ramesh/ }).waitFor();
  await page.keyboard.press("F9");
  await dialog().getByLabel("Amount", { exact: true }).first().fill("18");
  await dialog().getByText("will be added to Ramesh's dues").waitFor();
  await dialog().getByRole("button", { name: "Save bill" }).click();
  await dialog().getByText(/Invoice\s+INV/).waitFor();
  eq((await sql("select balance from customers where name = 'Ramesh'"))[0].balance, "100.00", "customer balance");
  await page.getByRole("button", { name: "New bill" }).click();
});

let offlineRef;
await step("offline: the app reloads from the device and billing still works", async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || true);
  await page.reload();                     // make sure this page is controlled by the service worker
  await page.getByText("Lux Soap").first().waitFor();
  await context.setOffline(true);
  await page.reload();                     // no network at all: served by the service worker
  await page.getByText("Lux Soap").first().waitFor();
  await page.getByRole("button", { name: /Lux Soap/ }).first().click();
  await page.getByLabel("Increase Lux Soap").click();
  await pay();
  await dialog().getByText("saved on this device").waitFor();
  offlineRef = (await dialog().innerText()).match(/Ref\s+([0-9A-F]{8})/)[1];
  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByText(/Offline · 1 waiting/).first().waitFor();
  eq((await sql("select count(*) from sales"))[0].count, 3, "server has not seen the offline bill yet");
  await shot("pos-offline");
});

await step("offline: the waiting bill survives a reload and navigating between screens", async () => {
  await page.reload();
  await page.getByText(/Offline · 1 waiting/).first().waitFor();
  await page.getByRole("link", { name: "Sales" }).click();
  await page.getByText("not yet uploaded (1)").waitFor();
  await page.getByText(offlineRef).first().waitFor();
  await page.getByRole("link", { name: "Billing" }).click();
  await page.getByText("Lux Soap").first().waitFor();
  expect((await page.getByRole("button", { name: /Lux Soap/ }).first().innerText()).includes("4 pcs"), "local stock reflects the offline sale (10-2-1-1-2 = 4)");
});

await step("offline: an expired login token does not lock the till out", async () => {
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
    const session = JSON.parse(localStorage.getItem(key));
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem(key, JSON.stringify(session));
  });
  await page.reload();
  await page.getByRole("button", { name: /Lux Soap/ }).first().waitFor();
  await page.getByText(/Offline · 1 waiting/).first().waitFor();
});

await step("offline: back online, the bill uploads exactly once and stock is deducted once", async () => {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("All saved").first().waitFor({ timeout: 15000 });
  const rows = await sql("select invoice_no, grand_total from sales order by created_at desc");
  eq(rows.length, 4, "sales on server");
  eq(rows[0].grand_total, "236.00", "offline bill total");
  expect(/^INV\/\d\d-\d\d\/4$/.test(rows[0].invoice_no), `offline bill got the next invoice number (${rows[0].invoice_no})`);
  eq(await stock("Lux Soap"), 4, "soap stock");
  await page.reload();
  await page.getByText("All saved").first().waitFor({ timeout: 15000 });
  eq((await sql("select count(*) from sales"))[0].count, 4, "no duplicate after another sync");
});

await step("sales: history lists the bills; cancelling needs a reason and restores stock", async () => {
  await page.getByRole("link", { name: "Sales" }).click();
  await page.getByRole("cell", { name: /INV\/\d\d-\d\d\/4/ }).click();
  await dialog().getByRole("button", { name: "Cancel bill" }).click();
  const confirm = dialog();
  expect(await confirm.getByRole("button", { name: "Cancel bill" }).isDisabled(), "cannot cancel without a reason");
  await confirm.getByLabel("Reason").fill("Customer changed mind");
  await confirm.getByRole("button", { name: "Cancel bill" }).click();
  await page.getByText("Bill cancelled").first().waitFor();
  eq(await stock("Lux Soap"), 6, "stock restored");
  eq((await sql("select status from sales where invoice_no like '%/4'"))[0].status, "cancelled", "status");
  await page.locator("dialog[open]").first().getByText("Cancelled on").waitFor();
  await page.locator("dialog[open]").first().getByLabel("Close").click();
  await shot("sales");
});

await step("sales: search finds a bill by customer name", async () => {
  await field("Search").fill("rames");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Showing 1 of 1").waitFor();
  await page.getByRole("cell", { name: "Ramesh" }).waitFor();
  await field("Search").fill("");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByText("Showing 4 of 4").waitFor();
});

await step("sales: partial return issues a credit note, refunds and restocks", async () => {
  await page.getByRole("cell", { name: /INV\/\d\d-\d\d\/1$/ }).click();
  await dialog().getByRole("button", { name: "Return items" }).click();
  await dialog().getByLabel("Quantity of Lux Soap to return").fill("1");
  await dialog().getByRole("button", { name: "Record return" }).click();
  await page.getByText(/Return CN\/\d\d-\d\d\/1 recorded — refund ₹118.00/).waitFor();
  eq(await stock("Lux Soap"), 7, "restocked");
  eq((await sql("select amount from payments where kind = 'refund' and amount = 118"))[0]?.amount, "118.00", "refund payment");
  await page.locator("dialog[open]").first().getByLabel("Close").click();
});

await step("stock: receiving stock and a count correction update levels and history", async () => {
  await page.getByRole("link", { name: "Stock" }).click();
  await page.getByRole("row", { name: /Lux Soap/ }).getByRole("button", { name: "Adjust" }).click();
  await dialog().getByLabel("Quantity received").fill("24");
  await dialog().getByLabel("Cost per unit").fill("82.50");
  await dialog().getByRole("button", { name: "Save" }).click();
  await page.getByText("Lux Soap: stock is now 31 pcs").waitFor();
  await page.getByRole("row", { name: /Lux Soap/ }).getByRole("button", { name: "Adjust" }).click();
  await dialog().getByLabel("What happened?").selectOption("count");
  await dialog().getByLabel("Counted quantity").fill("30");
  await dialog().getByRole("button", { name: "Save" }).click();
  await page.getByText("Lux Soap: stock is now 30 pcs").waitFor();
  eq(await stock("Lux Soap"), 30, "stock");
  eq((await sql("select purchase_price from products where name = 'Lux Soap'"))[0].purchase_price, "82.50", "cost updated");
  await page.getByLabel("Stock history of Lux Soap").click();
  await dialog().getByText("Count correction").waitFor();
  await dialog().getByText("Stock received").waitFor();
  await dialog().getByLabel("Close").click();
  await shot("stock");
});

await step("customers: collecting dues reduces the balance; over-collection is refused", async () => {
  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("row", { name: /Ramesh/ }).getByRole("button", { name: "Collect" }).click();
  await dialog().getByLabel("Amount received").fill("500");
  await dialog().getByRole("button", { name: "Record payment" }).click();
  await dialog().getByText("owes only ₹100.00").waitFor();
  await dialog().getByLabel("Amount received").fill("60");
  await dialog().getByRole("button", { name: "Record payment" }).click();
  await page.getByText("Received ₹60.00 from Ramesh").waitFor();
  eq((await sql("select balance from customers where name = 'Ramesh'"))[0].balance, "40.00", "balance");
  await page.getByRole("row", { name: /Ramesh/ }).getByText("₹40.00").waitFor();
});

await step("dashboard and reports show figures that agree with the database", async () => {
  await page.getByRole("link", { name: "Dashboard" }).click();
  await page.getByText("Gross profit").first().waitFor();
  await shot("dashboard");
  await page.getByRole("link", { name: "Reports" }).click();
  await page.getByRole("button", { name: "Today" }).click();
  await page.getByText("GST by rate").waitFor();
  const [r] = await sql("select sum(grand_total) as billed, count(*) as n from sales where status = 'completed'");
  const body = await page.locator("main").innerText();
  expect(body.includes(`₹${Number(r.billed).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`), `billed total ₹${r.billed} shown`);
  expect(body.includes(`${r.n} bills`), `${r.n} bills shown`);
  await shot("reports");
});

await step("settings: owner changes the invoice prefix; next bill uses it", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await field("Invoice number prefix").fill("GS");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved").waitFor();
  eq((await sql("select invoice_prefix from businesses"))[0].invoice_prefix, "GS", "prefix");
});

await step("settings: A4 paper size switches bills to the full-page tax invoice layout", async () => {
  await page.getByRole("tab", { name: "This device" }).click();
  await field("Bill paper size").selectOption("a4");
  await page.getByText("Paper size saved").waitFor();
  await page.getByRole("link", { name: "Sales" }).click();
  await page.getByRole("cell", { name: /INV\/\d\d-\d\d\/1$/ }).click();
  await dialog().getByText("Authorised signatory").waitFor();
  await dialog().getByText("HSN/SAC").waitFor();
  await shot("invoice-a4");
  await dialog().getByLabel("Close").click();
  await page.getByRole("link", { name: "Settings" }).click();
});

await step("staff: owner adds a cashier, who can bill but cannot open management screens", async () => {
  const other = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const p2 = await other.newPage();
  await p2.goto(`${APP}/register/`);
  await p2.getByLabel("Email").fill("cashier@shop.test");
  await p2.getByLabel("Password").fill("cashier-pass-1");
  await p2.getByRole("button", { name: "Create account" }).click();
  await p2.waitForURL("**/setup/");
  await page.getByRole("tab", { name: "Staff" }).click();
  await field("Name").fill("Sunil");
  await field("Their account email").fill("cashier@shop.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Sunil added as cashier").waitFor();
  await p2.getByRole("button", { name: "Reload" }).click();
  await p2.waitForURL("**/pos/");
  await p2.getByText("Lux Soap").first().waitFor();
  expect((await p2.getByRole("link", { name: "Products" }).count()) === 0, "no Products link for cashier");
  expect((await p2.getByRole("link", { name: "Reports" }).count()) === 0, "no Reports link for cashier");
  await p2.goto(`${APP}/products/`);
  await p2.getByText("This screen is for the owner or a manager").waitFor();
  await p2.goto(`${APP}/sales/`);
  await p2.getByRole("cell", { name: /INV\/\d\d-\d\d\/2/ }).click();
  await p2.locator("dialog[open]").getByRole("button", { name: "Print" }).waitFor();
  expect((await p2.locator("dialog[open]").getByRole("button", { name: "Cancel bill" }).count()) === 0, "cashier has no Cancel bill button");
  await other.close();
});

await step("sign out and sign back in; wrong password is rejected", async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login/");
  await field("Email").fill("owner@shop.test");
  await field("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Wrong email or password").waitFor();
  await field("Password").fill("correct-horse-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Today" }).waitFor();
});

await step("phone layout and dark theme render the billing screen", async () => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(`${APP}/pos/`);
  await page.getByText("Lux Soap").first().waitFor();
  await page.getByRole("button", { name: /Lux Soap/ }).first().click();
  await page.getByRole("button", { name: /^Bill · 1/ }).click();
  await page.getByRole("button", { name: /Take payment/ }).waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll on a phone");
  await shot("pos-phone");
  await page.evaluate(() => { localStorage.setItem("ygpos-theme", "dark"); });
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.reload();
  await page.getByText("Lux Soap").first().waitFor();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark")), "dark theme applied");
  await shot("pos-dark");
});

await step("data integrity: stock equals movements, balances equal unpaid dues, no page errors", async () => {
  eq((await sql(`select count(*) from products p left join (select product_id, sum(qty_change) q from stock_movements group by 1) m on m.product_id = p.id where p.stock_qty <> coalesce(m.q, 0)`))[0].count, 0, "stock drift");
  eq((await sql(`select count(*) from customers c left join (select customer_id, sum(due_amount) d from sales where status = 'completed' group by 1) s on s.customer_id = c.id where c.balance <> coalesce(s.d, 0)`))[0].count, 0, "balance drift");
  expect(consoleErrors.length === 0, `page errors: ${consoleErrors.join(" | ")}`);
  expect(cspViolations.length === 0, `content security policy violations: ${cspViolations.join(" | ")}`);
});

await browser.close();
await new Promise((r) => web.close(r));
await new Promise((r) => api.close(r));
await pool.end();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
