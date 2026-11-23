-- =====================================================================
-- Rexius Bulk Delivery Dispatch — production schema
-- Run once in the Supabase SQL editor of the production project.
-- Safe to re-run: every statement is idempotent.
-- =====================================================================

create schema if not exists dispatch;
grant usage on schema dispatch to authenticated;

-- --- who is allowed in -----------------------------------------------
-- Membership, not a shared password. Adding a person is one insert;
-- removing them is one delete and they are out on their next request.
create table if not exists dispatch.staff (
  email      text primary key,
  full_name  text,
  can_edit   boolean not null default true,
  added_at   timestamptz not null default now()
);

create or replace function dispatch.is_staff()
returns boolean
language sql
stable
security definer
set search_path = dispatch, public
as $$
  select exists (
    select 1 from dispatch.staff
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function dispatch.can_edit()
returns boolean
language sql
stable
security definer
set search_path = dispatch, public
as $$
  select coalesce((
    select can_edit from dispatch.staff
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ), false);
$$;

revoke all on function dispatch.is_staff() from public, anon;
revoke all on function dispatch.can_edit() from public, anon;
grant execute on function dispatch.is_staff() to authenticated;
grant execute on function dispatch.can_edit() to authenticated;

-- nobody edits the roster from the browser; it is managed here
alter table dispatch.staff enable row level security;
create policy staff_self_read on dispatch.staff
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- --- the app's own store ---------------------------------------------
-- One row per collection (orders, trucks, drivers, plans, settings…).
-- The app upserts on "collection".
create table if not exists dispatch.bulk_dispatch (
  collection  text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create or replace function dispatch.stamp_writer()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', 'unknown');
  return new;
end $$;

drop trigger if exists stamp_writer on dispatch.bulk_dispatch;
create trigger stamp_writer before insert or update on dispatch.bulk_dispatch
  for each row execute function dispatch.stamp_writer();

alter table dispatch.bulk_dispatch enable row level security;

-- the anon key alone gets nothing; only a signed-in member of staff reads
drop policy if exists dispatch_read   on dispatch.bulk_dispatch;
drop policy if exists dispatch_insert on dispatch.bulk_dispatch;
drop policy if exists dispatch_update on dispatch.bulk_dispatch;

create policy dispatch_read on dispatch.bulk_dispatch
  for select to authenticated using (dispatch.is_staff());
create policy dispatch_insert on dispatch.bulk_dispatch
  for insert to authenticated with check (dispatch.can_edit());
create policy dispatch_update on dispatch.bulk_dispatch
  for update to authenticated using (dispatch.can_edit()) with check (dispatch.can_edit());

grant select, insert, update on dispatch.bulk_dispatch to authenticated;

-- --- expose the schema to PostgREST ----------------------------------
-- Settings → API → Exposed schemas must include "dispatch", or add it here:
--   alter role authenticator set pgrst.db_schemas = 'public, storage, dispatch';
--   notify pgrst, 'reload config';

-- --- the Retail Yard link --------------------------------------------
-- The tracker owns its own table; dispatch only reads the ask and writes
-- back what happened. Point Settings → Retail yard tracker at it.
-- Replace the schema/table below with wherever the tracker actually lives.
do $$
begin
  if to_regclass('retail_yard.backfill_requests') is not null then
    alter table retail_yard.backfill_requests
      add column if not exists dispatch_status    text,
      add column if not exists scheduled_for      date,
      add column if not exists scheduled_time     text,
      add column if not exists scheduled_truck    text,
      add column if not exists delivered_at       timestamptz,
      add column if not exists dispatch_note      text,
      add column if not exists dispatch_synced_at timestamptz;
  end if;
end $$;

-- --- seed the roster --------------------------------------------------
-- Add the people who should have access. Email must match how they sign in.
insert into dispatch.staff (email, full_name, can_edit) values
  ('taylora@rexius.com', 'Taylor', true)
on conflict (email) do nothing;

-- Read-only example (sees the board, cannot change it):
--   insert into dispatch.staff (email, full_name, can_edit)
--   values ('someone@rexius.com', 'Name', false)
--   on conflict (email) do update set can_edit = excluded.can_edit;
