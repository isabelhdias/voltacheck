// CONFIG — paste your two Supabase values between the quotes.
// Supabase → Project Settings → Data API
// Leave them empty and the app runs in local mode.
export const SUPABASE_URL      = "https://ydtegeetihlhqwjefhyv.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_5gy4cDcQ10CaaAW3NKri-A_M3cflIvW";

export const HOUR = 3600000;
export const STALE_AFTER = 18 * HOUR;      // report fades after this — see FADED below
export const RECONFIRM_AFTER = 3 * HOUR;   // sheet prompt switches to "Ainda está assim?"
export const LOOKBACK_H = 72;              // how far back to pull reports
export const KEY = "centimo.v2";
export const DID_KEY = "centimo.did";

/* With ~2.400 máquinas on the map, one marker each is more DOM than a phone
   can pan smoothly. Draw only what is on screen, and cap it. Since clustering
   took over below CLUSTER_BELOW_ZOOM this cap only bites from zoom 13 up,
   where a padded viewport rarely holds anywhere near 400 machines. */
export const MAX_PINS = 400;

/* Zoomed out, a pin per machine was a wall of overlapping colour that said
   nothing, and MAX_PINS quietly dropped the rest — the country view showed
   400 of 2.444 while the count line said 2.444. Below this zoom the map
   groups machines into counted bubbles instead, which hides nothing.
   15 is where a city street fits on screen and pins stop colliding, so from
   there up every machine has its own pin again. */
export const CLUSTER_BELOW_ZOOM = 15;

/* How many machines a patch of map needs before they become a bubble. Two
   pins side by side are not a crowd, and they keep saying what state each
   machine is in — which a neutral bubble cannot. Below this, they stay
   pins however far out you are. */
export const CLUSTER_MIN = 3;

/* The grid a bubble covers, in screen pixels at any zoom. Comfortably wider
   than the widest bubble (48 px): each bubble is kept inside its own cell, so
   the wider the cell, the freer a bubble is to sit over its machines instead
   of being nudged toward the middle. */
export const CLUSTER_CELL_PX = 80;

/* PostgREST caps how many rows one request returns (1000 on Supabase by
   default), and there are ~2.400 machines. Without paging, live mode would
   quietly show a fraction of the country and a town search would come up
   empty for the towns that fell off the end. */
export const PAGE = 1000;

export const LABEL = { ok:"A funcionar", full:"Cheia", down:"Avariada", stale:"Sem dados recentes" };
// Must stay identical to --ok/--full/--down/--stale in index.html. These
// paint the sheet's status pill, the filter chips and the checklist dots;
// the CSS vars paint the pins. When they drift, the same machine is one
// colour on the map and a slightly different one in the sheet.
export const COLOR = { ok:"#12A05F", full:"#E39B22", down:"#DE4A3F", stale:"#98A0AE" };
export const GLYPH = { ok:"✓", full:"▲", down:"✕", stale:"?" };

// Past STALE_AFTER a report no longer drops to grey — it keeps its hue and
// loses its weight, so the map still says *what the machine last was*
// without claiming it is that now. FADED is the washed-out fill, FADED_INK
// the dark tone of the same hue that the glyph and the pill's text use, so
// the pale fill stays readable. Grey is now reserved for a machine nobody
// has ever reported: nothing to fade.
//
// Same duplication rule as COLOR: these mirror --ok-faded/--ok-deep and
// friends in index.html, and test/unit/tokens.test.js fails if they drift.
export const FADED     = { ok:"#C4E7D7", full:"#F8E6C8", down:"#F7D2CF" };
export const FADED_INK = { ok:"#0B633B", full:"#8D6015", down:"#8A2E27" };

/* The 11 chains tools/import_osm.py recognises by name at import time (see
   CHAIN_PATTERNS there) — kept in sync by hand, since the two run in
   different languages and can't share a literal. Used to build the "add
   machine" form's chain dropdown, so the submitter picks from the same list
   the map already filters by, instead of a client-side guess. */
export const CHAINS = [
  "Pingo Doce", "Auchan", "Continente", "Lidl", "Intermarché", "Aldi",
  "SPAR", "Mercadona", "Algartalhos", "Meu Super", "Coviran",
];
