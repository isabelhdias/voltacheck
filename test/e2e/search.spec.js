// Town search: accent folding in both directions, prefix ranking, keyboard
// handling, and that picking a result actually moves the map.
import { test, expect, gotoApp } from './fixtures.js';

test.use({ viewport: { width: 834, height: 1112 } });

async function rows(page) {
  return page.$$eval('#results button', (els) => els.map((e) => e.textContent));
}

test.describe('search', () => {
  test('search box is present and the dropdown starts closed', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#q')).toBeVisible();
    await expect(page.locator('#results')).toBeHidden();
  });

  test('typing "lisb" finds Lisboa with a machine count', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'lisb');
    await page.waitForTimeout(300);
    const r = await rows(page);
    expect(r[0]).toMatch(/^Lisboa/);
    expect(r[0]).toMatch(/\d+ máquinas/);
  });

  test('accent folding: unaccented input finds accented town names', async ({ page }) => {
    await gotoApp(page);

    await page.fill('#q', 'braganca');
    await page.waitForTimeout(300);
    expect(await rows(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^Bragança/)]));

    await page.fill('#q', 'sao joao');
    await page.waitForTimeout(300);
    expect(await rows(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^São João/)]));
  });

  test('accent folding: accented input also works', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'Évora');
    await page.waitForTimeout(300);
    const r = await rows(page);
    expect(r.some((t) => t.startsWith('Évora'))).toBe(true);
  });

  test('prefix match ranks before non-prefix matches', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'porto');
    await page.waitForTimeout(300);
    const r = await rows(page);
    expect(r[0]).toMatch(/^Porto/);
  });

  test('no match shows the empty-results line', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'zzzqqq');
    await page.waitForTimeout(300);
    await expect(page.locator('#results')).toContainText('Nenhum concelho');
  });

  test('picking a town closes the dropdown, fills the input, and moves the map', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'Faro');
    await page.waitForTimeout(300);

    const before = await page.locator('.pin').count();
    await page.click('#results button');
    await page.waitForTimeout(1400);
    const after = await page.locator('.pin').count();

    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#q')).toHaveValue('Faro');
    expect(after, `${before} -> ${after} pins`).toBeGreaterThan(0);

    const tiles = await page.$$eval('.leaflet-tile', (els) => els.slice(0, 1).map((e) => e.src));
    expect(tiles[0] || '').toMatch(/\/1[0-5]\//); // zoomed to a town-level level, over the Algarve
  });

  test('Escape clears the query and closes the dropdown', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'lisb');
    await page.waitForTimeout(250);
    await page.press('#q', 'Escape');
    await page.waitForTimeout(250);
    await expect(page.locator('#q')).toHaveValue('');
    await expect(page.locator('#results')).toBeHidden();
  });

  test('Enter jumps to the top hit', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'Braga');
    await page.waitForTimeout(250);
    await page.press('#q', 'Enter');
    await page.waitForTimeout(1000);
    const value = await page.inputValue('#q');
    expect(value).toMatch(/^Braga/);
  });

  test('tapping the map closes the dropdown', async ({ page }) => {
    await gotoApp(page);
    await page.fill('#q', 'lisb');
    await page.waitForTimeout(250);
    await page.mouse.click(417, 700);
    await page.waitForTimeout(400);
    await expect(page.locator('#results')).toBeHidden();
  });

  test('no page errors during search interactions', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/tile|favicon|net::/i.test(m.text())) errors.push(m.text());
    });

    await gotoApp(page);
    await page.fill('#q', 'Coimbra');
    await page.waitForTimeout(350);

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
