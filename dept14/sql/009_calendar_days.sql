-- =====================================================================
-- Dept 14 - 009_calendar_days.sql
-- Calendar day notes and days off, one row per calendar per day:
--   kind = 'bio' (biochar production), 'dryer', 'pick' (picker), 'bag' (bagging)
--   note = what happened that day (breakdown, weather, ...)
--   off  = the day was purposely off (no red "missing" mark)
-- Managers only (RLS), and every change goes into change_log.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

create table if not exists dept14.calendar_days (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('bio','dryer','pick','bag')),
  day        date not null,
  note       text,
  off        boolean not null default false,
  updated_by uuid references auth.users(id) default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (kind, day)
);

alter table dept14.calendar_days enable row level security;
drop policy if exists logged_in_all on dept14.calendar_days;
create policy logged_in_all on dept14.calendar_days for all to authenticated using (true) with check (true);
revoke all on dept14.calendar_days from anon, public;
grant select, insert, update, delete on dept14.calendar_days to authenticated;

drop trigger if exists calendar_days_log on dept14.calendar_days;
create trigger calendar_days_log after insert or update or delete on dept14.calendar_days
  for each row execute function dept14.log_change();

commit;

-- Check: paste this back
select 'table' as what, (select to_regclass('dept14.calendar_days')::text) as detail
union all select 'rls on', (select relrowsecurity::text from pg_class where oid = 'dept14.calendar_days'::regclass)
union all select 'anon can read', has_table_privilege('anon', 'dept14.calendar_days', 'select')::text
union all select 'change log trigger', (select count(*)::text from pg_trigger where tgname = 'calendar_days_log');
