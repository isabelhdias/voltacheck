// Leaflet map: tile layer, pins, viewport culling.
//
// The tally strip moved to app/ui.js — once it became a status filter with
// click handlers and closeSheet()/toast-style wiring, it fit ui.js's existing
// job (DOM controls + filter state) better than map.js's (Leaflet + pins).

import { MAX_PINS, GLYPH } from './config.js';
import * as store from './store.js';
import { statusOf, filterByChain, filterByStatus, filterByDistance, sortByDistance } from './domain.js';

export var map = L.map("map", { zoomControl:false }).setView([38.7380, -9.1450], 13);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: 'Mapa e máquinas © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · estado reportado pela comunidade'
}).addTo(map);

// Marker taps are wired from main.js via setOnSelect, so this module never
// has to import ui.js (which itself depends on map.js for draw()/panTo()).
var onSelect = function(){};
export function setOnSelect(fn){ onSelect = fn; }

function icon(m, now){
  var s = statusOf(m, now);
  return L.divIcon({
    className: "",
    html: '<div class="pin' + (store.selected === m.id ? " is-sel" : "") +
          '" data-s="' + s + '">' + GLYPH[s] + '</div>',
    iconSize:[26,26], iconAnchor:[13,13]
  });
}

// The machines that pass the current chain + status filters, before any
// viewport cropping. This is also what "does this filter combination show
// anything at all" (app/ui.js's empty-state message) has to check against —
// it has to be the nationwide count, not what happens to be on screen, or
// panning to an empty corner of the map would look like the same dead end.
export function filtered(now){
  return filterByDistance(
    filterByStatus(filterByChain(store.machines, store.activeChain), store.activeStatuses, now),
    store.userPos, store.activeRadius
  );
}

/* With ~2.400 máquinas on the map, one marker each is more DOM than a phone
   can pan smoothly. Draw only what is on screen, and cap it — zoomed out to
   the whole country, a few thousand pins say nothing anyway. Prefer the
   machines nearest the user when their position is known (from locate),
   falling back to nearest-to-map-centre when it isn't. */

export function onScreen(now){
  var b = map.getBounds().pad(0.2);
  var list = filtered(now).filter(function(m){ return b.contains([m.lat, m.lng]); });

  if(list.length > MAX_PINS){
    if(store.userPos){
      list = sortByDistance(list, store.userPos).slice(0, MAX_PINS);
    } else {
      var c = map.getCenter();
      list = list.slice().sort(function(x, y){
        return ((x.lat-c.lat)*(x.lat-c.lat) + (x.lng-c.lng)*(x.lng-c.lng)) -
               ((y.lat-c.lat)*(y.lat-c.lat) + (y.lng-c.lng)*(y.lng-c.lng));
      }).slice(0, MAX_PINS);
    }
  }
  var sel = store.selected && store.find(store.selected);
  if(sel && list.indexOf(sel) === -1) list.push(sel);
  return list;
}

var markers = {};

export function draw(){
  var now = Date.now();
  var wanted = {};

  onScreen(now).forEach(function(m){
    wanted[m.id] = true;
    var key = statusOf(m, now) + (store.selected === m.id ? "!" : "");
    var mk = markers[m.id];
    if(mk){
      if(mk._k !== key){ mk.setIcon(icon(m, now)); mk._k = key; }
    } else {
      mk = L.marker([m.lat, m.lng], { icon: icon(m, now), keyboard:true })
            .addTo(map)
            .on("click", function(){ onSelect(m.id); });
      mk._k = key;
      markers[m.id] = mk;
    }
  });

  Object.keys(markers).forEach(function(id){
    if(!wanted[id]){
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
}
