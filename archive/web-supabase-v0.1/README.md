# YG POS

Billing, stock and sales software for a single Indian retail shop. It runs in the browser on the
counter PC, a tablet or a phone, keeps billing working when the internet drops, and stores the
shop's data in your own Supabase (PostgreSQL) project.

**Status: version 0.1 — built and tested locally, not yet deployed.** Everything listed under
"What works" below has automated tests behind it, but those tests ran against a local PostgreSQL
database and a test stand-in for the Supabase API. It has not yet been run against a real Supabase
project or used in a shop. Do a trial day alongside your current billing method before relying on it.
See [Before you rely on it](#before-you-rely-on-it).

## What works

| Area | What you can do |
| --- | --- |
| Billing | Search or scan items, edit quantity/price, line and bill discounts (₹ or %), cash/UPI/card/split payments, change calculation, credit (due) sales to saved customers, keyboard shortcuts (F2 search, F9 pay) |
| GST | Optional. GSTIN and state, per-product rate and HSN/SAC, tax-inclusive or exclusive prices, CGST+SGST or IGST by place of supply, tax invoice numbering per financial year (`INV/26-27/1`) |
| Bills | 58 mm / 80 mm thermal and A4 layouts through the browser print dialog; reprint any bill |
| Offline | The app and product list are stored on the device. Bills made offline are saved on the device and upload by themselves, exactly once, when the connection returns |
| Sales history | Filter by date, search by invoice/customer, cancel a bill (owner/manager, reason required), partial returns with credit note numbers |
| Products | Add/edit/delete, categories, SKU, barcode, cost price, units, active/inactive |
| Stock | Automatic deduction on sale, restock on cancel/return, receive stock, damaged/expired, count correction, low-stock list, movement history, stock value |
| Customers | Saved customers, dues, collect payments (oldest bill first), purchase history |
| Reports | Today dashboard; any date range: billed amount, revenue, gross profit, GST by rate and HSN, payments by method, best sellers; CSV export |
| Staff | Owner, manager and cashier roles enforced by the database |

Not built yet (see [PROJECT_PLAN.md](PROJECT_PLAN.md)): suppliers and purchase orders, expenses and
net profit, multiple outlets, product variants and images, loyalty points. Online payment gateways
are intentionally out of scope: UPI and card payments are *recorded*, not processed.

## Set up

You need Node.js 20 or newer and a free [Supabase](https://supabase.com) account.

### 1. Create the database

1. Create a new Supabase project (choose the Mumbai region for a shop in India).
2. Open **SQL Editor** and run the three files in `supabase/migrations/` **in filename order**,
   one at a time. (Or with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.)
3. In **Authentication → URL Configuration**, set *Site URL* to where the app will be hosted
   (for example `https://your-app.vercel.app`) and add `http://localhost:3000/**` under *Redirect URLs* for local use.
4. Keep *Confirm email* turned on under **Authentication → Sign In / Providers → Email**.

### 2. Configure and run

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Project Settings → API**.
Only ever use the **anon / publishable** key. The `service_role` key must never be put in this app.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000, create your account, confirm the email, and fill in the shop details.

Offline support (the service worker) is only active in a production build:

```bash
npm run build
```

```bash
npm run preview
```

### 3. Deploy (Vercel)

1. Import this repository in Vercel. The defaults work (framework: Next.js, build command `npm run build`).
2. Add the two `NEXT_PUBLIC_…` environment variables.
3. Deploy, then put the deployed URL into Supabase's *Site URL* (step 1.3).

The app is a static site; `vercel.json` adds security headers. If your Supabase project is not on a
`*.supabase.co` address, update `connect-src` in the Content-Security-Policy there.

### Adding staff

Staff create their own account on the sign-up page. The owner then adds that email under
**Settings → Staff** as cashier or manager.

## Using it day to day

- **First time on each device:** open the app once while online so it can store itself and the product list.
- **Offline:** the cloud icon at the bottom of the menu shows the state. Bills made offline print with a
  reference code; the invoice number is assigned when the bill uploads, and the bill can then be reprinted from Sales.
  New customers, product changes, stock changes, cancellations, returns and reports need a connection.
- **Never clear the browser's site data while bills are waiting to upload** — they exist only on that device until then.
- **Printing:** choose the paper size under **Settings → This device**. In the print dialog pick the matching
  paper and turn off headers/footers. A browser cannot drive a printer or cash drawer directly; see
  [ARCHITECTURE.md](ARCHITECTURE.md#printing-and-hardware).

## Before you rely on it

- Run the migrations on a real Supabase project and go through signup → products → a few bills → a
  cancellation → an offline bill. This path is covered by the automated tests, but only against the test setup.
- Ask your accountant to check a printed tax invoice and the GST report. The tax arithmetic is tested,
  but **this software has not been reviewed or certified for GST compliance** (no e-invoicing, no GSTR export).
- Turn on database backups (Supabase paid plans include daily backups; on the free plan run `pg_dump`
  on a schedule). See [ARCHITECTURE.md](ARCHITECTURE.md#backups-and-recovery).

## Testing

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm test
```

`npm test` runs the bill-arithmetic unit tests and, if a local PostgreSQL 15+ server is reachable, the
database tests (security rules, sale/cancel/return/dues functions, and a check that the browser and
database arithmetic agree to the paisa). Set `TEST_DATABASE_URL` to an admin connection string; the
default is `postgres://postgres:postgres@127.0.0.1:5432/postgres`. The tests create and drop their own
scratch databases and never touch Supabase.

The browser test drives the built app in Chromium against the same local PostgreSQL. It needs Playwright
installed and a build made with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`:

```bash
npm run build
```

```bash
npm run test:e2e
```

## Documentation

- [PROJECT_PLAN.md](PROJECT_PLAN.md) — scope, feature checklist, roadmap, risks
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built and why
- [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) — tables, constraints, security rules
- [API_DOCUMENTATION.md](API_DOCUMENTATION.md) — database functions the app calls
- [CHANGELOG.md](CHANGELOG.md)
