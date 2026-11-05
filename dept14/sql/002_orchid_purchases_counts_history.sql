-- =====================================================================
-- Dept 14 · 002_orchid_purchases_counts_history.sql
-- Everything the dashboard prototype does that 001 doesn't store yet:
--   • Biochar: Revd + custom blends/bags, toted raw char, blank white
--     totes, live inventory counts, crew sheet checkboxes
--   • Orchid bark: bins (incl. ones the manager adds), dryer runs,
--     picker production, bagging production, sales orders
--   • Purchased material for both departments
--   • Saved reports, suggestions
--   • Change log (every insert/update/delete, written by the database)
--     for shared undo / redo / version history
--   • On-hand views for both lines, the dryer crew sheet RPC
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor and Run.
-- Run 001 first. Touches ONLY the dept14 schema (plus reading auth.uid()
-- / auth.jwt()). Safe to re-run.
-- When it finishes, paste the result of the check query at the bottom.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Biochar catalog changes
-- ---------------------------------------------------------------------
-- Units: toted raw char is counted in totes.
alter table dept14.items drop constraint if exists items_unit_check;
alter table dept14.items add constraint items_unit_check check (unit in ('yd','ea','totes'));

-- Custom blends / custom bags carry a typed name on the line (custom_name),
-- the same way custom socks carry a length (custom_size_ft).
alter table dept14.run_lines add column if not exists custom_name text;

insert into dept14.items (line, code, kind, name, blend, size_ft, is_custom, unit, sort) values
  ('biochar','14-14-CB2','raw',  'Raw biochar (toted)',  null,    null, false,'totes', 11),
  ('biochar','MAT',      'other','Blank white totes',    null,    null, false,'ea',    15),
  ('biochar','14-14-CC1','blend','Washed · Revd',        'Revd',  null, false,'yd',    24),
  ('biochar','14-14-CC1','blend','Washed · Custom',      null,    null, true, 'yd',    29),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Zapt',     'Zapt',  null, false,'ea',    43),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Washed',   'Washed',null, false,'ea',    44),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Revd',     'Revd',  null, false,'ea',    45),
  ('biochar','07-86-15W','bag',  '1.5cf bag · Custom',   null,    null, true, 'ea',    49)
on conflict (code, name) do nothing;

-- Blend order on screens: Basic · Washed · Peat · Zapt · Revd
update dept14.items set sort = 20 where code = '14-14-CC1' and blend = 'Basic';
update dept14.items set sort = 21 where code = '14-14-CC1' and blend = 'Washed';
update dept14.items set sort = 22 where code = '14-14-CC1' and blend = 'Peat';
update dept14.items set sort = 23 where code = '14-14-CC1' and blend = 'Zapt';
update dept14.items set sort = 40 where code = '07-86-15W' and blend = 'Basic';
update dept14.items set sort = 41 where code = '07-86-15W' and blend = 'Peat';
-- A bag is always the char it was filled with, so "Special blend" bags are retired.
update dept14.items set active = false where code = '07-86-15W' and blend = 'Special';

-- Custom items need their detail: socks a length, blends/bags a name.
create or replace function dept14.check_custom_size() returns trigger
language plpgsql set search_path = '' as $$
declare v_custom boolean; v_kind text;
begin
  select is_custom, kind into v_custom, v_kind from dept14.items where id = new.item_id;
  new.custom_name := nullif(trim(new.custom_name), '');
  if not v_custom then
    new.custom_size_ft := null; new.custom_name := null;
  elsif v_kind = 'sock' then
    if new.custom_size_ft is null then raise exception 'Custom size needs a length in feet'; end if;
    new.custom_name := null;
  else
    if new.custom_name is null then raise exception 'Custom blend needs a name'; end if;
    new.custom_size_ft := null;
  end if;
  return new;
end $$;

-- Crew sheet checkboxes (Settings → Crew)
alter table dept14.employees add column if not exists on_biochar_sheet boolean not null default true;
alter table dept14.employees add column if not exists on_dryer_sheet   boolean not null default false;
update dept14.employees set on_dryer_sheet = true
  where name in ('Charlie','Joe','Isaiah') and not on_dryer_sheet
    and not exists (select 1 from dept14.employees where on_dryer_sheet);

-- ---------------------------------------------------------------------
-- 2. Orchid bark: bins
--   kind green    = goes into the dryer (yd)
--        dried    = comes out of the dryer into a bin (yd)
--        bagged   = bagged pallets
--        totes    = dried product in totes
--        material = picker input that isn't kept as a bin (Jumbo Orchid)
--   is_core = the workbook's bins (can't be deleted); manager-added bins have is_core = false.
-- ---------------------------------------------------------------------
create table if not exists dept14.bins (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  kind         text not null check (kind in ('green','dried','bagged','totes','material')),
  unit         text not null check (unit in ('yd','pallets','totes')),
  note         text,
  on_map       boolean not null default true,    -- shows on the bin map
  dryer_input  boolean not null default false,   -- on the dryer sheet product list
  picker_input boolean not null default false,   -- can go into the picker
  purchasable  boolean not null default false,   -- on the Purchased material list
  totes_to     text references dept14.bins(name) on update cascade,  -- dried in totes lands here
  bags_to      text references dept14.bins(name) on update cascade,  -- bagged from this bin lands here
  is_core      boolean not null default false,
  active       boolean not null default true,
  sort         int not null default 500,
  created_at   timestamptz not null default now()
);

insert into dept14.bins (name, kind, unit, sort, is_core) values
  ('Small bagged',  'bagged','pallets', 300, true),
  ('Medium bagged', 'bagged','pallets', 310, true),
  ('Small totes',   'totes', 'totes',   320, true),
  ('Medium totes',  'totes', 'totes',   330, true)
on conflict (name) do nothing;

insert into dept14.bins (name, kind, unit, sort, is_core, bags_to) values
  ('Small Dried',    'dried','yd', 200, true, 'Small bagged'),
  ('#2 Medium Dried','dried','yd', 210, true, 'Medium bagged'),
  ('#1 Medium Dried','dried','yd', 220, true, 'Medium bagged')
on conflict (name) do nothing;

insert into dept14.bins (name, kind, unit, note, sort, is_core, dryer_input, picker_input, purchasable, totes_to, on_map) values
  ('#1 Medium Green', 'green','yd','Turns into #1 Medium Dried',                       100, true, true, true,  true, 'Medium totes', true),
  ('#1 Small Green',  'green','yd','Turns into Small Dried',                           110, true, true, false, true, 'Small totes',  true),
  ('XS Idaho Green',  'green','yd','Purchased',                                        130, true, true, false, true, 'Small totes',  true),
  ('PAC Fibre Large', 'green','yd','Turns into #2 Medium Dried',                       140, true, true, false, true, 'Medium totes', true),
  ('PAC Fibre Medium','green','yd','Turns into “#2 Small Dried Toted” immediately',    150, true, true, false, true, 'Small totes',  true),
  ('Cypress Mulch',   'green','yd',null,                                               160, true, true, false, true, 'Medium totes', true),
  ('Jumbo Orchid',    'material','yd',null,                                            90,  true, true, true,  false,'Medium totes', false)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 3. Orchid bark: production and sales
-- ---------------------------------------------------------------------
create table if not exists dept14.dryer_runs (
  id              uuid primary key default gen_random_uuid(),
  production_date date not null,
  product_bin_id  uuid not null references dept14.bins(id),
  yards_in        numeric not null check (yards_in > 0),
  yards_out       numeric not null check (yards_out >= 0),
  hours           numeric not null check (hours > 0 and hours <= 24),
  destination     text not null check (destination in ('totes','bin')),
  bin_id          uuid references dept14.bins(id),          -- the dried bin, when destination = 'bin'
  totes           numeric check (totes is null or totes >= 0), -- totes made, when destination = 'totes'
  notes           text,
  source          text not null default 'form' check (source in ('form','dashboard','import')),
  status          text not null default 'active' check (status in ('active','void')),
  void_reason     text,
  import_ref      text,
  submitted_at    timestamptz not null default now(),
  created_by      uuid references auth.users(id) default auth.uid(),
  updated_at      timestamptz not null default now(),
  check (yards_out <= yards_in),
  check ((destination = 'bin' and bin_id is not null) or (destination = 'totes' and bin_id is null))
);
create index if not exists dryer_runs_date_idx on dept14.dryer_runs (production_date);

create table if not exists dept14.dryer_run_workers (
  run_id      uuid not null references dept14.dryer_runs(id) on delete cascade,
  employee_id uuid not null references dept14.employees(id),
  primary key (run_id, employee_id)
);

-- Picker production: units (loader buckets) of Jumbo Orchid or #1 Medium Green into the picker.
-- Yards and the small / medium / lost split are worked out from Settings (key 'orchid').
create table if not exists dept14.picker_runs (
  id              uuid primary key default gen_random_uuid(),
  production_date date not null,
  material_bin_id uuid not null references dept14.bins(id),
  units           numeric not null check (units > 0),
  hours           numeric not null default 0 check (hours >= 0 and hours <= 24),
  notes           text,
  source          text not null default 'dashboard' check (source in ('form','dashboard','import')),
  import_ref      text,
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists picker_runs_date_idx on dept14.picker_runs (production_date);

-- Bagging production: dried bin yards become bagged pallets.
create table if not exists dept14.bagging_runs (
  id              uuid primary key default gen_random_uuid(),
  production_date date not null,
  from_bin_id     uuid not null references dept14.bins(id),
  yards_used      numeric not null check (yards_used > 0),
  pallets         numeric not null check (pallets > 0),
  hours           numeric not null default 0 check (hours >= 0 and hours <= 24),
  notes           text,
  source          text not null default 'dashboard' check (source in ('form','dashboard','import')),
  import_ref      text,
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists bagging_runs_date_idx on dept14.bagging_runs (production_date);

-- Sales orders. Only completed orders take product out of inventory.
create table if not exists dept14.sales_orders (
  id             uuid primary key default gen_random_uuid(),
  order_date     date not null,
  customer       text not null,
  sales_order_no text,
  load_type      text not null check (load_type in ('BULK','BAGS','TOTES')),
  bin_id         uuid not null references dept14.bins(id),
  qty            numeric not null check (qty > 0),
  completed      boolean not null default false,
  completed_at   timestamptz,
  notes          text,
  import_ref     text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists sales_orders_date_idx on dept14.sales_orders (order_date);

create or replace function dept14.stamp_completed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.completed and (tg_op = 'INSERT' or not old.completed) then new.completed_at := now();
  elsif not new.completed then new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists sales_orders_completed on dept14.sales_orders;
create trigger sales_orders_completed before insert or update on dept14.sales_orders
  for each row execute function dept14.stamp_completed();

-- ---------------------------------------------------------------------
-- 4. Purchased material (both departments)
--   Biochar purchases point at an item (raw char bulk / toted);
--   orchid purchases point at a bin.
-- ---------------------------------------------------------------------
create table if not exists dept14.purchases (
  id            uuid primary key default gen_random_uuid(),
  purchase_date date not null default current_date,
  line          text not null check (line in ('biochar','orchid')),
  item_id       uuid references dept14.items(id),
  bin_id        uuid references dept14.bins(id),
  amount        numeric not null check (amount > 0),
  po            text,
  notes         text,
  import_ref    text,
  created_by    uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((line = 'biochar' and item_id is not null and bin_id is null)
      or (line = 'orchid'  and bin_id  is not null and item_id is null))
);
create index if not exists purchases_date_idx on dept14.purchases (purchase_date);

-- ---------------------------------------------------------------------
-- 5. Inventory counts and adjustments for both lines
--   A count sets the number; movements dated on or before the count date
--   are replaced by it, later ones move it from there.
-- ---------------------------------------------------------------------
create table if not exists dept14.inventory_counts (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid references dept14.items(id),
  bin_id         uuid references dept14.bins(id),
  custom_size_ft numeric,
  custom_name    text,
  qty            numeric not null check (qty >= 0),
  counted_on     date not null default current_date,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check (num_nonnulls(item_id, bin_id) = 1)
);
create index if not exists inventory_counts_item_idx on dept14.inventory_counts (item_id, counted_on);
create index if not exists inventory_counts_bin_idx  on dept14.inventory_counts (bin_id, counted_on);

alter table dept14.inventory_adjustments add column if not exists bin_id uuid references dept14.bins(id);
alter table dept14.inventory_adjustments add column if not exists custom_name text;
alter table dept14.inventory_adjustments alter column item_id drop not null;
alter table dept14.inventory_adjustments drop constraint if exists inventory_adjustments_one_target;
alter table dept14.inventory_adjustments add constraint inventory_adjustments_one_target
  check (num_nonnulls(item_id, bin_id) = 1);

-- ---------------------------------------------------------------------
-- 6. Saved reports and suggestions
-- ---------------------------------------------------------------------
create table if not exists dept14.saved_reports (
  id         uuid primary key default gen_random_uuid(),
  line       text not null check (line in ('biochar','orchid')),
  name       text not null,
  config     jsonb not null,               -- the report builder settings
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists dept14.suggestions (
  id         uuid primary key default gen_random_uuid(),
  body       text not null check (length(trim(body)) > 0 and length(body) <= 2000),
  created_by uuid references auth.users(id) default auth.uid(),
  created_by_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 7. Settings
-- ---------------------------------------------------------------------
insert into dept14.settings (key, value) values
  ('orchid', '{"yards_per_unit":7.5,"ratios":{"Jumbo Orchid":{"small":60,"medium":30,"lost":10},"#1 Medium Green":{"small":75,"medium":15,"lost":10}}}'),
  ('bonus',  '{"per_yard_in":0.5,"per_tote":0.5,"yards_per_tote":2.5}')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 8. Change log: one row per insert / update / delete on Dept 14 tables,
--    written by the database. Rows from one save share a txid, so the
--    dashboard can undo/redo a whole save and show version history.
--    Managers can read it; nobody can edit it.
-- ---------------------------------------------------------------------
create table if not exists dept14.change_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  txid       bigint not null default txid_current(),
  by_user    uuid default auth.uid(),
  by_email   text default (auth.jwt() ->> 'email'),
  table_name text not null,
  action     text not null check (action in ('insert','update','delete')),
  row_id     text,
  old_row    jsonb,
  new_row    jsonb
);
create index if not exists change_log_at_idx   on dept14.change_log (at desc);
create index if not exists change_log_txid_idx on dept14.change_log (txid);

create or replace function dept14.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_new jsonb; v_row jsonb;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then return null; end if;
  v_row := coalesce(v_new, v_old);
  insert into dept14.change_log (table_name, action, row_id, old_row, new_row)
  values (tg_table_name, lower(tg_op), coalesce(v_row ->> 'id', v_row ->> 'key', v_row ->> 'run_id'), v_old, v_new);
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 9. Triggers on the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- keep updated_at fresh
  foreach t in array array['dryer_runs','picker_runs','bagging_runs','sales_orders','purchases','saved_reports'] loop
    execute format('drop trigger if exists %I on dept14.%I', t || '_touch', t);
    execute format('create trigger %I before update on dept14.%I for each row execute function dept14.touch_updated_at()', t || '_touch', t);
  end loop;
  -- change log on every table that holds department data
  foreach t in array array['employees','items','production_runs','run_workers','run_lines','inventory_adjustments',
                           'inventory_counts','settings','bins','dryer_runs','dryer_run_workers','picker_runs',
                           'bagging_runs','sales_orders','purchases','saved_reports'] loop
    execute format('drop trigger if exists %I on dept14.%I', t || '_log', t);
    execute format('create trigger %I after insert or update or delete on dept14.%I for each row execute function dept14.log_change()', t || '_log', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 10. Views (security_invoker: the caller's permissions apply, so anon can't read them)
-- ---------------------------------------------------------------------
drop view if exists dept14.on_hand;
drop view if exists dept14.inventory_ledger;

-- Biochar movements: active runs (in = used, out = made), adjustments, purchases.
create view dept14.inventory_ledger with (security_invoker = true) as
  select r.production_date as on_date, 'run'::text as source, r.id as source_id,
         l.item_id, l.custom_size_ft, l.custom_name,
         case l.direction when 'out' then l.qty else -l.qty end as qty_delta,
         r.job_type as detail
  from dept14.run_lines l
  join dept14.production_runs r on r.id = l.run_id
  where r.status = 'active'
  union all
  select a.adj_date, 'adjustment', a.id, a.item_id, a.custom_size_ft, a.custom_name, a.qty_delta, a.reason
  from dept14.inventory_adjustments a where a.item_id is not null
  union all
  select p.purchase_date, 'purchase', p.id, p.item_id, null::numeric, null::text, p.amount, coalesce('PO ' || p.po, 'purchased')
  from dept14.purchases p where p.item_id is not null;

-- Biochar on hand: last count + every movement after the count date.
create view dept14.on_hand with (security_invoker = true) as
  with keys as (
    select item_id, custom_size_ft, custom_name from dept14.inventory_ledger
    union
    select item_id, custom_size_ft, custom_name from dept14.inventory_counts where item_id is not null
    union
    select id, null::numeric, null::text from dept14.items where line = 'biochar' and active and not is_custom
  ),
  last_count as (
    select distinct on (item_id, custom_size_ft, custom_name) item_id, custom_size_ft, custom_name, qty, counted_on
    from dept14.inventory_counts where item_id is not null
    order by item_id, custom_size_ft, custom_name, counted_on desc, created_at desc
  )
  select k.item_id, i.code, i.name, i.kind, i.unit, i.blend, k.custom_size_ft, k.custom_name, i.active,
         c.counted_on as last_counted_on,
         coalesce(c.qty, 0) + coalesce((
           select sum(l.qty_delta) from dept14.inventory_ledger l
           where l.item_id = k.item_id
             and l.custom_size_ft is not distinct from k.custom_size_ft
             and l.custom_name is not distinct from k.custom_name
             and (c.counted_on is null or l.on_date > c.counted_on)), 0) as on_hand
  from keys k
  join dept14.items i on i.id = k.item_id
  left join last_count c on c.item_id = k.item_id
    and c.custom_size_ft is not distinct from k.custom_size_ft
    and c.custom_name is not distinct from k.custom_name
  where i.line = 'biochar';

-- Picker production with yards and the estimated split.
create or replace view dept14.picker_estimates with (security_invoker = true) as
  with s as (select coalesce((value ->> 'yards_per_unit')::numeric, 7.5) as ypu, value -> 'ratios' as ratios
             from dept14.settings where key = 'orchid')
  select p.id, p.production_date, m.name as material, p.units, p.hours, p.notes,
         p.units * coalesce(s.ypu, 7.5) as yards,
         p.units * coalesce(s.ypu, 7.5) * coalesce((s.ratios -> m.name ->> 'small')::numeric, 0)  / 100 as small_green,
         p.units * coalesce(s.ypu, 7.5) * coalesce((s.ratios -> m.name ->> 'medium')::numeric, 0) / 100 as medium_green,
         p.units * coalesce(s.ypu, 7.5) * coalesce((s.ratios -> m.name ->> 'lost')::numeric, 0)   / 100 as lost
  from dept14.picker_runs p
  join dept14.bins m on m.id = p.material_bin_id
  left join s on true;

-- Orchid movements, bin by bin.
create or replace view dept14.orchid_ledger with (security_invoker = true) as
  -- picker: estimated small and medium green in; #1 Medium Green run through the picker comes out first
  select e.production_date as on_date, 'picker'::text as source, e.id as source_id,
         (select id from dept14.bins where name = '#1 Small Green') as bin_id, e.small_green as qty_delta, 'small green (est.)'::text as detail
  from dept14.picker_estimates e where e.small_green <> 0
  union all
  select e.production_date, 'picker', e.id, (select id from dept14.bins where name = '#1 Medium Green'), e.medium_green, 'medium green (est.)'
  from dept14.picker_estimates e where e.medium_green <> 0
  union all
  select e.production_date, 'picker', e.id, (select id from dept14.bins where name = '#1 Medium Green'), -e.yards, 'run through the picker'
  from dept14.picker_estimates e where e.material = '#1 Medium Green'
  union all
  -- purchases
  select p.purchase_date, 'purchase', p.id, p.bin_id, p.amount, coalesce('PO ' || p.po, 'purchased')
  from dept14.purchases p where p.bin_id is not null
  union all
  -- dryer: product out, dried into a bin or totes
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
  -- bagging: bin yards out, pallets in
  select b.production_date, 'bagging', b.id, b.from_bin_id, -b.yards_used, 'bagged'
  from dept14.bagging_runs b
  union all
  select b.production_date, 'bagging', b.id, t.id, b.pallets, 'pallets bagged'
  from dept14.bagging_runs b
  join dept14.bins f on f.id = b.from_bin_id
  join dept14.bins t on t.name = f.bags_to
  union all
  -- completed sales
  select s.order_date, 'sale', s.id, s.bin_id, -s.qty, s.customer
  from dept14.sales_orders s where s.completed
  union all
  -- manager adjustments
  select a.adj_date, 'adjustment', a.id, a.bin_id, a.qty_delta, a.reason
  from dept14.inventory_adjustments a where a.bin_id is not null;

-- Orchid on hand: last count + every movement after the count date, plus open orders.
create or replace view dept14.orchid_on_hand with (security_invoker = true) as
  with last_count as (
    select distinct on (bin_id) bin_id, qty, counted_on
    from dept14.inventory_counts where bin_id is not null
    order by bin_id, counted_on desc, created_at desc
  ),
  open_orders as (
    select bin_id, sum(qty) as qty from dept14.sales_orders where not completed group by bin_id
  )
  select b.id as bin_id, b.name, b.kind, b.unit, b.note, b.sort, b.on_map, b.is_core, b.active,
         c.counted_on as last_counted_on,
         coalesce(c.qty, 0) + coalesce((
           select sum(l.qty_delta) from dept14.orchid_ledger l
           where l.bin_id = b.id and (c.counted_on is null or l.on_date > c.counted_on)), 0) as on_hand,
         coalesce(o.qty, 0) as on_open_orders
  from dept14.bins b
  left join last_count c on c.bin_id = b.id
  left join open_orders o on o.bin_id = b.id;

-- ---------------------------------------------------------------------
-- 11. Open-form RPCs (the ONLY things anon can call)
-- ---------------------------------------------------------------------

-- Pick-lists for a crew sheet.
--   biochar: crew on the biochar sheet + biochar items
--   orchid:  crew on the dryer sheet + products into the dryer + dried bins
create or replace function dept14.form_options(p_line text default 'biochar')
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_line = 'orchid' then jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                           from dept14.employees where active and on_dryer_sheet), '[]'),
    'products',  coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort)
                           from dept14.bins where active and dryer_input), '[]'),
    'bins',      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort)
                           from dept14.bins where active and kind = 'dried'), '[]'))
  else jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                           from dept14.employees where active and on_biochar_sheet), '[]'),
    'items',     coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'kind', kind, 'blend', blend,
                             'name', name, 'unit', unit, 'is_custom', is_custom) order by sort)
                           from dept14.items where active and line = 'biochar'), '[]'))
  end;
$$;

-- Submit one biochar run (same payload as 001, plus custom_name on custom blend/bag lines).
-- Wash jobs may also list blank white totes used (kind 'other') as an "in" line.
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
  if v_job is null or v_job not in ('wash','sock','bag') then raise exception 'Pick a production type'; end if;
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
    v_kind := null;
    select kind into v_kind from dept14.items
      where id = (v_line ->> 'item_id')::uuid and line = 'biochar' and active;
    if v_kind is null then raise exception 'Unknown product'; end if;
    if coalesce((v_line ->> 'qty')::numeric, 0) <= 0 then raise exception 'Quantities must be more than 0'; end if;

    v_ok := case
      when v_job = 'wash' and v_line ->> 'direction' = 'in'  then array['raw','other']
      when v_job = 'wash' and v_line ->> 'direction' = 'out' then array['blend']
      when v_job in ('sock','bag') and v_line ->> 'direction' = 'in' then array['blend']
      when v_job = 'sock' and v_line ->> 'direction' = 'out' then array['sock']
      when v_job = 'bag'  and v_line ->> 'direction' = 'out' then array['bag']
    end;
    if v_ok is null or not (v_kind = any(v_ok)) then
      raise exception 'That product doesn''t belong on a % job', v_job; end if;

    insert into dept14.run_lines (run_id, direction, item_id, qty, custom_size_ft, custom_name)
    values (v_run, v_line ->> 'direction', (v_line ->> 'item_id')::uuid,
            (v_line ->> 'qty')::numeric, nullif(v_line ->> 'custom_size_ft','')::numeric,
            nullif(trim(v_line ->> 'custom_name'), ''));
    if v_kind <> 'other' then
      if v_line ->> 'direction' = 'in' then n_in := n_in + 1; else n_out := n_out + 1; end if;
    end if;
  end loop;

  if n_out = 0 then raise exception 'Enter what was made'; end if;
  if n_in = 0 then raise exception 'Enter what material was used'; end if;
  return v_run;
end $$;

-- Submit one dryer run. Payload:
-- { "production_date":"2026-11-04", "worker_ids":["…"], "product_id":"<bin id>",
--   "yards_in":15, "yards_out":12, "hours":4, "destination":"totes"|"bin",
--   "bin_id":"<dried bin id, when destination = bin>", "totes":5.33, "notes":"…" }
create or replace function dept14.submit_dryer_run(payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_run   uuid;
  v_date  date    := (payload ->> 'production_date')::date;
  v_in    numeric := (payload ->> 'yards_in')::numeric;
  v_out   numeric := (payload ->> 'yards_out')::numeric;
  v_hours numeric := (payload ->> 'hours')::numeric;
  v_dest  text    := lower(payload ->> 'destination');
  v_prod  uuid    := nullif(payload ->> 'product_id','')::uuid;
  v_bin   uuid    := nullif(payload ->> 'bin_id','')::uuid;
  v_totes numeric := nullif(payload ->> 'totes','')::numeric;
  v_w     text;
begin
  if v_date is null or v_date > current_date + 1 or v_date < current_date - 120 then
    raise exception 'Production date must be within the last 120 days'; end if;
  if jsonb_array_length(coalesce(payload -> 'worker_ids', '[]')) = 0 then
    raise exception 'Pick at least one person'; end if;
  if v_prod is null or not exists (select 1 from dept14.bins where id = v_prod and active and dryer_input) then
    raise exception 'Pick what went into the dryer'; end if;
  if v_in is null or v_in <= 0 then raise exception 'Enter the yards that went in'; end if;
  if v_out is null or v_out < 0 then raise exception 'Enter the yards that came out'; end if;
  if v_out > v_in then raise exception 'Yards out can''t be more than yards in'; end if;
  if v_hours is null or v_hours <= 0 or v_hours > 24 then raise exception 'Hours must be between 0 and 24'; end if;
  if v_dest not in ('totes','bin') then raise exception 'Pick totes or bin'; end if;
  if v_dest = 'bin' then
    if v_bin is null or not exists (select 1 from dept14.bins where id = v_bin and active and kind = 'dried') then
      raise exception 'Pick which bin it went to'; end if;
    v_totes := null;
  else
    if v_totes is null or v_totes < 0 then raise exception 'Enter how many totes were made'; end if;
    v_bin := null;
  end if;

  insert into dept14.dryer_runs (production_date, product_bin_id, yards_in, yards_out, hours,
                                 destination, bin_id, totes, notes, source, created_by)
  values (v_date, v_prod, v_in, v_out, v_hours, v_dest, v_bin, v_totes,
          nullif(trim(payload ->> 'notes'), ''), 'form', auth.uid())
  returning id into v_run;

  for v_w in select jsonb_array_elements_text(payload -> 'worker_ids') loop
    if not exists (select 1 from dept14.employees where id = v_w::uuid and active) then
      raise exception 'Unknown crew member'; end if;
    insert into dept14.dryer_run_workers (run_id, employee_id) values (v_run, v_w::uuid) on conflict do nothing;
  end loop;
  return v_run;
end $$;

-- ---------------------------------------------------------------------
-- 12. Permissions and row-level security
-- ---------------------------------------------------------------------
grant usage on schema dept14 to anon, authenticated;

revoke all on all tables in schema dept14 from anon, public;
grant select, insert, update, delete on all tables in schema dept14 to authenticated;
revoke insert, update, delete, truncate on dept14.change_log from authenticated;
grant usage, select on all sequences in schema dept14 to authenticated;

revoke all on all functions in schema dept14 from public, anon;
grant execute on function dept14.form_options(text)        to anon, authenticated;
grant execute on function dept14.submit_biochar_run(jsonb) to anon, authenticated;
grant execute on function dept14.submit_dryer_run(jsonb)   to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['bins','dryer_runs','dryer_run_workers','picker_runs','bagging_runs','sales_orders',
                           'purchases','inventory_counts','saved_reports','suggestions'] loop
    execute format('alter table dept14.%I enable row level security', t);
    execute format('drop policy if exists logged_in_all on dept14.%I', t);
    execute format('create policy logged_in_all on dept14.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

alter table dept14.change_log enable row level security;
drop policy if exists logged_in_read on dept14.change_log;
create policy logged_in_read on dept14.change_log for select to authenticated using (true);

commit;

-- ---------------------------------------------------------------------
-- Check: paste this result back
-- ---------------------------------------------------------------------
select 'tables' as what, string_agg(table_name, ', ' order by table_name) as detail
  from information_schema.tables where table_schema = 'dept14' and table_type = 'BASE TABLE'
union all
select 'views', string_agg(table_name, ', ' order by table_name)
  from information_schema.views where table_schema = 'dept14'
union all
select 'functions', string_agg(routine_name, ', ' order by routine_name)
  from information_schema.routines where routine_schema = 'dept14'
union all
select 'items (active)', (select count(*)::text from dept14.items where active)
union all
select 'bins', (select string_agg(name, ', ' order by sort) from dept14.bins)
union all
select 'dryer crew', (select string_agg(name, ', ' order by name) from dept14.employees where on_dryer_sheet)
union all
select 'settings', (select string_agg(key, ', ' order by key) from dept14.settings)
union all
select 'change-log triggers', (select count(*)::text from pg_trigger where not tgisinternal and tgname like '%\_log' and tgrelid::regclass::text like 'dept14.%')
union all
select 'rls_off', coalesce((select string_agg(relname, ', ') from pg_class
  where relnamespace = 'dept14'::regnamespace and relkind = 'r' and not relrowsecurity), 'none')
union all
select 'anon can run', (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
  where p.pronamespace = 'dept14'::regnamespace and has_function_privilege('anon', p.oid, 'execute'));
