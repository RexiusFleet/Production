-- Rexius Production — record of what is already applied (2026-11-25).
-- 1. yard.dispatch_debris : the debris piles as Bulk Dispatch shows them (level, alert, yards already booked to leave).
-- 2. yard.delete_request  : delete a product order from Retail Yard or Bulk Dispatch. The order is kept on file as
--    "cancelled" and any truck still booked for it is cancelled with it. Delivered orders can't be deleted.

create or replace view yard.dispatch_debris with (security_invoker = true) as
select b.id,
       b.code,
       coalesce(p.name, b.code)           as product,
       b.debris_role,
       nullif(b.capacity_yd, 0)           as capacity_yd,
       b.alert_over_yd,
       coalesce(oh.on_hand_yd, 0)         as on_hand_yd,
       coalesce((select sum(e.qty_yd) from yard.debris_events e
                  where e.bin_id = b.id and e.kind = 'removal' and e.status = 'scheduled'), 0) as booked_out_yd
  from yard.bins b
  left join yard.products    p  on p.id = b.product_id
  left join yard.bin_on_hand oh on oh.bin_id = b.id
 where b.site = 'debris' and b.active;

grant select on yard.dispatch_debris to authenticated;

create or replace function yard.delete_request(p_id uuid)
returns yard.backfill_requests
language plpgsql security definer set search_path to 'yard' as $function$
declare r backfill_requests;
begin
  if coalesce(app_role(), '') not in ('admin', 'inventory', 'hauling') then
    raise exception 'Your account can''t delete product orders' using errcode = '42501';
  end if;
  select * into r from backfill_requests where id = p_id for update;
  if not found then
    raise exception 'That order was not found' using errcode = '22023';
  end if;
  if app_role() = 'hauling' and r.method <> 'bulk' then
    raise exception 'Slinger orders are managed by the yard' using errcode = '42501';
  end if;
  if r.status = 'delivered' then
    raise exception 'A delivered order can''t be deleted' using errcode = '22023';
  end if;
  if r.status <> 'cancelled' then
    update backfill_requests set status = 'cancelled' where id = p_id;
  end if;
  update hauls set status = 'cancelled'
   where request_id = p_id and status in ('scheduled', 'en_route');
  select * into r from backfill_requests where id = p_id;
  return r;
end $function$;

revoke all on function yard.delete_request(uuid) from public, anon;
grant execute on function yard.delete_request(uuid) to authenticated;
