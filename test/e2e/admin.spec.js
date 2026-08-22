// The admin panel, driven through the real admin/index.html.
//
// supabase-js is replaced with a fake that answers auth and rpc calls from
// memory, so this never reaches the real project — the same trick every other
// spec here uses, for the same reason. What it can prove:
//
//   * the gate shows the right screen for each state a session can be in,
//     including the one that matters most — signed in, second factor passed,
//     and still not an admin;
//   * no data is drawn before the database has been asked;
//   * all four screens render real numbers without a page error.
//
// What it cannot prove is the gate itself. `public.is_admin()` is the
// security boundary and lives in Postgres; test/integration/admin.test.js is
// where it is actually tested, with real JWTs, against a real database.
//
// The panel's copy is English — only the app is Portuguese — so the strings
// asserted below are English on purpose, not an oversight.
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

// Numbers shaped like the real RPCs' output, small enough to check by eye.
const OVERVIEW = {
  at: new Date().toISOString(),
  machines: { total: 2444, new_7d: 3, reported_ever: 344, never_reported: 2100 },
  coverage_pm: 141,
  reports: { h24: { ok: 12, full: 3, down: 1 }, total: 512 },
  submissions: { pending: 2, oldest_h: 30 },
  traffic: { visits_today: 84, sessions_today: 61, errors_today: 1 },
  telemetry: {
    raw_rows: 812, daily_rows: 240,
    limits: { raw_max: 400000, raw_days: 14 },
    last_seen: new Date(Date.now() - 4 * 60000).toISOString(),
  },
};

const today = new Date().toISOString().slice(0, 10);
const SERIES = [
  { d: today, m: 'reports.filed', k: { status: 'ok' }, v: 12, n: 0, p50: null, p95: null },
  { d: today, m: 'reports.filed', k: { status: 'full' }, v: 3, n: 0, p50: null, p95: null },
  { d: today, m: 'app.visit', k: { mode: 'live' }, v: 84, n: 0, p50: null, p95: null },
  { d: today, m: 'app.session', k: { mode: 'live' }, v: 61, n: 0, p50: null, p95: null },
  { d: today, m: 'sheet.open', k: { state: 'stale' }, v: 30, n: 0, p50: null, p95: null },
  { d: today, m: 'report.tap', k: { status: 'ok' }, v: 18, n: 0, p50: null, p95: null },
  { d: today, m: 'report.result', k: { outcome: 'ok' }, v: 12, n: 0, p50: null, p95: null },
  { d: today, m: 'reports.outcome', k: { outcome: 'ok' }, v: 12, n: 0, p50: null, p95: null },
  { d: today, m: 'reports.outcome', k: { outcome: 'far' }, v: 5, n: 0, p50: null, p95: null },
  { d: today, m: 'reports.outcome', k: { outcome: 'nopos' }, v: 3, n: 0, p50: null, p95: null },
  { d: today, m: 'locate.tap', k: { outcome: 'granted' }, v: 9, n: 0, p50: null, p95: null },
  { d: today, m: 'machines.new', k: { source: 'user' }, v: 1, n: 0, p50: null, p95: null },
  { d: today, m: 'app.boot.duration', k: { mode: 'live' }, v: 0, n: 40, p50: 500, p95: 2500 },
  { d: today, m: 'db.pull.duration', k: { kind: 'machines' }, v: 0, n: 40, p50: 250, p95: 1000 },
  { d: today, m: 'db.pull.duration', k: { kind: 'reports' }, v: 0, n: 40, p50: 100, p95: 500 },
  { d: today, m: 'db.rpc.duration', k: { rpc: 'report_machine', outcome: 'ok' }, v: 0, n: 12, p50: 100, p95: 250 },
];

// `mfa` and `admin` steer which branch of the gate the fake lands in.
function fakeSupabase({ mfa = 'enrolled', admin = true } = {}) {
  return `
window.__state = { signedIn:false, aal:'aal1', mfa:${JSON.stringify(mfa)}, admin:${admin}, calls:[] };
window.supabase = {
  createClient: function(){
    var S = window.__state;
    return {
      auth: {
        getSession: function(){
          return Promise.resolve({ data:{ session: S.signedIn
            ? { user:{ id:'aaaaaaaa-0000-4000-8000-000000000001', email:'isabel@example.com' } }
            : null }, error:null });
        },
        signInWithPassword: function(c){
          if(c.password !== 'correct'){
            return Promise.resolve({ data:null, error:{ message:'Invalid login credentials' } });
          }
          S.signedIn = true;
          return Promise.resolve({ data:{ user:{ id:'u' } }, error:null });
        },
        signOut: function(){ S.signedIn = false; return Promise.resolve({ error:null }); },
        mfa: {
          getAuthenticatorAssuranceLevel: function(){
            return Promise.resolve({ data:{
              currentLevel: S.aal,
              nextLevel: S.mfa === 'none' ? 'aal1' : 'aal2'
            }, error:null });
          },
          listFactors: function(){
            return Promise.resolve({ data:{ all: S.mfa === 'none' ? []
              : [{ id:'f1', factor_type:'totp', status:'verified' }] }, error:null });
          },
          enroll: function(){
            S.mfa = 'enrolled';
            return Promise.resolve({ data:{ id:'f1', totp:{
              qr_code:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
              secret:'JBSWY3DPEHPK3PXP' } }, error:null });
          },
          unenroll: function(){ return Promise.resolve({ data:{}, error:null }); },
          challengeAndVerify: function(c){
            if(c.code !== '123456'){
              return Promise.resolve({ data:null, error:{ message:'Invalid TOTP code' } });
            }
            S.aal = 'aal2';
            return Promise.resolve({ data:{}, error:null });
          }
        }
      },
      rpc: function(fn, args){
        S.calls.push(fn);
        if(!S.admin || S.aal !== 'aal2'){
          return Promise.resolve({ data:null, error:{ code:'42501', message:'not authorised' } });
        }
        var data = { admin_overview:${JSON.stringify(OVERVIEW)},
                     admin_series:${JSON.stringify(SERIES)},
                     admin_top:[{k:{town:'Lisboa'},v:9},{k:{chain:'Lidl'},v:4}],
                     admin_errors:[{msg:'x is not a function',kind:'js.error',n:3,
                                    last_seen:new Date().toISOString(),sessions:2,releases:['abc1234']}],
                     admin_traces:[{trace:'0123456789abcdef0123456789abcdef',
                                    started:new Date().toISOString(), total_ms:1800,
                                    spans:[{name:'app.boot',span:'aaaaaaaaaaaaaaaa',parent:null,
                                            at:new Date().toISOString(),ms:1800,a:{}},
                                           {name:'db.pull',span:'bbbbbbbbbbbbbbbb',parent:'aaaaaaaaaaaaaaaa',
                                            at:new Date().toISOString(),ms:812,a:{}}]}] }[fn];
        return Promise.resolve({ data:data === undefined ? [] : data, error:null });
      }
    };
  }
};`;
}

async function openAdmin(page, opts) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/supabase-js@2', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: fakeSupabase(opts) })
  );
  // Belt and braces: nothing in this spec may address the real project.
  await page.route('**://*.supabase.co/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  );
  await page.goto('/admin/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return errors;
}

async function signIn(page, { password = 'correct', code = '123456' } = {}) {
  await page.fill('#email', 'isabel@example.com');
  await page.fill('#pw', password);
  await page.click('#login button');
  await page.waitForTimeout(300);
  if (await page.locator('#mfa').isVisible()) {
    await page.fill('#code', code);
    await page.click('#mfa button');
    await page.waitForTimeout(500);
  }
}

test.describe('admin panel', () => {
  test('shows the login form and nothing else', async ({ page }) => {
    await openAdmin(page);
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#panel')).toBeHidden();
    // The point: no request for data has been made yet, so there is nothing
    // on the page that could have leaked.
    expect(await page.evaluate(() => window.__state.calls)).toEqual([]);
  });

  test('a wrong password says so plainly and stays put', async ({ page }) => {
    await openAdmin(page);
    await signIn(page, { password: 'wrong' });
    await expect(page.locator('#gate-err')).toHaveText('Wrong email or password.');
    await expect(page.locator('#panel')).toBeHidden();
  });

  test('the password alone is not enough — the second factor is asked for', async ({ page }) => {
    await openAdmin(page);
    await page.fill('#email', 'isabel@example.com');
    await page.fill('#pw', 'correct');
    await page.click('#login button');
    await page.waitForTimeout(400);
    await expect(page.locator('#mfa')).toBeVisible();
    await expect(page.locator('#panel')).toBeHidden();
    expect(await page.evaluate(() => window.__state.calls)).toEqual([]);
  });

  test('a wrong code does not open the panel', async ({ page }) => {
    await openAdmin(page);
    await signIn(page, { code: '000000' });
    await expect(page.locator('#gate-err')).toHaveText('Wrong or expired code.');
    await expect(page.locator('#panel')).toBeHidden();
  });

  test('no second factor yet offers enrolment rather than the panel', async ({ page }) => {
    await openAdmin(page, { mfa: 'none' });
    await page.fill('#email', 'isabel@example.com');
    await page.fill('#pw', 'correct');
    await page.click('#login button');
    await page.waitForTimeout(400);
    await expect(page.locator('#enrol')).toBeVisible();
    await expect(page.locator('#secret')).toHaveValue('JBSWY3DPEHPK3PXP');
  });

  // Signed in, second factor passed, and still refused by the database. This
  // is the case a UI-only gate would get wrong, and the panel has to say
  // something better than an empty screen.
  test('a valid session that is not an admin is told exactly what to do', async ({ page }) => {
    await openAdmin(page, { admin: false });
    await signIn(page);
    await expect(page.locator('#notadmin')).toBeVisible();
    await expect(page.locator('#panel')).toBeHidden();
    await expect(page.locator('#grantsql')).toContainText('insert into private.admins');
    await expect(page.locator('#grantsql')).toContainText('aaaaaaaa-0000-4000-8000-000000000001');
  });

  test('Now leads with live coverage', async ({ page }) => {
    const errors = await openAdmin(page);
    await signIn(page);
    await expect(page.locator('#panel')).toBeVisible();
    // Not redundant with the above: #gate carries `display:grid`, which beats
    // the [hidden] attribute, so the login card once stayed on the page behind
    // the dashboard.
    await expect(page.locator('#gate')).toBeHidden();
    await expect(page.locator('#screen')).toContainText('Live coverage');
    // 141 per-mille is 14.1% — the per-mille-to-percent conversion is the
    // kind of thing that silently ships as 141% or 1.41%.
    await expect(page.locator('#screen')).toContainText('14.1%');
    await expect(page.locator('#screen')).toContainText('2,444');
    expect(errors).toEqual([]);
  });

  test('all four screens render without a page error', async ({ page }) => {
    const errors = await openAdmin(page);
    await signIn(page);

    const tabs = page.locator('#tabs button');
    await expect(tabs).toHaveCount(4);

    for (const label of ['Activity', 'Behaviour', 'Health']) {
      await page.click(`#tabs button:text-is("${label}")`);
      await page.waitForTimeout(500);
      await expect(page.locator('#screen')).not.toContainText('Loading');
      await expect(page.locator('#screen')).not.toContainText('Could not load');
    }
    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('Behaviour shows the report funnel and the rejection breakdown', async ({ page }) => {
    await openAdmin(page);
    await signIn(page);
    await page.click('#tabs button:text-is("Behaviour")');
    await page.waitForTimeout(500);
    const screen = page.locator('#screen');
    await expect(screen).toContainText('Opened the map');
    await expect(screen).toContainText('Tapped a state');
    // The most actionable number in the whole dashboard.
    await expect(screen).toContainText('Too far away');
    // And its neighbour since the proximity check stopped failing open: how
    // many people are being turned away for sharing no location at all. An
    // outcome with no entry in OUTCOME renders as the bare database string,
    // which is how this one would quietly go unlabelled.
    await expect(screen).toContainText('No location shared');

    // And the bars next to those numbers are actually drawn. They were not,
    // once: a percentage-width block in an auto-layout table cell collapsed
    // the whole column to zero, and every bar rendered invisible while the
    // text beside it looked perfect.
    const bar = screen.locator('table.hb td:nth-child(2) span').first();
    const w = await bar.evaluate((el) => el.getBoundingClientRect().width);
    expect(w, 'the bars are invisible').toBeGreaterThan(10);
  });

  test('Health reports latency as bucket bounds, not invented precision', async ({ page }) => {
    await openAdmin(page);
    await signIn(page);
    await page.click('#tabs button:text-is("Health")');
    await page.waitForTimeout(500);
    const screen = page.locator('#screen');
    await expect(screen).toContainText('≤');
    await expect(screen).toContainText('x is not a function');
    await expect(screen).toContainText('app.boot');
  });

  // ───────────────── when the panel itself is broken ─────────────────
  //
  // These are the tests for the failure mode that took a live debugging
  // session to find: the login form used to be visible in the markup by
  // default and the listeners were attached after the boot, so anything that
  // threw on the way up left a page that looked completely normal and did
  // nothing at all when tapped. No message, nowhere to look, on a phone with
  // no console.

  test('a module that throws says what threw, instead of showing a dead form', async ({ page }) => {
    await page.route('**/supabase-js@2', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fakeSupabase() })
    );
    // Break the panel the way a real fault would: an exception while the
    // module is being evaluated.
    await page.route('**/admin/main.js', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: 'throw new Error("boom from main.js");' })
    );
    await page.goto('/admin/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    await expect(page.locator('#gate-err')).toContainText('boom from main.js');
    // And no form that cannot possibly work.
    await expect(page.locator('#login')).toBeHidden();
  });

  test('a module that never loads at all still says so', async ({ page }) => {
    await page.route('**/supabase-js@2', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fakeSupabase() })
    );
    // A 404 on a module script reports on the script element, not on window,
    // so neither error handler fires — this is the case the watchdog exists
    // for, and the one that would otherwise stay completely silent.
    await page.route('**/admin/main.js', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('/admin/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // the watchdog waits 2s after load

    await expect(page.locator('#gate-err')).toContainText('did not load');
    await expect(page.locator('#login')).toBeHidden();
  });

  // The PR-preview case: app/config.js blanked, so the panel has no project
  // to talk to and must say so rather than showing an empty dashboard.
  test('with no Supabase configured it explains itself instead of failing', async ({ page }) => {
    await page.route('**/supabase-js@2', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fakeSupabase() })
    );
    await page.route('**/app/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text())
        .replace(/^export const SUPABASE_URL.*$/m, 'export const SUPABASE_URL = "";')
        .replace(/^export const SUPABASE_ANON_KEY.*$/m, 'export const SUPABASE_ANON_KEY = "";');
      await route.fulfill({ contentType: 'application/javascript', body });
    });
    await page.goto('/admin/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await expect(page.locator('#gate-note')).toContainText('No Supabase project configured');
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#panel')).toBeHidden();
  });
});
