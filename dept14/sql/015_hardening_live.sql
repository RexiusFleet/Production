-- =====================================================================
-- Dept 14 - 015_hardening_live.sql   (whole-app test fixes, 2026-11-05)
--
-- 1. Numbers: no NaN / Infinity / absurd values can be stored. Postgres
--    treats 'NaN' as bigger than every number, so "qty > 0" let it through
--    from the open crew sheets and one bad submit made on-hand NaN.
--    Table checks cover every way in (crew sheets, dashboard, sales page).
--    Also: a wash tote line must equal totes x size.
-- 2. All-or-nothing saves: replacing an order's lines, a run's crew and
--    lines, or a dryer run's crew now happens in one database call, so a
--    dropped connection can't leave an order or run with no lines.
-- 3. Sales page saves through save_sales_order / cancel_sales_order: they
--    refuse to overwrite an order someone changed since it was opened,
--    refuse completed orders, never touch ready / completed / priority,
--    and check the ship date isn't before the order date.
-- 4. Live updates: the Dept 14 tables are added to Supabase's realtime
--    publication (only dept14 tables; nothing else changes) so the
--    dashboard and the sales page refresh when new data comes in.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

-- ---------- 1. sane numbers ----------
create or replace function dept14.num_ok(v numeric, lo numeric, hi numeric)
returns boolean language sql immutable set search_path = '' as $$
  select v is null or (v <> 'NaN'::numeric and v >= lo and v <= hi)
$$;

do $$
declare c record;
begin
  for c in select * from (values
    ('run_lines','qty',0,1000000), ('run_lines','tote_count',0,100000), ('run_lines','tote_size_yd',0,100),
    ('run_lines','custom_size_ft',0,1000),
    ('dryer_runs','yards_in',0,100000), ('dryer_runs','yards_out',0,100000), ('dryer_runs','totes',0,100000),
    ('picker_runs','units',0,100000), ('bagging_runs','yards_used',0,100000), ('bagging_runs','pallets',0,100000),
    ('order_lines','qty',0,1000000), ('order_lines','custom_size_ft',0,1000),
    ('purchases','amount',0,1000000), ('inventory_counts','qty',-1000000,1000000),
    ('inventory_adjustments','qty_delta',-1000000,1000000), ('orders','freight_cost',0,10000000)
  ) as t(tbl, col, lo, hi) loop
    execute format('alter table dept14.%I drop constraint if exists %I', c.tbl, c.tbl || '_' || c.col || '_sane');
    execute format('alter table dept14.%I add constraint %I check (dept14.num_ok(%I, %s, %s))',
                   c.tbl, c.tbl || '_' || c.col || '_sane', c.col, c.lo, c.hi);
  end loop;
end $$;

alter table dept14.run_lines drop constraint if exists run_lines_tote_math;
alter table dept14.run_lines add constraint run_lines_tote_math
  check (tote_count is null or tote_size_yd is null or abs(qty - tote_count * tote_size_yd) < 0.01);

alter table dept14.production_runs drop constraint if exists production_runs_pending_totes_sane;
alter table dept14.production_runs add constraint production_runs_pending_totes_sane
  check (jsonb_typeof(pending_totes) = 'array'
         and not jsonb_path_exists(pending_totes, '$[*] ? (!(@.count > 0 && @.count < 100000))'));

-- ---------- 2. all-or-nothing replacements (managers only) ----------
create or replace function dept14.replace_order_lines(p_order uuid, p_lines jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from dept14.order_lines where order_id = p_order;
  insert into dept14.order_lines (order_id, item_id, bin_id, custom_name, custom_size_ft, load_type, qty)
  select p_order, nullif(l ->> 'item_id', '')::uuid, nullif(l ->> 'bin_id', '')::uuid,
         nullif(l ->> 'custom_name', ''), nullif(l ->> 'custom_size_ft', '')::numeric,
         nullif(l ->> 'load_type', ''), (l ->> 'qty')::numeric
    from jsonb_array_elements(coalesce(p_lines, '[]')) l;
end $$;

create or replace function dept14.replace_run_children(p_run uuid, p_workers uuid[], p_lines jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from dept14.run_workers where run_id = p_run;
  insert into dept14.run_workers (run_id, employee_id)
  select p_run, w from unnest(coalesce(p_workers, '{}')) w on conflict do nothing;
  delete from dept14.run_lines where run_id = p_run;
  insert into dept14.run_lines (run_id, direction, item_id, qty, custom_size_ft, custom_name, tote_count, tote_size_yd)
  select p_run, l ->> 'direction', (l ->> 'item_id')::uuid, (l ->> 'qty')::numeric,
         nullif(l ->> 'custom_size_ft', '')::numeric, nullif(l ->> 'custom_name', ''),
         nullif(l ->> 'tote_count', '')::numeric, nullif(l ->> 'tote_size_yd', '')::numeric
    from jsonb_array_elements(coalesce(p_lines, '[]')) l;
end $$;

create or replace function dept14.replace_dryer_workers(p_run uuid, p_workers uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from dept14.dryer_run_workers where run_id = p_run;
  insert into dept14.dryer_run_workers (run_id, employee_id)
  select p_run, w from unnest(coalesce(p_workers, '{}')) w on conflict do nothing;
end $$;

-- ---------- 3. sales page saves ----------
-- p: {id, order_date, customer, sales_order_no, po, notes, carrier, ship_date, freight_cost}
-- p_lines: [{bin_id, qty, load_type}]   p_expected: updated_at the sales page loaded (null = new order)
create or replace function dept14.save_sales_order(p jsonb, p_lines jsonb, p_expected timestamptz)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  v_id   uuid := (p ->> 'id')::uuid;
  v_cur  dept14.orders;
  v_date date := (p ->> 'order_date')::date;
  v_ship date := nullif(p ->> 'ship_date', '')::date;
  v_out  timestamptz;
begin
  if v_id is null then raise exception 'Missing order id'; end if;
  if v_date is null then raise exception 'Pick the order date'; end if;
  if nullif(trim(p ->> 'customer'), '') is null then raise exception 'Enter the customer'; end if;
  if v_ship is not null and v_ship < v_date then raise exception 'The ship date can''t be before the order date'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'Add at least one product'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
              where nullif(l ->> 'bin_id', '') is null or not dept14.num_ok((l ->> 'qty')::numeric, 0.0001, 1000000)) then
    raise exception 'Each product needs a quantity'; end if;

  select * into v_cur from dept14.orders where id = v_id for update;
  if found then
    if v_cur.line <> 'orchid' then raise exception 'Not an orchid order'; end if;
    if v_cur.completed then raise exception 'This order was completed and can''t be changed'; end if;
    if p_expected is null or v_cur.updated_at <> p_expected then
      raise exception 'Someone else changed this order. It has been reloaded.'; end if;
    update dept14.orders set order_date = v_date, customer = trim(p ->> 'customer'),
           sales_order_no = nullif(trim(p ->> 'sales_order_no'), ''), po = nullif(trim(p ->> 'po'), ''),
           notes = nullif(trim(p ->> 'notes'), ''), carrier = nullif(trim(p ->> 'carrier'), ''),
           ship_date = v_ship, freight_cost = nullif(p ->> 'freight_cost', '')::numeric
     where id = v_id;
  else
    insert into dept14.orders (id, line, order_date, customer, sales_order_no, po, notes, carrier, ship_date, freight_cost)
    values (v_id, 'orchid', v_date, trim(p ->> 'customer'), nullif(trim(p ->> 'sales_order_no'), ''), nullif(trim(p ->> 'po'), ''),
            nullif(trim(p ->> 'notes'), ''), nullif(trim(p ->> 'carrier'), ''), v_ship, nullif(p ->> 'freight_cost', '')::numeric);
  end if;
  perform dept14.replace_order_lines(v_id, p_lines);
  update dept14.orders set updated_at = now() where id = v_id returning updated_at into v_out;
  return v_out;
end $$;

create or replace function dept14.cancel_sales_order(p_id uuid, p_expected timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_cur dept14.orders;
begin
  select * into v_cur from dept14.orders where id = p_id for update;
  if not found then return; end if;
  if v_cur.line <> 'orchid' then raise exception 'Not an orchid order'; end if;
  if v_cur.completed then raise exception 'This order was completed and can''t be cancelled'; end if;
  if p_expected is null or v_cur.updated_at <> p_expected then
    raise exception 'Someone else changed this order. It has been reloaded.'; end if;
  delete from dept14.orders where id = p_id;
end $$;

revoke all on function dept14.num_ok(numeric, numeric, numeric) from public, anon;
grant execute on function dept14.num_ok(numeric, numeric, numeric) to authenticated;
revoke all on function dept14.stamp_order_ready() from public, anon;
revoke all on function dept14.replace_order_lines(uuid, jsonb) from public, anon;
revoke all on function dept14.replace_run_children(uuid, uuid[], jsonb) from public, anon;
revoke all on function dept14.replace_dryer_workers(uuid, uuid[]) from public, anon;
revoke all on function dept14.save_sales_order(jsonb, jsonb, timestamptz) from public, anon;
revoke all on function dept14.cancel_sales_order(uuid, timestamptz) from public, anon;
grant execute on function dept14.replace_order_lines(uuid, jsonb) to authenticated;
grant execute on function dept14.replace_run_children(uuid, uuid[], jsonb) to authenticated;
grant execute on function dept14.replace_dryer_workers(uuid, uuid[]) to authenticated;
grant execute on function dept14.save_sales_order(jsonb, jsonb, timestamptz) to authenticated;
grant execute on function dept14.cancel_sales_order(uuid, timestamptz) to authenticated;

-- ---------- 4. live updates ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders','order_lines','production_runs','run_lines','run_workers','dryer_runs','dryer_run_workers',
                             'picker_runs','bagging_runs','purchases','inventory_counts','inventory_adjustments','settings',
                             'calendar_days','bins','employees','items'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'dept14' and tablename = t) then
        execute format('alter publication supabase_realtime add table dept14.%I', t);
      end if;
    end loop;
  end if;
end $$;

commit;

-- Check: paste this back
select 'number checks' as what, (select count(*)::text from pg_constraint where conname like '%\_sane' and connamespace = 'dept14'::regnamespace) as detail
union all select 'safe save functions', (select string_agg(proname, ', ' order by proname) from pg_proc
  where pronamespace = 'dept14'::regnamespace and proname in ('replace_order_lines','replace_run_children','replace_dryer_workers','save_sales_order','cancel_sales_order'))
union all select 'live tables', (select count(*)::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'dept14')
union all select 'anon can run', (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
  where p.pronamespace = 'dept14'::regnamespace and has_function_privilege('anon', p.oid, 'execute'));
