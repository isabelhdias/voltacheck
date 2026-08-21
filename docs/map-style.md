# The basemap

## What ships

OpenStreetMap's standard raster tiles, warmed toward the app's palette with
a CSS filter and a multiply tint. The values live in `index.html` next to a
comment explaining them; this file is the reasoning behind them and the
options we did not take.

## Why a tint rather than a different map

The redesign's map is drawn furniture — tilted bars and rounded blobs
standing in for a map inside a static picture. "Match the design" therefore
means *quieter and warmer*, not a literal colour match. A tint buys that for
about four lines of CSS, no new dependency, no tile provider, no key, and it
is reversible in one commit.

## Why multiply and not sepia

`sepia()` is the obvious way to warm a map and it is the wrong one. It
rotates hue, so it warms water along with the land.

Measured on a real Lisbon tile (z13, containing the Tagus, parks, a street
grid and open land), classifying each pixel by its OSM Carto source colour
and comparing before and after. "Blue gap" is how much bluer water is than
the land around it — the cue that makes water read as water:

| treatment | land | roads vs land | blue gap |
|---|---|---|---|
| untreated tiles | `#F2EFE9` | +9 | **+62** |
| sepia, warm enough to hit the palette | `#F7F3E2` | +5 | **−1** |
| heavier sepia | `#F4F4E1` | +1 | **−27** |
| **filter + multiply tint (shipped)** | `#E8E6D8` | **+13** | **+12** |

At −27 the Tagus renders warmer than its own banks: it reads as sand. The
heavier the sepia, the closer the land got to target and the more the map
stopped making sense. Multiply scales each channel instead of rotating hue,
so the warmth arrives without the estuary changing material.

It also preserves the road/land contrast that sepia collapses — roads stay
+13 in luminance over the land instead of +1.

## The values, and what they hit

`saturate(.85) brightness(1.04)` on the tile pane, then `#E8E6DE` at 50%
opacity, `mix-blend-mode: multiply`.

Against the design's palette:

| feature | design | shipped | off by |
|---|---|---|---|
| land | `#E8E6DE` | `#E8E6D8` | 6 |
| roads | `#F4F2EC` | `#F3F2EE` | 2 |
| parks | `#DCE4D8` | `#CFDFC2` | 26 |
| water | `#D9E3EA` | `#C1C5BD` | 59 |

Four candidate treatments were scored across all four features; this one won
on total error and had the quietest parks. Pushing saturation to chase the
water only moved the blue gap from 12 to 17 while making parks acidic, so it
was not worth the trade.

## What this cannot do

**Water is the limit.** The design wants a light blue and this gets a muted
grey-blue. One transform applied to the whole image cannot tint one feature
without tinting the others — there is no setting that lifts water toward
blue while keeping land warm, because both are the same pixels to a filter.

Getting the palette exactly means vector tiles, where each layer is painted
separately: MapLibre GL with a custom style, over a vector source such as
OpenFreeMap (no key, no registration, no rate limits, commercial use
allowed, self-hostable). The cost is real — it replaces Leaflet, so
`app/map.js` is rewritten end to end: pins, viewport culling, the `MAX_PINS`
cap and selection. That is its own piece of work, not a follow-up commit.

## Pins are never tinted

The tint sits at `z-index: 250`, above Leaflet's tile pane (200) and below
its overlay (400) and marker (600) panes.

This is deliberate, not incidental. The status colours carry the decay
mechanic, and a treatment that dragged a working machine's green toward a
stale grey would quietly undermine the one thing the app is for.
`test/e2e/map-tint.spec.js` asserts a pin's painted colour equals its status
colour exactly, and that neither the pin nor the marker pane inherits a
filter.

## Attribution

Unaffected — the control container paints above the tint, and the e2e suite
hit-tests it rather than trusting a z-index, since Leaflet does not set one
there. OSM's tile usage policy permits normal interactive viewing and says
nothing about restyling; it does warn there is no SLA. If VoltaCheck ever
gets busy, moving off OSM's own servers is the courteous thing to do
regardless of how it looks.
