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
5. ~~Distance from the user, and filter by status~~ — done. The locate
   button records a fix (`store.userPos`) that the sheet shows a distance
   from and the pin cap prefers when trimming the list; status and chain
   filters compose by AND.
6. ~~Moderated machine submissions~~ — done. Anonymous insert into
   `machines` is revoked outright; the "adicionar" form now calls
   `public.submit_machine()`, which writes to `machine_submissions` — a
   table anon can neither read nor write. Isabel approves rows in the
   Supabase Table Editor and a trigger copies them into `machines`.
   Submitting needs no proximity (people map from home); *reporting* a
   machine's state still does, now within 2 km. Approving is a checkbox in
   the review-queue issue, not a trip to the Table Editor. See
   `docs/supabase-setup.md`.
7. ~~Set the machine's details instead of inferring them~~ — done. The form
   now asks for the concelho (prefilled from a machine within 2 km, and
   left blank when there is none) and an optional address, and
   `submit_machine()` stores what was typed. It used to derive the concelho
   from the nearest machine at any distance, which filed the first real
   submission 18.8 km away under the wrong one.

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
- **Two taps may ask for location, and only those two:** the locate button,
  and picking a distance in the filter sheet. Never on load, never on
  opening a sheet. "Todas" does not ask, because it needs no position. See
  `docs/redesign.md`.
- **UI copy is Portuguese** (pt-PT). Match the existing register — plain and
  direct, not formal.
- **Don't restyle.** Design tokens are CSS vars at the top of `index.html`:
  `--ink #14202E`, `--paper #F4F2EC`, `--azulejo #1F4FD8`, and status colours
  `--ok #12A05F`, `--full #E39B22`, `--down #DE4A3F`, `--stale #98A0AE`.
  Type is Archivo, loaded as a variable font because the wordmark needs the
  `wdth` axis. These come from `design/VoltaCheck.dc.html`; match what's
  there.

## Key mechanic

A report decays to grey ("sem dados recentes") after 18h, so the map can't
silently go stale. When a machine's last report is over 3h old, the sheet prompt
changes from "Estiveste lá agora?" to "Ainda está assim?" to invite
reconfirmation. `STALE_AFTER` and `RECONFIRM_AFTER` live in `app/config.js`.

This decay is the point of the product. Don't add anything that makes a stale
report look fresh.

## Files

- `README.md` — the front door: what the app is, screenshots, the decay
  mechanic, how to run it, and an index of everything below.
- `index.html` — markup and styles, plus a single
  `<script type="module" src="app/main.js">` that loads the app. No inline
  app logic lives here any more.
- `app/config.js` — `SUPABASE_URL` / `SUPABASE_ANON_KEY` and the other
  tunables (`STALE_AFTER`, `RECONFIRM_AFTER`, `LOOKBACK_H`, colours, labels).
  Isabel pastes her Supabase values in here, not in `index.html`.
- `app/domain.js` — pure status/search logic (decay, reconfirm threshold,
  town search, chain filtering, distance, status filtering, concelho
  suggestion). No
  `document`/`window`/`localStorage`/`navigator`/`fetch` — this is the spec
  an iOS/Android port would mirror, and what `node --test` unit-tests
  directly.
- `app/store.js` — the `machines`/`selected`/`activeChain`/`activeStatuses`/
  `userPos` state and localStorage persistence (`localSeed`, `localLoad`,
  `localSave`, `deviceId`). `activeStatuses` and `userPos` are never
  persisted — filters are ephemeral, and a fix only exists once locate is
  tapped.
- `app/api.js` — Supabase reads and writes (`connect`, `pull`, `pushReport`,
  `pushMachine`, `getFix`), and the PostgREST paging.
- `app/map.js` — Leaflet init, pins, viewport culling (preferring the
  machines nearest `store.userPos` when trimming the list).
- `app/ui.js` — the bottom sheet (including the distance line), town search,
  the filter sheet (status checklist, chain chips, distance segmented
  control), the topbar filter bar and its per-filter chips, the count line,
  empty-state reset, toast.
- `app/main.js` — wires the modules together and boots the app.
- `seed/machines.js` — the generated `SEED` array (2,444 rows), imported by
  `app/store.js`. Don't edit it by hand: run `python3 tools/import_osm.py`.
- `schema.sql` — Postgres schema for Supabase (machines, reports,
  machine_submissions) and its RLS policies. Anon reads machines and
  reports and can call two functions — `report_machine()` and
  `submit_machine()` — and has no direct write anywhere. Applied by the
  Migrate workflow, not by hand; safe to re-run. Note the "Known gap"
  comment at the bottom.
- `tools/import_osm.py` — the machine importer. Python 3 stdlib, no install.
  Run it to refresh the data; it rewrites `seed/`, including `seed/machines.js`
  directly.
- `seed/machines.csv`, `seed/machines.sql` — generated. Load either one into
  Supabase.
- `docs/seed-data-plan.md` — where the data comes from and how to refresh it.
- `docs/rate-limiting-plan.md` — how report writes are guarded, and what that
  does and doesn't stop.
- `docs/supabase-setup.md` — the step-by-step for creating the project and
  going from local mode to shared. Written for an iPad; no CLI.
- `design/VoltaCheck.dc.html` — the redesign handoff from Claude Design,
  committed because the share link needs a login agents here cannot hold.
  A prototype: read it for values, not structure.
- `docs/redesign.md` — what shipped from that file, where the build
  deliberately differs, and why distance filtering widened the geolocation
  rule.
- `docs/domain-contract.md` — what `app/domain.js` guarantees and how an
  iOS/Android port should consume `test/vectors/*.json`.
- `docs/architecture.md` — the module layout, why `domain.js` takes `now` as
  a parameter, and what each of the four test layers is for. Start here.
- `docs/diagrams.md` — the same system drawn: Mermaid diagrams of the whole
  stack, the module graph, the boot sequence, the decay clock, and the paths
  a report and a submission each take. Renders inline on GitHub, phone
  included.
- `docs/images/*.jpg` — the README screenshots. Generated by
  `node tools/screenshots.mjs`, which drives the real `index.html` in
  Chromium in **local mode** (supabase-js stubbed exactly as the e2e suite
  does it, so it can never reach the live database) with demo reports seeded
  into localStorage. Don't hand-crop replacements: re-run the script.
- `test/vectors/*.json` — the language-agnostic contract `domain.js` is
  tested against; also the contract future native ports assert against.
- `test/unit/domain.test.js` — loads the vectors and runs them through
  `domain.js` with `node --test`. No I/O, ~100ms.
- `test/integration/` — `api.test.js` runs `app/api.js`'s paging and
  `report_machine()` against real Postgres + PostgREST containers that
  `docker-env.js` builds and tears down itself. Needs Docker.
- `test/e2e/` — Playwright specs driving the real `index.html` in Chromium.
  Runs in local mode only; `fixtures.js` stubs `supabase-js` so it can never
  reach the production database.
- `.github/workflows/ci.yml` — runs unit, integration, and e2e tests on every
  push to `main`. The only feedback loop Isabel has, since she can't run
  anything locally — read as pass/fail on her phone.
- `.github/workflows/pages.yml` — publishes the site and a preview of
  every open PR at `/preview/pr-N/`. Previews run in **local mode**: the
  workflow blanks `SUPABASE_URL`/`SUPABASE_ANON_KEY` in its copy, then
  refuses to publish if the live URL or key appears anywhere in the
  preview at all — an unreviewed branch must never be able to write to
  the real database. The whole site is rebuilt each run, so previews are
  always exactly the open PRs and a closed one disappears by itself. A
  failed preview is a warning, never a blocked deploy: previewing a change
  must not be able to stop the live site shipping. Serves only
  `seed/machines.js`, not the CSV/SQL beside it — those are Supabase import
  inputs, 486 KB, and nothing in the browser reads them.

  **Pages source must be "GitHub Actions".** While it is set to "deploy
  from a branch", GitHub also runs its own `pages-build-deployment` on
  every push, which publishes main's files alone and overwrites the
  previews seconds later — both deployments report success and the preview
  URL 404s a minute after it worked.
- `.github/workflows/migrate.yml` — applies `schema.sql` and
  `seed/machines.sql` to the live database in one transaction, manual
  trigger only. Runs the integration suite first and verifies row counts
  and the guard salt afterwards, so the partial-migration incident can't
  recur. Needs the `SUPABASE_DB_URL` secret (Session pooler string).
- `.github/workflows/review-queue.yml` — a few times a day, opens or
  updates one labelled GitHub issue listing pending `machine_submissions`,
  and closes it when the queue empties. Silent when there's nothing
  waiting. Rendering lives in `tools/review_queue.sh` because the apply
  workflow needs it too.
- `.github/workflows/review-apply.yml` — turns a ticked checkbox in that
  issue into an approval or rejection, then redraws the issue. The one
  workflow reachable from a public event, so read its header comment
  before changing it: it is gated on `github.actor` being the repo owner,
  and the issue body is treated as untrusted input. This is how Isabel finds out something needs approving — and the
  one piece of the system that can fail silently, since GitHub disables
  scheduled workflows after 60 days without a commit. See "The one way this
  alerting can go quiet" in `docs/supabase-setup.md`.
- `package.json` / `package-lock.json` — test tooling only, never served.
  The app itself still has no build step.

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
