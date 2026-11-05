-- =====================================================================
-- Dept 14 - 005_orders.sql
-- Close-outs: one Sales log for both lines.
--   dept14.orders       one row per order: line (biochar / orchid), order
--                       date, customer, sales order #, notes, completed,
--                       completed_on (the day it shipped)
--   dept14.order_lines  the products on an order: a biochar item (custom
--                       blends carry custom_name, custom socks custom_size_ft)
--                       or an orchid bin, plus qty (and load type for orchid)
-- Open orders don't move inventory. A completed order takes its products
-- out of inventory on completed_on (set automatically when Completed is
-- ticked; cleared when unticked).
-- The existing orchid sales_orders rows are copied in (rows with the same
-- order date + customer + sales order # become one order). sales_orders is
-- kept as it was but no longer used by the views.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

create table if not exists dept14.orders (
  id             uuid primary key default gen_random_uuid(),
  line           text not null check (line in ('biochar','orchid')),
  order_date     date not null,
  customer       text not null,
  sales_order_no text,
  notes          text,
  completed      boolean not null default false,
  completed_on   date,
  import_ref     text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists orders_line_idx on dept14.orders (line, completed);

create table if not exists dept14.order_lines (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references dept14.orders(id) on delete cascade,
  item_id        uuid references dept14.items(id),
  bin_id         uuid references dept14.bins(id),
  custom_name    text,
  custom_size_ft numeric,
  load_type      text check (load_type is null or load_type in ('BULK','BAGS','TOTES')),
  qty            numeric not null check (qty > 0),
  check (num_nonnulls(item_id, bin_id) = 1)
);
create index if not exists order_lines_order_idx on dept14.order_lines (order_id);

-- completed_on follows the Completed box
create or replace function dept14.stamp_order_completed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.completed and new.completed_on is null then new.completed_on := current_date;
  elsif not new.completed then new.completed_on := null; end if;
  return new;
end $$;
drop trigger if exists orders_completed on dept14.orders;
create trigger orders_completed before insert or update on dept14.orders
  for each row execute function dept14.stamp_order_completed();
drop trigger if exists orders_touch on dept14.orders;
create trigger orders_touch before update on dept14.orders
  for each row execute function dept14.touch_updated_at();
drop trigger if exists orders_log on dept14.orders;
create trigger orders_log after insert or update or delete on dept14.orders
  for each row execute function dept14.log_change();
drop trigger if exists order_lines_log on dept14.order_lines;
create trigger order_lines_log after insert or update or delete on dept14.order_lines
  for each row execute function dept14.log_change();

-- copy the orchid sales in (completed ones keep their order date as the ship date,
-- so inventory doesn't change)
alter table dept14.orders disable trigger orders_log;
alter table dept14.order_lines disable trigger order_lines_log;
insert into dept14.orders (id, line, order_date, customer, sales_order_no, notes, completed, completed_on, import_ref)
select md5('so:' || s.order_date || '|' || s.customer || '|' || coalesce(s.sales_order_no, ''))::uuid,
       'orchid', s.order_date, s.customer, max(s.sales_order_no), string_agg(nullif(s.notes, ''), ' / '),
       bool_and(s.completed), case when bool_and(s.completed) then s.order_date end,
       'sales_orders'
from dept14.sales_orders s
group by s.order_date, s.customer, coalesce(s.sales_order_no, '')
on conflict (id) do nothing;
insert into dept14.order_lines (id, order_id, bin_id, load_type, qty)
select s.id, md5('so:' || s.order_date || '|' || s.customer || '|' || coalesce(s.sales_order_no, ''))::uuid, s.bin_id, s.load_type, s.qty
from dept14.sales_orders s
on conflict (id) do nothing;
alter table dept14.orders enable trigger orders_log;
alter table dept14.order_lines enable trigger order_lines_log;

-- ---- views: completed orders take product out on completed_on ----
drop view if exists dept14.on_hand;
drop view if exists dept14.inventory_ledger;
create view dept14.inventory_ledger with (security_invoker = true) as
  select r.production_date as on_date, 'run'::text as source, r.id as source_id,
         l.item_id, l.custom_size_ft, l.custom_name,
         case l.direction when 'out' then l.qty else -l.qty end as qty_delta,
         r.job_type as detail
  from dept14.run_lines l
  join dept14.production_runs r on r.id = l.run_id
  where r.status = 'active'
  union all
  select a.adj_date, 'adjustment', a.id, a.item_id, a.custom_size_ft, a.custom_name, a.qty_delta, a.reason
  from dept14.inventory_adjustments a where a.item_id is not null
  union all
  select p.purchase_date, 'purchase', p.id, p.item_id, null::numeric, null::text, p.amount, coalesce('PO ' || p.po, 'purchased')
  from dept14.purchases p where p.item_id is not null
  union all
  select o.completed_on, 'sale', o.id, ol.item_id, ol.custom_size_ft, ol.custom_name, -ol.qty, o.customer
  from dept14.order_lines ol join dept14.orders o on o.id = ol.order_id
  where o.completed and ol.item_id is not null;

create view dept14.on_hand with (security_invoker = true) as
  with keys as (
    select item_id, custom_size_ft, custom_name from dept14.inventory_ledger
    union
    select item_id, custom_size_ft, custom_name from dept14.inventory_counts where item_id is not null
    union
    select id, null::numeric, null::text from dept14.items where line = 'biochar' and active and not is_custom
  ),
  last_count as (
    select distinct on (item_id, custom_size_ft, custom_name) item_id, custom_size_ft, custom_name, qty, counted_on
    from dept14.inventory_counts where item_id is not null
    order by item_id, custom_size_ft, custom_name, counted_on desc, created_at desc
  ),
  open_orders as (
    select ol.item_id, ol.custom_size_ft, ol.custom_name, sum(ol.qty) as qty
    from dept14.order_lines ol join dept14.orders o on o.id = ol.order_id
    where not o.completed and ol.item_id is not null
    group by 1, 2, 3
  )
  select k.item_id, i.code, i.name, i.kind, i.unit, i.blend, k.custom_size_ft, k.custom_name, i.active,
         c.counted_on as last_counted_on,
         coalesce(c.qty, 0) + coalesce((
           select sum(l.qty_delta) from dept14.inventory_ledger l
           where l.item_id = k.item_id
             and l.custom_size_ft is not distinct from k.custom_size_ft
             and l.custom_name is not distinct from k.custom_name
             and (c.counted_on is null or l.on_date > c.counted_on)), 0) as on_hand,
         coalesce(oo.qty, 0) as on_open_orders
  from keys k
  join dept14.items i on i.id = k.item_id
  left join last_count c on c.item_id = k.item_id
    and c.custom_size_ft is not distinct from k.custom_size_ft
    and c.custom_name is not distinct from k.custom_name
  left join open_orders oo on oo.item_id = k.item_id
    and oo.custom_size_ft is not distinct from k.custom_size_ft
    and oo.custom_name is not distinct from k.custom_name
  where i.line = 'biochar';

drop view if exists dept14.orchid_on_hand;
create or replace view dept14.orchid_ledger with (security_invoker = true) as
  select e.production_date as on_date, 'picker'::text as source, e.id as source_id,
         (select id from dept14.bins where name = '#1 Small Green') as bin_id, e.small_green as qty_delta, 'small green (est.)'::text as detail
  from dept14.picker_estimates e where e.small_green <> 0
  union all
  select e.production_date, 'picker', e.id, (select id from dept14.bins where name = '#1 Medium Green'), e.medium_green, 'medium green (est.)'
  from dept14.picker_estimates e where e.medium_green <> 0
  union all
  select e.production_date, 'picker', e.id, (select id from dept14.bins where name = '#1 Medium Green'), -e.yards, 'run through the picker'
  from dept14.picker_estimates e where e.material = '#1 Medium Green'
  union all
  select p.purchase_date, 'purchase', p.id, p.bin_id, p.amount, coalesce('PO ' || p.po, 'purchased')
  from dept14.purchases p where p.bin_id is not null
  union all
  select r.production_date, 'dryer', r.id, r.product_bin_id, -r.yards_in, 'into the dryer'
  from dept14.dryer_runs r where r.status = 'active'
  union all
  select r.production_date, 'dryer', r.id, r.bin_id, r.yards_out, 'out of the dryer'
  from dept14.dryer_runs r where r.status = 'active' and r.destination = 'bin'
  union all
  select r.production_date, 'dryer', r.id, t.id, r.totes, 'totes made'
  from dept14.dryer_runs r
  join dept14.bins pb on pb.id = r.product_bin_id
  join dept14.bins t  on t.name = pb.totes_to
  where r.status = 'active' and r.destination = 'totes' and coalesce(r.totes, 0) <> 0
  union all
  select b.production_date, 'bagging', b.id, b.from_bin_id, -b.yards_used, 'bagged'
  from dept14.bagging_runs b
  union all
  select b.production_date, 'bagging', b.id, t.id, b.pallets, 'pallets bagged'
  from dept14.bagging_runs b
  join dept14.bins f on f.id = b.from_bin_id
  join dept14.bins t on t.name = f.bags_to
  union all
  select o.completed_on, 'sale', o.id, ol.bin_id, -ol.qty, o.customer
  from dept14.order_lines ol join dept14.orders o on o.id = ol.order_id
  where o.completed and ol.bin_id is not null
  union all
  select a.adj_date, 'adjustment', a.id, a.bin_id, a.qty_delta, a.reason
  from dept14.inventory_adjustments a where a.bin_id is not null;

create view dept14.orchid_on_hand with (security_invoker = true) as
  with last_count as (
    select distinct on (bin_id) bin_id, qty, counted_on
    from dept14.inventory_counts where bin_id is not null
    order by bin_id, counted_on desc, created_at desc
  ),
  open_orders as (
    select ol.bin_id, sum(ol.qty) as qty
    from dept14.order_lines ol join dept14.orders o on o.id = ol.order_id
    where not o.completed and ol.bin_id is not null group by ol.bin_id
  )
  select b.id as bin_id, b.name, b.kind, b.unit, b.note, b.sort, b.on_map, b.is_core, b.active,
         c.counted_on as last_counted_on,
         coalesce(c.qty, 0) + coalesce((
           select sum(l.qty_delta) from dept14.orchid_ledger l
           where l.bin_id = b.id and (c.counted_on is null or l.on_date > c.counted_on)), 0) as on_hand,
         coalesce(o.qty, 0) as on_open_orders
  from dept14.bins b
  left join last_count c on c.bin_id = b.id
  left join open_orders o on o.bin_id = b.id;

-- ---- permissions ----
grant select, insert, update, delete on dept14.orders, dept14.order_lines to authenticated;
grant select on dept14.inventory_ledger, dept14.on_hand, dept14.orchid_ledger, dept14.orchid_on_hand to authenticated;
revoke all on dept14.orders, dept14.order_lines from anon;
revoke all on function dept14.stamp_order_completed() from public, anon;
do $$
declare t text;
begin
  foreach t in array array['orders','order_lines'] loop
    execute format('alter table dept14.%I enable row level security', t);
    execute format('drop policy if exists logged_in_all on dept14.%I', t);
    execute format('create policy logged_in_all on dept14.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

commit;

-- Check: paste this back
select 'orders' as what, count(*)::text as detail from dept14.orders
union all select 'order lines', count(*)::text from dept14.order_lines
union all select 'old sales rows', count(*)::text from dept14.sales_orders
union all select 'open orders', count(*)::text from dept14.orders where not completed
union all select 'orchid on hand', string_agg(name || ' ' || round(on_hand, 2), ' | ' order by sort) from dept14.orchid_on_hand where on_hand <> 0
union all select 'rls_off', coalesce((select string_agg(relname, ', ') from pg_class
  where relnamespace = 'dept14'::regnamespace and relkind = 'r' and not relrowsecurity), 'none');
