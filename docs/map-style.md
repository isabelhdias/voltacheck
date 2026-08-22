# The basemap

## Where it stands

OpenStreetMap's standard raster tiles, untreated. A CSS tint was tried and
**abandoned** — it measurably did almost nothing. This file records why, so
nobody spends the afternoon again.

## What was tried

Warm OSM's tiles toward `--paper` with a filter and a per-channel multiply,
on the theory that the map looked cold and bright next to the redesign.

It shipped to a preview and the reaction was "doesn't change much, if it
changed at all". That was correct, and measuring said so:

| basemap | mean chroma | pixels visibly coloured |
|---|---|---|
| OSM Standard, untreated | 32.6 | 47% |
| OSM Standard + the tint | 30.4 | 46.1% |
| CARTO Positron, untreated | **1.7** | **0%** |

A 7% reduction in colourfulness is not a visual change.

## Why it failed — the useful part

The premise was wrong. **OSM's land colour is already close to the design's**:
`#ECEBDE` measured against a target of `#E8E6DE`, a difference of about 6.
There was never much to correct there, so correcting it changed nothing.

What actually separates OSM Standard from the design is not its background
tint but its *colourfulness*: green parks, blue water, pink motorways,
coloured landuse, dense labels — **47% of pixels carry visible colour**. The
design is flat: near-monochrome, four muted tones.

A global filter cannot fix that. It can only desaturate everything at once,
and doing that hard enough to matter destroys the map. Measured on a Lisbon
tile containing the Tagus, using "blue gap" — how much bluer water is than
the land around it, the cue that makes water read as water:

| treatment | land | roads vs land | blue gap |
|---|---|---|---|
| untreated | `#F2EFE9` | +9 | **+62** |
| sepia, warm enough to matter | `#F7F3E2` | +5 | **−1** |
| heavier sepia | `#F4F4E1` | +1 | **−27** |

At −27 the estuary renders warmer than its own banks and reads as sand. So
the two options were "no visible change" or "a broken map", with very little
in between.

## What would work

Serve a basemap that is already flat, then warm it. CARTO Positron is
near-monochrome to begin with (chroma 1.7 against OSM's 32.6), and the same
warm multiply that did nothing to OSM lands it right on the design:

| treatment | background | Δ to design's `#E8E6DE` | chroma |
|---|---|---|---|
| Positron, untreated | `#FCFCFC` | 42 | 1.7 |
| Positron + warm 25% | `#ECECE4` | 9 | 4.1 |
| **Positron + warm 50%** | `#E4E4DC` | **5** | 6.2 |

The tint only ever made sense on top of a basemap that was already quiet.

**Not free, though.** CARTO's raster endpoint answers without a key today,
but their stated terms ask for one — free, no account needed, a fair-use
limit of 5M tile requests a month, and commercial use handled separately.
Shipping against terms we know we aren't meeting isn't worth it, so this
needs the key requested first.

Beyond that, exact control means vector tiles: MapLibre GL with a custom
style over a source such as OpenFreeMap (no key, no registration, no rate
limits, commercial use allowed, self-hostable). That replaces Leaflet, so
`app/map.js` is rewritten end to end — pins, viewport culling, the
`MAX_PINS` cap, the zoomed-out cluster bubbles, selection. Its own piece of
work. (`clusterize()` itself would survive: it is pure grid maths in
`app/domain.js` and knows nothing about Leaflet.)

## A trap worth remembering

The first attempt at the tint was a div with `mix-blend-mode: multiply` at
`z-index: 250`, on the theory that it would sit between Leaflet's tile pane
(200) and marker pane (600).

Those z-indexes are relative to `.leaflet-map-pane`, which is **itself**
`z-index: 400`. The overlay painted underneath the entire map and did
nothing whatsoever — while still looking correct in the CSS, still passing
a test that only checked the rule existed, and still deploying green.

If a map treatment ever seems to have no effect, check that first.

## Pins are never tinted

Whatever the basemap ends up being, the status colours carry the decay
mechanic, and a treatment that dragged a working machine's green toward a
faded one would undermine the thing the app exists to do — that difference
got *smaller* when decay stopped meaning grey, so it matters more, not less.
`test/e2e/pin-colours.spec.js` asserts a pin's painted colour equals its
status colour exactly — the washed-out one when the report has aged past 18h,
the solid one otherwise — and that nothing overlays the map into the pins.
`test/e2e/decay.spec.js` covers the aged case in full, ring included: a pale
fill measures barely above the basemap on its own (1.02 against `--map` for
amber), so the coloured ring is what keeps a faded pin findable and is not
decoration to drop in a restyle.

That file earned its place immediately: writing it is what surfaced that
`app/config.js` had been left on the pre-redesign palette.

## Attribution and policy

OSM's tile usage policy permits normal interactive viewing and says nothing
about restyling. It does warn there is no SLA. If VoltaCheck ever gets busy,
moving off OSM's own servers is the courteous thing to do regardless of how
it looks — which is a second, independent argument for Positron.
