# The redesign

What shipped from `design/VoltaCheck.dc.html`, and where the built app
deliberately differs from it.

## The shape of the change

The old topbar spent its height on two always-visible chip rows — every
chain, then four status toggles — before you had asked to filter anything.
On a phone that is a lot of screen given to a question nobody posed.

Filters now live in a sheet behind one **Filtros** button. What stays in the
topbar is only what is actually narrowing the map: one dismissible chip per
active filter, and a line saying how many machines are left. Removing a
filter is the commonest thing anyone does to one, and it no longer requires
reopening the sheet that set it.

The sheet itself holds Estado (a checklist with counts), Cadeia (chips with
counts, the long tail behind "+ N cadeias") and Distância.

## Distance is new behaviour, not just new pixels

`filterByDistance()` in `app/domain.js`, with vectors in
`test/vectors/distance-filter.json`. Two of its rules are decisions rather
than arithmetic, and a native port has to reproduce both:

- **No radius selected returns everything.** "Todas" is the default.
- **No position also returns everything.** The filter cannot measure without
  an origin. Returning nothing would tell someone the map is empty near them
  when the truth is that we do not know where they are.

The boundary is inclusive: a machine at exactly 1 km is within 1 km. The
vectors pin this at true equality — a port using `<` fails that case and
passes every other one.

### This widened a rule, on purpose

The app used to call geolocation from exactly one place: the locate button.
Picking a distance now also asks, because it is equally a deliberate tap and
the filter is useless without a fix. Two entry points, both a tap, neither
on load.

"Todas" never asks — it needs no position, so prompting would be a
permission dialog in exchange for nothing. If a fix is refused the radius is
still applied, the map stays whole (see above), and a line under the control
says why the radius is not biting.

## Where the build differs from the mock

- **The add form keeps `morada`.** The mock shows name / chain / concelho /
  nota. It predates the address field, which has a column, a migration and
  tests behind it. Dropping shipped functionality to match a picture would
  be reading the mock too literally.
- **`localStorage` keys stay `centimo.*`.** Renaming them to match the
  rebrand would wipe every existing user's local data and reset their device
  id — which is their rate-limit identity, so it would also hand everyone a
  fresh quota. Invisible cosmetics, real cost.
- **The mock's map is drawn furniture.** Those tilted bars and blobs are a
  stand-in for a map in a static picture. The real app has Leaflet.

## What did not change

The decay mechanic. `--stale` is still a desaturated grey that cannot be
mistaken for a fresh report, `STALE_AFTER` is still 18h, and nothing in the
new palette makes an old report look recent. The colours were retuned; what
they mean was not.
