-- =====================================================================
-- Rexius core — the hub's people list mirrors the account list
-- (applied to the Production project on 2026-11-24 as migration
-- "core_people_from_accounts"; kept here as the record. Safe to re-run.)
-- ---------------------------------------------------------------------
-- Every account in Supabase Authentication gets a row in core.people as
-- soon as it is created, so access can be assigned before the person has
-- ever opened the hub. Removing an account removes the row.
-- =====================================================================

alter table core.people add column if not exists last_sign_in timestamptz;

create or replace function core.sync_person()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  begin
    if new.email is not null then
      insert into core.people (user_id, email, full_name)
      values (new.id, lower(new.email),
              coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                       nullif(btrim(new.raw_user_meta_data ->> 'name'), ''), ''))
      on conflict (user_id) do update set email = excluded.email;
    end if;
  exception when others then
    -- never block an account from being created or changed
    raise warning 'core.sync_person skipped for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function core.sync_person() from public, anon, authenticated;

drop trigger if exists core_person_on_account on auth.users;
create trigger core_person_on_account
  after insert or update of email on auth.users
  for each row execute function core.sync_person();

insert into core.people (user_id, email, full_name)
select u.id, lower(u.email),
       coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                (select nullif(btrim(y.full_name), '') from yard.profiles y where y.id = u.id),
                (select nullif(btrim(s.full_name), '') from dispatch.staff s where lower(s.email) = lower(u.email)),
                '')
from auth.users u
where u.email is not null
on conflict (user_id) do nothing;
