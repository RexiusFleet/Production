-- =====================================================================
-- Dept 14 - 012_calendar_plan.sql
-- The orchid master calendar gets a day Plan note (any day, past or
-- future) that production writes on the dashboard and sales see on the
-- sales page. Stored in calendar_days with kind = 'orc'.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

alter table dept14.calendar_days drop constraint if exists calendar_days_kind_check;
alter table dept14.calendar_days add constraint calendar_days_kind_check
  check (kind in ('bio','dryer','pick','bag','orc'));

commit;

-- Check: paste this back
select 'kinds allowed' as what, pg_get_constraintdef(oid) as detail
  from pg_constraint where conname = 'calendar_days_kind_check';
