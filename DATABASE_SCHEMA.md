# Database schema

SQLite, one file. Defined in `desktop/core/migrations.ts`. All tables are `STRICT`; foreign keys
are enforced. See [ARCHITECTURE.md](ARCHITECTURE.md#numbers) for how money and quantities are stored.

## Tables

| Table | Holds |
| --- | --- |
| `settings` | One row: business profile, GSTIN and state, invoice prefix, round-off, invoice texts, recovery-key hash |
| `config` | Per-computer preferences: printers, second backup folder, last backup times |
| `users` | Username, name, role (`owner` / `manager` / `cashier`), password hash, active flag |
| `doc_counters` | Last number issued per series (`invoice`, `credit_note`) and financial year |
| `brands`, `categories` | Names |
| `products` | Name, brand, category, flavour, pack size, SKU, barcode, HSN, GST rate, rate-includes-GST flag, **base unit**, counted or weighed, expiry tracking, low-stock level, latest cost, shortfall |
| `product_units` | Packing units: name, `factor_m` (base units inside), rate, default-for-sale / purchase flags, active flag. One row per product is the base unit |
| `price_tiers` | Quantity prices: unit, minimum quantity, rate |
| `customers` | Shop name, contact, phone, GSTIN, state, address, credit limit, opening balance, `opening_due`, `balance` |
| `customer_prices` | Rate agreed with a customer for a unit |
| `suppliers` | Name, contact, GSTIN, opening balance, `opening_due`, `balance` (what we owe) |
| `purchases`, `purchase_items` | Supplier bills and lines (unit snapshot, quantity, rate, discount, GST, batch created) |
| `stock_batches` | Every lot of stock: product, batch no, manufacture and expiry dates, quantity received, **quantity remaining**, cost per base unit, source |
| `stock_movements` | Append-only stock ledger: product, batch, signed quantity, reason, reference, cost, note, who, when |
| `sales`, `sale_items` | Invoices and lines (customer snapshot; unit snapshot; quantity in the unit sold and in base units; rate, list rate and price source; discount; GST split; cost) |
| `sale_item_batches` | Which batches each invoice line took, how much, at what cost, and how much has come back |
| `sale_returns`, `sale_return_items` | Credit notes: quantity returned per line, its condition (restock / damaged / melted / expired), value, how it was settled |
| `payments` | Money received from or refunded to customers: kind (`sale`, `collection`, `refund`), method, amount, invoice or opening balance |
| `supplier_payments` | Money paid to or refunded by suppliers |
| `expenses`, `expense_categories` | Running costs |
| `audit_log` | Who did what: set-up, settings, users, approvals, cancellations, returns, stock adjustments, purchases, restores |

Stock movement reasons: `opening`, `purchase`, `purchase_cancel`, `sale`, `sale_cancel`,
`sale_return`, `adjustment`, `damaged`, `melted`, `expired`.

## Rules the database itself enforces

- A batch's remaining quantity can never be below zero.
- A counted product can never hold a fraction of a base unit (triggers on batches and movements).
- Stock movements and the audit log cannot be edited or deleted.
- Invoice numbers, credit-note numbers and `(financial year, sequence)` are unique.
- `client_ref` is unique on invoices, purchases and credit notes (stops double submits).
- SKU, barcode, usernames, brand and category names are unique; unit names are unique per product.
- A GST-registered business must have a GSTIN whose first two digits equal its state code.
- Amounts, rates and quantities have range checks; balances cannot be negative.

## Invariants the tests check after every scenario

- For each product: sum of batch quantities − shortfall = sum of its stock movements.
- For each customer: `balance` = `opening_due` + unpaid amounts on their completed invoices = the ledger's closing balance.
- For each supplier: the same, with purchases.
- For each invoice: sum of line totals + round-off = invoice total.

## Ledgers

Customer and supplier ledgers are not stored. They are built on request from invoices, payments,
credit notes, cancellations and the opening balance, so they cannot disagree with those records.

## Changing the schema

Add a new entry at the end of the `MIGRATIONS` list. Never edit an entry that has shipped. The
list position is the schema version (`PRAGMA user_version`). On start-up the app applies any missing
entries, each in its own transaction, after keeping a `pre-upgrade` copy of the database. Changes
must be additive (new tables, new columns with defaults). Run `npm test`: the backup tests include
upgrading an older database and restoring an older backup.
