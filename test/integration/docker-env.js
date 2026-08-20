// Spins up real Postgres + PostgREST containers for the integration suite,
// and tears them down again. No mocks: this is the only place that runs
// schema.sql, seed/machines.sql and public.report_machine() against an
// actual database, the way Supabase would.
//
// Deliberately NOT the Supabase CLI — its GitHub release is unreachable from
// this environment (proxy policy, not worth retrying), and it would only
// buy auth/storage/realtime that this app never uses. Postgres + PostgREST
// is the whole surface: no auth, no storage, no realtime.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..');

const NET = 'voltacheck-it-net';
const PG = 'voltacheck-it-pg';
const REST = 'voltacheck-it-rest';
const PORT = 3999;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

const PG_IMAGE = 'postgres:16-alpine';
const REST_IMAGE = 'postgrest/postgrest:v12.2.3';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, ...opts });
}

// True only if the docker CLI can actually reach a running daemon — a
// missing/dead daemon must not throw, so the suite can skip cleanly instead
// of failing on a machine without Docker.
export function dockerAvailable() {
  try {
    return run('docker', ['info']).status === 0;
  } catch {
    return false;
  }
}

// Removes any leftovers from a previous run that crashed mid-suite, so the
// harness is safe to re-run without manual cleanup. Every call is best-effort
// (ignore errors — "already gone" is success here too).
function removeExisting() {
  run('docker', ['rm', '-f', REST, PG]);
  run('docker', ['network', 'rm', NET]);
}

function psql(sql, retries = 2) {
  const res = run(
    'docker',
    ['exec', '-i', '-u', 'postgres', PG, 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'app', '-q'],
    { input: sql },
  );
  if (res.status !== 0) {
    // Belt-and-suspenders alongside the two-in-a-row readiness check above:
    // "the database system is shutting down" means we still caught the
    // initdb container's throwaway restart. Retrying a genuine SQL error
    // (bad syntax, constraint violation) just fails the same way again.
    if (retries > 0 && /shutting down|starting up/.test(res.stderr)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // synchronous sleep
      return psql(sql, retries - 1);
    }
    throw new Error(`psql failed:\n${res.stderr}\n${res.stdout}`);
  }
  return res.stdout;
}

function psqlFile(relPath) {
  return psql(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

async function waitFor(check, { label, timeoutMs = 30_000, intervalMs = 300 }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? `: ${lastErr}` : ''}`);
}

// Brings up network + postgres + postgrest, applies the bootstrap roles,
// the repo's real unmodified schema.sql, and seed/machines.sql. Throws (and
// cleans up after itself) if any step fails.
export async function setup() {
  removeExisting();
  try {
    run('docker', ['network', 'create', NET]);

    const pgRun = run('docker', [
      'run', '-d', '--name', PG, '--network', NET,
      '-e', 'POSTGRES_PASSWORD=pw', '-e', 'POSTGRES_DB=app',
      PG_IMAGE,
    ]);
    if (pgRun.status !== 0) throw new Error(`starting postgres failed: ${pgRun.stderr}`);

    // postgres:16-alpine's entrypoint runs initdb, starts the server briefly
    // to run init scripts, shuts it back down, then starts it for real.
    // pg_isready can report ready during that first, throwaway start, so a
    // single green check isn't enough — wait for two real queries to
    // succeed in a row, half a second apart, to land after the restart.
    let consecutive = 0;
    await waitFor(
      () => {
        const ok = run('docker', ['exec', '-u', 'postgres', PG, 'psql', '-d', 'app', '-c', 'select 1']).status === 0;
        consecutive = ok ? consecutive + 1 : 0;
        return consecutive >= 2;
      },
      { label: 'postgres to accept connections', intervalMs: 500 },
    );

    // Order matters: roles before schema.sql (which grants to them), schema
    // before the seed (which references public.machines).
    psqlFile('test/integration/supabase-roles.sql');
    psqlFile('schema.sql');
    psqlFile('seed/machines.sql');

    const restRun = run('docker', [
      'run', '-d', '--name', REST, '--network', NET, '-p', `${PORT}:3000`,
      '-e', `PGRST_DB_URI=postgres://authenticator:pw@${PG}:5432/app`,
      '-e', 'PGRST_DB_SCHEMAS=public',
      '-e', 'PGRST_DB_ANON_ROLE=anon',
      '-e', 'PGRST_JWT_SECRET=reallyreallyreallyreallyverysafesecret',
      // Mirrors Supabase's documented default row cap. Without this the
      // 1000-row pagination bug this suite exists to catch does not
      // reproduce, and the regression test below is theatre.
      '-e', 'PGRST_DB_MAX_ROWS=1000',
      REST_IMAGE,
    ]);
    if (restRun.status !== 0) throw new Error(`starting postgrest failed: ${restRun.stderr}`);

    await waitFor(
      async () => {
        const res = await fetch(`${BASE_URL}/machines?limit=1`);
        return res.ok;
      },
      { label: 'postgrest to accept requests' },
    );
  } catch (err) {
    removeExisting();
    throw err;
  }
}

export async function teardown() {
  removeExisting();
}

// Runs SQL as the Postgres superuser, bypassing RLS/PostgREST entirely.
// Used by tests to arrange state directly (e.g. seeding a source='user' row)
// or to inspect internals no API exposes (e.g. the guard salt).
export function superuserQuery(sql) {
  return psql(sql);
}

// Same, but for a single-value query — returns it as a trimmed string via
// psql's unaligned tuples-only output instead of psql's table formatting.
export function superuserScalar(sql) {
  const res = run(
    'docker',
    ['exec', '-u', 'postgres', PG, 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'app', '-t', '-A', '-c', sql],
  );
  if (res.status !== 0) {
    throw new Error(`psql failed:\n${res.stderr}\n${res.stdout}`);
  }
  return res.stdout.trim();
}

export function reapplySchema() {
  psqlFile('schema.sql');
}

export function reapplySeed() {
  psqlFile('seed/machines.sql');
}
