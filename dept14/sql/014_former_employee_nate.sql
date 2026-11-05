-- =====================================================================
-- Dept 14 - 014_former_employee_nate.sql
-- Biochar crew history (Nate, 2026-11-05):
--   * Adds "Nate" as a former employee (not on either crew sheet, not in
--     Settings, but shown on the old production sheets).
--   * Biochar runs before 2026-06-01 marked "Nathaniel" were Nate.
--   * Biochar runs before Cameron's first run were Nate alone.
-- Production sheets keep everything else; only their crew changes. Every
-- change goes into change_log like any other edit.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

insert into dept14.employees (name, active, on_biochar_sheet, on_dryer_sheet)
values ('Nate', false, false, false)
on conflict (name) do update set active = false, on_biochar_sheet = false, on_dryer_sheet = false;

create temp table d14_nate on commit drop as
select (select id from dept14.employees where name = 'Nate')      as nate,
       (select id from dept14.employees where name = 'Nathaniel') as nathaniel,
       (select min(r.production_date) from dept14.production_runs r
          join dept14.run_workers w on w.run_id = r.id
          join dept14.employees e on e.id = w.employee_id
         where r.line = 'biochar' and e.name = 'Cameron')          as cameron_first;

-- 1. before June 2026: Nathaniel -> Nate
insert into dept14.run_workers (run_id, employee_id)
select w.run_id, n.nate
  from dept14.run_workers w
  join dept14.production_runs r on r.id = w.run_id
  cross join d14_nate n
 where r.line = 'biochar' and r.production_date < date '2026-06-01' and w.employee_id = n.nathaniel
on conflict do nothing;
delete from dept14.run_workers w
 using dept14.production_runs r, d14_nate n
 where r.id = w.run_id and r.line = 'biochar' and r.production_date < date '2026-06-01' and w.employee_id = n.nathaniel;

-- 2. before Cameron's first run: Nate alone
delete from dept14.run_workers w
 using dept14.production_runs r, d14_nate n
 where r.id = w.run_id and r.line = 'biochar' and n.cameron_first is not null
   and r.production_date < n.cameron_first and w.employee_id <> n.nate;
insert into dept14.run_workers (run_id, employee_id)
select r.id, n.nate
  from dept14.production_runs r cross join d14_nate n
 where r.line = 'biochar' and n.cameron_first is not null and r.production_date < n.cameron_first
on conflict do nothing;

commit;

-- Check: paste this back
select 'Nate' as what, (select case when active then 'active' else 'former' end from dept14.employees where name = 'Nate') as detail
union all select 'Cameron first run', (select min(r.production_date)::text from dept14.production_runs r
  join dept14.run_workers w on w.run_id = r.id join dept14.employees e on e.id = w.employee_id where r.line = 'biochar' and e.name = 'Cameron')
union all select 'runs with Nate', (select count(distinct w.run_id)::text from dept14.run_workers w join dept14.employees e on e.id = w.employee_id where e.name = 'Nate')
union all select 'Nathaniel before Jun 2026', (select count(*)::text from dept14.run_workers w join dept14.production_runs r on r.id = w.run_id
  join dept14.employees e on e.id = w.employee_id where e.name = 'Nathaniel' and r.production_date < date '2026-06-01')
union all select 'Nathaniel from Jun 2026', (select count(*)::text from dept14.run_workers w join dept14.production_runs r on r.id = w.run_id
  join dept14.employees e on e.id = w.employee_id where e.name = 'Nathaniel' and r.production_date >= date '2026-06-01');
