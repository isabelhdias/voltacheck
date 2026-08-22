// Leaflet map: tile layer, pins, clusters, viewport culling.
//
// The tally strip moved to app/ui.js — once it became a status filter with
// click handlers and closeSheet()/toast-style wiring, it fit ui.js's existing
// job (DOM controls + filter state) better than map.js's (Leaflet + pins).

import { MAX_PINS, GLYPH, CLUSTER_BELOW_ZOOM, CLUSTER_CELL_PX } from './config.js';
import * as store from './store.js';
import { paintOf, filterByChain, filterByStatus, filterByDistance, sortByDistance, clusterize } from './domain.js';

export var map = L.map("map", { zoomControl:false }).setView([38.7380, -9.1450], 13);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: 'Mapa e máquinas © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · estado reportado pela comunidade'
}).addTo(map);

// Marker taps are wired from main.js via setOnSelect, so this module never
// has to import ui.js (which itself depends on map.js for draw()/panTo()).
var onSelect = function(){};
export function setOnSelect(fn){ onSelect = fn; }

// A pin is painted from paintOf(), not statusOf(): an aged report keeps its
// colour and gets data-faded="1", which index.html draws washed out. Only a
// machine nobody has ever reported is grey.
function icon(m, now){
  var p = paintOf(m, now);
  return L.divIcon({
    className: "",
    html: '<div class="pin' + (store.selected === m.id ? " is-sel" : "") +
          '" data-s="' + p.tone + '"' + (p.faded ? ' data-faded="1"' : '') +
          '>' + GLYPH[p.tone] + '</div>',
    iconSize:[26,26], iconAnchor:[13,13]
  });
}

// What the drawn icon depends on, as a string, so draw() can skip setIcon()
// on pins that haven't changed. Crossing STALE_AFTER no longer changes the
// tone (it used to flip to "stale"), so `faded` has to be in here or an
// ageing pin would never be repainted.
function iconKey(m, now){
  var p = paintOf(m, now);
  return p.tone + (p.faded ? "~" : "") + (store.selected === m.id ? "!" : "");
}

// A group of machines, drawn as one counted bubble. Deliberately neutral —
// --ink and a number, never a status colour: a bubble stands for machines in
// every state at once, and painting it green or amber would claim a status
// nobody confirmed. It is also not class "pin", so the colour assertions in
// test/e2e/pin-colours.spec.js and decay.spec.js keep meaning what they say.
function clusterSize(count){ return count < 10 ? "s" : count < 100 ? "m" : "l"; }
var CLUSTER_PX = { s:32, m:40, l:48 };

function clusterIcon(g){
  var size = clusterSize(g.count), px = CLUSTER_PX[size];
  return L.divIcon({
    className: "",
    html: '<div class="cluster" data-size="' + size + '">' + g.count + '</div>',
    iconSize:[px, px], iconAnchor:[px/2, px/2]
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
   can pan smoothly. Draw only what is on screen, and cap it. Prefer the
   machines nearest the user when their position is known (from locate),
   falling back to nearest-to-map-centre when it isn't.

   This is the zoomed-in path. Zoomed out, the cap used to swallow most of
   the country in silence; that job now belongs to clustersOnScreen() below,
   which counts machines instead of dropping them. */

function inView(now){
  var b = map.getBounds().pad(0.2);
  return filtered(now).filter(function(m){ return b.contains([m.lat, m.lng]); });
}

export function onScreen(now){
  var list = inView(now);

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

// Leaflet allows fractional zoom levels, and the grid is defined at a whole
// one — read it in one place so the cells a bubble is placed in are the same
// cells it was grouped into.
function gridZoom(){ return Math.round(map.getZoom()); }

/* Below CLUSTER_BELOW_ZOOM the same viewport list is grouped instead of
   capped. No MAX_PINS here, and that is the point: one bubble per grid cell
   is a bounded number of markers however many machines it holds, so the map
   can count them all instead of dropping the ones past the cap.

   The selected machine is held out of the grid and drawn as its own pin —
   its sheet is open, so it has to stay visible and marked. */
export function clustersOnScreen(now){
  var sel = store.selected && store.find(store.selected);
  var list = inView(now).filter(function(m){ return !sel || m.id !== sel.id; });
  return clusterize(list, gridZoom(), CLUSTER_CELL_PX);
}

/* Where a bubble is drawn: over its machines, but never poking out of its own
   cell. Cells don't overlap, so a bubble kept inside one cannot overlap the
   bubble next door — the first draft placed them on the plain centroid and
   two coastal groups landed on top of each other, one number unreadable
   under the other. The nudge is at most half a bubble, so it still points at
   the machines it stands for. */
function clusterLatLng(g, px){
  var z = gridZoom(), r = px / 2, p = map.project([g.lat, g.lng], z);
  var lo = { x: g.cellX * CLUSTER_CELL_PX + r, y: g.cellY * CLUSTER_CELL_PX + r };
  var hi = { x: lo.x + CLUSTER_CELL_PX - px, y: lo.y + CLUSTER_CELL_PX - px };
  return map.unproject([
    Math.max(lo.x, Math.min(hi.x, p.x)),
    Math.max(lo.y, Math.min(hi.y, p.y))
  ], z);
}

// Markers are reconciled against what should be on screen, so a pan repaints
// only the difference. Keys are namespaced because pins and bubbles share the
// registry: "m:"+id for a machine, "c:"+cell for a group.
var markers = {};

function drawPin(m, now, wanted){
  var id = "m:" + m.id;
  wanted[id] = true;
  var key = iconKey(m, now);
  var mk = markers[id];
  if(mk){
    if(mk._k !== key){ mk.setIcon(icon(m, now)); mk._k = key; }
  } else {
    mk = L.marker([m.lat, m.lng], { icon: icon(m, now), keyboard:true })
          .addTo(map)
          .on("click", function(){ onSelect(m.id); });
    mk._k = key;
    markers[id] = mk;
  }
}

function drawCluster(g, wanted){
  var id = "c:" + g.key;
  wanted[id] = true;
  var at = clusterLatLng(g, CLUSTER_PX[clusterSize(g.count)]);
  var mk = markers[id];
  if(mk){
    // A filter can change who is in a cell without changing how many, so the
    // group behind the marker is always replaced; only the icon is memoised.
    if(mk._k !== g.count){ mk.setIcon(clusterIcon(g)); mk._k = g.count; }
    mk.setLatLng(at);
  } else {
    mk = L.marker(at, {
      icon: clusterIcon(g),
      keyboard: true,
      title: g.count + " máquinas aqui"
    }).addTo(map).on("click", function(){ zoomToCluster(mk._c); });
    mk._k = g.count;
    markers[id] = mk;
  }
  mk._c = g;
}

// Tapping a bubble opens it: frame its machines, stopping at zoom 16 so a
// tight group doesn't shoot to street level. When every machine in it sits on
// the same spot the bounds are a point and fitBounds would jump straight to
// maxZoom, so step in instead and let the next tap go further.
function zoomToCluster(g){
  var b = L.latLngBounds(g.machines.map(function(m){ return [m.lat, m.lng]; }));
  if(b.getNorth() === b.getSouth() && b.getEast() === b.getWest()){
    map.setView([g.lat, g.lng], Math.min(map.getZoom() + 3, 16));
  } else {
    map.fitBounds(b, { maxZoom: 16, padding: [48, 48] });
  }
}

export function draw(){
  var now = Date.now();
  var wanted = {};

  if(map.getZoom() < CLUSTER_BELOW_ZOOM){
    clustersOnScreen(now).forEach(function(g){
      if(g.count === 1) drawPin(g.machines[0], now, wanted);
      else drawCluster(g, wanted);
    });
    var sel = store.selected && store.find(store.selected);
    if(sel) drawPin(sel, now, wanted);
  } else {
    onScreen(now).forEach(function(m){ drawPin(m, now, wanted); });
  }

  Object.keys(markers).forEach(function(id){
    if(!wanted[id]){
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
}
