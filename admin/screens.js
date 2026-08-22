// The four screens. Each one is an async function returning HTML, and each
// makes as few round trips as it can get away with — a phone on a mobile
// connection would rather ask four questions than forty.
//
// This panel is in English. The app itself is Portuguese and stays that way;
// the split is deliberate — the map is for people in Portugal, the dashboard
// is for whoever maintains it.

import * as api from './data.js';
import * as c from './charts.js';

var DAYS = 30;

function tile(k, v, s, wide){
  return '<div class="tile' + (wide ? " wide" : "") + '">' +
         '<div class="k">' + k + '</div><div class="v">' + v + '</div>' +
         (s ? '<div class="s">' + s + '</div>' : "") + '</div>';
}

function box(caption, body){
  return '<div class="panelbox"><figure>' +
         (caption ? '<figcaption>' + caption + '</figcaption>' : "") +
         body + '</figure></div>';
}

function ago(iso){
  if(!iso) return "never";
  var m = Math.round((Date.now() - new Date(iso)) / 60000);
  if(m < 1) return "just now";
  if(m < 60) return m + " min ago";
  if(m < 1440) return Math.round(m / 60) + " h ago";
  return Math.round(m / 1440) + " days ago";
}

/* ───────── 1. Now ───────── */

export async function now(){
  var o = await api.overview();
  var r24 = o.reports.h24 || {};
  var total24 = (r24.ok || 0) + (r24.full || 0) + (r24.down || 0);

  var html = "";

  html += '<section><h2>Coverage</h2><div class="tiles">';
  html += tile("Live coverage", c.pct(o.coverage_pm),
    c.num(o.machines.total - o.machines.never_reported) + " of " + c.num(o.machines.total) +
    " machines have ever been reported", true);
  html += '</div><div class="panelbox" style="margin-top:10px">' + c.meter(o.coverage_pm) +
    '<p class="s" style="font-size:12px;color:var(--ink-faint);margin:8px 0 0">' +
    'Machines carrying a report from the last 18 h — the same threshold that fades a pin. ' +
    'This is the number that says whether the app is working.</p></div></section>';

  html += '<section><h2>Machines</h2><div class="tiles">';
  html += tile("On the map", c.num(o.machines.total));
  html += tile("New in 7 days", c.num(o.machines.new_7d));
  html += tile("Never reported", c.num(o.machines.never_reported));
  html += tile("Awaiting review", c.num(o.submissions.pending),
    o.submissions.pending ? "oldest " + c.num(o.submissions.oldest_h) + " h ago" : "queue empty");
  html += '</div></section>';

  html += '<section><h2>Reports (24 h)</h2><div class="tiles">';
  html += tile("Total", c.num(total24), "all time: " + c.num(o.reports.total));
  html += tile("Working", c.num(r24.ok || 0));
  html += tile("Full", c.num(r24.full || 0));
  html += tile("Broken", c.num(r24.down || 0));
  html += '</div></section>';

  html += '<section><h2>Today</h2><div class="tiles">';
  html += tile("Visits", c.num(o.traffic.visits_today));
  html += tile("Sessions", c.num(o.traffic.sessions_today));
  html += tile("Errors", c.num(o.traffic.errors_today));
  html += tile("Last telemetry", ago(o.telemetry.last_seen));
  html += '</div>';
  if(!o.telemetry.last_seen){
    html += '<div class="panelbox" style="margin-top:10px"><p class="empty">' +
      'No telemetry has arrived yet. Local mode and PR previews send nothing at all — ' +
      'only the live site counts.</p></div>';
  }
  html += '</section>';

  return html;
}

/* ───────── 2. Activity ───────── */

export async function activity(){
  var rows = await api.series(DAYS, [
    "reports.filed", "machines.new", "app.visit", "app.session", "submissions.outcome",
  ]);
  var days = api.lastDays(DAYS);

  var reports = api.byDayAnd(rows, "reports.filed", "status");
  var repSeries = [
    { name:"Working", color:c.COLOR.ok,   values: reports.ok   || {} },
    { name:"Full",    color:c.COLOR.full, values: reports.full || {} },
    { name:"Broken",  color:c.COLOR.down, values: reports.down || {} },
  ];

  var visits = api.byDay(rows, "app.visit");
  var sessions = api.byDay(rows, "app.session");
  var machines = api.byDayAnd(rows, "machines.new", "source");
  var subs = api.byDay(rows, "submissions.outcome", { outcome:"ok" });

  var html = "";

  html += '<section><h2>Reports per day</h2>' +
    box(c.num(api.sum(reports.ok || {}) + api.sum(reports.full || {}) + api.sum(reports.down || {})) +
        " in the last " + DAYS + " days",
        c.bars(days, repSeries, { title:"Reports per day", emptyText:"No reports in this period." }) +
        c.legend(repSeries)) + '</section>';

  html += '<section><h2>Visits</h2>' +
    box(c.num(api.sum(visits)) + " visits · " + c.num(api.sum(sessions)) + " sessions",
        c.bars(days, [
          { name:"Visits", color:c.COLOR.blue, values:visits },
        ], { title:"Visits per day", emptyText:"No telemetry in this period." }) +
        '<figcaption style="margin-top:10px">Sessions per day</figcaption>' +
        c.line(days, sessions, { title:"Sessions per day", color:c.COLOR.ink, height:60,
                                 emptyText:"" })) +
    '</section>';

  html += '<section><h2>The map growing</h2>' +
    box("New machines per day, and submissions accepted",
        c.bars(days, [
          { name:"Imported (OSM)", color:c.COLOR.soft, values: machines.osm  || {} },
          { name:"Added",          color:c.COLOR.blue, values: machines.user || {} },
          { name:"Submissions",    color:c.COLOR.full, values: subs },
        ], { title:"New machines", emptyText:"Nothing new in this period." }) +
        c.legend([
          { name:"Imported (OSM)", color:c.COLOR.soft },
          { name:"Added", color:c.COLOR.blue },
          { name:"Submissions", color:c.COLOR.full },
        ])) + '</section>';

  return html;
}

/* ───────── 3. Behaviour ───────── */

// The strings report_machine() and submit_machine() return, in words. The
// database keeps the terse ones because the app maps them to its own
// Portuguese; this is the only place they are read by a person.
var OUTCOME = {
  ok:"Accepted", far:"Too far away", nopos:"No location shared",
  cooldown:"Repeated too soon", flood:"Too many", unknown:"Unknown machine",
  invalid:"Invalid", erro:"Network failed",
};

export async function behaviour(){
  var rows = await api.series(DAYS, [
    "app.visit", "sheet.open", "report.tap", "report.result",
    "reports.outcome", "locate.tap", "filter.distance", "filter.status",
  ]);
  var towns = await api.top("search.town", DAYS, 8);
  var chains = await api.top("filter.chain", DAYS, 8);

  function totalOf(metric, where){ return api.sum(api.byDay(rows, metric, where)); }

  var visits = totalOf("app.visit");
  var opens = totalOf("sheet.open");
  var taps = totalOf("report.tap");
  var okd = totalOf("report.result", { outcome:"ok" });

  var html = "";

  // The funnel, as four numbers with the drop between them spelled out —
  // percentages of the previous step, because "8% of visits report" hides
  // whether people are not opening machines or not finishing.
  function step(label, n, prev){
    var s = prev ? c.pct(Math.round((n / prev) * 1000)) + " of the previous step" : "";
    return tile(label, c.num(n), s);
  }
  html += '<section><h2>From map to report</h2><div class="tiles">';
  html += step("Opened the map", visits, 0);
  html += step("Opened a machine", opens, visits);
  html += step("Tapped a state", taps, opens);
  html += step("Recorded", okd, taps);
  html += '</div></section>';

  // The most actionable panel in the whole dashboard: until this existed, a
  // report rejected as "too far" left no trace anywhere, so a proximity rule
  // turning away real people looked exactly like a quiet week.
  var outcomes = {};
  rows.forEach(function(r){
    if(r.m !== "reports.outcome") return;
    var k = (r.k || {}).outcome || "—";
    outcomes[k] = (outcomes[k] || 0) + Number(r.v || 0);
  });
  var outRows = Object.keys(outcomes).sort(function(a, b){ return outcomes[b] - outcomes[a]; })
    .map(function(k){
      return { label: OUTCOME[k] || k, value: outcomes[k],
               color: k === "ok" ? c.COLOR.ok : (k === "far" ? c.COLOR.down : c.COLOR.full) };
    });
  html += '<section><h2>What the database answered</h2>' +
    box("Every report attempted, accepted and rejected, in the last " + DAYS + " days",
        c.hbars(outRows, { emptyText:"No reports attempted in this period." }) +
        '<p class="empty" style="margin-top:10px">If “too far away” is a big slice, the 5 km ' +
        'radius is turning away real people. “No location shared” is the same question for the ' +
        'rule that a report must carry a position at all — together they are what the ' +
        'proximity check costs.</p>') +
    '</section>';

  html += '<section><h2>What people look for</h2>';
  html += box("Concelhos searched", c.hbars(towns.map(function(t){
    return { label: t.k.town, value: Number(t.v) };
  }), { emptyText:"Nobody has searched yet." }));
  html += box("Chains filtered", c.hbars(chains.map(function(t){
    return { label: t.k.chain, value: Number(t.v) };
  }), { emptyText:"Nobody has filtered by chain yet." }));
  html += '</section>';

  // Refused and timed out are counted apart on purpose: one is a choice the
  // person made, the other is the app failing them indoors, and only the
  // second is something to fix.
  var loc = {};
  rows.forEach(function(r){
    if(r.m !== "locate.tap") return;
    var k = (r.k || {}).outcome || "—";
    loc[k] = (loc[k] || 0) + Number(r.v || 0);
  });
  var LOCATE = { granted:"Shared location", denied:"Refused", timeout:"Timed out",
                 unavailable:"Unavailable on device" };
  html += '<section><h2>Location</h2>' +
    box("The locate button", c.hbars(Object.keys(loc).map(function(k){
      return { label: LOCATE[k] || k, value: loc[k],
               color: k === "granted" ? c.COLOR.ok : c.COLOR.stale };
    }), { emptyText:"Nobody has tapped locate." })) + '</section>';

  return html;
}

/* ───────── 4. Health ───────── */

// Roughly what one machine costs on the wire, gzipped, in the pull the app
// does on every visit. Measured off the real payload rather than guessed, and
// deliberately a constant here so the estimate below is legible as an
// estimate — see docs/observability-plan.md.
var BYTES_PER_MACHINE = 40;

export async function health(){
  var rows = await api.series(DAYS, ["db.pull.duration", "db.rpc.duration", "app.boot.duration", "app.visit", "app.error"]);
  var errs = await api.errors(24 * 7, 12);
  var tr = await api.traces(8);
  var o = await api.overview();
  var days = api.lastDays(DAYS);

  function latest(metric, where, field){
    var m = api.latencyByDay(rows, metric, where), k = days.slice().reverse();
    for(var i = 0; i < k.length; i++){ if(m[k[i]] && m[k[i]][field] != null) return m[k[i]][field]; }
    return null;
  }

  var html = "";

  html += '<section><h2>Latency (p95)</h2><div class="tiles">';
  html += tile("Boot", c.ms(latest("app.boot.duration", null, "p95")), "until there is a map");
  html += tile("Machines", c.ms(latest("db.pull.duration", { kind:"machines" }, "p95")), "full pull");
  html += tile("Reports", c.ms(latest("db.pull.duration", { kind:"reports" }, "p95")), "last 72 h");
  html += tile("Write", c.ms(latest("db.rpc.duration", { rpc:"report_machine" }, "p95")), "report_machine");
  html += '</div>';
  html += box("Boot, p95 per day",
    c.line(days, (function(){
      var m = api.latencyByDay(rows, "app.boot.duration", null), out = {};
      for(var d in m) out[d] = m[d].p95;
      return out;
    })(), { title:"Boot p95", maxLabel:c.ms, emptyText:"No measurements yet." }));
  html += '<p class="empty">These are bucket boundaries, not exact measurements — hence the ' +
    '“≤”. A fixed-bucket histogram does not know where inside a bucket its observations fell, ' +
    'and interpolating would give a number more precise than the data is.</p>';
  html += '</section>';

  html += '<section><h2>Errors (7 days)</h2><div class="panelbox scroll">';
  if(!errs.length){
    html += '<p class="empty">No errors reported. Either everything is fine, or no telemetry ' +
      'is arriving — the “Last telemetry” tile on Now says which.</p>';
  } else {
    html += '<table><thead><tr><th>Message</th><th>Where</th><th class="n">Times</th>' +
      '<th class="n">Last</th></tr></thead><tbody>';
    errs.forEach(function(e){
      html += '<tr><td class="msg">' + escapeHtml(e.msg) + '</td>' +
        '<td>' + escapeHtml(e.kind) + '<br><span class="s" style="color:var(--ink-faint);font-size:11px">' +
        escapeHtml((e.releases || []).filter(Boolean).join(", ")) + '</span></td>' +
        '<td class="n">' + c.num(e.n) + '<br><span style="color:var(--ink-faint);font-size:11px">' +
        c.num(e.sessions) + ' sessions</span></td>' +
        '<td class="n">' + ago(e.last_seen) + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div></section>';

  html += '<section><h2>Recent traces</h2>';
  if(!tr.length){
    html += '<div class="panelbox"><p class="empty">No traces stored. Only 2% are kept, plus ' +
      'anything that failed or was slow — that is what keeps telemetry inside the free tier.</p></div>';
  } else {
    tr.slice(0, 5).forEach(function(t){
      html += box(ago(t.started) + " · " + c.num(t.total_ms) + " ms · " + t.trace.slice(0, 12),
                  '<div class="scroll">' + c.waterfall(t.spans) + '</div>');
    });
  }
  html += '</section>';

  // The thing that will actually hit the free tier first is not telemetry,
  // it is the pull every visit does. Better to watch it arrive than discover
  // it in a billing email.
  var visits30 = api.sum(api.byDay(rows, "app.visit"));
  var perVisitKb = (o.machines.total * BYTES_PER_MACHINE) / 1024;
  var monthlyGb = (visits30 * perVisitKb) / 1024 / 1024;
  html += '<section><h2>Storage and traffic</h2><div class="tiles">';
  html += tile("Raw rows", c.num(o.telemetry.raw_rows),
    "ceiling " + c.num(o.telemetry.limits.raw_max) + " · deleted after " +
    o.telemetry.limits.raw_days + " days");
  html += tile("Aggregated rows", c.num(o.telemetry.daily_rows), "kept forever, flat in traffic");
  html += tile("Estimated egress", c.dec(monthlyGb, 2) + " GB/month", "free limit: 5 GB");
  html += tile("Per visit", c.num(perVisitKb) + " KB",
    c.num(o.machines.total) + " machines, compressed");
  html += '</div>';
  html += '<p class="empty">An estimate, from the visits of the last ' + DAYS +
    ' days. Telemetry barely counts towards it — what it sends goes up, and egress is what ' +
    'comes down. When this approaches 5 GB, the thing that needs to change is ' +
    '<code style="display:inline;padding:1px 4px">pull()</code>, not this panel.</p></section>';

  return html;
}

function escapeHtml(s){
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, function(ch){
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[ch];
  });
}

export var TABS = [
  { id:"now",       label:"Now",       render:now },
  { id:"activity",  label:"Activity",  render:activity },
  { id:"behaviour", label:"Behaviour", render:behaviour },
  { id:"health",    label:"Health",    render:health },
];
