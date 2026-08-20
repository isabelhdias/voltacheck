// The status filter (the tally row, now four toggles) and distance from the
// user. The fresh local-mode seed has zero reports on every machine, so by
// default every one of the 2.444 machines is "stale" — that's not a test
// artefact, it mirrors production today (docs/seed-data-plan.md), and it's
// exactly the shape that makes "turn off the only non-empty bucket" a
// realistic case to cover, not a contrived one.
import { test, expect, gotoApp, centerPin } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } });

function tallyBtn(page, word) {
  return page.locator('#tally button', { hasText: word }).first();
}

async function zoomToCountry(page) {
  await page.mouse.move(417, 556);
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

test.describe('status filter', () => {
  test('default: every toggle is pressed, and "sem dados" carries every machine', async ({ page }) => {
    await gotoApp(page);

    const pressed = await page.$$eval('#tally button', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    expect(pressed).toEqual(['true', 'true', 'true', 'true']);

    expect((await tallyBtn(page, 'sem dados').textContent()).trim()).toBe('2444 sem dados');
    for (const w of ['a funcionar', 'cheias', 'avariadas']) {
      expect((await tallyBtn(page, w).textContent()).trim()).toBe('0 ' + w);
    }
  });

  test('turning off the only non-empty status empties the map and offers a way out', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);
    expect(await page.locator('.pin').count()).toBeGreaterThan(0);
    await expect(page.locator('#empty')).toBeHidden();

    await tallyBtn(page, 'sem dados').click();
    await page.waitForTimeout(400);

    await expect(tallyBtn(page, 'sem dados')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.locator('.pin').count()).toBe(0);
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#empty')).toContainText('Nenhuma máquina com este filtro.');

    await page.click('#empty-clear');
    await page.waitForTimeout(400);

    await expect(page.locator('#empty')).toBeHidden();
    expect(await page.locator('.pin').count()).toBeGreaterThan(0);
    const pressed = await page.$$eval('#tally button', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    expect(pressed).toEqual(['true', 'true', 'true', 'true']);
  });

  test('a status toggle closes an open sheet, matching what the chain chips already do', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);

    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.getElementById('sheet').classList.contains('open'))).toBe(true);

    await tallyBtn(page, 'a funcionar').click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.getElementById('sheet').classList.contains('open'))).toBe(false);
  });

  test('the filter badge shows only while a filter is active, and "limpar" resets both dimensions', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#filterbadge')).toBeHidden();

    await tallyBtn(page, 'a funcionar').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#filterbadge')).toBeVisible();

    await page.click('#filterbadge');
    await page.waitForTimeout(300);

    await expect(page.locator('#filterbadge')).toBeHidden();
    const pressed = await page.$$eval('#tally button', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    expect(pressed).toEqual(['true', 'true', 'true', 'true']);
  });

  test('the filter badge also appears for a chain-only filter, with no status toggles touched', async ({ page }) => {
    await gotoApp(page);
    await page.locator('#chains button', { hasText: 'Lidl' }).first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('#filterbadge')).toBeVisible();
  });

  test('composes with the chain filter: a status count reflects the active chain, not the national total', async ({ page }) => {
    await gotoApp(page);

    expect((await tallyBtn(page, 'sem dados').textContent()).trim()).toBe('2444 sem dados');

    await page.locator('#chains button', { hasText: 'Lidl' }).first().click();
    await page.waitForTimeout(400);

    // 278 is Lidl's own machine count (see test/e2e/chains.spec.js) — every
    // one of them is also "stale" (fresh seed, no reports), so the toggle
    // must show Lidl's own total, not the national 2.444.
    expect((await tallyBtn(page, 'sem dados').textContent()).trim()).toBe('278 sem dados');

    await page.locator('#chains button', { hasText: 'Todas' }).first().click();
    await page.waitForTimeout(400);
    expect((await tallyBtn(page, 'sem dados').textContent()).trim()).toBe('2444 sem dados');
  });

  test('no page errors while toggling status filters', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/tile|favicon|net::/i.test(m.text())) errors.push(m.text());
    });

    await gotoApp(page);
    await zoomToCountry(page);
    await tallyBtn(page, 'a funcionar').click();
    await page.waitForTimeout(300);
    await tallyBtn(page, 'sem dados').click();
    await page.waitForTimeout(300);
    await page.click('#empty-clear');
    await page.waitForTimeout(300);

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});

test.describe('distance', () => {
  test('locating shows a distance in the sheet next to the concelho', async ({ page, context }) => {
    // A stubbed fix, not a real one — Playwright's own geolocation mock, so
    // this never reaches an actual device or network.
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 38.7223, longitude: -9.1393 });

    await gotoApp(page);
    await page.click('#locate');
    await page.waitForTimeout(1200);

    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);

    const addr = (await page.textContent('#s-addr')).trim();
    expect(addr).toMatch(/a \d+(,\d)? ?(m|km)$/);
  });

  test('without locating, the sheet shows no distance', async ({ page }) => {
    await gotoApp(page);
    const box = await centerPin(page);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);

    const addr = (await page.textContent('#s-addr')).trim();
    expect(addr).not.toMatch(/\bkm$|\bm$/);
  });
});
