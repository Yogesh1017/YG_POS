# YG POS

Wholesale billing, stock and accounts for an ice cream distribution business, as an offline
Windows desktop application. Everything runs on one computer. All data is kept in a local SQLite
database file on that computer. No internet, cloud service, network or account is needed for
any part of normal use.

**Status: version 1.0.0.** The business logic, the interface and the desktop shell are covered by
automated tests (see [Testing](#testing)), which pass on Linux. Before relying on it, read
[What has and has not been verified](#what-has-and-has-not-been-verified): the app has not yet been
run on your Windows PC or with your printers.

## What it does

| Area | Details |
| --- | --- |
| Invoices | Keyboard-first wholesale billing: customer, product search, unit, quantity, rate, discount. Final invoice number at once (`INV/26-27/1`). A4 tax invoice, thermal receipt, PDF file |
| Packing units | Each product has one smallest unit (piece, cup, kg…). Boxes, cartons and cases are conversions of it, set per product. Selling 2 cartons of 12 boxes × 10 pieces takes 240 pieces from stock |
| Pricing | A rate per unit, quantity prices ("5 cartons or more"), special rates per customer, and hand-typed rates that need an owner or manager |
| Customers | Credit sales, part payments, credit limits, opening balances, ledger with running balance, printable statement |
| Stock | Batches with expiry dates, earliest-expiry-first selling, expired stock blocked from sale, write-offs for damaged / melted / expired, stock counts, movement history |
| Purchases | Supplier bills add stock with batch, expiry and real cost; supplier balances, payments and ledger |
| Returns | Cancel an invoice, or return part of it (even part of a carton) against a credit note; returned goods go back to stock or to wastage |
| GST | Optional. GSTIN, CGST/SGST or IGST by customer state, a rate and HSN per product, rates before or including GST |
| Reports | Sales and profit (revenue, gross profit, wastage, expenses, net profit), by product, by customer, purchases, wastage, outstanding, stock value, GST summary, invoice register. CSV export |
| Users | Owner, manager, cashier — enforced inside the app's core, with an audit log |
| Safety | Automatic verified backups in two locations, restore with a safety copy, crash-safe database |

Not included: payment gateways or any online payment (payment methods are recorded only),
e-invoicing and e-way bills, the GST composition scheme, purchase returns to suppliers, product
import from Excel, freezer-wise stock, free-goods schemes (enter a line at rate 0 instead), and
advance payments from customers. The older web version is kept, unused, in `archive/`.

## Install on the billing computer

1. On GitHub, open the repository's **Actions** tab, then the latest successful **Windows build** run.
2. Under **Artifacts**, download **YG-POS-Windows-Installer** and unzip it.
3. Run `YG-POS-Setup-1.0.0.exe`. Windows will warn that the publisher is unknown, because the
   installer is not code-signed: choose **More info → Run anyway**.
4. Open **YG POS** from the desktop shortcut.

Requirements: Windows 10 or 11, 64-bit.

### First run

1. Create the owner login and enter the business details. Tick GST only if you have a GSTIN.
2. **Write down the recovery key** that is shown. It is the only way to reset a forgotten owner password.
3. **Settings → Backup and restore:** choose a second backup location on a USB or external drive.
   The app keeps warning until this is done.
4. **Settings → Printing:** choose the A4 and thermal printers (install them in Windows first).
5. **Settings → Users:** add logins for staff.
6. **Products:** add brands, then each product with its packing and rates. Enter stock in hand as
   opening stock, or enter supplier bills under **Purchases**.
7. **Customers / Suppliers:** add them, with any balance already outstanding as the opening balance.

### Everyday keys

| Key | Does |
| --- | --- |
| F1 | New invoice, from anywhere |
| F3 | Customer box |
| F2 | Product search (also accepts a barcode scan) |
| Enter | Pick the highlighted product; then in the quantity box, go back to product search |
| Tab | Move across quantity, rate and discount |
| F9 or Ctrl+Enter | Save the invoice |

## Where the data is

- Database: `%APPDATA%\YG POS\data\ygpos.db` (Help → Open data folder).
- Backups: the `backups` folder beside it, plus the second location you chose.
- Uninstalling the app does not delete this folder.

Backups are taken when the app opens, every two hours while open, and when it closes. Each backup
is reopened and checked after it is written. See [ARCHITECTURE.md](ARCHITECTURE.md#backup-and-recovery)
for the recovery steps, including moving to a new computer.

## What has and has not been verified

Verified by automated tests on Linux (all passing):

- 60 unit and database tests of the core: unit conversion, pricing, GST, invoice numbering, credit,
  ledgers, stock and batches, purchases, returns, reports, backup and restore.
- A 19-step browser test of the whole workflow against a real database, including a hard kill of
  the app mid-use and a restore from backup.
- A 5-step test of the real desktop shell: start-up, PDF export, single-instance lock, backup on
  close, data kept across restarts.

The same tests and the installer build run on a Windows machine at GitHub on every push; check the
**Actions** tab for the result of the latest run.

Not verified by me, and needing a check on your side:

1. **Your Windows PC.** Install it and go through one day's work on trial data.
2. **Your printers.** A4 and thermal layouts were checked on screen and as PDF, never on paper.
   Thermal output depends on the printer driver's paper settings.
3. **GST treatment.** The arithmetic is tested, but this software has not been reviewed or
   certified for GST compliance. Have your accountant check a printed invoice, the GST rate set on
   each product, and the GST report.
4. **A restore drill on the real machine.** After a few days of use, press *Check* on a backup in
   Settings and confirm the last invoice number and customer dues match.

## For developers

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

`npm start` opens the desktop app. To run without the shell, in a browser:

```bash
npm run serve
```

then open http://127.0.0.1:3210 (data goes to `.data/`; set `YGPOS_DATA` to change it).

Build the Windows installer on a Windows machine:

```bash
npm run dist
```

### Testing

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run test:desktop
```

The last two need Playwright (`npm install --no-save playwright` and `npx playwright install chromium`)
and a build. On Linux without a display, run the desktop test as `xvfb-run -a npm run test:desktop`.
Node.js 22.13 or newer is required (the built-in SQLite module is used; there are no native add-ons).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built, safety guarantees, backup and recovery
- [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) — tables, units, invariants, migrations
- [API_DOCUMENTATION.md](API_DOCUMENTATION.md) — the core's methods and permissions
- [PROJECT_PLAN.md](PROJECT_PLAN.md) — feature checklist, decisions, what is left
- [CHANGELOG.md](CHANGELOG.md)
