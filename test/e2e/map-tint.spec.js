// The basemap tint.
//
// The point of these tests is not that the map looks nice — that's a
// judgement, and the preview URL is where it gets made. It's that the tint
// stays where it was put. A treatment applied to the whole map instead of
// just its tiles would drag the status pins toward each other, and the
// difference between a green machine and a grey one is the entire product.
import { test, expect, gotoApp, centerPin } from './fixtures.js';
import { COLOR } from '../../app/config.js';

test.use({ viewport: { width: 834, height: 1112 } });

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

test.describe('basemap tint', () => {
  test('the tile pane is filtered and the tint sits over it', async ({ page }) => {
    await gotoApp(page);

    const tileFilter = await page.$eval('.leaflet-tile-pane', (el) => getComputedStyle(el).filter);
    expect(tileFilter).toContain('saturate');

    const tint = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('map'), '::after');
      return { blend: s.mixBlendMode, z: s.zIndex, events: s.pointerEvents };
    });
    expect(tint.blend).toBe('multiply');
    expect(tint.events, 'the tint must never swallow a tap').toBe('none');
    // Above Leaflet's tile pane (200), below its marker pane (600).
    expect(Number(tint.z)).toBeGreaterThan(200);
    expect(Number(tint.z)).toBeLessThan(600);
  });

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

  test('the tint does not block selecting a machine', async ({ page }) => {
    await gotoApp(page);
    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);
    await expect(page.locator('#sheet')).toHaveClass(/open/);
  });

  // Asserted by hit-testing rather than by reading a z-index: Leaflet does
  // not set one on the control container, so the number is NaN and proves
  // nothing. What matters is that the tint is not painted over the credit.
  test('attribution stays on top of the tint', async ({ page }) => {
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
