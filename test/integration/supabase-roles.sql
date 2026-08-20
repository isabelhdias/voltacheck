-- Bootstrap roles for a bare postgres:16-alpine container.
--
-- Real Supabase projects ship with anon/authenticated/service_role and an
-- authenticator role that PostgREST connects as and switches out of per
-- request. schema.sql grants privileges to anon/authenticated and would
-- fail on stock Postgres without these existing first — Supabase itself
-- creates them when the project is provisioned, so this file is normally
-- invisible.
--
-- This is the one place in the integration suite that could drift from a
-- real Supabase project. If Supabase ever changes what a fresh project
-- provisions by default, this is the file to update.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login password 'pw' noinherit;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
