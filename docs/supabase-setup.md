# Setting up Supabase

Everything in the app is built and tested; this is the part only you can do.
Until it is done the site runs in local mode — which works, and shows all 2.444
machines, but reports stay on each person's own device and nobody sees anyone
else's.

You can do all of this from a phone. There is no CLI, no terminal, and nothing
to install anywhere.

Rough order, about twenty minutes:

1. Create the project
2. Run `schema.sql`
3. Load the machines
4. Copy the two values into `index.html`
5. Check it went live
6. One small thing to look up afterwards
7. Set up the Migrate workflow, so future migrations aren't manual again

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

The very first time, before the automated workflow below has anything to talk
to, do this by hand:

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

Two ways. The first is easier on a phone.

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

**After this first time, don't do steps 2 and 3 by hand again — use the
Migrate workflow below instead.** It runs both files together and cannot
leave you in the half-applied state these two steps can.

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

## 7. Set up the Migrate workflow, so future migrations aren't manual again

Steps 2 and 3 above are how you get the database going the very first time.
After that, don't repeat them by hand — this is what caused the one real
incident so far: `schema.sql` got pasted and run, `seed/machines.sql` didn't,
and the site quietly shipped with every machine's chain blank. Nobody noticed
until the filter chips under the search box showed only two chains instead of
the real list.

There's a GitHub Actions workflow, `Migrate`, that applies both files together
as one database transaction. Either both go in, or — if anything about either
file is wrong — neither does. That specific failure can't happen through this
workflow.

**One-time setup, from your phone:**

1. In Supabase: **Connect** button (top of the project) → **Session pooler**
   tab. Copy the connection string shown there and swap in your database
   password (the one you saved when creating the project) where it says
   `[YOUR-PASSWORD]`.

   > **Copy it verbatim. Don't retype it, and don't build it from an example
   > you saw somewhere — including one someone hands you in a chat.** The
   > hostname contains two things that cannot be guessed or reasoned about:
   > the region, and a generation prefix (`aws-0-` or `aws-1-`) that depends
   > on when the project was created. Both look plausible whichever value they
   > have, and getting either wrong produces an error that reads like a
   > credentials problem but isn't. The password is the only part you should
   > ever be editing.

   **This has to be the Session pooler string, not the other two Supabase
   offers.** The three look similar but only one works here:
   - **Direct connection** — fails. It only accepts IPv6 by default, and the
     computer that runs this workflow (a GitHub Actions runner) only speaks
     IPv4. It doesn't fail loudly — it just hangs and times out, which looks
     like nothing at all.
   - **Transaction pooler** (port `6543`) — also wrong, for a quieter reason.
     It doesn't support the kind of multi-statement, single-transaction run
     this migration needs, so schema changes behave unpredictably through it.
   - **Session pooler** (port `5432`) — the right one. Works over IPv4, and
     behaves like a normal database connection for this kind of migration.

2. In the GitHub repo: **Settings** → **Secrets and variables** → **Actions**
   → **New repository secret**.
   - Name: `SUPABASE_DB_URL`
   - Value: the Session pooler string from step 1, password filled in.
   - Save.

   This secret is never shown in logs and never appears in the repo. Only the
   workflow can read it.

That's it — one secret, set once. You won't need to touch it again unless the
database password changes.

**Running a migration, from your phone, any time after that:**

1. GitHub app (or github.com in Safari) → this repo → **Actions** tab.
2. Tap **Migrate** in the left list of workflows.
3. Tap **Run workflow** → **Run workflow** again to confirm.
4. Wait for the green check (a minute or two — it stands up a throwaway test
   database first and applies the real migration to it, to catch a broken
   file before it ever touches production).
5. Tap into the run → the **Summary** page shows a short readable report:
   machine count before and after, whether any OSM machine is missing its
   chain, and either "migration applied" or exactly what failed. If it
   failed, nothing partial was left behind — the transaction means production
   is exactly as it was before you tapped the button.

Hand-pasting `schema.sql` and `seed/machines.sql` into the SQL Editor (steps 2
and 3 above) still exists as a fallback — for the very first setup, before the
secret exists, or if GitHub Actions itself is ever down. Day to day, the
Migrate workflow is the normal way to apply a database change.

### If Migrate fails with "tenant/user ... not found"

If the run fails with something like:

```
FATAL:  (ENOTFOUND) tenant/user postgres.ydtegeetihlhqwjefhyv not found
```

that is **not** a wrong password, and the project isn't broken. It means the
`SUPABASE_DB_URL` secret has the right project ref but the wrong pooler
*host*. Two separate things in that hostname can be wrong, and the error is
identical either way:

- **The region.** A project's login only exists on the pooler for the region
  it was created in.
- **The generation prefix — `aws-0-` vs `aws-1-`.** Supabase runs more than
  one pooler per region and puts newer projects on `aws-1-`. Both hostnames
  resolve, so this looks completely fine and fails anyway.

The second one is the easier trap, because the region is something you can
look up and check while the prefix is not. It is what actually happened here:
the region (`eu-west-1`, West EU Ireland) was correct all along, and the
secret had been built from an example that said `aws-0-`. Changing that single
character to `aws-1-` fixed it.

Don't go hunting for the connection string again — there's a workflow for
this. **Actions** tab → **Diagnose DB connection** → **Run workflow**. It
tries your same username and password against every Supabase pooler region in
turn and tells you which one answers. When it finds it, open the run's
**Summary** page: it has the corrected connection string ready to copy, with
only the password blanked out for you to fill back in. Paste that into the
`SUPABASE_DB_URL` secret (same steps as setting it the first time, above) and
re-run Migrate.

It never prints your password or the full secret anywhere, in the log or the
summary — only region names, whether each one matched, and the corrected
string with the password replaced by `[YOUR-PASSWORD]`.

## Once it is live

The app becomes genuinely shared, which changes one thing worth knowing: the
rate limiting is now load-bearing, and it is a speed bump rather than a wall.
`docs/rate-limiting-plan.md` has an honest account of what it does and does not
stop. Worth reading before the link goes anywhere public.

## Reviewing machine submissions

When someone adds a machine that isn't on the map yet, it doesn't go straight
into `machines` — it lands in `machine_submissions` with `status = 'pending'`
and waits for you to look at it. Here's the whole loop, end to end.

1. **Someone submits a machine.** The app writes a row to
   `machine_submissions`, along with anything useful for judging it: how far
   they were from the spot, the nearest machine already on the map and how
   close it is, and whether that closeness makes it look like a duplicate.

2. **A GitHub Action notices and opens an issue.** The `Review queue`
   workflow runs a few times a day (and any time you run it by hand from the
   **Actions** tab) and checks for pending submissions. If there are any, it
   opens or updates a single GitHub issue titled with the count — something
   like **"3 máquinas para rever"** — labelled `review-queue`. You'll get
   that as a normal GitHub notification on your phone, the same way you get
   everything else. If nothing is pending, it closes that issue and stays
   silent — you should only ever hear from it when there's something to do.

3. **You judge it from the issue.** No need to open Supabase first — the
   issue lists each pending machine with its name, chain and town, the note
   whoever submitted it left, how far the nearest existing machine is (with
   its name), and a tappable link to a satellite view of the spot. Rows that
   look like duplicates (under 75 m from something already mapped) are
   marked with **⚠** and sorted to the top, then the rest oldest first.

4. **You approve or reject in the Table Editor.** Open Supabase, **Table
   Editor** → `machine_submissions`, find the row, and change `status` from
   `pending` to `approved` or `rejected`. That's the only field you touch.

5. **A trigger does the rest.** Approving a row fires a database trigger
   that copies it into `machines`, so it shows up on the map without you
   doing anything else. Rejecting one just leaves it marked `rejected` —
   nothing is copied, nothing shows up.

Once you've dealt with everything in the issue, the next scheduled run (or a
manual **Run workflow** if you don't want to wait) sees the queue is empty
and closes it on its own — you don't need to close it yourself.
