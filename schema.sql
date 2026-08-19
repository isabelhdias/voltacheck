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

create policy machines_insert on machines
  for insert with check (
    length(trim(name)) between 3 and 80
    -- Mainland, Madeira, Azores. The old check was mainland only, which would
    -- have rejected every one of the ~80 island machines.
    and (
         (lat between 36.80 and  42.25 and lng between  -9.62 and  -6.10)
      or (lat between 32.30 and  33.20 and lng between -17.35 and -16.20)
      or (lat between 36.85 and  39.90 and lng between -31.40 and -24.90)
    )
    -- Imported rows are the importer's to write, using the service key.
    -- Nobody coming in on the anon key gets to claim one or forge an id.
    and source = 'user'
    and external_id is null
  );

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
begin
  if state not in ('ok','full','down') then
    return 'invalid';
  end if;

  select m.lat, m.lng into m_lat, m_lng from public.machines m where m.id = machine;
  if not found then
    return 'unknown';
  end if;

  -- `true` makes this NULL when PostgREST is not the caller. Once the GUC has
  -- been set in a session, resetting it leaves '' rather than NULL, so strip
  -- that too or the ::json cast throws. (Found the hard way — see testing.)
  ip := coalesce(
          nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for',
          'sem-ip');
  who_ip := private.guard_hash('ip', ip);
  who    := private.guard_hash('dev', coalesce(nullif(device, ''), ip));

  -- Proximity. `acc` is the browser's own accuracy radius in metres, and it is
  -- deliberately not capped: with iOS Precise Location off the radius is
  -- 1-20 km, and capping it would reject those people while stopping nobody
  -- who is lying — a liar picks the coordinates too. Missing coordinates are
  -- accepted; blocking real reports is worse than letting a few bad ones in.
  if lat is not null and lng is not null then
    slack := greatest(coalesce(acc, 0), 0);
    if private.metres_between(lat, lng, m_lat, m_lng) > 500 + slack then
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
-- Known gap
--
-- Report writes go through public.report_machine(), which rate-limits by
-- device and IP and rejects reports too far from the machine — see the
-- comments above and docs/rate-limiting-plan.md for what that does and does
-- not stop. Two doors are still wide open, on purpose for now:
--
--   - Reads. `machines_read` and `reports_read` are both `using (true)`,
--     so anyone with the anon key can scrape the whole dataset. Nothing here
--     limits that.
--   - `machines_insert`. Anyone can still add junk machines — it is bounded
--     to Portuguese coordinates and a sane name, but not rate-limited at all.
--     Worth doing the same way as reports, next.
-- ─────────────────────────────────────────────
