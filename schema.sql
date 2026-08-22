-- Cêntimo / VoltaCheck — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- Safe to re-run: every statement is idempotent, so this doubles as the
-- migration for a database created before the machines table grew columns.
--
-- Then load the real machines — see "Seed data" at the bottom.

-- ─────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────

create table if not exists machines (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now()
);

-- Added after the first import. `create table if not exists` above won't touch
-- an existing table, so the columns go on separately.
alter table machines add column if not exists external_id text;
alter table machines add column if not exists town        text;
alter table machines add column if not exists address     text;
alter table machines add column if not exists source      text not null default 'user';
alter table machines add column if not exists chain       text;

-- external_id is the source's own identifier — 'osm:node/13722147127'. It is
-- what makes re-importing safe: the importer upserts on it, so a second run
-- updates rows instead of doubling every machine. Postgres treats NULLs as
-- distinct here, so machines people add by hand simply leave it empty.
create unique index if not exists machines_external_id
  on machines (external_id);

-- 'osm' for imported machines, 'user' for ones people added. A re-import only
-- touches its own rows, so community additions never get clobbered.
alter table machines drop constraint if exists machines_source_check;
alter table machines add  constraint machines_source_check
  check (source in ('osm', 'sdr', 'user'));

-- Search by town.
create index if not exists machines_town on machines (lower(town));

-- Filter by supermarket. Set once at import time by tools/import_osm.py from
-- the machine's name — OSM carries no separate tag for which chain hosts a
-- machine. Null for machines added through the app; the app buckets those
-- (and any imported machine whose name didn't match a known chain) as
-- "Outras". Not a foreign key: the chain list lives client-side and grows
-- without a migration.
create index if not exists machines_chain on machines (chain);

-- `address` is here for a source that carries street addresses. OSM does not
-- for these machines — the name ("Pingo Doce Altura") is the useful label —
-- so it stays null until something fills it.

create table if not exists reports (
  id          bigint generated always as identity primary key,
  machine_id  uuid not null references machines(id) on delete cascade,
  status      text not null check (status in ('ok', 'full', 'down')),
  created_at  timestamptz not null default now()
);

create index if not exists reports_machine_recent
  on reports (machine_id, created_at desc);

-- ─────────────────────────────────────────────
-- Row level security
--
-- Anyone may read. Anyone may add a machine or a report, but only somewhere
-- in Portugal and with a sane name. This is the floor, not real abuse
-- protection — see the note at the bottom.
-- ─────────────────────────────────────────────

alter table machines enable row level security;
alter table reports  enable row level security;

drop policy if exists machines_read   on machines;
drop policy if exists machines_insert on machines;
drop policy if exists reports_read    on reports;

create policy machines_read on machines
  for select using (true);

-- machines_insert used to live here, letting anyone with the anon key add
-- unlimited machines straight onto the map with no rate limit and no check
-- at all — the permanent table was less protected than `reports`, which
-- decays. It's gone; see "Machine submissions" below. New machines now go
-- through public.submit_machine() into a review queue, and only an
-- `approved` row becomes a real one.

create policy reports_read on reports
  for select using (true);

-- Report inserts no longer go through a policy — see "Report guard" below,
-- which revokes insert on this table entirely and routes writes through
-- public.report_machine() instead.

-- ─────────────────────────────────────────────
-- Seed data
--
-- ~2.400 real machines live in seed/, generated from OpenStreetMap by
-- tools/import_osm.py. Load them either way:
--
--   • Table editor → machines → Import data from CSV → seed/machines.csv
--     (easiest from a phone or iPad)
--   • SQL editor → paste seed/machines.sql
--
-- Both are safe to repeat — the SQL upserts on external_id.
--
-- Data © OpenStreetMap contributors, under ODbL. The map already credits
-- them in the attribution control; keep it there.
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- Report guard — rate limiting and proximity
--
-- Reports no longer go in through the table. They go through
-- public.report_machine(), which counts and checks first. Nothing
-- identifying is written to `reports`; the counters live in `private`,
-- which the Data API does not expose.
-- ─────────────────────────────────────────────

create schema if not exists private;
revoke all on schema private from public;

-- The salt never leaves the database and is not in this repo. Generated once;
-- re-running this file keeps the existing one.
create table if not exists private.guard_secret (
  id   int primary key default 1 check (id = 1),
  salt text not null
);
insert into private.guard_secret (id, salt)
values (1, replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''))
on conflict (id) do nothing;

-- One row per accepted report. Pseudonyms only, dropped after 48 h.
create table if not exists private.report_guard (
  id          bigint generated always as identity primary key,
  ident       text not null,
  ip_ident    text not null,
  machine_id  uuid not null,
  created_at  timestamptz not null default now()
);
create index if not exists report_guard_ident on private.report_guard (ident, created_at desc);
create index if not exists report_guard_ip    on private.report_guard (ip_ident, created_at desc);

-- Haversine, metres. No PostGIS needed for one point-to-point distance.
create or replace function private.metres_between(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe
set search_path = ''
as $$
  select 12742000 * asin(sqrt(
      power(sin(radians($3 - $1) / 2), 2)
    + cos(radians($1)) * cos(radians($3)) * power(sin(radians($4 - $2) / 2), 2)
  ));
$$;

-- sha256() and gen_random_uuid() are core Postgres. No pgcrypto.
create or replace function private.guard_hash(kind text, value text)
returns text language sql stable set search_path = '' as $$
  select encode(
    sha256(
      convert_to((select s.salt from private.guard_secret s where s.id = 1)
                 || ':' || $1 || ':' || $2, 'UTF8')),
    'hex');
$$;

-- The caller's IP, as trustworthily as this stack allows.
--
-- Measured against the live project rather than assumed (see
-- docs/rate-limiting-plan.md). Two things came out of it:
--
--   * Supabase sits behind Cloudflare, which PREPENDS nothing and APPENDS
--     the real connecting address to whatever `x-forwarded-for` the client
--     sent. A client sending "9.9.9.9, 8.8.8.8" arrives as
--     "9.9.9.9, 8.8.8.8, <real>". So the real address is the LAST element,
--     never the first, and a spoofer cannot remove it — only push it
--     rightwards. Hashing the whole string, as this used to, handed anyone
--     a fresh rate-limit bucket per request just by varying the prefix.
--   * `cf-connecting-ip` is set by Cloudflare itself and cannot be forged:
--     a request that tries to set it is rejected with a 403 at the edge,
--     before Supabase ever sees it. That makes it the better source, with
--     the last `x-forwarded-for` element as the fallback if Supabase ever
--     stops fronting with Cloudflare.
--
-- `true` in current_setting makes this NULL when PostgREST is not the
-- caller. Once the GUC has been set in a session, resetting it leaves ''
-- rather than NULL, so strip that too or the ::json cast throws. (Found the
-- hard way — see testing.)
create or replace function private.client_ip() returns text
language plpgsql stable set search_path = pg_catalog as $$
declare
  hdrs json;
begin
  hdrs := nullif(current_setting('request.headers', true), '')::json;
  if hdrs is null then
    return 'sem-ip';
  end if;
  return coalesce(
    nullif(btrim(hdrs ->> 'cf-connecting-ip'), ''),
    nullif(btrim(split_part(hdrs ->> 'x-forwarded-for', ',', -1)), ''),
    'sem-ip');
end $$;

-- Returns one of: ok, cooldown, flood, far, unknown, invalid.
-- It returns a string rather than raising, so the client can map each case to
-- its own line of Portuguese without depending on HTTP status plumbing.
--
-- Every one of those six strings is also counted, under
-- `reports.outcome`, by private.note_outcome() — defined further down this
-- file, which is fine because plpgsql resolves calls at run time and the
-- Migrate workflow applies the whole file in one transaction. Until now the
-- rejections were computed and thrown away: if the 2 km proximity rule were
-- turning away real people, nothing here would ever have said so. See
-- docs/observability-plan.md.
create or replace function public.report_machine(
  machine  uuid,
  state    text,
  lat      double precision default null,
  lng      double precision default null,
  acc      double precision default null,
  device   text default null
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m_lat  double precision;
  m_lng  double precision;
  ip     text;
  who    text;
  who_ip text;
  slack  double precision;
  n      integer;
begin
  if state not in ('ok','full','down') then
    return private.note_outcome('reports.outcome', 'invalid');
  end if;

  select m.lat, m.lng into m_lat, m_lng from public.machines m where m.id = machine;
  if not found then
    return private.note_outcome('reports.outcome', 'unknown');
  end if;

  ip := private.client_ip();
  who_ip := private.guard_hash('ip', ip);
  who    := private.guard_hash('dev', coalesce(nullif(device, ''), ip));

  -- Proximity, 2 km. The point of this check was never to prove someone is
  -- standing at the machine — it's to accept a fresh *observation*: someone
  -- who just left the shop, reporting from the car park or a couple of
  -- minutes down the road on foot or by car, while still rejecting a report
  -- from across the region, which isn't an observation of this machine at
  -- all. `acc` is the browser's own accuracy radius in metres, and it is
  -- deliberately not capped: with iOS Precise Location off the radius is
  -- 1-20 km, and capping it would reject those people while stopping nobody
  -- who is lying — a liar picks the coordinates too. Missing coordinates are
  -- accepted; blocking real reports is worse than letting a few bad ones in.
  -- And because this whole check fails open, it only ever constrains someone
  -- who shares their real location in the first place — being generous here
  -- costs nothing against anyone actually determined to lie.
  if lat is not null and lng is not null then
    slack := greatest(coalesce(acc, 0), 0);
    if private.metres_between(lat, lng, m_lat, m_lng) > 2000 + slack then
      return private.note_outcome('reports.outcome', 'far');
    end if;
  end if;

  if random() < 0.02 then
    delete from private.report_guard where created_at < now() - interval '48 hours';
  end if;

  -- Same machine, same device, inside 10 min. Well under the 3 h
  -- reconfirmation prompt, so it never gets in the way of "Ainda está assim?".
  select count(*) into n from private.report_guard g
   where g.ident = who and g.machine_id = machine
     and g.created_at > now() - interval '10 minutes';
  if n > 0 then return private.note_outcome('reports.outcome', 'cooldown'); end if;

  select count(*) into n from private.report_guard g
   where g.ident = who and g.created_at > now() - interval '1 hour';
  if n >= 20 then return private.note_outcome('reports.outcome', 'flood'); end if;

  select count(*) into n from private.report_guard g
   where g.ident = who and g.created_at > now() - interval '24 hours';
  if n >= 60 then return private.note_outcome('reports.outcome', 'flood'); end if;

  -- Backstop for someone rotating device ids. Loose on purpose: Portuguese
  -- mobile networks put a lot of people behind one address.
  select count(*) into n from private.report_guard g
   where g.ip_ident = who_ip and g.created_at > now() - interval '1 hour';
  if n >= 300 then return private.note_outcome('reports.outcome', 'flood'); end if;

  insert into public.reports (machine_id, status) values (machine, state);
  insert into private.report_guard (ident, ip_ident, machine_id) values (who, who_ip, machine);
  return private.note_outcome('reports.outcome', 'ok');
end;
$$;

revoke all on function public.report_machine(uuid, text, double precision, double precision, double precision, text) from public;
grant execute on function public.report_machine(uuid, text, double precision, double precision, double precision, text) to anon, authenticated;

-- Close the front door. From here on the only way into `reports` is the
-- function above.
drop policy if exists reports_insert on reports;
revoke insert on table public.reports from anon, authenticated;

-- ─────────────────────────────────────────────
-- Machine submissions — manual review, not instant publish
--
-- machines_insert used to let anyone with the anon key add a permanent row
-- straight onto the map, with no rate limit and no check beyond a bounding
-- box and a name length — the permanent thing was less protected than
-- `reports`, which decays. New machines now go into this queue instead, and
-- only become a real `machines` row once a human sets status = 'approved'.
--
-- Reuses private.guard_secret / private.guard_hash from the report guard
-- above — one salt, one hashing scheme, for both writers.
-- ─────────────────────────────────────────────

create table if not exists machine_submissions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  chain        text,
  note         text,
  lat          double precision not null,
  lng          double precision not null,
  town         text,
  from_lat     double precision,
  from_lng     double precision,
  from_acc     double precision,
  from_metres  double precision,
  near_id      uuid,
  near_name    text,
  near_metres  double precision,
  likely_dupe  boolean not null default false,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  machine_id   uuid references machines(id)
);

-- A reviewer taps straight from the Supabase table editor to satellite view
-- to sanity-check a submission, no separate map needed.
alter table machine_submissions add column if not exists maps_url text
  generated always as (
    'https://www.google.com/maps/@' || lat::text || ',' || lng::text || ',19z'
  ) stored;

create index if not exists machine_submissions_status
  on machine_submissions (status, created_at desc);

alter table machine_submissions enable row level security;

-- No policies, no grants, in either direction. Writes happen only through
-- public.submit_machine() below, which runs as the function owner and so
-- bypasses RLS the same way public.report_machine() already does for
-- `reports` — anon never gets a table-level grant to piggyback on. Reads
-- happen only via the Supabase dashboard / service role: the queue is
-- private, so nobody can watch whether their own junk landed or got
-- rejected.
revoke all on table public.machine_submissions from anon, authenticated;

-- One row per accepted submission. Same shape as private.report_guard, kept
-- separate because the rate limits below are deliberately tighter and
-- aren't keyed to any one machine (there isn't one yet).
create table if not exists private.submission_guard (
  id          bigint generated always as identity primary key,
  ident       text not null,
  ip_ident    text not null,
  created_at  timestamptz not null default now()
);
create index if not exists submission_guard_ident on private.submission_guard (ident, created_at desc);
create index if not exists submission_guard_ip    on private.submission_guard (ip_ident, created_at desc);

-- Returns one of: ok, cooldown, flood, invalid. Same string-return style as
-- report_machine() — the client maps each case to its own line of
-- Portuguese without depending on HTTP status plumbing.
-- Counted under `submissions.outcome`, same as above.
--
-- Deliberately does NOT check the submitter's distance from the machine —
-- adding a machine from home with accurate coordinates is legitimate and
-- welcome, unlike reporting a status you didn't see. `from_lat`/`from_lng`,
-- when given, are recorded only as a review signal (`from_metres`), never

-- Grew a column: what the submitter typed as the street address. Nothing
-- filled machines.address before — OSM carries no street address for these
-- — but a person adding a machine knows where it is, and typing it is
-- cheaper than any amount of guessing.
alter table machine_submissions add column if not exists address text;

-- The parameter list changed (town and address are now passed in rather
-- than derived), and `create or replace` cannot change a function's
-- signature — it would leave the old one in place as a second overload.
-- PostgREST then sees two candidates for /rpc/submit_machine and answers
-- 300 Multiple Choices for every call, which is a total outage of the add
-- form rather than a subtle drift. Drop the previous signature by name
-- first; `if exists` keeps this safe on a fresh database.
drop function if exists public.submit_machine(
  text, double precision, double precision, text, text,
  double precision, double precision, double precision, text);

-- used to accept or reject.
create or replace function public.submit_machine(
  name      text,
  lat       double precision,
  lng       double precision,
  chain     text default null,
  note      text default null,
  town      text default null,
  address   text default null,
  from_lat  double precision default null,
  from_lng  double precision default null,
  from_acc  double precision default null,
  device    text default null
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ip        text;
  who       text;
  who_ip    text;
  v_name    text;
  v_note    text;
  v_chain   text;
  v_town    text;
  v_address text;
  n_town    text;
  n_id      uuid;
  n_name    text;
  n_metres  double precision;
  f_metres  double precision;
  n         integer;
  new_id    uuid;
begin
  v_name    := trim(coalesce(name, ''));
  v_note    := nullif(trim(coalesce(note, '')), '');
  v_chain   := nullif(trim(coalesce(chain, '')), '');
  v_town    := nullif(trim(coalesce(town, '')), '');
  v_address := nullif(trim(coalesce(address, '')), '');

  if length(v_name) < 3 or length(v_name) > 80 then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;
  -- 140 chars — a short line ("ao lado da entrada"), not a place for a
  -- review essay. Room for review notes lives in the dashboard, not here.
  if v_note is not null and length(v_note) > 140 then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;
  if v_town is not null and length(v_town) > 60 then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;
  if v_address is not null and length(v_address) > 120 then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;
  if lat is null or lng is null then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;
  -- Same bounding boxes machines_insert used to check: mainland, Madeira,
  -- Azores.
  if not (
       (lat between 36.80 and  42.25 and lng between  -9.62 and  -6.10)
    or (lat between 32.30 and  33.20 and lng between -17.35 and -16.20)
    or (lat between 36.85 and  39.90 and lng between -31.40 and -24.90)
  ) then
    return private.note_outcome('submissions.outcome', 'invalid');
  end if;

  ip := private.client_ip();
  who_ip := private.guard_hash('ip', ip);
  who    := private.guard_hash('dev', coalesce(nullif(device, ''), ip));

  if random() < 0.02 then
    delete from private.submission_guard where created_at < now() - interval '48 hours';
  end if;

  -- Same device, inside 2 min — catches a double-tapped save button. There's
  -- no "same machine" to key a cooldown on the way report_machine() does;
  -- the machine doesn't exist yet.
  select count(*) into n from private.submission_guard g
   where g.ident = who and g.created_at > now() - interval '2 minutes';
  if n > 0 then return private.note_outcome('submissions.outcome', 'cooldown'); end if;

  -- Submissions are for brand-new machines, and the country is already
  -- 2,400+ deep — a genuine person adds a handful of new ones in their
  -- lifetime, not per hour. Deliberately tighter than report_machine()'s
  -- 20/hour and 60/day: 5/hour and 15/day per device.
  select count(*) into n from private.submission_guard g
   where g.ident = who and g.created_at > now() - interval '1 hour';
  if n >= 5 then return private.note_outcome('submissions.outcome', 'flood'); end if;

  select count(*) into n from private.submission_guard g
   where g.ident = who and g.created_at > now() - interval '24 hours';
  if n >= 15 then return private.note_outcome('submissions.outcome', 'flood'); end if;

  -- IP backstop for someone rotating device ids, same reasoning as
  -- report_machine()'s: shared addresses (CGNAT, a shop's wifi) shouldn't
  -- lock out unrelated people. Looser than the device caps above, but
  -- tighter than report_machine()'s 300/hour, because submissions are
  -- rarer to begin with: 40/hour per IP.
  select count(*) into n from private.submission_guard g
   where g.ip_ident = who_ip and g.created_at > now() - interval '1 hour';
  if n >= 40 then return private.note_outcome('submissions.outcome', 'flood'); end if;

  -- Nearest existing machine. Source of the duplicate-detection signal
  -- below, and a last-resort fallback for the concelho.
  --
  -- It used to be the *only* source of the concelho, on the reasoning that a
  -- new machine is essentially always in its neighbour's. The first real
  -- submission broke that: the nearest machine was 18.8 km away, in a
  -- different concelho, and the submission was filed under it — so the town
  -- search would not have found it under the name it was given. The town now
  -- comes from whoever submitted it, and this is only consulted when they
  -- left it blank AND the neighbour is close enough for the assumption to
  -- hold. Otherwise it stays null, which is honest and visible in review,
  -- rather than confidently wrong and invisible.
  --
  -- `submit_machine.lat`/`.lng` below, not bare `lat`/`lng`: this query's
  -- FROM clause touches public.machines, which itself has lat/lng columns,
  -- so an unqualified reference is ambiguous between the parameter and the
  -- table column (Postgres error 42702) — qualifying with the function name
  -- is the documented way to point at the parameter instead.
  select m.id, m.name, m.town,
         private.metres_between(submit_machine.lat, submit_machine.lng, m.lat, m.lng)
    into n_id, n_name, n_town, n_metres
    from public.machines m
   order by private.metres_between(submit_machine.lat, submit_machine.lng, m.lat, m.lng) asc
   limit 1;

  -- 2 km, the same radius report_machine() treats as "near this machine".
  -- Inside it, two machines really are almost always in one concelho.
  if v_town is null and n_metres is not null and n_metres <= 2000 then
    v_town := n_town;
  end if;

  if from_lat is not null and from_lng is not null then
    f_metres := private.metres_between(from_lat, from_lng, lat, lng);
  end if;

  insert into public.machine_submissions
    (name, chain, note, lat, lng, town, address, from_lat, from_lng, from_acc,
     from_metres, near_id, near_name, near_metres, likely_dupe)
  values
    (v_name, v_chain, v_note, lat, lng, v_town, v_address, from_lat, from_lng,
     from_acc, f_metres, n_id, n_name, n_metres, coalesce(n_metres < 75, false))
  returning id into new_id;

  insert into private.submission_guard (ident, ip_ident) values (who, who_ip);

  return private.note_outcome('submissions.outcome', 'ok');
end;
$$;

revoke all on function public.submit_machine(text, double precision, double precision, text, text, text, text, double precision, double precision, double precision, text) from public;
grant execute on function public.submit_machine(text, double precision, double precision, text, text, text, text, double precision, double precision, double precision, text) to anon, authenticated;

-- Promote an approved submission into a real machine. Idempotent by
-- checking machine_id is still null before inserting — toggling status back
-- and forth (pending -> approved -> rejected -> approved again) must never
-- create a second machines row for the same submission.
create or replace function private.approve_submission() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_machine_id uuid;
begin
  if new.status = 'approved' and new.machine_id is null then
    insert into public.machines (name, chain, town, address, lat, lng, source, external_id)
    values (new.name, new.chain, new.town, new.address, new.lat, new.lng, 'user', null)
    returning id into new_machine_id;
    new.machine_id := new_machine_id;
  end if;

  if new.status in ('approved', 'rejected') and new.reviewed_at is null then
    new.reviewed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists machine_submissions_approve on machine_submissions;
create trigger machine_submissions_approve
  before update on machine_submissions
  for each row execute function private.approve_submission();

-- The RPC above is the only public write path into `machines` now. Anyone
-- with the anon key used to be able to insert a row directly and have it
-- appear on the map instantly and forever; now the only door in goes through
-- review.
drop policy if exists machines_insert on machines;
revoke insert on table public.machines from anon, authenticated;

-- ─────────────────────────────────────────────
-- Telemetry — the admin dashboard's numbers
--
-- Read docs/observability-plan.md alongside this. The short version:
--
--   * Two tiers. `telemetry_daily` holds counters, histograms and gauges,
--     upserted in place and kept forever — it does not grow with traffic.
--     `telemetry_raw` holds individual records (errors, slow spans, a
--     head-sampled slice of traces) and is pruned after 14 days.
--   * The wire format is a compact envelope, not OTLP/JSON, because OTLP is
--     3-4x the bytes to upload from a phone and a nested walk to parse in a
--     function anyone can call. The OpenTelemetry *data model* is kept
--     intact — real 16-byte trace ids, 8-byte span ids, parent links,
--     severity numbers, explicit-bucket histograms — and
--     private.otlp_export() renders any window of it back as OTLP/JSON, so
--     forwarding to a real backend later needs no change in the app.
--   * public.ingest_telemetry() is an anonymous endpoint, exactly like
--     report_machine() and submit_machine(), and is guarded the same way:
--     the same salt, the same hashing, the same "return a string, don't
--     raise". Plus a metric registry, which is what stops a caller from
--     inventing unbounded (metric, dims) combinations and filling the
--     table one row at a time.
--
-- Everything here lives in `private`, which the Data API does not expose.
-- anon and authenticated get exactly one privilege in this whole section:
-- execute on public.ingest_telemetry(). They cannot read a byte back.
-- ─────────────────────────────────────────────

-- The registry. A metric that is not in here is dropped on ingest.
--
-- `dim_keys` bounds cardinality: those are the only dimension keys a metric
-- may carry, and any value is capped at 40 characters. `source` decides who
-- may write it — 'server' metrics are recorded by report_machine() and
-- friends, and ingest_telemetry() refuses them, so a client cannot forge
-- the outcome counters the dashboard's funnel is built on.
create table if not exists private.telemetry_metric (
  name     text primary key,
  kind     text not null check (kind in ('counter','histogram','gauge')),
  dim_keys text[] not null default '{}',
  source   text not null default 'client' check (source in ('client','server')),
  about    text
);

insert into private.telemetry_metric (name, kind, dim_keys, source, about) values
  -- Server-side. Written inside the write guards; never accepted from a client.
  ('reports.outcome',      'counter',   '{outcome}',        'server', 'every string report_machine() returns, including the rejections'),
  ('submissions.outcome',  'counter',   '{outcome}',        'server', 'same, for submit_machine()'),
  ('machines.total',       'gauge',     '{}',               'server', 'rows in machines, snapshotted daily'),
  ('machines.new',         'gauge',     '{source}',         'server', 'machines created that day, by osm/user; recomputed, not incremented'),
  ('reports.filed',        'gauge',     '{status}',         'server', 'accepted reports that day, by status; recomputed, not incremented'),
  ('coverage.live',        'gauge',     '{}',               'server', 'per-mille of machines with a report inside STALE_AFTER'),
  ('submissions.pending',  'gauge',     '{}',               'server', 'depth of the review queue'),
  ('submissions.oldest_h', 'gauge',     '{}',               'server', 'age in hours of the oldest pending submission'),
  ('telemetry.rejected',   'counter',   '{reason}',         'server', 'ingest entries dropped, and why'),
  -- Client-side.
  ('app.visit',            'counter',   '{mode}',           'client', 'one per page load'),
  ('app.session',          'counter',   '{mode}',           'client', 'one per browser session, on its first flush'),
  ('app.error',            'counter',   '{kind}',           'client', 'window.onerror and unhandledrejection'),
  ('app.boot.duration',    'histogram', '{mode}',           'client', 'page load to first usable map'),
  ('db.pull.duration',     'histogram', '{kind}',           'client', 'machines and reports pulls, separately'),
  ('db.rpc.duration',      'histogram', '{rpc,outcome}',    'client', 'report_machine and submit_machine, as the phone sees them'),
  ('db.pull.rows',         'counter',   '{kind}',           'client', 'rows actually received, to catch a paging regression'),
  ('map.render.duration',  'histogram', '{mode}',           'client', 'pins vs clusters'),
  ('sheet.open',           'counter',   '{state}',          'client', 'the top of the report funnel'),
  ('report.tap',           'counter',   '{status}',         'client', 'a state was tapped'),
  ('report.result',        'counter',   '{outcome}',        'client', 'what the phone saw come back — differs from reports.outcome when the network ate it'),
  ('search.town',          'counter',   '{town}',           'client', 'concelho searched, or sem-resultado'),
  ('filter.chain',         'counter',   '{chain}',          'client', 'chain chip tapped'),
  ('filter.status',        'counter',   '{status}',         'client', 'status checkbox toggled on'),
  ('filter.distance',      'counter',   '{km}',             'client', 'distance segment picked'),
  ('locate.tap',           'counter',   '{outcome}',        'client', 'granted/denied/timeout/unavailable'),
  ('page.view',            'counter',   '{page}',           'client', 'app or admin')
on conflict (name) do update
  set kind = excluded.kind, dim_keys = excluded.dim_keys,
      source = excluded.source, about = excluded.about;

-- Aggregates, kept forever. One row per (day, metric, dims).
--
-- `value` carries counters (summed) and gauges (overwritten). Gauges that
-- are not whole numbers are scaled to integers by the metric's definition —
-- coverage.live is per-mille — because a bigint that is exact beats a float
-- that is nearly right for something read off a dashboard.
--
-- Histograms use hits/sum_ms/max_ms plus `buckets`, a fixed 12-element
-- explicit-bucket histogram in OpenTelemetry's sense. Boundaries are in
-- private.hist_bounds() below; storing the boundaries per row would triple
-- the row for no gain, since they never change.
create table if not exists private.telemetry_daily (
  day     date   not null,
  metric  text   not null,
  dims    jsonb  not null default '{}'::jsonb,
  value   bigint not null default 0,
  hits    bigint not null default 0,
  sum_ms  double precision not null default 0,
  max_ms  double precision,
  buckets bigint[],
  primary key (day, metric, dims)
);

-- Individual records. Only what needs to be an individual: errors, spans
-- over a threshold, and a head-sampled slice of traces for the waterfall on
-- the dashboard's Saúde screen. Everything else is counted above and never
-- stored, which is the whole reason this fits in the free tier.
--
-- Note what is NOT on this row: no IP hash (it lives on telemetry_guard,
-- one row per flush rather than one per event), no coordinates, no URL, no
-- user agent string beyond a coarse bucket in `attrs`. Trace and span ids
-- are bytea, not hex text — 16 and 8 bytes instead of 32 and 16.
create table if not exists private.telemetry_raw (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  kind      text not null check (kind in ('span','log')),
  name      text not null,
  severity  smallint,
  trace_id  bytea,
  span_id   bytea,
  parent_id bytea,
  dur_ms    integer,
  attrs     jsonb not null default '{}'::jsonb,
  sess      uuid,
  release   text
);
create index if not exists telemetry_raw_at    on private.telemetry_raw (at desc);
create index if not exists telemetry_raw_name  on private.telemetry_raw (name, at desc);
create index if not exists telemetry_raw_trace on private.telemetry_raw (trace_id);

-- One row per accepted flush. Same shape and reasoning as
-- private.report_guard: pseudonyms only, dropped after 48 h.
create table if not exists private.telemetry_guard (
  id         bigint generated always as identity primary key,
  ident      text not null,
  ip_ident   text not null,
  created_at timestamptz not null default now()
);
create index if not exists telemetry_guard_ident on private.telemetry_guard (ident, created_at desc);
create index if not exists telemetry_guard_ip    on private.telemetry_guard (ip_ident, created_at desc);

-- ── Limits, in one place so the plan doc and the code cannot drift ──
--
-- TELEMETRY_RAW_MAX is the ceiling that keeps a flood from filling the
-- database: above it the raw tier stops accepting writes and ingestion
-- falls back to counting only, which costs no space at all. 400.000 rows is
-- roughly 120 MB of a 500 MB tier, and about 500 times a normal fortnight.
create or replace function private.telemetry_limits() returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object(
    'raw_days',        14,      -- retention for telemetry_raw
    'guard_hours',     48,      -- retention for telemetry_guard
    'raw_max',         400000,  -- hard ceiling on telemetry_raw rows
    'raw_per_batch',   20,      -- raw records accepted per flush
    'metrics_per_batch', 200,   -- counter/histogram entries accepted per flush
    'dims_per_metric', 500,     -- distinct dimension combinations per metric per day
    'dim_value_len',   40,      -- longest a dimension value may be
    'attrs_bytes',     2000,    -- longest a raw record's attrs may be
    'batches_per_hour_device', 60,
    'batches_per_hour_ip',     600
  );
$$;

-- Explicit histogram bucket boundaries, milliseconds. Twelve buckets: the
-- eleven below plus everything above the last one.
create or replace function private.hist_bounds() returns double precision[]
language sql immutable parallel safe set search_path = '' as $$
  select array[5,10,25,50,100,250,500,1000,2500,5000,10000]::double precision[];
$$;

create or replace function private.hist_index(ms double precision) returns integer
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(
    (select min(i) from generate_subscripts(private.hist_bounds(), 1) i
      where ms <= (private.hist_bounds())[i]),
    array_length(private.hist_bounds(), 1) + 1);
$$;

-- Element-wise addition for the bucket arrays. Postgres has no operator for
-- it, and doing it with an UPDATE ... buckets[i] = ... per observation would
-- mean one statement per bucket touched.
create or replace function private.arr_add(a bigint[], b bigint[]) returns bigint[]
language sql immutable parallel safe set search_path = '' as $$
  select array_agg(coalesce(a[i], 0) + coalesce(b[i], 0) order by i)
    from generate_series(1, greatest(coalesce(array_length(a,1),0),
                                     coalesce(array_length(b,1),0))) i;
$$;

-- ── The three ways a number gets recorded ──

-- The parameters are p_-prefixed on purpose. plpgsql substitutes its
-- variables into an ON CONFLICT target list, so a parameter called `metric`
-- would turn `on conflict (day, metric, dims)` into `on conflict (day, $1,
-- $2)` and fail at run time, not at creation. Same for gauge() and observe().
create or replace function private.note(p_metric text, p_dims jsonb, p_n bigint default 1)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.telemetry_daily (day, metric, dims, value)
  values ((now() at time zone 'utc')::date, p_metric, coalesce(p_dims, '{}'::jsonb), p_n)
  on conflict (day, metric, dims)
  do update set value = telemetry_daily.value + excluded.value;
end $$;

create or replace function private.gauge(p_metric text, p_dims jsonb, p_v bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.telemetry_daily (day, metric, dims, value)
  values ((now() at time zone 'utc')::date, p_metric, coalesce(p_dims, '{}'::jsonb), p_v)
  on conflict (day, metric, dims)
  do update set value = excluded.value;
end $$;

create or replace function private.observe(p_metric text, p_dims jsonb, p_ms double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  delta bigint[];
begin
  if p_ms is null or p_ms < 0 then return; end if;
  delta := array_fill(0::bigint, array[array_length(private.hist_bounds(),1) + 1]);
  delta[private.hist_index(p_ms)] := 1;

  insert into private.telemetry_daily (day, metric, dims, hits, sum_ms, max_ms, buckets)
  values ((now() at time zone 'utc')::date, p_metric, coalesce(p_dims,'{}'::jsonb), 1, p_ms, p_ms, delta)
  on conflict (day, metric, dims)
  do update set hits    = telemetry_daily.hits + 1,
                sum_ms  = telemetry_daily.sum_ms + excluded.sum_ms,
                max_ms  = greatest(telemetry_daily.max_ms, excluded.max_ms),
                buckets = private.arr_add(telemetry_daily.buckets, excluded.buckets);
end $$;

-- Records an outcome string and hands it straight back, so the write guards
-- can stay one-line returns:  return private.note_outcome('reports.outcome', 'far');
create or replace function private.note_outcome(metric text, outcome text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.note(metric, jsonb_build_object('outcome', outcome), 1);
  return outcome;
end $$;

-- ── Housekeeping ──

create or replace function private.telemetry_prune() returns void
language plpgsql security definer set search_path = '' as $$
declare
  lim jsonb := private.telemetry_limits();
begin
  delete from private.telemetry_raw
   where at < now() - ((lim->>'raw_days') || ' days')::interval;
  delete from private.telemetry_guard
   where created_at < now() - ((lim->>'guard_hours') || ' hours')::interval;
end $$;

-- The daily snapshot: the handful of numbers that are cheap to compute from
-- the real tables and expensive to reconstruct later. Idempotent — the
-- gauges overwrite and the counters are recomputed for the day rather than
-- incremented, so running it three times a day (which is what the
-- review-queue workflow does) is the same as running it once.
create or replace function private.telemetry_rollup_daily() returns void
language plpgsql security definer set search_path = '' as $$
declare
  d      date := (now() at time zone 'utc')::date;
  total  bigint;
  live   bigint;
  r      record;
begin
  select count(*) into total from public.machines;
  perform private.gauge('machines.total', '{}'::jsonb, total);

  -- Cobertura viva: machines carrying a report inside STALE_AFTER (18 h).
  -- Per-mille, so the dashboard gets one decimal place without a float.
  select count(distinct rp.machine_id) into live
    from public.reports rp
   where rp.created_at > now() - interval '18 hours';
  perform private.gauge('coverage.live', '{}'::jsonb,
                        case when total > 0 then (live * 1000) / total else 0 end);

  select count(*) into total from public.machine_submissions where status = 'pending';
  perform private.gauge('submissions.pending', '{}'::jsonb, total);

  select coalesce(max(extract(epoch from (now() - s.created_at)) / 3600), 0)::bigint
    into total
    from public.machine_submissions s where s.status = 'pending';
  perform private.gauge('submissions.oldest_h', '{}'::jsonb, total);

  -- Recomputed for today rather than incremented, which is what makes this
  -- safe to re-run. Both tables carry created_at, so there is nothing to
  -- reconstruct from.
  for r in
    select m.source as k, count(*) as n from public.machines m
     where m.created_at >= (d::timestamp at time zone 'UTC')
       and m.created_at <  ((d + 1)::timestamp at time zone 'UTC') group by 1
  loop
    perform private.gauge('machines.new', jsonb_build_object('source', r.k), r.n);
  end loop;

  for r in
    select rp.status as k, count(*) as n from public.reports rp
     where rp.created_at >= (d::timestamp at time zone 'UTC')
       and rp.created_at <  ((d + 1)::timestamp at time zone 'UTC') group by 1
  loop
    perform private.gauge('reports.filed', jsonb_build_object('status', r.k), r.n);
  end loop;

  perform private.telemetry_prune();
end $$;

-- ── The three checks every ingested entry goes through ──

-- Keeps only the dimension keys the registry allows, trims the values, and
-- returns null if the caller sent a key that is not on the list. Returning
-- null rather than silently dropping the key matters: a metric filed under
-- half its dimensions would quietly merge into a row that means something
-- else.
create or replace function private.telemetry_dims(d jsonb, allowed text[], maxlen int)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  out_d jsonb := '{}'::jsonb;
  k     text;
begin
  if d is null or jsonb_typeof(d) = 'null' then return '{}'::jsonb; end if;
  if jsonb_typeof(d) <> 'object' then return null; end if;
  for k in select jsonb_object_keys(d) loop
    if not (k = any(allowed)) then return null; end if;
    if jsonb_typeof(d->k) <> 'string' then return null; end if;
    out_d := out_d || jsonb_build_object(k, left(d->>k, maxlen));
  end loop;
  return out_d;
end $$;

-- Caps how many distinct dimension combinations one metric may accumulate in
-- a day. The registry bounds the *keys*; this bounds the *values*, which is
-- the half a registry cannot cover — search.town is legitimately open-ended,
-- and 500 concelhos a day is already far more than Portugal has.
create or replace function private.telemetry_dims_ok(p_metric text, p_dims jsonb, p_cap int)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  n integer;
begin
  if exists (select 1 from private.telemetry_daily t
              where t.day = (now() at time zone 'utc')::date
                and t.metric = p_metric and t.dims = p_dims) then
    return true;
  end if;
  select count(*) into n from private.telemetry_daily t
   where t.day = (now() at time zone 'utc')::date and t.metric = p_metric;
  return n < p_cap;
end $$;

-- Hex string to bytea, or null if it is not exactly the right length of hex.
-- Anything else would either throw out of decode() or store a trace id that
-- can never join to anything.
create or replace function private.hex_id(s text, chars int)
returns bytea language sql immutable parallel safe set search_path = '' as $$
  select case when s ~ ('^[0-9a-f]{' || chars || '}$') then decode(s, 'hex') end;
$$;

-- ── Ingestion ──
--
-- The envelope, version 1:
--
--   { "v":1, "sess":"<uuid>", "rel":"<release>", "mode":"live",
--     "m":[ {"n":"app.visit","d":{"mode":"live"},"v":1} ],
--     "h":[ {"n":"db.pull.duration","d":{"kind":"machines"},"v":[812.4,640.1]} ],
--     "r":[ {"k":"span","n":"db.pull","t":"<32 hex>","s":"<16 hex>",
--            "p":"<16 hex>","ms":812,"a":{...}},
--           {"k":"log","n":"js.error","sev":17,"a":{...}} ] }
--
-- Returns one of: ok, partial, flood, invalid. Same string-return style as
-- the other two public functions — 'partial' means the flush was accepted
-- but some entries inside it were dropped, which the caller does not need
-- to act on and the dashboard can see in telemetry.rejected.
--
-- Every rejection path counts itself. An endpoint that silently discards
-- what it doesn't like is an endpoint that lies to the dashboard built on
-- it, which would be a strange thing to build into an observability tool.
create or replace function public.ingest_telemetry(payload jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim        jsonb := private.telemetry_limits();
  ip         text;
  who        text;
  who_ip     text;
  sess       uuid;
  rel        text;
  n          integer;
  item       jsonb;
  reg        private.telemetry_metric%rowtype;
  dims       jsonb;
  k          text;
  v          jsonb;
  dropped    integer := 0;
  raw_room   integer;
  raw_est    bigint;
  tid        bytea;
  sid        bytea;
  pid        bytea;
begin
  if payload is null or payload->>'v' is distinct from '1' then
    return 'invalid';
  end if;

  -- Session id is optional but must be a uuid when present: it is what the
  -- dashboard counts distinct sessions by, and a free-text field there would
  -- be both a cardinality hole and somewhere to smuggle a string.
  begin
    sess := nullif(payload->>'sess', '')::uuid;
  exception when others then
    return 'invalid';
  end;

  rel := left(coalesce(nullif(payload->>'rel',''), 'unknown'), 40);

  if jsonb_typeof(coalesce(payload->'m','[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(payload->'h','[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(payload->'r','[]'::jsonb)) <> 'array' then
    return 'invalid';
  end if;

  if jsonb_array_length(coalesce(payload->'m','[]'::jsonb))
   + jsonb_array_length(coalesce(payload->'h','[]'::jsonb))
     > (lim->>'metrics_per_batch')::int then
    return 'invalid';
  end if;

  -- Rate limit, by device then by IP. Same salt, same hashing, same
  -- reasoning as report_machine(): the IP cap is loose because Portuguese
  -- mobile networks put a lot of people behind one address.
  ip     := private.client_ip();
  who_ip := private.guard_hash('ip', ip);
  who    := private.guard_hash('tel', coalesce(sess::text, ip));

  if random() < 0.02 then
    perform private.telemetry_prune();
  end if;

  select count(*) into n from private.telemetry_guard g
   where g.ident = who and g.created_at > now() - interval '1 hour';
  if n >= (lim->>'batches_per_hour_device')::int then
    perform private.note('telemetry.rejected', '{"reason":"flood_device"}'::jsonb, 1);
    return 'flood';
  end if;

  select count(*) into n from private.telemetry_guard g
   where g.ip_ident = who_ip and g.created_at > now() - interval '1 hour';
  if n >= (lim->>'batches_per_hour_ip')::int then
    perform private.note('telemetry.rejected', '{"reason":"flood_ip"}'::jsonb, 1);
    return 'flood';
  end if;

  insert into private.telemetry_guard (ident, ip_ident) values (who, who_ip);

  -- ── counters ──
  for item in select value from jsonb_array_elements(coalesce(payload->'m','[]'::jsonb)) loop
    select * into reg from private.telemetry_metric t where t.name = item->>'n';
    if not found or reg.kind <> 'counter' then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"unknown_metric"}'::jsonb, 1);
      continue;
    end if;
    -- A client may not write a server metric. reports.outcome and friends are
    -- the funnel the dashboard is built on; if the browser could increment
    -- them, "how many reports were rejected as far" would mean nothing.
    if reg.source <> 'client' then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"server_metric"}'::jsonb, 1);
      continue;
    end if;
    dims := private.telemetry_dims(item->'d', reg.dim_keys, (lim->>'dim_value_len')::int);
    if dims is null then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_dims"}'::jsonb, 1);
      continue;
    end if;
    if not private.telemetry_dims_ok(reg.name, dims, (lim->>'dims_per_metric')::int) then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"dim_cardinality"}'::jsonb, 1);
      continue;
    end if;
    -- A counter increment is a small positive integer. Absent means one —
    -- most taps send no value at all. Present but not a number is malformed,
    -- and is dropped rather than quietly counted as one: an ingest endpoint
    -- that guesses is an ingest endpoint the dashboard cannot be read off.
    -- The jsonb_typeof guard is also what keeps (item->>'v')::int from
    -- throwing on a string and losing the whole flush.
    if item ? 'v' and jsonb_typeof(item->'v') <> 'number' then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_value"}'::jsonb, 1);
      continue;
    end if;
    n := case when jsonb_typeof(item->'v') = 'number'
              then least(greatest((item->>'v')::int, 1), 1000) else 1 end;
    perform private.note(reg.name, dims, n);
  end loop;

  -- ── histograms ──
  for item in select value from jsonb_array_elements(coalesce(payload->'h','[]'::jsonb)) loop
    select * into reg from private.telemetry_metric t where t.name = item->>'n';
    if not found or reg.kind <> 'histogram' then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"unknown_metric"}'::jsonb, 1);
      continue;
    end if;
    if reg.source <> 'client' then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"server_metric"}'::jsonb, 1);
      continue;
    end if;
    dims := private.telemetry_dims(item->'d', reg.dim_keys, (lim->>'dim_value_len')::int);
    if dims is null or not private.telemetry_dims_ok(reg.name, dims, (lim->>'dims_per_metric')::int) then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_dims"}'::jsonb, 1);
      continue;
    end if;
    if jsonb_typeof(item->'v') <> 'array' or jsonb_array_length(item->'v') > 50 then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_values"}'::jsonb, 1);
      continue;
    end if;
    for v in select value from jsonb_array_elements(item->'v') loop
      if jsonb_typeof(v) = 'number' then
        -- 10 minutes. Past that it is not a latency, it is a phone that went
        -- to sleep mid-span, and it would drag every average it touches.
        perform private.observe(reg.name, dims, least((v#>>'{}')::double precision, 600000));
      end if;
    end loop;
  end loop;

  -- ── raw records ──
  --
  -- The ceiling check uses pg_class.reltuples rather than count(*): it is an
  -- estimate maintained by autovacuum, it costs one catalog lookup instead
  -- of a scan of the biggest table here, and "roughly 400.000" is exactly
  -- the precision this decision needs.
  raw_room := least(jsonb_array_length(coalesce(payload->'r','[]'::jsonb)),
                    (lim->>'raw_per_batch')::int);
  if raw_room > 0 then
    select coalesce(c.reltuples, 0)::bigint into raw_est
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'private' and c.relname = 'telemetry_raw';
    if raw_est >= (lim->>'raw_max')::bigint then
      perform private.note('telemetry.rejected', '{"reason":"raw_full"}'::jsonb, raw_room);
      raw_room := 0;
    end if;
  end if;

  for item in select value from jsonb_array_elements(coalesce(payload->'r','[]'::jsonb)) loop
    exit when raw_room <= 0;
    if item->>'k' not in ('span','log')
       or coalesce(item->>'n','') !~ '^[a-z][a-z0-9_.]{1,60}$'
       or length(coalesce(item->'a','{}'::jsonb)::text) > (lim->>'attrs_bytes')::int then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_record"}'::jsonb, 1);
      continue;
    end if;
    tid := private.hex_id(item->>'t', 32);
    sid := private.hex_id(item->>'s', 16);
    pid := private.hex_id(item->>'p', 16);
    -- A span whose trace id did not survive validation can never join to
    -- anything and otlp_export() would drop it anyway, so it is refused here
    -- rather than stored as a row that only takes up room. Logs are allowed
    -- to stand alone: a js.error before the first span still has to be seen.
    if item->>'k' = 'span' and (tid is null or sid is null) then
      dropped := dropped + 1;
      perform private.note('telemetry.rejected', '{"reason":"bad_ids"}'::jsonb, 1);
      continue;
    end if;
    insert into private.telemetry_raw
      (kind, name, severity, trace_id, span_id, parent_id, dur_ms, attrs, sess, release)
    values
      (item->>'k', item->>'n',
       case when item->>'k' <> 'log' then null
            when jsonb_typeof(item->'sev') = 'number'
            then least(greatest((item->>'sev')::int, 0), 24) else 9 end::smallint,
       tid, sid, pid,
       case when jsonb_typeof(item->'ms') = 'number'
            then least(greatest((item->>'ms')::int, 0), 600000) else null end,
       coalesce(item->'a', '{}'::jsonb), sess, rel);
    raw_room := raw_room - 1;
  end loop;

  return case when dropped > 0 then 'partial' else 'ok' end;
end;
$$;

-- Anon may call the endpoint and nothing else. No select, no insert, no
-- read back — a client can write telemetry and can never see any.
revoke all on function public.ingest_telemetry(jsonb) from public;
grant execute on function public.ingest_telemetry(jsonb) to anon, authenticated;
revoke all on table private.telemetry_raw, private.telemetry_daily,
                   private.telemetry_metric, private.telemetry_guard
  from anon, authenticated;

-- ── OTLP export ──
--
-- Renders a window of stored telemetry as OpenTelemetry's OTLP/JSON, which
-- is what makes "point this at Grafana Cloud later" a forwarder job rather
-- than a rewrite. Nothing calls it yet; it exists so that the compact wire
-- format above is a storage decision and not a lock-in.
create or replace function private.otlp_export(since timestamptz, until timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with res as (
    select jsonb_build_object('attributes', jsonb_build_array(
      jsonb_build_object('key','service.name','value',jsonb_build_object('stringValue','voltacheck-web')),
      jsonb_build_object('key','service.namespace','value',jsonb_build_object('stringValue','voltacheck'))
    )) as r
  ),
  attrs as (
    select t.id,
           coalesce(jsonb_agg(jsonb_build_object(
             'key', a.key,
             'value', case jsonb_typeof(a.value)
                        when 'number'  then jsonb_build_object('doubleValue', a.value)
                        when 'boolean' then jsonb_build_object('boolValue', a.value)
                        else jsonb_build_object('stringValue', a.value#>>'{}')
                      end)) filter (where a.key is not null), '[]'::jsonb) as list
      from private.telemetry_raw t
      left join lateral jsonb_each(t.attrs) a on true
     where t.at >= since and t.at < until
     group by t.id
  ),
  spans as (
    select jsonb_agg(jsonb_build_object(
             'traceId', encode(t.trace_id,'hex'),
             'spanId',  encode(t.span_id,'hex'),
             'parentSpanId', coalesce(encode(t.parent_id,'hex'), ''),
             'name', t.name,
             'kind', 1,
             'startTimeUnixNano', (extract(epoch from t.at) * 1e9)::bigint::text,
             'endTimeUnixNano',
               ((extract(epoch from t.at) + coalesce(t.dur_ms,0)/1000.0) * 1e9)::bigint::text,
             'attributes', a.list)) as list
      from private.telemetry_raw t join attrs a on a.id = t.id
     where t.at >= since and t.at < until and t.kind = 'span' and t.trace_id is not null
  ),
  logs as (
    select jsonb_agg(jsonb_build_object(
             'timeUnixNano', (extract(epoch from t.at) * 1e9)::bigint::text,
             'severityNumber', coalesce(t.severity, 9),
             'body', jsonb_build_object('stringValue', t.name),
             'traceId', coalesce(encode(t.trace_id,'hex'), ''),
             'spanId',  coalesce(encode(t.span_id,'hex'), ''),
             'attributes', a.list)) as list
      from private.telemetry_raw t join attrs a on a.id = t.id
     where t.at >= since and t.at < until and t.kind = 'log'
  )
  select jsonb_build_object(
    'resourceSpans', jsonb_build_array(jsonb_build_object(
      'resource', (select r from res),
      'scopeSpans', jsonb_build_array(jsonb_build_object(
        'scope', jsonb_build_object('name','voltacheck'),
        'spans', coalesce((select list from spans), '[]'::jsonb))))),
    'resourceLogs', jsonb_build_array(jsonb_build_object(
      'resource', (select r from res),
      'scopeLogs', jsonb_build_array(jsonb_build_object(
        'scope', jsonb_build_object('name','voltacheck'),
        'logRecords', coalesce((select list from logs), '[]'::jsonb)))))
  );
$$;

-- ─────────────────────────────────────────────
-- Known gap
--
-- Report writes go through public.report_machine() and new-machine writes
-- go through public.submit_machine() — both rate-limit by device and IP;
-- see the comments above and docs/rate-limiting-plan.md for what that does
-- and does not stop. One door is still wide open, on purpose for now:
--
--   - Reads. `machines_read` and `reports_read` are both `using (true)`,
--     so anyone with the anon key can scrape the whole dataset. Nothing here
--     limits that. (`machine_submissions` is the exception — anon has no
--     read access to it at all.)
-- ─────────────────────────────────────────────
