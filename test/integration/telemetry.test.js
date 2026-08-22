// Integration tests for the telemetry pipeline, against the same real
// Postgres + PostgREST containers api.test.js uses.
//
// What this suite is protecting. public.ingest_telemetry() is an anonymous
// endpoint: the anon key is public by design, so anything that reaches it is
// not necessarily a browser. Two failure modes matter and neither shows up
// as an error at the time —
//
//   * a caller inventing metric names or dimension values fills
//     private.telemetry_daily, which is the table kept forever, one row at a
//     time until the free tier is gone;
//   * a caller writing a *server* metric — reports.outcome and friends —
//     makes the dashboard's funnel a work of fiction.
//
// So the tests below spend most of their time on what the function refuses.
// They assert on deltas rather than absolutes wherever a counter is touched
// by more than one case here — app.visit moves in the happy path and again
// in the rate-limit loop — so adding a test later cannot silently break an
// earlier one's arithmetic.
//
// Requires Docker, and skips itself cleanly without it — same as api.test.js.
// Both files drive one set of fixed-name containers, which is why
// package.json runs the integration layer with --test-concurrency=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dockerAvailable, setup, teardown, BASE_URL, superuserScalar, ROOT } from './docker-env.js';

const LONG = { timeout: 60_000 };
const TOTAL_MACHINES = 2444;

if (!dockerAvailable()) {
  test('telemetry suite skipped: Docker is not available in this environment', { skip: true }, () => {});
} else {
  before(setup, LONG);
  after(teardown, LONG);

  // A fresh session id per test keeps each one out of the previous one's
  // per-device flush budget.
  let n = 0;
  const sess = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  async function ingest(payload, forwardedFor = '85.240.99.1') {
    const res = await fetch(`${BASE_URL}/rpc/ingest_telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
      body: JSON.stringify({ payload }),
    });
    const text = await res.text();
    assert.ok(res.ok, `rpc call failed: ${res.status} ${text}`);
    return JSON.parse(text);
  }

  const counter = (metric, dims = '{}') =>
    Number(
      superuserScalar(
        `select coalesce(sum(value),0) from private.telemetry_daily` +
          ` where metric = '${metric}' and dims @> '${dims}'::jsonb`,
      ),
    );

  const rejected = (reason) => counter('telemetry.rejected', `{"reason":"${reason}"}`);
  const rawRows = (name) =>
    Number(superuserScalar(`select count(*) from private.telemetry_raw where name = '${name}'`));

  // ───────────────────────── the happy path ─────────────────────────

  test('a well-formed flush lands counters, a histogram and raw records', LONG, async () => {
    const before = counter('app.visit', '{"mode":"live"}');
    const result = await ingest({
      v: 1,
      sess: sess(),
      rel: 'test-rel',
      m: [
        { n: 'app.visit', d: { mode: 'live' }, v: 2 },
        { n: 'app.session', d: { mode: 'live' } }, // no v at all means one
      ],
      h: [{ n: 'db.pull.duration', d: { kind: 'machines' }, v: [812.4, 640.1, 23.0] }],
      r: [
        {
          k: 'span',
          n: 'db.pull',
          t: '0123456789abcdef0123456789abcdef',
          s: '0123456789abcdef',
          ms: 812,
          a: { rows: TOTAL_MACHINES },
        },
        { k: 'log', n: 'js.error', sev: 17, a: { msg: 'boom' } },
      ],
    });
    assert.equal(result, 'ok');
    assert.equal(counter('app.visit', '{"mode":"live"}'), before + 2);
    assert.equal(counter('app.session', '{"mode":"live"}'), 1, 'a missing v counts as one');
    assert.equal(rawRows('db.pull'), 1);
    assert.equal(rawRows('js.error'), 1);
  });

  test('histogram observations land in the right explicit buckets', LONG, () => {
    // Boundaries are 5,10,25,50,100,250,500,1000,2500,5000,10000 (+Inf).
    // 23ms -> bucket 3; 640.1ms and 812.4ms -> bucket 8.
    const buckets = superuserScalar(
      `select buckets::text from private.telemetry_daily` +
        ` where metric = 'db.pull.duration' and dims = '{"kind":"machines"}'::jsonb`,
    );
    assert.equal(buckets, '{0,0,1,0,0,0,0,2,0,0,0,0}');
    assert.equal(
      superuserScalar(
        `select hits || ':' || round(sum_ms::numeric,1) || ':' || round(max_ms::numeric,1)` +
          ` from private.telemetry_daily where metric = 'db.pull.duration'` +
          ` and dims = '{"kind":"machines"}'::jsonb`,
      ),
      '3:1475.5:812.4',
    );
  });

  test('a span keeps its trace id, and a log keeps its severity', LONG, () => {
    assert.equal(
      superuserScalar(
        `select encode(trace_id,'hex') from private.telemetry_raw where name = 'db.pull'`,
      ),
      '0123456789abcdef0123456789abcdef',
    );
    // Severity is a log concept — a span must not be given a default one.
    assert.equal(
      superuserScalar(`select coalesce(severity::text,'null') from private.telemetry_raw where name = 'db.pull'`),
      'null',
    );
    assert.equal(
      superuserScalar(`select severity from private.telemetry_raw where name = 'js.error'`),
      '17',
    );
  });

  // ───────────────────────── what it refuses ─────────────────────────

  test('a payload of the wrong version is invalid', LONG, async () => {
    assert.equal(await ingest({ v: 2, m: [] }), 'invalid');
  });

  test('a session id that is not a uuid is invalid', LONG, async () => {
    // Free text here would be both a cardinality hole and somewhere to
    // smuggle a string into a column the dashboard groups by.
    assert.equal(await ingest({ v: 1, sess: 'not-a-uuid' }), 'invalid');
  });

  test('an unregistered metric name is dropped and counted', LONG, async () => {
    const before = rejected('unknown_metric');
    assert.equal(await ingest({ v: 1, sess: sess(), m: [{ n: 'made.up.metric', v: 1 }] }), 'partial');
    assert.equal(rejected('unknown_metric'), before + 1);
    assert.equal(counter('made.up.metric'), 0, 'nothing was written under the invented name');
  });

  // The one that matters most: a browser must not be able to move the
  // numbers the dashboard's report funnel is read off.
  test('a client cannot write a server-side metric', LONG, async () => {
    const outcomes = counter('reports.outcome');
    const before = rejected('server_metric');
    assert.equal(
      await ingest({ v: 1, sess: sess(), m: [{ n: 'reports.outcome', d: { outcome: 'ok' }, v: 999 }] }),
      'partial',
    );
    assert.equal(rejected('server_metric'), before + 1);
    assert.equal(counter('reports.outcome'), outcomes, 'reports.outcome is untouched');
  });

  test('a dimension key outside the registry drops the whole entry', LONG, async () => {
    // Not "drop the key and keep the rest": a metric filed under half its
    // dimensions merges into a row that means something else.
    const before = rejected('bad_dims');
    assert.equal(
      await ingest({ v: 1, sess: sess(), m: [{ n: 'app.visit', d: { smuggled: 'x' }, v: 1 }] }),
      'partial',
    );
    assert.equal(rejected('bad_dims'), before + 1);
  });

  test('a counter value that is not a number is dropped, not guessed at', LONG, async () => {
    const visits = counter('app.visit', '{"mode":"live"}');
    const before = rejected('bad_value');
    assert.equal(
      await ingest({ v: 1, sess: sess(), m: [{ n: 'app.visit', d: { mode: 'live' }, v: 'lots' }] }),
      'partial',
    );
    assert.equal(rejected('bad_value'), before + 1);
    assert.equal(counter('app.visit', '{"mode":"live"}'), visits, 'not silently counted as one');
  });

  test('a span with a malformed trace id is refused rather than stored', LONG, async () => {
    const before = rejected('bad_ids');
    assert.equal(
      await ingest({ v: 1, sess: sess(), r: [{ k: 'span', n: 'x.y', t: 'zzzz', s: 'nope', ms: 5 }] }),
      'partial',
    );
    assert.equal(rejected('bad_ids'), before + 1);
    assert.equal(rawRows('x.y'), 0);
  });

  test('a record name that is not a metric name is refused', LONG, async () => {
    const before = rejected('bad_record');
    assert.equal(
      await ingest({ v: 1, sess: sess(), r: [{ k: 'log', n: 'DROP TABLE machines', a: {} }] }),
      'partial',
    );
    assert.equal(rejected('bad_record'), before + 1);
  });

  test('an oversized batch of metric entries is refused outright', LONG, async () => {
    const m = Array.from({ length: 201 }, () => ({ n: 'app.visit', d: { mode: 'live' } }));
    assert.equal(await ingest({ v: 1, sess: sess(), m }), 'invalid');
  });

  test('raw records are capped per flush', LONG, async () => {
    const r = Array.from({ length: 30 }, (_, i) => ({
      k: 'log',
      n: 'flush.cap',
      a: { i },
    }));
    await ingest({ v: 1, sess: sess(), r });
    assert.equal(rawRows('flush.cap'), 20, 'raw_per_batch is 20');
  });

  test('flushes are rate limited per session', LONG, async () => {
    const s = sess();
    const body = { v: 1, sess: s, m: [{ n: 'app.visit', d: { mode: 'live' } }] };
    let flooded = 0;
    for (let i = 0; i < 62; i++) {
      // A distinct IP per iteration would defeat the point; the IP cap is
      // 600/h and is not what this test is about.
      if ((await ingest(body, '85.240.99.2')) === 'flood') { flooded = i + 1; break; }
    }
    assert.equal(flooded, 61, 'the 61st flush from one session is refused');
  });

  // ───────────────────── nothing reads back out ─────────────────────

  test('anon cannot read the telemetry tables through the API', LONG, async () => {
    for (const t of ['telemetry_daily', 'telemetry_raw', 'telemetry_metric']) {
      const res = await fetch(`${BASE_URL}/${t}?select=*`);
      assert.ok(!res.ok, `${t} must not be readable, got ${res.status}`);
    }
  });

  // ───────────────── the server records its own outcomes ─────────────────

  test('report_machine counts every outcome it returns', LONG, async () => {
    const far = counter('reports.outcome', '{"outcome":"far"}');
    const machine = superuserScalar('select id from public.machines order by id limit 1');
    const res = await fetch(`${BASE_URL}/rpc/report_machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '85.240.99.3' },
      // Porto, comfortably more than the 5km radius from that machine.
      body: JSON.stringify({ machine, state: 'ok', lat: 41.1579, lng: -8.6291, device: 'tel-far' }),
    });
    assert.equal(await res.json(), 'far');
    assert.equal(counter('reports.outcome', '{"outcome":"far"}'), far + 1);

    // The other refusal the proximity rule makes, and the newer one: no
    // coordinates at all. It has to be counted for the same reason 'far'
    // does — it is how many people the rule is turning away.
    const nopos = counter('reports.outcome', '{"outcome":"nopos"}');
    const res2 = await fetch(`${BASE_URL}/rpc/report_machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '85.240.99.5' },
      body: JSON.stringify({ machine, state: 'ok', device: 'tel-nopos' }),
    });
    assert.equal(await res2.json(), 'nopos');
    assert.equal(counter('reports.outcome', '{"outcome":"nopos"}'), nopos + 1);
  });

  test('submit_machine counts every outcome it returns', LONG, async () => {
    const bad = counter('submissions.outcome', '{"outcome":"invalid"}');
    const res = await fetch(`${BASE_URL}/rpc/submit_machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '85.240.99.4' },
      body: JSON.stringify({ name: 'X', lat: 38.73, lng: -9.15 }), // too short
    });
    assert.equal(await res.json(), 'invalid');
    assert.equal(counter('submissions.outcome', '{"outcome":"invalid"}'), bad + 1);
  });

  // ───────────────────────── the daily rollup ─────────────────────────

  test('the daily rollup snapshots the numbers that are expensive to rebuild', LONG, () => {
    superuserScalar('select private.telemetry_rollup_daily()');
    assert.equal(counter('machines.total'), TOTAL_MACHINES);
    const coverage = counter('coverage.live');
    assert.ok(coverage >= 0 && coverage <= 1000, `coverage.live is per-mille, got ${coverage}`);

    // Idempotent: the review-queue workflow calls it three times a day, and
    // running it twice must not double anything.
    superuserScalar('select private.telemetry_rollup_daily()');
    assert.equal(counter('machines.total'), TOTAL_MACHINES);
  });

  // ─────────────── what a real browser actually sends ───────────────

  // The one test that joins the two halves. test/vectors/telemetry-envelope.json
  // is captured from the real index.html by the e2e suite's fake-live fixture,
  // never hand-written — so this fails the moment app/telemetry.js starts
  // sending something the database would refuse, which is a failure nobody
  // would otherwise see until the dashboard quietly stopped filling in.
  test('the envelope a real browser produces is accepted whole', LONG, async () => {
    const envelope = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test/vectors/telemetry-envelope.json'), 'utf8'),
    );
    // Deltas, not absolutes: the cases above deliberately tripped every one
    // of these counters already.
    const before = {
      unknown_metric: rejected('unknown_metric'),
      bad_dims: rejected('bad_dims'),
      bad_ids: rejected('bad_ids'),
    };
    // A fresh session id, so re-running the suite cannot trip the flush limit.
    const result = await ingest({ ...envelope, sess: sess() }, '85.240.99.9');
    assert.equal(result, 'ok', 'a captured real payload was not accepted whole');

    assert.equal(rejected('unknown_metric'), before.unknown_metric,
      'the app sent a metric the registry does not know');
    assert.equal(rejected('bad_dims'), before.bad_dims,
      'the app sent a dimension key the registry does not allow');
    assert.equal(rejected('bad_ids'), before.bad_ids,
      'the app sent a span the database could not decode');
  });

  // Both ends of db.pull.rows, which is the paging regression's alarm and the
  // one counter whose value is neither small nor optional.
  test('a full pull count survives, and a zero stays zero', LONG, async () => {
    await ingest({
      v: 1,
      sess: sess(),
      m: [
        { n: 'db.pull.rows', d: { kind: 'machines' }, v: TOTAL_MACHINES },
        { n: 'db.pull.rows', d: { kind: 'reports' }, v: 0 },
      ],
    }, '85.240.99.10');
    // 2444 is well past the ceiling an earlier version of this clamped to.
    // The captured envelope above also carries db.pull.rows, from a fixture
    // with two machines, so this is the sum rather than a bare 2444.
    assert.equal(counter('db.pull.rows', '{"kind":"machines"}'), TOTAL_MACHINES + 2);
    // And a zero must not arrive as a one — "the pull returned no machines"
    // is the alarm, so rounding it up would silence it.
    assert.equal(counter('db.pull.rows', '{"kind":"reports"}'), 0);
  });

  // ───────────────────────── OTLP export ─────────────────────────

  test('stored telemetry renders back as OTLP/JSON', LONG, () => {
    // The compact wire format is a storage decision, not a lock-in: this is
    // what makes forwarding to a real OpenTelemetry backend later a
    // forwarder job rather than a rewrite.
    const otlp = JSON.parse(
      superuserScalar(
        "select private.otlp_export(now() - interval '1 hour', now() + interval '1 hour')::text",
      ),
    );
    const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
    const pull = spans.find((s) => s.name === 'db.pull');
    assert.ok(pull, 'the db.pull span survived the round trip');
    assert.equal(pull.traceId, '0123456789abcdef0123456789abcdef');
    assert.equal(pull.spanId, '0123456789abcdef');
    assert.equal(
      Number(pull.endTimeUnixNano) - Number(pull.startTimeUnixNano),
      812_000_000,
      'duration is carried as nanoseconds',
    );
    assert.deepEqual(pull.attributes, [{ key: 'rows', value: { doubleValue: TOTAL_MACHINES } }]);

    const logs = otlp.resourceLogs[0].scopeLogs[0].logRecords;
    const err = logs.find((l) => l.body.stringValue === 'js.error');
    assert.ok(err, 'the js.error log survived the round trip');
    assert.equal(err.severityNumber, 17);

    const resource = otlp.resourceSpans[0].resource.attributes;
    assert.deepEqual(resource[0], { key: 'service.name', value: { stringValue: 'voltacheck-web' } });
  });
}
