# The domain contract

`app/domain.js` is the one piece of VoltaCheck that iOS (Swift) and Android
(Kotlin) will need to re-implement, byte-for-byte, when those clients get
built. Everything else — the map, Supabase wiring, the sheet — is
platform-specific UI. This file is the spec. If two ports quietly disagree
about when a report goes stale, the app lies to someone.

## What `domain.js` guarantees

- **Pure.** No DOM, no network, no storage, no `Date.now()`. Every function
  that cares about time takes `now` as an explicit argument in epoch
  milliseconds. That's what makes the decay testable without mocking a clock,
  in any language.
- **Deterministic.** Same inputs, same output, always. No randomness, no
  locale-dependent formatting beyond the fixed pt-PT strings baked in.
- **Small surface.** `statusOf`, `paintOf`, `needsReconfirm`, `ago`, `norm`,
  `groupTowns`, `townsMatching`, `filterByChain`, `chainCounts`, `latest`,
  `metresBetween`, `formatDistance`, `sortByDistance`, `filterByStatus`,
  `statusCounts`, `filterByDistance`, `suggestTown`, `knownTowns`,
  `clusterize`. A port only needs to match these nineteen functions and the
  two thresholds they read from `app/config.js`: `STALE_AFTER` (18h) and
  `RECONFIRM_AFTER` (3h).

Formatting an *absolute* timestamp is deliberately not in that list. The
sheet shows one beside `ago()`'s relative string ("Último report: 20/08,
08:06"), but it is locale- and timezone-dependent, so `app/ui.js` builds it
with `Intl` and a port should use its own platform formatter. The instant
itself is just `latest(machine).at`; there is no accessor for it, because a
caller that wants the timestamp already needs the report for the prompt.

## The vectors are the contract, not the JS test

`test/vectors/*.json` is plain, strict JSON — no comments, no trailing
commas, nothing JS-only. It is meant to outlive this repo's test runner:
`test/unit/domain.test.js` is just the first thing that loads it and
asserts. An `XCTest` target or a JUnit suite should be able to bundle the
same files and iterate them the same way.

Files:

| File | Covers |
|---|---|
| `status.json` | `statusOf` — the 18h decay, including both sides of the boundary |
| `paint.json` | `paintOf` — which colour an aged report keeps, the `faded` flag that says it must be drawn washed out, and which report's timestamp the sheet stamps |
| `reconfirm.json` | `needsReconfirm` in isolation, and the composed sheet-prompt rule below |
| `ago.json` | `ago` — pt-PT relative time strings, the minute/hour/day boundaries, the 1-min floor |
| `search.json` | `norm` (accent/case folding) and `townsMatching` (ranking, the 8-result cap, empty input) |
| `chains.json` | `chainCounts` (ordering, "Outras" last) and `filterByChain` |
| `distance.json` | `metresBetween` (haversine, against real reference distances), `formatDistance` (pt-PT rounding and the metre/km bucket boundaries), `sortByDistance` (nearest-first, the no-position case) |
| `status-filter.json` | `filterByStatus` (statuses-to-keep against `statusOf`, the empty-list-matches-nothing rule) and `statusCounts` (per-status bucket counts, independent of any filter) |
| `clusters.json` | `clusterize` — the screen-pixel grid a zoomed-out map groups machines into: which cell a machine lands in at a given zoom and cell size, the counted group that comes back, and the rule that a cell holding one machine is still a group |

Each file carries the relevant threshold constants as data (e.g.
`staleAfterMs`, `reconfirmAfterMs`, `hourMs`, `dayMs`) under a top-level
`"constants"` key. Assert those against your port's own constants *first* —
if they've drifted, every other case in the file is checked against the
wrong number and a pass proves nothing.

`distance.json` is the one file where exact equality is the wrong check.
`metresBetween` goes through `asin`/`sqrt`/trig, and different platforms'
math libraries can disagree by a fraction of a metre on the same inputs. Its
`metresBetweenCases` carry `expectedMetres` and the file has a top-level
`toleranceMetres` — assert `abs(got - expectedMetres) <= toleranceMetres`,
not `==`. `formatDistanceCases` and `sortByDistanceCases` are plain
arithmetic/formatting/ordering, not trig, so those stay exact-equality like
every other vector file.

### Case shape

Every case has an `id` and a `description` — read the description before
touching the numbers; several cases exist specifically to pin down which
side of a boundary wins, or to document a quirk in `ago()`'s rounding that
looks like a bug but is the real, current output (see the "há 60 min" /
"há 24 h" cases in `ago.json` — flagged there in detail). Timestamps
(`now`, `at`, `ts`) are always epoch milliseconds, chosen so the exact
millisecond offset from the relevant threshold is obvious from context
rather than needing to be recomputed.

### The one composed rule: the sheet prompt

`domain.js` does not export a single "what prompt do I show" function — the
prompt is assembled in `app/ui.js` from two independent domain calls
(`app/ui.js` writes the staleness half as `!paintOf(...).faded`, which for a
machine that has a report is the same test):

```
prompt = (report != null && statusOf(machine, now) != "stale" && needsReconfirm(report, now))
  ? "Ainda está assim?"
  : "Estiveste lá agora?"
```

This matters because `needsReconfirm()` on its own does **not** know about
staleness — a report 19 hours old still trips it (10h+ past a 3h
threshold). It's the `statusOf(...) != "stale"` guard that stops a dead
report from being asked to "reconfirm" a status nobody can currently see.
`reconfirm.json` includes cases for this exact interaction
(`older-than-18h-suppresses-reconfirm`, `well-past-stale-suppresses-reconfirm`)
with the formula spelled out in the file's own `"promptFormula"` field. A
Swift/Kotlin port needs to replicate the *composition*, not just the two
functions separately.

## Status and paint are one threshold, two questions

`statusOf` and `paintOf` must never disagree about a machine, and the split
between them is the decay mechanic as it stands:

| | `statusOf(m, now)` | `paintOf(m, now)` |
|---|---|---|
| fresh report | its own status | `{ tone: <status>, faded: false }` |
| report older than `STALE_AFTER` | `"stale"` | `{ tone: <status>, faded: true }` |
| no reports at all | `"stale"` | `{ tone: "stale", faded: false }` |

`statusOf` is what a machine *counts as*: it drives `filterByStatus`,
`statusCounts` and every filter chip, so a report that has aged out is filed
under "no recent data" and never under the status it used to have.
`paintOf` is only how it is *drawn*: an aged report keeps its hue and is
rendered hollow — pale fill, coloured ring — rather than dropping to grey,
which threw away the last thing anyone knew about the machine.

Both use `> STALE_AFTER`, never `>=`, so a report exactly 18h old is current
on both sides. `paint.json` pins the boundary from the painting side, and
`test/unit/domain.test.js` additionally asserts the relationship itself:
`paintOf(...).faded` is true on exactly the inputs where `statusOf(...)` is
`"stale"` **and** a report exists. A port that reimplements the two
independently should assert that same equivalence — it is what stops a pin
and a filter from telling one person two different stories.

## How a Swift/Kotlin port should consume this

1. Bundle `test/vectors/*.json` as test resources (don't hand-transcribe the
   cases — load the files, so a future update to the vectors is a
   free upgrade to every port's test suite).
2. For each file, assert the `"constants"` block against your own
   threshold constants before iterating cases.
3. Iterate `cases` (or the named case arrays in `search.json`,
   `chains.json`, `clusters.json`, …) and assert your implementation's output against the
   `expected*` field(s), using the `id`/`description` as the assertion
   message so a failure names the exact scenario.
4. For `reconfirm.json`, implement the prompt as the three-part composition
   above, not as a rename of `needsReconfirm`.

## Things noticed while testing, not fixed here

- `ago()`'s `Math.round` can push a duration just under a branch's own
  cutoff into a value that reads as the *next* unit: 1ms under 1 hour
  rounds to "há 60 min" instead of "há 1 h", and 1ms under 24h rounds to
  "há 24 h" instead of "há 1 d". Not wrong per the current formula, but
  worth a deliberate look before three platforms independently decide
  whether to preserve it.
- `clusterize()`'s group order is the JavaScript sort of the cell key
  string, `"zoom:cellX:cellY"` — so `"10:1944:1569"` sorts before
  `"10:1950:1533"` character by character, and the order is not
  north-to-south or west-to-east. Any port that sorts numerically by cell
  column and row instead will disagree with `clusters.json` on the order
  (never on the grouping). The order only has to be *stable*, so a port that
  deliberately picks another one should say so and adjust its own
  expectations rather than leave the difference implicit.
- `chainCounts()`'s tie-breaking (chains with equal counts) depends on
  JavaScript's stable sort plus `Object.keys` insertion order, i.e. which
  chain's first machine appears earliest in the input array. That's a
  legitimate, deterministic rule, but it's an implicit one — a Kotlin/Swift
  port needs a stable sort over the same first-seen ordering, not just
  "sort by count descending," to match exactly. `chains.json`'s
  `ties-keep-first-seen-order` case exists to catch a port that gets this
  wrong.
