// Supabase wiring: connect, pull the current state, push reports and new
// machines. Everything here is a no-op (or a local-only stand-in) when the
// app is running in local mode.

import { SUPABASE_URL, SUPABASE_ANON_KEY, LOOKBACK_H, HOUR } from './config.js';
import * as store from './store.js';
import { deviceId } from './store.js';

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

export async function pull(){
  var since = new Date(Date.now() - LOOKBACK_H * HOUR).toISOString();

  var mRows = await pageAll(function(){
    return db.from("machines")
             .select("id,name,lat,lng,town,chain,source")
             .order("id", { ascending:true });
  });

  var rRows = await pageAll(function(){
    return db.from("reports")
             .select("machine_id,status,created_at")
             .gte("created_at", since)
             .order("created_at", { ascending:true });
  });

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
export async function connect(){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase){
    return { live:false, reason:"no-supabase" };
  }
  try {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    await pull();
    store.setLive(true);
    return { live:true, reason:null };
  } catch(err){
    store.setLive(false);
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
  var res = await db.rpc("report_machine", {
    machine: machineId,
    state:   status,
    lat:     f ? f.lat : null,
    lng:     f ? f.lng : null,
    acc:     f ? f.acc : null,
    device:  deviceId()
  });
  if(res.error) return "erro";
  return res.data || "erro";
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
  var res = await db.rpc("submit_machine", {
    name:     fields.name,
    chain:    fields.chain,
    note:     fields.note,
    lat:      fields.lat,
    lng:      fields.lng,
    from_lat: pos ? pos.lat : null,
    from_lng: pos ? pos.lng : null,
    from_acc: null,
    device:   deviceId()
  });
  if(res.error) return "erro";
  return res.data || "erro";
}
