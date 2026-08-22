// The admin dashboard's gate, tested where it actually lives.
//
// The panel at admin/ is served from GitHub Pages, from a public repo, with
// the public anon key. That is only acceptable because the page is not the
// gate: public.is_admin() is, and it is a Postgres function. So this suite
// mints real JWTs — signed with the same secret PostgREST is started with —
// and walks every way in that must not work:
//
//   * no token at all
//   * a valid session that is not on the allowlist
//   * on the allowlist, but only one factor deep (aal1)
//   * on the allowlist at aal2, with an email that no longer matches
//
// and then the one that must. test/e2e/admin.spec.js covers what the panel
// *shows*; nothing there can prove any of this, because a browser test can
// only ever check what a fake client told it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dockerAvailable, setup, teardown, BASE_URL, superuserQuery, superuserScalar, JWT_SECRET }
  from './docker-env.js';

const LONG = { timeout: 60_000 };
const TOTAL_MACHINES = 2444;

const ADMIN_UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'isabel@example.com';
const OTHER_UID = 'bbbbbbbb-0000-4000-8000-000000000002';

if (!dockerAvailable()) {
  test('admin suite skipped: Docker is not available in this environment', { skip: true }, () => {});
} else {
  before(setup, LONG);
  after(teardown, LONG);

  function b64url(s) {
    return Buffer.from(s).toString('base64url');
  }

  // A Supabase session token, near enough: PostgREST only cares that it
  // verifies and carries a `role`, and is_admin() reads `sub`, `aal` and
  // `email` out of request.jwt.claims exactly as it would in production.
  function token(claims) {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }));
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  }

  const admin = () => token({ sub: ADMIN_UID, email: ADMIN_EMAIL, aal: 'aal2' });

  async function call(fn, args, jwt) {
    const res = await fetch(`${BASE_URL}/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify(args || {}),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  }

  test('fixture: put one uid on the allowlist', LONG, () => {
    superuserQuery(
      `insert into private.admins (uid, email) values ('${ADMIN_UID}', '${ADMIN_EMAIL}')` +
        ' on conflict (uid) do nothing',
    );
    assert.equal(superuserScalar('select count(*) from private.admins'), '1');
  });

  // ───────────────────── every way in that must not work ─────────────────────

  test('with no token at all, the admin RPCs are not even callable', LONG, async () => {
    for (const fn of ['admin_overview', 'admin_series', 'admin_top', 'admin_errors', 'admin_traces']) {
      const r = await call(fn, { p_days: 7, p_metrics: ['app.visit'], p_metric: 'search.town', p_limit: 5, p_hours: 24 });
      assert.ok(!r.ok, `${fn} answered an anonymous caller with ${r.status}`);
    }
  });

  test('is_admin() is false for anon', LONG, async () => {
    const r = await call('is_admin', {});
    // anon holds no grant on it either, so this is refused before it runs.
    assert.ok(!r.ok, `is_admin was callable by anon: ${r.status} ${r.body}`);
  });

  test('a valid session that is not on the allowlist is refused', LONG, async () => {
    const r = await call('admin_overview', {}, token({ sub: OTHER_UID, email: 'someone@example.com', aal: 'aal2' }));
    assert.ok(!r.ok, 'a stranger with a valid session got data');
    assert.match(r.body, /not authoris/i);
  });

  // The part that makes this two-factor rather than "one factor that happens
  // to be a password": the token has to say a TOTP challenge was passed.
  test('the right uid at aal1 is refused — the second factor is required in the database', LONG, async () => {
    const r = await call('admin_overview', {}, token({ sub: ADMIN_UID, email: ADMIN_EMAIL, aal: 'aal1' }));
    assert.ok(!r.ok, 'a single-factor session got data');
    assert.match(r.body, /not authoris/i);
  });

  test('a token with no aal claim at all is refused', LONG, async () => {
    const r = await call('admin_overview', {}, token({ sub: ADMIN_UID, email: ADMIN_EMAIL }));
    assert.ok(!r.ok, 'a token that simply omitted aal got data');
  });

  // Supabase Auth lets a user change their own email, which is exactly why
  // the allowlist is keyed on the uid — and why the email is then checked
  // against it rather than trusted.
  test('the right uid with a changed email is refused', LONG, async () => {
    const r = await call('admin_overview', {}, token({ sub: ADMIN_UID, email: 'attacker@example.com', aal: 'aal2' }));
    assert.ok(!r.ok, 'an email change carried the privilege with it');
  });

  test('a token signed with the wrong secret is refused', LONG, async () => {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({
      role: 'authenticated', sub: ADMIN_UID, email: ADMIN_EMAIL, aal: 'aal2',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const sig = crypto.createHmac('sha256', 'not-the-secret').update(`${head}.${body}`).digest('base64url');
    const r = await call('admin_overview', {}, `${head}.${body}.${sig}`);
    assert.ok(!r.ok, 'a forged token was accepted');
  });

  // ───────────────────────── and the one that does ─────────────────────────

  test('the real thing gets the overview', LONG, async () => {
    const r = await call('admin_overview', {}, admin());
    assert.ok(r.ok, `admin_overview failed: ${r.status} ${r.body}`);
    const o = JSON.parse(r.body);
    assert.equal(o.machines.total, TOTAL_MACHINES);
    assert.equal(o.machines.total, o.machines.reported_ever + o.machines.never_reported);
    assert.ok(o.coverage_pm >= 0 && o.coverage_pm <= 1000, `coverage_pm out of range: ${o.coverage_pm}`);
    assert.ok(o.telemetry.limits.raw_max > 0);
  });

  test('the other four reads work for an admin', LONG, async () => {
    const a = admin();
    for (const [fn, args] of [
      ['admin_series', { p_days: 30, p_metrics: ['app.visit', 'reports.filed'] }],
      ['admin_top', { p_metric: 'search.town', p_days: 30, p_limit: 5 }],
      ['admin_errors', { p_hours: 24, p_limit: 10 }],
      ['admin_traces', { p_limit: 5 }],
    ]) {
      const r = await call(fn, args, a);
      assert.ok(r.ok, `${fn} failed: ${r.status} ${r.body}`);
      assert.ok(Array.isArray(JSON.parse(r.body)), `${fn} did not return an array`);
    }
  });

  test('reads are logged', LONG, () => {
    const n = Number(superuserScalar(
      `select count(*) from private.admin_access where uid = '${ADMIN_UID}'`,
    ));
    assert.ok(n >= 5, `expected the successful reads to be logged, found ${n}`);
  });

  // The escape hatch is a column rather than a constant, so a phone that
  // cannot hold an authenticator app is a row update, not a migration. It
  // defaults to on, and this is the test that it is actually consulted.
  test('require_aal2 can be relaxed per admin, and defaults to on', LONG, async () => {
    assert.equal(
      superuserScalar(`select require_aal2 from private.admins where uid = '${ADMIN_UID}'`),
      't',
    );
    superuserQuery(`update private.admins set require_aal2 = false where uid = '${ADMIN_UID}'`);
    const r = await call('admin_overview', {}, token({ sub: ADMIN_UID, email: ADMIN_EMAIL, aal: 'aal1' }));
    assert.ok(r.ok, 'relaxing require_aal2 did not let a single-factor session in');
    superuserQuery(`update private.admins set require_aal2 = true where uid = '${ADMIN_UID}'`);
  });

  // The telemetry tables are the reason all of the above matters: they hold
  // every number the panel shows, and no role the API can reach may read them.
  test('no API role can read the telemetry or allowlist tables directly', LONG, async () => {
    for (const t of ['telemetry_daily', 'telemetry_raw', 'admins', 'admin_access']) {
      const res = await fetch(`${BASE_URL}/${t}?select=*`, {
        headers: { Authorization: `Bearer ${admin()}` },
      });
      assert.ok(!res.ok, `${t} was readable over the API, got ${res.status}`);
    }
  });
}
