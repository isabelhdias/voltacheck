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
// Same haversine the database uses, term for term — see app/domain.js. Only
// used here to keep the distance-based fixtures honest.
import { metresBetween } from '../../app/domain.js';

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
    // Porto city centre — a different city from the fixture machine, which
    // is the point of the case. Asserted rather than assumed: the fixture is
    // whichever machine comes back first, and a fixture that happened to be
    // in Porto would make this test pass for no reason.
    const porto = { lat: 41.1579, lng: -8.6291 };
    const away = metresBetween(porto.lat, porto.lng, machineLat, machineLng);
    assert.ok(away > 5000, `fixture sanity: machine is ${Math.round(away)}m from Porto, needs to be >5000`);

    const result = await reportMachine(
      { machine: machineId, state: 'ok', ...porto },
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

  // The proximity check no longer fails open. It used to accept a report
  // with no coordinates, which made it skippable by anyone who simply sent
  // none — so these are the cases that keep it a check. Distinct
  // X-Forwarded-For values so they don't trip the cooldown set up by the
  // "at the machine" test above, which used the same machine.

  test('report_machine: no coordinates at all returns nopos', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok' },
      '10.20.30.1',
    );
    assert.equal(result, 'nopos');
  });

  test('report_machine: latitude without longitude returns nopos', LONG, async () => {
    // Half a position is no position. Rejected before the haversine, which
    // would otherwise return null and let the > comparison pass as unknown.
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat },
      '10.20.30.6',
    );
    assert.equal(result, 'nopos');
  });

  test('report_machine: a rejected nopos writes no guard row and no report', LONG, async () => {
    // Rejections are free, but they must also be silent: nothing counted,
    // nothing stored. Otherwise a refused report would burn the reporter's
    // own rate-limit quota.
    const target = freshMachine();
    assert.equal(await reportMachine({ machine: target, state: 'ok', device: 'nopos-guard' }), 'nopos');
    assert.equal(guardRows(target), '0:0');
  });

  // The radius widened 500m → 2km → 5km — see docs/rate-limiting-plan.md.
  // A degree of latitude is ~111km, so ~0.0135° is ~1.5km, ~0.036° is ~4km,
  // and ~0.072° is ~8km. Nothing here sits near the 5km boundary on purpose:
  // a test that only passes because of rounding tells you nothing.

  test('report_machine: 1.5km away with no accuracy returns ok', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.0135, lng: machineLng },
      '10.20.30.3',
    );
    assert.equal(result, 'ok');
  });

  test('report_machine: 4km away with no accuracy returns ok (inside the widened radius)', LONG, async () => {
    // Would have been 'far' under the old 2km radius. This is the case the
    // widening is for: reported on the way home from the shop.
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.036, lng: machineLng },
      '10.20.30.5',
    );
    assert.equal(result, 'ok');
  });

  test('report_machine: 8km away with no accuracy returns far', LONG, async () => {
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.072, lng: machineLng },
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

  test('report_machine: 8km away with acc:5000 (iOS approximate location) returns ok', LONG, async () => {
    // ~8km north of the machine — 'far' on its own, per the case above.
    // slack = acc = 5000 pushes the threshold to 5000 + 5000 = 10000m, so
    // this passes only because the accuracy radius is honoured.
    const result = await reportMachine(
      { machine: machineId, state: 'ok', lat: machineLat + 0.072, lng: machineLng, acc: 5000 },
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

  test('submit_machine: the submitted town is stored as given, not overwritten by the neighbour\'s', LONG, async () => {
    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng,town&limit=1`)).json();
    assert.ok(m.town, 'sanity: fixture machine has a town');

    // Right next to a machine in a known concelho, but naming a different
    // one. What the person typed wins — they are standing there.
    const result = await submitMachine(
      { name: 'Concelho Escolhido À Mão', lat: m.lat + 0.001, lng: m.lng + 0.001,
        town: 'Concelho Improvável', device: 'sub-town-explicit' },
      '91.1.1.20',
    );
    assert.equal(result, 'ok');
    assert.equal(
      superuserScalar("select town from machine_submissions where name = 'Concelho Escolhido À Mão' order by created_at desc limit 1;"),
      'Concelho Improvável',
    );
  });

  test('submit_machine: a blank town falls back to a neighbour within 2km', LONG, async () => {
    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng,town&limit=1`)).json();
    const result = await submitMachine(
      { name: 'Sem Concelho Mas Perto', lat: m.lat + 0.001, lng: m.lng + 0.001, device: 'sub-town-near' },
      '91.1.1.21',
    );
    assert.equal(result, 'ok');
    assert.equal(
      superuserScalar("select town from machine_submissions where name = 'Sem Concelho Mas Perto' order by created_at desc limit 1;"),
      m.town,
      'a close neighbour is still a good enough guess to borrow',
    );
  });

  // The regression this whole change exists for. The first real submission
  // sat 18.8 km from its nearest machine and was filed under that machine's
  // concelho, so a town search would never have found it under the name it
  // was given. Null is the correct answer here: it is visibly missing at
  // review time instead of confidently wrong.
  test('submit_machine: a blank town stays null when the nearest machine is far away', LONG, async () => {
    // Somewhere deliberately remote — assert the emptiness rather than
    // assume it, so this test cannot pass for the wrong reason.
    const far = { lat: 40.0419, lng: -7.9486 };
    const nearest = Number(
      superuserScalar(
        `select round(min(private.metres_between(${far.lat}, ${far.lng}, lat, lng))) from public.machines`,
      ),
    );
    assert.ok(nearest > 2000, `fixture sanity: nearest machine is ${nearest}m away, needs to be >2000`);

    const result = await submitMachine(
      { name: 'Longe De Tudo', lat: far.lat, lng: far.lng, device: 'sub-town-far' },
      '91.1.1.22',
    );
    assert.equal(result, 'ok');
    assert.equal(
      superuserScalar("select coalesce(town, '') from machine_submissions where name = 'Longe De Tudo' order by created_at desc limit 1;"),
      '',
    );
  });

  test('submit_machine: address is stored and survives approval into machines', LONG, async () => {
    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng&limit=1`)).json();
    const result = await submitMachine(
      { name: 'Com Morada', lat: m.lat + 0.002, lng: m.lng + 0.002, town: 'Lisboa',
        address: 'R. do Comércio 12', device: 'sub-address' },
      '91.1.1.23',
    );
    assert.equal(result, 'ok');

    const id = superuserScalar("select id from machine_submissions where name = 'Com Morada' order by created_at desc limit 1;");
    superuserQuery(`update machine_submissions set status = 'approved' where id = '${id}';`);

    assert.equal(
      superuserScalar(`select address from public.machines where id = (select machine_id from machine_submissions where id = '${id}')`),
      'R. do Comércio 12',
      'the address must not be dropped on the way into machines',
    );
  });

  // Changing the parameter list without dropping the old signature would
  // leave two overloads behind, and PostgREST answers 300 Multiple Choices
  // when it cannot pick — every add-form call failing, not some subtle
  // drift. schema.sql is applied twice here because that is exactly when a
  // stale overload would survive.
  test('submit_machine: exactly one overload exists, even after re-applying schema.sql', LONG, async () => {
    reapplySchema();
    assert.equal(
      superuserScalar("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'submit_machine'"),
      '1',
    );

    const [m] = await (await fetch(`${BASE_URL}/machines?select=id,lat,lng&limit=1`)).json();
    const result = await submitMachine(
      { name: 'Depois Da Migração', lat: m.lat + 0.003, lng: m.lng + 0.003, town: 'Porto', device: 'sub-overload' },
      '91.1.1.24',
    );
    assert.equal(result, 'ok', 'a second overload would surface here as an error, not as ok');
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

  test('seed/machines.sql upserts: reloading duplicates nothing and never touches a source=user row', LONG, async () => {
    // Counted relative to whatever is already here, and by source, rather
    // than against one absolute total. Earlier tests in this file approve
    // submissions, and every approval adds a machine — pinning the grand
    // total made this test fail whenever a test above it was added, which
    // says nothing about whether the seed upserts correctly.
    const osmBefore = Number(superuserScalar(`select count(*) from machines where source = 'osm';`));
    assert.equal(osmBefore, TOTAL_MACHINES, 'sanity: the seed is fully loaded before we reload it');

    const userBefore = Number(superuserScalar(`select count(*) from machines where source = 'user';`));
    superuserQuery(
      `insert into machines (name, lat, lng, town, source)
       values ('Minha Máquina de Teste', 38.7, -9.1, 'Lisboa', 'user');`,
    );

    assert.doesNotThrow(() => reapplySeed());

    assert.equal(
      Number(superuserScalar(`select count(*) from machines where source = 'osm';`)),
      TOTAL_MACHINES,
      'reloading the seed should upsert osm rows, not duplicate them',
    );
    assert.equal(
      Number(superuserScalar(`select count(*) from machines where source = 'user';`)),
      userBefore + 1,
      'the re-import must neither delete nor duplicate machines people added',
    );
    assert.equal(
      superuserScalar(`select name from machines where name = 'Minha Máquina de Teste';`),
      'Minha Máquina de Teste',
      'the hand-added machine must survive a re-import untouched',
    );
  });
}
