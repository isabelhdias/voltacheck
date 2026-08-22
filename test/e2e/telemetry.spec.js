// The browser half of the telemetry pipeline, driven through the real
// index.html.
//
// Every other spec in this suite runs in local mode, where telemetry is off
// by design (local-mode.spec.js asserts exactly that). This one is the
// opposite case and the only one that needs it: supabase-js is replaced with
// a fake client that answers from memory, so `connect()` reports live and
// app/telemetry.js switches on — without a single byte reaching the real
// project.
//
// Two layers of belt and braces on that promise, because `app/config.js`
// carries the live URL and key:
//
//   * the fake client makes no network calls at all, so nothing but the
//     telemetry flush ever addresses supabase.co;
//   * every request to *.supabase.co is intercepted and fulfilled locally
//     before the page loads, and the test fails if one addresses anything
//     other than the ingest endpoint.
//
// What it proves is the thing CI otherwise cannot: that the payload leaving
// a browser is one public.ingest_telemetry() would accept — right envelope
// version, a real uuid session, registered metric names, and trace and span
// ids of exactly the length the database decodes as bytea.
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

// Enough of supabase-js for app/api.js: from().select().order()/.gte() then
// .range(), and .rpc(). Two machines is plenty — this spec is about the
// telemetry, not the map.
const FAKE_SUPABASE = `
window.supabase = {
  createClient: function(){
    var machines = [
      { id:'11111111-1111-1111-1111-111111111111', name:'Pingo Doce Teste',
        lat:38.7380, lng:-9.1450, town:'Lisboa', chain:'Pingo Doce', source:'osm' },
      { id:'22222222-2222-2222-2222-222222222222', name:'Continente Teste',
        lat:38.7390, lng:-9.1460, town:'Lisboa', chain:'Continente', source:'osm' }
    ];
    function table(name){
      var q = {
        select: function(){ return q; },
        order:  function(){ return q; },
        gte:    function(){ return q; },
        range:  function(from){
          var rows = name === 'machines' ? machines : [];
          return Promise.resolve({ data: from === 0 ? rows : [], error: null });
        }
      };
      return q;
    }
    return {
      from: table,
      rpc: function(fn){
        window.__rpc = (window.__rpc || []).concat([fn]);
        return Promise.resolve({ data: 'ok', error: null });
      }
    };
  }
};
`;

async function liveApp(page) {
  const flushes = [];
  const strays = [];

  await page.route('**/supabase-js@2', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE })
  );

  // Nothing reaches the real project. Anything addressed at it that is not
  // the ingest endpoint is recorded and fails the test below.
  await page.route('**://*.supabase.co/**', (route) => {
    const req = route.request();
    if (req.url().includes('/rpc/ingest_telemetry')) {
      flushes.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ contentType: 'application/json', body: '"ok"' });
    }
    strays.push(req.method() + ' ' + req.url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return { flushes, strays };
}

// The app flushes on `hidden` rather than only on pagehide, because an iOS
// tab that is switched away from is often frozen before pagehide ever fires.
async function forceFlush(page) {
  await page.evaluate(() => import('/app/telemetry.js').then((t) => t.flush()));
  await page.waitForTimeout(400);
}

test.describe('telemetry', () => {
  test('goes live against the fake client and never addresses anything but the ingest endpoint', async ({ page }) => {
    const { strays } = await liveApp(page);
    await expect(page.locator('#mode')).toHaveText('em direto');
    expect(strays, `unexpected request to the live project: ${strays.join(', ')}`).toHaveLength(0);
  });

  test('a visit sends an envelope public.ingest_telemetry() would accept', async ({ page }) => {
    const { flushes } = await liveApp(page);
    await forceFlush(page);

    expect(flushes.length, 'nothing was flushed').toBeGreaterThan(0);
    const payload = flushes[0].payload;

    expect(payload.v).toBe(1);
    expect(payload.mode).toBe('live');
    // The database casts this to uuid and returns 'invalid' if it cannot.
    expect(payload.sess).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof payload.rel).toBe('string');

    const names = payload.m.map((e) => e.n);
    expect(names).toContain('app.visit');
    expect(names).toContain('app.session');
    expect(names).toContain('page.view');

    // Server-side caps in private.telemetry_limits(): the client trims to the
    // same numbers so a flush is never refused wholesale for being too big.
    expect(payload.m.length + payload.h.length).toBeLessThanOrEqual(200);
    expect(payload.r.length).toBeLessThanOrEqual(20);

    // Every dimension value is a string; the registry's checks assume it and
    // drop the whole entry otherwise.
    payload.m.concat(payload.h).forEach((e) => {
      Object.values(e.d || {}).forEach((v) => expect(typeof v).toBe('string'));
    });
  });

  test('boot and pull latency arrive as histograms', async ({ page }) => {
    const { flushes } = await liveApp(page);
    await forceFlush(page);

    const h = {};
    flushes.forEach((f) => (f.payload.h || []).forEach((e) => { h[e.n] = e; }));

    expect(Object.keys(h)).toContain('app.boot.duration');
    expect(Object.keys(h)).toContain('db.pull.duration');
    // Values are milliseconds, one per observation — the database buckets
    // them; the client does not pre-aggregate.
    expect(Array.isArray(h['db.pull.duration'].v)).toBe(true);
    h['db.pull.duration'].v.forEach((ms) => expect(ms).toBeGreaterThanOrEqual(0));
    expect(h['db.pull.duration'].d.kind).toMatch(/^(machines|reports)$/);
  });

  test('trace and span ids are the exact lengths the database decodes', async ({ page }) => {
    const { flushes } = await liveApp(page);
    // A raw span only ships when its trace wins the 2% sampling roll, errored,
    // or was slow — so rather than retrying until one appears, this records
    // one directly through the same entry point the app uses.
    await page.evaluate(() =>
      import('/app/telemetry.js').then((t) => {
        const s = t.span('test.span');
        s.end('error', { probe: true }); // 'error' is always kept
        t.log(t.SEV.ERROR, 'test.log', { probe: true });
      })
    );
    await forceFlush(page);

    const raw = flushes.flatMap((f) => f.payload.r || []);
    const span = raw.find((r) => r.n === 'test.span');
    expect(span, 'the span was not flushed').toBeTruthy();
    // private.hex_id() returns null for anything that is not exactly this,
    // and ingest_telemetry() then refuses the span outright.
    expect(span.t).toMatch(/^[0-9a-f]{32}$/);
    expect(span.s).toMatch(/^[0-9a-f]{16}$/);
    expect(span.a['otel.status_code']).toBe('ERROR');

    const log = raw.find((r) => r.n === 'test.log');
    expect(log.k).toBe('log');
    expect(log.sev).toBe(17); // OTel SEVERITY_NUMBER_ERROR
  });

  test('a report records the outcome the phone actually saw', async ({ page }) => {
    const { flushes } = await liveApp(page);

    // Open the sheet on the machine under the map centre and report a state.
    await page.evaluate(() =>
      import('/app/ui.js').then((ui) => ui.select('11111111-1111-1111-1111-111111111111'))
    );
    await page.waitForTimeout(300);
    await page.click('.choice[data-s="ok"]');
    await page.waitForTimeout(600);
    await forceFlush(page);

    const m = flushes.flatMap((f) => f.payload.m || []);
    const tap = m.find((e) => e.n === 'report.tap');
    const result = m.find((e) => e.n === 'report.result');
    expect(tap, 'report.tap was not recorded').toBeTruthy();
    expect(tap.d.status).toBe('ok');
    // report.result is what the browser saw come back, which is deliberately
    // separate from the server's own reports.outcome: when they disagree, the
    // difference is the network, and that is the interesting number.
    expect(result, 'report.result was not recorded').toBeTruthy();
    expect(result.d.outcome).toBe('ok');

    expect(await page.evaluate(() => window.__rpc || [])).toContain('report_machine');
  });

  test('opening a machine counts once, and refreshing it does not count again', async ({ page }) => {
    const { flushes } = await liveApp(page);

    await page.evaluate(() =>
      import('/app/ui.js').then(async (ui) => {
        ui.select('11111111-1111-1111-1111-111111111111');
        // The refresh path: select() called again for the same machine, which
        // is what happens after a locate, a report, or a foreground pull.
        ui.select('11111111-1111-1111-1111-111111111111');
        ui.select('11111111-1111-1111-1111-111111111111');
      })
    );
    await page.waitForTimeout(300);
    await forceFlush(page);

    const opens = flushes
      .flatMap((f) => f.payload.m || [])
      .filter((e) => e.n === 'sheet.open')
      .reduce((n, e) => n + e.v, 0);
    expect(opens, 'the sheet refresh was counted as a second open').toBe(1);
  });
});
