# VoltaCheck

Community map showing the live status of Portugal's deposit-return machines
(the SDR system, branded "Volta" by SDR Portugal — **we are unaffiliated**, and
nothing in the UI should imply otherwise). Users see which machines are working,
full, or broken, and report status themselves.

Live at https://isabelhdias.github.io/voltacheck/

## Current work

Read `docs/seed-data-plan.md` first. It carries the active roadmap, what's
blocked and why, and what still needs Isabel.

Roadmap, in priority order:

1. ~~Real seed data~~ — done. 2,444 machines imported from OpenStreetMap
   (ODbL), covering the mainland, Madeira and the Azores.
2. ~~Rate limiting on reports~~ — done. Writes go through
   `public.report_machine()`, a Postgres function that rate-limits by device
   and IP and checks proximity to the machine; see
   `docs/rate-limiting-plan.md`.
3. ~~Search by town~~ — done. A box in the topbar matches concelhos as you
   type, ignoring accents, and frames a town's machines on the map.
4. ~~Filter by supermarket~~ — done. Chips under the search box narrow the
   map to one chain. `chain` is a real column, set once at import time by
   `tools/import_osm.py`, not guessed client-side — this app is meant to be
   the base for iOS/Android clients later, and those want to query it
   server-side.

The app is live and shared — the Supabase project exists, so local mode is
now the fallback path, not the default.

## Hard constraints

- **No build step for the app.** Isabel works entirely from a phone and
  cannot run a local dev server, so anything requiring a local toolchain to
  see the result is a non-starter. What ships is plain files served by GitHub
  Pages from `main` — ES modules load natively in the browser, nothing is
  compiled or bundled. Test tooling in `package.json` is dev-only and never
  reaches a user.
- **Keep files small enough to read on a phone.** This replaced the original
  "single static index.html" rule for the reason that rule existed: a 243 KB
  file is unopenable in GitHub's mobile web view. Prefer several short
  modules over one long file.
- **Ask before adding any dependency or build tooling.** Leaflet and
  supabase-js load from CDN; that's the whole stack.
- **The local-mode fallback must keep working.** The CONFIG block at the top of
  the script holds `SUPABASE_URL` / `SUPABASE_ANON_KEY`. Filled, the app runs
  shared and shows an "em direto" badge; empty, it falls back to localStorage
  with seed data. Never break the empty case.
- **UI copy is Portuguese** (pt-PT). Match the existing register — plain and
  direct, not formal.
- **Don't restyle.** Design tokens are CSS vars at the top of the file:
  `--ink #16233D`, `--paper #F2F4F1`, `--azulejo #2F6FB2`, and status colours
  `--ok #1F9E63`, `--full #D9932B`, `--down #D64545`, `--stale #8C93A5`.
  Type is Archivo. Match what's there.

## Key mechanic

A report decays to grey ("sem dados recentes") after 18h, so the map can't
silently go stale. When a machine's last report is over 3h old, the sheet prompt
changes from "Estiveste lá agora?" to "Ainda está assim?" to invite
reconfirmation. `STALE_AFTER` and `RECONFIRM_AFTER` live in `app/config.js`.

This decay is the point of the product. Don't add anything that makes a stale
report look fresh.

## Files

- `index.html` — markup and styles, plus a single
  `<script type="module" src="app/main.js">` that loads the app. No inline
  app logic lives here any more.
- `app/config.js` — `SUPABASE_URL` / `SUPABASE_ANON_KEY` and the other
  tunables (`STALE_AFTER`, `RECONFIRM_AFTER`, `LOOKBACK_H`, colours, labels).
  Isabel pastes her Supabase values in here, not in `index.html`.
- `app/domain.js` — pure status/search logic (decay, reconfirm threshold,
  town search, chain filtering). No `document`/`window`/`localStorage`/
  `navigator`/`fetch` — this is the spec an iOS/Android port would mirror,
  and what `node --test` unit-tests directly.
- `app/store.js` — the `machines`/`selected`/`activeChain` state and
  localStorage persistence (`localSeed`, `localLoad`, `localSave`,
  `deviceId`).
- `app/api.js` — Supabase reads and writes (`connect`, `pull`, `pushReport`,
  `pushMachine`, `getFix`), and the PostgREST paging.
- `app/map.js` — Leaflet init, pins, viewport culling, the tally strip.
- `app/ui.js` — the bottom sheet, town search, chain filter chips, toast.
- `app/main.js` — wires the modules together and boots the app.
- `seed/machines.js` — the generated `SEED` array (2,444 rows), imported by
  `app/store.js`. Don't edit it by hand: run `python3 tools/import_osm.py`.
- `schema.sql` — Postgres schema for Supabase (machines, reports) and RLS
  policies allowing anonymous read and insert. Paste into the Supabase SQL
  editor; safe to re-run. Note the "Known gap" comment at the bottom.
- `tools/import_osm.py` — the machine importer. Python 3 stdlib, no install.
  Run it to refresh the data; it rewrites `seed/`. (As of the `app/` split
  above, it still targets the old single-file `SEED` block in `index.html`
  and needs an update to write `seed/machines.js` instead — not yet done.)
- `seed/machines.csv`, `seed/machines.sql` — generated. Load either one into
  Supabase.
- `docs/seed-data-plan.md` — where the data comes from and how to refresh it.
- `docs/rate-limiting-plan.md` — how report writes are guarded, and what that
  does and doesn't stop.
- `docs/supabase-setup.md` — the step-by-step for creating the project and
  going from local mode to shared. Written for an iPad; no CLI.

## Working style

**This project is worked fully through agents. Isabel does not edit code and
is on a phone.** Plan the work, dispatch agents to implement it, and verify
their output yourself before reporting it as done — do not hand her a diff to
check. Treat CI as the thing that proves a change is good, because she cannot
run anything locally.

- Small, single-purpose commits with clear messages, pushed to `main` so Isabel
  can check each one on her phone. No PRs unless asked.
- Say plainly when a step needs something only Isabel can do — creating the
  Supabase project, pasting keys, widening the session network policy. Keep
  that list as short as possible; every manual step is one she has to do by
  hand on a phone, and it is where mistakes have actually happened (a schema
  migration ran without its data reload and shipped an empty column).
- On external data sources: flag terms-of-use problems rather than working
  around them.

## Secrets

The repo is public and deploys from `main`. The anon key is designed to be
public and belongs in `app/config.js`; the **service key never goes in the
repo** — importers read it from the environment.
