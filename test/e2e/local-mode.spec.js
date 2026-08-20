// Confirms the app runs in local mode (never touching the live Supabase
// project) when supabase-js is unavailable, and — the single most important
// regression here — that local mode never calls the Geolocation API, even
// when permission is already granted. A phone-sized viewport, since that is
// the real target device for this check.
import { test, expect, gotoApp, centerPin } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('local mode', () => {
  test('badge reads "modo local" when supabase-js is stubbed out', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#mode')).toHaveText('modo local');
    const live = await page.locator('#mode').getAttribute('data-live');
    expect(live).toBe('0');
  });

  test('never calls navigator.geolocation, even with permission pre-granted', async ({ page }) => {
    // Pretend geolocation permission is already granted, so any warm-up code
    // path is maximally tempted to fire — then prove it never does.
    await page.addInitScript(() => {
      window.__geo = 0;
      navigator.geolocation.getCurrentPosition = function () {
        window.__geo++;
      };
      navigator.permissions.query = () => Promise.resolve({ state: 'granted' });
    });

    await gotoApp(page);
    expect(await page.evaluate(() => window.__geo)).toBe(0);

    // Open a sheet.
    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.__geo)).toBe(0);

    // Report a status — the write path is the other plausible place a
    // "confirm you're near the machine" warm-up call could sneak in.
    await page.click('.choice[data-s="down"]');
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__geo)).toBe(0);

    await expect(page.locator('#s-state')).toContainText('Avariada');
  });

  test('reporting in local mode skips the device id and never hits a remote database', async ({ page }) => {
    // pushReport() short-circuits to "ok" for local mode before it ever
    // touches deviceId() or the RPC call — so a report should leave
    // centimo.did unset and should never produce a request to the Supabase
    // host, regardless of what index.html had baked in for SUPABASE_URL.
    const supabaseRequests = [];
    page.on('request', (req) => {
      if (/supabase\.co/.test(req.url())) supabaseRequests.push(req.url());
    });

    await gotoApp(page);
    expect(await page.evaluate(() => localStorage.getItem('centimo.did'))).toBeNull();

    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);
    await page.click('.choice[data-s="down"]');
    await page.waitForTimeout(900);

    await expect(page.locator('#s-state')).toContainText('Avariada');
    expect(await page.evaluate(() => localStorage.getItem('centimo.did'))).toBeNull();
    expect(supabaseRequests, supabaseRequests.join(' | ')).toEqual([]);
  });
});
