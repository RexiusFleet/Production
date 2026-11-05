-- =====================================================================
-- Dept 14 - 011_sales_shipping.sql
-- The sales page (/dept14/sales) and the manager dashboard share the
-- orders table. New columns:
--   po            customer PO number (sales enter it)
--   ready         production says the order is ready (manager's switch)
--   ready_on      stamped when ready is switched on, cleared when off
--   carrier       shipping: who carries it          (sales enter it)
--   ship_date     shipping: the date it ships        (sales enter it)
--   freight_cost  shipping: what the freight costs   (sales enter it)
-- A ship date does not complete an order; the manager still ticks
-- Completed (that is what takes it out of inventory).
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

alter table dept14.orders add column if not exists po           text;
alter table dept14.orders add column if not exists ready        boolean not null default false;
alter table dept14.orders add column if not exists ready_on     date;
alter table dept14.orders add column if not exists carrier      text;
alter table dept14.orders add column if not exists ship_date    date;
alter table dept14.orders add column if not exists freight_cost numeric check (freight_cost is null or freight_cost >= 0);

create or replace function dept14.stamp_order_ready() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.ready and new.ready_on is null then new.ready_on := current_date;
  elsif not new.ready then new.ready_on := null; end if;
  return new;
end $$;
drop trigger if exists orders_ready on dept14.orders;
create trigger orders_ready before insert or update on dept14.orders
  for each row execute function dept14.stamp_order_ready();

commit;

-- Check: paste this back
select 'new columns' as what, (select string_agg(column_name, ', ' order by column_name) from information_schema.columns
  where table_schema = 'dept14' and table_name = 'orders'
    and column_name in ('po','ready','ready_on','carrier','ship_date','freight_cost')) as detail
union all select 'ready trigger', (select count(*)::text from pg_trigger where tgname = 'orders_ready')
union all select 'open orchid orders', (select count(*)::text from dept14.orders where line = 'orchid' and not completed);
