// Unit tests for app/domain.js, driven entirely by test/vectors/*.json.
//
// The vectors are the contract: this file's job is to load them and assert,
// not to hardcode the same expectations a second time. A future Swift/Kotlin
// port loads the same JSON and should reach the same pass/fail per case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  statusOf,
  needsReconfirm,
  ago,
  norm,
  townsMatching,
  chainCounts,
  filterByChain,
  latest,
  metresBetween,
  formatDistance,
  sortByDistance,
  filterByStatus,
  statusCounts,
} from '../../app/domain.js';
import { STALE_AFTER, RECONFIRM_AFTER, HOUR } from '../../app/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(__dirname, '..', 'vectors');

function loadVector(name) {
  const raw = fs.readFileSync(path.join(VECTORS, name), 'utf8');
  return JSON.parse(raw);
}

/* ───────── constants sanity ───────── */
// If config.js ever drifts from what the vectors assume, every other test in
// this file would still "pass" against the wrong numbers. Check the
// constants themselves first, against every file that declares them.

test('vector constants match app/config.js', () => {
  const status = loadVector('status.json');
  const reconfirm = loadVector('reconfirm.json');
  const ago_ = loadVector('ago.json');

  assert.equal(status.constants.staleAfterMs, STALE_AFTER);
  assert.equal(status.constants.hourMs, HOUR);

  assert.equal(reconfirm.constants.reconfirmAfterMs, RECONFIRM_AFTER);
  assert.equal(reconfirm.constants.staleAfterMs, STALE_AFTER);

  assert.equal(ago_.constants.hourMs, HOUR);
  assert.equal(ago_.constants.dayMs, 24 * HOUR);
});

/* ───────── status.json ───────── */

test('statusOf — decay boundaries and fresh reports', () => {
  const { cases } = loadVector('status.json');
  assert.ok(cases.length > 0, 'vector file has no cases');

  for (const c of cases) {
    const machine = { reports: c.reports };
    const got = statusOf(machine, c.now);
    assert.equal(got, c.expectedStatus, `${c.id}: ${c.description}`);
  }
});

/* ───────── reconfirm.json ───────── */

test('needsReconfirm — threshold, in isolation', () => {
  const { cases } = loadVector('reconfirm.json');
  assert.ok(cases.length > 0, 'vector file has no cases');

  for (const c of cases) {
    const got = needsReconfirm(c.report, c.now);
    assert.equal(got, c.expectedNeedsReconfirm, `${c.id}: ${c.description}`);
  }
});

test('reconfirm prompt — composition of statusOf + needsReconfirm (matches app/ui.js)', () => {
  const { cases, constants } = loadVector('reconfirm.json');

  for (const c of cases) {
    const machine = { reports: c.report ? [c.report] : [] };
    const status = statusOf(machine, c.now);
    const r = latest(machine);
    const prompt =
      r && status !== 'stale' && needsReconfirm(r, c.now)
        ? constants.promptAindaEstaAssim
        : constants.promptEstivesteLaAgora;

    assert.equal(status, c.expectedStatus, `${c.id} (status): ${c.description}`);
    assert.equal(prompt, c.expectedPrompt, `${c.id} (prompt): ${c.description}`);
  }
});

/* ───────── ago.json ───────── */

test('ago — pt-PT relative time strings, including the 1-min floor', () => {
  const { cases } = loadVector('ago.json');
  assert.ok(cases.length > 0, 'vector file has no cases');

  for (const c of cases) {
    const got = ago(c.ts, c.now);
    assert.equal(got, c.expected, `${c.id}: ${c.description}`);
  }
});

/* ───────── search.json: norm ───────── */

test('norm — accent folding, case folding, trimming', () => {
  const { normCases } = loadVector('search.json');
  assert.ok(normCases.length > 0, 'vector file has no cases');

  for (const c of normCases) {
    const got = norm(c.input);
    assert.equal(got, c.expected, `${c.id}: norm(${JSON.stringify(c.input)})`);
  }
});

/* ───────── search.json: townsMatching ───────── */

test('townsMatching — ranking, accent folding, the 8-result cap, empty input', () => {
  const { townsMatchingCases } = loadVector('search.json');
  assert.ok(townsMatchingCases.length > 0, 'vector file has no cases');

  for (const c of townsMatchingCases) {
    const got = townsMatching(c.machines, c.term).map((g) => g.town);
    assert.deepEqual(got, c.expectedTowns, `${c.id}: ${c.description}`);
    assert.ok(got.length <= 8, `${c.id}: townsMatching must never return more than 8 towns`);
  }
});

/* ───────── chains.json ───────── */

test('chainCounts — descending count, Outras always last, stable ties', () => {
  const { chainCountsCases } = loadVector('chains.json');
  assert.ok(chainCountsCases.length > 0, 'vector file has no cases');

  for (const c of chainCountsCases) {
    const got = chainCounts(c.machines);
    assert.deepEqual(got, c.expected, `${c.id}: ${c.description ?? ''}`);
  }
});

test('filterByChain — falsy chain passes everything through, a real chain filters', () => {
  const { filterByChainCases } = loadVector('chains.json');
  assert.ok(filterByChainCases.length > 0, 'vector file has no cases');

  for (const c of filterByChainCases) {
    const got = filterByChain(c.machines, c.chain).map((m) => m.id);
    assert.deepEqual(got, c.expectedIds, c.id);
  }
});

/* ───────── distance.json: metresBetween ───────── */

test('metresBetween — haversine, matching private.metres_between() in schema.sql', () => {
  const { metresBetweenCases, toleranceMetres } = loadVector('distance.json');
  assert.ok(metresBetweenCases.length > 0, 'vector file has no cases');

  for (const c of metresBetweenCases) {
    const got = metresBetween(c.lat1, c.lng1, c.lat2, c.lng2);
    const diff = Math.abs(got - c.expectedMetres);
    assert.ok(
      diff <= toleranceMetres,
      `${c.id}: ${c.description ?? ''} — got ${got}, expected ${c.expectedMetres} (within ${toleranceMetres} m)`
    );
  }
});

/* ───────── distance.json: formatDistance ───────── */

test('formatDistance — pt-PT metres/km formatting with comma decimals', () => {
  const { formatDistanceCases } = loadVector('distance.json');
  assert.ok(formatDistanceCases.length > 0, 'vector file has no cases');

  for (const c of formatDistanceCases) {
    const got = formatDistance(c.metres);
    assert.equal(got, c.expected, `${c.id}: ${c.description ?? ''}`);
  }
});

/* ───────── distance.json: sortByDistance ───────── */

test('sortByDistance — nearest first, unsorted copy when position is unknown', () => {
  const { sortByDistanceCases } = loadVector('distance.json');
  assert.ok(sortByDistanceCases.length > 0, 'vector file has no cases');

  for (const c of sortByDistanceCases) {
    const before = c.machines.map((m) => m.id);
    const got = sortByDistance(c.machines, c.from).map((m) => m.id);
    assert.deepEqual(got, c.expectedIds, `${c.id}: ${c.description ?? ''}`);
    // Pure: the input array's own order must be untouched.
    assert.deepEqual(c.machines.map((m) => m.id), before, `${c.id}: mutated its input`);
  }
});

/* ───────── status-filter.json: filterByStatus ───────── */

test('filterByStatus — matches statusOf(machine, now) against the given list; empty list matches nothing', () => {
  const { filterByStatusCases } = loadVector('status-filter.json');
  assert.ok(filterByStatusCases.length > 0, 'vector file has no cases');

  for (const c of filterByStatusCases) {
    const got = filterByStatus(c.machines, c.statuses, c.now).map((m) => m.id);
    assert.deepEqual(got, c.expectedIds, `${c.id}: ${c.description ?? ''}`);
  }
});

/* ───────── status-filter.json: statusCounts ───────── */

test('statusCounts — buckets by statusOf(), independent of any status filter', () => {
  const { statusCountsCases } = loadVector('status-filter.json');
  assert.ok(statusCountsCases.length > 0, 'vector file has no cases');

  for (const c of statusCountsCases) {
    const got = statusCounts(c.machines, c.now);
    assert.deepEqual(got, c.expected, `${c.id}: ${c.description ?? ''}`);
  }
});
