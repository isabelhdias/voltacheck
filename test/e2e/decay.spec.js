// What an aged report looks like.
//
// Decay used to drop a machine to grey at 18 h, which read as harsher than
// the truth: the app knew what the machine last was and threw it away.
// Now the pin keeps its hue and goes hollow, and the sheet says when the
// report was filed. The line this suite has to hold is that "faded" never
// becomes "fresh": a washed-out pin is still excluded from its status
// filter, still carries the "sem dados recentes" warning, and still offers
// no pre-ticked answer to agree with.
import { test, expect, gotoApp, centerPin } from './fixtures.js';
import { COLOR, FADED, FADED_INK, STALE_AFTER, HOUR } from '../../app/config.js';
import { SEED } from '../../seed/machines.js';

test.use({ viewport: { width: 834, height: 1112 } });

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

// Every seeded machine gets the same report at the same age, so whichever
// pins the viewport happens to draw are all the case under test — no
// hunting for one particular machine among 2.444.
async function seedAllReports(page, { status, ageMs }) {
  const at = Date.now() - ageMs;
  const reports = {};
  for (const s of SEED) reports['osm-' + s[5]] = [{ s: status, at }];

  await page.evaluate(
    ([reports]) => localStorage.setItem('centimo.v2', JSON.stringify({ reports, custom: [] })),
    [reports]
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}

async function paintedPins(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.pin')).slice(0, 40).map((el) => {
      const cs = getComputedStyle(el);
      return {
        status: el.dataset.s,
        faded: el.dataset.faded === '1',
        bg: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderTopColor,
      };
    })
  );
}

test.describe('decay', () => {
  test('a report past 18 h keeps its colour, hollow — it never turns grey', async ({ page }) => {
    await gotoApp(page);
    await seedAllReports(page, { status: 'full', ageMs: STALE_AFTER + HOUR });

    const pins = await paintedPins(page);
    expect(pins.length, 'no pins on screen to check').toBeGreaterThan(0);

    for (const pin of pins) {
      expect(pin.status, 'an aged report must keep its own status, not become stale').toBe('full');
      expect(pin.faded).toBe(true);
      expect(pin.bg).toBe(rgb(FADED.full));
      expect(pin.color).toBe(rgb(FADED_INK.full));
      // The ring is what keeps a pale pin findable against the basemap.
      expect(pin.borderColor).toBe(rgb(COLOR.full));
      // The regression this whole change is about.
      expect(pin.bg).not.toBe(rgb(COLOR.stale));
    }
  });

  test('a report inside 18 h is still painted solid', async ({ page }) => {
    await gotoApp(page);
    await seedAllReports(page, { status: 'full', ageMs: 2 * HOUR });

    const pins = await paintedPins(page);
    expect(pins.length).toBeGreaterThan(0);

    for (const pin of pins) {
      expect(pin.faded, 'a 2 h-old report is current, not faded').toBe(false);
      expect(pin.bg).toBe(rgb(COLOR.full));
      expect(pin.color).toBe('rgb(255, 255, 255)');
    }
  });

  test('the sheet timestamps the last report, aged or not', async ({ page }) => {
    await gotoApp(page);
    await seedAllReports(page, { status: 'full', ageMs: 20 * HOUR });

    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);

    // What was reported and how long ago — both of which an aged machine
    // used to stop saying entirely.
    await expect(page.locator('#s-state')).toContainText('Cheia');
    await expect(page.locator('#s-state')).toContainText('há 20 h');
    await expect(page.locator('#s-state')).toHaveAttribute('data-faded', '1');

    // dd/mm, hh:mm — the absolute stamp beside the relative one.
    const stamp = page.locator('#s-stamp');
    await expect(stamp).toBeVisible();
    await expect(stamp).toContainText(/Último report: \d{2}\/\d{2}, \d{2}:\d{2}/);
    // The colour got softer; the warning did not go away with it.
    await expect(stamp.locator('b')).toHaveText('sem dados recentes');

    // Nothing is pre-ticked: a faded state is not one to nod along to.
    await expect(page.locator('.choice[data-cur="1"]')).toHaveCount(0);
    await expect(page.locator('#s-ask')).toHaveText('Estiveste lá agora?');
  });

  test('a fresh report is stamped too, without the stale warning', async ({ page }) => {
    await gotoApp(page);
    await seedAllReports(page, { status: 'ok', ageMs: 4 * HOUR });

    const box = await centerPin(page);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);

    const stamp = page.locator('#s-stamp');
    await expect(stamp).toBeVisible();
    await expect(stamp).toContainText(/Último report: \d{2}\/\d{2}, \d{2}:\d{2}/);
    await expect(stamp.locator('b')).toHaveCount(0);

    await expect(page.locator('#s-state')).not.toHaveAttribute('data-faded', '1');
    await expect(page.locator('#s-ask')).toHaveText('Ainda está assim?');
    await expect(page.locator('.choice[data-cur="1"]')).toHaveCount(1);
  });

  // The mechanic, stated as a filter: fading changed how a decayed machine
  // is drawn and nothing else. "Cheias" still means machines someone
  // confirmed were full — not ones that were full yesterday.
  test('a faded machine still counts as no-recent-data, not as its old status', async ({ page }) => {
    await gotoApp(page);
    await seedAllReports(page, { status: 'full', ageMs: STALE_AFTER + HOUR });

    await page.click('#filterbtn');
    await expect(page.locator('#filters')).toBeVisible();

    const count = (word) =>
      page.locator('#statuslist button', { hasText: word }).first().locator('b');

    await expect(count('Cheias')).toHaveText('0');
    await expect(count('Sem dados há 18 h')).toHaveText(String(SEED.length));
  });
});
