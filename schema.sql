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
  -- How far from the machine a report is still treated as an observation of
  -- it. A judgement call, not a finding — see docs/rate-limiting-plan.md.
  radius constant double precision := 5000;
begin
  if state not in ('ok','full','down') then
    return 'invalid';
  end if;

  select m.lat, m.lng into m_lat, m_lng from public.machines m where m.id = machine;
  if not found then
    return 'unknown';
  end if;

  ip := private.client_ip();
  who_ip := private.guard_hash('ip', ip);
  who    := private.guard_hash('dev', coalesce(nullif(device, ''), ip));

  -- Proximity, 5 km (was 2 km). The point of this check was never to prove
  -- someone is standing at the machine — it's to accept a fresh
  -- *observation*: someone who just left the shop, reporting from the car
  -- park or a few minutes down the road on foot or by car, while still
  -- rejecting a report from across the region, which isn't an observation of
  -- this machine at all. 5 km is still comfortably inside "the errand I am
  -- on"; it is a different town only in the densest bits of Lisbon and
  -- Porto, where the machine you actually used is the one you tapped.
  -- `acc` is the browser's own accuracy radius in metres, and it is
  -- deliberately not capped: with iOS Precise Location off the radius is
  -- 1-20 km, and capping it would reject those people while stopping nobody
  -- who is lying — a liar picks the coordinates too. Missing coordinates are
  -- accepted; blocking real reports is worse than letting a few bad ones in.
  -- And because this whole check fails open, it only ever constrains someone
  -- who shares their real location in the first place — being generous here
  -- costs nothing against anyone actually determined to lie.
  if lat is not null and lng is not null then
    slack := greatest(coalesce(acc, 0), 0);
    if private.metres_between(lat, lng, m_lat, m_lng) > radius + slack then
      return 'far';
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
  if n > 0 then return 'cooldown'; end if;

  select count(*) into n from private.report_guard g
   where g.ident = who and g.created_at > now() - interval '1 hour';
  if n >= 20 then return 'flood'; end if;

  select count(*) into n from private.report_guard g
   where g.ident = who and g.created_at > now() - interval '24 hours';
  if n >= 60 then return 'flood'; end if;

  -- Backstop for someone rotating device ids. Loose on purpose: Portuguese
  -- mobile networks put a lot of people behind one address.
  select count(*) into n from private.report_guard g
   where g.ip_ident = who_ip and g.created_at > now() - interval '1 hour';
  if n >= 300 then return 'flood'; end if;

  insert into public.reports (machine_id, status) values (machine, state);
  insert into private.report_guard (ident, ip_ident, machine_id) values (who, who_ip, machine);
  return 'ok';
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
    return 'invalid';
  end if;
  -- 140 chars — a short line ("ao lado da entrada"), not a place for a
  -- review essay. Room for review notes lives in the dashboard, not here.
  if v_note is not null and length(v_note) > 140 then
    return 'invalid';
  end if;
  if v_town is not null and length(v_town) > 60 then
    return 'invalid';
  end if;
  if v_address is not null and length(v_address) > 120 then
    return 'invalid';
  end if;
  if lat is null or lng is null then
    return 'invalid';
  end if;
  -- Same bounding boxes machines_insert used to check: mainland, Madeira,
  -- Azores.
  if not (
       (lat between 36.80 and  42.25 and lng between  -9.62 and  -6.10)
    or (lat between 32.30 and  33.20 and lng between -17.35 and -16.20)
    or (lat between 36.85 and  39.90 and lng between -31.40 and -24.90)
  ) then
    return 'invalid';
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
  if n > 0 then return 'cooldown'; end if;

  -- Submissions are for brand-new machines, and the country is already
  -- 2,400+ deep — a genuine person adds a handful of new ones in their
  -- lifetime, not per hour. Deliberately tighter than report_machine()'s
  -- 20/hour and 60/day: 5/hour and 15/day per device.
  select count(*) into n from private.submission_guard g
   where g.ident = who and g.created_at > now() - interval '1 hour';
  if n >= 5 then return 'flood'; end if;

  select count(*) into n from private.submission_guard g
   where g.ident = who and g.created_at > now() - interval '24 hours';
  if n >= 15 then return 'flood'; end if;

  -- IP backstop for someone rotating device ids, same reasoning as
  -- report_machine()'s: shared addresses (CGNAT, a shop's wifi) shouldn't
  -- lock out unrelated people. Looser than the device caps above, but
  -- tighter than report_machine()'s 300/hour, because submissions are
  -- rarer to begin with: 40/hour per IP.
  select count(*) into n from private.submission_guard g
   where g.ip_ident = who_ip and g.created_at > now() - interval '1 hour';
  if n >= 40 then return 'flood'; end if;

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

  -- 2 km, and deliberately not tied to report_machine()'s radius, which is
  -- now 5 km: that one answers "did this person plausibly just see the
  -- machine?", this one answers "are these two machines in the same
  -- concelho?" — and inside 2 km they almost always are, while 5 km crosses
  -- a boundary often enough to reintroduce the wrong-concelho bug this
  -- fallback was narrowed to avoid. Matches suggestTown()'s default in
  -- app/domain.js, which prefills the same field client-side.
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

  return 'ok';
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
