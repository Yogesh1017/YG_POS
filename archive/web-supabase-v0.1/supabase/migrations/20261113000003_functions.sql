-- YG POS — server functions (called from the app through supabase.rpc).
-- Each function is one transaction: it either fully happens or not at all.
-- All arithmetic is recomputed here; totals sent by the client are never stored.

-- Indian financial year (April–March) of a moment, in IST. e.g. '26-27'.
create function public.fy_of(p_at timestamptz) returns text
language sql immutable as $$
  select case when extract(month from d) >= 4
    then to_char(d, 'YY') || '-' || to_char(d + interval '1 year', 'YY')
    else to_char(d - interval '1 year', 'YY') || '-' || to_char(d, 'YY') end
  from (select (p_at at time zone 'Asia/Kolkata') as d) x
$$;

create function public.next_doc_no(p_business_id uuid, p_series text, p_fy text) returns integer
language sql security definer set search_path = public as $$
  insert into public.invoice_counters as c (business_id, series, fy, last_no)
  values (p_business_id, p_series, p_fy, 1)
  on conflict (business_id, series, fy) do update set last_no = c.last_no + 1
  returning last_no
$$;

create function public.sale_result(p_sale_id uuid, p_duplicate boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', id, 'invoice_no', invoice_no, 'status', status,
    'gross_total', gross_total, 'discount_total', discount_total, 'taxable_total', taxable_total,
    'cgst_total', cgst_total, 'sgst_total', sgst_total, 'igst_total', igst_total,
    'tax_total', tax_total, 'round_off', round_off, 'grand_total', grand_total,
    'paid_total', paid_total, 'due_amount', due_amount, 'duplicate', p_duplicate)
  from public.sales where id = p_sale_id
$$;

-- ------------------------------------------------------------ create_business
create function public.create_business(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if (select count(*) from business_members where user_id = v_uid and role = 'owner') >= 3 then
    raise exception 'You already own the maximum number of businesses' using errcode = '22023';
  end if;
  select email into v_email from auth.users where id = v_uid;

  insert into businesses (name, legal_name, phone, email, address, city, pincode, state_code,
                          gst_registered, gstin, default_tax_rate, prices_include_tax)
  values (
    btrim(p->>'name'), nullif(btrim(p->>'legal_name'), ''), nullif(btrim(p->>'phone'), ''),
    nullif(btrim(p->>'email'), ''), nullif(btrim(p->>'address'), ''), nullif(btrim(p->>'city'), ''),
    nullif(btrim(p->>'pincode'), ''), nullif(btrim(p->>'state_code'), ''),
    coalesce((p->>'gst_registered')::boolean, false), nullif(upper(btrim(p->>'gstin')), ''),
    coalesce((p->>'default_tax_rate')::numeric, 0), coalesce((p->>'prices_include_tax')::boolean, true))
  returning id into v_id;

  insert into business_members (business_id, user_id, role, display_name, email)
  values (v_id, v_uid, 'owner',
          coalesce(nullif(btrim(p->>'owner_name'), ''), split_part(v_email, '@', 1), 'Owner'),
          coalesce(v_email, ''));

  insert into audit_log (business_id, user_id, action, entity, entity_id)
  values (v_id, v_uid, 'business.create', 'business', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- create_sale
-- p: { id, business_id, sold_at?, customer_id?, customer_name?, customer_phone?, customer_gstin?,
--      place_of_supply?, note?, client_total?,
--      items: [{ product_id, qty, unit_price, discount?, tax_rate?, price_includes_tax? }],
--      payments: [{ method, amount, reference? }] }
-- Idempotent on id: replaying the same sale returns the stored result ("duplicate": true).
-- unit_price / tax_rate / price_includes_tax are the values shown on the receipt at sale time
-- (the till may have been offline with a slightly stale catalog). They are range-checked,
-- every amount derived from them is recomputed here, and deviations from the catalog are audited.
create function public.create_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := (p->>'id')::uuid;
  v_bid uuid := (p->>'business_id')::uuid;
  v_role member_role;
  b businesses%rowtype;
  c customers%rowtype;
  pr products%rowtype;
  v_customer_id uuid := nullif(p->>'customer_id', '')::uuid;
  v_sold_at timestamptz := coalesce((p->>'sold_at')::timestamptz, now());
  v_pos text;
  v_inter boolean;
  v_rows integer;
  it jsonb;
  pay jsonb;
  v_line integer := 0;
  v_qty numeric; v_price numeric; v_disc numeric; v_rate numeric; v_incl boolean;
  v_gross numeric; v_net numeric; v_taxable numeric; v_tax numeric;
  v_cgst numeric; v_sgst numeric; v_igst numeric;
  t_gross numeric := 0; t_disc numeric := 0; t_taxable numeric := 0;
  t_cgst numeric := 0; t_sgst numeric := 0; t_igst numeric := 0; t_cost numeric := 0;
  v_sum numeric; v_grand numeric; v_paid numeric := 0; v_amt numeric; v_due numeric;
  v_fy text; v_invoice text;
  v_overrides jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if v_id is null or v_bid is null then
    raise exception 'Sale id and business are required' using errcode = '22023';
  end if;
  v_role := app_role(v_bid);
  if v_role is null then
    raise exception 'You do not have access to this business' using errcode = '42501';
  end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'A sale needs at least one item' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'items') > 500 then
    raise exception 'Too many items on one bill' using errcode = '22023';
  end if;
  if v_sold_at > now() + interval '10 minutes' then
    v_sold_at := now();  -- device clock is ahead; do not record sales in the future
  end if;

  -- Claim the id first. A concurrent replay blocks here until we commit, then sees the row.
  insert into sales (id, business_id, sold_at, created_by)
  values (v_id, v_bid, v_sold_at, v_uid)
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    if not exists (select 1 from sales where id = v_id and business_id = v_bid) then
      raise exception 'Sale id is already in use' using errcode = '23505';
    end if;
    return sale_result(v_id, true);
  end if;

  select * into b from businesses where id = v_bid;

  if v_customer_id is not null then
    select * into c from customers where id = v_customer_id and business_id = v_bid for update;
    if not found then
      raise exception 'Customer not found' using errcode = '23503';
    end if;
  end if;

  v_pos := coalesce(nullif(p->>'place_of_supply', ''), c.state_code, b.state_code);
  v_inter := b.gst_registered and v_pos is not null and v_pos <> b.state_code;

  for it in select value from jsonb_array_elements(p->'items') loop
    v_line := v_line + 1;
    select * into pr from products where id = (it->>'product_id')::uuid and business_id = v_bid;
    if not found then
      raise exception 'Item %: product not found', v_line using errcode = '23503';
    end if;

    v_qty := (it->>'qty')::numeric;
    v_price := (it->>'unit_price')::numeric;
    v_disc := coalesce((it->>'discount')::numeric, 0);
    v_incl := coalesce((it->>'price_includes_tax')::boolean, pr.price_includes_tax);
    v_rate := case when b.gst_registered then coalesce((it->>'tax_rate')::numeric, pr.tax_rate) else 0 end;

    if v_qty is null or v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty, 3) then
      raise exception 'Item %: invalid quantity', v_line using errcode = '22023';
    end if;
    if v_price is null or v_price < 0 or v_price > 100000000 or v_price <> round(v_price, 2) then
      raise exception 'Item %: invalid price', v_line using errcode = '22023';
    end if;
    if v_rate < 0 or v_rate > 100 or v_rate <> round(v_rate, 2) then
      raise exception 'Item %: invalid tax rate', v_line using errcode = '22023';
    end if;
    v_gross := round(v_qty * v_price, 2);
    if v_disc < 0 or v_disc > v_gross or v_disc <> round(v_disc, 2) then
      raise exception 'Item %: invalid discount', v_line using errcode = '22023';
    end if;

    v_net := v_gross - v_disc;
    if v_incl then
      v_taxable := round(v_net * 100 / (100 + v_rate), 2);
      v_tax := v_net - v_taxable;
    else
      v_taxable := v_net;
      v_tax := round(v_net * v_rate / 100, 2);
    end if;
    if v_inter then
      v_igst := v_tax; v_cgst := 0; v_sgst := 0;
    else
      v_cgst := round(v_tax / 2, 2); v_sgst := v_tax - v_cgst; v_igst := 0;
    end if;

    insert into sale_items (sale_id, business_id, line_no, product_id, name, hsn_code, unit, qty,
      unit_price, price_includes_tax, gross_amount, discount_amount, tax_rate, taxable_value,
      cgst, sgst, igst, line_total, unit_cost, tracked_stock)
    values (v_id, v_bid, v_line, pr.id, pr.name, pr.hsn_code, pr.unit, v_qty,
      v_price, v_incl, v_gross, v_disc, v_rate, v_taxable,
      v_cgst, v_sgst, v_igst, v_taxable + v_tax, pr.purchase_price, pr.track_stock);

    if pr.track_stock then
      insert into stock_movements (business_id, product_id, qty_change, reason, ref_type, ref_id, unit_cost, created_by)
      values (v_bid, pr.id, -v_qty, 'sale', 'sale', v_id, pr.purchase_price, v_uid);
    end if;

    if v_price <> pr.sale_price or (b.gst_registered and v_rate <> pr.tax_rate) then
      v_overrides := v_overrides || jsonb_build_object('line', v_line, 'product_id', pr.id,
        'catalog_price', pr.sale_price, 'billed_price', v_price,
        'catalog_tax_rate', pr.tax_rate, 'billed_tax_rate', v_rate);
    end if;

    t_gross := t_gross + v_gross;
    t_disc := t_disc + v_disc;
    t_taxable := t_taxable + v_taxable;
    t_cgst := t_cgst + v_cgst; t_sgst := t_sgst + v_sgst; t_igst := t_igst + v_igst;
    t_cost := t_cost + round(v_qty * pr.purchase_price, 2);
  end loop;

  v_sum := t_taxable + t_cgst + t_sgst + t_igst;
  v_grand := case when b.round_off_total then round(v_sum) else v_sum end;

  if p ? 'payments' and jsonb_typeof(p->'payments') = 'array' then
    for pay in select value from jsonb_array_elements(p->'payments') loop
      v_amt := (pay->>'amount')::numeric;
      if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
        raise exception 'Invalid payment amount' using errcode = '22023';
      end if;
      v_paid := v_paid + v_amt;
      insert into payments (business_id, sale_id, customer_id, kind, method, amount, reference, paid_at, created_by)
      values (v_bid, v_id, v_customer_id, 'sale', (pay->>'method')::payment_method, v_amt,
              nullif(btrim(pay->>'reference'), ''), v_sold_at, v_uid);
    end loop;
  end if;
  if v_paid > v_grand then
    raise exception 'Payments (%) are more than the bill total (%)', v_paid, v_grand using errcode = '22023';
  end if;

  v_due := v_grand - v_paid;
  if v_due > 0 then
    if v_customer_id is null then
      raise exception 'A customer must be selected for a credit (due) sale' using errcode = '22023';
    end if;
    update customers set balance = balance + v_due where id = v_customer_id;
  end if;

  v_fy := fy_of(v_sold_at);
  v_invoice := b.invoice_prefix || '/' || v_fy || '/' || next_doc_no(v_bid, 'invoice', v_fy);

  update sales set
    invoice_no = v_invoice, fy = v_fy, customer_id = v_customer_id,
    customer_name = coalesce(c.name, nullif(btrim(p->>'customer_name'), '')),
    customer_phone = coalesce(c.phone, nullif(btrim(p->>'customer_phone'), '')),
    customer_gstin = coalesce(c.gstin, nullif(upper(btrim(p->>'customer_gstin')), '')),
    place_of_supply = v_pos, is_interstate = v_inter,
    gross_total = t_gross, discount_total = t_disc, taxable_total = t_taxable,
    cgst_total = t_cgst, sgst_total = t_sgst, igst_total = t_igst,
    tax_total = t_cgst + t_sgst + t_igst, round_off = v_grand - v_sum, grand_total = v_grand,
    paid_total = v_paid, due_amount = v_due, cost_total = t_cost,
    note = nullif(btrim(p->>'note'), '')
  where id = v_id;

  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_log (business_id, user_id, action, entity, entity_id, details)
    values (v_bid, v_uid, 'sale.price_or_tax_differs_from_catalog', 'sale', v_id, v_overrides);
  end if;
  if p ? 'client_total' and (p->>'client_total')::numeric <> v_grand then
    insert into audit_log (business_id, user_id, action, entity, entity_id, details)
    values (v_bid, v_uid, 'sale.total_mismatch', 'sale', v_id,
            jsonb_build_object('client_total', p->'client_total', 'server_total', v_grand));
  end if;

  return sale_result(v_id, false);
end $$;

-- ---------------------------------------------------------------- cancel_sale
-- Voids a whole bill: stock goes back, dues are removed, money received is recorded as refunded.
-- The invoice number is kept (cancelled invoices stay in the series).
create function public.cancel_sale(p_sale_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  s sales%rowtype;
  v_role member_role;
begin
  select * into s from sales where id = p_sale_id for update;
  if found then v_role := app_role(s.business_id); end if;
  if v_role is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'Only an owner or manager can cancel a sale' using errcode = '42501';
  end if;
  if s.status = 'cancelled' then
    return jsonb_build_object('id', s.id, 'status', 'cancelled', 'duplicate', true);
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to cancel a sale' using errcode = '22023';
  end if;
  if exists (select 1 from sale_returns where sale_id = s.id) then
    raise exception 'This sale already has returns and cannot be cancelled' using errcode = '22023';
  end if;

  insert into stock_movements (business_id, product_id, qty_change, reason, ref_type, ref_id, unit_cost, created_by)
  select business_id, product_id, qty, 'sale_cancel', 'sale', sale_id, unit_cost, v_uid
    from sale_items where sale_id = s.id and tracked_stock;

  if s.due_amount > 0 and s.customer_id is not null then
    update customers set balance = balance - s.due_amount where id = s.customer_id;
  end if;

  insert into payments (business_id, sale_id, customer_id, kind, method, amount, created_by)
  select s.business_id, s.id, s.customer_id, 'refund', method, sum(amount), v_uid
    from payments where sale_id = s.id and kind in ('sale', 'due_collection')
   group by method;

  update sales set status = 'cancelled', due_amount = 0, cancelled_at = now(),
         cancelled_by = v_uid, cancel_reason = btrim(p_reason)
   where id = s.id;

  insert into audit_log (business_id, user_id, action, entity, entity_id, details)
  values (s.business_id, v_uid, 'sale.cancel', 'sale', s.id,
          jsonb_build_object('invoice_no', s.invoice_no, 'reason', btrim(p_reason), 'grand_total', s.grand_total));
  return jsonb_build_object('id', s.id, 'status', 'cancelled', 'duplicate', false);
end $$;

-- -------------------------------------------------------------- create_return
-- p: { id, sale_id, items: [{ sale_item_id, qty }], restock, refund_method?, reason? }
-- Partial or full return against a bill, with a credit note number. The value returned first
-- reduces any unpaid due on the bill; the rest is paid back by refund_method.
create function public.create_return(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := (p->>'id')::uuid;
  v_restock boolean := coalesce((p->>'restock')::boolean, true);
  s sales%rowtype;
  si sale_items%rowtype;
  r sale_returns%rowtype;
  v_role member_role;
  it jsonb;
  v_qty numeric; v_remaining numeric; v_amount numeric; v_taxable numeric;
  v_prev_amount numeric; v_prev_taxable numeric;
  t_amount numeric := 0; t_taxable numeric := 0; t_cost numeric := 0;
  v_due_reduced numeric; v_refund numeric; v_prev_refunds numeric;
  v_fy text; v_cn text;
begin
  if v_id is null then
    raise exception 'Return id is required' using errcode = '22023';
  end if;
  select * into s from sales where id = (p->>'sale_id')::uuid for update;
  if found then v_role := app_role(s.business_id); end if;
  if v_role is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'Only an owner or manager can process a return' using errcode = '42501';
  end if;

  select * into r from sale_returns where id = v_id;
  if found then
    if r.sale_id <> s.id then
      raise exception 'Return id is already in use' using errcode = '23505';
    end if;
    return jsonb_build_object('id', r.id, 'credit_note_no', r.credit_note_no, 'total', r.total,
      'due_reduced', r.due_reduced, 'refund_paid', r.refund_paid, 'duplicate', true);
  end if;

  if s.status <> 'completed' then
    raise exception 'A cancelled sale cannot have returns' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Select at least one item to return' using errcode = '22023';
  end if;

  v_fy := fy_of(now());
  v_cn := 'CN/' || v_fy || '/' || next_doc_no(s.business_id, 'credit_note', v_fy);
  insert into sale_returns (id, business_id, sale_id, credit_note_no, reason, restocked,
                            taxable_total, tax_total, total, created_by)
  values (v_id, s.business_id, s.id, v_cn, nullif(btrim(p->>'reason'), ''), v_restock, 0, 0, 0, v_uid);

  for it in select value from jsonb_array_elements(p->'items') loop
    select * into si from sale_items
     where id = (it->>'sale_item_id')::uuid and sale_id = s.id for update;
    if not found then
      raise exception 'Returned item does not belong to this sale' using errcode = '23503';
    end if;
    v_qty := (it->>'qty')::numeric;
    v_remaining := si.qty - si.returned_qty;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_qty > v_remaining then
      raise exception 'Cannot return % of "%": only % left to return', v_qty, si.name, v_remaining
        using errcode = '22023';
    end if;

    select coalesce(sum(amount), 0), coalesce(sum(taxable_value), 0)
      into v_prev_amount, v_prev_taxable
      from sale_return_items where sale_item_id = si.id;
    if v_qty = v_remaining then            -- last of the line: use the remainder, no rounding drift
      v_amount := si.line_total - v_prev_amount;
      v_taxable := si.taxable_value - v_prev_taxable;
    else
      v_amount := round(si.line_total * v_qty / si.qty, 2);
      v_taxable := round(si.taxable_value * v_qty / si.qty, 2);
    end if;

    insert into sale_return_items (return_id, business_id, sale_item_id, qty, taxable_value, tax_amount, amount)
    values (v_id, s.business_id, si.id, v_qty, v_taxable, v_amount - v_taxable, v_amount);
    update sale_items set returned_qty = returned_qty + v_qty where id = si.id;

    if v_restock and si.tracked_stock then
      insert into stock_movements (business_id, product_id, qty_change, reason, ref_type, ref_id, unit_cost, created_by)
      values (s.business_id, si.product_id, v_qty, 'sale_return', 'sale_return', v_id, si.unit_cost, v_uid);
      t_cost := t_cost + round(si.unit_cost * v_qty, 2);
    end if;
    t_amount := t_amount + v_amount;
    t_taxable := t_taxable + v_taxable;
  end loop;

  select coalesce(sum(refund_paid), 0) into v_prev_refunds from sale_returns where sale_id = s.id;
  v_due_reduced := least(s.due_amount, t_amount);
  -- Never pay back more than was actually received for this bill.
  v_refund := greatest(least(t_amount - v_due_reduced, s.paid_total - v_prev_refunds), 0);

  if v_due_reduced > 0 then
    update customers set balance = balance - v_due_reduced where id = s.customer_id;
  end if;
  if v_refund > 0 then
    if nullif(p->>'refund_method', '') is null then
      raise exception 'Choose how the refund is paid' using errcode = '22023';
    end if;
    insert into payments (business_id, sale_id, customer_id, kind, method, amount, created_by)
    values (s.business_id, s.id, s.customer_id, 'refund', (p->>'refund_method')::payment_method, v_refund, v_uid);
  end if;

  update sale_returns set taxable_total = t_taxable, tax_total = t_amount - t_taxable, total = t_amount,
         due_reduced = v_due_reduced, refund_paid = v_refund, cost_total = t_cost
   where id = v_id;
  update sales set due_amount = due_amount - v_due_reduced, returned_total = returned_total + t_amount
   where id = s.id;

  insert into audit_log (business_id, user_id, action, entity, entity_id, details)
  values (s.business_id, v_uid, 'sale.return', 'sale', s.id,
          jsonb_build_object('credit_note_no', v_cn, 'total', t_amount, 'refund_paid', v_refund));
  return jsonb_build_object('id', v_id, 'credit_note_no', v_cn, 'total', t_amount,
    'due_reduced', v_due_reduced, 'refund_paid', v_refund, 'duplicate', false);
end $$;

-- --------------------------------------------------------------- adjust_stock
create function public.adjust_stock(
  p_product_id uuid, p_qty_change numeric, p_reason public.stock_reason,
  p_note text default null, p_unit_cost numeric default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  pr products%rowtype;
  v_role member_role;
  v_stock numeric;
begin
  select * into pr from products where id = p_product_id for update;
  if found then v_role := app_role(pr.business_id); end if;
  if v_role is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'Only an owner or manager can change stock' using errcode = '42501';
  end if;
  if not pr.track_stock then
    raise exception 'Stock tracking is turned off for this product' using errcode = '22023';
  end if;
  if p_reason in ('sale', 'sale_cancel', 'sale_return') then
    raise exception 'This stock reason is reserved for sales' using errcode = '22023';
  end if;
  if p_qty_change is null or p_qty_change = 0 or p_qty_change <> round(p_qty_change, 3)
     or abs(p_qty_change) > 1000000 then
    raise exception 'Invalid quantity' using errcode = '22023';
  end if;
  if p_reason in ('opening', 'stock_in') and p_qty_change < 0 then
    raise exception 'Stock-in quantity must be positive' using errcode = '22023';
  end if;
  if p_reason in ('damage', 'expiry') and p_qty_change > 0 then
    raise exception 'Damaged/expired quantity must reduce stock' using errcode = '22023';
  end if;
  if p_unit_cost is not null and (p_unit_cost < 0 or p_unit_cost <> round(p_unit_cost, 2)) then
    raise exception 'Invalid unit cost' using errcode = '22023';
  end if;

  insert into stock_movements (business_id, product_id, qty_change, reason, unit_cost, note, created_by)
  values (pr.business_id, pr.id, p_qty_change, p_reason, coalesce(p_unit_cost, pr.purchase_price),
          nullif(btrim(p_note), ''), v_uid);
  if p_unit_cost is not null and p_reason in ('opening', 'stock_in') then
    update products set purchase_price = p_unit_cost where id = pr.id;
  end if;
  select stock_qty into v_stock from products where id = pr.id;
  return v_stock;
end $$;

-- ---------------------------------------------------- record_customer_payment
-- Collects money against a customer's dues; applied to the oldest unpaid bills first.
-- Idempotent on p_id.
create function public.record_customer_payment(
  p_id uuid, p_customer_id uuid, p_amount numeric, p_method public.payment_method,
  p_reference text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  c customers%rowtype;
  s record;
  v_left numeric := p_amount;
  v_apply numeric;
begin
  if p_id is null then
    raise exception 'Payment id is required' using errcode = '22023';
  end if;
  select * into c from customers where id = p_customer_id for update;
  if not found or app_role(c.business_id) is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from payments where batch_id = p_id) then
    return jsonb_build_object('balance', c.balance, 'duplicate', true);
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Invalid amount' using errcode = '22023';
  end if;
  if p_amount > c.balance then
    raise exception 'Amount (%) is more than the customer owes (%)', p_amount, c.balance using errcode = '22023';
  end if;

  for s in select id, due_amount from sales
            where customer_id = c.id and status = 'completed' and due_amount > 0
            order by sold_at, id for update loop
    exit when v_left <= 0;
    v_apply := least(v_left, s.due_amount);
    update sales set due_amount = due_amount - v_apply, paid_total = paid_total + v_apply where id = s.id;
    insert into payments (business_id, sale_id, customer_id, kind, method, amount, reference, batch_id, created_by)
    values (c.business_id, s.id, c.id, 'due_collection', p_method, v_apply, nullif(btrim(p_reference), ''), p_id, v_uid);
    v_left := v_left - v_apply;
  end loop;
  if v_left > 0 then
    raise exception 'Customer balance does not match unpaid bills; payment not recorded' using errcode = 'P0001';
  end if;

  update customers set balance = balance - p_amount where id = c.id;
  return jsonb_build_object('balance', c.balance - p_amount, 'duplicate', false);
end $$;

-- -------------------------------------------------------------------- members
-- The person must have signed up already; the owner then adds them by email.
create function public.add_member(p_business_id uuid, p_email text, p_role public.member_role, p_display_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_email text;
begin
  if app_role(p_business_id) is distinct from 'owner' then
    raise exception 'Only the owner can manage staff' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'A business has one owner; choose manager or cashier' using errcode = '22023';
  end if;
  select id, email into v_user, v_email from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'No account uses that email yet. Ask them to sign up first, then add them.' using errcode = 'P0002';
  end if;
  if exists (select 1 from business_members where business_id = p_business_id and user_id = v_user and role = 'owner') then
    raise exception 'That account is the owner' using errcode = '22023';
  end if;
  insert into business_members (business_id, user_id, role, display_name, email)
  values (p_business_id, v_user, p_role, btrim(p_display_name), v_email)
  on conflict (business_id, user_id) do update
    set role = excluded.role, display_name = excluded.display_name, is_active = true;
  insert into audit_log (business_id, user_id, action, entity, entity_id, details)
  values (p_business_id, auth.uid(), 'member.add', 'user', v_user, jsonb_build_object('role', p_role));
  return v_user;
end $$;

create function public.set_member(p_business_id uuid, p_user_id uuid, p_role public.member_role, p_is_active boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role(p_business_id) is distinct from 'owner' then
    raise exception 'Only the owner can manage staff' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'A business has one owner; choose manager or cashier' using errcode = '22023';
  end if;
  update business_members set role = p_role, is_active = p_is_active
   where business_id = p_business_id and user_id = p_user_id and role <> 'owner';
  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;
  insert into audit_log (business_id, user_id, action, entity, entity_id, details)
  values (p_business_id, auth.uid(), 'member.update', 'user', p_user_id,
          jsonb_build_object('role', p_role, 'is_active', p_is_active));
end $$;

-- ------------------------------------------------------------- report_summary
-- Figures for an inclusive date range (dates are IST calendar days).
-- revenue      = taxable value of sales, net of discounts and returns, excluding tax
-- gross_profit = revenue - cost of goods sold (cost of restocked returns is added back)
-- Net profit is not reported: it needs expenses, which this version does not record.
create function public.report_summary(p_business_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_start timestamptz := (p_from::timestamp at time zone 'Asia/Kolkata');
  v_end timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  v_sales jsonb; v_returns jsonb; v_result jsonb;
begin
  if app_role(p_business_id) is null or app_role(p_business_id) not in ('owner', 'manager') then
    raise exception 'Only an owner or manager can view reports' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'count', count(*), 'billed_total', coalesce(sum(grand_total), 0),
    'taxable_total', coalesce(sum(taxable_total), 0), 'tax_total', coalesce(sum(tax_total), 0),
    'discount_total', coalesce(sum(discount_total), 0), 'cost_total', coalesce(sum(cost_total), 0),
    'credit_given', coalesce(sum(grand_total - paid_total) filter (where grand_total > paid_total), 0))
    into v_sales
    from sales where business_id = p_business_id and status = 'completed'
     and sold_at >= v_start and sold_at < v_end;

  select jsonb_build_object(
    'count', count(*), 'total', coalesce(sum(total), 0), 'taxable_total', coalesce(sum(taxable_total), 0),
    'tax_total', coalesce(sum(tax_total), 0), 'cost_total', coalesce(sum(cost_total), 0))
    into v_returns
    from sale_returns where business_id = p_business_id
     and created_at >= v_start and created_at < v_end;

  v_result := jsonb_build_object(
    'from', p_from, 'to', p_to, 'sales', v_sales, 'returns', v_returns,
    'revenue', (v_sales->>'taxable_total')::numeric - (v_returns->>'taxable_total')::numeric,
    'gross_profit', (v_sales->>'taxable_total')::numeric - (v_returns->>'taxable_total')::numeric
                    - ((v_sales->>'cost_total')::numeric - (v_returns->>'cost_total')::numeric),
    'cancelled_count', (select count(*) from sales where business_id = p_business_id
                         and status = 'cancelled' and sold_at >= v_start and sold_at < v_end),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'total', total, 'count', n) order by d)
      from (select (sold_at at time zone 'Asia/Kolkata')::date as d, sum(grand_total) as total, count(*) as n
              from sales where business_id = p_business_id and status = 'completed'
               and sold_at >= v_start and sold_at < v_end group by 1) x), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object('method', method, 'received', received, 'refunded', refunded) order by method)
      from (select method,
                   coalesce(sum(amount) filter (where kind in ('sale', 'due_collection')), 0) as received,
                   coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunded
              from payments where business_id = p_business_id
               and paid_at >= v_start and paid_at < v_end group by method) x), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'qty', qty, 'total', total)
                       order by total desc, name)
      from (select i.product_id, max(i.name) as name, sum(i.qty) as qty, sum(i.line_total) as total
              from sale_items i join sales s on s.id = i.sale_id
             where s.business_id = p_business_id and s.status = 'completed'
               and s.sold_at >= v_start and s.sold_at < v_end
             group by i.product_id order by sum(i.line_total) desc limit 10) x), '[]'::jsonb),
    'gst_by_rate', coalesce((
      select jsonb_agg(jsonb_build_object('tax_rate', tax_rate, 'taxable', taxable, 'cgst', cgst,
                                          'sgst', sgst, 'igst', igst) order by tax_rate)
      from (select i.tax_rate, sum(i.taxable_value) as taxable, sum(i.cgst) as cgst,
                   sum(i.sgst) as sgst, sum(i.igst) as igst
              from sale_items i join sales s on s.id = i.sale_id
             where s.business_id = p_business_id and s.status = 'completed'
               and s.sold_at >= v_start and s.sold_at < v_end
             group by i.tax_rate) x), '[]'::jsonb),
    'gst_by_hsn', coalesce((
      select jsonb_agg(jsonb_build_object('hsn_code', hsn_code, 'tax_rate', tax_rate, 'qty', qty,
                                          'taxable', taxable, 'tax', tax) order by hsn_code, tax_rate)
      from (select coalesce(i.hsn_code, '') as hsn_code, i.tax_rate, sum(i.qty) as qty,
                   sum(i.taxable_value) as taxable, sum(i.cgst + i.sgst + i.igst) as tax
              from sale_items i join sales s on s.id = i.sale_id
             where s.business_id = p_business_id and s.status = 'completed'
               and s.sold_at >= v_start and s.sold_at < v_end
             group by 1, 2) x), '[]'::jsonb),
    -- point-in-time figures (not limited to the date range)
    'outstanding_dues', (select coalesce(sum(balance), 0) from customers where business_id = p_business_id),
    'stock_value', (select coalesce(sum(stock_qty * purchase_price), 0)::numeric(14,2) from products
                     where business_id = p_business_id and track_stock and is_active and stock_qty > 0),
    'low_stock_count', (select count(*) from products where business_id = p_business_id
                         and track_stock and is_active and stock_qty <= low_stock_threshold));
  return v_result;
end $$;

-- Only signed-in users may call the API functions; internals are not exposed at all.
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.app_role(uuid),
  public.create_business(jsonb),
  public.create_sale(jsonb),
  public.cancel_sale(uuid, text),
  public.create_return(jsonb),
  public.adjust_stock(uuid, numeric, public.stock_reason, text, numeric),
  public.record_customer_payment(uuid, uuid, numeric, public.payment_method, text),
  public.add_member(uuid, text, public.member_role, text),
  public.set_member(uuid, uuid, public.member_role, boolean),
  public.report_summary(uuid, date, date)
  to authenticated;
