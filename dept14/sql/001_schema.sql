-- =====================================================================
-- Dept 14 · 001_schema.sql
-- Biochar foundation: roster, items, production runs,
-- inventory adjustments, settings, views, and the open-form RPCs.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor and Run.
-- It touches ONLY the dept14 schema. Safe to re-run: it creates things
-- if they're missing, replaces functions/views, and skips seed rows that
-- already exist.
-- After it succeeds: Settings → API → Exposed schemas → add "dept14".
-- =====================================================================
begin;

create schema if not exists dept14;

-- ---------------------------------------------------------------------
-- Access model: any user with a Supabase login on this project is a
-- Dept 14 manager (full read/write). Logins are added by hand in
-- Authentication → Users. The open forms use anon and can only call the
-- two RPCs at the bottom.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Crew roster (form pick-list)
-- ---------------------------------------------------------------------
create table if not exists dept14.employees (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Items: item code + variant.
--   kind  raw   = 14-14-CB2 unwashed bulk char (yd)
--         blend = 14-14-CC1 washed char, one row per blend (yd)
--         sock  = 14-14-SO1, one row per standard size + one "Custom" row (ea)
--         bag   = 07-86-15W 1.5cf hand-filled bags, one row per blend (ea)
-- For the Custom sock row, the actual length goes on the run line
-- (custom_size_ft), so inventory can still be split by length.
-- ---------------------------------------------------------------------
create table if not exists dept14.items (
  id         uuid primary key default gen_random_uuid(),
  line       text not null check (line in ('biochar','orchid')),
  code       text not null,
  kind       text not null check (kind in ('raw','blend','sock','bag','other')),
  name       text not null,
  blend      text,
  size_ft    numeric check (size_ft is null or size_ft > 0),
  is_custom  boolean not null default false,
  unit       text not null check (unit in ('yd','ea')),
  active     boolean not null default true,
  sort       int not null default 100,
  created_at timestamptz not null default now(),
  unique (code, name)
);

-- ---------------------------------------------------------------------
-- Production runs: one per submission.
-- status 'active' counts toward inventory immediately; the manager can
-- 'void' a bad run instead of deleting it.
-- ---------------------------------------------------------------------
create table if not exists dept14.production_runs (
  id              uuid primary key default gen_random_uuid(),
  line            text not null check (line in ('biochar','orchid')),
  job_type        text not null check (job_type in ('wash','sock','bag')),
  production_date date not null,
  hours           numeric not null check (hours > 0 and hours <= 24),
  boxes           int check (boxes is null or boxes >= 0),
  pallets         int check (pallets is null or pallets >= 0),
  order_refs      text[] not null default '{}',   -- e.g. {AECOM,"Port of Vancouver"}
  notes           text,
  source          text not null default 'form' check (source in ('form','dashboard','import')),
  status          text not null default 'active' check (status in ('active','void')),
  void_reason     text,
  import_ref      text,                            -- original Sheets tab + row for imported history
  submitted_at    timestamptz not null default now(),
  created_by      uuid references auth.users(id) default auth.uid(),
  updated_at      timestamptz not null default now()
);
create index if not exists production_runs_date_idx on dept14.production_runs (production_date);

create table if not exists dept14.run_workers (
  run_id      uuid not null references dept14.production_runs(id) on delete cascade,
  employee_id uuid not null references dept14.employees(id),
  primary key (run_id, employee_id)
);

-- Material in/out for a run.
create table if not exists dept14.run_lines (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references dept14.production_runs(id) on delete cascade,
  direction      text not null check (direction in ('in','out')),
  item_id        uuid not null references dept14.items(id),
  qty            numeric not null check (qty > 0),
  custom_size_ft numeric check (custom_size_ft is null or custom_size_ft > 0)
);
create index if not exists run_lines_run_idx on dept14.run_lines (run_id);

-- A Custom-size item must carry a length; standard items must not.
create or replace function dept14.check_custom_size() returns trigger
language plpgsql set search_path = '' as $$
declare v_custom boolean;
begin
  select is_custom into v_custom from dept14.items where id = new.item_id;
  if v_custom and new.custom_size_ft is null then
    raise exception 'Custom size needs a length in feet';
  elsif not v_custom then
    new.custom_size_ft := null;
  end if;
  return new;
end $$;
drop trigger if exists run_lines_custom_size on dept14.run_lines;
create trigger run_lines_custom_size before insert or update on dept14.run_lines
  for each row execute function dept14.check_custom_size();

-- Manager inventory corrections, physical counts, receipts and shipments.
create table if not exists dept14.inventory_adjustments (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references dept14.items(id),
  custom_size_ft numeric check (custom_size_ft is null or custom_size_ft > 0),
  qty_delta      numeric not null check (qty_delta <> 0),
  reason         text not null check (reason in ('count','received','shipped','correction','opening')),
  adj_date       date not null default current_date,
  notes          text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);

create table if not exists dept14.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function dept14.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists production_runs_touch on dept14.production_runs;
create trigger production_runs_touch before update on dept14.production_runs
  for each row execute function dept14.touch_updated_at();
drop trigger if exists settings_touch on dept14.settings;
create trigger settings_touch before update on dept14.settings
  for each row execute function dept14.touch_updated_at();

-- ---------------------------------------------------------------------
-- Seed data (skipped if already present)
-- ---------------------------------------------------------------------
insert into dept14.employees (name) values
  ('Nathaniel'),('Cameron'),('Charlie'),('Joe'),('Isaiah')
on conflict (name) do nothing;

insert into dept14.items (line, code, kind, name, blend, size_ft, is_custom, unit, sort) values
  ('biochar','14-14-CB2','raw',  'Raw biochar (bulk)', null,    null, false,'yd', 10),
  ('biochar','14-14-CC1','blend','Washed · Basic',     'Basic', null, false,'yd', 20),
  ('biochar','14-14-CC1','blend','Washed · Peat',      'Peat',  null, false,'yd', 21),
  ('biochar','14-14-CC1','blend','Washed · Zapt',      'Zapt',  null, false,'yd', 22),
  ('biochar','14-14-CC1','blend','Washed · Washed',    'Washed',null, false,'yd', 23),
  ('biochar','14-14-SO1','sock', 'Sock · 3 ft',        null,    3,    false,'ea', 30),
  ('biochar','14-14-SO1','sock', 'Sock · 6 ft',        null,    6,    false,'ea', 31),
  ('biochar','14-14-SO1','sock', 'Sock · 10 ft',       null,    10,   false,'ea', 32),
  ('biochar','14-14-SO1','sock', 'Sock · Custom',      null,    null, true, 'ea', 33),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Basic',  'Basic', null, false,'ea', 40),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Peat',   'Peat',  null, false,'ea', 41),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Special blend', 'Special', null, false,'ea', 42)
on conflict (code, name) do nothing;

insert into dept14.settings (key, value) values
  ('equipment_ratio', '{"wash":0.85,"sock":0.20,"bag":0.20}')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Views (security_invoker = the caller's permissions apply, so anon can't read them)
-- ---------------------------------------------------------------------

-- Every inventory movement: active runs (in = used, out = made) + adjustments.
create or replace view dept14.inventory_ledger with (security_invoker = true) as
  select r.production_date as on_date, 'run'::text as source, r.id as source_id,
         l.item_id, l.custom_size_ft,
         case l.direction when 'out' then l.qty else -l.qty end as qty_delta,
         r.job_type as detail
  from dept14.run_lines l
  join dept14.production_runs r on r.id = l.run_id
  where r.status = 'active'
  union all
  select a.adj_date, 'adjustment', a.id, a.item_id, a.custom_size_ft, a.qty_delta, a.reason
  from dept14.inventory_adjustments a;

create or replace view dept14.on_hand with (security_invoker = true) as
  select i.id as item_id, i.code, i.name, i.kind, i.unit, g.custom_size_ft,
         coalesce(g.qty, 0) as on_hand
  from dept14.items i
  left join (
    select item_id, custom_size_ft, sum(qty_delta) as qty
    from dept14.inventory_ledger group by item_id, custom_size_ft
  ) g on g.item_id = i.id
  where i.line = 'biochar' and i.active;

-- Month-end labor, matching the old EOM tab:
--   equipment hours = hours × ratio;  labor hours = hours − equipment hours
create or replace view dept14.month_end_labor with (security_invoker = true) as
  select date_trunc('month', r.production_date)::date as month,
         r.job_type,
         count(*)                                   as runs,
         sum(r.hours)                               as total_hours,
         round(sum(r.hours * coalesce((s.value ->> r.job_type)::numeric, 0)), 2) as equipment_hours,
         round(sum(r.hours * (1 - coalesce((s.value ->> r.job_type)::numeric, 0))), 2) as labor_hours,
         sum(coalesce(r.boxes, 0))                  as boxes,
         sum(coalesce(r.pallets, 0))                as pallets
  from dept14.production_runs r
  left join dept14.settings s on s.key = 'equipment_ratio'
  where r.status = 'active' and r.line = 'biochar'
  group by 1, 2;

create or replace view dept14.month_end_material with (security_invoker = true) as
  select date_trunc('month', r.production_date)::date as month,
         r.job_type, l.direction, i.code, i.name, l.custom_size_ft, i.unit,
         sum(l.qty) as qty
  from dept14.run_lines l
  join dept14.production_runs r on r.id = l.run_id
  join dept14.items i on i.id = l.item_id
  where r.status = 'active' and r.line = 'biochar'
  group by 1, 2, 3, 4, 5, 6, 7;

-- ---------------------------------------------------------------------
-- Open-form RPCs (the ONLY things anon can call)
-- ---------------------------------------------------------------------

-- Pick-lists for the form: active crew names + biochar items.
create or replace function dept14.form_options(p_line text default 'biochar')
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                           from dept14.employees where active), '[]'),
    'items',     coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'kind', kind,
                             'name', name, 'unit', unit, 'is_custom', is_custom) order by sort)
                           from dept14.items where active and line = p_line), '[]')
  );
$$;

-- Submit one biochar run. Payload:
-- { "production_date":"2026-11-03", "job_type":"sock", "hours":3,
--   "worker_ids":["…"], "boxes":2, "pallets":2,
--   "order_refs":["AECOM"], "notes":"…",
--   "lines":[ {"direction":"in","item_id":"…","qty":2},
--             {"direction":"out","item_id":"…","qty":36},
--             {"direction":"out","item_id":"<custom>","qty":4,"custom_size_ft":8} ] }
create or replace function dept14.submit_biochar_run(payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_run   uuid;
  v_job   text := lower(payload ->> 'job_type');
  v_date  date := (payload ->> 'production_date')::date;
  v_hours numeric := (payload ->> 'hours')::numeric;
  v_line  jsonb;
  v_kind  text;
  v_ok    text[];
  v_w     text;
  n_in int := 0; n_out int := 0;
begin
  if v_job not in ('wash','sock','bag') then raise exception 'Pick a production type'; end if;
  if v_date is null or v_date > current_date + 1 or v_date < current_date - 120 then
    raise exception 'Production date must be within the last 120 days'; end if;
  if v_hours is null or v_hours <= 0 or v_hours > 24 then raise exception 'Hours must be between 0 and 24'; end if;
  if jsonb_array_length(coalesce(payload -> 'worker_ids', '[]')) = 0 then
    raise exception 'Pick at least one employee'; end if;

  insert into dept14.production_runs (line, job_type, production_date, hours, boxes, pallets,
                                      order_refs, notes, source, created_by)
  values ('biochar', v_job, v_date, v_hours,
          nullif(payload ->> 'boxes','')::int, nullif(payload ->> 'pallets','')::int,
          coalesce(array(select trim(x) from jsonb_array_elements_text(coalesce(payload -> 'order_refs','[]')) x
                         where trim(x) <> ''), '{}'),
          nullif(trim(payload ->> 'notes'), ''), 'form', auth.uid())
  returning id into v_run;

  for v_w in select jsonb_array_elements_text(payload -> 'worker_ids') loop
    if not exists (select 1 from dept14.employees where id = v_w::uuid and active) then
      raise exception 'Unknown employee'; end if;
    insert into dept14.run_workers (run_id, employee_id) values (v_run, v_w::uuid) on conflict do nothing;
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(payload -> 'lines', '[]')) loop
    select kind into v_kind from dept14.items
      where id = (v_line ->> 'item_id')::uuid and line = 'biochar' and active;
    if v_kind is null then raise exception 'Unknown product'; end if;

    -- which kinds are allowed in/out for each job
    v_ok := case
      when v_job = 'wash' and v_line ->> 'direction' = 'in'  then array['raw']
      when v_job = 'wash' and v_line ->> 'direction' = 'out' then array['blend']
      when v_job in ('sock','bag') and v_line ->> 'direction' = 'in' then array['blend']
      when v_job = 'sock' and v_line ->> 'direction' = 'out' then array['sock']
      when v_job = 'bag'  and v_line ->> 'direction' = 'out' then array['bag']
    end;
    if v_ok is null or not (v_kind = any(v_ok)) then
      raise exception 'That product doesn''t belong on a % job', v_job; end if;

    insert into dept14.run_lines (run_id, direction, item_id, qty, custom_size_ft)
    values (v_run, v_line ->> 'direction', (v_line ->> 'item_id')::uuid,
            (v_line ->> 'qty')::numeric, nullif(v_line ->> 'custom_size_ft','')::numeric);
    if v_line ->> 'direction' = 'in' then n_in := n_in + 1; else n_out := n_out + 1; end if;
  end loop;

  if n_out = 0 then raise exception 'Enter what was made'; end if;
  if n_in = 0 then raise exception 'Enter what material was used'; end if;
  return v_run;
end $$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
grant usage on schema dept14 to anon, authenticated;

revoke all on all tables in schema dept14 from anon, public;
grant select, insert, update, delete on all tables in schema dept14 to authenticated;

revoke all on all functions in schema dept14 from public, anon;
grant execute on function dept14.form_options(text)        to anon, authenticated;
grant execute on function dept14.submit_biochar_run(jsonb) to anon, authenticated;
-- Row-level security: logged-in users get full access; anon gets nothing.
do $$
declare t text;
begin
  foreach t in array array['employees','items','production_runs','run_workers','run_lines',
                           'inventory_adjustments','settings'] loop
    execute format('alter table dept14.%I enable row level security', t);
    execute format('drop policy if exists logged_in_all on dept14.%I', t);
    execute format('create policy logged_in_all on dept14.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------
-- Verification: paste this result back
-- ---------------------------------------------------------------------
select 'tables' as what, string_agg(table_name, ', ' order by table_name) as detail
  from information_schema.tables where table_schema = 'dept14' and table_type = 'BASE TABLE'
union all
select 'views', string_agg(table_name, ', ' order by table_name)
  from information_schema.views where table_schema = 'dept14'
union all
select 'employees', (select count(*)::text from dept14.employees)
union all
select 'items', (select count(*)::text from dept14.items)
union all
select 'rls_off', coalesce(string_agg(relname, ', '), 'none')
  from pg_class where relnamespace = 'dept14'::regnamespace and relkind = 'r' and not relrowsecurity;
