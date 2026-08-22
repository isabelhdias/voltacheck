# Diagrams

The same system `docs/architecture.md` describes in prose, drawn. Read that
one for the *why*; this one is for getting the shape of it in your head
quickly. Every diagram is Mermaid, so it renders inline on GitHub — including
the mobile app, which is where this repo is mostly read.

> **Keeping these true is part of changing the code, not a follow-up.**
> "Keeping the docs true" in `CLAUDE.md` says which diagram each kind of
> change has to update, and it refers to them by the numbers below — so add
> new diagrams at the end rather than renumbering the existing ones.

## 1. The whole thing, once

```mermaid
flowchart TB
  osm["OpenStreetMap<br/>ODbL"] -->|"tools/import_osm.py"| seed["seed/machines.js<br/>seed/machines.csv · .sql"]
  seed --> pages
  seed -->|"Migrate workflow"| db

  pages["GitHub Pages<br/>serves main as-is"] --> app

  app["index.html + app/*.js<br/>native ES modules, no build"]
  app <-->|"PostgREST + RPC"| db[("Supabase Postgres<br/>machines · reports · machine_submissions<br/>private.telemetry_*")]
  app -.->|"no keys in app/config.js"| ls[("localStorage<br/>local mode fallback")]
  app -->|"telemetry, live only"| db
  pages --> admin["admin/*.js<br/>the dashboard, English"]
  admin <-->|"admin_* RPCs, behind is_admin()"| db
```

Two things worth noticing. The seed data goes to *both* sides — the same
import feeds the file the browser reads in local mode and the SQL the live
database is loaded from. And the dotted line is a real, supported path: blank
the two config values and the whole app still works, offline, on one device.

## 2. The modules

```mermaid
flowchart TD
  main["main.js<br/>boot · wiring"]
  ui["ui.js<br/>sheet · search · filters"]
  map["map.js<br/>Leaflet · pins · clusters · culling"]
  api["api.js<br/>Supabase reads/writes"]
  store["store.js<br/>state · localStorage"]
  domain["domain.js<br/>PURE — no DOM, no clock"]
  config["config.js<br/>keys · thresholds · labels"]
  tel["telemetry.js<br/>spans · metrics · logs"]
  seed["seed/machines.js"]

  main --> ui & map & api & store & tel
  ui --> map & api & store & domain & tel
  map --> store & domain & tel
  api --> store & tel
  store --> seed
  domain --> config
  tel --> config
```

Every module reads `config.js`; only `domain.js`'s and `telemetry.js`'s
arrows are drawn, because those are the ones that matter — the two decay
thresholds, and whether telemetry is on at all. `domain.js` is the bottom of
the graph on purpose: it depends on nothing else, so it can be lifted out and
re-implemented in Swift or Kotlin without dragging the browser along. See
`docs/domain-contract.md`.

`telemetry.js` is the one module everything may call and nothing may depend
on: it imports only `config.js`, exports no state anyone reads, and swallows
its own errors. A module that four others call has to be unable to break any
of them.

## 3. What happens when the page loads

```mermaid
sequenceDiagram
  participant B as Browser
  participant M as main.js
  participant A as api.js
  participant S as store.js
  participant DB as Supabase

  participant T as telemetry.js

  B->>M: module script runs
  M->>T: open the app.boot span
  M->>A: connect()
  alt keys set and supabase-js loaded
    A->>DB: machines + reports from the last 72 h
    Note over A,DB: paged 1000 rows at a time —<br/>unpaged, live mode showed 40% of the country
    DB-->>A: rows
    A->>S: setMachines(...)
    M->>B: badge reads "em direto"
  else local mode
    S->>S: SEED + whatever localStorage holds
    M->>B: badge reads "modo local"
  end
  M->>B: count the filters, draw the pins
  M->>T: start(live) — on only if live, then close app.boot
```

`start()` is what decides whether a single byte is ever sent, and it runs
*after* the live-or-local branch above. Local mode and PR previews take the
same path and send nothing, which is what keeps the dashboard's numbers the
live site's.

## 4. The decay clock

This is the product, not a detail. A report is only worth something for as
long as it is plausibly still true.

```mermaid
stateDiagram-v2
  state "Never reported · grey pin" as never
  state "Fresh · solid green / amber / red pin" as fresh
  state "Still shown, but asks to be confirmed" as recon
  state "Faded · same colour, hollow · 'sem dados recentes'" as faded

  [*] --> never
  never --> fresh: someone reports
  fresh --> recon: 3 h · RECONFIRM_AFTER
  recon --> faded: 18 h · STALE_AFTER
  recon --> fresh: someone reports again
  faded --> fresh: someone reports again
```

Under 3 h the sheet asks **"Estiveste lá agora?"**. Past 3 h it switches to
**"Ainda está assim?"** — same question, but it now reads as an invitation to
reconfirm. Past 18 h there is nothing left to confirm: the pin keeps its
colour but turns hollow, the sheet spells out *sem dados recentes*, and the
prompt goes back to **"Estiveste lá agora?"** with no answer pre-ticked.
Both thresholds live in `app/config.js`.

Grey is now only the left-hand state — a machine nobody has ever reported.
The faded state is a *drawing*, not a status: `statusOf()` still calls it
`"stale"`, so the filters and the counts treat "full yesterday" as no recent
data rather than as full. Only `paintOf()` keeps the hue. Every machine also
carries the timestamp of its last report in the sheet, in all three states
that have one.

## 5. What a report goes through

Anonymous users have no INSERT anywhere. The only door is one Postgres
function, and it returns a string per outcome so the app can say something
specific in Portuguese instead of surfacing an HTTP code.

```mermaid
flowchart TD
  tap["Tap 'A funcionar' / 'Cheia' / 'Avariada'"] --> mode{"local mode?"}
  mode -- yes --> ls["straight to localStorage · done"]
  mode -- no --> fix["getFix — position, only if permission is already granted"]
  fix --> rpc["rpc: public.report_machine(...)"]
  rpc --> valid{"known machine,<br/>valid status?"}
  valid -- no --> bad["'invalid' / 'unknown'"]
  valid -- yes --> near{"within 2 km,<br/>plus the browser's own accuracy radius?"}
  near -- no --> far["'far'"]
  near -- yes --> rate{"rate limits:<br/>same machine again inside 10 min ·<br/>20/h or 60/day per device · 300/h per IP"}
  rate -- over --> stop["'cooldown' / 'flood'"]
  rate -- under --> ins["INSERT into reports<br/>+ a pseudonymous guard row, deleted after 48 h"]
  bad --> cnt(["counted under reports.outcome"])
  far --> cnt
  stop --> cnt
  ins --> cnt
```

No coordinates at all is accepted: blocking a real report is worse than
letting an unverifiable one through, and someone willing to lie picks their
coordinates too. `docs/rate-limiting-plan.md` has the full reasoning.

Every one of those six outcomes is counted, which it did not used to be:
until the dashboard existed, a report rejected as `far` left no trace
anywhere, so a proximity rule that was turning away real people would have
looked exactly like a quiet week. See diagram 8.

## 6. What a *new machine* goes through

Anyone can suggest a machine from their sofa — no proximity check, because
people map from home. Nothing they submit reaches the map until it is
approved, and approving is a checkbox in a GitHub issue, not a trip to the
Supabase dashboard.

```mermaid
flowchart TD
  form["'Adicionar' form:<br/>name · chain · concelho · address · note"] --> rpc["rpc: public.submit_machine(...)"]
  rpc --> cnt(["every outcome counted under submissions.outcome"])
  rpc --> sub[("machine_submissions · status = pending<br/>anon can neither read nor write this table")]
  sub --> q["review-queue.yml — three times a day"]
  q --> issue["one labelled GitHub issue,<br/>a checkbox per pending submission"]
  issue -->|"Isabel ticks approve or reject"| apply["review-apply.yml<br/>gated on the actor being the repo owner"]
  apply --> upd["UPDATE status = 'approved'"]
  upd --> trg["trigger: private.approve_submission()"]
  trg --> mach[("machines — now on the map")]
```

The scheduled half is the one piece that can fail quietly: GitHub disables
scheduled workflows after 60 days without a commit. `docs/supabase-setup.md`
explains how that shows up.

## 7. What runs in CI, and what ships

```mermaid
flowchart LR
  push["push or PR"] --> ci["ci.yml"]
  ci --> u["unit — domain.js against test/vectors/*.json · ~100 ms"]
  ci --> i["integration — real Postgres + PostgREST in Docker · ~6 s"]
  ci --> e["e2e — Chromium on the real index.html, local mode · ~55 s"]

  push --> p["pages.yml"]
  p --> site["the live site"]
  p --> prev["/preview/pr-N/ — with the Supabase keys blanked"]

  hand["Actions ▸ Run workflow"] --> mig["migrate.yml — schema.sql + seed, one transaction"]
  mig --> db[("live database")]
```

CI is the only feedback loop this project has: Isabel works from a phone and
cannot run anything locally, so a red check is the review.

## 8. Where the dashboard's numbers come from

Two tiers, because one would not fit the free tier. Aggregates are upserted
in place and kept forever — they do not grow with traffic. Individual
records are kept only for what has to be an individual, and only for a
fortnight.

```mermaid
flowchart TD
  app["app/telemetry.js<br/>off unless live · no cookies · no coordinates"]
  app -->|"compact envelope, on hidden / pagehide / 15 s"| ing
  rep["public.report_machine()"] --> note["private.note_outcome()"]
  sub["public.submit_machine()"] --> note
  ing["public.ingest_telemetry()<br/>anonymous, rate limited, registry-checked"] --> note2["private.note / gauge / observe"]
  note --> daily[("private.telemetry_daily<br/>counters · gauges · histograms<br/>kept forever, ~40 KB/day")]
  note2 --> daily
  ing --> raw[("private.telemetry_raw<br/>errors · slow spans · sampled traces<br/>pruned after 14 days")]
  cron["review-queue.yml — 3×/day"] --> roll["private.telemetry_rollup_daily()"]
  roll --> daily
  roll --> prune["prune telemetry_raw + the flush guard"]
  raw --> otlp["private.otlp_export()<br/>renders it back as OTLP/JSON"]
  daily --> read["public.admin_overview / series / top / errors / traces"]
  raw --> read
  read --> panel["/admin/ — the dashboard"]
```

`ingest_telemetry()` is guarded exactly like the two write functions above
it: same salt, same hashing, same string returns. It adds a metric registry,
which is the part that stops a caller inventing names and dimension values
until the forever-table is the size of the free tier.
`docs/observability-plan.md` has the arithmetic.

## 9. Who gets to read the dashboard

The panel at `/admin/` is public HTML on GitHub Pages, served from a public
repo, using the public anon key. That is fine, and it is fine for exactly one
reason: **the page is not the gate.** Every read goes through a
`security definer` function that asks Postgres first, and the tables it reads
live in `private`, which the Data API does not expose at all.

```mermaid
flowchart TD
  page["/admin/ — public HTML, public anon key"] --> pw["password"]
  pw --> totp["TOTP challenge<br/>Supabase Auth issues aal2"]
  totp --> rpc["public.admin_* — security definer"]
  rpc --> guard["private.admin_guard()"]
  guard --> chk{"public.is_admin()"}
  chk -->|"uid not on private.admins"| no["raise 42501 · not authorised"]
  chk -->|"aal1, or no aal claim"| no
  chk -->|"token email no longer matches the row"| no
  chk -->|"all three hold"| yes["read private.telemetry_* · log to admin_access"]
```

Three things carry the weight, in this order: **sign-ups are off** in Supabase
Auth, so no account can be created to be refused with; the allowlist is keyed
on the **uid**, because Supabase lets a user change their own email; and
`aal2` is required **in the database**, so a password alone is never enough.
`require_aal2` is a column rather than a constant, so it can be relaxed with
an `update` if enrolling TOTP on a phone turns out to be miserable — it
defaults to on, and `test/integration/admin.test.js` proves it is consulted.
