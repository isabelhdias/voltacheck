// Regenerates the README screenshots in docs/images/.
//
//   npm install && node tools/screenshots.mjs
//
// It drives the real, unmodified index.html in Chromium (Playwright, already
// a dev dependency for the e2e suite) and captures five phone-sized shots.
//
// Two things are deliberate:
//
// * It runs in LOCAL MODE. supabase-js is stubbed out exactly the way
//   test/e2e/fixtures.js does it, so window.supabase is undefined, connect()
//   takes the localStorage branch, and nothing here can reach — or write to —
//   the live database.
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

  await browser.close();
  server.kill();

  fs.readdirSync(OUT).sort().forEach((f) =>
    console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB')
  );
};

run().catch((e) => { console.error(e); process.exit(1); });
