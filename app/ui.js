// The bottom sheet, town search, chain filter chips, status filter chips,
// and toast.

import { LABEL, COLOR } from './config.js';
import * as store from './store.js';
import {
  statusOf, latest, needsReconfirm, ago, townsMatching, chainCounts,
  filterByChain, statusCounts, metresBetween, formatDistance,
} from './domain.js';
import { map, draw, filtered } from './map.js';
import { getFix, pushReport } from './api.js';

/* ───────── sheet ───────── */

var sheet = document.getElementById("sheet");

export function sheetHeight(){
  document.documentElement.style.setProperty(
    "--sheet-h", sheet.classList.contains("open") ? sheet.offsetHeight + "px" : "0px"
  );
}

export function select(id){
  store.setSelected(id);
  var m = store.find(id);
  if(!m) return;

  var now = Date.now();
  var s = statusOf(m, now), r = latest(m);

  document.getElementById("s-name").textContent = m.name;

  var addr = [m.town || (m.lat.toFixed(4) + ", " + m.lng.toFixed(4))];
  if(store.userPos) addr.push(formatDistance(metresBetween(store.userPos.lat, store.userPos.lng, m.lat, m.lng)));
  document.getElementById("s-addr").textContent = addr.join(" · ");

  var st = document.getElementById("s-state");
  st.textContent = LABEL[s] + (r && s !== "stale" ? " · " + ago(r.at, now) : "");
  st.style.background = COLOR[s];

  document.getElementById("s-ask").textContent =
    (r && s !== "stale" && needsReconfirm(r, now))
      ? "Ainda está assim?"
      : "Estiveste lá agora?";

  // Mark the choice that matches the machine's current state, so
  // "Ainda está assim?" has a visibly obvious answer to confirm. A stale
  // machine has no current state to mark — which is the point of stale.
  Array.prototype.forEach.call(document.querySelectorAll(".choice"), function(b){
    if(s !== "stale" && b.dataset.s === s) b.dataset.cur = "1";
    else delete b.dataset.cur;
  });

  // Mark the choice matching the machine's current state, so
  // "Ainda está assim?" has a visibly obvious answer to confirm. A stale
  // machine has no current state to mark — which is the point of stale.
  Array.prototype.forEach.call(document.querySelectorAll(".choice"), function(b){
    if(s !== "stale" && b.dataset.s === s) b.dataset.cur = "1";
    else delete b.dataset.cur;
  });

  var log = document.getElementById("s-log");
  log.innerHTML = (!m.reports || !m.reports.length)
    ? "<p>Ainda ninguém reportou esta máquina.</p>"
    : m.reports.slice(-6).reverse().map(function(x){
        return "<p><em>" + LABEL[x.s] + "</em><span>" + ago(x.at, now) + "</span></p>";
      }).join("");

  sheet.classList.add("open");
  requestAnimationFrame(sheetHeight);
  draw();
  map.panTo([m.lat, m.lng], { animate:true });

  // Warm the location fix so tapping a choice doesn't wait the full 6 s —
  // but only if permission is already granted, so opening a sheet never
  // triggers the browser's location prompt on its own.
  if(store.live && navigator.permissions){
    navigator.permissions.query({ name:"geolocation" })
      .then(function(p){ if(p.state === "granted") getFix(); })
      .catch(function(){});
  }
}

export function closeSheet(){
  store.setSelected(null);
  sheet.classList.remove("open");
  sheetHeight();
  draw();
}

/* ───────── filtros: cadeia + estado ───────── */
//
// Two independent dimensions, composed by AND: the chain chips narrow which
// machines are candidates at all, the status toggles narrow which of those
// are currently shown. Both share the same aftermath — recount, redraw,
// close whatever sheet was open (a filter change can hide the machine it
// was showing, same as the chain chips always did), and refresh the two
// "a filter is doing something" indicators.

var chainsEl = document.getElementById("chains");
var tallyEl = document.getElementById("tally");
var emptyEl = document.getElementById("empty");
var filterBadge = document.getElementById("filterbadge");

var STATUS_KEYS = ["ok", "full", "down", "stale"];
// The tally's own established wording (plural, lowercase) — kept distinct
// from LABEL, which is singular and capitalised for one machine's status in
// the sheet ("Cheia"), not a count of many ("12 cheias"). LABEL and COLOR
// are still reused directly: COLOR for every dot, LABEL for each toggle's
// accessible name.
var TALLY_WORD = { ok:"a funcionar", full:"cheias", down:"avariadas", stale:"sem dados" };

function isFiltering(){
  return store.activeChain !== null || store.activeStatuses.length < STATUS_KEYS.length;
}

// The empty-state message and the "a filter is active" badge both key off
// the *nationwide* filtered count, not what happens to be on screen — a
// filter that matches machines just outside the current viewport isn't a
// dead end, it's just a pan away.
function updateFilterState(){
  emptyEl.hidden = filtered(Date.now()).length > 0;
  filterBadge.hidden = !isFiltering();
}

function afterFilterChange(){
  buildTally();
  updateFilterState();
  closeSheet(); // matches what the chain chips already did before this existed
}

export function resetFilters(){
  store.setActiveChain(null);
  store.setActiveStatuses(STATUS_KEYS.slice());
  buildChainChips();
  afterFilterChange();
}

export function buildChainChips(){
  chainsEl.textContent = "";

  function addChip(label, value){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", store.activeChain === value);
    btn.addEventListener("click", function(){
      store.setActiveChain(store.activeChain === value ? null : value);
      buildChainChips();
      afterFilterChange();
    });
    chainsEl.appendChild(btn);
  }

  addChip("Todas", null);
  chainCounts(store.machines).forEach(function(c){ addChip(c.chain, c.chain); });
}

// Counts are for the *current chain filter*, not the national total — a
// count that ignores an active chain would lie about what tapping the
// toggle actually shows. They stay independent of the status filter itself,
// so a toggle that's off still shows what turning it on would reveal.
export function buildTally(){
  var now = Date.now();
  var counts = statusCounts(filterByChain(store.machines, store.activeChain), now);
  tallyEl.textContent = "";

  STATUS_KEYS.forEach(function(key){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", store.activeStatuses.indexOf(key) !== -1);
    btn.setAttribute("aria-label", LABEL[key]);

    var dot = document.createElement("i");
    dot.style.background = COLOR[key];

    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(counts[key] + " " + TALLY_WORD[key]));
    btn.addEventListener("click", function(){
      var cur = store.activeStatuses;
      store.setActiveStatuses(
        cur.indexOf(key) !== -1 ? cur.filter(function(s){ return s !== key; }) : cur.concat([key])
      );
      afterFilterChange();
    });

    tallyEl.appendChild(btn);
  });

  updateFilterState();
}

/* ───────── procura por concelho ───────── */

var qInput = document.getElementById("q");
var qResults = document.getElementById("results");

function goToTown(g){
  closeSheet();
  qInput.value = g.town;
  qInput.blur();
  qResults.classList.remove("open");

  if(g.s === g.n_ && g.w === g.e){
    map.setView([g.s, g.w], 16);
  } else {
    /* Keep the framed machines clear of the topbar. */
    map.fitBounds([[g.s, g.w], [g.n_, g.e]], {
      paddingTopLeft:[28, 128], paddingBottomRight:[28, 44], maxZoom:15
    });
  }
}

function renderResults(){
  qResults.textContent = "";

  if(!qInput.value.trim()){
    qResults.classList.remove("open");
    return;
  }

  var list = townsMatching(store.machines, qInput.value);

  if(!list.length){
    var none = document.createElement("p");
    none.textContent = "Nenhum concelho com esse nome.";
    qResults.appendChild(none);
  } else {
    list.forEach(function(g){
      var row = document.createElement("button");
      row.type = "button";

      var name = document.createElement("b");
      name.textContent = g.town;

      var count = document.createElement("span");
      count.textContent = g.n + (g.n === 1 ? " máquina" : " máquinas");

      row.appendChild(name);
      row.appendChild(count);
      row.addEventListener("click", function(){ goToTown(g); });
      qResults.appendChild(row);
    });
  }

  qResults.classList.add("open");
}

/* ───────── toast ───────── */

var toastEl = document.getElementById("toast"), toastTimer;
export function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, 2400);
}

/* ───────── wiring ───────── */

// One-time DOM listener setup for everything in this module. Called once
// from main.js during boot.
export function init(){
  map.on("click", closeSheet);
  map.on("moveend", draw);

  filterBadge.addEventListener("click", resetFilters);
  document.getElementById("empty-clear").addEventListener("click", resetFilters);

  qInput.addEventListener("input", renderResults);
  qInput.addEventListener("focus", renderResults);

  qInput.addEventListener("keydown", function(e){
    if(e.key === "Escape"){
      qInput.value = "";
      qResults.classList.remove("open");
      qInput.blur();
    } else if(e.key === "Enter"){
      var list = townsMatching(store.machines, qInput.value);
      if(list.length) goToTown(list[0]);
    }
  });

  document.addEventListener("click", function(e){
    if(!e.target || !e.target.closest || !e.target.closest(".search")){
      qResults.classList.remove("open");
    }
  });

  var choiceBtns = Array.prototype.slice.call(document.querySelectorAll(".choice"));

  choiceBtns.forEach(function(btn){
    btn.addEventListener("click", async function(){
      var m = store.find(store.selected);
      if(!m) return;

      choiceBtns.forEach(function(b){ b.disabled = true; });

      if(store.live) toast("A confirmar que estás junto à máquina…");
      var r = await pushReport(m.id, btn.dataset.s);

      if(r === "ok"){
        m.reports = (m.reports || []).concat([{ s: btn.dataset.s, at: Date.now() }]);
        store.localSave();
        select(m.id);
        buildTally();
        toast(store.live ? "Obrigado — toda a gente vê isto agora" : "Guardado neste dispositivo");
      } else if(r === "cooldown"){
        toast("Já reportaste esta máquina há pouco. Volta daqui a uns minutos.");
      } else if(r === "far"){
        toast("Só dá para reportar quando estás junto à máquina.");
      } else if(r === "flood"){
        toast("Muitos reports deste telemóvel hoje. Tenta mais logo.");
      } else if(r === "unknown"){
        toast("Esta máquina já não existe. Recarrega a página.");
      } else {
        toast("Não consegui guardar. Tenta outra vez.");
      }

      choiceBtns.forEach(function(b){ b.disabled = false; });
    });
  });
}
