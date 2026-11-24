-- =====================================================================
-- Rexius core — step 2: the shared product catalog
-- ---------------------------------------------------------------------
-- Run once in the Supabase SQL editor of the PRODUCTION project, AFTER
-- core_001_hub.sql. Safe to re-run. Nothing in the existing apps changes:
-- this only ADDS the catalog and reads the other apps' product lists to
-- build a starting list.
--
--   core.products         one row per product, with current lbs per yard
--   core.product_weights  every weight a product has had (history)
--   core.product_apps     which products are available in which app
--   core.app_products()   what an app will call to get "my products"
--   core.apply_weights()  saves a batch of weights from an upload
--   core.merge_products() folds a duplicate into the product you keep
--
-- Everyone signed in can read the catalog. Only hub admins can change it.
-- =====================================================================

-- "EconoBark™ Mulch" and "econobark  mulch" are the same name.
create or replace function core.norm_name(t text)
returns text language sql immutable set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[™®©]', '', 'g'), '[^a-z0-9]+', ' ', 'g'));
$$;

create table if not exists core.products (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) between 1 and 160),
  erp_code           text,
  category           text not null default '',
  lbs_per_yard       numeric(7,1) check (lbs_per_yard is null or (lbs_per_yard > 0 and lbs_per_yard < 10000)),
  weight_source      text not null default '',     -- 'upload' | 'manual' | 'estimate' | ''
  weight_updated_at  timestamptz,
  weight_updated_by  uuid references auth.users(id) on delete set null,
  aliases            text[] not null default '{}', -- other names this product goes by
  notes              text not null default '',
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create unique index if not exists products_name_uq on core.products (core.norm_name(name));

create table if not exists core.product_weights (
  id            bigint generated always as identity primary key,
  product_id    uuid not null references core.products(id) on delete cascade,
  lbs_per_yard  numeric(7,1) not null,
  source        text not null default '',
  recorded_at   timestamptz not null default now(),
  recorded_by   uuid references auth.users(id) on delete set null
);
create index if not exists product_weights_product on core.product_weights (product_id, recorded_at desc);

create table if not exists core.product_apps (
  product_id  uuid not null references core.products(id) on delete cascade,
  app_slug    text not null references core.apps(slug) on delete cascade on update cascade,
  primary key (product_id, app_slug)
);

-- ---------------------------------------------------------------------
-- Weight stamping + history
-- ---------------------------------------------------------------------
create or replace function core.products_stamp_weight()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.lbs_per_yard is distinct from old.lbs_per_yard then
    if new.lbs_per_yard is not null then
      new.weight_updated_at := now();
      new.weight_updated_by := auth.uid();
    end if;
  end if;
  return new;
end $$;

create or replace function core.products_log_weight()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.lbs_per_yard is not null
     and (tg_op = 'INSERT' or new.lbs_per_yard is distinct from old.lbs_per_yard) then
    insert into core.product_weights (product_id, lbs_per_yard, source, recorded_by)
    values (new.id, new.lbs_per_yard, new.weight_source, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists products_stamp_weight on core.products;
create trigger products_stamp_weight before insert or update on core.products
  for each row execute function core.products_stamp_weight();
drop trigger if exists products_log_weight on core.products;
create trigger products_log_weight after insert or update on core.products
  for each row execute function core.products_log_weight();

-- ---------------------------------------------------------------------
-- Functions the apps call
-- ---------------------------------------------------------------------
-- The products one app is allowed to use.
create or replace function core.app_products(app text)
returns table (id uuid, name text, erp_code text, category text,
               lbs_per_yard numeric, weight_updated_at timestamptz, aliases text[])
language sql stable set search_path = ''
as $$
  select p.id, p.name, p.erp_code, p.category, p.lbs_per_yard, p.weight_updated_at, p.aliases
  from core.products p
  join core.product_apps pa on pa.product_id = p.id
  where pa.app_slug = app and p.active
  order by p.name;
$$;

-- Save a batch of weights: rows = [{"id": "<product id>", "lbs": 650}, …]
create or replace function core.apply_weights(rows jsonb, src text default 'upload')
returns int language plpgsql set search_path = ''
as $$
declare n int;
begin
  if not core.is_admin() then
    raise exception 'Only an admin can change product weights' using errcode = '42501';
  end if;
  update core.products p
     set lbs_per_yard = r.lbs, weight_source = left(coalesce(src, ''), 20)
    from jsonb_to_recordset(rows) as r(id uuid, lbs numeric)
   where p.id = r.id and r.lbs is not null and p.lbs_per_yard is distinct from r.lbs;
  get diagnostics n = row_count;
  return n;
end $$;

-- Fold a duplicate (src) into the product you keep (dst): its name becomes an
-- alias, its app assignments carry over, and dst takes its weight if it has none.
create or replace function core.merge_products(src uuid, dst uuid)
returns void language plpgsql set search_path = ''
as $$
declare s core.products;
begin
  if not core.is_admin() then
    raise exception 'Only an admin can merge products' using errcode = '42501';
  end if;
  if src = dst then raise exception 'Pick two different products'; end if;
  select * into s from core.products where id = src;
  if not found then raise exception 'Product not found'; end if;
  perform 1 from core.products where id = dst;
  if not found then raise exception 'Product not found'; end if;

  insert into core.product_apps (product_id, app_slug)
  select dst, app_slug from core.product_apps where product_id = src
  on conflict do nothing;

  update core.products d set
    aliases = (select coalesce(array_agg(distinct a), '{}') from unnest(d.aliases || s.aliases || s.name) a
               where core.norm_name(a) <> core.norm_name(d.name)),
    erp_code = coalesce(nullif(d.erp_code, ''), s.erp_code),
    category = coalesce(nullif(d.category, ''), s.category),
    lbs_per_yard = coalesce(d.lbs_per_yard, s.lbs_per_yard),
    weight_source = case when d.lbs_per_yard is null then s.weight_source else d.weight_source end
  where d.id = dst;

  delete from core.products where id = src;
end $$;

-- ---------------------------------------------------------------------
-- Row-level security: everyone signed in reads, admins write
-- ---------------------------------------------------------------------
alter table core.products        enable row level security;
alter table core.product_weights enable row level security;
alter table core.product_apps    enable row level security;

drop policy if exists products_read  on core.products;
drop policy if exists products_admin on core.products;
create policy products_read  on core.products for select to authenticated using (true);
create policy products_admin on core.products for all to authenticated
  using (core.is_admin()) with check (core.is_admin());

drop policy if exists product_weights_read on core.product_weights;
create policy product_weights_read on core.product_weights for select to authenticated using (true);

drop policy if exists product_apps_read  on core.product_apps;
drop policy if exists product_apps_admin on core.product_apps;
create policy product_apps_read  on core.product_apps for select to authenticated using (true);
create policy product_apps_admin on core.product_apps for all to authenticated
  using (core.is_admin()) with check (core.is_admin());

revoke all on core.products, core.product_weights, core.product_apps from anon, public;
grant select, insert, update, delete on core.products, core.product_apps to authenticated;
grant select on core.product_weights to authenticated;
revoke all on function core.app_products(text), core.apply_weights(jsonb, text),
              core.merge_products(uuid, uuid) from anon, public;
grant execute on function core.norm_name(text), core.app_products(text),
              core.apply_weights(jsonb, text), core.merge_products(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- The hub tile
-- ---------------------------------------------------------------------
insert into core.apps (slug, name, description, department, path, sort) values
  ('products', 'Products', 'Every product, its current weight, and which apps use it.', 'Shared', '/Production/products/', 5)
on conflict (slug) do nothing;

-- =====================================================================
-- STARTING LIST — built from what the apps already have.
-- Only runs while the catalog is empty, so re-running never duplicates
-- or undoes your clean-up. Each source is skipped quietly if its table
-- is missing or shaped differently than expected.
-- =====================================================================
do $seed$
declare
  r record;
  src record;

  -- adds a product if its name is new, then ticks the app for it
begin
  if exists (select 1 from core.products) then
    raise notice 'Catalog already has products — starting list skipped.';
    return;
  end if;

  create temp table _seed (name text, app text, erp text, category text, lbs numeric, wsrc text) on commit drop;

  -- Blower rate card (Eugene Blower Pricing 2026) — has the ERP codes.
  insert into _seed (name, app, erp, category) values
    ('Econo-Bark','blower','321','Bark'), ('BeautiBark','blower','322','Bark'), ('Hemlock','blower','020','Bark'),
    ('UltraKote','blower','040','Bark'), ('DecoBark Nuggets','blower','004','Bark'), ('Extra Fine Bark','blower','002','Bark'),
    ('Garden Mulch','blower','032','Bark'), ('Fiberex','blower','301','Bark'), ('Fresh Sawdust','blower','300','Bark'),
    ('Alder Sawdust','blower',null,'Bark'), ('Commercial Hog','blower','324','Bark'),
    ('Primary Planting Soil','blower','180','Soil & compost'), ('Tree-n-Shrub','blower','106','Soil & compost'),
    ('Flower-n-Garden','blower','100','Soil & compost'), ('Turf Start','blower','107','Soil & compost'),
    ('Patio Potting Soil','blower','105','Soil & compost'), ('Garden Compost','blower','907','Soil & compost'),
    ('GVO Compost','blower','907','Soil & compost'), ('Steer Plus','blower','121','Soil & compost'),
    ('GV Natural & Organic P.S.','blower','103','Soil & compost'), ('Opus Zero','blower','103','Soil & compost'),
    ('Opus #1','blower','103','Soil & compost'), ('Opus #2','blower','103','Soil & compost'),
    ('Opus #3','blower','103','Soil & compost'), ('Opus Bio Tope','blower','103','Soil & compost'),
    ('GVO w/Worm Castings','blower','103','Soil & compost'),
    ('3/4" round rock from RiverBend','blower',null,'Rock'), ('3/8" round rock from RiverBend','blower',null,'Rock'),
    ('Quarter Ten from RiverBend','blower',null,'Rock'), ('3/4" open quarry from Coburg Quarry','blower',null,'Rock');

  -- Bulk Dispatch's built-in list. Its weights are industry ESTIMATES.
  insert into _seed (name, app, category, lbs, wsrc) values
    ('Premium Hemlock Bark Mulch','bulk-dispatch','Bark',650,'estimate'), ('BeautiBark™ Mulch','bulk-dispatch','Bark',600,'estimate'),
    ('UltraKote™ Bark Mulch','bulk-dispatch','Bark',620,'estimate'), ('EconoBark™ Mulch','bulk-dispatch','Bark',580,'estimate'),
    ('DecoBark™ Nuggets','bulk-dispatch','Bark',550,'estimate'), ('Fiberex™ Playground Wood Chips','bulk-dispatch','Bark',500,'estimate'),
    ('Fresh Sawdust','bulk-dispatch','Bark',420,'estimate'),
    ('Organic Compost (Certified for Organic Use)','bulk-dispatch','Soil & compost',1100,'estimate'),
    ('Love Food Not Waste Compost','bulk-dispatch','Soil & compost',1100,'estimate'), ('Steer Plus™','bulk-dispatch','Soil & compost',1150,'estimate'),
    ('Flower-n-Garden™','bulk-dispatch','Soil & compost',1250,'estimate'), ('Primary Planting Soil','bulk-dispatch','Soil & compost',1300,'estimate'),
    ('Premium Turf Start™','bulk-dispatch','Soil & compost',1350,'estimate'), ('Pro-Mix™','bulk-dispatch','Soil & compost',1250,'estimate'),
    ('Opus Grows® Bio-Tope®','bulk-dispatch','Soil & compost',1000,'estimate'),
    ('Opus Grows® Mix #1 (Certified for Organic Use)','bulk-dispatch','Soil & compost',1000,'estimate'),
    ('Opus Grows® Mix #3 (Certified for Organic Use)','bulk-dispatch','Soil & compost',1000,'estimate'),
    ('Natural & Organic Potting Soil with Worm Castings (Certified for Organic Use)','bulk-dispatch','Soil & compost',900,'estimate'),
    ('3/4 in. Minus Crushed Quarry','bulk-dispatch','Rock',2900,'estimate'), ('1/4 in. Minus Crushed Quarry','bulk-dispatch','Rock',2950,'estimate'),
    ('3/4 in. Open Quarry Rock','bulk-dispatch','Rock',2700,'estimate'), ('3/8 in. Round Rock Pea Gravel','bulk-dispatch','Rock',2800,'estimate'),
    ('3/4 in. Round Rock','bulk-dispatch','Rock',2750,'estimate'), ('1 1/2 in. Round Rock','bulk-dispatch','Rock',2700,'estimate'),
    ('Garden Sand','bulk-dispatch','Rock',2400,'estimate'), ('Sandy Loam','bulk-dispatch','Rock',2200,'estimate');

  -- Live lists from the other apps' own tables. (Mix Board and Specialty are left
  -- out on purpose: their products are specific to those apps.)
  for src in select * from (values
      ('retail-yard', 'select distinct name from yard.products where name is not null')
    ) as t(app, q)
  loop
    begin
      execute format('insert into _seed (name, app) select name, %L from (%s) x', src.app, src.q);
    exception when others then
      raise notice 'Skipped % products (%).', src.app, sqlerrm;
    end;
  end loop;

  -- One catalog row per distinct name; first non-empty value wins for each field.
  for r in
    select (array_agg(name order by length(name)))[1] as name, core.norm_name(name) as k,
           (array_agg(erp) filter (where erp is not null))[1] as erp,
           coalesce((array_agg(category) filter (where category is not null))[1], '') as category,
           (array_agg(lbs) filter (where lbs is not null))[1] as lbs,
           coalesce((array_agg(wsrc) filter (where wsrc is not null))[1], '') as wsrc
    from _seed where core.norm_name(name) <> '' and length(btrim(name)) <= 160
    group by core.norm_name(name)
  loop
    insert into core.products (name, erp_code, category, lbs_per_yard, weight_source)
    values (r.name, r.erp, r.category, r.lbs, r.wsrc);
  end loop;

  insert into core.product_apps (product_id, app_slug)
  select distinct p.id, s.app
  from _seed s
  join core.products p on core.norm_name(p.name) = core.norm_name(s.name)
  join core.apps a on a.slug = s.app
  on conflict do nothing;

  raise notice 'Starting list built: % products.', (select count(*) from core.products);
end
$seed$;
