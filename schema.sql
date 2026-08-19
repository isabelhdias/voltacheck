-- Cêntimo / VoltaCheck — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.

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
-- Anyone may read. Anyone may add a machine or a report, but only
-- within Portugal's bounding box and with a sane name. This is the
-- floor, not real abuse protection — see the note at the bottom.
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
    and lat between 36.8 and 42.2      -- mainland PT
    and lng between -9.6 and -6.1
  );

create policy reports_read on reports
  for select using (true);

create policy reports_insert on reports
  for insert with check (true);

-- ─────────────────────────────────────────────
-- Seed data — placeholder machines, replace with the real locator
-- ─────────────────────────────────────────────

insert into machines (name, lat, lng) values
  ('Continente Bom Dia — Alvalade',    38.7530, -9.1400),
  ('Pingo Doce — Areeiro',             38.7423, -9.1330),
  ('Lidl — Av. de Roma',               38.7487, -9.1329),
  ('Auchan — Alfragide',               38.7360, -9.2160),
  ('Minipreço — Anjos',                38.7248, -9.1355),
  ('Continente — Colombo',             38.7540, -9.1880),
  ('Pingo Doce — Cais do Sodré',       38.7060, -9.1450),
  ('Intermarché — Graça',              38.7195, -9.1300),
  ('Lidl — Benfica',                   38.7510, -9.2010),
  ('Continente — Parque das Nações',   38.7680, -9.0960)
on conflict do nothing;

-- ─────────────────────────────────────────────
-- Known gap
--
-- `reports_insert` currently accepts anything. A determined person could
-- flood it. Postgres RLS can't rate-limit on its own — that needs an Edge
-- Function checking IP or device hash before the insert. Fine to leave open
-- while the userbase is a few dozen people; close it before you promote it
-- anywhere public.
-- ─────────────────────────────────────────────
