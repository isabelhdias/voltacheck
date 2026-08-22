// Regenerates the README screenshots in docs/images/.
//
//   npm install && node tools/screenshots.mjs
//
// It drives the real, unmodified index.html in Chromium (Playwright, already
// a dev dependency for the e2e suite) and captures six phone-sized shots, plus
// three of the admin panel at admin/index.html. The app is Portuguese and the
// panel is English; the contexts are given matching locales so neither is
// screenshotted in the other's.
//
// Two things are deliberate:
//
// * It runs in LOCAL MODE. supabase-js is stubbed out exactly the way
//   test/e2e/fixtures.js does it, so window.supabase is undefined, connect()
//   takes the localStorage branch, and nothing here can reach — or write to —
//   the live database. The admin pass at the bottom needs a *live* client to
//   have anything to draw, so it gets a fake one that answers from memory —
//   still nothing on the wire, and the panel is the real admin/ files.
// * The reports are demo data, seeded into localStorage before the page
//   loads and derived from each machine's OSM id, so a re-run reproduces the
//   same picture. The seed file itself carries no reports, and a screenshot
//   of an all-grey map would say nothing about what the app does.
//
// Everything off-site (Leaflet, Google Fonts, OSM tiles) is fetched by node
// and fulfilled into the page, cached under the system temp dir. That keeps
// the run repeatable, keeps tile requests down to one per tile ever, and
// works in sandboxes where the browser has no direct network.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SEED } from '../seed/machines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
const CACHE = path.join(os.tmpdir(), 'voltacheck-shots-cache');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const HOUR = 3600000;

const TILE_UA =
  'VoltaCheck-readme-screenshots/1.0 (+https://github.com/isabelhdias/voltacheck)';
// Google Fonts serves a different format per user agent — asking as Chrome is
// what gets the variable woff2 the wordmark's 'wdth' axis needs.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

async function fetchCached(url) {
  const key = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex'));
  if (fs.existsSync(key + '.bin')) {
    return { body: fs.readFileSync(key + '.bin'),
             contentType: fs.readFileSync(key + '.type', 'utf8') };
  }
  const ua = url.includes('openstreetmap.org') ? TILE_UA : CHROME_UA;
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  const body = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  fs.writeFileSync(key + '.bin', body);
  fs.writeFileSync(key + '.type', contentType);
  return { body, contentType };
}

// One report per machine, chosen from its OSM id so the map looks the same on
// every run. Three kinds of pin have to appear, because all three are real:
// solid ones (a report inside 18 h), hollow ones (a report past 18 h, which
// keeps its colour instead of going grey), and grey ones — about an eighth of
// the machines, left with no report at all, which is now the only thing grey
// means.
function demoReports(now) {
  const reports = {};
  SEED.forEach((s) => {
    const h = Number(String(s[5]).slice(-4)) % 100;
    let state, ageH;
    if (h < 34)      { state = 'ok';   ageH = 0.2 + (h % 9) * 0.3; }
    else if (h < 46) { state = 'ok';   ageH = 5 + (h % 7); }
    else if (h < 58) { state = 'full'; ageH = 1 + (h % 5) * 0.8; }
    else if (h < 68) { state = 'down'; ageH = 0.5 + (h % 6); }
    // Past STALE_AFTER: drawn faded, one of each colour so the screenshot
    // shows what an aged report looks like rather than only fresh ones.
    else if (h < 76) { state = 'ok';   ageH = 21 + (h % 5) * 6; }
    else if (h < 83) { state = 'full'; ageH = 19 + (h % 4) * 9; }
    else if (h < 88) { state = 'down'; ageH = 26 + (h % 3) * 11; }
    else return;
    reports['osm-' + s[5]] = [{ s: state, at: Math.round(now - ageH * HOUR) }];
  });
  // The machine the sheet screenshot opens: a short history, latest 4 h old,
  // so the prompt is the reconfirm one — "Ainda está assim?".
  reports['osm-13722146779'] = [
    { s: 'down', at: now - 26 * HOUR },
    { s: 'ok',   at: now - 9 * HOUR },
    { s: 'full', at: now - 4 * HOUR },
  ];
  return reports;
}

async function serve() {
  const proc = spawn('npx', ['http-server', '-p', String(PORT), '-s', ROOT], {
    cwd: ROOT, stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/index.html'); return proc; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('static server did not come up on ' + BASE);
}

// Demo numbers for the admin pass — a month of plausible traffic, generated
// rather than captured, because the real numbers are the live site's and this
// file is committed to a public repo. Deterministic, so a re-run reproduces
// the same picture.
function fakePanelClient() {
  const days = [...Array(30)].map((_, i) =>
    new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10));
  const series = [];
  const push = (d, m, k, v, extra) =>
    series.push({ d, m, k, v, n: 0, p50: null, p95: null, ...extra });

  days.forEach((d, i) => {
    push(d, 'reports.filed', { status: 'ok' }, 6 + ((i * 7) % 11));
    push(d, 'reports.filed', { status: 'full' }, 1 + ((i * 3) % 5));
    push(d, 'reports.filed', { status: 'down' }, i % 4 === 0 ? 2 : 0);
    push(d, 'app.visit', { mode: 'live' }, 40 + ((i * 13) % 60));
    push(d, 'app.session', { mode: 'live' }, 25 + ((i * 11) % 40));
    push(d, 'machines.new', { source: 'user' }, i % 6 === 0 ? 1 : 0);
    push(d, 'submissions.outcome', { outcome: 'ok' }, i % 9 === 0 ? 1 : 0);
    push(d, 'sheet.open', { state: 'stale' }, 20 + ((i * 5) % 18));
    push(d, 'report.tap', { status: 'ok' }, 8 + (i % 7));
    push(d, 'report.result', { outcome: 'ok' }, 6 + (i % 5));
    push(d, 'reports.outcome', { outcome: 'ok' }, 6 + (i % 5));
    push(d, 'reports.outcome', { outcome: 'far' }, 2 + (i % 3));
    push(d, 'reports.outcome', { outcome: 'cooldown' }, i % 2);
    push(d, 'locate.tap', { outcome: 'granted' }, 5 + (i % 4));
    push(d, 'locate.tap', { outcome: 'denied' }, i % 3);
    push(d, 'app.boot.duration', { mode: 'live' }, 0, { n: 40, p50: 500, p95: i % 5 === 0 ? 5000 : 2500 });
    push(d, 'db.pull.duration', { kind: 'machines' }, 0, { n: 40, p50: 250, p95: 1000 });
    push(d, 'db.pull.duration', { kind: 'reports' }, 0, { n: 40, p50: 100, p95: 500 });
    push(d, 'db.rpc.duration', { rpc: 'report_machine', outcome: 'ok' }, 0, { n: 12, p50: 100, p95: 250 });
  });

  const now = Date.now();
  const data = {
    admin_overview: {
      at: new Date(now).toISOString(),
      machines: { total: SEED.length, new_7d: 3, reported_ever: 344, never_reported: SEED.length - 344 },
      coverage_pm: 141,
      reports: { h24: { ok: 12, full: 3, down: 1 }, total: 512 },
      submissions: { pending: 2, oldest_h: 30 },
      traffic: { visits_today: 84, sessions_today: 61, errors_today: 1 },
      telemetry: {
        raw_rows: 812, daily_rows: 240,
        limits: { raw_max: 400000, raw_days: 14 },
        last_seen: new Date(now - 4 * 60000).toISOString(),
      },
    },
    admin_series: series,
    town: [{ k: { town: 'Lisboa' }, v: 64 }, { k: { town: 'Porto' }, v: 41 },
           { k: { town: 'Cascais' }, v: 22 }, { k: { town: 'Braga' }, v: 14 },
           { k: { town: 'Faro' }, v: 9 }],
    chain: [{ k: { chain: 'Pingo Doce' }, v: 52 }, { k: { chain: 'Continente' }, v: 38 },
            { k: { chain: 'Lidl' }, v: 25 }, { k: { chain: 'Auchan' }, v: 11 }],
    admin_errors: [
      { msg: "Cannot read properties of undefined (reading 'lat')", kind: 'js.error',
        n: 7, last_seen: new Date(now - 3600000).toISOString(), sessions: 4, releases: ['a33d9db'] },
      { msg: 'Failed to fetch', kind: 'js.unhandled',
        n: 2, last_seen: new Date(now - 9e6).toISOString(), sessions: 2, releases: ['a33d9db'] },
    ],
    admin_traces: [{
      trace: '0123456789abcdef0123456789abcdef',
      started: new Date(now - 600000).toISOString(), total_ms: 1840,
      spans: [
        { name: 'app.boot',   span: 'a1', parent: null, at: new Date(now - 600000).toISOString(), ms: 1840, a: {} },
        { name: 'db.connect', span: 'a2', parent: 'a1', at: new Date(now - 599900).toISOString(), ms: 1610, a: {} },
        { name: 'db.pull',    span: 'a3', parent: 'a1', at: new Date(now - 599800).toISOString(), ms: 980,
          a: { 'db.rows': SEED.length } },
        { name: 'db.pull',    span: 'a4', parent: 'a1', at: new Date(now - 598700).toISOString(), ms: 520,
          a: { 'db.rows': 41 } },
      ],
    }],
  };

  return `
window.__s = { in:false, aal:'aal1' };
window.supabase = { createClient: function(){
  var S = window.__s, D = ${JSON.stringify(data)};
  return {
    auth: {
      getSession: function(){ return Promise.resolve({ data:{ session: S.in
        ? { user:{ id:'demo', email:'isabel@example.com' } } : null }, error:null }); },
      signInWithPassword: function(){ S.in = true; return Promise.resolve({ data:{}, error:null }); },
      signOut: function(){ S.in = false; return Promise.resolve({ error:null }); },
      mfa: {
        getAuthenticatorAssuranceLevel: function(){
          return Promise.resolve({ data:{ currentLevel:S.aal, nextLevel:'aal2' }, error:null }); },
        listFactors: function(){
          return Promise.resolve({ data:{ all:[{ id:'f1', factor_type:'totp', status:'verified' }] }, error:null }); },
        challengeAndVerify: function(){ S.aal = 'aal2'; return Promise.resolve({ data:{}, error:null }); }
      }
    },
    rpc: function(fn, args){
      if(fn === 'admin_top'){
        return Promise.resolve({ data: args.p_metric === 'search.town' ? D.town : D.chain, error:null });
      }
      return Promise.resolve({ data: D[fn] === undefined ? [] : D[fn], error:null });
    }
  };
}};`;
}

const run = async () => {
  const server = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 800 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-PT',
  });

  // One catch-all route, not two: Playwright matches the most recently
  // registered handler first, so a separate supabase stub registered earlier
  // would silently lose to this one and the app would go live.
  await ctx.route('**/*', async (route, request) => {
    const url = request.url();
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes('supabase')) {
      return route.fulfill({ contentType: 'application/javascript', body: '' });
    }
    try {
      const { body, contentType } = await fetchCached(url);
      await route.fulfill({ body, contentType });
    } catch (e) {
      await route.abort();
    }
  });

  await ctx.addInitScript(
    ([reports]) => {
      localStorage.setItem('centimo.v2', JSON.stringify({ reports, custom: [] }));
    },
    [demoReports(Date.now())]
  );

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.pin');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);

  // JPEG, not PNG: these are photographic map tiles under flat UI, and a
  // README image nobody in this repo can run an optimiser over should not be
  // 1.4 MB.
  const shot = (name) =>
    page.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 82 });

  // Reaching into the app's own modules — importing the same URL the page
  // already loaded returns the same module instance, so this drives the real
  // map and the real sheet rather than a copy of them.
  await page.evaluate(async () => {
    const m = await import('/app/map.js');
    m.map.setView([38.7365, -9.1435], 15);
    m.draw();
  });
  await page.waitForTimeout(3000);
  await shot('map.jpg');

  // The same map zoomed out to the whole country, where machines are grouped
  // into counted bubbles instead of a pin each. Shot here, between the two
  // street-level views, so it is the real transition and not a mock-up.
  await page.evaluate(async () => {
    const m = await import('/app/map.js');
    m.map.setView([39.6, -8.2], 7);
    m.draw();
  });
  await page.waitForTimeout(3000);
  await shot('clusters.jpg');

  // Back to street level for everything below, so those shots are unchanged.
  await page.evaluate(async () => {
    const m = await import('/app/map.js');
    m.map.setView([38.7365, -9.1435], 15);
    m.draw();
  });
  await page.waitForTimeout(2000);

  await page.evaluate(async () => {
    const ui = await import('/app/ui.js');
    ui.select('osm-13722146779');
  });
  await page.waitForTimeout(2000);
  await shot('sheet.jpg');
  await page.evaluate(async () => (await import('/app/ui.js')).closeSheet());

  await page.click('#filterbtn');
  await page.waitForTimeout(1000);
  await shot('filters.jpg');
  await page.click('#filters-apply');
  await page.waitForTimeout(600);

  await page.fill('#q', 'vila');
  await page.waitForTimeout(800);
  await shot('search.jpg');
  await page.fill('#q', '');
  await page.waitForTimeout(300);

  await page.click('#add');
  await page.waitForTimeout(1000);
  await shot('add.jpg');

  // ── the admin panel ──
  //
  // Its own context, with its own routes: the catch-all above deliberately
  // serves an empty supabase-js so the app falls into local mode, and the
  // panel needs the opposite. The client below is a fake that answers from
  // memory — the panel itself is the real admin/ files, and nothing in this
  // pass touches the network either.
  const adminCtx = await browser.newContext({
    viewport: { width: 390, height: 900 }, deviceScaleFactor: 2, locale: 'en-GB',
  });
  await adminCtx.route('**/*', async (route, request) => {
    const url = request.url();
    if (url.includes('supabase')) {
      return route.fulfill({ contentType: 'application/javascript', body: fakePanelClient() });
    }
    if (url.startsWith(BASE)) return route.continue();
    try {
      const { body, contentType } = await fetchCached(url);
      await route.fulfill({ body, contentType });
    } catch (e) { await route.abort(); }
  });

  const admin = await adminCtx.newPage();
  admin.on('pageerror', (e) => console.log('ADMIN PAGE ERROR', e.message));
  await admin.goto(BASE + '/admin/', { waitUntil: 'load' });
  await admin.evaluate(() => document.fonts.ready);
  await admin.waitForTimeout(500);
  await admin.fill('#email', 'isabel@example.com');
  await admin.fill('#pw', 'demo');
  await admin.click('#login button');
  await admin.waitForTimeout(500);
  await admin.fill('#code', '123456');
  await admin.click('#mfa button');
  await admin.waitForTimeout(1200);

  const adminShot = (name) =>
    admin.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 82, fullPage: true });

  await adminShot('admin-now.jpg');
  for (const [tab, file] of [['Behaviour', 'admin-behaviour.jpg'],
                             ['Health', 'admin-health.jpg']]) {
    await admin.click(`#tabs button:text-is("${tab}")`);
    await admin.waitForTimeout(900);
    await adminShot(file);
  }

  await browser.close();
  server.kill();

  fs.readdirSync(OUT).sort().forEach((f) =>
    console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB')
  );
};

run().catch((e) => { console.error(e); process.exit(1); });
