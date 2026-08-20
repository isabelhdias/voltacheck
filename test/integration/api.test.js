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

  async function reportMachine(body, forwardedFor, extraHeaders) {
    const res = await fetch(`${BASE_URL}/rpc/report_machine`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
        ...(extraHeaders || {}),
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
    // Porto city centre — comfortably >2km from any single machine.
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

  // The radius widened from 500m to 2km — see docs/rate-limiting-plan.md.
  // ~0.0135° of latitude is ~1.5km, ~0.045° is ~5km (matches the Porto and
  // 5km-with-approximate-fix cases above).

  test('report_machine: 1.5km away with no accuracy returns ok (inside the widened radius)', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.0135, lng: machineLng },
      '10.20.30.3',
    );
    assert.equal(result, 'ok');
  });

  test('report_machine: 5km away with no accuracy returns far', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.045, lng: machineLng },
      '10.20.30.4',
    );
    assert.equal(result, 'far');
  });

  // How the caller's IP is derived. Measured against the live project with a
  // temporary probe, not assumed: Cloudflare APPENDS the real connecting
  // address to whatever x-forwarded-for the client sent, so the real address
  // is the last element and a spoofer can only push it rightwards. These
  // three tests pin that reading down — the first is the regression that
  // matters, since the old code hashed the whole header and so handed anyone
  // a fresh bucket per request just by varying the prefix.
  //
  // Each uses a machine no guard row mentions yet, so the counts below see
  // only its own two reports, and each report carries its own `device` — the
  // 10-minute per-(device, machine) cooldown would otherwise reject the
  // second one, leave no guard row, and make every one of these pass for the
  // wrong reason.

  function freshMachine() {
    return superuserScalar(
      "select id from public.machines where source = 'osm'" +
        ' and id not in (select machine_id from private.report_guard)' +
        ' order by id limit 1',
    );
  }

  function guardRows(machine) {
    return superuserScalar(
      `select count(*) || ':' || count(distinct ip_ident) from private.report_guard where machine_id = '${machine}'`,
    );
  }

  test('client_ip: a forged x-forwarded-for prefix cannot change the IP bucket', LONG, async () => {
    const target = freshMachine();
    // Same real address last, different forged prefixes — exactly the shape
    // Cloudflare produces for a client that sent its own header.
    assert.equal(await reportMachine({ machine: target, state: 'ok', device: 'xff-a' }, '9.9.9.9, 203.0.113.5'), 'ok');
    assert.equal(await reportMachine({ machine: target, state: 'full', device: 'xff-b' }, '1.1.1.1, 8.8.8.8, 203.0.113.5'), 'ok');
    assert.equal(guardRows(target), '2:1', 'two reports, one shared IP bucket');
  });

  test('client_ip: genuinely different clients still get different buckets', LONG, async () => {
    const target = freshMachine();
    assert.equal(await reportMachine({ machine: target, state: 'ok', device: 'xff-c' }, '9.9.9.9, 203.0.113.5'), 'ok');
    assert.equal(await reportMachine({ machine: target, state: 'full', device: 'xff-d' }, '9.9.9.9, 198.51.100.77'), 'ok');
    assert.equal(guardRows(target), '2:2', 'distinct last elements are distinct clients');
  });

  test('client_ip: cf-connecting-ip wins over x-forwarded-for', LONG, async () => {
    const target = freshMachine();
    // Cloudflare sets cf-connecting-ip itself and rejects forged ones at the
    // edge, so it is preferred. Same cf value, different xff: one bucket.
    assert.equal(await reportMachine({ machine: target, state: 'ok', device: 'cf-a' }, '203.0.113.5', { 'CF-Connecting-IP': '198.51.100.9' }), 'ok');
    assert.equal(await reportMachine({ machine: target, state: 'full', device: 'cf-b' }, '192.0.2.44', { 'CF-Connecting-IP': '198.51.100.9' }), 'ok');
    assert.equal(guardRows(target), '2:1', 'cf-connecting-ip decides; xff is ignored when it is present');
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

  test('RLS: anon POST /machines directly is rejected — submit_machine() is the only door in now', LONG, async () => {
    const res = await fetch(`${BASE_URL}/machines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaked In Directly', lat: 38.7, lng: -9.1 }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.message, 'permission denied for table machines');
  });

  test('RLS: anon cannot SELECT machine_submissions at all — the queue is write-only via the RPC', LONG, async () => {
    const res = await fetch(`${BASE_URL}/machine_submissions?select=*`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.message, 'permission denied for table machine_submissions');
  });

  // ───────────────────────── submit_machine RPC ─────────────────────────

  async function submitMachine(body, forwardedFor) {
    const res = await fetch(`${BASE_URL}/rpc/submit_machine`, {
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

  test('submit_machine: a plausible new machine returns ok and lands pending in the queue', LONG, async () => {
    const result = await submitMachine(
      { name: 'Pingo Doce Teste Integração', lat: 38.90, lng: -9.30, device: 'sub-basic' },
      '91.1.1.1',
    );
    assert.equal(result, 'ok');

    const status = superuserScalar(
      `select status from machine_submissions where name = 'Pingo Doce Teste Integração' order by created_at desc limit 1;`,
    );
    assert.equal(status, 'pending');
  });

  test('submit_machine: name too short returns invalid', LONG, async () => {
    const result = await submitMachine(
      { name: 'ab', lat: 38.7, lng: -9.1, device: 'sub-invalid' },
      '91.1.1.5',
    );
    assert.equal(result, 'invalid');
  });

  test('submit_machine: town is derived from the nearest existing machine, not left null', LONG, async () => {
    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng,town&limit=1`)).json();
    assert.ok(m.town, 'sanity: fixture machine has a town');

    // A small nudge — close enough that m stays the nearest neighbour, far
    // enough it clears the 75m duplicate threshold.
    const result = await submitMachine(
      { name: 'Nova Máquina Perto Do Vizinho', lat: m.lat + 0.001, lng: m.lng + 0.001, device: 'sub-town' },
      '91.1.1.2',
    );
    assert.equal(result, 'ok');

    const town = superuserScalar(
      `select town from machine_submissions where name = 'Nova Máquina Perto Do Vizinho' order by created_at desc limit 1;`,
    );
    assert.equal(town, m.town);
  });

  test('submit_machine: likely_dupe is true under 75m and false over it', LONG, async () => {
    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng&limit=1`)).json();

    // ~30m north — well under the 75m threshold.
    const dupe = await submitMachine(
      { name: 'Máquina Duplicada', lat: m.lat + 0.00027, lng: m.lng, device: 'sub-dupe' },
      '91.1.1.3',
    );
    assert.equal(dupe, 'ok');
    assert.equal(
      superuserScalar(`select likely_dupe from machine_submissions where name = 'Máquina Duplicada' order by created_at desc limit 1;`),
      't',
    );

    // ~200m north — comfortably over.
    const notDupe = await submitMachine(
      { name: 'Máquina Não Duplicada', lat: m.lat + 0.0018, lng: m.lng, device: 'sub-notdupe' },
      '91.1.1.4',
    );
    assert.equal(notDupe, 'ok');
    assert.equal(
      superuserScalar(`select likely_dupe from machine_submissions where name = 'Máquina Não Duplicada' order by created_at desc limit 1;`),
      'f',
    );
  });

  test('submit_machine: does not require the submitter to be near the machine', LONG, async () => {
    // from_lat/from_lng are 100+ km from lat/lng — a submission "from home".
    const result = await submitMachine(
      {
        name: 'Adicionada De Casa', lat: 38.90, lng: -9.30,
        from_lat: 41.15, from_lng: -8.62, device: 'sub-fromhome',
      },
      '91.1.1.6',
    );
    assert.equal(result, 'ok');

    const fromMetres = Number(superuserScalar(
      `select from_metres from machine_submissions where name = 'Adicionada De Casa' order by created_at desc limit 1;`,
    ));
    assert.ok(fromMetres > 100000, `expected a large from_metres as a review signal, got ${fromMetres}`);
  });

  test('submit_machine: cooldown on a second submission from the same device inside 2 minutes', LONG, async () => {
    const first = await submitMachine(
      { name: 'Cooldown Um', lat: 38.72, lng: -9.20, device: 'sub-cooldown' },
      '91.1.2.1',
    );
    assert.equal(first, 'ok');

    const second = await submitMachine(
      { name: 'Cooldown Dois', lat: 38.73, lng: -9.21, device: 'sub-cooldown' },
      '91.1.2.1',
    );
    assert.equal(second, 'cooldown');
  });

  test('submit_machine: flood after 5 submissions in an hour from the same device', LONG, async () => {
    const device = 'sub-flood-device';
    // Backdate 5 accepted submissions to land inside the 1-hour flood window
    // while clearing the 2-minute cooldown, rather than sleeping in a loop.
    superuserQuery(`
      insert into private.submission_guard (ident, ip_ident, created_at)
      select private.guard_hash('dev', '${device}'), private.guard_hash('ip', '91.1.3.1'),
             now() - (n || ' minutes')::interval
        from generate_series(10, 50, 10) as n;
    `);

    const result = await submitMachine(
      { name: 'Flood Test', lat: 38.74, lng: -9.22, device },
      '91.1.3.1',
    );
    assert.equal(result, 'flood');
  });

  // ───────────────────────── approval ─────────────────────────

  test('approving a submission copies exactly one row into machines, and re-approving is idempotent', LONG, async () => {
    const result = await submitMachine(
      { name: 'Aprovação Teste', chain: 'Lidl', lat: 38.80, lng: -9.25, device: 'sub-approve' },
      '91.1.4.1',
    );
    assert.equal(result, 'ok');

    const subId = superuserScalar(
      `select id from machine_submissions where name = 'Aprovação Teste' order by created_at desc limit 1;`,
    );
    assert.ok(subId);
    assert.equal(Number(superuserScalar(`select count(*) from machines where name = 'Aprovação Teste';`)), 0);

    superuserQuery(`update machine_submissions set status = 'approved' where id = '${subId}';`);
    assert.equal(Number(superuserScalar(`select count(*) from machines where name = 'Aprovação Teste';`)), 1);

    const machineId = superuserScalar(`select machine_id from machine_submissions where id = '${subId}';`);
    assert.ok(machineId);
    assert.equal(superuserScalar(`select source from machines where id = '${machineId}';`), 'user');
    assert.equal(superuserScalar(`select chain from machines where id = '${machineId}';`), 'Lidl');

    // Toggle status back and forth — must never create a second machine.
    superuserQuery(`update machine_submissions set status = 'rejected' where id = '${subId}';`);
    superuserQuery(`update machine_submissions set status = 'approved' where id = '${subId}';`);

    assert.equal(Number(superuserScalar(`select count(*) from machines where name = 'Aprovação Teste';`)), 1);
    assert.equal(
      superuserScalar(`select machine_id from machine_submissions where id = '${subId}';`),
      machineId,
      'machine_id must not change on re-approval',
    );

    // This is the only test in the file that leaves a row in `machines`
    // (via the approval trigger) — clean it up so the exact-count seed
    // upsert test below isn't thrown off. Submission row first: it holds
    // the foreign key into machines.
    superuserQuery(`delete from machine_submissions where id = '${subId}';`);
    superuserQuery(`delete from machines where id = '${machineId}';`);
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
