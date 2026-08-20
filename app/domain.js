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
