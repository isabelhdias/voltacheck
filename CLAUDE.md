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
2. Rate limiting on reports — `reports_insert` currently accepts anything from
   anyone. Needs an Edge Function (device hash / IP) plus a proximity check.
   Must land before the link is shared publicly. **Now the top item.**
3. Search by town. Unblocked — every machine has a `town` (concelho).

## Hard constraints

- **Single static `index.html`. No build step.** Isabel works mostly from an
  iPad and cannot run a local dev server, so anything requiring a local
  toolchain to see the result is a non-starter. Deployed by GitHub Pages
  from `main`.
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
reconfirmation. `STALE_AFTER` and the 3h threshold live in the script.

This decay is the point of the product. Don't add anything that makes a stale
report look fresh.

## Files

- `index.html` — the entire app: markup, styles, and script in one file. The
  `SEED` block near the top of the script is generated — don't edit it by hand.
- `schema.sql` — Postgres schema for Supabase (machines, reports) and RLS
  policies allowing anonymous read and insert. Paste into the Supabase SQL
  editor; safe to re-run. Note the "Known gap" comment at the bottom.
- `tools/import_osm.py` — the machine importer. Python 3 stdlib, no install.
  Run it to refresh the data; it rewrites `seed/` and the `SEED` block.
- `seed/machines.csv`, `seed/machines.sql` — generated. Load either one into
  Supabase.
- `docs/seed-data-plan.md` — where the data comes from and how to refresh it.

## Working style

- Small, single-purpose commits with clear messages, pushed to `main` so Isabel
  can check each one on her phone. No PRs unless asked.
- Say plainly when a step needs something only Isabel can do — creating the
  Supabase project, pasting keys, widening the session network policy.
- On external data sources: flag terms-of-use problems rather than working
  around them.

## Secrets

The repo is public and deploys from `main`. The anon key is designed to be
public and belongs in `index.html`; the **service key never goes in the repo** —
importers read it from the environment.
