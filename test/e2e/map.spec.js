// Map rendering, viewport culling, the pin cap, the machine sheet, reporting,
// and localStorage's shape/durability across reloads — including the "old
// v1 cache must not mask the new seed" regression.
import { test, expect, gotoApp, expectLocalMode, centerPin, countPageErrors } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } }); // iPad-ish, the target device

test.describe('map', () => {
  test('renders pins in local mode, capped well under the full seed', async ({ page }) => {
    const errors = countPageErrors(page);
    await gotoApp(page);

    await expectLocalMode(page);

    const pinCount = await page.locator('.pin').count();
    expect(pinCount).toBeGreaterThan(0);
    // MAX_PINS in index.html is 400 — the seed has 2,444 machines, so an
    // unculled render would blow way past this.
    expect(pinCount).toBeLessThanOrEqual(400);

    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('pins re-render after panning the map', async ({ page }) => {
    await gotoApp(page);
    const before = await page.locator('.pin').count();

    await page.mouse.move(417, 556);
    await page.mouse.down();
    await page.mouse.move(120, 200, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const after = await page.locator('.pin').count();
    expect(after, `${before} -> ${after}`).toBeGreaterThan(0);
  });

  test('tapping a pin opens the sheet with a name, town and fresh-report prompt', async ({ page }) => {
    await gotoApp(page);

    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);

    await expect(page.locator('#sheet')).toHaveClass(/open/);

    const name = (await page.textContent('#s-name')).trim();
    expect(name.length).toBeGreaterThan(2);

    const addr = (await page.textContent('#s-addr')).trim();
    expect(addr.length).toBeGreaterThan(0);
    expect(addr).not.toMatch(/^-?\d+\.\d+,/); // a concelho, not raw coordinates

    await expect(page.locator('#s-ask')).toHaveText('Estiveste lá agora?');
    await expect(page.locator('#s-state')).toContainText('Sem dados recentes');
  });

  test('reporting a status updates the sheet and the status counts, and persists', async ({ page }) => {
    await gotoApp(page);

    const box = await centerPin(page);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);

    await page.click('.choice[data-s="full"]');
    await page.waitForTimeout(900);

    await expect(page.locator('#s-state')).toContainText('Cheia');

    // The status counts live in the filter sheet now, not a topbar row.
    await page.click('#filterbtn');
    await expect(page.locator('#filters')).toBeVisible();
    await expect(
      page.locator('#statuslist button', { hasText: 'Cheias' }).locator('b')
    ).toHaveText('1');
    await page.click('#scrim');

    const stored = await page.evaluate(() => localStorage.getItem('centimo.v2'));
    expect(stored).toBeTruthy();
    expect(stored).toContain('full');

    const parsed = JSON.parse(stored);
    expect(parsed.reports).toBeTruthy();
    expect(Array.isArray(parsed.custom)).toBe(true);
    // The store holds only the report + any user-added machines, not the
    // whole 2,444-machine seed list.
    expect(stored.length).toBeLessThan(2000);

    // The report survives a reload — the point of persisting it at all.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.click('#filterbtn');
    await expect(page.locator('#filters')).toBeVisible();
    await expect(
      page.locator('#statuslist button', { hasText: 'Cheias' }).locator('b')
    ).toHaveText('1');
  });

  test('a stale v1 localStorage cache does not mask the current seed', async ({ page }) => {
    await gotoApp(page);

    await page.evaluate(() => {
      localStorage.setItem(
        'centimo.v1',
        JSON.stringify([{ id: 'seed-0', name: 'Velho placeholder', lat: 38.75, lng: -9.14, reports: [] }])
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const pinCount = await page.locator('.pin').count();
    expect(pinCount).toBeGreaterThan(1);
  });
});
