# Database schema

PostgreSQL 15+. Defined in `supabase/migrations/`. Money is `numeric(12,2)` (rupees), quantities
`numeric(14,3)`, timestamps `timestamptz`.

## Relationships

```
businesses ─┬─ business_members ── auth.users
            ├─ invoice_counters
            ├─ categories ── products ── stock_movements
            ├─ customers
            ├─ sales ─┬─ sale_items ── products
            │         ├─ payments ── customers
            │         └─ sale_returns ── sale_return_items ── sale_items
            └─ audit_log
```

Every table carries `business_id`. Where a row points at another business-owned row, a composite
foreign key `(id, business_id)` guarantees both belong to the same business.

## Tables

### businesses
The shop. `name`, `legal_name`, contact and address fields, `state_code` (2-digit GST state code),
`gst_registered`, `gstin`, `default_tax_rate`, `prices_include_tax`, `round_off_total`,
`invoice_prefix` (1–4 capitals/digits, not `CN`), `receipt_footer`.
Check `gst_details_required`: a GST-registered business must have a GSTIN whose first two digits equal `state_code`.

### business_members
`(business_id, user_id)` primary key, `role` (`owner` | `manager` | `cashier`), `display_name`, `email`, `is_active`.
Deactivating a member removes all access immediately.

### invoice_counters
`(business_id, series, fy)` → `last_no`. Series are `invoice` and `credit_note`; `fy` is the Indian
financial year such as `26-27`. Incremented inside the same transaction as the document, so numbers
are consecutive with no gaps. Not readable or writable by clients.

### categories
`name`, unique per business (case-insensitive).

### products
`name`, `category_id`, `sku` (unique per business, case-insensitive), `barcode` (unique per business),
`hsn_code` (4–8 digits), `unit`, `sale_price`, `purchase_price`, `tax_rate` (0–100),
`price_includes_tax`, `track_stock`, `stock_qty`, `low_stock_threshold`, `description`, `is_active`.
`stock_qty` is maintained by a trigger and always equals the sum of the product's stock movements.
A product referenced by a sale cannot be deleted (deactivate it instead).

### customers
`name`, `phone` (unique per business), `gstin`, `state_code`, `address`, `balance`.
`balance` (what the customer owes) is maintained by the sale/return/payment functions and always
equals the sum of `due_amount` over the customer's completed sales.

### sales
One bill. `id` is generated on the till and is the idempotency key.
`invoice_no` (unique per business), `fy`, `status` (`completed` | `cancelled`), customer link and a
snapshot of the customer's name/phone/GSTIN, `place_of_supply`, `is_interstate`, totals
(`gross_total`, `discount_total`, `taxable_total`, `cgst_total`, `sgst_total`, `igst_total`,
`tax_total`, `round_off`, `grand_total`), `paid_total`, `due_amount`, `cost_total`, `returned_total`,
`note`, `sold_at` (time at the till), `created_at` (time recorded by the server), `created_by`, and
cancellation fields.

### sale_items
One line. Snapshots `name`, `hsn_code`, `unit` and `unit_cost` from the product at sale time, plus
`qty`, `unit_price`, `price_includes_tax`, `gross_amount`, `discount_amount`, `tax_rate`,
`taxable_value`, `cgst`, `sgst`, `igst`, `line_total`, `tracked_stock`, `returned_qty`.

### payments
Money movements: `kind` is `sale` (paid at billing), `due_collection` (paid later) or `refund`
(money paid back; stored as a positive amount). `method` is `cash` | `upi` | `card` | `other`.
`batch_id` groups the rows written by one dues collection.

### sale_returns, sale_return_items
A return against a bill with its `credit_note_no`, whether goods were `restocked`, value
(`taxable_total`, `tax_total`, `total`), and how it was settled (`due_reduced`, `refund_paid`).

### stock_movements
Append-only ledger: `product_id`, `qty_change`, `reason` (`opening`, `stock_in`, `sale`,
`sale_cancel`, `sale_return`, `adjustment`, `damage`, `expiry`), `ref_type`/`ref_id` linking to the
sale or return that caused it, `unit_cost`, `note`, `created_by`.

### audit_log
`action`, `entity`, `entity_id`, `details` (JSON), `user_id`, `created_at`. Readable by owner and manager.

## Indexes

Beyond primary and unique keys: sales by `(business_id, sold_at desc)` and by customer; sale items by
sale and by `(business_id, product_id)`; payments by `(business_id, paid_at desc)`, sale and batch;
stock movements by `(product_id, created_at desc)` and `(business_id, created_at desc)`; products and
customers by `(business_id, lower(name))`; members by user.

## Access rules

`app_role(business_id)` returns the caller's role, or null if they are not an active member.

| Table | Read | Insert / update / delete from the client |
| --- | --- | --- |
| businesses | members | update by owner (listed columns only) |
| business_members | members | none — `add_member`, `set_member` |
| categories, products | members | owner, manager (not `stock_qty`) |
| customers | members | any member may add/edit (not `balance`); delete by owner, manager |
| sales, sale_items, payments, sale_returns, sale_return_items, stock_movements | members | none — functions only |
| audit_log | owner, manager | none |
| invoice_counters | nobody | none |

Anonymous (not signed in) users have no access to any table or function.

## Changing the schema

Add a new timestamped file in `supabase/migrations/`; never edit one that has been applied to a real
database. Run `npm test` — the database tests rebuild a scratch database from all migrations.
