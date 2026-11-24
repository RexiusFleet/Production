-- =====================================================================
-- Retail Yard -> Bulk Dispatch feed  (already applied to the Production
-- project on 2026-11-24 as migration "yard_dispatch_feed_views"; kept
-- here as the record. Safe to re-run.)
-- ---------------------------------------------------------------------
-- Two read-only views. They add nothing to Retail Yard's tables and
-- change no data. security_invoker = the reader's own Retail Yard
-- permissions apply, so an account with no Retail Yard role sees nothing.
--
--   yard.dispatch_requests  bulk backfill requests, with product name,
--                           every name the shared catalog knows it by,
--                           bin code, bin room, and the hauls booked
--   yard.dispatch_bins      retail bins with capacity and current level
--
-- Bulk Dispatch writes back by inserting rows in yard.hauls (one per
-- trip) under Retail Yard's existing rules for the "hauling" role.
-- =====================================================================

create or replace view yard.dispatch_requests
with (security_invoker = true) as
select
  r.id, r.created_at, r.status, r.priority, r.needed_by, r.notes,
  r.created_by_name                         as requested_by,
  r.qty_yd, r.volume_by_dispatch,
  r.product_id, p.name                      as product,
  (select array_agg(distinct n)
     from unnest(array[p.name, c.name] || coalesce(c.aliases, '{}')) n
    where n is not null)                    as product_names,
  c.id                                      as catalog_product_id,
  r.bin_id, b.code                          as bin,
  nullif(b.capacity_yd, 0)                  as bin_capacity_yd,
  oh.on_hand_yd                             as bin_on_hand_yd,
  coalesce(h.hauls, '[]'::jsonb)            as hauls
from yard.backfill_requests r
left join yard.products p     on p.id = r.product_id
left join yard.bins b         on b.id = r.bin_id
left join yard.bin_on_hand oh on oh.bin_id = r.bin_id
left join lateral (
  select c.id, c.name, c.aliases
  from core.products c
  where core.norm_name(c.name) = core.norm_name(p.name)
     or core.norm_name(p.name) in (select core.norm_name(a) from unnest(c.aliases) a)
  order by (core.norm_name(c.name) = core.norm_name(p.name)) desc
  limit 1
) c on true
left join lateral (
  select jsonb_agg(jsonb_build_object(
           'id', x.id, 'truck_no', x.truck_no, 'volume_yd', x.volume_yd,
           'haul_on', x.haul_on, 'status', x.status) order by x.haul_on, x.created_at) as hauls
  from yard.hauls x
  where x.request_id = r.id and x.status <> 'cancelled'
) h on true
where r.method = 'bulk'
  and (r.status not in ('delivered', 'cancelled') or r.created_at > now() - interval '45 days');

create or replace view yard.dispatch_bins
with (security_invoker = true) as
select
  b.id, b.code                               as bin_name,
  p.name                                     as product,
  b.product_id,
  (select array_agg(distinct n)
     from unnest(array[p.name, c.name] || coalesce(c.aliases, '{}')) n
    where n is not null)                     as product_names,
  b.capacity_yd,
  greatest(coalesce(oh.on_hand_yd, 0), 0)    as on_hand_yd,
  case when b.capacity_yd > 0
       then round(least(b.reorder_yd / b.capacity_yd, 1), 3) end as reorder_fraction
from yard.bins b
left join yard.products p     on p.id = b.product_id
left join yard.bin_on_hand oh on oh.bin_id = b.id
left join lateral (
  select c.name, c.aliases
  from core.products c
  where core.norm_name(c.name) = core.norm_name(p.name)
     or core.norm_name(p.name) in (select core.norm_name(a) from unnest(c.aliases) a)
  order by (core.norm_name(c.name) = core.norm_name(p.name)) desc
  limit 1
) c on true
where b.site = 'retail' and b.active;

revoke all on yard.dispatch_requests, yard.dispatch_bins from anon, public;
grant select on yard.dispatch_requests, yard.dispatch_bins to authenticated;

-- ---------------------------------------------------------------------
-- Added 2026-11-24 (migration "yard_dispatch_truck_loads_and_kevin_staff"):
-- Retail Yard's load sizes per truck and product, dry and wet, so Bulk
-- Dispatch sizes a yard haul the way Retail Yard does.
--   dry = the product's own load size for that truck, else its haul group's
--   wet = the haul group's wet figure, else the product's own
-- ---------------------------------------------------------------------
create or replace view yard.dispatch_truck_loads
with (security_invoker = true) as
with t as (
  select e.value ->> 'no' as truck_no, e.ordinality::int as pos, e.value -> 'cap' as cap
  from yard.settings s
  cross join lateral jsonb_array_elements(s.value) with ordinality e
  where s.key = 'trucks' and jsonb_typeof(s.value) = 'array'
)
select
  t.truck_no, p.id as product_id, p.name as product,
  (select array_agg(distinct n)
     from unnest(array[p.name, c.name] || coalesce(c.aliases, '{}')) n
    where n is not null)                     as product_names,
  coalesce(x.own, x.grp_dry)                 as dry_yd,
  coalesce(x.grp_wet, x.own)                 as wet_yd
from t
cross join yard.products p
cross join lateral (
  select nullif(case t.pos when 1 then p.order_size_1_yd when 2 then p.order_size_2_yd end, 0) as own,
         nullif((t.cap -> p.haul_group ->> 'dry')::numeric, 0) as grp_dry,
         nullif((t.cap -> p.haul_group ->> 'wet')::numeric, 0) as grp_wet
) x
left join lateral (
  select c.name, c.aliases
  from core.products c
  where core.norm_name(c.name) = core.norm_name(p.name)
     or core.norm_name(p.name) in (select core.norm_name(a) from unnest(c.aliases) a)
  order by (core.norm_name(c.name) = core.norm_name(p.name)) desc
  limit 1
) c on true
where p.active and coalesce(x.own, x.grp_dry, x.grp_wet) is not null;

revoke all on yard.dispatch_truck_loads from anon, public;
grant select on yard.dispatch_truck_loads to authenticated;
