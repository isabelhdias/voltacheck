# Diagrams

The same system `docs/architecture.md` describes in prose, drawn. Read that
one for the *why*; this one is for getting the shape of it in your head
quickly. Every diagram is Mermaid, so it renders inline on GitHub — including
the mobile app, which is where this repo is mostly read.

## 1. The whole thing, once

```mermaid
flowchart TB
  osm["OpenStreetMap<br/>ODbL"] -->|"tools/import_osm.py"| seed["seed/machines.js<br/>seed/machines.csv · .sql"]
  seed --> pages
  seed -->|"Migrate workflow"| db

  pages["GitHub Pages<br/>serves main as-is"] --> app

  app["index.html + app/*.js<br/>native ES modules, no build"]
  app <-->|"PostgREST + RPC"| db[("Supabase Postgres<br/>machines · reports · machine_submissions")]
  app -.->|"no keys in app/config.js"| ls[("localStorage<br/>local mode fallback")]
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
  map["map.js<br/>Leaflet · pins · culling"]
  api["api.js<br/>Supabase reads/writes"]
  store["store.js<br/>state · localStorage"]
  domain["domain.js<br/>PURE — no DOM, no clock"]
  config["config.js<br/>keys · thresholds · labels"]
  seed["seed/machines.js"]

  main --> ui & map & api & store
  ui --> map & api & store & domain
  map --> store & domain
  api --> store
  store --> seed
  domain --> config
```

Every module reads `config.js`; only `domain.js`'s arrow is drawn, because
that is the one that matters — the two decay thresholds. `domain.js` is the
bottom of the graph on purpose: it depends on nothing else, so it can be
lifted out and re-implemented in Swift or Kotlin without dragging the browser
along. See `docs/domain-contract.md`.

## 3. What happens when the page loads

```mermaid
sequenceDiagram
  participant B as Browser
  participant M as main.js
  participant A as api.js
  participant S as store.js
  participant DB as Supabase

  B->>M: module script runs
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
```

## 4. The decay clock

This is the product, not a detail. A report is only worth something for as
long as it is plausibly still true.

```mermaid
stateDiagram-v2
  state "No recent data · grey pin · 'Sem dados recentes'" as stale
  state "Fresh · green / amber / red pin" as fresh
  state "Still shown, but asks to be confirmed" as recon

  [*] --> stale
  stale --> fresh: someone reports
  fresh --> recon: 3 h · RECONFIRM_AFTER
  recon --> stale: 18 h · STALE_AFTER
  recon --> fresh: someone reports again
```

Under 3 h the sheet asks **"Estiveste lá agora?"**. Past 3 h it switches to
**"Ainda está assim?"** — same question, but it now reads as an invitation to
reconfirm. Past 18 h the colour is gone and there is nothing left to confirm.
Both thresholds live in `app/config.js`.

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
```

No coordinates at all is accepted: blocking a real report is worse than
letting an unverifiable one through, and someone willing to lie picks their
coordinates too. `docs/rate-limiting-plan.md` has the full reasoning.

## 6. What a *new machine* goes through

Anyone can suggest a machine from their sofa — no proximity check, because
people map from home. Nothing they submit reaches the map until it is
approved, and approving is a checkbox in a GitHub issue, not a trip to the
Supabase dashboard.

```mermaid
flowchart TD
  form["'Adicionar' form:<br/>name · chain · concelho · address · note"] --> rpc["rpc: public.submit_machine(...)"]
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
