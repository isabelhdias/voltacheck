// Pure status/search logic — no DOM, no timers, no network.
//
// This is the spec that iOS/Android ports will mirror, and Phase 3 unit-tests
// it with `node --test`. Nothing here may touch document, window,
// localStorage, navigator, L, supabase or fetch, and `now` is always passed
// in rather than read from Date.now() internally — that's what makes the
// 18h decay testable without mocking the clock.

import { STALE_AFTER, RECONFIRM_AFTER, HOUR } from './config.js';

/* ───────── status ───────── */

export function latest(machine){
  return (machine.reports && machine.reports.length)
    ? machine.reports[machine.reports.length - 1]
    : null;
}

export function statusOf(machine, now){
  var r = latest(machine);
  if(!r) return "stale";
  return (now - r.at) > STALE_AFTER ? "stale" : r.s;
}

// The sheet prompt switches from "Estiveste lá agora?" to "Ainda está
// assim?" once the latest report is old enough to invite reconfirmation.
export function needsReconfirm(report, now){
  return !!report && (now - report.at) > RECONFIRM_AFTER;
}

export function ago(ts, now){
  var d = now - ts;
  if(d < HOUR)      return "há " + Math.max(1, Math.round(d / 60000)) + " min";
  if(d < 24 * HOUR) return "há " + Math.round(d / HOUR) + " h";
  return "há " + Math.round(d / (24 * HOUR)) + " d";
}

/* ───────── procura por concelho ───────── */

// "Braganca" has to find "Bragança", and "sao" has to find "São". Strip the
// accents off both sides rather than asking people to type them.
export function norm(str){
  return (str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Group the machines by concelho, keeping each one's bounds so picking a
// result can frame every machine in that town.
export function groupTowns(machines){
  var by = {};
  machines.forEach(function(m){
    if(!m.town) return;
    var g = by[m.town];
    if(!g){
      g = by[m.town] = { town:m.town, n:0, s:m.lat, n_:m.lat, w:m.lng, e:m.lng };
    }
    g.n++;
    if(m.lat < g.s)  g.s  = m.lat;
    if(m.lat > g.n_) g.n_ = m.lat;
    if(m.lng < g.w)  g.w  = m.lng;
    if(m.lng > g.e)  g.e  = m.lng;
  });
  return by;
}

export function townsMatching(machines, term){
  var t = norm(term);
  if(!t) return [];

  var by = groupTowns(machines);

  var hits = [];
  Object.keys(by).forEach(function(k){
    var at = norm(k).indexOf(t);
    if(at >= 0) hits.push({ g:by[k], at:at });
  });

  /* Towns that start with what you typed come first. */
  hits.sort(function(a, b){
    if(a.at !== b.at) return a.at - b.at;
    return a.g.town.localeCompare(b.g.town, "pt");
  });

  return hits.slice(0, 8).map(function(h){ return h.g; });
}

/* ───────── filtro por cadeia ───────── */

export function filterByChain(machines, chain){
  return chain ? machines.filter(function(m){ return m.chain === chain; }) : machines;
}

// Ordered by how many machines each chain has, "Outras" always last —
// "Todas" itself isn't a chain in the data, so it's a UI-only entry added
// ahead of this list at the call site.
export function chainCounts(machines){
  var counts = {};
  machines.forEach(function(m){ counts[m.chain] = (counts[m.chain] || 0) + 1; });

  var chains = Object.keys(counts).filter(function(c){ return c !== "Outras"; });
  chains.sort(function(a, b){ return counts[b] - counts[a]; });
  if(counts["Outras"]) chains.push("Outras");

  return chains.map(function(c){ return { chain:c, count:counts[c] }; });
}

/* ───────── distância ───────── */

// Haversine, matching private.metres_between() in schema.sql term for term
// (same formula, same 12,742,000 m mean earth diameter) — the server-side
// proximity check on report_machine() and this client-side one must never
// quietly disagree about how far apart two points are.
function toRad(deg){ return deg * Math.PI / 180; }

export function metresBetween(lat1, lng1, lat2, lng2){
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.pow(Math.sin(dLat / 2), 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
  return 12742000 * Math.asin(Math.sqrt(a));
}

// pt-PT: under 1 km reads as whole metres, rounded to the nearest 10 — no
// one needs "a 437 m". From 1 km up to 10 km it's kilometres with one
// decimal and a comma, the Portuguese convention ("a 1,2 km", not "a 1.2
// km"). Past 10 km, whole kilometres only. The bucket is chosen from the
// *rounded* value, not the raw one, so a distance like 997 m lands on
// "a 1,0 km" instead of surfacing as "a 1000 m".
export function formatDistance(metres){
  var m = Math.max(0, metres);

  var metres10 = Math.round(m / 10) * 10;
  if(metres10 < 1000) return "a " + metres10 + " m";

  var km1 = Math.round(m / 100) / 10;
  if(km1 < 10) return "a " + km1.toFixed(1).replace(".", ",") + " km";

  return "a " + Math.round(m / 1000) + " km";
}

// New array, nearest machine first. `from` is {lat,lng}; when the user's
// position isn't known yet, a falsy `from` returns an unsorted copy so
// callers never need a separate branch for "no fix".
export function sortByDistance(machines, from){
  if(!from) return machines.slice();
  return machines.slice().sort(function(a, b){
    return metresBetween(from.lat, from.lng, a.lat, a.lng) -
           metresBetween(from.lat, from.lng, b.lat, b.lng);
  });
}

/* ───────── filtro por estado ───────── */

// An empty (or missing) statuses list matches nothing — "all four toggles
// off" is a real, intentional state, not shorthand for "show everything".
export function filterByStatus(machines, statuses, now){
  var wanted = {};
  (statuses || []).forEach(function(s){ wanted[s] = true; });
  return machines.filter(function(m){ return wanted[statusOf(m, now)]; });
}

// How many machines currently fall in each status. Independent of any
// status filter — callers filter by chain (or whatever else) first, so a
// toggle can show what turning it *on* would reveal, including one that's
// currently off. That's what stops a filter combination from being a blind
// dead end: the count is visible before the tap.
export function statusCounts(machines, now){
  var c = { ok:0, full:0, down:0, stale:0 };
  machines.forEach(function(m){ c[statusOf(m, now)]++; });
  return c;
}

/* ───────── concelho sugerido ───────── */

// The concelho of the nearest machine, but only when that machine is close
// enough for the guess to be worth anything.
//
// This exists to PREFILL a field the person can see and correct, not to
// decide the answer. The database used to derive a submission's concelho
// from its nearest machine unconditionally, and the first real submission
// landed 18.8 km from its neighbour and was filed under the wrong concelho —
// wrong in a way nobody would notice until a town search came up empty.
// Suggesting it in a visible field fixes the visibility; the radius fixes
// the suggestion.
//
// Returns "" when there is nothing close, which is the signal to leave the
// field empty rather than put a guess in front of someone as if it were
// known.
export function suggestTown(machines, lat, lng, within){
  var limit = within == null ? 2000 : within;
  var best = null, bestD = Infinity, d;
  (machines || []).forEach(function(m){
    if(!m || !m.town) return;
    d = metresBetween(lat, lng, m.lat, m.lng);
    if(d < bestD){ bestD = d; best = m; }
  });
  return (best && bestD <= limit) ? best.town : "";
}

// Every distinct concelho currently on the map, sorted, for the datalist
// behind the concelho field. Suggestions only — somewhere with no machine
// yet is still a legitimate answer, so the field stays free text.
export function knownTowns(machines){
  var seen = {}, out = [];
  (machines || []).forEach(function(m){
    if(m && m.town && !seen[m.town]){ seen[m.town] = true; out.push(m.town); }
  });
  return out.sort(function(a, b){ return norm(a) < norm(b) ? -1 : 1; });
}

/* ───────── filtro por distância ───────── */

// Machines within `metres` of `from`. A null radius means "Todas" and
// returns everything, as does a missing position — the filter cannot
// answer "how far" without somewhere to measure from, and showing an empty
// map would blame the user for not having tapped locate.
//
// Deliberately inclusive at the boundary: a machine at exactly 1000 m is
// within 1 km. Half-open ranges are for buckets that must not overlap, and
// these do not.
export function filterByDistance(machines, from, metres){
  if(metres == null || !from) return machines.slice();
  return machines.filter(function(m){
    return metresBetween(from.lat, from.lng, m.lat, m.lng) <= metres;
  });
}
