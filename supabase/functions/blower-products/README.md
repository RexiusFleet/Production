# blower-products (Edge Function, Rexius Production project)

Read-only bridge from the Products catalog to the Blower Scheduler, which
stays on its own Supabase project ("EB CRM").

- Deployed from Claude on 2026-11-24; the deployed source is the record.
- Caller must be a signed-in hub admin (`core.is_admin()`, checked with the
  caller's own token). Gateway JWT verification is off because the function
  does that check itself.
- On the Blower side it calls one read-only database function,
  `public.catalog_feed(p_token)`, which returns the rate card, truck
  capacities and crew names. It holds no Blower service key and cannot write.
- Secret: `BLOWER_FEED_TOKEN` (the feed token; only its hash is stored in the
  Blower database, in `feed_private.catalog_token`).
- To rotate the token: generate a new one in the Blower database, update the
  hash there, and save the new value in this function's secret.
