// Tests the real desktop shell (Electron): the window loads from the private app:// address, the
// database lives in the app's data folder, "Save PDF" writes a real PDF, a backup is taken on
// close, and data is still there after restarting. Run:  npm run build && npm run test:desktop
// On Linux without a display:  xvfb-run -a npm run test:desktop
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");
const electronPath = require("electron"); // the project's own Electron binary
const root = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "ygpos-desktop-"));
const pdfDir = mkdtempSync(path.join(tmpdir(), "ygpos-pdf-"));
const launch = () => electron.launch({ executablePath: electronPath, cwd: root, args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])], env: { ...process.env, YGPOS_DATA: dataDir, YGPOS_PDF_DIR: pdfDir } });

let passed = 0;
const failures = [];
async function step(name, fn) {
  if (failures.length) return console.log(`  - ${name} (skipped: an earlier step failed)`);
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log("YG POS desktop shell");
let app = await launch();
let page = await app.firstWindow();
page.setDefaultTimeout(15000);
const rpc = (method, args = {}) => page.evaluate(async ([m, a]) => {
  const r = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json", "x-session": sessionStorage.getItem("ygpos-session") ?? "" }, body: JSON.stringify({ method: m, args: a }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error.message);
  return j.data;
}, [method, args]);

await step("the window opens on the app's private address and shows first-run setup", async () => {
  await page.waitForURL("app://ygpos/setup/");
  await page.getByRole("heading", { name: "Set up YG POS on this computer" }).waitFor();
  expect(existsSync(path.join(dataDir, "ygpos.db")), "database created in the data folder");
});

await step("setup works through the interface; the desktop bridge is available", async () => {
  await page.getByLabel("Your name", { exact: true }).fill("Yogesh");
  await page.getByLabel("Username", { exact: true }).fill("yogesh");
  await page.getByLabel("Password", { exact: true }).fill("owner-pass");
  await page.getByLabel("Password again", { exact: true }).fill("owner-pass");
  await page.getByLabel("Business name", { exact: true }).fill("Gupta Ice Cream Agency");
  await page.getByRole("button", { name: "Create and continue" }).click();
  await page.getByRole("button", { name: "I have written it down" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  expect(Array.isArray(await page.evaluate(() => window.desktop.printers())), "printer list available");
  expect(/^\d+\.\d+\.\d+$/.test(await page.evaluate(() => window.desktop.version())), "version available");
  expect(await page.evaluate(() => typeof window.require === "undefined" && typeof window.process === "undefined"), "the page has no direct access to the computer");
});

let invoiceNo;
await step("an invoice made in the desktop app can be saved as a real PDF file", async () => {
  const p = await rpc("products.save", { name: "Choco Bar", tax_rate_bp: 0, price_includes_tax: false, base_unit: "pcs", qty_decimals: 0, track_expiry: false, low_stock_m: 0, cost4: 120000, is_active: true, base_price: 2000,
    units: [{ name: "Box", factor_m: 24000, sale_price: 45000 }], default_sale_unit: "Box", opening: { qty_m: 480000 } });
  expect(p.on_hand_m === 480000, "opening stock saved");
  await page.keyboard.press("F1");
  await page.getByLabel("Search products").fill("choco");
  await page.keyboard.press("Enter");
  await page.keyboard.type("3");
  await page.keyboard.press("F9");
  await page.getByText("Invoice saved").waitFor();
  invoiceNo = (await page.locator("dialog[open]").innerText()).match(/INV\/\d\d-\d\d\/\d+/)[0];
  await page.getByRole("button", { name: "Save PDF" }).click();
  await page.getByText(/^Saved .*\.pdf/).waitFor();
  const file = path.join(pdfDir, `${invoiceNo.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`);
  expect(existsSync(file), `PDF written to ${file}`);
  const pdf = readFileSync(file);
  expect(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 5000, `a real PDF (${pdf.length} bytes)`);
  console.log(`      PDF: ${path.basename(file)}, ${pdf.length} bytes`);
  if (process.env.E2E_SCREENSHOTS) copyFileSync(file, path.join(process.env.E2E_SCREENSHOTS, "invoice.pdf"));
});

await step("opening a second copy does not start a second app on the same database", async () => {
  // The second copy must quit by itself straight away (Playwright reports that as "has been closed").
  let windows = 0;
  try {
    const second = await launch();
    await new Promise((r) => setTimeout(r, 2500));
    windows = second.windows().length;
    await second.close().catch(() => {});
  } catch (e) {
    if (!/has been closed|exited/i.test(String(e.message))) throw e;
  }
  expect(await page.getByText("Invoice saved").isVisible(), "the first copy is still running, untouched");
  expect(windows === 0, `second copy opened ${windows} window(s)`);
});

await step("closing the app takes a verified backup; reopening shows the same data and asks to sign in", async () => {
  await app.close();
  const backups = readdirSync(path.join(dataDir, "backups"));
  expect(backups.some((f) => f.endsWith("-close.db")), `backup on close (${backups.join(", ")})`);
  expect(backups.every((f) => statSync(path.join(dataDir, "backups", f)).size > 4096), "backups are not empty");
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL("app://ygpos/login/");
  await page.getByLabel("Username", { exact: true }).fill("yogesh");
  await page.getByLabel("Password", { exact: true }).fill("owner-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  const sales = await rpc("sales.list", {});
  expect(sales.rows.length === 1 && sales.rows[0].invoice_no === invoiceNo, "the invoice is still there");
  const status = await rpc("backup.status");
  expect(status.backups.some((b) => b.kind === "start"), "backup taken on start");
  await app.close();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
