-- =====================================================================
-- Retail Yard — a recorded grind can be corrected
-- (applied to the Production project on 2026-11-25 as migration
-- "yard_edit_grind"; kept here as the record. Safe to re-run.)
-- ---------------------------------------------------------------------
-- yard.edit_grind(id, pile, yards in, yards out, date, notes) changes a
-- grind that is still "done". The old amounts are backed out of the ledger
-- and the corrected ones posted, so both piles end up right and the history
-- shows what changed. Same people who can record a grind can edit one.
-- =====================================================================

alter table yard.debris_events
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by_name text;

create or replace function yard.edit_grind(
  p_id uuid, p_bin_id uuid, p_qty_yd numeric, p_to_qty_yd numeric,
  p_happened_on date, p_notes text default null)
returns yard.debris_events
language plpgsql security definer set search_path to 'yard'
as $$
declare e debris_events; b bins; tb bins; ob bins; notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if coalesce(app_role(), '') not in ('admin', 'inventory', 'hauling', 'debris') then
    raise exception 'Your account can''t change Yard Debris records' using errcode = '42501';
  end if;
  select * into e from debris_events where id = p_id for update;
  if not found or e.kind <> 'grind' then
    raise exception 'That grind was not found' using errcode = '22023';
  end if;
  if e.status <> 'done' then
    raise exception 'An undone grind can''t be edited' using errcode = '22023';
  end if;
  select * into b from bins where id = p_bin_id;
  if not found or b.site <> 'debris' or b.debris_role is distinct from 'grind' then
    raise exception 'Only green waste and wood debris are ground' using errcode = '22023';
  end if;
  select * into tb from bins where id = e.to_bin_id;
  select * into ob from bins where id = e.bin_id;
  if p_qty_yd is null or p_qty_yd <= 0 or p_qty_yd > 2000 then
    raise exception 'Amount ground must be between 0 and 2,000 yd³' using errcode = '22023';
  end if;
  if p_to_qty_yd is null or p_to_qty_yd <= 0 or p_to_qty_yd > 2000 then
    raise exception 'Ground made must be between 0 and 2,000 yd³' using errcode = '22023';
  end if;
  if p_happened_on is null or p_happened_on > current_date + 1 or p_happened_on < current_date - 366 then
    raise exception 'The date must be within the last year and not in the future' using errcode = '22023';
  end if;
  if notes is not null and length(notes) > 500 then
    raise exception 'Notes are limited to 500 characters' using errcode = '22023';
  end if;

  if p_bin_id = e.bin_id and p_qty_yd = e.qty_yd and p_to_qty_yd = e.to_qty_yd and p_happened_on = e.happened_on then
    update debris_events set notes = notes_new.v, edited_at = now(), edited_by_name = actor_name()
      from (select notes as v) notes_new where id = p_id returning debris_events.* into e;
    return e;
  end if;

  insert into movements (bin_id, product_id, qty_yd, kind, source_table, source_id, note, occurred_on)
  values (e.bin_id, ob.product_id, e.qty_yd, 'adjustment', 'debris_events', e.id, 'Grind edited (old amount backed out)', e.happened_on),
         (e.to_bin_id, tb.product_id, -e.to_qty_yd, 'adjustment', 'debris_events', e.id, 'Grind edited (old amount backed out)', e.happened_on);
  insert into movements (bin_id, product_id, qty_yd, kind, source_table, source_id, note, occurred_on)
  values (b.id, b.product_id, -p_qty_yd, 'grind', 'debris_events', e.id, 'Ground into ' || tb.code || ' (edited)', p_happened_on),
         (tb.id, tb.product_id, p_to_qty_yd, 'grind', 'debris_events', e.id, 'Ground from ' || b.code || ' (edited)', p_happened_on);

  update debris_events
     set bin_id = p_bin_id, qty_yd = p_qty_yd, to_qty_yd = p_to_qty_yd, happened_on = p_happened_on,
         notes = notes_new.v, edited_at = now(), edited_by_name = actor_name()
    from (select notes as v) notes_new
   where id = p_id
  returning debris_events.* into e;
  return e;
end $$;

revoke all on function yard.edit_grind(uuid, uuid, numeric, numeric, date, text) from public, anon;
grant execute on function yard.edit_grind(uuid, uuid, numeric, numeric, date, text) to authenticated;
