// Supabase wiring: connect, pull the current state, push reports and new
// machines. Everything here is a no-op (or a local-only stand-in) when the
// app is running in local mode.

import { SUPABASE_URL, SUPABASE_ANON_KEY, LOOKBACK_H, HOUR } from './config.js';
import * as store from './store.js';
import { deviceId } from './store.js';
import * as tel from './telemetry.js';

export var db = null;

/* PostgREST caps how many rows one request returns (1000 on Supabase by
   default), and there are ~2.400 machines. Without paging, live mode would
   quietly show a fraction of the country and a town search would come up
   empty for the towns that fell off the end. */
var PAGE = 1000;

export async function pageAll(build){
  var all = [], from = 0, res;
  for(;;){
    res = await build().range(from, from + PAGE - 1);
    if(res.error) throw res.error;
    all = all.concat(res.data);
    if(res.data.length < PAGE) return all;
    from += PAGE;
  }
}

/* `parent` is optional and only ties this pull's spans into a bigger trace —
   the boot sequence passes one, the foreground refresh doesn't and gets a
   trace of its own. Row counts ride along as span attributes and as
   db.pull.rows, which is the paging regression's own alarm: if a page cap
   ever silently truncates the country again, the number on the dashboard
   drops and says so. */
export async function pull(parent){
  var since = new Date(Date.now() - LOOKBACK_H * HOUR).toISOString();

  var mSpan = tel.span("db.pull", {
    parent: parent, metric: "db.pull.duration", dims: { kind: "machines" } });
  var mRows;
  try {
    mRows = await pageAll(function(){
      return db.from("machines")
               .select("id,name,lat,lng,town,chain,source")
               .order("id", { ascending:true });
    });
  } catch(err){
    mSpan.end("error", { "db.table": "machines" });
    throw err;
  }
  mSpan.end("ok", { "db.table": "machines", "db.rows": mRows.length });
  tel.count("db.pull.rows", { kind: "machines" }, mRows.length);

  var rSpan = tel.span("db.pull", {
    parent: parent, metric: "db.pull.duration", dims: { kind: "reports" } });
  var rRows;
  try {
    rRows = await pageAll(function(){
      return db.from("reports")
               .select("machine_id,status,created_at")
               .gte("created_at", since)
               .order("created_at", { ascending:true });
    });
  } catch(err){
    rSpan.end("error", { "db.table": "reports" });
    throw err;
  }
  rSpan.end("ok", { "db.table": "reports", "db.rows": rRows.length });
  tel.count("db.pull.rows", { kind: "reports" }, rRows.length);

  var byId = {};
  mRows.forEach(function(x){
    byId[x.id] = { id:x.id, name:x.name, lat:x.lat, lng:x.lng,
                   town:x.town || "", chain:x.chain || "Outras",
                   src:x.source || "user", reports:[] };
  });
  rRows.forEach(function(x){
    if(byId[x.machine_id]){
      byId[x.machine_id].reports.push({ s:x.status, at:new Date(x.created_at).getTime() });
    }
  });

  store.setMachines(Object.keys(byId).map(function(k){ return byId[k]; }));
}

/* Returns { live, reason }. reason is "no-supabase" when the config/CDN
   script isn't available — a silent fallback to local mode — or "error" when
   the connection attempt itself failed, which the caller reports with a
   toast. */
export async function connect(parent){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase){
    return { live:false, reason:"no-supabase" };
  }
  var s = tel.span("db.connect", { parent:parent });
  try {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    await pull(parent);
    store.setLive(true);
    s.end("ok");
    return { live:true, reason:null };
  } catch(err){
    store.setLive(false);
    // The one failure that decides whether anyone sees a map at all, and
    // until now it left no trace anywhere off the phone it happened on.
    s.end("error");
    tel.log(tel.SEV.ERROR, "db.connect.failed", {
      "exception.message": err && err.message ? String(err.message) : "unknown",
    });
    return { live:false, reason:"error" };
  }
}

var fix = null, FIX_TTL = 2 * 60 * 1000;

export function getFix(){
  return new Promise(function(resolve){
    if(fix && Date.now() - fix.at < FIX_TTL){ resolve(fix); return; }
    if(!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      function(p){
        fix = { lat:p.coords.latitude, lng:p.coords.longitude,
                acc:p.coords.accuracy, at:Date.now() };
        resolve(fix);
      },
      function(){ resolve(null); },
      { enableHighAccuracy:true, timeout:6000, maximumAge:60000 }
    );
  });
}

export async function pushReport(machineId, status){
  if(!store.live) return "ok";                    // local mode: unchanged, and no geolocation prompt
  var f = await getFix();
  // No `metric` on the span: the outcome is only known once the call
  // returns, and db.rpc.duration is dimensioned by it — "how long does a
  // rejection take" is a different question from "how long does a write
  // take". So the span hands back its duration and it is observed once,
  // with both dimensions.
  var s = tel.span("db.rpc", {});
  var res = await db.rpc("report_machine", {
    machine: machineId,
    state:   status,
    lat:     f ? f.lat : null,
    lng:     f ? f.lng : null,
    acc:     f ? f.acc : null,
    device:  deviceId()
  });
  var outcome = res.error ? "erro" : (res.data || "erro");
  // `geo.fix` is whether a position was attached at all, never the position.
  // Coordinates never leave the phone through this module.
  var ms = s.end(outcome === "erro" ? "error" : "ok",
                 { "rpc.outcome":outcome, "geo.fix":!!f });
  tel.observe("db.rpc.duration", { rpc:"report_machine", outcome:outcome }, ms);
  tel.count("report.result", { outcome:outcome });
  return outcome;
}

/* New machines no longer go straight into `machines` — they go through
   submit_machine(), a review-queue RPC in the same shape as pushReport's
   report_machine(): a status string, not a boolean, so the caller can say
   something useful for each case. Local mode is unchanged and still adds
   the machine directly — there's no queue to speak of without a shared
   database.

   Deliberately reads store.userPos rather than calling getFix(): the
   submitter's own position is attached only when a previous locate tap
   already recorded one, never by prompting for a fresh fix here. */
export async function submitMachine(fields){
  if(!store.live) return "ok-local";
  var pos = store.userPos;
  var s = tel.span("db.rpc", {});
  var res = await db.rpc("submit_machine", {
    name:     fields.name,
    chain:    fields.chain,
    note:     fields.note,
    town:     fields.town,
    address:  fields.address,
    lat:      fields.lat,
    lng:      fields.lng,
    from_lat: pos ? pos.lat : null,
    from_lng: pos ? pos.lng : null,
    from_acc: null,
    device:   deviceId()
  });
  var outcome = res.error ? "erro" : (res.data || "erro");
  var ms = s.end(outcome === "erro" ? "error" : "ok", { "rpc.outcome":outcome });
  tel.observe("db.rpc.duration", { rpc:"submit_machine", outcome:outcome }, ms);
  return outcome;
}
