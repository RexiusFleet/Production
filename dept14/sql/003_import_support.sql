-- =====================================================================
-- Dept 14 · 003_import_support.sql
-- Small schema changes the Google Sheets history needs:
--   • job type 'other' for biochar labor that isn't wash/sock/bag
--     (blending, cleanup, order fulfillment, misc hours in the old archive)
--   • picker and bagging "hours" are crew labor hours for the day, which
--     can be more than 24 (e.g. 3 people × 8.5 h = 25.5), so allow up to 200
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run, after 002.
-- Safe to re-run. Paste the check result back.
-- =====================================================================
begin;

alter table dept14.production_runs drop constraint if exists production_runs_job_type_check;
alter table dept14.production_runs add constraint production_runs_job_type_check
  check (job_type in ('wash','sock','bag','other'));

alter table dept14.picker_runs drop constraint if exists picker_runs_hours_check;
alter table dept14.picker_runs add constraint picker_runs_hours_check check (hours >= 0 and hours <= 200);

alter table dept14.bagging_runs drop constraint if exists bagging_runs_hours_check;
alter table dept14.bagging_runs add constraint bagging_runs_hours_check check (hours >= 0 and hours <= 200);

commit;

select conname, pg_get_constraintdef(oid) as rule
from pg_constraint
where conname in ('production_runs_job_type_check','picker_runs_hours_check','bagging_runs_hours_check')
order by conname;
