-- =====================================================================
-- Dept 14 - 010_jumbo_from_picker.sql
-- A Jumbo Orchid picker run now takes its yards (units x yards per unit)
-- out of the Jumbo Orchid bin, the same way #1 Medium Green runs already
-- do. Purchased Jumbo adds to the bin (already the case). Nate, 2026-11-05.
-- Only the picker line of dept14.orchid_ledger changes; orchid_on_hand
-- reads the ledger, so it follows. As always, a count replaces every
-- movement dated on or before it, so Jumbo gets a starting count of 0 on
-- 2026-11-04 (the day every other bin was counted) if it has no count yet;
-- only picker runs and purchases after that day move it.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

insert into dept14.inventory_counts (bin_id, qty, counted_on)
select b.id, 0, date '2026-11-04' from dept14.bins b
 where b.name = 'Jumbo Orchid'
   and not exists (select 1 from dept14.inventory_counts c where c.bin_id = b.id);

create or replace view dept14.orchid_ledger with (security_invoker = true) as
  select e.production_date as on_date, 'picker'::text as source, e.id as source_id,
         (select id from dept14.bins where name = '#1 Small Green') as bin_id, e.small_green as qty_delta, 'small green (est.)'::text as detail
  from dept14.picker_estimates e where e.small_green <> 0
  union all
  select e.production_date, 'picker', e.id, (select id from dept14.bins where name = '#1 Medium Green'), e.medium_green, 'medium green (est.)'
  from dept14.picker_estimates e where e.medium_green <> 0
  union all
  select e.production_date, 'picker', e.id, m.id, -e.yards, 'run through the picker'
  from dept14.picker_estimates e join dept14.bins m on m.name = e.material
  where e.material in ('#1 Medium Green', 'Jumbo Orchid')
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

commit;

-- Check: paste this back
select 'jumbo picker rows in ledger' as what,
       (select count(*)::text from dept14.orchid_ledger l join dept14.bins b on b.id = l.bin_id
         where b.name = 'Jumbo Orchid' and l.source = 'picker') as detail
union all select 'jumbo on hand',
       (select round(on_hand, 2)::text || ' yd (last count ' || coalesce(last_counted_on::text, 'none') || ')'
          from dept14.orchid_on_hand where name = 'Jumbo Orchid');
