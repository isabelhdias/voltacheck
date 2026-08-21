-- One-off data corrections. Deleted from the repo once run.
--
-- Every statement names the row by its uuid rather than by name or
-- position, so re-running it cannot touch a row that happens to be called
-- something similar later. Each is also a no-op the second time: updates
-- set a value the row already holds, and the delete matches nothing once
-- the row is gone.

\echo '--- before ---'
select id, name, town, source from public.machines where source = 'user' order by name;

-- 1. Already applied in the first run, kept so this file describes the full
--    end state rather than a diff. Submitted as "Auchan - Pampilhosa da
--    Serra" and filed under Góis, because the old submit_machine() copied
--    the concelho from the nearest machine — 18.8 km away, in Góis.
update public.machines
   set town = 'Pampilhosa da Serra'
 where id = '55099dc8-075d-4ae6-874b-7a0e6a98be57';

-- 2. "Teste" sits at 37.5363, -7.4494 — inside Spain, east of the Guadiana.
--    It is outside all three bounding boxes submit_machine() accepts, so it
--    could not be submitted today; it predates that check. Nothing real is
--    lost, and with insert revoked from anon nothing can recreate it.
delete from public.machines
 where id = '99c90652-398f-4b63-8332-b51a5bb64d9b';

-- 3. "Continente" at 38.6124, -9.1911 keeps its row but gains a concelho,
--    so it can be found by searching for the town it is in. Almada is not a
--    guess: the four nearest machines are all Almada, the closest 510 m
--    away — comfortably inside the 2 km radius the new submit_machine()
--    treats as close enough to borrow a concelho from.
--
--    Worth knowing when it next comes up: "Continente Bom Dia Charneca da
--    Caparica" is 980 m away, so this row may well be a duplicate of it.
--    Not deleted — that is a judgement about real data, not cleanup.
update public.machines
   set town = 'Almada'
 where id = '9df9d892-102a-41a9-94f5-97dad75da88c';

\echo '--- after ---'
select id, name, town, source from public.machines where source = 'user' order by name;
