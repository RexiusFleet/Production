-- =====================================================================
-- Dept 14 - 006_sheet_layout.sql
-- Customize sheet: the manager sets what each crew sheet shows (title,
-- jobs, blends / sock sizes / products / bins and their order, which
-- questions are asked). It's stored in dept14.settings under the keys
-- 'sheet_char' and 'sheet_dryer', and form_options() hands it to the
-- crew sheet as "sheet" (the public key still can't read the settings
-- table itself).
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

insert into dept14.settings (key, value) values
  ('sheet_char',  '{"title":"Biochar production sheet","jobs":["wash","sock","bag"],"hiddenBlends":[],"blendOrder":[],"hiddenSocks":[],"questions":{"totes":true,"pallets":true,"orders":true,"notes":true,"customBlend":true,"customSock":true}}'),
  ('sheet_dryer', '{"title":"Dryer production sheet","hiddenProducts":[],"productOrder":[],"hiddenBins":[],"dest":["Totes","Bin"],"questions":{"notes":true}}')
on conflict (key) do nothing;

create or replace function dept14.form_options(p_line text default 'biochar')
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_line = 'orchid' then jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                           from dept14.employees where active and on_dryer_sheet), '[]'),
    'products',  coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort)
                           from dept14.bins where active and dryer_input), '[]'),
    'bins',      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort)
                           from dept14.bins where active and kind = 'dried'), '[]'),
    'sheet',     (select value from dept14.settings where key = 'sheet_dryer'))
  else jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                           from dept14.employees where active and on_biochar_sheet), '[]'),
    'items',     coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'kind', kind, 'blend', blend,
                             'name', name, 'unit', unit, 'is_custom', is_custom) order by sort)
                           from dept14.items where active and line = 'biochar'), '[]'),
    'sheet',     (select value from dept14.settings where key = 'sheet_char'))
  end;
$$;
revoke all on function dept14.form_options(text) from public;
grant execute on function dept14.form_options(text) to anon, authenticated;

commit;

-- Check: paste this back
select 'char sheet title' as what, dept14.form_options('biochar') -> 'sheet' ->> 'title' as detail
union all select 'dryer sheet title', dept14.form_options('orchid') -> 'sheet' ->> 'title'
union all select 'anon can run', (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
  where p.pronamespace = 'dept14'::regnamespace and has_function_privilege('anon', p.oid, 'execute'));
