// Charts, drawn as inline SVG.
//
// No charting library, for the same reason the app has no build step: adding
// one would mean another CDN script on a page that already loads supabase-js,
// and every chart here is bars, a line, or a bar lying on its side. The
// project's rule is to ask before adding a dependency, and none of this is
// worth asking for.
//
// Everything returns an SVG string rather than nodes: the screens assemble
// whole sections with innerHTML in one write, which is both simpler to read
// and one layout pass instead of dozens.

var NS = 'xmlns="http://www.w3.org/2000/svg"';

export var COLOR = {
  ok: "#12A05F", full: "#E39B22", down: "#DE4A3F", stale: "#98A0AE",
  ink: "#14202E", blue: "#1F4FD8", soft: "#8A93A3", line: "#DCDAD2",
};

function esc(s){
  return String(s).replace(/[&<>"]/g, function(c){
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
  });
}

// A comma for thousands, a dot for the decimal. The panel is in English —
// only the app itself is Portuguese — so this is the English convention, not
// the app's.
//
// Done by hand rather than with toLocaleString(), which needs the browser to
// carry ICU data for the locale. Headless Chromium in CI does not, and
// neither do some Android WebViews — so the same build that renders "2,444"
// on a phone renders "2444" elsewhere, and a test could only be written to
// accept both. Four lines here means the panel reads identically wherever it
// is opened, and the test can assert exactly what it should say.
export function dec(n, places){
  var s = Math.abs(Number(n)).toFixed(places || 0);
  var parts = s.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (Number(n) < 0 ? "-" : "") + parts.join(".");
}

export function num(n){
  if(n === null || n === undefined) return "—";
  return dec(Math.round(Number(n)), 0);
}

// Coverage is stored per-mille so one decimal place needs no float.
export function pct(pm){
  return dec(pm / 10, 1).replace(/\.0$/, "") + "%";
}

// Milliseconds off an explicit-bucket histogram are a bucket boundary, not a
// measurement, so they are shown as "≤ x" — see private.hist_quantile().
export function ms(v){
  if(v === null || v === undefined) return "—";
  return "≤ " + (v >= 1000 ? dec(v / 1000, v % 1000 ? 1 : 0) + " s" : num(v) + " ms");
}

function dayLabel(d){
  return d.slice(8, 10) + "/" + d.slice(5, 7);
}

/* ───────── stacked daily bars ─────────
   days: ["2026-08-01", ...]   series: [{ name, color, values:{day:n} }] */
export function bars(days, series, opts){
  opts = opts || {};
  var H = opts.height || 120, W = 320, pad = 16;
  var bw = (W - pad) / days.length;
  var max = 0;

  days.forEach(function(d){
    var t = 0;
    series.forEach(function(s){ t += s.values[d] || 0; });
    if(t > max) max = t;
  });
  if(max === 0) return empty(opts.emptyText);

  var out = '<svg ' + NS + ' viewBox="0 0 ' + W + ' ' + (H + 18) + '" role="img">';
  out += '<title>' + esc(opts.title || "") + '</title>';

  days.forEach(function(d, i){
    var y = H, x = pad + i * bw;
    series.forEach(function(s){
      var v = s.values[d] || 0;
      if(!v) return;
      var h = (v / max) * (H - 14);   // headroom for the max label
      y -= h;
      out += '<rect x="' + (x + bw * 0.14).toFixed(1) + '" y="' + y.toFixed(1) +
             '" width="' + (bw * 0.72).toFixed(1) + '" height="' + h.toFixed(1) +
             '" fill="' + s.color + '" rx="1"/>';
    });
  });

  out += '<line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H +
         '" stroke="' + COLOR.line + '" stroke-width="1"/>';
  // Only the ends and the middle get a label; a tick per day is unreadable
  // at phone width and says nothing a range does not.
  [0, Math.floor(days.length / 2), days.length - 1].forEach(function(i){
    var x = pad + i * bw + bw / 2;
    out += '<text x="' + x.toFixed(1) + '" y="' + (H + 13) +
           '" font-size="9" fill="' + COLOR.soft + '" text-anchor="middle">' +
           dayLabel(days[i]) + '</text>';
  });
  out += '<text x="0" y="10" font-size="9" fill="' + COLOR.soft + '">' + num(max) + '</text>';
  out += '</svg>';
  return out;
}

/* ───────── a line, for latency ─────────
   points: { day: value }, nulls allowed and drawn as gaps */
export function line(days, points, opts){
  opts = opts || {};
  var H = opts.height || 90, W = 320, pad = 16;
  var vals = days.map(function(d){
    var v = points[d];
    return (v === undefined || v === null) ? null : v;
  });
  var max = Math.max.apply(null, vals.filter(function(v){ return v !== null; }).concat([0]));
  if(max === 0) return empty(opts.emptyText);

  var step = (W - pad) / Math.max(days.length - 1, 1);
  var d = "", open = false, out = '<svg ' + NS + ' viewBox="0 0 ' + W + ' ' + (H + 18) + '" role="img">';
  out += '<title>' + esc(opts.title || "") + '</title>';

  vals.forEach(function(v, i){
    if(v === null){ open = false; return; }
    var x = pad + i * step, y = H - (v / max) * (H - 16);  // ditto
    d += (open ? " L" : " M") + x.toFixed(1) + " " + y.toFixed(1);
    open = true;
  });

  out += '<path d="' + d.trim() + '" fill="none" stroke="' + (opts.color || COLOR.blue) +
         '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  out += '<line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H +
         '" stroke="' + COLOR.line + '" stroke-width="1"/>';
  out += '<text x="0" y="10" font-size="9" fill="' + COLOR.soft + '">' +
         esc(opts.maxLabel ? opts.maxLabel(max) : num(max)) + '</text>';
  out += '</svg>';
  return out;
}

/* ───────── bars on their side, for top-N ─────────
   rows: [{ label, value, color? }] */
export function hbars(rows, opts){
  opts = opts || {};
  if(!rows.length) return empty(opts.emptyText);
  var max = Math.max.apply(null, rows.map(function(r){ return r.value; }));
  var out = '<table class="hb"><tbody>';
  rows.forEach(function(r){
    var w = max ? Math.max((r.value / max) * 100, 1.5) : 0;
    out += '<tr><td>' + esc(r.label) + '</td>' +
           '<td><span style="display:block;height:8px;border-radius:2px;background:' +
           (r.color || COLOR.blue) + ';width:' + w.toFixed(1) + '%"></span></td>' +
           '<td class="n">' + num(r.value) + '</td></tr>';
  });
  return out + '</tbody></table>';
}

/* ───────── the coverage meter ─────────
   The one number the whole product is scored on, so it gets its own shape. */
export function meter(pm){
  var w = Math.max(Math.min(pm / 10, 100), 0);
  return '<div style="height:10px;border-radius:5px;background:var(--line-soft);overflow:hidden">' +
         '<div style="height:100%;width:' + w.toFixed(1) + '%;background:' + COLOR.ok + '"></div></div>';
}

/* ───────── a trace, as a waterfall ─────────
   spans: [{ name, span, parent, at, ms }] in start order */
export function waterfall(spans){
  if(!spans.length) return empty("No spans.");
  var t0 = Math.min.apply(null, spans.map(function(s){ return +new Date(s.at); }));
  var t1 = Math.max.apply(null, spans.map(function(s){ return +new Date(s.at) + (s.ms || 0); }));
  var span = Math.max(t1 - t0, 1);

  var out = '<table class="hb"><tbody>';
  spans.forEach(function(s){
    var start = ((+new Date(s.at) - t0) / span) * 100;
    var width = Math.max(((s.ms || 0) / span) * 100, 1);
    // A child is inset so the tree is readable without drawing one.
    var pad = s.parent ? 12 : 0;
    out += '<tr><td style="padding-left:' + pad + 'px" class="msg">' + esc(s.name) + '</td>' +
           '<td><span style="display:block;height:8px;border-radius:2px;background:' + COLOR.blue +
           ';margin-left:' + start.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></span></td>' +
           '<td class="n">' + num(s.ms) + ' ms</td></tr>';
  });
  return out + '</tbody></table>';
}

export function legend(series){
  return '<div class="legend">' + series.map(function(s){
    return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>';
  }).join("") + '</div>';
}

// An empty chart says why it is empty. "No data yet" and "this is broken"
// look identical otherwise, and on a dashboard that is the difference between
// waiting and investigating.
function empty(text){
  return '<p class="empty">' + esc(text || "No data yet.") + '</p>';
}
