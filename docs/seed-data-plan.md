# Seed data plan — real machine locations

Handoff note. Written in a session whose network egress policy blocked every
outbound host except GitHub and package registries, so the research below is
**unverified inference from web search summaries**, not from loading the pages.
Anything marked ASSUMED needs confirming before it's built on.

## Why this is blocked

The session could not reach `volta.com.pt`, `sdrportugal.pt`, `apps.apple.com`,
or `overpass-api.de` — all returned `EGRESS_BLOCKED`. That means:

- the locator's actual data source was never observed
- its Terms of Use were never read
- no `robots.txt` was checked

Fix: claude.ai/code → environment selector → settings icon → **Network access**
= **Custom** → add the hosts below to **Allowed domains** → tick *"Also include
default list of common package managers"*. Then start a **new** session; a
running VM keeps the policy it booted with.

```
volta.com.pt
*.volta.com.pt
sdrportugal.pt
*.sdrportugal.pt
*.sensoneo.com
overpass-api.de
overpass.kumi.systems
nominatim.openstreetmap.org
```

Expect to need one more host once the locator's network calls are visible.

## What's known

CONFIRMED (multiple independent sources):

- Volta is the consumer brand of the SDR run by SDR Portugal, licensed by APA
  and DGAE. Live since 2026-04-10. €0.10 per container, <3L plastic bottles and
  metal cans.
- Network at launch: ~2,500 reverse vending machines (RVMs), 8,000+ manual
  collection points, 48 kiosks.
- Public locator: `volta.com.pt/onde-devolver/`. A second one exists at
  `sdrportugal.pt/en/collection-points/`.
- SDR Portugal's IT partner is **Sensoneo** (Slovak DRS vendor). The official
  consumer app is `com.sensoneo.sdrconsumer` ("Volta Consumidor") and has its
  own map/locator with address, hours and navigation per point.

ASSUMED (needs verifying):

- The web locator and the app read the same Sensoneo-hosted API, so the useful
  endpoint is probably on a Sensoneo domain rather than `volta.com.pt` itself.
- That API is unauthenticated or uses a client-side key. Unknown.

Note the count mismatch worth resolving early: ~2,500 RVMs vs 8,000+ manual
points. VoltaCheck's status model (working / full / broken) only makes sense for
RVMs — a manual counter at a till can't be "cheia". **Import RVMs only.** If the
source doesn't distinguish them, that's a blocker, not a detail.

## Sourcing options, in preference order

### 1. OpenStreetMap via Overpass — preferred if coverage is usable

OSM already has the right tags: `amenity=vending` + `vending=bottle_return`,
with `recycling:refund_bottles=yes` and payment subtags. There's active
community discussion on tagging deposit-return machines.

Why this wins: ODbL licence grants explicit reuse rights, the app already uses
OSM tiles so attribution is consistent, and it's a real API meant to be queried.
No ToS ambiguity at all.

Why it might not: community mapping of a system launched in 2026 may be sparse.
**Check coverage before committing** — query Lisbon and Porto, compare the count
against the ~2,500 figure. If it's a few dozen, this path is dead for now.

Sketch:

```
[out:json][timeout:60];
area["ISO3166-1"="PT"][admin_level=2]->.pt;
nwr(area.pt)["vending"="bottle_return"];
out center tags;
```

### 2. Ask SDR Portugal for an export

Email and ask for a bulk export for a non-commercial community map. Slower, but
it's the path that ends with permission in writing and data that stays fresh.
Worth sending regardless of which option ships first — it costs one email.

### 3. Scrape the locator — last resort, gated on ToS

Only after reading their Terms of Use. **Do not work around a restriction if one
is found — report it and stop.** Even setting the legal question aside this is
the worst option technically: brittle, and ~2,500 points off a map widget is
slow and re-breaks on every redesign.

If it does go ahead: identify the JSON endpoint, page through it politely
(sequential, rate-limited, honest User-Agent), cache raw responses to disk so
re-runs don't re-hit them.

## Import shape

A script that emits SQL (or CSV) for the `machines` table — nothing that runs at
page load. The app stays a single static `index.html` with no build step.

Current schema is `machines(id, name, lat, lng, created_at)`. Real data wants
more, so plan a migration:

- `external_id` text unique — the operator's own ID, so re-imports update rather
  than duplicate. Without this, the second import doubles every machine.
- `town` text — needed for search-by-town (roadmap item 3), and cheaper to
  populate once at import than to reverse-geocode in the browser.
- `address` text — the sheet currently shows raw coordinates, which is useless
  to a human standing on a street.
- `source` text — `'osm'` / `'sdr'` / `'user'`, so community-added machines stay
  distinguishable from imported ones and a re-import never clobbers them.

Keep `machines_insert` RLS working for user-added machines; the importer runs
with the service key, not the anon key.

If `town` comes from Nominatim: 1 req/sec, cache results, and only geocode
points that don't already carry a town from the source.

## Roadmap

1. **Seed data** (this doc) — blocked on network policy.
2. **Rate limiting** — `reports_insert` currently accepts anything from anyone.
   Needs a Supabase Edge Function checking device hash / IP, plus a proximity
   check so a machine can only be reported from nearby. See the "Known gap" note
   at the bottom of `schema.sql`. Not blocked by the network policy; can be
   built any time.
3. **Search by town** — depends on `town` from step 1.

Items 2 and 3 are unblocked in the sense that 2 can start now; 3 can't finish
without 1.

## Still needs Isabel

- Widen the network policy (above).
- Create the Supabase project, run `schema.sql`, paste `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` into the CONFIG block in `index.html`. Until then the app
  runs in local mode — that fallback must keep working.
- The service key for the importer stays local. Never commit it; the repo is
  public and deploys from `main`.
