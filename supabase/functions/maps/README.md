# maps

Address lookup and drive times for Bulk Dispatch, through Google. Deployed in **Rexius Production**.

- Needs one secret, entered by an owner in Supabase → Edge Functions → Secrets: `GOOGLE_MAPS_KEY`.
- The Google key needs these APIs switched on: **Places API (New)**, **Geocoding API**, **Routes API**.
- Only a signed-in account can call it. The key is never sent to a browser.
- Actions (`?action=`): `ping`, `places` (suggestions as you type), `place` (the picked address, with its map position),
  `geocode` (look up a typed address), `matrix` (drive times).
