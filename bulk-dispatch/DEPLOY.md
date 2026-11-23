# Setting this up — once

## 1. Supabase

1. Open the **production** project → SQL editor → paste `schema.sql` → Run.
   It is idempotent, so re-running it later is safe.
2. **Settings → API → Exposed schemas**: add `dispatch` to the list and save.
   Without this the app gets a 404 on every request.
3. **Authentication → Providers → Email**: turn on **Email**, and turn **off**
   "Allow new users to sign up". Access comes from `dispatch.staff`, not from
   self-registration.
4. **Authentication → URL Configuration → Redirect URLs**: add the Pages URL,
   e.g. `https://<org>.github.io/production/bulk-dispatch/`.
5. Add each person in the SQL editor:

   ```sql
   insert into dispatch.staff (email, full_name, can_edit)
   values ('kevin@rexius.com', 'Kevin Roemer', true)
   on conflict (email) do update set can_edit = excluded.can_edit;
   ```

   They must also exist as auth users — **Authentication → Users → Add user**
   (invite by email) — because sign-up is off.

## 2. GitHub

1. Copy this whole folder into the `production` repo as `bulk-dispatch/`.
2. Commit and push to the branch Pages serves.
3. Confirm Pages is enabled for that branch and the site builds.

## 3. First run

1. Open the Pages URL. You should get the sign-in screen.
2. Sign in with your email and follow the link.
3. **Settings → Supabase**: paste the Project URL and the **anon** key,
   table `bulk_dispatch`, schema `dispatch`.
4. Press **Refresh** in the top bar. The pill should read "Supabase synced".
5. **Settings → Retail yard tracker**: point it at the tracker's table once that
   exists. Until then the Yard requests tab still works by hand.

## 4. Check it took

- Open the app in a second browser, sign in as yourself → the same orders appear.
- Book something in one, press Refresh in the other → it is there.
- Sign out → you land back on the sign-in screen with no data cached.
- Ask someone not in `dispatch.staff` to try → they get a link, sign in, and then
  see "Your access has been withdrawn, or the sign-in expired." That is the
  policy doing its job.

## Rolling back

The app keeps a full local copy. **Settings → Download backup** before any change
you are unsure about; **Restore backup** puts it back. The Supabase table is one
row per collection, so a bad write can also be undone from a backup JSON.
