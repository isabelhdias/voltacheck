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
drop policy if exists reports_insert  on reports;

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

create policy reports_insert on reports
  for insert with check (true);

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
-- Known gap
--
-- `reports_insert` currently accepts anything. A determined person could
-- flood it. Postgres RLS can't rate-limit on its own — that needs an Edge
-- Function checking IP or device hash before the insert, plus a proximity
-- check so a machine can only be reported from nearby. Fine to leave open
-- while the userbase is a few dozen people; close it before you promote it
-- anywhere public.
-- ─────────────────────────────────────────────
