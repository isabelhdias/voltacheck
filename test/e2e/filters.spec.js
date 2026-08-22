// The filter sheet: status, chain and distance, plus the topbar bar that
// summarises what's active.
//
// The fresh local-mode seed has zero reports on every machine, so by default
// all 2.444 are "stale". That isn't a test artefact — it mirrors production
// today (docs/seed-data-plan.md) — and it's what makes "turn off the only
// non-empty bucket" a realistic case rather than a contrived one.
import { test, expect, gotoApp, centerPin, zoomToCountry } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } });

const sheet = (page) => page.locator('#filters');
const statusRow = (page, word) => page.locator('#statuslist button', { hasText: word }).first();
const chainChip = (page, label) => page.locator('#chains button', { hasText: label }).first();
const radiusBtn = (page, label) => page.locator('#radius button', { hasText: label }).first();

async function openFilters(page) {
  await page.click('#filterbtn');
  await expect(sheet(page)).toBeVisible();
}

// Zoomed out, machines are drawn as counted bubbles rather than pins, so
// "is there anything on the map" has to count both.
const marks = (page) => page.locator('.pin, .cluster');

test.describe('filter bar', () => {
  test('starts clean: no chips, no badge, no clear, and a live count', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('.fchip')).toHaveCount(0);
    await expect(page.locator('#filtercount')).toBeHidden();
    await expect(page.locator('#clear')).toBeHidden();
    await expect(page.locator('#count')).toHaveText(/2\.?444|2444 máquinas neste mapa/);
  });

  test('opens and closes the sheet, including via the scrim and Escape', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    await expect(page.locator('#filterbtn')).toHaveAttribute('aria-expanded', 'true');

    await page.click('#scrim');
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('#filterbtn')).toHaveAttribute('aria-expanded', 'false');

    await openFilters(page);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
  });

  // The regression the test above kept half-catching. openFilters() unhides
  // the sheet and only adds `open` on the next animation frame, so the CSS
  // transition has a from-state. A close landing inside that window removes
  // `open` before the frame runs; the frame then puts it back, and
  // closeFilters()'s timeout checks for `open` before hiding anything, so it
  // declines — leaving the sheet visible with nothing pending to close it.
  //
  // Driven through the module rather than through taps, because the window is
  // one frame wide: a click-then-Escape hits it only sometimes, which is
  // exactly how it showed up — as an Escape test that passed locally and
  // failed in CI.
  test('a close landing inside the open animation frame still closes', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(async () => {
      const ui = await import('/app/ui.js');
      ui.openFilters();
      ui.closeFilters();
    });
    await page.waitForTimeout(800); // well past closeFilters()'s 240ms
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('#filterbtn')).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('status filter', () => {
  test('four rows, all on, counts shown, and "4 de 4"', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);

    const rows = page.locator('#statuslist button');
    await expect(rows).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.locator('#status-of')).toHaveText('4 de 4');
    // Every machine is stale on a fresh seed, so that row carries them all.
    await expect(statusRow(page, 'Sem dados').locator('b')).toHaveText(/2\.?444|2444/);
  });

  test('turning one off adds a chip per remaining status and marks the badge', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    await statusRow(page, 'Sem dados').click();

    await expect(page.locator('#status-of')).toHaveText('3 de 4');
    await expect(page.locator('#filtercount')).toHaveText('1');
    await expect(page.locator('.fchip')).toHaveCount(3);
  });

  test('turning off the only non-empty bucket empties the map and offers a way back', async ({ page }) => {
    await gotoApp(page);
    await zoomToCountry(page);
    expect(await marks(page).count()).toBeGreaterThan(0);

    await openFilters(page);
    await statusRow(page, 'Sem dados').click();
    await page.click('#filters-apply');

    await expect(marks(page)).toHaveCount(0);
    await expect(page.locator('#empty')).toBeVisible();

    await page.click('#empty-clear');
    await expect(page.locator('#empty')).toBeHidden();
    expect(await marks(page).count()).toBeGreaterThan(0);
  });

  // All four off is indistinguishable from a blank map and nobody means it,
  // so clearing the last one resets rather than showing nothing.
  test('unticking every status resets instead of blanking the map', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    for (const w of ['A funcionar', 'Cheias', 'Avariadas', 'Sem dados']) {
      await statusRow(page, w).click();
    }
    await expect(page.locator('#status-of')).toHaveText('4 de 4');
    await expect(page.locator('.fchip')).toHaveCount(0);
  });
});

test.describe('chain filter', () => {
  test('collapsed to a few chips with counts, expandable to the rest', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);

    const chips = page.locator('#chains button:not(.more)');
    const collapsed = await chips.count();
    expect(collapsed).toBeLessThanOrEqual(4);
    // Each chip carries its own machine count, not just a name.
    await expect(chips.first().locator('em')).toHaveText(/\d/);

    await page.click('#chains .more');
    expect(await chips.count()).toBeGreaterThan(collapsed);

    await page.click('#chains .more');
    expect(await chips.count()).toBe(collapsed);
  });

  // Asserted against the count line, not the pin count: pins are capped at
  // MAX_PINS (400), so both the filtered and unfiltered maps can sit at the
  // cap and the narrowing becomes invisible. The count line reports the real
  // nationwide total, which is what the filter actually changed.
  test('picking a chain narrows the map and chips it in the bar', async ({ page }) => {
    await gotoApp(page);
    const before = Number((await page.textContent('#count')).replace(/\D/g, ''));

    await openFilters(page);
    await chainChip(page, 'Pingo Doce').click();
    await page.click('#filters-apply');

    await expect(page.locator('.fchip', { hasText: 'Pingo Doce' })).toHaveCount(1);
    const after = Number((await page.textContent('#count')).replace(/\D/g, ''));
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  // The counts under Estado follow the chain filter. A count showing the
  // national figure while a chain is selected would misstate what the toggle
  // does — the failure most likely to go unnoticed on an all-grey map.
  test('status counts follow the selected chain, not the national total', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    const national = await statusRow(page, 'Sem dados').locator('b').textContent();

    await chainChip(page, 'Pingo Doce').click();
    const chained = await statusRow(page, 'Sem dados').locator('b').textContent();

    expect(chained).not.toBe(national);
    expect(Number(chained.replace(/\D/g, ''))).toBeLessThan(Number(national.replace(/\D/g, '')));
  });
});

test.describe('distance filter', () => {
  test('"Todas" is the default and never asks for a location', async ({ page, context }) => {
    let asked = false;
    await context.grantPermissions([]);
    await page.addInitScript(() => {
      const real = navigator.geolocation.getCurrentPosition;
      window.__asked = false;
      navigator.geolocation.getCurrentPosition = function (...a) {
        window.__asked = true;
        return real.apply(navigator.geolocation, a);
      };
    });
    await gotoApp(page);
    await openFilters(page);

    await expect(radiusBtn(page, 'Todas')).toHaveAttribute('aria-pressed', 'true');
    await radiusBtn(page, 'Todas').click();
    asked = await page.evaluate(() => window.__asked);
    expect(asked, '"Todas" needs no position, so it must not prompt').toBe(false);
  });

  test('picking a radius uses the fix and narrows the map', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 38.7223, longitude: -9.1393 });

    await gotoApp(page);
    const before = Number((await page.textContent('#count')).replace(/\D/g, ''));

    await openFilters(page);
    await radiusBtn(page, '5 km').click();
    await page.waitForTimeout(800);
    await page.click('#filters-apply');

    await expect(page.locator('.fchip', { hasText: '5 km' })).toHaveCount(1);
    const after = Number((await page.textContent('#count')).replace(/\D/g, ''));
    expect(after, 'a 5 km radius around Lisbon is far fewer than the whole country').toBeLessThan(before);
  });

  // With no position the radius cannot bite. Showing an empty map would read
  // as "nothing near you" when the truth is "we don't know where you are".
  test('a denied location keeps every machine and explains why', async ({ page, context }) => {
    await context.setGeolocation({ latitude: 38.7223, longitude: -9.1393 });
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, err) =>
        err && err({ code: 1, message: 'denied' });
    });

    await gotoApp(page);
    const before = Number((await page.textContent('#count')).replace(/\D/g, ''));

    await openFilters(page);
    await radiusBtn(page, '1 km').click();
    await page.waitForTimeout(400);

    await expect(page.locator('#radius-hint')).toBeVisible();
    await page.click('#filters-apply');
    const after = Number((await page.textContent('#count')).replace(/\D/g, ''));
    expect(after, 'no position means the radius cannot bite').toBe(before);
  });
});

test.describe('removing filters', () => {
  test('each chip removes only its own filter', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    await chainChip(page, 'Pingo Doce').click();
    await statusRow(page, 'Cheias').click();
    await page.click('#scrim');

    await expect(page.locator('.fchip', { hasText: 'Pingo Doce' })).toHaveCount(1);
    await page.locator('.fchip', { hasText: 'Pingo Doce' }).click();

    await expect(page.locator('.fchip', { hasText: 'Pingo Doce' })).toHaveCount(0);
    // The status filter is untouched by removing the chain chip.
    await expect(page.locator('#filtercount')).toHaveText('1');
  });

  test('"Limpar filtros" clears everything at once', async ({ page }) => {
    await gotoApp(page);
    await openFilters(page);
    await chainChip(page, 'Pingo Doce').click();
    await statusRow(page, 'Cheias').click();
    await page.click('#scrim');

    await expect(page.locator('#clear')).toBeVisible();
    await page.click('#clear');

    await expect(page.locator('.fchip')).toHaveCount(0);
    await expect(page.locator('#filtercount')).toBeHidden();
    await expect(page.locator('#clear')).toBeHidden();
  });

  test('a selected machine\'s sheet closes when the filter set changes', async ({ page }) => {
    await gotoApp(page);
    const box = await centerPin(page);
    expect(box, 'no pin in view to click').not.toBeNull();
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(700);
    await expect(page.locator('#sheet')).toHaveClass(/open/);

    await openFilters(page);
    await statusRow(page, 'Cheias').click();
    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
  });
});
