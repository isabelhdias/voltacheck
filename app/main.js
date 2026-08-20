// Wiring + boot: connects to Supabase (or falls back to local mode), then
// wires up the buttons that don't belong to sheet/search/chains — add
// machine, locate me — and starts the app.

import * as store from './store.js';
import * as api from './api.js';
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

var nameInput = document.getElementById("add-name");
var saveBtn   = document.getElementById("add-save");

document.getElementById("add").addEventListener("click", function(){
  ui.closeSheet();
  document.body.classList.add("adding");
  nameInput.value = "";
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

  var c = map.getCenter();
  saveBtn.disabled = true;

  var row = await api.pushMachine(name, c.lat, c.lng);

  if(row){
    store.machines.push({ id: row.id, name: name, lat: c.lat, lng: c.lng,
                           town: "", chain: "Outras", src: "user", reports: [] });
    store.localSave();
    document.body.classList.remove("adding");
    ui.buildTally();
    draw();
    ui.toast("Máquina adicionada");
  } else {
    ui.toast("Não consegui adicionar. Verifica a ligação.");
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
