-- =====================================================================
-- Rexius core — which apps use the shared product catalog
-- ---------------------------------------------------------------------
-- Run once in the Supabase SQL editor of the PRODUCTION project, after
-- core_002_products.sql. Safe to re-run.
--
-- The Products page shows one checkbox column per app that uses the
-- catalog. Only Retail Yard, Bulk Dispatch and Blower Scheduler do;
-- Mix Board and Specialty keep their own product lists.
-- =====================================================================

alter table core.apps add column if not exists uses_catalog boolean not null default true;

update core.apps
   set uses_catalog = slug in ('retail-yard', 'bulk-dispatch', 'blower');

-- Clear any ticks left over for apps that no longer have a column.
delete from core.product_apps
 where app_slug not in ('retail-yard', 'bulk-dispatch', 'blower');
