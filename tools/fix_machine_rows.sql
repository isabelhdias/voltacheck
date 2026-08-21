-- One-off data corrections. Deleted from the repo once run.
--
-- Every statement names the row by its uuid rather than by name or
-- position, so re-running it cannot touch a row that happens to be called
-- something similar later. Each is also a no-op the second time: the update
-- sets a value it already holds, and the deletes match nothing once gone.

\echo '--- before ---'
select id, name, town, source from public.machines where source = 'user' order by name;

-- 1. The concelho this whole change was about. Submitted as "Auchan -
--    Pampilhosa da Serra" and filed under Góis, because the old
--    submit_machine() copied the concelho from the nearest machine — 18.8 km
--    away, in Góis. The machine is in Pampilhosa da Serra; the name says so
--    and the coordinates (40.0419, -7.9486) are inside that concelho.
--    Without this it never shows up in a search for the town it is in.
update public.machines
   set town = 'Pampilhosa da Serra'
 where id = '55099dc8-075d-4ae6-874b-7a0e6a98be57';

\echo '--- after ---'
select id, name, town, source from public.machines where source = 'user' order by name;
