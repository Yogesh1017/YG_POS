-- YG POS — access control: role helper, table grants, Row Level Security.
-- Model: members read their own business's rows. Owners/managers maintain the
-- catalog directly. Everything financial (sales, payments, stock, balances) is
-- read-only to clients and written only by the SECURITY DEFINER functions in
-- the next migration.

-- Role of the calling user in a business (null when not an active member).
create function public.app_role(p_business_id uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.business_members
   where business_id = p_business_id and user_id = auth.uid() and is_active
$$;

-- Start from zero: Supabase grants broad table privileges by default.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;
grant execute on function public.app_role(uuid) to authenticated;

grant select on public.businesses, public.business_members, public.categories, public.products,
  public.customers, public.sales, public.sale_items, public.sale_returns, public.sale_return_items,
  public.payments, public.stock_movements, public.audit_log to authenticated;

grant update (name, legal_name, phone, email, address, city, pincode, state_code, gst_registered,
  gstin, default_tax_rate, prices_include_tax, round_off_total, invoice_prefix, receipt_footer)
  on public.businesses to authenticated;

grant insert (id, business_id, name), update (name), delete on public.categories to authenticated;

-- stock_qty is deliberately absent: stock only changes through stock movements.
grant insert (id, business_id, category_id, name, sku, barcode, hsn_code, unit, sale_price,
    purchase_price, tax_rate, price_includes_tax, track_stock, low_stock_threshold, description, is_active),
  update (category_id, name, sku, barcode, hsn_code, unit, sale_price, purchase_price, tax_rate,
    price_includes_tax, track_stock, low_stock_threshold, description, is_active),
  delete on public.products to authenticated;

-- balance is deliberately absent: dues only change through sales/payments.
grant insert (id, business_id, name, phone, gstin, state_code, address),
  update (name, phone, gstin, state_code, address),
  delete on public.customers to authenticated;

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
alter table public.payments enable row level security;
alter table public.stock_movements enable row level security;
alter table public.audit_log enable row level security;

create policy businesses_select on public.businesses for select to authenticated
  using (public.app_role(id) is not null);
create policy businesses_update on public.businesses for update to authenticated
  using (public.app_role(id) = 'owner') with check (public.app_role(id) = 'owner');

create policy members_select on public.business_members for select to authenticated
  using (public.app_role(business_id) is not null);

create policy categories_select on public.categories for select to authenticated
  using (public.app_role(business_id) is not null);
create policy categories_insert on public.categories for insert to authenticated
  with check (public.app_role(business_id) in ('owner', 'manager'));
create policy categories_update on public.categories for update to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'))
  with check (public.app_role(business_id) in ('owner', 'manager'));
create policy categories_delete on public.categories for delete to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'));

create policy products_select on public.products for select to authenticated
  using (public.app_role(business_id) is not null);
create policy products_insert on public.products for insert to authenticated
  with check (public.app_role(business_id) in ('owner', 'manager'));
create policy products_update on public.products for update to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'))
  with check (public.app_role(business_id) in ('owner', 'manager'));
create policy products_delete on public.products for delete to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'));

-- Cashiers may add and edit customers (needed at the counter for credit sales).
create policy customers_select on public.customers for select to authenticated
  using (public.app_role(business_id) is not null);
create policy customers_insert on public.customers for insert to authenticated
  with check (public.app_role(business_id) is not null);
create policy customers_update on public.customers for update to authenticated
  using (public.app_role(business_id) is not null)
  with check (public.app_role(business_id) is not null);
create policy customers_delete on public.customers for delete to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'));

create policy sales_select on public.sales for select to authenticated
  using (public.app_role(business_id) is not null);
create policy sale_items_select on public.sale_items for select to authenticated
  using (public.app_role(business_id) is not null);
create policy sale_returns_select on public.sale_returns for select to authenticated
  using (public.app_role(business_id) is not null);
create policy sale_return_items_select on public.sale_return_items for select to authenticated
  using (public.app_role(business_id) is not null);
create policy payments_select on public.payments for select to authenticated
  using (public.app_role(business_id) is not null);
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.app_role(business_id) is not null);
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.app_role(business_id) in ('owner', 'manager'));
-- invoice_counters: no policies and no grants — reachable only from server functions.
