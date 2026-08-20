// The "+" flow: a submission form (name, chain, optional note), not a
// bare-name pin drop. Two things matter here:
//
//   1. Local mode (what every other spec in this suite runs in) is
//      unchanged — it still adds the machine directly, and the chain
//      picked in the form is the chain the new machine actually gets.
//   2. Live mode queues the submission for review instead: the client must
//      never add a pin for its own unapproved submission. Since fixtures.js
//      deliberately stubs supabase-js empty so this suite can never reach
//      the real project, this file installs its own minimal, fully local
//      `window.supabase` fake — no network call it makes ever leaves the
//      page — just enough surface for app/api.js's connect()/pull()/
//      submitMachine() to run their live-mode code paths.
import { test as base, expect, gotoApp, expectLocalMode } from './fixtures.js';

const test = base;
test.use({ viewport: { width: 834, height: 1112 } });

function chip(page, label) {
  return page.locator('#chains button', { hasText: label }).first();
}

test.describe('add machine form — local mode', () => {
  test('collects name, chain and an optional note, and the chain sticks', async ({ page }) => {
    await gotoApp(page);
    await expectLocalMode(page);

    const beforeLidl = await page.locator('.pin').count(); // sanity only, re-checked below

    await page.click('#add');
    await expect(page.locator('.addbar')).toBeVisible();
    await expect(page.locator('.crosshair')).toBeVisible();

    // The dropdown is built from app/config.js's CHAINS at boot, not
    // hand-typed markup — confirm it actually has the known chains plus
    // "Outra", not just whatever index.html happened to ship empty.
    const chainOptions = await page.$$eval('#add-chain option', (els) => els.map((e) => e.textContent));
    expect(chainOptions[0]).toBe('Outra');
    expect(chainOptions).toEqual(expect.arrayContaining(['Pingo Doce', 'Lidl', 'Continente', 'Coviran']));

    await page.fill('#add-name', 'Lidl Teste E2E');
    await page.selectOption('#add-chain', 'Lidl');
    await page.fill('#add-note', 'ao lado da entrada');
    await expect(page.locator('#add-town')).not.toHaveValue('');

    await expect(page.locator('#add-name')).toHaveValue('Lidl Teste E2E');
    await expect(page.locator('#add-chain')).toHaveValue('Lidl');
    await expect(page.locator('#add-note')).toHaveValue('ao lado da entrada');

    await page.click('#add-save');
    await page.waitForTimeout(600);

    // Local mode's own confirmation wording, unchanged from before this form
    // grew fields.
    await expect(page.locator('.toast')).toContainText('Máquina adicionada');
    await expect(page.locator('body')).not.toHaveClass(/adding/);

    // The chain picked in the form is the chain the machine actually got —
    // the Lidl chip's count goes up by exactly one.
    await page.mouse.move(417, 556);
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(400);

    await chip(page, 'Lidl').click();
    await page.waitForTimeout(500);
    const afterLidl = await page.locator('.pin').count();
    expect(afterLidl).toBe(279); // 278 seeded + the one just added
    expect(beforeLidl).toBeGreaterThan(0); // the earlier read wasn't meaningless
  });

  test('cancelling the form adds nothing', async ({ page }) => {
    await gotoApp(page);
    const before = await page.locator('.pin').count();

    await page.click('#add');
    await page.fill('#add-name', 'Não Vai Ficar');
    await page.click('#add-cancel');

    await expect(page.locator('body')).not.toHaveClass(/adding/);
    const after = await page.locator('.pin').count();
    expect(after).toBe(before);
  });
});

test.describe('add machine form — live mode (locally faked, never reaches Supabase)', () => {
  // Layers on top of fixtures.js's own `context` override (which already
  // stubs the CDN scripts and tile host) rather than replacing it — the
  // `{ context }` this destructures is that base fixture, not itself, which
  // is how Playwright fixture overriding composes.
  const liveTest = base.extend({
    context: async ({ context }, use) => {
      // Runs before app/main.js's module script, and before the (stubbed,
      // empty) supabase-js CDN tag — so this fake is what's still there by
      // the time connect() checks `window.supabase`.
      await context.addInitScript(() => {
        window.__rpcCalls = [];

        function query(data) {
          const q = {
            select: () => q,
            order: () => q,
            gte: () => q,
            eq: () => q,
            range: () => Promise.resolve({ data, error: null }),
          };
          return q;
        }

        const FAKE_MACHINES = [
          { id: 'fake-1', name: 'Pingo Doce Fixture 1', lat: 38.72, lng: -9.14, town: 'Lisboa', chain: 'Pingo Doce', source: 'osm' },
          { id: 'fake-2', name: 'Lidl Fixture 2', lat: 38.73, lng: -9.15, town: 'Lisboa', chain: 'Lidl', source: 'osm' },
          { id: 'fake-3', name: 'Continente Fixture 3', lat: 38.71, lng: -9.13, town: 'Lisboa', chain: 'Continente', source: 'osm' },
        ];

        window.supabase = {
          createClient: function () {
            return {
              from: function (table) {
                return query(table === 'machines' ? FAKE_MACHINES : []);
              },
              rpc: function (name, args) {
                window.__rpcCalls.push({ name, args });
                if (name === 'submit_machine') return Promise.resolve({ data: 'ok', error: null });
                return Promise.resolve({ data: 'ok', error: null });
              },
            };
          },
        };
      });
      await use(context);
    },
  });

  liveTest.use({ viewport: { width: 834, height: 1112 } });

  liveTest('a submission is sent for review and never adds a pin', async ({ page }) => {
    const realHits = [];
    page.on('request', (req) => {
      if (/supabase\.co/.test(req.url())) realHits.push(req.url());
    });

    await gotoApp(page, { waitMs: 1500 });

    // Confirms the fake actually took: this suite is "live" here, unlike
    // every other spec in it.
    await expect(page.locator('#mode')).toHaveText('em direto');

    const before = await page.locator('.pin').count();
    expect(before).toBe(3); // the three fixture machines, nothing more

    await page.click('#add');
    await page.fill('#add-name', 'Submissão Ao Vivo Teste');
    await page.selectOption('#add-chain', 'Continente');
    await page.fill('#add-town', 'Oeiras');
    await page.fill('#add-address', 'Av. Marginal 3');
    await page.fill('#add-note', 'perto da caixa');
    await page.click('#add-save');
    await page.waitForTimeout(600);

    await expect(page.locator('.toast')).toContainText('revisão');
    await expect(page.locator('body')).not.toHaveClass(/adding/);

    const after = await page.locator('.pin').count();
    expect(after, 'a pending submission must not add a pin').toBe(before);

    // The RPC actually carried the form's fields, and no fix was attached —
    // locate was never tapped in this test, and this flow must not prompt
    // for one on its own.
    const calls = await page.evaluate(() => window.__rpcCalls);
    const submit = calls.find((c) => c.name === 'submit_machine');
    expect(submit, 'expected a submit_machine RPC call').toBeTruthy();
    expect(submit.args.name).toBe('Submissão Ao Vivo Teste');
    expect(submit.args.chain).toBe('Continente');
    expect(submit.args.note).toBe('perto da caixa');
    // The two fields this form grew so the database stops guessing them.
    expect(submit.args.town).toBe('Oeiras');
    expect(submit.args.address).toBe('Av. Marginal 3');
    expect(submit.args.from_lat).toBeNull();
    expect(submit.args.from_lng).toBeNull();

    expect(realHits, realHits.join(' | ')).toEqual([]);
  });
});

test.describe('add machine form — concelho', () => {
  test('prefills the concelho from a machine nearby, and offers the known ones', async ({ page }) => {
    await gotoApp(page);
    await page.click('#add');

    // Opening the form over the seeded map should propose something rather
    // than leaving the person to type a concelho they are standing in.
    const suggested = await page.inputValue('#add-town');
    expect(suggested, 'expected a concelho prefilled from a nearby machine').not.toBe('');

    // The datalist is built from the map, not hardcoded in index.html.
    const options = await page.$$eval('#towns option', (els) => els.map((e) => e.value));
    expect(options.length).toBeGreaterThan(10);
    expect(options).toContain(suggested);
    expect(new Set(options).size, 'each concelho should appear once').toBe(options.length);
  });

  test('refuses to submit without a concelho, and says why', async ({ page }) => {
    await gotoApp(page);
    const before = await page.locator('.pin').count();

    await page.click('#add');
    await page.fill('#add-name', 'Sem Concelho Nenhum');
    await page.fill('#add-town', '');
    await page.click('#add-save');
    await page.waitForTimeout(400);

    await expect(page.locator('.toast')).toContainText('concelho');
    await expect(page.locator('body'), 'the form must stay open').toHaveClass(/adding/);
    expect(await page.locator('.pin').count()).toBe(before);
  });

  // The "nothing nearby, so suggest nothing" case — the Pampilhosa bug —
  // is covered by test/vectors/town-suggestion.json rather than here.
  // Reaching it in the browser would mean moving the map hundreds of km
  // from every seeded machine, and the only way to do that from a spec is
  // to expose the Leaflet instance on window. Test-only surface in the
  // shipped app is a worse trade than asserting the same rule where it
  // actually lives.
});
