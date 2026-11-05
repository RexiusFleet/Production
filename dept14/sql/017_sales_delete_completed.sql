-- =====================================================================
-- Dept 14 - 017_sales_delete_completed.sql   (2026-11-05)
-- Sales staff can cancel / delete any orchid order from the sales page,
-- completed ones included (Nate). Deleting a completed order puts its
-- products back into inventory, same as on the dashboard. It still
-- refuses if someone changed the order since the sales page loaded it.
-- Also: the orchid calendar gets a sales day note (kind 'sales'), written
-- on the sales page, next to production's day note (kind 'orc').
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

create or replace function dept14.cancel_sales_order(p_id uuid, p_expected timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_cur dept14.orders;
begin
  select * into v_cur from dept14.orders where id = p_id for update;
  if not found then return; end if;
  if v_cur.line <> 'orchid' then raise exception 'Not an orchid order'; end if;
  if p_expected is null or v_cur.updated_at <> p_expected then
    raise exception 'Someone else changed this order. It has been reloaded.'; end if;
  delete from dept14.orders where id = p_id;
end $$;
revoke all on function dept14.cancel_sales_order(uuid, timestamptz) from public, anon;
grant execute on function dept14.cancel_sales_order(uuid, timestamptz) to authenticated;

alter table dept14.calendar_days drop constraint if exists calendar_days_kind_check;
alter table dept14.calendar_days add constraint calendar_days_kind_check
  check (kind in ('bio','dryer','pick','bag','orc','sales'));

commit;

-- Check: paste this back
select 'cancel allows completed' as what,
       (position('completed' in pg_get_functiondef('dept14.cancel_sales_order(uuid,timestamptz)'::regprocedure)) = 0)::text as detail
union all select 'calendar kinds', pg_get_constraintdef(oid) from pg_constraint where conname = 'calendar_days_kind_check';
