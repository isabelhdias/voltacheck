// Wiring + boot: connects to Supabase (or falls back to local mode), then
// wires up the buttons that don't belong to sheet/search/chains — add
// machine, locate me — and starts the app.

import * as store from './store.js';
import * as api from './api.js';
import { CHAINS } from './config.js';
import { suggestTown, knownTowns } from './domain.js';
import { map, draw, setOnSelect } from './map.js';
import * as ui from './ui.js';

setOnSelect(ui.select);
ui.init();

function goLocal(msg){
  store.setLive(false);
  var badge = document.getElementById("mode");
  badge.textContent = "modo local";
  badge.dataset.live = "0";
  badge.title = "Os reports ficam só neste dispositivo.";
  store.setMachines(store.localLoad());
  if(msg) ui.toast(msg);
}

async function connect(){
  var result = await api.connect();
  if(result.live){
    var badge = document.getElementById("mode");
    badge.textContent = "em direto";
    badge.dataset.live = "1";
    badge.title = "Reports partilhados com toda a gente.";
  } else if(result.reason === "error"){
    goLocal("Sem ligação à base de dados — a mostrar dados locais");
  } else {
    goLocal();
  }
}

/* ───────── add machine ───────── */
//
// Grew from "drop a named pin" into a submission form: name, chain,
// concelho, an optional address and an optional note. In live mode this
// goes into a review queue and never touches the map or the store — a
// submission isn't a machine until someone approves it. Local mode is
// unchanged: no queue to speak of without a shared database, so it still
// adds directly, same as before.
//
// The concelho is a real field rather than something the database works out
// afterwards. It used to be derived from the nearest existing machine with
// no distance limit, which filed a submission 18.8 km from its neighbour
// under the neighbour's concelho — wrong, and invisible until a town search
// came up empty. It is still prefilled from a nearby machine, because
// that is right almost every time and saves typing, but it is prefilled
// into a box the person can see and correct, and only when there is
// something close enough to be worth suggesting.

var nameInput   = document.getElementById("add-name");
var chainSelect = document.getElementById("add-chain");
var townInput   = document.getElementById("add-town");
var addrInput   = document.getElementById("add-address");
var noteInput   = document.getElementById("add-note");
var townList    = document.getElementById("towns");
var saveBtn     = document.getElementById("add-save");

// Built from app/config.js's CHAINS, not hand-duplicated in index.html — one
// list, shared with the chain filter chips and tools/import_osm.py's own
// (necessarily separate, cross-language) copy.
(function buildChainOptions(){
  var outra = document.createElement("option");
  outra.value = "";
  outra.textContent = "Outra";
  chainSelect.appendChild(outra);
  CHAINS.forEach(function(c){
    var opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    chainSelect.appendChild(opt);
  });
})();

// Suggestions only — a concelho with no machine yet is still a legitimate
// answer, so the field stays free text and the list just saves typing.
function fillTownList(){
  townList.innerHTML = "";
  knownTowns(store.machines).forEach(function(t){
    var opt = document.createElement("option");
    opt.value = t;
    townList.appendChild(opt);
  });
}

document.getElementById("add").addEventListener("click", function(){
  ui.closeSheet();
  document.body.classList.add("adding");
  nameInput.value = "";
  chainSelect.value = "";
  addrInput.value = "";
  noteInput.value = "";

  fillTownList();
  var c = map.getCenter();
  townInput.value = suggestTown(store.machines, c.lat, c.lng);
});

document.getElementById("add-cancel").addEventListener("click", function(){
  document.body.classList.remove("adding");
});

saveBtn.addEventListener("click", async function(){
  var name = nameInput.value.trim();
  if(name.length < 3){
    nameInput.focus();
    ui.toast("Dá-lhe um nome para as pessoas a encontrarem");
    return;
  }

  var town = townInput.value.trim();
  if(!town){
    townInput.focus();
    ui.toast("Falta o concelho — é como as pessoas a encontram");
    return;
  }

  var chain = chainSelect.value || null;
  var addr  = addrInput.value.trim() || null;
  var note  = noteInput.value.trim() || null;
  var c = map.getCenter();
  saveBtn.disabled = true;

  var r = await api.submitMachine({ name:name, chain:chain, note:note,
                                    town:town, address:addr,
                                    lat:c.lat, lng:c.lng });

  if(r === "ok-local"){
    store.machines.push({ id: "u-" + Date.now(), name: name, lat: c.lat, lng: c.lng,
                           town: town, address: addr, chain: chain || "Outras",
                           src: "user", reports: [] });
    store.localSave();
    document.body.classList.remove("adding");
    ui.buildChainChips();
    ui.buildTally();
    draw();
    ui.toast("Máquina adicionada");
  } else if(r === "ok"){
    document.body.classList.remove("adding");
    ui.toast("Obrigado — fica em revisão antes de aparecer no mapa.");
  } else if(r === "cooldown"){
    ui.toast("Já enviaste uma máquina há pouco. Tenta daqui a uns minutos.");
  } else if(r === "flood"){
    ui.toast("Muitas máquinas enviadas deste telemóvel. Tenta mais logo.");
  } else if(r === "invalid"){
    ui.toast("Confirma o nome e a posição da máquina.");
  } else {
    ui.toast("Não consegui enviar. Tenta outra vez.");
  }

  saveBtn.disabled = false;
});

/* ───────── locate ───────── */

document.getElementById("locate").addEventListener("click", function(){
  if(!navigator.geolocation){ ui.toast("Localização indisponível neste dispositivo"); return; }
  ui.toast("A procurar-te…");

  function found(p){
    store.setUserPos({ lat:p.coords.latitude, lng:p.coords.longitude });
    map.setView([p.coords.latitude, p.coords.longitude], 15);
    draw();
    // Refreshes the open sheet, if any, so its distance line appears
    // without waiting for the next tap.
    if(store.selected) ui.select(store.selected);
  }

  // Ask for GPS first, but fall back to the coarse network fix. This matters
  // more here than it looks: the machines are inside supermarkets, so the
  // place someone taps this is the place a precise fix is least likely to
  // arrive before the timeout. Coarse is entirely good enough for framing
  // the map, and a failed high-accuracy attempt used to be the end of it.
  //
  // A refused permission is the one case not worth retrying — it fails the
  // same way instantly — and it is also the only one the person can fix, so
  // it gets its own message instead of the generic one.
  function retryCoarse(err){
    if(err && err.code === 1){
      ui.toast("Localização bloqueada. Ativa-a nas definições do browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      found,
      function(){ ui.toast("Não consegui obter a localização. Arrasta o mapa."); },
      { enableHighAccuracy:false, timeout:15000, maximumAge:300000 }
    );
  }

  navigator.geolocation.getCurrentPosition(
    found, retryCoarse,
    { enableHighAccuracy:true, timeout:8000, maximumAge:60000 }
  );
});

window.addEventListener("resize", ui.sheetHeight);

/* refresh when the app returns to the foreground */
document.addEventListener("visibilitychange", async function(){
  if(document.visibilityState === "visible" && store.live){
    try {
      await api.pull();
      ui.buildChainChips();
      ui.buildTally();
      draw();
      if(store.selected) ui.select(store.selected);
    } catch(e){}
  }
});

connect().then(function(){
  ui.buildChainChips();
  ui.buildTally();
  draw();
});
