-- =====================================================================
-- Rexius core — step 1: the hub
-- ---------------------------------------------------------------------
-- Run once in the Supabase SQL editor of the PRODUCTION project
-- (fxajnoeoclnbggbkkpxn). Safe to re-run.
--
-- Then: Project Settings → Data API → Exposed schemas → add `core`
-- (the same step already done for `yard`, `dept14` and `dispatch`).
--
-- What this adds — nothing existing is touched:
--   core.apps        one row per app shown on the hub
--   core.people      one row per signed-in person (created on first hub visit)
--   core.app_access  who may open which app (when the app is not open to all)
--   core.my_hub()    what the hub page calls to get "me + my apps"
--
-- The hub only decides which TILES a person sees. Each app still enforces
-- its own data access through its own policies, exactly as it does today.
-- =====================================================================

create schema if not exists core;

create table if not exists core.apps (
  slug         text primary key check (slug ~ '^[a-z0-9-]{2,40}$'),
  name         text not null,
  description  text not null default '',
  department   text not null default '',
  -- Site-relative address, e.g. /Production/retail-yard/ . Must stay on this site.
  path         text not null check (path ~ '^/[A-Za-z0-9._/-]*$' and path !~ '//'),
  sort         int  not null default 100,
  open_to_all  boolean not null default true,   -- every signed-in person sees the tile
  active       boolean not null default true
);

create table if not exists core.people (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  is_admin    boolean not null default false,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists core.app_access (
  user_id     uuid not null references core.people(user_id) on delete cascade,
  app_slug    text not null references core.apps(slug) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references auth.users(id) on delete set null,
  primary key (user_id, app_slug)
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function core.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from core.people p where p.user_id = auth.uid() and p.is_admin);
$$;

-- "Me + the apps I can open". Also records the person on their first visit.
create or replace function core.my_hub()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  mail  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  me    core.people;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  insert into core.people (user_id, email)
  values (uid, mail)
  on conflict (user_id) do update set last_seen = now(), email = excluded.email
  returning * into me;

  return jsonb_build_object(
    'me', jsonb_build_object(
      'email', me.email, 'full_name', me.full_name, 'is_admin', me.is_admin),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', a.slug, 'name', a.name, 'description', a.description,
               'department', a.department, 'path', a.path) order by a.sort, a.name)
      from core.apps a
      where a.active
        and (a.open_to_all or me.is_admin or exists (
              select 1 from core.app_access x
              where x.user_id = uid and x.app_slug = a.slug))
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table core.apps       enable row level security;
alter table core.people     enable row level security;
alter table core.app_access enable row level security;

drop policy if exists apps_read   on core.apps;
drop policy if exists apps_admin  on core.apps;
create policy apps_read  on core.apps for select to authenticated using (true);
create policy apps_admin on core.apps for all    to authenticated
  using (core.is_admin()) with check (core.is_admin());

-- People can see their own row; only admins can see everyone or change anything.
-- (No self-update policy, so nobody can make themselves an admin.)
drop policy if exists people_read  on core.people;
drop policy if exists people_admin on core.people;
create policy people_read  on core.people for select to authenticated
  using (user_id = auth.uid() or core.is_admin());
create policy people_admin on core.people for update to authenticated
  using (core.is_admin()) with check (core.is_admin());

drop policy if exists access_read  on core.app_access;
drop policy if exists access_admin on core.app_access;
create policy access_read  on core.app_access for select to authenticated
  using (user_id = auth.uid() or core.is_admin());
create policy access_admin on core.app_access for all to authenticated
  using (core.is_admin()) with check (core.is_admin());

revoke all on schema core from anon, public;
grant usage on schema core to authenticated;
revoke all on all tables in schema core from anon, public;
grant select, insert, update, delete on core.apps, core.app_access to authenticated;
grant select, update on core.people to authenticated;
revoke all on function core.my_hub(), core.is_admin() from anon, public;
grant execute on function core.my_hub(), core.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- The four apps
-- ---------------------------------------------------------------------
insert into core.apps (slug, name, description, department, path, sort) values
  ('retail-yard',   'Retail Yard',      'Bin inventory, internal orders and backfill hauling.', 'Retail Yard',    '/Production/retail-yard/',   10),
  ('mix-board',     'Mix Board',        'Dept 14 specialty production, counts and sales.',      'Dept 14',        '/Production/dept14/',        20),
  ('bulk-dispatch', 'Bulk Dispatch',    'Bulk delivery trucks, waves and route planning.',      'Bulk Delivery',  '/Production/bulk-dispatch/', 30),
  ('blower',        'Blower Scheduler', 'Blower quotes and the truck schedule.',                'Eugene Blowers', '/EB-CRM/',                   40)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- LAST STEP — make yourself the first admin.
-- Replace the address below with your own sign-in email, then run this line.
-- ---------------------------------------------------------------------
-- insert into core.people (user_id, email, is_admin)
-- select id, lower(email), true from auth.users where lower(email) = 'you@rexius.com'
-- on conflict (user_id) do update set is_admin = true;
