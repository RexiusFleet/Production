-- =====================================================================
-- Dept 14 - 006_order_priority.sql
-- Active orders on the orchid inventory screen are ranked 1, 2, 3...
-- and the manager drags them into order. This stores that rank.
-- Open orchid orders get a starting rank by order date (oldest = 1).
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

alter table dept14.orders add column if not exists priority int;

with ranked as (
  select id, row_number() over (order by order_date, created_at, id) as rn
  from dept14.orders
  where line = 'orchid' and not completed and priority is null
)
update dept14.orders o
   set priority = r.rn + coalesce((select max(priority) from dept14.orders
                                   where line = 'orchid' and not completed and priority is not null), 0)
  from ranked r
 where o.id = r.id;

commit;

-- Check: paste this back
select 'priority column' as what,
       (select data_type from information_schema.columns
         where table_schema = 'dept14' and table_name = 'orders' and column_name = 'priority') as detail
union all select 'open orchid orders ranked',
       (select count(*)::text || ' of ' || (select count(*) from dept14.orders where line = 'orchid' and not completed)
          from dept14.orders where line = 'orchid' and not completed and priority is not null);
