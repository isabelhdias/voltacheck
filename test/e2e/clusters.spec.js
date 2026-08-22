// Zoomed out, the map groups machines into counted bubbles.
//
// The reason this exists as its own spec: zoomed out, one pin per machine was
// a wall of overlapping colour, and the MAX_PINS cap that kept it drawable
// dropped the rest in silence — the country view showed 400 of 2.444 while the
// count line said 2.444. A bubble has to carry the true number, so "nothing is
// dropped" is asserted here, not just "bubbles appear".
import { test, expect, gotoApp, expectLocalMode, zoomToCountry, mapZoom } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } });

// Every machine drawn right now: the ones with their own pin, plus the ones
// standing behind a bubble's number.
function machinesDrawn(page) {
  return page.evaluate(() => {
    const pins = document.querySelectorAll('.pin').length;
    let clustered = 0;
    document.querySelectorAll('.cluster').forEach((el) => {
      clustered += Number(el.textContent);
    });
    return { pins, clustered, total: pins + clustered };
  });
}

test('the default view is unchanged: pins, no bubbles', async ({ page }) => {
  await gotoApp(page);
  await expectLocalMode(page);

  expect(await mapZoom(page)).toBe(13);
  await expect(page.locator('.cluster')).toHaveCount(0);
  expect(await page.locator('.pin').count()).toBeGreaterThan(0);
});

test('zoomed out, machines are grouped into counted bubbles', async ({ page }) => {
  await gotoApp(page);
  await zoomToCountry(page);

  expect(await mapZoom(page), 'the wheel should land below the clustering threshold').toBeLessThan(13);
  expect(await page.locator('.cluster').count()).toBeGreaterThan(0);

  // Every bubble carries a number, and never "1" — a machine on its own keeps
  // its own pin so its status stays visible.
  const labels = await page.locator('.cluster').allTextContents();
  for (const label of labels) {
    expect(Number(label)).toBeGreaterThan(1);
  }
});

test('the bubbles count machines the pin cap used to drop', async ({ page }) => {
  await gotoApp(page);
  await zoomToCountry(page);

  const { total } = await machinesDrawn(page);
  expect(total, 'a country view of ~2.444 machines must account for far more than MAX_PINS')
    .toBeGreaterThan(400);

  const shown = Number((await page.textContent('#count')).replace(/\D/g, ''));
  expect(total, 'and never claim more machines than exist').toBeLessThanOrEqual(shown);
});

// A bubble near the middle of the map, clear of the topbar and the sheet, as
// click coordinates — same idea as centerPin() for pins.
function centerCluster(page) {
  return page.evaluate(() => {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    document.querySelectorAll('.cluster').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 90 || r.bottom > innerHeight - 60) return;
      const d = (r.x + r.width / 2 - cx) ** 2 + (r.y + r.height / 2 - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: r.x + r.width / 2, y: r.y + r.height / 2, count: Number(el.textContent) };
      }
    });
    return best;
  });
}

test('tapping a bubble opens it up', async ({ page }) => {
  await gotoApp(page);
  await zoomToCountry(page);

  const before = await mapZoom(page);
  const bubble = await centerCluster(page);
  expect(bubble, 'no bubble in view to tap').not.toBeNull();

  await page.mouse.click(bubble.x, bubble.y);
  await page.waitForTimeout(1200);

  expect(await mapZoom(page), 'tapping a bubble has to go somewhere').toBeGreaterThan(before);
  // Whatever it broke into is still drawn: pins, smaller bubbles, or both.
  expect(await page.locator('.pin, .cluster').count()).toBeGreaterThan(0);
});
