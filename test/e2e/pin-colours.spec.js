// Pins must render exactly their status colour.
//
// The difference between a green machine and a grey one is the entire
// product, so anything that shifts a pin's colour — an inherited filter, a
// tint applied to the map as a whole, a palette that drifted out of sync
// between CSS and JS — breaks the thing the app is for, quietly and
// without failing anything.
//
// This file exists because all three of those nearly happened: a basemap
// treatment was drafted as an overlay that would have covered the pins,
// and writing the first test here surfaced that app/config.js had been
// left on the pre-redesign palette.
import { test, expect, gotoApp, centerPin } from './fixtures.js';
import { COLOR } from '../../app/config.js';

test.use({ viewport: { width: 834, height: 1112 } });

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

test.describe('pin colours', () => {
  // The regression that would matter: pins rendering as anything other than
  // their exact status colour.
  test('pins keep their exact status colour, untinted', async ({ page }) => {
    await gotoApp(page);

    const painted = await page.evaluate(() => {
      const el = document.querySelector('.pin');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        status: el.dataset.s,
        // A filter inherited from an ancestor would shift the rendered
        // colour even though backgroundColor still reads clean.
        filter: cs.filter,
        paneFilter: getComputedStyle(document.querySelector('.leaflet-marker-pane')).filter,
      };
    });
    expect(painted, 'no pin on screen to check').not.toBeNull();

    const [r, g, b] = rgb(COLOR[painted.status]);
    expect(painted.bg).toBe(`rgb(${r}, ${g}, ${b})`);
    expect(painted.filter, 'a pin must not be filtered').toBe('none');
    expect(painted.paneFilter, 'the marker pane must not be filtered').toBe('none');
  });

  test('nothing painted over the map blocks selecting a machine', async ({ page }) => {
    await gotoApp(page);
    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);
    await expect(page.locator('#sheet')).toHaveClass(/open/);
  });

  // Hit-tested rather than by reading a z-index: Leaflet sets none on the
  // control container, so the number is NaN and proves nothing.
  test('attribution is not painted over', async ({ page }) => {
    await gotoApp(page);
    const credit = page.locator('.leaflet-control-attribution');
    await expect(credit).toContainText('OpenStreetMap');

    const onTop = await page.evaluate(() => {
      const el = document.querySelector('.leaflet-control-attribution');
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(hit) || hit === el;
    });
    expect(onTop, 'something is painted over the attribution').toBe(true);
  });
});
