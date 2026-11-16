# Architecture

## In one picture

```
 Browser (counter PC / tablet / phone)                         Supabase project
┌───────────────────────────────────────────┐                ┌──────────────────────────────┐
│ Next.js app, exported as static files     │   HTTPS        │ Auth (email + password)      │
│  ├─ screens (React, client-rendered)      │ ─────────────► │ PostgREST API                │
│  ├─ cart (Zustand, saved to localStorage) │   supabase-js  │  ├─ tables behind RLS        │
│  ├─ IndexedDB (Dexie)                     │                │  └─ SQL functions (RPC)      │
│  │    catalog copy · sales queue          │                │ PostgreSQL                   │
│  └─ service worker (whole app, offline)   │                └──────────────────────────────┘
└───────────────────────────────────────────┘
 Hosting: any static host (Vercel). There is no application server.
```

## Decisions and reasons

### No application server; the database is the backend
Every screen is a client component that talks to Supabase directly. All rules that matter live in
PostgreSQL: Row Level Security decides who can read and write which rows, and every financial
operation is a `SECURITY DEFINER` SQL function that validates its input, recomputes every amount and
runs as a single transaction.

Why: a POS for one shop does not need a second backend to deploy, secure and keep running. Putting
the rules in the database means they hold no matter what the client sends, and they can be tested
directly with SQL (see `tests/db.test.ts`).

Trade-off: business logic is written in PL/pgSQL, which is less pleasant than TypeScript. It is kept
to a single migration file and documented in [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

### Static export instead of server rendering
`next.config.ts` sets `output: "export"`. This is a deliberate change from a typical Next.js setup:
a till must load with no network, and a fully static app can be stored on the device in its entirety.
Server rendering would add nothing (all data is per-user and fetched after sign-in) and would make
offline unreliable. Consequence: no dynamic route segments and no server actions; detail views are dialogs.

### Money is never a float
- Database: `numeric(12,2)` rupees, `numeric(14,3)` quantities.
- Browser: integer paise and integer thousandths of a unit (`src/lib/money.ts`); divisions use BigInt with explicit half-up rounding.
- Decimal values cross the API as strings in the sale payload.

Rounding rules (identical in `src/lib/tax.ts` and `create_sale()`):

```
gross   = round(qty × unit_price)
net     = gross − discount
price includes GST:   taxable = round(net × 100 / (100 + rate)),  tax = net − taxable
price excludes GST:   taxable = net,                              tax = round(net × rate / 100)
same state:  CGST = round(tax / 2), SGST = tax − CGST        other state: IGST = tax
bill total  = Σ(taxable + tax), then optionally rounded to the nearest rupee ("round off")
```

A bill-level discount is split across lines in proportion to their value before tax is computed, so
each rate is taxed on its discounted value. The test suite prices 150 random bills both ways and
requires agreement to the paisa.

### Offline-first billing
1. **App shell.** `scripts/build-sw.mjs` runs after the build and writes a service worker that lists
   every built file. On first visit the whole app (about 3 MB) is stored on the device. A new version
   is installed in the background and takes over only when the user accepts "Update now" or closes all
   tabs, so a bill in progress is never interrupted.
2. **Catalog.** Products, categories and customers are copied into IndexedDB on every sync. The
   billing screen reads only from this copy.
3. **Recording a sale** (`src/lib/checkout.ts`) never touches the network. In one IndexedDB transaction
   it stores the sale (with a client-generated UUID and a full printable snapshot) and adjusts the local
   stock and customer balance. The receipt can be printed immediately.
4. **Upload** (`src/lib/sync.ts`). Waiting sales are sent oldest-first to `create_sale()`. The sale's
   UUID is its primary key on the server, so a retry after a lost response returns the stored result
   instead of creating a second bill. Outcomes:
   - success → marked synced, invoice number stored;
   - network failure → stays waiting, retried on reconnect, tab focus and every 30 s;
   - session expired → stays waiting, user is told to sign in;
   - rejected by the server (validation) → marked *failed*, shown in the sync dialog for the owner to
     review and retry. It is never dropped silently.
5. **Conflicts.** The server is the source of truth for stock and balances. After each upload the
   catalog is re-downloaded and quantities used by still-waiting sales are re-applied locally. Sales are
   append-only facts, so there is nothing to merge: two tills selling the last item both succeed and
   stock goes negative, which is visible in the stock screen.
6. **Staying signed in offline.** The Supabase session is in localStorage. If the access token expires
   while offline, the app continues as the last signed-in user of that device using the cached
   membership; uploads resume after the token refreshes.

What is deliberately online-only: creating customers, editing products and stock, cancellations,
returns, dues collection, reports, settings.

### Roles
| | Owner | Manager | Cashier |
| --- | --- | --- | --- |
| Bill, view sales, add customers, collect dues | ✓ | ✓ | ✓ |
| Products, categories, stock adjustments | ✓ | ✓ | |
| Cancel bills, take returns, reports, audit log | ✓ | ✓ | |
| Shop/tax settings, staff | ✓ | | |

The UI hides what a role cannot do, but that is only for clarity — the database enforces the same table.

## Security

- **Isolation:** every table has `business_id` and RLS policies based on `app_role(business_id)`.
- **Least privilege:** table privileges are revoked from `anon`/`authenticated` and granted back
  column by column. Clients cannot write `products.stock_qty`, `customers.balance`, or any row of
  sales, payments, stock movements, returns, counters or the audit log.
- **No secrets in the browser:** only the Supabase URL and anon key are shipped; both are public by design.
- **Validation twice:** Zod schemas on forms; constraints and explicit checks in the database.
- **Audit log:** business creation, staff changes, cancellations, returns, billed prices or tax rates
  that differ from the catalog, and any mismatch between the till's total and the server's.
- **Sessions:** handled by Supabase Auth (short-lived JWT + rotating refresh token).
- **Rate limiting:** Supabase Auth limits sign-in, sign-up and email sending. Nothing extra is added
  on the data API; a signed-in member can only reach their own business anyway.
- **Headers:** `vercel.json` sets a Content-Security-Policy, `X-Frame-Options: DENY` and related headers.

Known gaps: no two-factor authentication; an owner can learn whether an email has an account through
"Add staff"; price overrides by cashiers are logged but not blocked.

## Printing and hardware

What a web page can and cannot do:

| Device | Approach | Limits |
| --- | --- | --- |
| Thermal (58/80 mm) and desktop printers | Browser print dialog with a print-only layout | Needs the printer's driver and the right paper size chosen once; one click per print unless the browser runs in kiosk-printing mode |
| Barcode scanner | Keyboard-emulating scanners type into the search box from anywhere on the billing screen | Scanner must send Enter after the code |
| Cash drawer | Wired to the receipt printer; the printer driver's "open drawer on print" option fires it | Cannot be opened from the browser without printing |

Direct ESC/POS control (silent printing, drawer kick, cutter) would need WebUSB/WebSerial or a small
local helper program. It is on the roadmap only if browser printing proves too slow.

## Backups and recovery

- **Server data:** Supabase paid plans take daily backups (point-in-time recovery is an add-on). On
  the free plan, schedule `pg_dump "$DATABASE_URL" > backup.sql` from another machine. Test a restore once.
- **Device data:** only un-uploaded bills are unique to a device. Everything else re-downloads.
- **Mistakes:** bills are cancelled or returned, never deleted; both leave an audit entry.

## Project layout

```
supabase/migrations/   schema, security, functions (run in order)
supabase/tests/        test-only shim that imitates Supabase's auth schema and roles
src/lib/               money, tax, gst, schemas, supabase client, db (IndexedDB), sync, checkout, session
src/stores/cart.ts     the bill in progress
src/components/        UI kit, app shell, receipt/printing, shared forms
src/app/(auth)/        sign-in, sign-up, password reset
src/app/(app)/         billing, sales, products, stock, customers, dashboard, reports, settings
scripts/               service worker generator
tests/                 unit + database integration tests (Vitest)
e2e/                   browser test and the test-only Supabase API stand-in
```
