-- =====================================================================
-- Dept 14 - 016_labor_per_person.sql   (2026-11-05)
-- 1. Biochar sheet hours are per person (Nate): labor = hours x the number
--    of people on the sheet (at least 1). Output stays the same. The
--    month_end_labor view now counts it that way, matching the dashboard:
--    total_hours = hours x people; equipment_hours = that x the job's
--    ratio; labor_hours = the rest. Orchid hours are unchanged.
-- 2. Custom tote counts on a wash sheet must be real numbers: a count sent
--    as "NaN" / "Infinity" was being stored as text and slipped past 015.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

create or replace view dept14.month_end_labor with (security_invoker = true) as
  with r as (
    select r.*, greatest(1, (select count(*) from dept14.run_workers w where w.run_id = r.id)) as people
      from dept14.production_runs r
     where r.status = 'active' and r.line = 'biochar')
  select date_trunc('month', r.production_date)::date as month,
         r.job_type,
         count(*)                                   as runs,
         sum(r.hours * r.people)                    as total_hours,
         round(sum(r.hours * r.people * coalesce((s.value ->> r.job_type)::numeric, 0)), 2) as equipment_hours,
         round(sum(r.hours * r.people * (1 - coalesce((s.value ->> r.job_type)::numeric, 0))), 2) as labor_hours,
         sum(coalesce(r.boxes, 0))                  as boxes,
         sum(coalesce(r.pallets, 0))                as pallets
  from r
  left join dept14.settings s on s.key = 'equipment_ratio'
  group by 1, 2;

alter table dept14.production_runs drop constraint if exists production_runs_pending_totes_sane;
alter table dept14.production_runs add constraint production_runs_pending_totes_sane
  check (jsonb_typeof(pending_totes) = 'array'
         and not jsonb_path_exists(pending_totes,
               '$[*] ? (!(@.count.type() == "number" && @.count > 0 && @.count < 100000))'));

commit;

-- Check: paste this back
select 'Oct 2026 labor (hours x people)' as what,
       (select string_agg(job_type || ' ' || round(total_hours, 1), ', ' order by job_type)
          from dept14.month_end_labor where month = date '2026-10-01') as detail
union all select 'tote count check', (select pg_get_constraintdef(oid) like '%type()%' from pg_constraint
  where conname = 'production_runs_pending_totes_sane')::text;
