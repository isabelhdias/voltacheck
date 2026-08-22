// The five RPCs the panel reads, and nothing else.
//
// Every one of them is a security definer function that calls
// private.admin_guard() first, so a call from a session that is not an admin
// at aal2 comes back as an error rather than as data. That is deliberate:
// there is no shape of bug in this file that can turn a refusal into rows.

import { sb } from './auth.js';

async function rpc(fn, args){
  var r = await sb.rpc(fn, args || {});
  if(r.error){
    // 42501 is the guard refusing. Distinguished from a network or schema
    // failure because the panel says something completely different about
    // each: one means "you are not allowed", the other means "it is broken".
    var e = new Error(r.error.message || "erro");
    e.denied = r.error.code === "42501" || /not authoris/i.test(r.error.message || "");
    throw e;
  }
  return r.data;
}

export function overview(){
  return rpc("admin_overview");
}

export function series(days, metrics){
  return rpc("admin_series", { p_days: days, p_metrics: metrics });
}

export function top(metric, days, limit){
  return rpc("admin_top", { p_metric: metric, p_days: days, p_limit: limit });
}

export function errors(hours, limit){
  return rpc("admin_errors", { p_hours: hours, p_limit: limit });
}

export function traces(limit){
  return rpc("admin_traces", { p_limit: limit });
}

/* ───────── shaping ─────────
   admin_series returns one row per (day, metric, dims). These turn that into
   what a chart wants without another round trip. */

// [{d,m,k,v,...}] -> { "2026-08-01": 12, ... } for one metric, optionally
// narrowed to rows whose dims match `where`.
export function byDay(rows, metric, where){
  var out = {};
  rows.forEach(function(r){
    if(r.m !== metric) return;
    if(where && !matches(r.k, where)) return;
    out[r.d] = (out[r.d] || 0) + Number(r.v || 0);
  });
  return out;
}

// Same, but split into one series per value of `dim` — reports by status,
// machines by source.
export function byDayAnd(rows, metric, dim){
  var out = {};
  rows.forEach(function(r){
    if(r.m !== metric) return;
    var key = (r.k && r.k[dim]) || "—";
    (out[key] = out[key] || {});
    out[key][r.d] = (out[key][r.d] || 0) + Number(r.v || 0);
  });
  return out;
}

// Histograms: one p50/p95 per day is already computed server-side, since
// bucket arrays are the wrong thing to send to a phone.
export function latencyByDay(rows, metric, where){
  var out = {};
  rows.forEach(function(r){
    if(r.m !== metric) return;
    if(where && !matches(r.k, where)) return;
    out[r.d] = { p50: r.p50, p95: r.p95, n: Number(r.n || 0) };
  });
  return out;
}

function matches(dims, where){
  for(var k in where){ if((dims || {})[k] !== where[k]) return false; }
  return true;
}

// A dense list of the last n days, so a chart's x-axis has a bar for a day
// nothing happened rather than closing the gap and implying it did.
export function lastDays(n){
  var out = [], d = new Date();
  for(var i = n - 1; i >= 0; i--){
    var x = new Date(d.getTime() - i * 86400000);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

export function sum(map){
  var t = 0;
  for(var k in map) t += map[k];
  return t;
}
