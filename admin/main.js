// Wiring for the panel: walk the person through getting a session the
// database will accept, then draw the four screens.
//
// The order below is the whole security story, and it is worth reading once:
// nothing here decides whether someone may see data. It gets a session, asks
// the database a question, and shows either the answer or the reason there
// isn't one. `public.is_admin()` is the gate — uid on the allowlist, `aal2`
// in the token, email still matching — and no arrangement of this file can
// talk it round.

import { RELEASE } from '../app/config.js';
import * as auth from './auth.js';
import { TABS } from './screens.js';
import * as api from './data.js';

var gate     = document.getElementById("gate");
var panel    = document.getElementById("panel");
var errEl    = document.getElementById("gate-err");
var noteEl   = document.getElementById("gate-note");
var forms    = {
  login:    document.getElementById("login"),
  mfa:      document.getElementById("mfa"),
  enrol:    document.getElementById("enrol"),
  notadmin: document.getElementById("notadmin"),
};

function show(which){
  Object.keys(forms).forEach(function(k){ forms[k].hidden = (k !== which); });
  errEl.textContent = "";
}

function fail(e){
  errEl.textContent = auth.readable(e);
}

function busy(form, on){
  var b = form.querySelector("button");
  if(b) b.disabled = on;
}

/* ───────── boot ───────── */

var reason = auth.init();
if(reason === "no-config"){
  // The PR-preview case, and the "cloned it and blanked the keys" case. The
  // panel cannot work without a project, and saying so beats an empty page.
  show("login");
  forms.login.hidden = true;
  noteEl.textContent =
    "No Supabase project configured — app/config.js is empty. " +
    "PR previews always run like this, on purpose.";
} else if(reason === "no-script"){
  show("login");
  forms.login.hidden = true;
  noteEl.textContent = "Could not load supabase-js. Check the connection and reload.";
} else {
  route();
}

async function route(){
  try {
    var st = await auth.state();
    if(st === "anon")        return show("login");
    if(st === "needs-enrol") return startEnrol();
    if(st === "needs-mfa")   return show("mfa");
    return openPanel();
  } catch(e){
    show("login");
    fail(e);
  }
}

/* ───────── the three forms ───────── */

forms.login.addEventListener("submit", async function(e){
  e.preventDefault();
  busy(forms.login, true);
  errEl.textContent = "";
  try {
    await auth.signIn(
      document.getElementById("email").value.trim(),
      document.getElementById("pw").value,
    );
    document.getElementById("pw").value = "";
    await route();
  } catch(err){
    fail(err);
  }
  busy(forms.login, false);
});

forms.mfa.addEventListener("submit", async function(e){
  e.preventDefault();
  busy(forms.mfa, true);
  errEl.textContent = "";
  try {
    await auth.verify(document.getElementById("code").value.trim());
    await openPanel();
  } catch(err){
    document.getElementById("code").value = "";
    fail(err);
  }
  busy(forms.mfa, false);
});

var enrolFactor = null;

async function startEnrol(){
  show("enrol");
  noteEl.textContent = "";
  try {
    var f = await auth.enrol();
    enrolFactor = f.id;
    // Supabase hands back the QR as an SVG string or a data: URL depending on
    // the client version, so both are handled rather than guessed at.
    var qr = document.getElementById("qr");
    qr.innerHTML = /^data:/.test(f.qr) ? '<img alt="QR code" src="' + f.qr + '">' : f.qr;
    document.getElementById("secret").value = f.secret;
  } catch(err){
    fail(err);
  }
}

forms.enrol.addEventListener("submit", async function(e){
  e.preventDefault();
  busy(forms.enrol, true);
  errEl.textContent = "";
  try {
    await auth.confirmEnrol(enrolFactor, document.getElementById("enrolcode").value.trim());
    await openPanel();
  } catch(err){
    document.getElementById("enrolcode").value = "";
    fail(err);
  }
  busy(forms.enrol, false);
});

document.getElementById("signout").addEventListener("click", async function(){
  await auth.signOut();
  location.reload();
});

/* ───────── the panel ───────── */

async function openPanel(){
  // Having a session at aal2 is not the same as being an admin, and only the
  // database knows which. Asking it first — before drawing anything — is what
  // turns "the screens are all empty and I don't know why" into a sentence
  // that says what to do about it.
  try {
    await api.overview();
  } catch(err){
    if(err.denied) return showNotAdmin();
    show("login");
    return fail(err);
  }

  gate.hidden = true;
  panel.hidden = false;
  document.getElementById("release").textContent = RELEASE;
  buildTabs();
}

async function showNotAdmin(){
  show("notadmin");
  var s = await auth.session();
  var id = auth.uid(s) || "<your-uid>";
  var mail = auth.email(s) || "";
  document.getElementById("grantsql").textContent =
    "insert into private.admins (uid, email)\n" +
    "values ('" + id + "', '" + mail + "');";
}

function buildTabs(){
  var nav = document.getElementById("tabs");
  var screen = document.getElementById("screen");
  nav.textContent = "";

  TABS.forEach(function(t, i){
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(nav.children, function(x){
        x.setAttribute("aria-selected", x === b ? "true" : "false");
      });
      draw(t);
    });
    nav.appendChild(b);
  });

  draw(TABS[0]);

  async function draw(tab){
    screen.innerHTML = '<p class="empty">Loading…</p>';
    try {
      screen.innerHTML = await tab.render();
    } catch(err){
      // A screen that fails says so. Half a dashboard that looks whole is
      // how you end up acting on a number that isn't there.
      screen.innerHTML = '<div class="panelbox"><p class="empty">' +
        (err.denied
          ? "The database refused this read. Is this session still an admin?"
          : "Could not load this screen: " + auth.readable(err)) +
        '</p></div>';
    }
  }
}
