// Integration tests against real Postgres + PostgREST containers — no
// supabase-js, no mocks. This is the only suite that exercises app/api.js's
// paging logic, RLS, and the report_machine() rate-limiting RPC against an
// actual database, the way the e2e suite deliberately does not (it stubs
// supabase-js so it can never touch the live project — see test/e2e/fixtures.js).
//
// The regression this suite exists for: Supabase caps API responses at 1000
// rows by default. With 2444 machines, unpaged live mode silently showed
// ~40% of the country and nothing caught it. See docs/seed-data-plan.md.
//
// Requires a working Docker daemon. If one isn't available this file skips
// itself with a clear message rather than failing — see dockerAvailable()
// below — so `npm test` still passes on a machine without Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  dockerAvailable,
  setup,
  teardown,
  BASE_URL,
  superuserQuery,
  superuserScalar,
  reapplySchema,
  reapplySeed,
} from './docker-env.js';

const LONG = { timeout: 60_000 };
const TOTAL_MACHINES = 2444;
const PAGE = 1000; // mirrors app/api.js's PAGE constant

if (!dockerAvailable()) {
  test('integration suite skipped: Docker is not available in this environment', { skip: true }, () => {});
} else {
  before(setup, LONG);
  after(teardown, LONG);

  // ───────────────────────── pagination ─────────────────────────
  // The regression test for the shipped bug. PGRST_DB_MAX_ROWS=1000 (set in
  // docker-env.js) reproduces Supabase's documented default cap.

  test('unpaged GET /machines is capped at 1000 rows', LONG, async () => {
    const res = await fetch(`${BASE_URL}/machines?select=id`, {
      headers: { Prefer: 'count=exact' },
    });
    assert.equal(res.status, 206); // Partial Content — PostgREST's signal that more rows exist
    assert.equal(res.headers.get('content-range'), `0-999/${TOTAL_MACHINES}`);
    const body = await res.json();
    assert.equal(body.length, PAGE);
  });

  test('paging in blocks of 1000 (app/api.js pageAll) retrieves all 2444 rows', LONG, async () => {
    // Mirrors app/api.js's pageAll(): Range-Unit/Range headers, stop once a
    // page comes back shorter than PAGE.
    let all = [];
    for (let from = 0; ; from += PAGE) {
      const res = await fetch(`${BASE_URL}/machines?select=id&order=id.asc`, {
        headers: { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}` },
      });
      assert.ok(res.ok, `page at offset ${from} failed: ${res.status}`);
      const page = await res.json();
      all = all.concat(page);
      if (page.length < PAGE) break;
    }
    assert.equal(all.length, TOTAL_MACHINES);
    assert.equal(new Set(all.map((m) => m.id)).size, TOTAL_MACHINES, 'no duplicate ids across pages');
  });

  // ───────────────────────── report_machine RPC ─────────────────────────

  let machineId, machineLat, machineLng;

  test('fixture: pick a real machine to report against', LONG, async () => {
    const res = await fetch(`${BASE_URL}/machines?select=id,lat,lng&limit=1`);
    const [m] = await res.json();
    assert.ok(m, 'expected at least one seeded machine');
    machineId = m.id;
    machineLat = m.lat;
    machineLng = m.lng;
  });

  async function reportMachine(body, forwardedFor) {
    const res = await fetch(`${BASE_URL}/rpc/report_machine`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(res.ok, `rpc call failed: ${res.status} ${text}`);
    return JSON.parse(text);
  }

  test('report_machine: at the machine returns ok', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat, lng: machineLng },
      '85.240.10.7',
    );
    assert.equal(result, 'ok');
  });

  test('report_machine: immediately again returns cooldown', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat, lng: machineLng },
      '85.240.10.7',
    );
    assert.equal(result, 'cooldown');
  });

  test('report_machine: from Porto coords returns far', LONG, async () => {
    // Porto city centre — comfortably >500m from any single machine.
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: 41.1579, lng: -8.6291 },
      '85.240.10.7',
    );
    assert.equal(result, 'far');
  });

  test('report_machine: bad status string returns invalid', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'bogus' },
      '85.240.10.7',
    );
    assert.equal(result, 'invalid');
  });

  test('report_machine: unknown machine uuid returns unknown', LONG, async () => {
    const result = await reportMachine(
      { machine: '00000000-0000-0000-0000-000000000000', state: 'ok' },
      '85.240.10.7',
    );
    assert.equal(result, 'unknown');
  });

  // Fail-open cases the rate limiter's design depends on. Distinct
  // X-Forwarded-For values so these don't trip the cooldown set up by the
  // "at the machine" test above, which used the same machine.

  test('report_machine: no coordinates at all returns ok (fail open)', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok' },
      '10.20.30.1',
    );
    assert.equal(result, 'ok');
  });

  test('report_machine: 5km away with acc:5000 (iOS approximate location) returns ok', LONG, async () => {
    // ~5km north of the machine. slack = acc = 5000, so the far threshold is
    // 500 + 5000 = 5500m — comfortably clears an actual ~5000m offset.
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.045, lng: machineLng, acc: 5000 },
      '10.20.30.2',
    );
    assert.equal(result, 'ok');
  });

  // ───────────────────────── RLS ─────────────────────────

  test('RLS: anon POST /reports directly is rejected', LONG, async () => {
    const res = await fetch(`${BASE_URL}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_id: '00000000-0000-0000-0000-000000000000', status: 'ok' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.message, 'permission denied for table reports');
  });

  // ───────────────────────── schema exposure ─────────────────────────

  test('the private schema is not reachable through the API', LONG, async () => {
    // PGRST_DB_SCHEMAS=public only, so private.* tables have no route at all
    // — not even a 401, just "this path doesn't exist".
    const res = await fetch(`${BASE_URL}/report_guard`);
    assert.equal(res.status, 404);

    // Asking PostgREST to switch schema profile is refused outright, since
    // "private" isn't in PGRST_DB_SCHEMAS.
    const profileRes = await fetch(`${BASE_URL}/machines?limit=1`, {
      headers: { 'Accept-Profile': 'private' },
    });
    assert.equal(profileRes.status, 406);

    const openapi = await (await fetch(`${BASE_URL}/`)).json();
    const exposedTables = Object.keys(openapi.definitions ?? {});
    assert.deepEqual(exposedTables.sort(), ['machines', 'reports']);
  });

  test('reports has exactly id, machine_id, status, created_at — no identity data', LONG, async () => {
    // Insert directly as superuser (RLS blocks anon inserts, by design —
    // that's the RLS test above) so this test doesn't depend on run order.
    superuserQuery(
      `insert into reports (machine_id, status) values ('${machineId}', 'ok');`,
    );
    const res = await fetch(`${BASE_URL}/reports?select=*&limit=1`);
    const [row] = await res.json();
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'id', 'machine_id', 'status']);
  });

  // ───────────────────────── idempotency ─────────────────────────

  test('schema.sql is idempotent: reapplying does not rotate the guard salt', LONG, async () => {
    const before_ = superuserScalar('select salt from private.guard_secret;');
    assert.match(before_, /^[0-9a-f]{64}$/, 'sanity: salt looks like the expected hex string');

    assert.doesNotThrow(() => reapplySchema());

    const after_ = superuserScalar('select salt from private.guard_secret;');
    assert.equal(after_, before_, 'reapplying schema.sql rotated the salt — every rate-limit counter just got invalidated');
  });

  // ───────────────────────── seed upsert ─────────────────────────
  // This is the exact migration Isabel runs by hand on her phone — load
  // seed/machines.sql into an existing database — and it half-failed once
  // already, so it gets the most scrutiny here.

  test('seed/machines.sql upserts: reloading leaves 2444 rows and never touches a source=user row', LONG, async () => {
    superuserQuery(
      `insert into machines (name, lat, lng, town, source)
       values ('Minha Máquina de Teste', 38.7, -9.1, 'Lisboa', 'user');`,
    );
    const countBefore = Number(superuserScalar('select count(*) from machines;'));
    assert.equal(countBefore, TOTAL_MACHINES + 1);

    assert.doesNotThrow(() => reapplySeed());

    const countAfter = Number(superuserScalar('select count(*) from machines;'));
    assert.equal(countAfter, TOTAL_MACHINES + 1, 'reloading the seed should upsert osm rows, not duplicate them');

    const userRows = Number(superuserScalar(`select count(*) from machines where source = 'user';`));
    assert.equal(userRows, 1, 'the hand-added machine must survive a re-import untouched');

    const userName = superuserScalar(
      `select name from machines where source = 'user';`,
    );
    assert.equal(userName, 'Minha Máquina de Teste');
  });
}
