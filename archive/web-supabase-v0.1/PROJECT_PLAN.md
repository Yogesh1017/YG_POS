# Project plan

## Scope decision

The original brief describes a multi-tenant commercial POS platform. It was then narrowed: **this is
for one shop first; prioritise billing, product management, sales history, invoices and basic
inventory; no payment gateways; keep the architecture simple.** This plan follows the narrowed scope.
The data model still isolates businesses from each other, so opening it to more shops later does not
need a redesign — but nothing has been built *for* that yet (no billing/subscriptions, no admin console).

## Assumptions made (change these if they are wrong)

| Assumption | Why | Cost of changing later |
| --- | --- | --- |
| One outlet per business | Single shop | Medium: add `outlet_id` to stock and sales, per-outlet stock levels |
| Three roles: owner, manager, cashier | Enough for a small shop; "administrator" and "inventory manager" fold into manager | Low: `member_role` enum + policies |
| Selling below zero stock is allowed | An offline till cannot know the true stock, and a counter sale has already happened | Low: a business setting checked in `create_sale` |
| Cashiers may change the price on a bill; every deviation from the catalog price is written to the audit log | Small shops negotiate | Low |
| Offline bills get their invoice number when they upload | Guarantees one gapless series without per-device series | Medium: per-device series |
| Times and financial years use India time (IST) | India-first | Low |
| Bill total rounds to the nearest rupee by default (switchable) | Common practice | None (setting) |

## Feature checklist

Legend: ✅ built and covered by automated tests · 🟡 built, lightly tested · ⬜ not built

### Authentication and business setup
- ✅ Sign-up, sign-in, sign-out, password recovery
- ✅ Shop profile, GST/tax settings, invoice prefix, receipt footer
- ✅ Roles (owner / manager / cashier) enforced in the database
- ✅ Business data isolation (Row Level Security)
- ⬜ Multiple outlets
- ⬜ Administrator and Inventory Manager as separate roles

### Billing
- ✅ Product search, barcode scan, category filter
- ✅ Cart, quantity (incl. fractional for weighed goods), price override, remove
- ✅ Line and bill discounts (₹ and %)
- ✅ GST calculation, inclusive and exclusive
- ✅ Cash, UPI, card, other; split payments; change
- ✅ Credit (due) sales
- ✅ Bill saved locally first; invoice number from server
- ✅ Printing: 80 mm, A4 (🟡 58 mm layout shares the 80 mm code but was not inspected separately)
- ✅ Cancellation and partial returns, owner/manager only, with reason / credit note
- ⬜ Hold and resume a bill
- ⬜ Items not in the catalog (ad-hoc line)

### Products
- ✅ Create, edit, delete (blocked once sold; deactivate instead)
- ✅ Categories, SKU, barcode, cost and selling price, tax rate, HSN/SAC, units, description, active flag
- ⬜ Product images
- ⬜ Variants

### Inventory
- ✅ Stock tracking tied to sales, cancellations and returns
- ✅ Stock in, damaged, expired, count correction
- ✅ Low-stock indicators, movement history, stock value at cost
- ⬜ Transfers between outlets
- ⬜ Batch / expiry-date tracking

### Customers
- ✅ Register, edit, delete (blocked once billed)
- ✅ Purchase history, balances, dues collection
- ⬜ Loyalty points, customer-specific discounts
- ⬜ Creating a customer while offline

### Suppliers, purchases, expenses
- ⬜ All of it. Stock received is recorded as a stock adjustment with an optional cost and note.

### Reports
- ✅ Today: billed, revenue, gross profit, GST, dues, stock value, low stock
- ✅ Date-range report, sales per day, payments by method, best sellers
- ✅ GST by rate and by HSN/SAC; CSV export
- ⬜ Net profit (needs expenses)
- ⬜ GSTR-1 / e-invoice export

### Offline
- ✅ App shell available offline (service worker)
- ✅ On-device catalog; local billing; persistent queue
- ✅ Automatic, idempotent upload; duplicate prevention; survives reload
- ✅ Opens even when the login token expired while offline
- ✅ Sync status indicator; rejected bills surfaced for review

### Security and reliability
- ✅ RLS on every table; financial tables are read-only to clients
- ✅ Server-side recomputation of all amounts; atomic functions
- ✅ Audit log for cancellations, returns, price deviations, staff changes
- ✅ Input validation on client (Zod) and server (constraints + function checks)
- ✅ Security headers and Content-Security-Policy
- 🟡 Rate limiting: relies on Supabase Auth's built-in limits; none added for the data API

### Deployment
- 🟡 Vercel configuration and instructions written; **not deployed**
- ⬜ CI pipeline

## Roadmap

1. **Trial (next).** Create the Supabase project, deploy, enter real products, run alongside the
   current billing method for a few days. Fix what the trial shows.
2. **Purchases and expenses.** Suppliers, purchase entries that add stock and cost, supplier dues,
   expense entries; then net profit on reports.
3. **Counter conveniences.** Hold/resume bills, ad-hoc items, product import from CSV, barcode label printing.
4. **Hardware.** If browser printing proves too slow at the counter: direct ESC/POS printing and
   drawer kick through WebUSB/WebSerial or a small local print helper.
5. **Compliance.** GSTR-1-shaped exports; e-invoicing only if turnover requires it.
6. **Growth, if wanted.** Multiple outlets, more roles, variants, onboarding for other shops.

## Technical risks

| Risk | Mitigation in place | Still open |
| --- | --- | --- |
| Device lost/cleared while bills are waiting | Bills upload within seconds when online; UI warns before sign-out | A device that dies offline loses its un-uploaded bills |
| Browser and database compute different totals | Shared rules, 150 randomised bills compared in tests; server value wins and mismatches are audited | — |
| Same bill uploaded twice | Bill id is the primary key; `create_sale` is idempotent, tested under concurrency | — |
| Stale prices on an offline till | Bill records the price shown to the customer; deviations audited | Owner must review the audit log |
| Behaviour differs on real Supabase | Standard Postgres + PostgREST features only | Needs the trial in step 1 |
| GST rules misapplied | Tested arithmetic; clear disclaimers | Needs an accountant's review; composition scheme, cess, reverse charge are not handled |
| Browser storage evicted by the OS | The app asks the browser for persistent storage; the catalog re-downloads | The browser may refuse the request; un-uploaded bills are the only data at risk |
