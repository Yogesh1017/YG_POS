# Core API

The interface calls the core with `POST /api/rpc` and a JSON body `{ "method": "...", "args": { … } }`,
plus the session token in the `x-session` header. The address is the app's own (`app://ygpos`); it
is not reachable from outside the app. Every reply is `{ ok: true, data }` or
`{ ok: false, error: { code, message, data? } }`.

Error codes: `auth` (sign in again), `forbidden`, `invalid`, `not_found`, `conflict`,
`needs_approval`, `internal` (nothing was saved).

Each method validates its input, checks the caller's role, and runs in one database transaction.
Money is in paise, quantities in thousandths (`*_m`), dates `YYYY-MM-DD`.

Roles: **A** = anyone signed in, **M** = owner or manager, **O** = owner, **P** = no sign-in needed.

## Sign-in, users, settings

| Method | Role | Purpose |
| --- | --- | --- |
| `app.status` | P | Whether first-run setup is done; the signed-in user |
| `setup.create` | P | First run only: owner login + business profile. Returns a session and the recovery key |
| `auth.login`, `auth.logout` | P | Start / end a session |
| `auth.changePassword` | A | Change own password |
| `auth.recover` | P | Reset the owner password with the recovery key; issues a new key |
| `settings.get` / `settings.update` | A / O | Business, GST and invoice settings |
| `config.get` / `config.set` | A | Printer preferences; `backup_dir_2` is owner-only |
| `users.list`, `users.create`, `users.update` | O | Staff logins, roles, access, password reset |
| `audit.list` | O | Recent audit entries |

## Catalog and stock

| Method | Role | Purpose |
| --- | --- | --- |
| `brands.*`, `categories.*`, `expense_categories.*` (`list`, `save`, `delete`) | A / M | Simple lists |
| `products.list` | A | Products with units, quantity prices, stock on hand, expired and sellable quantities |
| `products.save` | M | Create or update a product, its packing units, rates and quantity prices; optional opening stock for a new product |
| `products.delete` | M | Only for products with no stock or invoice history |
| `stock.adjust` | M | `add` (opening stock / count correction), `remove` (damaged / melted / expired / correction, optionally from one batch), or `set` (counted quantity) |
| `stock.batches`, `stock.movements`, `stock.expiring` | A | Batches on hand, movement history, expired and soon-to-expire batches |

## Invoices

### `sales.create` (A)

```jsonc
{
  "client_ref": "uuid made by the screen",   // a repeat returns the first result
  "customer_id": 12,                          // or null for a cash sale
  "cash_customer_name": "…",                  // optional name on a cash sale
  "note": "…",
  "bill_discount": 10000,
  "items": [ { "product_id": 3, "unit_id": 9, "qty_m": 2000, "unit_price": 108000, "discount": 0 } ],
  "payments": [ { "method": "cash", "amount": 100000, "reference": null } ],
  "approved": ["price", "stock", "credit"],   // what the user confirmed after a needs_approval reply
  "approver": { "username": "…", "password": "…" }   // when a cashier is billing
}
```

Returns the saved invoice with lines, payments and returns. If something needs approval the reply is
`needs_approval` with `data.problems` (each `{ type, message }`) and `data.needs_manager`; nothing is
saved until the request is sent again with `approved` (and `approver` for a cashier).

| Method | Role | Purpose |
| --- | --- | --- |
| `sales.list` | A | Filter by date range, text (number, customer, phone), customer, status (`paid`, `partial`, `unpaid`, `cancelled`) |
| `sales.get` | A | One invoice with lines, payments, returns |
| `sales.cancel` | M | Cancel with a reason: stock back to its batches, due removed, refund recorded, number kept |
| `sales.return` | M | Credit note for quantities in base units, each `restock`, `damaged`, `melted` or `expired`. Reduces the invoice's due first, then refunds (never more than was received) |
| `returns.get` | A | One credit note with its lines |

## Customers, suppliers, purchases, expenses

| Method | Role | Purpose |
| --- | --- | --- |
| `customers.list`, `customers.save` | A | Cashiers may add and edit customers but not credit limits, opening balances or active status |
| `customers.delete` | M | Only with no invoices or payments |
| `customers.prices`, `customers.setPrice` | A / M | Rates agreed with a customer |
| `customers.recent` | A | Last rate per unit and recent invoices, shown while billing |
| `customers.collect` | A | Record a payment received: opening balance first, then oldest invoices. Idempotent on `client_ref` |
| `customers.ledger` | A | Statement with running balance, optional date range |
| `suppliers.list`, `save`, `delete`, `pay`, `ledger` | M | The same for suppliers |
| `purchases.create` | M | Supplier bill: adds a batch per line, sets product cost, records payment and amount owed. Refuses a repeated bill number for the same supplier |
| `purchases.list`, `purchases.get` | M | Purchase history |
| `purchases.cancel` | M | Only while none of its stock has been sold or adjusted |
| `expenses.list`, `save`, `delete` | M | Running costs (deletions are audited) |

## Reports

| Method | Role | Returns |
| --- | --- | --- |
| `reports.dashboard` | A | Today and month figures, 14-day trend, best sellers, low stock. Profit, purchases and supplier figures are withheld from cashiers |
| `reports.summary` | M | Sales, returns, revenue, cost, gross profit, wastage, expenses, net profit, purchases, by day, by payment method, balances |
| `reports.products`, `reports.customers`, `reports.purchases` | M | Breakdowns for a date range |
| `reports.wastage` | M | Damaged / melted / expired entries and totals at cost |
| `reports.outstanding` | M | Customers who owe and suppliers we owe, with oldest unpaid date |
| `reports.stock` | M | Stock on hand, expired quantity and value at cost per product |
| `reports.gst` | M | Output GST by rate and HSN, credit notes, input GST on purchases |
| `reports.invoiceRegister` | M | Every invoice number in a financial year with status, and any missing numbers |

Definitions: **revenue** = taxable value of invoices less returns (GST is never revenue);
**gross profit** = revenue − actual cost of the batches sold (restocked returns added back);
**net profit** = gross profit − wastage at cost − expenses.

## Backup

| Method | Role | Purpose |
| --- | --- | --- |
| `backup.status` | M | Folders, last backup times, warning text, list of backups |
| `backup.now` | M | Take and verify a backup; copy to the second location |
| `backup.inspect` | O | Check any backup file and show its date, last invoice, dues and stock value |
| `backup.restore` | O | Replace the live data with a backup (after saving a `pre-restore` copy). Signs everyone out |

## Desktop bridge (`window.desktop`, inside the app only)

`print({ paper, printer?, silent? })`, `savePdf({ paper, filename })`, `printers()`, `pickFolder()`,
`pickBackupFile()`, `openFolder(folder)`, `version()`.
