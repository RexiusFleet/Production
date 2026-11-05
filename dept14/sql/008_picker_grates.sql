-- =====================================================================
-- Dept 14 - 008_picker_grates.sql
-- Each picker run keeps the grate % it was entered with, so switching
-- the active profile in Settings (or editing a profile) never changes
-- past estimates. A run can be moved to the other profile when editing it
-- (and from the calendar later).
--   picker_runs.grate_profile        1 or 2
--   picker_runs.small/medium/lost_pct the % used for that run
-- Existing runs get profile 1 with today's % for their material.
-- picker_estimates uses the run's own % (falls back to Settings if empty).
-- Also: orchid inventory gets a middle section with Jumbo Orchid and a new
-- NW Bark bin (both show on the inventory and can be purchased).
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

alter table dept14.picker_runs add column if not exists grate_profile smallint check (grate_profile in (1, 2));
alter table dept14.picker_runs add column if not exists small_pct  numeric check (small_pct  between 0 and 100);
alter table dept14.picker_runs add column if not exists medium_pct numeric check (medium_pct between 0 and 100);
alter table dept14.picker_runs add column if not exists lost_pct   numeric check (lost_pct   between 0 and 100);

alter table dept14.picker_runs disable trigger picker_runs_log;
update dept14.picker_runs p
   set grate_profile = 1,
       small_pct  = coalesce((s.value -> 'ratios' -> m.name ->> 'small')::numeric, 0),
       medium_pct = coalesce((s.value -> 'ratios' -> m.name ->> 'medium')::numeric, 0),
       lost_pct   = coalesce((s.value -> 'ratios' -> m.name ->> 'lost')::numeric, 0)
  from dept14.bins m, dept14.settings s
 where m.id = p.material_bin_id and s.key = 'orchid' and p.small_pct is null;
alter table dept14.picker_runs enable trigger picker_runs_log;

insert into dept14.bins (name, kind, unit, sort, is_core, on_map, purchasable)
values ('NW Bark', 'material', 'yd', 95, true, true, true)
on conflict (name) do nothing;
update dept14.bins set on_map = true, purchasable = true where name in ('Jumbo Orchid', 'NW Bark');

create or replace view dept14.picker_estimates with (security_invoker = true) as
  with s as (select coalesce((value ->> 'yards_per_unit')::numeric, 7.5) as ypu, value -> 'ratios' as ratios
             from dept14.settings where key = 'orchid')
  select p.id, p.production_date, m.name as material, p.units, p.hours, p.notes,
         p.units * coalesce(s.ypu, 7.5) as yards,
         p.units * coalesce(s.ypu, 7.5) * coalesce(p.small_pct,  (s.ratios -> m.name ->> 'small')::numeric, 0)  / 100 as small_green,
         p.units * coalesce(s.ypu, 7.5) * coalesce(p.medium_pct, (s.ratios -> m.name ->> 'medium')::numeric, 0) / 100 as medium_green,
         p.units * coalesce(s.ypu, 7.5) * coalesce(p.lost_pct,   (s.ratios -> m.name ->> 'lost')::numeric, 0)   / 100 as lost
  from dept14.picker_runs p
  join dept14.bins m on m.id = p.material_bin_id
  left join s on true;

commit;

-- Check: paste this back
select 'columns' as what, (select string_agg(column_name, ', ' order by column_name) from information_schema.columns
  where table_schema = 'dept14' and table_name = 'picker_runs' and column_name in ('grate_profile','small_pct','medium_pct','lost_pct')) as detail
union all select 'runs with grates', (select count(*) filter (where small_pct is not null) || ' of ' || count(*) from dept14.picker_runs)
union all select 'material bins', (select string_agg(name || case when on_map and purchasable then '' else ' (hidden)' end, ', ' order by sort)
  from dept14.bins where kind = 'material')
union all select 'estimate check', (select round(sum(small_green), 2) || ' small / ' || round(sum(medium_green), 2) || ' medium yd' from dept14.picker_estimates);
