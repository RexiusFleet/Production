# Bulk Delivery Dispatch

Dispatching and route optimisation for the retail bulk delivery trucks —
Truck 29 and Truck 128 on morning/afternoon waves, Trucks 85 and 98 on hourly
slots, plus the Retail Yard backfill queue.

Single file, no build step. `index.html` is the whole application.

---

## What is where

| | |
|---|---|
| `index.html` | the app |
| `schema.sql` | the production migration — run once in the Supabase SQL editor |
| `DEPLOY.md` | the one-time setup checklist |

Served from GitHub Pages at `/<this-folder>/`.

## How access works

The page is public; the data is not.

Opening the URL gets you a sign-in screen. You enter your Rexius email, Supabase
emails you a one-time link, and that link signs you in **on that device**. Every
read and write then carries your own token, and the row-level policies check your
email against `dispatch.staff`.

That means:

- **adding someone** is one row in `dispatch.staff`
- **removing someone** is one `delete` — they are locked out on their next request,
  with no key to rotate for everybody else
- **read-only** is `can_edit = false`: they see the board and cannot change it
- every write records **who** made it in `updated_by`

The anon key in Settings only identifies the Supabase project. On its own it
opens nothing.

## Local-only mode

With no Supabase URL set, the app runs entirely in the browser against
`localStorage` and never asks anyone to sign in. That is the right mode for a
demo or a scratch copy. The moment a project URL is set, sign-in is required.

## Settings that matter

| Setting | Value |
|---|---|
| Supabase → Project URL | the production project URL |
| Supabase → Anon key | the project's **anon** key (never the service key) |
| Supabase → Table | `bulk_dispatch` |
| Supabase → Schema | `dispatch` |
| Retail yard tracker | the tracker's schema and request table |
| Google Maps | proxy or key — without it, drive times are straight-line estimates |

## Things to know

- **Drive times are estimates** until a Maps key or proxy is configured:
  straight-line miles × 1.28, speed by distance band. The plan's shape holds up
  well without it; the clock times move by up to ~1.5 hours across a day.
- **Trucks 85 and 98 carry placeholder box sizes** (10 yd) and all four weight
  limits are placeholders. Fix these in Fleet before trusting capacity numbers.
- **Which yard stocks which product** is currently "both" for everything. Set the
  real stocking in Products — it is the single biggest thing that would change the
  routing.
