# Setting up Supabase

Everything in the app is built and tested; this is the part only you can do.
Until it is done the site runs in local mode — which works, and shows all 2.444
machines, but reports stay on each person's own device and nobody sees anyone
else's.

You can do all of this from an iPad. There is no CLI, no terminal, and nothing
to install anywhere.

Rough order, about twenty minutes:

1. Create the project
2. Run `schema.sql`
3. Load the machines
4. Copy the two values into `index.html`
5. Check it went live
6. One small thing to look up afterwards

---

## 1. Create the project

<https://supabase.com> → sign in → **New project**.

- **Name** anything — `voltacheck` is fine.
- **Database password** — generate one, save it in your password manager. You
  will almost certainly never need it (the dashboard logs you in on its own),
  but it cannot be recovered later, only reset.
- **Region** — pick a European one, London or Frankfurt. Portugal is a long way
  from Virginia and every report pays the round trip. **The region cannot be
  changed after the project is created**, so this is the one choice here worth
  slowing down for.

The free tier is far more than this needs. Free projects pause after a week of
no traffic and wake on the next request, so if the map is slow after a quiet
week, that is what it is.

Wait for it to finish provisioning — a couple of minutes.

## 2. Run `schema.sql`

Open [`schema.sql`](../schema.sql) on GitHub, tap **Raw**, select all, copy.

In Supabase: **SQL Editor** (left sidebar) → new query → paste → **Run**.

You should see `Success. No rows returned`, possibly with some `NOTICE` lines
about things not existing — those are expected on a fresh database and are not
errors.

This creates both tables, the row-level security policies, and the report guard
that does the rate limiting. It is safe to run again at any time; every
statement is written to be repeatable, and re-running does **not** reset the
rate-limiting salt.

## 3. Load the machines

Two ways. The first is easier on an iPad.

**CSV (recommended).** Open [`seed/machines.csv`](../seed/machines.csv) on
GitHub, tap **Raw**, then share/download it to your Files app.

In Supabase: **Table Editor** → select the `machines` table → **Insert** →
**Import data from CSV** → choose the file. The column names in the file
already match the table, so nothing needs mapping.

**SQL (alternative).** Open [`seed/machines.sql`](../seed/machines.sql) raw,
copy the lot, paste into the SQL Editor, Run. It is about 240 KB of text, which
Safari can be sluggish about, but it works.

Then check it took: **Table Editor** → `machines` should say **2444 rows**.

> **One trap.** The CSV route does plain inserts. If you import the same CSV
> twice you will get a unique-constraint error on `external_id`, because every
> machine is already there. That is the constraint doing its job — nothing is
> broken. To *refresh* the data later, use `seed/machines.sql` instead: it
> upserts, so it updates rows rather than duplicating them, and it leaves
> machines people added through the app alone.

## 4. Copy the two values into `index.html`

In Supabase: **Project Settings** → **API Keys** (some dashboards still call
this page **API**, and the **Connect** button at the top also shows both
values).

You need two things:

- **Project URL** — looks like `https://abcdefghijkl.supabase.co`
- **The public key** — labelled either `anon` `public`, or, on newer projects,
  a **publishable key** starting `sb_publishable_`. Supabase is part-way
  through renaming these and is retiring the `anon` name; whichever your
  project shows, take the public one. Either works here.

> **Take the public key, never the other one.** The same page carries a
> `service_role` (or `sb_secret_`) key. That one bypasses every security rule
> in the database. It must never go into `index.html`, never be committed, and
> never be pasted into a chat — this repo is public and deploys straight to the
> web. The public key is *designed* to be published; that is why the security
> lives in the database's row-level security rules instead of in the key.

Now edit `index.html` on GitHub — pencil icon, or the `.dev` editor — and fill
in the CONFIG block near the top of the script (around line 221):

```js
  var SUPABASE_URL      = "https://abcdefghijkl.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOi…";
```

Commit to `main`. GitHub Pages redeploys in a minute or two.

## 5. Check it went live

Open <https://isabelhdias.github.io/voltacheck/> and hard-refresh.

The badge next to the title should read **em direto** in green instead of
**modo local**. Report a machine, then open the site on a different device: the
report should be there too. That is the whole point of the exercise.

If it still says **modo local**, the app could not reach the database and fell
back — which is the fallback working as designed, not a crash. Check the URL
and key for a stray space or a missing character.

## 6. Afterwards: check what the IP header looks like

The rate limiter identifies people partly by IP, read from the
`x-forwarded-for` header. We could not confirm the exact shape of that header
without a live project, so it currently hashes the whole string. That is safe,
but if the header turns out to be a chain like `real.ip, 10.0.0.1`, the limiter
could be made sharper.

Takes about thirty seconds. SQL Editor:

```sql
create or replace function public.debug_headers() returns json
language sql stable as $$ select current_setting('request.headers', true)::json $$;
grant execute on function public.debug_headers() to anon;
```

Then on the live site, open the browser console and run:

```js
await supabase.rpc('debug_headers')
```

Look at the `x-forwarded-for` value and note whether it is one address or a
comma-separated list. Then remove it:

```sql
drop function public.debug_headers();
```

Don't leave it installed. It is harmless — it only hands callers their own
headers back — but there is no reason for it to stay.

## Things you do not need to do

- **Don't touch Max Rows** in Project Settings → API. It defaults to 1000,
  which is less than our 2.444 machines, but the app pages through the results
  in blocks, so it already handles this correctly. Raising it is not needed.
- **Don't create a service key for the importer.** `tools/import_osm.py` only
  reads from OpenStreetMap and writes files to the repo. It never touches the
  database, so it needs no credentials at all.
- **Don't enable any extensions.** No PostGIS, no pgcrypto — everything used is
  core Postgres.

## If something goes wrong

Nothing here is destructive and everything is repeatable. `schema.sql` can be
re-run safely. If the machines table ends up in a mess, the fastest recovery is:

```sql
delete from machines where source = 'osm';
```

then load the CSV again. That deliberately leaves `source = 'user'` machines —
anything people added through the app — untouched.

## Once it is live

The app becomes genuinely shared, which changes one thing worth knowing: the
rate limiting is now load-bearing, and it is a speed bump rather than a wall.
`docs/rate-limiting-plan.md` has an honest account of what it does and does not
stop. Worth reading before the link goes anywhere public.
