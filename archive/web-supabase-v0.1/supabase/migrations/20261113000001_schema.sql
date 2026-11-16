-- YG POS — core schema
-- Money: numeric(12,2) rupees. Quantities: numeric(14,3). Never floats.
-- Every business-owned row carries business_id; RLS isolates businesses.

create type public.member_role as enum ('owner', 'manager', 'cashier');
create type public.sale_status as enum ('completed', 'cancelled');
create type public.payment_method as enum ('cash', 'upi', 'card', 'other');
create type public.payment_kind as enum ('sale', 'due_collection', 'refund');
create type public.stock_reason as enum (
  'opening', 'stock_in', 'sale', 'sale_cancel', 'sale_return', 'adjustment', 'damage', 'expiry'
);

-- ---------------------------------------------------------------- businesses
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  legal_name text check (legal_name is null or length(legal_name) <= 160),
  phone text check (phone is null or length(phone) <= 20),
  email text check (email is null or length(email) <= 160),
  address text check (address is null or length(address) <= 400),
  city text check (city is null or length(city) <= 80),
  pincode text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  -- GST state code (first two digits of a GSTIN), e.g. '27' = Maharashtra
  state_code text check (state_code is null or state_code ~ '^[0-9]{2}$'),
  gst_registered boolean not null default false,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  default_tax_rate numeric(5,2) not null default 0 check (default_tax_rate between 0 and 100),
  prices_include_tax boolean not null default true,
  round_off_total boolean not null default true,
  invoice_prefix text not null default 'INV'
    check (invoice_prefix ~ '^[A-Z0-9]{1,4}$' and invoice_prefix <> 'CN'),
  receipt_footer text check (receipt_footer is null or length(receipt_footer) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gst_details_required check (
    not gst_registered
    or (gstin is not null and state_code is not null and left(gstin, 2) = state_code)
  )
);

create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  email text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

-- Gapless per-financial-year document numbering (invoice / credit_note).
create table public.invoice_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  series text not null check (series in ('invoice', 'credit_note')),
  fy text not null check (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  last_no integer not null check (last_no >= 0),
  primary key (business_id, series, fy)
);

-- ------------------------------------------------------------------ catalog
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (id, business_id)
);
create unique index categories_name_uq on public.categories (business_id, lower(btrim(name)));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category_id uuid,
  name text not null check (length(btrim(name)) between 1 and 200),
  sku text check (sku is null or length(btrim(sku)) between 1 and 60),
  barcode text check (barcode is null or length(btrim(barcode)) between 1 and 60),
  hsn_code text check (hsn_code is null or hsn_code ~ '^[0-9]{4,8}$'),
  unit text not null default 'pcs' check (length(btrim(unit)) between 1 and 12),
  sale_price numeric(12,2) not null check (sale_price >= 0),
  purchase_price numeric(12,2) not null default 0 check (purchase_price >= 0),
  tax_rate numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  price_includes_tax boolean not null default true,
  track_stock boolean not null default true,
  -- Maintained only by the stock_movements trigger; not writable by clients.
  stock_qty numeric(14,3) not null default 0,
  low_stock_threshold numeric(14,3) not null default 0 check (low_stock_threshold >= 0),
  description text check (description is null or length(description) <= 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (category_id, business_id) references public.categories (id, business_id)
    on delete set null (category_id)
);
create unique index products_sku_uq on public.products (business_id, lower(sku)) where sku is not null;
create unique index products_barcode_uq on public.products (business_id, barcode) where barcode is not null;
create index products_business_name_idx on public.products (business_id, lower(name));

-- ---------------------------------------------------------------- customers
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  phone text check (phone is null or phone ~ '^[0-9+ -]{6,20}$'),
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code text check (state_code is null or state_code ~ '^[0-9]{2}$'),
  address text check (address is null or length(address) <= 400),
  -- Amount the customer owes the shop. Maintained only by server functions.
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);
create unique index customers_phone_uq on public.customers (business_id, phone) where phone is not null;
create index customers_business_name_idx on public.customers (business_id, lower(name));

-- -------------------------------------------------------------------- sales
create table public.sales (
  -- Generated on the billing device; doubles as the idempotency key for sync.
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete restrict,
  invoice_no text,
  fy text,
  status public.sale_status not null default 'completed',
  customer_id uuid,
  customer_name text,
  customer_phone text,
  customer_gstin text,
  place_of_supply text check (place_of_supply is null or place_of_supply ~ '^[0-9]{2}$'),
  is_interstate boolean not null default false,
  gross_total numeric(12,2) not null default 0,     -- sum(qty * unit_price) before discounts
  discount_total numeric(12,2) not null default 0,
  taxable_total numeric(12,2) not null default 0,   -- value excluding tax
  cgst_total numeric(12,2) not null default 0,
  sgst_total numeric(12,2) not null default 0,
  igst_total numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  round_off numeric(12,2) not null default 0,
  grand_total numeric(12,2) not null default 0,
  paid_total numeric(12,2) not null default 0,
  due_amount numeric(12,2) not null default 0 check (due_amount >= 0),
  cost_total numeric(12,2) not null default 0,      -- cost of goods at sale time
  returned_total numeric(12,2) not null default 0,
  note text check (note is null or length(note) <= 300),
  sold_at timestamptz not null,
  created_at timestamptz not null default now(),    -- when the server recorded it
  created_by uuid not null references auth.users (id),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancel_reason text,
  unique (business_id, invoice_no),
  unique (id, business_id),
  foreign key (customer_id, business_id) references public.customers (id, business_id)
);
create index sales_business_sold_idx on public.sales (business_id, sold_at desc);
create index sales_customer_idx on public.sales (customer_id) where customer_id is not null;

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete restrict,
  line_no integer not null,
  product_id uuid not null references public.products (id) on delete restrict,
  name text not null,
  hsn_code text,
  unit text not null,
  qty numeric(14,3) not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  price_includes_tax boolean not null,
  gross_amount numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  tax_rate numeric(5,2) not null check (tax_rate between 0 and 100),
  taxable_value numeric(12,2) not null,
  cgst numeric(12,2) not null default 0,
  sgst numeric(12,2) not null default 0,
  igst numeric(12,2) not null default 0,
  line_total numeric(12,2) not null,
  unit_cost numeric(12,2) not null default 0,
  tracked_stock boolean not null default false,
  returned_qty numeric(14,3) not null default 0 check (returned_qty >= 0),
  unique (sale_id, line_no),
  check (returned_qty <= qty)
);
create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_product_idx on public.sale_items (business_id, product_id);

create table public.sale_returns (
  id uuid primary key,                               -- client generated, idempotency key
  business_id uuid not null references public.businesses (id) on delete restrict,
  sale_id uuid not null references public.sales (id) on delete restrict,
  credit_note_no text not null,
  reason text check (reason is null or length(reason) <= 300),
  restocked boolean not null,
  taxable_total numeric(12,2) not null,
  tax_total numeric(12,2) not null,
  total numeric(12,2) not null,                      -- value of goods returned
  due_reduced numeric(12,2) not null default 0,      -- part set off against unpaid dues
  refund_paid numeric(12,2) not null default 0,      -- part paid back to the customer
  cost_total numeric(12,2) not null default 0,       -- cost of goods put back in stock
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users (id),
  unique (business_id, credit_note_no)
);
create index sale_returns_sale_idx on public.sale_returns (sale_id);
create index sale_returns_business_idx on public.sale_returns (business_id, created_at desc);

create table public.sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sale_returns (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete restrict,
  sale_item_id uuid not null references public.sale_items (id) on delete restrict,
  qty numeric(14,3) not null check (qty > 0),
  taxable_value numeric(12,2) not null,
  tax_amount numeric(12,2) not null,
  amount numeric(12,2) not null
);
create index sale_return_items_return_idx on public.sale_return_items (return_id);
create index sale_return_items_item_idx on public.sale_return_items (sale_item_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  sale_id uuid references public.sales (id) on delete restrict,
  customer_id uuid references public.customers (id) on delete restrict,
  kind public.payment_kind not null,
  method public.payment_method not null,
  amount numeric(12,2) not null check (amount > 0),  -- refunds are positive rows of kind 'refund'
  reference text check (reference is null or length(reference) <= 80),
  -- groups the rows written by one record_customer_payment call (idempotency)
  batch_id uuid,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users (id)
);
create index payments_business_paid_idx on public.payments (business_id, paid_at desc);
create index payments_sale_idx on public.payments (sale_id);
create index payments_batch_idx on public.payments (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------- inventory
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  qty_change numeric(14,3) not null check (qty_change <> 0),
  reason public.stock_reason not null,
  ref_type text,          -- 'sale' | 'sale_return' | null for manual entries
  ref_id uuid,
  unit_cost numeric(12,2),
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_business_idx on public.stock_movements (business_id, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid,
  action text not null,
  entity text,
  entity_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_business_idx on public.audit_log (business_id, created_at desc);

-- ----------------------------------------------------------------- triggers
create function public.tg_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger businesses_updated before update on public.businesses
  for each row execute function public.tg_set_updated_at();
create trigger products_updated before update on public.products
  for each row execute function public.tg_set_updated_at();
create trigger customers_updated before update on public.customers
  for each row execute function public.tg_set_updated_at();

-- products.stock_qty is always the sum of that product's movements.
create function public.tg_apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.products
     set stock_qty = stock_qty + new.qty_change
   where id = new.product_id and business_id = new.business_id;
  if not found then
    raise exception 'Product does not belong to this business' using errcode = '23503';
  end if;
  return new;
end $$;

create trigger stock_movements_apply after insert on public.stock_movements
  for each row execute function public.tg_apply_stock_movement();
