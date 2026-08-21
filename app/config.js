// CONFIG — paste your two Supabase values between the quotes.
// Supabase → Project Settings → Data API
// Leave them empty and the app runs in local mode.
export const SUPABASE_URL      = "https://ydtegeetihlhqwjefhyv.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_5gy4cDcQ10CaaAW3NKri-A_M3cflIvW";

export const HOUR = 3600000;
export const STALE_AFTER = 18 * HOUR;      // report decays to grey after this
export const RECONFIRM_AFTER = 3 * HOUR;   // sheet prompt switches to "Ainda está assim?"
export const LOOKBACK_H = 72;              // how far back to pull reports
export const KEY = "centimo.v2";
export const DID_KEY = "centimo.did";

/* With ~2.400 máquinas on the map, one marker each is more DOM than a phone
   can pan smoothly. Draw only what is on screen, and cap it — zoomed out to
   the whole country, a few thousand pins say nothing anyway. */
export const MAX_PINS = 400;

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

/* The 11 chains tools/import_osm.py recognises by name at import time (see
   CHAIN_PATTERNS there) — kept in sync by hand, since the two run in
   different languages and can't share a literal. Used to build the "add
   machine" form's chain dropdown, so the submitter picks from the same list
   the map already filters by, instead of a client-side guess. */
export const CHAINS = [
  "Pingo Doce", "Auchan", "Continente", "Lidl", "Intermarché", "Aldi",
  "SPAR", "Mercadona", "Algartalhos", "Meu Super", "Coviran",
];
