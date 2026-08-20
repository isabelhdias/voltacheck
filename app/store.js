// machines/selected state + local (device-only) persistence.
//
// Local mode keeps reports and any machine you added yourself, but always
// rebuilds the list from SEED. That way a refreshed import reaches people
// who already have the app open in a tab, instead of being masked forever
// by whatever was cached the first time.

import { SEED } from '../seed/machines.js';
import { KEY, DID_KEY } from './config.js';

export var machines = [];
export var selected = null;
export var live = false;
export var activeChain = null;   // null = "Todas"

export function setMachines(list){ machines = list; }
export function setSelected(id){ selected = id; }
export function setLive(v){ live = v; }
export function setActiveChain(v){ activeChain = v; }

export function find(id){
  return machines.filter(function(x){ return x.id === id; })[0];
}

export function deviceId(){
  var v = null;
  try { v = localStorage.getItem(DID_KEY); } catch(e){ return null; }
  if(!v){
    if(window.crypto && crypto.randomUUID){
      v = crypto.randomUUID();
    } else if(window.crypto && crypto.getRandomValues){
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      v = Array.prototype.map.call(a, function(b){ return (b + 256).toString(16).slice(1); }).join("");
    } else {
      v = String(Date.now()) + String(Math.random()).slice(2);
    }
    try { localStorage.setItem(DID_KEY, v); } catch(e){}
  }
  return v;
}

export function localSeed(){
  return SEED.map(function(s){
    return { id:"osm-"+s[5], name:s[0], lat:s[1], lng:s[2], town:s[3], chain:s[4], src:"osm", reports:[] };
  });
}

export function localLoad(){
  var stored;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch(e){ stored = null; }
  if(!stored) return localSeed();

  var list = localSeed(), reports = stored.reports || {};
  list.forEach(function(m){ m.reports = reports[m.id] || []; });

  (stored.custom || []).forEach(function(c){
    list.push({
      id:c.id, name:c.name, lat:c.lat, lng:c.lng, town:c.town || "",
      src:"user", reports: reports[c.id] || []
    });
  });
  return list;
}

export function localSave(){
  if(live) return;
  var reports = {}, custom = [];
  machines.forEach(function(m){
    if(m.reports && m.reports.length) reports[m.id] = m.reports;
    if(m.src === "user"){
      custom.push({ id:m.id, name:m.name, lat:m.lat, lng:m.lng, town:m.town || "" });
    }
  });
  try {
    localStorage.setItem(KEY, JSON.stringify({ reports:reports, custom:custom }));
  } catch(e){}
}
