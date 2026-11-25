-- =====================================================================
-- Retail Yard — product orders: "one load" or "fill the bin"
-- (applied to the Production project on 2026-11-25 as migration
-- "yard_request_goal_fill"; kept here as the record. Safe to re-run.)
-- ---------------------------------------------------------------------
-- backfill_requests.goal = 'load' (default, as before) | 'fill'.
-- A fill order stays open across as many trips as it takes, until the bin
-- is at yard.fill_target_pct() of its capacity and no truck is still on its
-- way. "That's enough" in Retail Yard sets goal back to 'load', and the
-- order then closes once the trucks already booked are confirmed.
-- yard.dispatch_requests (the Bulk Dispatch feed) gained two columns at the
-- end: goal, fill_pct. See yard_001_dispatch_feed.sql for the view itself.
-- =====================================================================

alter table yard.backfill_requests
  add column if not exists goal text not null default 'load'
  check (goal in ('load', 'fill'));
grant insert (goal), update (goal) on yard.backfill_requests to authenticated;

create or replace function yard.fill_target_pct()
returns numeric language sql immutable set search_path = ''
as $$ select 0.90::numeric $$;

create or replace function yard.request_status_now(rid uuid, p_goal text default null)
returns text
language plpgsql stable security definer set search_path to 'yard'
as $$
declare
  r backfill_requests;
  v_delivered numeric; v_active int; v_sched int; v_enroute int;
  cap numeric; oh numeric;
begin
  select * into r from backfill_requests where id = rid;
  if not found then return null; end if;
  if r.status = 'cancelled' then return 'cancelled'; end if;

  select coalesce(sum(volume_yd) filter (where status = 'delivered'), 0),
         count(*) filter (where status in ('en_route','delivered')),
         count(*) filter (where status = 'scheduled'),
         count(*) filter (where status = 'en_route')
    into v_delivered, v_active, v_sched, v_enroute
    from hauls where request_id = rid;

  if coalesce(p_goal, r.goal) = 'fill' then
    select b.capacity_yd, coalesce(o.on_hand_yd, 0) into cap, oh
      from bins b left join bin_on_hand o on o.bin_id = b.id
     where b.id = r.bin_id;
    if coalesce(cap, 0) > 0 then
      return case when oh >= cap * fill_target_pct() and v_delivered > 0
                       and v_sched = 0 and v_enroute = 0 then 'delivered'
                  when v_active > 0 then 'in_progress'
                  when v_sched > 0 then 'scheduled'
                  else 'requested' end;
    end if;
  end if;

  return case when v_delivered >= r.qty_yd then 'delivered'
              when v_active > 0 then 'in_progress'
              when v_sched > 0 then 'scheduled'
              else 'requested' end;
end $$;
revoke all on function yard.request_status_now(uuid, text) from public, anon;
grant execute on function yard.fill_target_pct() to authenticated;

create or replace function yard.trg_haul_after()
returns trigger
language plpgsql security definer set search_path to 'yard'
as $function$
begin
  if new.status = 'delivered' and (tg_op = 'INSERT' or old.status <> 'delivered') then
    insert into movements (bin_id, product_id, qty_yd, kind, source_table, source_id, note, occurred_on)
    values (new.bin_id, new.product_id, new.volume_yd, 'backfill', 'hauls', new.id,
            'Truck ' || new.truck_no || case when new.method = 'slinger' then ' (slinger)' else '' end,
            new.haul_on);
  elsif tg_op = 'UPDATE' and old.status = 'delivered' and new.status <> 'delivered' then
    insert into movements (bin_id, product_id, qty_yd, kind, source_table, source_id, note)
    values (old.bin_id, old.product_id, -old.volume_yd, 'adjustment', 'hauls', new.id,
            'Reversed delivery — Truck ' || old.truck_no);
  end if;

  if new.request_id is not null then
    update backfill_requests set status = request_status_now(new.request_id)
    where id = new.request_id and status <> 'cancelled';
  end if;
  return null;
end $function$;

create or replace function yard.trg_request_goal_change()
returns trigger
language plpgsql security definer set search_path to 'yard'
as $$
begin
  if new.goal is distinct from old.goal and old.status not in ('cancelled', 'delivered')
     and new.status = old.status then
    new.status := coalesce(request_status_now(new.id, new.goal), new.status);
  end if;
  return new;
end $$;

drop trigger if exists c_request_goal_change on yard.backfill_requests;
create trigger c_request_goal_change
  before update of goal on yard.backfill_requests
  for each row execute function yard.trg_request_goal_change();
