// Chain filter chips: ordering, toggling, and that the map actually narrows
// to the selected chain. Zoomed out to the whole country first so every
// chain's machines are candidates for the viewport, which is what makes the
// exact pin counts below meaningful rather than incidental.
import { test, expect, gotoApp, centerPin } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } });

function chip(page, label) {
  return page.locator('#chains button', { hasText: label }).first();
}

async function chipLabels(page) {
  return page.$$eval('#chains button', (els) => els.map((e) => e.textContent));
}

async function zoomToCountry(page) {
  await page.mouse.move(417, 556);
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

test.describe('chain filter', () => {
  test('chip row renders "Todas" first, "Outras" last, sorted by count between', async ({ page }) => {
    await gotoApp(page);
    const labels = await chipLabels(page);

    expect(labels.length).toBeGreaterThan(1);
    expect(labels[0]).toBe('Todas');
    expect(labels[labels.length - 1]).toBe('Outras');
    // Sorted by machine count descending (excluding "Todas" and "Outras",
    // which are pinned to the ends regardless of count).
    expect(labels.slice(0, 4)).toEqual(['Todas', 'Pingo Doce', 'Auchan', 'Continente']);
    for (const c of ['Pingo Doce', 'Auchan', 'Continente', 'Lidl', 'Intermarché', 'Aldi', 'SPAR', 'Mercadona']) {
      expect(labels).toContain(c);
    }

    await expect(chip(page, 'Todas')).toHaveAttribute('aria-pressed', 'true');
  });

  test('picking "Lidl" shows exactly the 278 Lidl machines, and pins are actually Lidl', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);

    const beforeCount = await page.locator('.pin').count();
    await chip(page, 'Lidl').click();
    await page.waitForTimeout(500);

    await expect(chip(page, 'Lidl')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'Todas')).toHaveAttribute('aria-pressed', 'false');

    const afterCount = await page.locator('.pin').count();
    expect(afterCount, `${beforeCount} -> ${afterCount}`).toBe(278);
    expect(afterCount).toBeLessThan(beforeCount);

    await expect(page.locator('#tally')).toContainText(/\d+ a funcionar/);

    const box = await centerPin(page);
    expect(box, 'no Lidl pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);
    const name = (await page.textContent('#s-name')).trim();
    expect(name).toMatch(/lidl/i);
  });

  test('clicking the active chip again clears the filter', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);

    await chip(page, 'Lidl').click();
    await page.waitForTimeout(500);
    const filteredCount = await page.locator('.pin').count();

    await chip(page, 'Lidl').click();
    await page.waitForTimeout(500);

    await expect(chip(page, 'Todas')).toHaveAttribute('aria-pressed', 'true');
    const clearedCount = await page.locator('.pin').count();
    expect(clearedCount, `${filteredCount} -> ${clearedCount}`).toBeGreaterThanOrEqual(filteredCount);
  });

  test('picking a chain filter closes an open sheet', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);

    const box = await centerPin(page);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);
    const wasOpen = await page.evaluate(() => document.getElementById('sheet').classList.contains('open'));
    expect(wasOpen).toBe(true);

    await chip(page, 'Auchan').click();
    await page.waitForTimeout(500);
    const stillOpen = await page.evaluate(() => document.getElementById('sheet').classList.contains('open'));
    expect(stillOpen).toBe(false);
  });

  test('"Outras" filter shows exactly the 200 non-chain machines', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);

    await chip(page, 'Outras').click();
    await page.waitForTimeout(500);
    const outrasCount = await page.locator('.pin').count();
    expect(outrasCount).toBe(200);
  });

  test('no page errors while filtering', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/tile|favicon|net::/i.test(m.text())) errors.push(m.text());
    });

    await gotoApp(page);
    await zoomToCountry(page);
    await chip(page, 'Lidl').click();
    await page.waitForTimeout(400);
    await chip(page, 'Todas').click();
    await page.waitForTimeout(400);

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
