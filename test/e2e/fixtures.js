// Shared setup for the VoltaCheck e2e suite.
//
// The app is a single unmodified index.html. In this sandbox — and in CI,
// where flakiness from third-party hosts is undesirable regardless — cdnjs,
// jsdelivr, fonts.googleapis.com and tile.openstreetmap.org are not reachable.
// So every test routes those requests to local stand-ins: Leaflet is served
// from node_modules (installed by package.json, not the CDN the page asks
// for), fonts and supabase-js are served empty, and map tiles are a 1x1 PNG.
//
// Stubbing supabase-js with an empty body is also what keeps the suite out of
// the real, live Supabase project: index.html has real credentials baked in,
// but with `window.supabase` undefined, connect() takes the "no supabase-js"
// branch and falls back to local mode. No test in this suite should ever see
// the "em direto" badge — local-mode.spec.js asserts that directly.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const LEAFLET_JS = fs.readFileSync(path.join(ROOT, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.join(ROOT, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

// A valid, minimal 1x1 transparent PNG — enough for Leaflet's tile <img> tags
// to load successfully without any real map imagery.
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function stubNetwork(context) {
  await context.route('**/leaflet.min.js', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: LEAFLET_JS })
  );
  await context.route('**/leaflet.min.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: LEAFLET_CSS })
  );
  await context.route('**/supabase-js@2', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: '' })
  );
  await context.route('**/fonts.googleapis.com/**', (r) =>
    r.fulfill({ contentType: 'text/css', body: '' })
  );
  await context.route('**/tile.openstreetmap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG })
  );
}

// Extends the base test so every spec gets the CDN stubs for free, without
// repeating the route() calls in every file.
export const test = base.extend({
  context: async ({ context }, use) => {
    await stubNetwork(context);
    await use(context);
  },
});

export { expect };

// Loads the app and waits for the initial seed render (map + pins) to settle.
// index.html has no "app ready" event to hook into, so the scratchpad scripts
// this was lifted from used a fixed settle delay; kept as-is here.
export async function gotoApp(page, { waitMs = 2500 } = {}) {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(waitMs);
}

// Confirms the app is running in local mode, never against the live Supabase
// project. Call this early in every spec that touches app state.
export async function expectLocalMode(page) {
  await expect(page.locator('#mode')).toHaveText('modo local');
}

// Wheels the map out from the default zoom 13 to roughly country level, where
// every machine on screen is behind a counted bubble rather than its own pin.
// Shared because more than one spec needs the zoomed-out map, and they must
// agree on what "zoomed out" means.
export async function zoomToCountry(page) {
  await page.mouse.move(417, 556);
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

// The zoom Leaflet is actually on. The app's modules are already loaded, so
// importing map.js in the page hands back the same live instance.
export function mapZoom(page) {
  return page.evaluate(() => import('/app/map.js').then((m) => m.map.getZoom()));
}

// Finds the on-screen pin nearest the viewport centre, clear of the topbar
// and the bottom sheet, and returns click coordinates for it (or null).
export async function centerPin(page) {
  return page.evaluate(() => {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    document.querySelectorAll('.pin').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 90 || r.bottom > innerHeight - 60) return; // clear of topbar/sheet
      const d = (r.x + r.width / 2 - cx) ** 2 + (r.y + r.height / 2 - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    });
    return best;
  });
}

export function countPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/tile|favicon|net::/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}
