# API

There is no custom HTTP API. The app uses the Supabase client for:

1. **Table access** (PostgREST) for simple reads and catalog edits, limited by the rules in
   [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md#access-rules).
2. **Database functions** (`supabase.rpc(name, args)`) for everything that changes money or stock.

All functions require a signed-in user, run as one transaction, and raise an error with a readable
message when they refuse. Common error codes: `42501` not allowed, `22023` invalid input,
`23503` referenced row missing, `P0002` not found.

## create_business(p jsonb) → uuid
Creates a business and makes the caller its owner.
`p`: `name` (required), `owner_name`, `legal_name`, `phone`, `email`, `address`, `city`, `pincode`,
`state_code`, `gst_registered`, `gstin`, `default_tax_rate`, `prices_include_tax`.

## create_sale(p jsonb) → jsonb
Records a bill. Any member.

```jsonc
{
  "id": "uuid generated on the till",       // idempotency key
  "business_id": "uuid",
  "sold_at": "2026-11-13T18:30:00+05:30",   // optional; a time in the future is replaced by now
  "customer_id": "uuid | null",             // required when the bill is not fully paid
  "customer_name": "…", "customer_phone": "…", "customer_gstin": "…",   // for one-off customers
  "place_of_supply": "27",                  // GST state code; default: customer's, else the shop's
  "note": "…",
  "client_total": "236.00",                 // what the till showed; compared, never stored
  "items": [
    { "product_id": "uuid", "qty": "2.000", "unit_price": "118.00", "discount": "0.00",
      "tax_rate": "18.00", "price_includes_tax": true }
  ],
  "payments": [ { "method": "cash", "amount": "236.00", "reference": null } ]
}
```

Behaviour:
- Recomputes every amount (see the rounding rules in [ARCHITECTURE.md](ARCHITECTURE.md#money-is-never-a-float)).
  `tax_rate` and `price_includes_tax` default to the product's values; tax is forced to 0 when the
  business is not GST-registered.
- Validates quantities (> 0, ≤ 3 decimals), prices (≥ 0, 2 decimals), discounts (≤ line amount),
  payments (> 0, sum ≤ bill total), up to 500 items.
- Writes sale, items, payments and stock movements; raises the customer's balance by any unpaid
  amount; assigns the next invoice number for the financial year of `sold_at`.
- Audits billed prices/tax rates that differ from the catalog, and a `client_total` that differs from the computed total.
- **Idempotent:** calling again with the same `id` changes nothing and returns the original result with `"duplicate": true`.

Returns `{ id, invoice_no, status, gross_total, discount_total, taxable_total, cgst_total,
sgst_total, igst_total, tax_total, round_off, grand_total, paid_total, due_amount, duplicate }`.

## cancel_sale(p_sale_id uuid, p_reason text) → jsonb
Owner or manager. Voids a whole bill: restores stock, removes its due from the customer's balance,
records refunds mirroring the payments received, marks the sale cancelled (the invoice number is kept).
Requires a reason of at least 3 characters. Refused if the sale already has returns. Calling it on an
already cancelled sale is a no-op.

## create_return(p jsonb) → jsonb
Owner or manager. `p`: `id` (uuid, idempotency key), `sale_id`, `items: [{ sale_item_id, qty }]`,
`restock` (boolean, default true), `refund_method`, `reason`.
Returns part or all of a bill's lines. Each line's value is its proportional share of the line total
(the last unit takes the remainder, so partial returns never drift by a paisa). The value first
reduces any unpaid due on the bill; the rest is recorded as a refund by `refund_method`, never more
than was received. Restocked goods create stock movements. Assigns a credit note number (`CN/26-27/1`).
Returns `{ id, credit_note_no, total, due_reduced, refund_paid, duplicate }`.

## adjust_stock(p_product_id uuid, p_qty_change numeric, p_reason stock_reason, p_note text, p_unit_cost numeric) → numeric
Owner or manager. Manual stock change; returns the new stock level.
`p_reason`: `opening` or `stock_in` (quantity must be positive; `p_unit_cost`, if given, becomes the
product's cost price), `damage` or `expiry` (must be negative), `adjustment` (either sign).

## record_customer_payment(p_id uuid, p_customer_id uuid, p_amount numeric, p_method payment_method, p_reference text) → jsonb
Any member. Collects money against a customer's dues, applied to the oldest unpaid bills first.
Refused if the amount exceeds the balance. Idempotent on `p_id`. Returns `{ balance, duplicate }`.

## add_member(p_business_id uuid, p_email text, p_role member_role, p_display_name text) → uuid
Owner only. Gives an existing account (they must have signed up) access as `manager` or `cashier`.

## set_member(p_business_id uuid, p_user_id uuid, p_role member_role, p_is_active boolean) → void
Owner only. Changes a staff member's role or removes/restores access. The owner cannot be changed.

## report_summary(p_business_id uuid, p_from date, p_to date) → jsonb
Owner or manager. Figures for an inclusive range of India-time calendar days (max two years).

| Field | Meaning |
| --- | --- |
| `sales` | `count`, `billed_total` (incl. tax), `taxable_total`, `tax_total`, `discount_total`, `cost_total`, `credit_given` — completed bills only |
| `returns` | `count`, `total`, `taxable_total`, `tax_total`, `cost_total` (cost of restocked goods) — returns recorded in the range |
| `revenue` | `sales.taxable_total − returns.taxable_total` (excludes tax) |
| `gross_profit` | `revenue − (sales.cost_total − returns.cost_total)`; before expenses |
| `cancelled_count` | bills cancelled |
| `by_day` | `[{ day, total, count }]` |
| `by_method` | `[{ method, received, refunded }]` — includes dues collected in the range |
| `top_products` | top 10 by amount: `[{ product_id, name, qty, total }]` |
| `gst_by_rate` | `[{ tax_rate, taxable, cgst, sgst, igst }]` on bills, before returns |
| `gst_by_hsn` | `[{ hsn_code, tax_rate, qty, taxable, tax }]` |
| `outstanding_dues`, `stock_value`, `low_stock_count` | current values, not limited to the range |

Net profit is not returned: expenses are not recorded in this version.

## Internal functions (not callable by clients)
`app_role`, `fy_of`, `next_doc_no`, `sale_result`, and the trigger functions. `app_role` is callable
because the security policies use it; it only reveals the caller's own role.
