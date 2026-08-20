// Wiring + boot: connects to Supabase (or falls back to local mode), then
// wires up the buttons that don't belong to sheet/search/chains — add
// machine, locate me — and starts the app.

import * as store from './store.js';
import * as api from './api.js';
import { CHAINS } from './config.js';
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
// Grew from "drop a named pin" into a submission form: name, chain, an
// optional note. In live mode this goes into a review queue and never
// touches the map or the store — a submission isn't a machine until someone
// approves it. Local mode is unchanged: no queue to speak of without a
// shared database, so it still adds directly, same as before.

var nameInput   = document.getElementById("add-name");
var chainSelect = document.getElementById("add-chain");
var noteInput   = document.getElementById("add-note");
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

document.getElementById("add").addEventListener("click", function(){
  ui.closeSheet();
  document.body.classList.add("adding");
  nameInput.value = "";
  chainSelect.value = "";
  noteInput.value = "";
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

  var chain = chainSelect.value || null;
  var note  = noteInput.value.trim() || null;
  var c = map.getCenter();
  saveBtn.disabled = true;

  var r = await api.submitMachine({ name:name, chain:chain, note:note, lat:c.lat, lng:c.lng });

  if(r === "ok-local"){
    store.machines.push({ id: "u-" + Date.now(), name: name, lat: c.lat, lng: c.lng,
                           town: "", chain: chain || "Outras", src: "user", reports: [] });
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
  navigator.geolocation.getCurrentPosition(
    function(p){
      store.setUserPos({ lat:p.coords.latitude, lng:p.coords.longitude });
      map.setView([p.coords.latitude, p.coords.longitude], 15);
      draw();
      // Refreshes the open sheet, if any, so its distance line appears
      // without waiting for the next tap.
      if(store.selected) ui.select(store.selected);
    },
    function(){ ui.toast("Não consegui obter a localização"); },
    { enableHighAccuracy:true, timeout:8000 }
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
