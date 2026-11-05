-- =====================================================================
-- Dept 14 - 004_fix_text_encoding.sql
-- Some special characters were scrambled when SQL was pasted from the
-- clipboard (the UTF-8 text was read as Mac Roman): the middle dot in item
-- names, curly quotes and apostrophes in notes, and so on.
-- This puts every text value in the dept14 tables back. The SQL itself is
-- plain ASCII (chr() codes) so pasting it can't scramble it again.
-- Safe to re-run: once fixed, nothing matches.
-- =====================================================================
begin;
do $$
declare
  pairs text[][] := array[
    array[chr(8218)||chr(196)||chr(162), chr(8226)],
    array[chr(8218)||chr(220)||chr(237), chr(8594)],
    array[chr(8218)||chr(196)||chr(182), chr(8230)],
    array[chr(8218)||chr(224)||chr(237), chr(8722)],
    array[chr(8218)||chr(196)||chr(250), chr(8220)],
    array[chr(8218)||chr(196)||chr(249), chr(8221)],
    array[chr(8218)||chr(196)||chr(242), chr(8216)],
    array[chr(8218)||chr(196)||chr(244), chr(8217)],
    array[chr(8218)||chr(196)||chr(236), chr(8211)],
    array[chr(8218)||chr(196)||chr(238), chr(8212)],
    array[chr(8218)||chr(226)||chr(8226), chr(8805)],
    array[chr(8218)||chr(226)||chr(167), chr(8804)],
    array[chr(8218)||chr(209)||chr(162), chr(8482)],
    array[chr(172)||chr(8721), chr(183)],
    array[chr(8730)||chr(243), chr(215)],
    array[chr(172)||chr(8805), chr(179)],
    array[chr(172)||chr(8804), chr(178)],
    array[chr(172)||chr(8734), chr(176)],
    array[chr(172)||chr(937), chr(189)],
    array[chr(172)||chr(186), chr(188)],
    array[chr(172)||chr(230), chr(190)],
    array[chr(8730)||chr(169), chr(233)],
    array[chr(172)||chr(177), chr(177)],
    array[chr(8730)||chr(177), chr(241)],
    array[chr(172)||chr(165), chr(180)],
    array[chr(172)||chr(174), chr(168)],
    array[chr(172)||chr(198), chr(174)]
  ];
  c record; p text[]; n bigint; total bigint := 0;
begin
  for c in
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'dept14' and table_name <> 'change_log'
      and table_name in (select table_name from information_schema.tables where table_schema = 'dept14' and table_type = 'BASE TABLE')
      and (data_type in ('text','character varying') or (data_type = 'ARRAY' and udt_name = '_text'))
  loop
    foreach p slice 1 in array pairs loop
      if c.data_type = 'ARRAY' then
        execute format('update dept14.%I set %I = (select array_agg(replace(x, $1, $2)) from unnest(%I) x) where array_to_string(%I, chr(1)) like ''%%'' || $1 || ''%%''',
                       c.table_name, c.column_name, c.column_name, c.column_name) using p[1], p[2];
      else
        execute format('update dept14.%I set %I = replace(%I, $1, $2) where %I like ''%%'' || $1 || ''%%''',
                       c.table_name, c.column_name, c.column_name, c.column_name) using p[1], p[2];
      end if;
      get diagnostics n = row_count; total := total + n;
    end loop;
  end loop;
  raise notice 'fixed % values', total;
end $$;
commit;

-- Check: paste this back (all three should read correctly; the last line should be 0)
select 'item names' as what, string_agg(name, ' | ' order by sort) as detail from dept14.items where code in ('14-14-CC1','07-86-15W') and active
union all select 'PAC Fibre Medium note', note from dept14.bins where name = 'PAC Fibre Medium'
union all select 'values still scrambled', (
  select count(*)::text from dept14.items where name like '%' || chr(172) || chr(8721) || '%') ;
