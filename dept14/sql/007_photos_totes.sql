-- =====================================================================
-- Dept 14 - 007_photos_totes.sql
--
-- 1. Photos on the biochar sock and bag sheets.
--    One private storage bucket, dept14-photos (Nate OK'd this on
--    2026-11-05; nothing else in storage is touched). Files live at
--    runs/<production run id>/<file>.jpg.
--    - The open crew sheet (anon) may only upload JPEGs into the folder of
--      a sock/bag sheet submitted from the form in the last 2 hours, at
--      most 12 photos per sheet. It can't list, read or delete anything.
--    - Logged-in managers can view and delete them.
-- 2. Wash totes. The wash sheet asks how many totes of each size were
--    filled; yards = totes x size. Sizes live in settings 'tote_sizes'
--    (1 yd, and 2 yd for the Washed blend). run_lines keeps tote_count and
--    tote_size_yd. A "Custom" tote has no size yet: it's kept on the run in
--    pending_totes (not in inventory) until the manager names it and gives
--    its yards on the dashboard.
-- 3. form_options('biochar') also returns tote_sizes; submit_biochar_run
--    accepts the tote fields and pending custom totes.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

-- ---------- 2. totes ----------
alter table dept14.run_lines add column if not exists tote_count   numeric check (tote_count is null or tote_count > 0);
alter table dept14.run_lines add column if not exists tote_size_yd numeric check (tote_size_yd is null or tote_size_yd > 0);
alter table dept14.production_runs add column if not exists pending_totes jsonb not null default '[]';

insert into dept14.settings (key, value) values
  ('tote_sizes', '[{"name":"1 yd","yd":1},{"name":"2 yd","yd":2,"blends":["Washed"]}]')
on conflict (key) do nothing;

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
                           from dept14.items where active and line = 'biochar'), '[]'),
    'tote_sizes', coalesce((select value from dept14.settings where key = 'tote_sizes'), '[]'))
  end;
$$;

-- Payload additions (on top of 002):
--   lines[]: "tote_count":3, "tote_size_yd":1   (wash output; qty = yards)
--   "pending_totes":[{"item_id":"<blend item>","custom_name":null,"count":2}]  (Custom tote size, size in notes)
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
  v_pend  jsonb := coalesce(payload -> 'pending_totes', '[]');
  n_in int := 0; n_out int := 0;
begin
  if v_job is null or v_job not in ('wash','sock','bag') then raise exception 'Pick a production type'; end if;
  if v_date is null or v_date > current_date + 1 or v_date < current_date - 120 then
    raise exception 'Production date must be within the last 120 days'; end if;
  if v_hours is null or v_hours <= 0 or v_hours > 24 then raise exception 'Hours must be between 0 and 24'; end if;
  if jsonb_array_length(coalesce(payload -> 'worker_ids', '[]')) = 0 then
    raise exception 'Pick at least one employee'; end if;
  if jsonb_typeof(v_pend) <> 'array' then raise exception 'Bad custom totes'; end if;
  if jsonb_array_length(v_pend) > 0 then
    if v_job <> 'wash' then raise exception 'Custom totes only go on a wash job'; end if;
    if nullif(trim(payload ->> 'notes'), '') is null then raise exception 'Write the custom tote size in Notes'; end if;
    for v_line in select * from jsonb_array_elements(v_pend) loop
      if not exists (select 1 from dept14.items where id = (v_line ->> 'item_id')::uuid and line = 'biochar' and active and kind = 'blend') then
        raise exception 'Unknown product'; end if;
      if coalesce((v_line ->> 'count')::numeric, 0) <= 0 then raise exception 'Enter how many custom totes'; end if;
    end loop;
  end if;

  insert into dept14.production_runs (line, job_type, production_date, hours, boxes, pallets,
                                      order_refs, notes, source, created_by, pending_totes)
  values ('biochar', v_job, v_date, v_hours,
          nullif(payload ->> 'boxes','')::int, nullif(payload ->> 'pallets','')::int,
          coalesce(array(select trim(x) from jsonb_array_elements_text(coalesce(payload -> 'order_refs','[]')) x
                         where trim(x) <> ''), '{}'),
          nullif(trim(payload ->> 'notes'), ''), 'form', auth.uid(),
          (select coalesce(jsonb_agg(jsonb_build_object('item_id', p ->> 'item_id',
                                                        'custom_name', nullif(trim(p ->> 'custom_name'), ''),
                                                        'count', (p ->> 'count')::numeric)), '[]')
             from jsonb_array_elements(v_pend) p))
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

    insert into dept14.run_lines (run_id, direction, item_id, qty, custom_size_ft, custom_name, tote_count, tote_size_yd)
    values (v_run, v_line ->> 'direction', (v_line ->> 'item_id')::uuid,
            (v_line ->> 'qty')::numeric, nullif(v_line ->> 'custom_size_ft','')::numeric,
            nullif(trim(v_line ->> 'custom_name'), ''),
            nullif(v_line ->> 'tote_count','')::numeric, nullif(v_line ->> 'tote_size_yd','')::numeric);
    if v_kind <> 'other' then
      if v_line ->> 'direction' = 'in' then n_in := n_in + 1; else n_out := n_out + 1; end if;
    end if;
  end loop;

  if n_out = 0 and jsonb_array_length(v_pend) = 0 then raise exception 'Enter what was made'; end if;
  if n_in = 0 then raise exception 'Enter what material was used'; end if;
  return v_run;
end $$;

revoke all on function dept14.form_options(text) from public;
revoke all on function dept14.submit_biochar_run(jsonb) from public;
grant execute on function dept14.form_options(text)        to anon, authenticated;
grant execute on function dept14.submit_biochar_run(jsonb) to anon, authenticated;

-- ---------- 1. photos ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dept14-photos', 'dept14-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];

-- May the crew sheet put this file here? Only runs/<id>/<file> for a sock/bag
-- sheet sent from the form in the last 2 hours, and at most 12 per sheet.
create or replace function dept14.photo_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := string_to_array(p_name, '/'); v_id uuid;
begin
  if array_length(v_parts, 1) <> 3 or v_parts[1] <> 'runs' or v_parts[3] !~ '^[A-Za-z0-9_-]{1,80}\.jpg$' then return false; end if;
  begin v_id := v_parts[2]::uuid; exception when others then return false; end;
  if not exists (select 1 from dept14.production_runs
                  where id = v_id and source = 'form' and job_type in ('sock','bag')
                    and submitted_at > now() - interval '2 hours') then return false; end if;
  return (select count(*) from storage.objects
           where bucket_id = 'dept14-photos' and name like 'runs/' || v_id::text || '/%') < 12;
end $$;
revoke all on function dept14.photo_upload_ok(text) from public;
grant execute on function dept14.photo_upload_ok(text) to anon, authenticated;

drop policy if exists dept14_photos_crew_upload on storage.objects;
create policy dept14_photos_crew_upload on storage.objects for insert to anon
  with check (bucket_id = 'dept14-photos' and dept14.photo_upload_ok(name));

drop policy if exists dept14_photos_manager_read on storage.objects;
create policy dept14_photos_manager_read on storage.objects for select to authenticated
  using (bucket_id = 'dept14-photos');

drop policy if exists dept14_photos_manager_delete on storage.objects;
create policy dept14_photos_manager_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dept14-photos');

commit;

-- Check: paste this back
select 'tote sizes' as what, (select value::text from dept14.settings where key = 'tote_sizes') as detail
union all select 'form_options has tote_sizes', (dept14.form_options('biochar') ? 'tote_sizes')::text
union all select 'new columns', (select string_agg(table_name || '.' || column_name, ', ' order by column_name)
  from information_schema.columns where table_schema = 'dept14'
   and column_name in ('tote_count','tote_size_yd','pending_totes'))
union all select 'photo bucket', (select id || ' public=' || public::text from storage.buckets where id = 'dept14-photos')
union all select 'photo policies', (select string_agg(policyname, ', ' order by policyname) from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'dept14_photos%')
union all select 'anon can run', (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
  where p.pronamespace = 'dept14'::regnamespace and has_function_privilege('anon', p.oid, 'execute'));
