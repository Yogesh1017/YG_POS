// Database schema, as forward-only migrations. NEVER edit a migration that has shipped:
// add a new entry at the end. The position in this list is the schema version (PRAGMA user_version).
//
// Conventions
//   money      INTEGER paise (1/100 rupee)
//   cost4      INTEGER 1/10000 rupee, cost of ONE base unit (so a carton cost divides without loss)
//   *_m        INTEGER thousandths ("milli") of a quantity. A countable product (qty_decimals = 0)
//              may only hold multiples of 1000 in base-unit columns — enforced by triggers below.
//   dates      TEXT 'YYYY-MM-DD' in the computer's local time; timestamps TEXT ISO-8601 UTC
export const MIGRATIONS: string[] = [
  /* 1 */ `
create table settings (
  id integer primary key check (id = 1),
  business_name text not null default '',
  legal_name text, phone text, email text, address text, city text, pincode text,
  state_code text check (state_code is null or (length(state_code) = 2 and state_code glob '[0-9][0-9]')),
  gst_registered integer not null default 0 check (gst_registered in (0, 1)),
  gstin text,
  default_tax_rate_bp integer not null default 0 check (default_tax_rate_bp between 0 and 10000),
  prices_include_tax integer not null default 0 check (prices_include_tax in (0, 1)),
  round_off_total integer not null default 1 check (round_off_total in (0, 1)),
  invoice_prefix text not null default 'INV',
  invoice_terms text, bank_details text, receipt_footer text,
  setup_complete integer not null default 0 check (setup_complete in (0, 1)),
  recovery_hash text,
  check (gst_registered = 0 or (gstin is not null and state_code is not null and substr(gstin, 1, 2) = state_code))
) strict;
insert into settings (id) values (1);

-- Per-computer preferences (printer names, second backup folder, last backup time).
create table config (key text primary key, value text not null) strict;

create table users (
  id integer primary key,
  username text not null unique collate nocase,
  display_name text not null,
  role text not null check (role in ('owner', 'manager', 'cashier')),
  password_hash text not null,
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null
) strict;

-- Document numbers: sequential per series and financial year, unique, never reused.
create table doc_counters (
  series text not null check (series in ('invoice', 'credit_note')),
  fy text not null,
  last_no integer not null check (last_no >= 0),
  primary key (series, fy)
) strict;

create table brands (id integer primary key, name text not null unique collate nocase) strict;
create table categories (id integer primary key, name text not null unique collate nocase) strict;

create table products (
  id integer primary key,
  name text not null check (length(trim(name)) > 0),
  brand_id integer references brands (id) on delete set null,
  category_id integer references categories (id) on delete set null,
  flavour text, pack_size text,
  sku text unique collate nocase,
  barcode text unique,
  hsn_code text,
  tax_rate_bp integer not null default 0 check (tax_rate_bp between 0 and 10000),
  price_includes_tax integer not null default 0 check (price_includes_tax in (0, 1)),
  base_unit text not null check (length(trim(base_unit)) > 0),      -- smallest unit stock is counted in
  qty_decimals integer not null default 0 check (qty_decimals in (0, 3)), -- 0 countable, 3 weight/volume
  track_expiry integer not null default 0 check (track_expiry in (0, 1)),
  low_stock_m integer not null default 0 check (low_stock_m >= 0),
  cost4 integer not null default 0 check (cost4 >= 0),              -- latest cost per base unit
  -- Quantity sold with owner/manager approval when no stock was on record. Absorbed by the next stock-in.
  shortfall_m integer not null default 0 check (shortfall_m >= 0),
  description text,
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null, updated_at text not null
) strict;
create index products_name_idx on products (name collate nocase);

-- Packaging. Units are conversions only: they hold no stock of their own.
create table product_units (
  id integer primary key,
  product_id integer not null references products (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  factor_m integer not null check (factor_m > 0),                    -- base units inside one of this unit, x1000
  sale_price integer not null default 0 check (sale_price >= 0),     -- paise for ONE of this unit
  is_base integer not null default 0 check (is_base in (0, 1)),
  is_default_sale integer not null default 0 check (is_default_sale in (0, 1)),
  is_default_purchase integer not null default 0 check (is_default_purchase in (0, 1)),
  is_active integer not null default 1 check (is_active in (0, 1)),
  check (is_base = 0 or factor_m = 1000),
  unique (product_id, name collate nocase)
) strict;
create unique index product_units_base_uq on product_units (product_id) where is_base = 1;

create table price_tiers (            -- "buy at least min_qty of this unit, pay this price each"
  id integer primary key,
  unit_id integer not null references product_units (id) on delete cascade,
  min_qty_m integer not null check (min_qty_m > 0),
  price integer not null check (price >= 0),
  unique (unit_id, min_qty_m)
) strict;

create table customers (
  id integer primary key,
  name text not null check (length(trim(name)) > 0),                 -- shop / business name
  contact_person text, phone text, gstin text,
  state_code text check (state_code is null or (length(state_code) = 2 and state_code glob '[0-9][0-9]')),
  address text, city text, notes text,
  credit_limit integer check (credit_limit is null or credit_limit >= 0),
  opening_balance integer not null default 0 check (opening_balance >= 0),
  opening_due integer not null default 0 check (opening_due >= 0),   -- unpaid part of the opening balance
  balance integer not null default 0 check (balance >= 0),           -- opening_due + unpaid invoice amounts
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null
) strict;
create index customers_name_idx on customers (name collate nocase);

create table customer_prices (
  customer_id integer not null references customers (id) on delete cascade,
  unit_id integer not null references product_units (id) on delete cascade,
  price integer not null check (price >= 0),
  primary key (customer_id, unit_id)
) strict;

create table suppliers (
  id integer primary key,
  name text not null check (length(trim(name)) > 0),
  contact_person text, phone text, gstin text,
  state_code text check (state_code is null or (length(state_code) = 2 and state_code glob '[0-9][0-9]')),
  address text, notes text,
  opening_balance integer not null default 0 check (opening_balance >= 0),
  opening_due integer not null default 0 check (opening_due >= 0),
  balance integer not null default 0 check (balance >= 0),           -- what we owe the supplier
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null
) strict;

-- ------------------------------------------------------------------ purchases
create table purchases (
  id integer primary key,
  client_ref text not null unique,                                   -- stops a double submit creating two
  supplier_id integer not null references suppliers (id),
  bill_no text, bill_date text not null,
  status text not null default 'completed' check (status in ('completed', 'cancelled')),
  rates_include_tax integer not null default 0 check (rates_include_tax in (0, 1)),
  taxable_total integer not null, tax_total integer not null, round_off integer not null default 0,
  grand_total integer not null, paid_total integer not null default 0,
  due_amount integer not null default 0 check (due_amount >= 0),
  note text, created_by integer not null references users (id), created_at text not null,
  cancelled_at text, cancelled_by integer references users (id), cancel_reason text
) strict;
create index purchases_supplier_idx on purchases (supplier_id, bill_date);
create index purchases_date_idx on purchases (bill_date);

-- ---------------------------------------------------------------------- stock
-- All stock lives in batches. A product's stock = sum(batch qty_m) - products.shortfall_m.
create table stock_batches (
  id integer primary key,
  product_id integer not null references products (id),
  batch_no text, mfg_date text, expiry_date text,
  received_m integer not null check (received_m > 0),
  qty_m integer not null check (qty_m >= 0),                         -- remaining; can never go below zero
  cost4 integer not null default 0 check (cost4 >= 0),
  source text not null check (source in ('opening', 'purchase', 'adjustment')),
  purchase_id integer references purchases (id),
  created_at text not null
) strict;
create index stock_batches_product_idx on stock_batches (product_id, expiry_date);

create table purchase_items (
  id integer primary key,
  purchase_id integer not null references purchases (id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products (id),
  unit_id integer not null references product_units (id),
  name text not null, unit_name text not null, factor_m integer not null,
  qty_m integer not null check (qty_m > 0), base_qty_m integer not null check (base_qty_m > 0),
  rate integer not null check (rate >= 0), discount integer not null default 0 check (discount >= 0),
  tax_rate_bp integer not null, taxable integer not null, tax integer not null, line_total integer not null,
  batch_id integer references stock_batches (id),
  unique (purchase_id, line_no)
) strict;

create table stock_movements (                                        -- append-only stock ledger
  id integer primary key,
  product_id integer not null references products (id),
  batch_id integer references stock_batches (id),                     -- null: sold without stock (shortfall)
  qty_m integer not null check (qty_m <> 0),
  reason text not null check (reason in ('opening', 'purchase', 'purchase_cancel', 'sale', 'sale_cancel',
    'sale_return', 'adjustment', 'damaged', 'melted', 'expired')),
  ref_type text, ref_id integer,
  cost4 integer not null default 0,
  note text, moved_on text not null,
  created_by integer references users (id), created_at text not null
) strict;
create index stock_movements_product_idx on stock_movements (product_id, id);
create index stock_movements_date_idx on stock_movements (moved_on, reason);

-- Countable products can never hold a fraction of a base unit.
create trigger stock_batches_whole_ins before insert on stock_batches
when (select qty_decimals from products where id = new.product_id) = 0 and (new.qty_m % 1000 <> 0 or new.received_m % 1000 <> 0)
begin select raise(abort, 'Countable products cannot hold a fraction of a unit'); end;
create trigger stock_batches_whole_upd before update of qty_m on stock_batches
when (select qty_decimals from products where id = new.product_id) = 0 and new.qty_m % 1000 <> 0
begin select raise(abort, 'Countable products cannot hold a fraction of a unit'); end;
create trigger stock_movements_whole_ins before insert on stock_movements
when (select qty_decimals from products where id = new.product_id) = 0 and new.qty_m % 1000 <> 0
begin select raise(abort, 'Countable products cannot hold a fraction of a unit'); end;
create trigger stock_movements_no_update before update on stock_movements
begin select raise(abort, 'Stock movements cannot be edited'); end;
create trigger stock_movements_no_delete before delete on stock_movements
begin select raise(abort, 'Stock movements cannot be deleted'); end;

-- ---------------------------------------------------------------------- sales
create table sales (
  id integer primary key,
  client_ref text not null unique,
  invoice_no text not null unique,
  fy text not null, seq integer not null,
  status text not null default 'completed' check (status in ('completed', 'cancelled')),
  customer_id integer references customers (id),                      -- null: cash sale to an unnamed buyer
  customer_name text, customer_phone text, customer_gstin text, customer_address text,
  place_of_supply text, is_interstate integer not null default 0 check (is_interstate in (0, 1)),
  gross_total integer not null, discount_total integer not null, taxable_total integer not null,
  cgst_total integer not null, sgst_total integer not null, igst_total integer not null, tax_total integer not null,
  round_off integer not null, grand_total integer not null,
  paid_total integer not null default 0, due_amount integer not null default 0 check (due_amount >= 0),
  cost_total integer not null default 0, returned_total integer not null default 0,
  note text, sold_on text not null, sold_at text not null,
  created_by integer not null references users (id),
  cancelled_at text, cancelled_by integer references users (id), cancel_reason text,
  unique (fy, seq)
) strict;
create index sales_date_idx on sales (sold_on);
create index sales_customer_idx on sales (customer_id, sold_on);

create table sale_items (
  id integer primary key,
  sale_id integer not null references sales (id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products (id),
  unit_id integer not null references product_units (id),
  name text not null, unit_name text not null, factor_m integer not null,   -- snapshot of the packaging used
  hsn_code text,
  qty_m integer not null check (qty_m > 0),               -- in the unit sold
  base_qty_m integer not null check (base_qty_m > 0),     -- the same quantity in base units
  unit_price integer not null check (unit_price >= 0),    -- per unit sold
  list_price integer not null,                            -- what the price rules gave
  price_source text not null check (price_source in ('list', 'tier', 'customer', 'manual')),
  price_includes_tax integer not null check (price_includes_tax in (0, 1)),
  gross integer not null, discount integer not null default 0 check (discount >= 0),
  tax_rate_bp integer not null, taxable integer not null,
  cgst integer not null, sgst integer not null, igst integer not null, line_total integer not null,
  cost_total integer not null default 0,                  -- actual cost of the batches this line took
  returned_base_m integer not null default 0 check (returned_base_m >= 0 and returned_base_m <= base_qty_m),
  unique (sale_id, line_no)
) strict;
create index sale_items_product_idx on sale_items (product_id);

create table sale_item_batches (                           -- which batches a line was taken from
  id integer primary key,
  sale_item_id integer not null references sale_items (id) on delete cascade,
  batch_id integer references stock_batches (id),          -- null: shortfall (no stock on record)
  qty_m integer not null check (qty_m > 0),
  returned_m integer not null default 0 check (returned_m >= 0 and returned_m <= qty_m),
  cost4 integer not null
) strict;
create index sale_item_batches_item_idx on sale_item_batches (sale_item_id);

create table sale_returns (
  id integer primary key,
  client_ref text not null unique,
  sale_id integer not null references sales (id),
  credit_note_no text not null unique,
  reason text,
  taxable_total integer not null, tax_total integer not null, total integer not null,
  due_reduced integer not null default 0, refund_paid integer not null default 0, refund_method text,
  cost_total integer not null default 0,                    -- cost of goods put back into stock
  returned_on text not null, created_at text not null, created_by integer not null references users (id)
) strict;
create index sale_returns_sale_idx on sale_returns (sale_id);

create table sale_return_items (
  id integer primary key,
  return_id integer not null references sale_returns (id) on delete cascade,
  sale_item_id integer not null references sale_items (id),
  base_qty_m integer not null check (base_qty_m > 0),
  disposition text not null check (disposition in ('restock', 'damaged', 'melted', 'expired')),
  taxable integer not null, tax integer not null, amount integer not null
) strict;

-- Money received from / refunded to customers. Records only: no payment is processed by this app.
create table payments (
  id integer primary key,
  group_ref text not null,                                  -- one collection may settle several invoices
  customer_id integer references customers (id),
  sale_id integer references sales (id),                    -- null: against the opening balance
  kind text not null check (kind in ('sale', 'collection', 'refund')),
  method text not null check (method in ('cash', 'upi', 'card', 'bank', 'cheque', 'other')),
  amount integer not null check (amount > 0),
  reference text, note text,
  paid_on text not null, created_at text not null, created_by integer not null references users (id)
) strict;
create index payments_customer_idx on payments (customer_id, paid_on);
create index payments_sale_idx on payments (sale_id);
create index payments_group_idx on payments (group_ref);
create index payments_date_idx on payments (paid_on);

create table supplier_payments (
  id integer primary key,
  group_ref text not null,
  supplier_id integer not null references suppliers (id),
  purchase_id integer references purchases (id),            -- null: against the opening balance
  kind text not null check (kind in ('purchase', 'payment', 'refund')),
  method text not null check (method in ('cash', 'upi', 'card', 'bank', 'cheque', 'other')),
  amount integer not null check (amount > 0),
  reference text, note text,
  paid_on text not null, created_at text not null, created_by integer not null references users (id)
) strict;
create index supplier_payments_supplier_idx on supplier_payments (supplier_id, paid_on);
create index supplier_payments_group_idx on supplier_payments (group_ref);

create table expense_categories (id integer primary key, name text not null unique collate nocase) strict;
create table expenses (
  id integer primary key,
  category_id integer references expense_categories (id) on delete set null,
  amount integer not null check (amount > 0),
  method text not null check (method in ('cash', 'upi', 'card', 'bank', 'cheque', 'other')),
  spent_on text not null, note text,
  created_by integer not null references users (id), created_at text not null
) strict;
create index expenses_date_idx on expenses (spent_on);

create table audit_log (
  id integer primary key,
  user_id integer, action text not null, entity text, entity_id integer, details text,
  created_at text not null
) strict;
create index audit_log_date_idx on audit_log (created_at);
create trigger audit_log_no_update before update on audit_log begin select raise(abort, 'The audit log cannot be edited'); end;
create trigger audit_log_no_delete before delete on audit_log begin select raise(abort, 'The audit log cannot be deleted'); end;
`,
];
