// The bottom sheet, town search, chain filter chips, status filter chips,
// and toast.

import { LABEL, COLOR, FADED, FADED_INK } from './config.js';
import * as store from './store.js';
import {
  paintOf, latest, needsReconfirm, ago, townsMatching, chainCounts,
  filterByChain, statusCounts, metresBetween, formatDistance,
} from './domain.js';
import { map, draw, filtered } from './map.js';
import { getFix, pushReport } from './api.js';
import * as tel from './telemetry.js';

/* ───────── sheet ───────── */

var sheet = document.getElementById("sheet");

export function sheetHeight(){
  document.documentElement.style.setProperty(
    "--sheet-h", sheet.classList.contains("open") ? sheet.offsetHeight + "px" : "0px"
  );
}

// The absolute time of a report, pt-PT and short: "20/08, 14:32", with the
// year added only when it isn't the current one. `ago()` is what you read at
// a glance; this is what you check when the answer actually matters — and
// it's the thing a decayed machine used to stop telling you altogether.
//
// Intl lives here rather than in domain.js because it is locale- and
// timezone-dependent, and domain.js has to stay deterministic for the
// vectors (a Swift/Kotlin port will use its own platform formatter here).
function stampAt(ts, now){
  var d = new Date(ts);
  var opts = { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" };
  if(d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  try { return new Intl.DateTimeFormat("pt-PT", opts).format(d); }
  catch(e){ return d.toLocaleString(); }
}

export function select(id){
  // select() is also how the sheet is *refreshed* — after a locate, after a
  // report, after a foreground pull — so counting every call would put the
  // top of the report funnel several times higher than the number of people
  // who actually opened a machine. closeSheet() clears store.selected, so
  // "different from what was already selected" is exactly "newly opened".
  var reopened = store.selected !== id;
  store.setSelected(id);
  var m = store.find(id);
  if(!m) return;

  var now = Date.now();
  var p = paintOf(m, now), r = latest(m);
  if(reopened) tel.count("sheet.open", { state: p.tone });

  document.getElementById("s-name").textContent = m.name;

  var addr = [m.town || (m.lat.toFixed(4) + ", " + m.lng.toFixed(4))];
  if(store.userPos) addr.push(formatDistance(metresBetween(store.userPos.lat, store.userPos.lng, m.lat, m.lng)));
  document.getElementById("s-addr").textContent = addr.join(" · ");

  // The pill says what was reported and how long ago — now including
  // reports that have aged past STALE_AFTER, which used to collapse to a
  // bare "Sem dados recentes" that threw away both. A faded machine gets
  // the washed-out fill and the dark-hue text instead, so it still cannot
  // be mistaken for a current report.
  var st = document.getElementById("s-state");
  st.textContent = LABEL[p.tone] + (r ? " · " + ago(r.at, now) : "");
  st.style.background = p.faded ? FADED[p.tone] : COLOR[p.tone];
  st.style.color      = p.faded ? FADED_INK[p.tone] : "#fff";
  st.style.boxShadow  = p.faded ? "inset 0 0 0 1.5px " + COLOR[p.tone] : "none";
  if(p.faded) st.dataset.faded = "1"; else delete st.dataset.faded;

  // The timestamp itself, absolute, whenever there is one to show. When the
  // report has aged out, "sem dados recentes" is spelled out beside it in
  // stale grey — the faded pill must never be the only thing saying so.
  var stamp = document.getElementById("s-stamp");
  stamp.textContent = r ? "Último report: " + stampAt(r.at, now) : "";
  if(r && p.faded){
    stamp.appendChild(document.createTextNode(" · "));
    var warn = document.createElement("b");
    warn.textContent = "sem dados recentes";
    stamp.appendChild(warn);
  }
  stamp.hidden = !r;

  // Same rule as before the fade landed: reconfirmation is only offered for
  // a report that is still current (3 h–18 h old). `!p.faded` with a report
  // present is exactly `statusOf(...) !== "stale"` — see the composed
  // prompt rule in docs/domain-contract.md.
  document.getElementById("s-ask").textContent =
    (r && !p.faded && needsReconfirm(r, now))
      ? "Ainda está assim?"
      : "Estiveste lá agora?";

  // Mark the choice that matches the machine's current state, so
  // "Ainda está assim?" has a visibly obvious answer to confirm. Nothing is
  // marked once the report has aged out: a faded state is not a current one
  // to agree with, and pre-ticking it would be the app nodding along to
  // something it no longer knows.
  Array.prototype.forEach.call(document.querySelectorAll(".choice"), function(b){
    if(!p.faded && p.tone !== "stale" && b.dataset.s === p.tone) b.dataset.cur = "1";
    else delete b.dataset.cur;
  });

  var log = document.getElementById("s-log");
  log.innerHTML = (!m.reports || !m.reports.length)
    ? "<p>Ainda ninguém reportou esta máquina.</p>"
    : m.reports.slice(-6).reverse().map(function(x){
        return '<p title="' + stampAt(x.at, now) + '"><em>' + LABEL[x.s] +
               "</em><span>" + ago(x.at, now) + "</span></p>";
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

var chainsEl    = document.getElementById("chains");
var statusListEl= document.getElementById("statuslist");
var radiusEl    = document.getElementById("radius");
var radiusHint  = document.getElementById("radius-hint");
var emptyEl     = document.getElementById("empty");
var filterBar   = document.getElementById("filterbar");
var filterBtn   = document.getElementById("filterbtn");
var filterCount = document.getElementById("filtercount");
var filtersEl   = document.getElementById("filters");
var scrimEl     = document.getElementById("scrim");
var countEl     = document.getElementById("count");
var clearEl     = document.getElementById("clear");
var statusOfEl  = document.getElementById("status-of");

var STATUS_KEYS = ["ok", "full", "down", "stale"];

// Plural, lowercase — a count of many, not one machine's state. LABEL stays
// singular and capitalised for the sheet ("Cheia"), and both are still used:
// LABEL for accessible names, COLOR for every dot.
var STATUS_WORD = { ok:"A funcionar", full:"Cheias", down:"Avariadas", stale:"Sem dados há 18 h" };

// How many chains to show before "+ N cadeias". Eleven chips is a wall;
// four covers the large majority of machines and the rest are one tap away.
var CHAINS_SHOWN = 4;
var chainsExpanded = false;

var RADII = [
  { label:"1 km",  metres:1000 },
  { label:"5 km",  metres:5000 },
  { label:"25 km", metres:25000 },
  { label:"Todas", metres:null },
];

function isFiltering(){
  return store.activeChain !== null
      || store.activeStatuses.length < STATUS_KEYS.length
      || store.activeRadius !== null;
}

function activeFilterCount(){
  var n = 0;
  if(store.activeChain !== null) n++;
  if(store.activeStatuses.length < STATUS_KEYS.length) n++;
  if(store.activeRadius !== null) n++;
  return n;
}

/* ───────── barra de filtros ───────── */

// One chip per active filter, each removing just that filter. Undoing is the
// commonest thing done to a filter and shouldn't need the sheet reopened.
function buildFilterBar(){
  Array.prototype.slice.call(filterBar.querySelectorAll(".fchip"))
    .forEach(function(el){ el.remove(); });

  function chip(text, colour, onRemove){
    var b = document.createElement("button");
    b.type = "button";
    b.className = "fchip";
    if(colour){
      var dot = document.createElement("i");
      dot.style.background = colour;
      b.appendChild(dot);
    }
    b.appendChild(document.createTextNode(text));
    var x = document.createElement("b");
    x.textContent = "×";
    b.appendChild(x);
    b.setAttribute("aria-label", "Remover filtro: " + text);
    b.addEventListener("click", function(){ onRemove(); afterFilterChange(); });
    filterBar.appendChild(b);
  }

  // Statuses chip individually, so turning one back on is one tap.
  if(store.activeStatuses.length < STATUS_KEYS.length){
    store.activeStatuses.forEach(function(k){
      chip(STATUS_WORD[k], COLOR[k], function(){
        store.setActiveStatuses(store.activeStatuses.filter(function(s){ return s !== k; }));
        // Removing the last one means "no status filter", not "empty map".
        if(!store.activeStatuses.length) store.setActiveStatuses(STATUS_KEYS.slice());
      });
    });
  }
  if(store.activeChain !== null){
    chip(store.activeChain, null, function(){ store.setActiveChain(null); });
  }
  if(store.activeRadius !== null){
    var r = RADII.filter(function(x){ return x.metres === store.activeRadius; })[0];
    chip(r ? r.label : "Distância", null, function(){ store.setActiveRadius(null); });
  }

  var n = activeFilterCount();
  filterCount.textContent = n;
  filterCount.hidden = n === 0;
}

// The count and the empty state both key off the *nationwide* filtered
// total, not what's on screen — a filter matching machines just outside the
// viewport isn't a dead end, it's a pan away.
function updateFilterState(){
  var n = filtered(Date.now()).length;
  emptyEl.hidden = n > 0;
  countEl.textContent = n === 1 ? "1 máquina neste mapa" : n + " máquinas neste mapa";
  clearEl.hidden = !isFiltering();
  var applyBtn = document.getElementById("filters-apply");
  if(applyBtn) applyBtn.textContent = n === 1 ? "Ver 1 máquina" : "Ver " + n + " máquinas";
}

function afterFilterChange(){
  buildStatusList();
  buildChainChips();
  buildRadius();
  buildFilterBar();
  updateFilterState();
  closeSheet();
  draw();
}

export function resetFilters(){
  store.setActiveChain(null);
  store.setActiveStatuses(STATUS_KEYS.slice());
  store.setActiveRadius(null);
  chainsExpanded = false;
  afterFilterChange();
}

/* ───────── estado ───────── */

// Counts follow the *chain* filter but not the status filter: a count that
// ignored an active chain would lie about what the toggle shows, while one
// that followed the status filter would zero out every row you turned off.
export function buildStatusList(){
  var now = Date.now();
  var counts = statusCounts(filterByChain(store.machines, store.activeChain), now);
  statusListEl.textContent = "";

  STATUS_KEYS.forEach(function(key){
    var on = store.activeStatuses.indexOf(key) !== -1;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", on);
    btn.setAttribute("aria-label", LABEL[key]);

    var box = document.createElement("u");
    box.textContent = on ? "✓" : "";
    var dot = document.createElement("i");
    dot.style.background = COLOR[key];
    var name = document.createElement("span");
    name.textContent = STATUS_WORD[key];
    var num = document.createElement("b");
    num.textContent = counts[key];

    btn.appendChild(box); btn.appendChild(dot);
    btn.appendChild(name); btn.appendChild(num);
    btn.addEventListener("click", function(){
      var cur = store.activeStatuses;
      var next = cur.indexOf(key) !== -1
        ? cur.filter(function(s){ return s !== key; })
        : cur.concat([key]);
      // Which way it went is the interesting half: everything starts on, so
      // an "off" is someone hiding a state and an "on" is them putting it
      // back. Counting only the taps would make those indistinguishable.
      tel.count("filter.status",
                { status: key, state: next.length < cur.length ? "off" : "on" });
      // All four off is indistinguishable from a blank map and no one means
      // it; treat clearing the last one as clearing the filter.
      store.setActiveStatuses(next.length ? next : STATUS_KEYS.slice());
      afterFilterChange();
    });
    statusListEl.appendChild(btn);
  });

  statusOfEl.textContent = store.activeStatuses.length + " de " + STATUS_KEYS.length;
}

/* ───────── cadeia ───────── */

export function buildChainChips(){
  chainsEl.textContent = "";
  var all = chainCounts(store.machines);
  var shown = chainsExpanded ? all : all.slice(0, CHAINS_SHOWN);

  // An active chain outside the collapsed slice must still be visible, or
  // the sheet would show no chain selected while one plainly is.
  if(store.activeChain !== null && !shown.some(function(c){ return c.chain === store.activeChain; })){
    var hit = all.filter(function(c){ return c.chain === store.activeChain; })[0];
    if(hit) shown = shown.concat([hit]);
  }

  shown.forEach(function(c){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", store.activeChain === c.chain);
    btn.appendChild(document.createTextNode(c.chain));
    var n = document.createElement("em");
    n.textContent = c.count;
    btn.appendChild(n);
    btn.addEventListener("click", function(){
      if(store.activeChain !== c.chain) tel.count("filter.chain", { chain: c.chain });
      store.setActiveChain(store.activeChain === c.chain ? null : c.chain);
      afterFilterChange();
    });
    chainsEl.appendChild(btn);
  });

  var rest = all.length - shown.length;
  if(rest > 0 || chainsExpanded){
    var more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = chainsExpanded ? "Ver menos" : "+ " + rest + (rest === 1 ? " cadeia" : " cadeias");
    more.addEventListener("click", function(){
      chainsExpanded = !chainsExpanded;
      buildChainChips();
    });
    chainsEl.appendChild(more);
  }
}

/* ───────── distância ───────── */

export function buildRadius(){
  radiusEl.textContent = "";
  RADII.forEach(function(r){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = r.label;
    btn.setAttribute("aria-pressed", store.activeRadius === r.metres);
    btn.addEventListener("click", function(){ pickRadius(r.metres); });
    radiusEl.appendChild(btn);
  });
  radiusHint.hidden = !(store.activeRadius !== null && !store.userPos);
}

// Picking a distance is a deliberate tap, so it may ask for location the
// same way the locate button does — the second and only other place in the
// app that reaches for geolocation. "Todas" never asks: it needs no
// position, and asking would be a prompt for nothing.
function pickRadius(metres){
  tel.count("filter.distance", { km: metres === null ? "todas" : String(metres / 1000) });
  if(metres === null || store.userPos){
    store.setActiveRadius(metres);
    afterFilterChange();
    return;
  }
  if(!navigator.geolocation){
    toast("Localização indisponível neste dispositivo");
    return;
  }
  toast("A procurar-te…");
  navigator.geolocation.getCurrentPosition(
    function(p){
      store.setUserPos({ lat:p.coords.latitude, lng:p.coords.longitude });
      store.setActiveRadius(metres);
      afterFilterChange();
      if(store.selected) select(store.selected);
    },
    function(){
      // Apply it anyway. filterByDistance with no position returns
      // everything, so the map stays honest instead of going blank, and the
      // hint under the control says why the radius isn't biting.
      store.setActiveRadius(metres);
      afterFilterChange();
      toast("Não consegui obter a localização");
    },
    { enableHighAccuracy:true, timeout:8000, maximumAge:60000 }
  );
}

/* ───────── abrir e fechar o painel ───────── */

// The sheet is unhidden first and only gains `open` on the next frame, so
// the CSS transition has a from-state to animate out of. That frame is the
// problem below — see closeFilters().
var openRaf = null;

export function openFilters(){
  closeSheet();
  buildStatusList();
  buildChainChips();
  buildRadius();
  updateFilterState();
  filtersEl.hidden = false;
  scrimEl.hidden = false;
  openRaf = requestAnimationFrame(function(){
    openRaf = null;
    filtersEl.classList.add("open");
    scrimEl.classList.add("open");
  });
  filterBtn.setAttribute("aria-expanded", "true");
}

export function closeFilters(){
  // Cancel the frame openFilters() scheduled, if it has not run yet. A close
  // can land inside that window — Escape straight after the tap, or a fast
  // double tap — and if the frame then runs it re-adds `open` after this
  // removed it. The timeout below checks for `open` before hiding anything,
  // so it declines, and the sheet is left visible with nothing pending to
  // close it: stuck open until the next tap. Rare by hand, reliable under
  // Playwright, which is where it showed up.
  if(openRaf !== null){ cancelAnimationFrame(openRaf); openRaf = null; }
  filtersEl.classList.remove("open");
  scrimEl.classList.remove("open");
  filterBtn.setAttribute("aria-expanded", "false");
  setTimeout(function(){
    if(!filtersEl.classList.contains("open")){
      filtersEl.hidden = true;
      scrimEl.hidden = true;
    }
  }, 240);
}

/* ───────── procura por concelho ───────── */

var qInput = document.getElementById("q");
var qResults = document.getElementById("results");

function goToTown(g){
  // Counted here rather than on every keystroke: this is a concelho that
  // exists and was chosen, so the dimension stays bounded to the 308 real
  // ones. Nothing anybody types is ever sent.
  tel.count("search.town", { town: g.town });
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

  filterBtn.addEventListener("click", openFilters);
  scrimEl.addEventListener("click", closeFilters);
  document.getElementById("filters-apply").addEventListener("click", closeFilters);
  document.getElementById("filters-clear").addEventListener("click", function(){
    resetFilters();
    updateFilterState();
  });
  clearEl.addEventListener("click", resetFilters);
  document.getElementById("empty-clear").addEventListener("click", function(){
    resetFilters();
    closeFilters();
  });
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && !filtersEl.hidden) closeFilters();
  });

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
      tel.count("report.tap", { status: btn.dataset.s });

      if(store.live) toast("A confirmar que estás junto à máquina…");
      var r = await pushReport(m.id, btn.dataset.s);

      if(r === "ok"){
        m.reports = (m.reports || []).concat([{ s: btn.dataset.s, at: Date.now() }]);
        store.localSave();
        select(m.id);
        buildStatusList();
        buildFilterBar();
        updateFilterState();
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

// Called whenever the machine list itself changes (first load, a refresh, a
// locally added machine). One entry point so callers don't have to know
// which pieces of the filter UI are derived from the data.
export function refreshFilters(){
  buildStatusList();
  buildChainChips();
  buildRadius();
  buildFilterBar();
  updateFilterState();
}
