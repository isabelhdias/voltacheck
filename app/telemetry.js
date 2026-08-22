// Telemetry: OpenTelemetry's data model, none of its SDK.
//
// The official JS SDK assumes a bundler and costs upwards of 150 KB, which
// breaks the no-build-step rule and lands on a phone already paying for
// Leaflet and a variable font. What is kept is the part that matters: real
// 16-byte trace ids and 8-byte span ids, parent/child links, OTel log
// severity numbers, and histograms with fixed explicit buckets. The database
// renders any of it back as OTLP/JSON, so pointing this at a real backend
// later is a forwarder and not a rewrite. See docs/observability-plan.md.
//
// Three rules this module lives by, in order:
//
//   1. It never throws into the app. Every entry point swallows its own
//      errors — an observability tool that can break the map is worse than
//      no observability tool.
//   2. It is off unless the app is live. Local mode and PR previews send
//      nothing, ever, so the dashboard's numbers are the real site's.
//   3. It sends no personal data. No cookies, no fingerprint, no
//      coordinates, no URLs, no free text from anything anyone typed. The
//      session id is random, lives in sessionStorage and dies with the tab.

import {
  SUPABASE_URL, SUPABASE_ANON_KEY, RELEASE,
  TELEMETRY_FLUSH_MS, TRACE_SAMPLE, SLOW_SPAN_MS,
} from './config.js';

// Matches the server's caps in private.telemetry_limits(). Trimming here as
// well means a flush is never refused wholesale for being too big.
var MAX_METRICS = 200, MAX_RAW = 20;

export var SEV = { INFO: 9, WARN: 13, ERROR: 17 };

var on = false;
var mode = "local";
var sess = null;
var timer = null;
var buf = { m:{}, h:{}, r:[] };

/* ───────── plumbing ───────── */

var clock = (window.performance && window.performance.now)
  ? function(){ return window.performance.now(); }
  : function(){ return Date.now(); };

function hex(bytes){
  var a = new Uint8Array(bytes), i;
  if(window.crypto && window.crypto.getRandomValues){
    window.crypto.getRandomValues(a);
  } else {
    for(i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return Array.prototype.map.call(a, function(b){
    return (b + 0x100).toString(16).slice(1);
  }).join("");
}

// Some browsers expose this on window, some on navigator, and Safari used
// its own name. Any of them saying "1" means don't.
function optedOut(){
  var d = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  return d === "1" || d === "yes";
}

function sessionId(){
  try {
    var k = "centimo.tel", v = sessionStorage.getItem(k);
    if(!v){
      v = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : hex(4) + "-" + hex(2) + "-4" + hex(2).slice(1) + "-8" + hex(2).slice(1) + "-" + hex(6);
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch(e){
    // Private browsing can refuse sessionStorage outright. A per-load id is
    // still useful for grouping one visit's spans; it just cannot tell a
    // reload from a new person, which is a limit the dashboard states rather
    // than papers over.
    return null;
  }
}

// Dimension keys are fixed by the server's registry, so the only thing worth
// normalising here is the ordering — {a,b} and {b,a} must land on one row.
function dimKey(name, dims){
  var keys = Object.keys(dims || {}).sort(), out = {}, i;
  for(i = 0; i < keys.length; i++) out[keys[i]] = String(dims[keys[i]]).slice(0, 40);
  return name + " " + JSON.stringify(out);
}

function unkey(k){
  var i = k.indexOf(" ");
  return { n: k.slice(0, i), d: JSON.parse(k.slice(i + 1)) };
}

// Attributes ride along on a raw record and are the one place free-form data
// could leak in, so they are filtered rather than trusted: primitives only,
// short, and few.
function clean(attrs){
  var out = {}, n = 0, k, v;
  for(k in attrs){
    if(!Object.prototype.hasOwnProperty.call(attrs, k) || n >= 10) continue;
    v = attrs[k];
    if(typeof v === "string") out[k] = v.slice(0, 200);
    else if(typeof v === "number" && isFinite(v)) out[k] = v;
    else if(typeof v === "boolean") out[k] = v;
    else continue;
    n++;
  }
  return out;
}

/* ───────── recording ───────── */

// `v` absent means one — most call sites are a tap. It is spelled out
// rather than written `v || 1`, which turned a genuine zero into a one: the
// count that matters most here is db.pull.rows, and "the pull returned no
// machines" reported as "the pull returned one machine" would hide exactly
// the paging regression this exists to catch.
export function count(name, dims, v){
  try {
    var inc = (v === undefined || v === null) ? 1 : v;
    if(typeof inc !== "number" || !isFinite(inc) || inc < 0) return;
    var k = dimKey(name, dims);
    if(!buf.m[k] && Object.keys(buf.m).length >= MAX_METRICS) return;
    buf.m[k] = (buf.m[k] || 0) + inc;
  } catch(e){}
}

export function observe(name, dims, ms){
  try {
    if(!isFinite(ms) || ms < 0) return;
    var k = dimKey(name, dims);
    if(!buf.h[k] && Object.keys(buf.h).length >= MAX_METRICS) return;
    (buf.h[k] = buf.h[k] || []).push(Math.round(ms * 10) / 10);
  } catch(e){}
}

// Raw records are capped per flush, and the cap keeps the OLDEST rather than
// the newest: the first error in a session is the one that explains the rest
// of it.
function raw(rec){
  try {
    if(buf.r.length >= MAX_RAW) return;
    buf.r.push(rec);
    if(buf.r.length >= MAX_RAW) flush();
  } catch(e){}
}

export function log(severity, name, attrs){
  raw({ k:"log", n:name, sev:severity, a:clean(attrs) });
}

// Head sampling, decided from the trace id itself so every span in one trace
// is kept or dropped together — a waterfall missing its middle is worse than
// no waterfall.
function sampled(traceId){
  return parseInt(traceId.slice(0, 2), 16) / 256 < TRACE_SAMPLE;
}

// span("db.pull", { metric:"db.pull.duration", dims:{ kind:"machines" } })
//
// The histogram is always recorded — it is an aggregate and costs nothing.
// The raw span is kept only when it errored, was slow, or its trace won the
// sampling roll, which is what keeps the raw tier inside the free tier.
export function span(name, opts){
  opts = opts || {};
  var t0 = clock();
  var traceId = opts.parent ? opts.parent.traceId : hex(16);
  var spanId = hex(8);

  return {
    traceId: traceId,
    spanId: spanId,
    end: function(status, attrs){
      var ms, keep, a;
      try {
        ms = clock() - t0;
        if(opts.metric) observe(opts.metric, opts.dims, ms);
        keep = status === "error" || ms >= SLOW_SPAN_MS || sampled(traceId);
        if(keep){
          a = clean(attrs);
          if(status) a["otel.status_code"] = status === "error" ? "ERROR" : "OK";
          raw({ k:"span", n:name, t:traceId, s:spanId,
                p: opts.parent ? opts.parent.spanId : undefined,
                ms: Math.round(ms), a:a });
        }
        return ms;
      } catch(e){ return 0; }
    },
  };
}

/* ───────── sending ───────── */

function drain(){
  var payload = { v:1, sess:sess, rel:RELEASE, mode:mode, m:[], h:[], r:buf.r };
  var k, p;
  for(k in buf.m){ p = unkey(k); payload.m.push({ n:p.n, d:p.d, v:buf.m[k] }); }
  for(k in buf.h){ p = unkey(k); payload.h.push({ n:p.n, d:p.d, v:buf.h[k] }); }
  buf = { m:{}, h:{}, r:[] };
  if(!payload.m.length && !payload.h.length && !payload.r.length) return null;
  return payload;
}

// Deliberately fire-and-forget, with no retry buffer. A failed flush is
// dropped: re-queueing would grow without bound on a phone that is offline,
// and re-sending a latency measured ten minutes ago would poison the very
// histogram it belongs to.
//
// keepalive lets the request outlive the page, which is the whole point on
// pagehide. sendBeacon cannot be used instead — it sets no headers, and
// PostgREST needs the apikey one.
export function flush(){
  try {
    if(!on) return;
    var payload = drain();
    if(!payload) return;
    fetch(SUPABASE_URL + "/rest/v1/rpc/ingest_telemetry", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ payload: payload }),
    }).catch(function(){});
  } catch(e){}
}

/* ───────── lifecycle ───────── */

// Called once, after connect() has decided live or local. Everything
// recorded before this point is still in the buffer: the boot spans happen
// before the app knows which mode it is in, and throwing them away would
// lose the one measurement covering the slowest part of the page.
export function start(isLive){
  try {
    mode = isLive ? "live" : "local";
    on = !!(isLive && SUPABASE_URL && SUPABASE_ANON_KEY && !optedOut());
    if(!on){ buf = { m:{}, h:{}, r:[] }; return; }

    sess = sessionId();
    count("page.view", { page:"app" });
    count("app.visit", { mode:mode });
    try {
      if(!sessionStorage.getItem("centimo.tel.seen")){
        sessionStorage.setItem("centimo.tel.seen", "1");
        count("app.session", { mode:mode });
      }
    } catch(e){ count("app.session", { mode:mode }); }

    window.addEventListener("error", function(e){
      log(SEV.ERROR, "js.error", {
        "exception.message": e && e.message,
        "exception.file": e && e.filename ? String(e.filename).split("/").pop() : undefined,
        "exception.line": e && e.lineno,
      });
      count("app.error", { kind:"error" });
    });
    window.addEventListener("unhandledrejection", function(e){
      log(SEV.ERROR, "js.unhandled", {
        "exception.message": e && e.reason ? String(e.reason).slice(0, 200) : "unknown",
      });
      count("app.error", { kind:"rejection" });
    });

    // Flushing on hidden rather than only on pagehide is what actually gets
    // data off a phone: on iOS a tab that is switched away from is often
    // frozen and never fires pagehide at all.
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);

    timer = setInterval(flush, TELEMETRY_FLUSH_MS);
  } catch(e){ on = false; }
}

// Only the tests use this; the app has no reason to stop.
export function stop(){
  on = false;
  if(timer) clearInterval(timer);
  timer = null;
  buf = { m:{}, h:{}, r:[] };
}

export function enabled(){ return on; }
