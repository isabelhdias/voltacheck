# Rate limiting and proximity on reports

Roadmap item 2. `reports_insert` is `with check (true)`: anyone with the anon
key — which is in the page source, by design — can insert unlimited rows.

## Recommendation

**Do it in plain SQL, not an Edge Function.** Move report writing behind one
`security definer` Postgres function, `report_machine(...)`, exposed as a
PostgREST RPC; revoke `insert` on `reports` from `anon`. The function reads the
caller's IP from `current_setting('request.headers', true)`, hashes it together
with a device id the client keeps in localStorage and a salt that only the
database knows, counts recent accepted reports in a table in a `private` schema
that the API cannot see, and checks the reporter's coordinates against the
machine's with haversine in SQL. It installs by pasting into the Supabase SQL
editor, exactly like `schema.sql` — no CLI, no Deno, no new runtime, no
extension, nothing to keep in sync outside the repo. The client change is about
forty lines in `index.html`. Everything below was executed against Postgres 16
before being written down.

Edge Functions *can* now be deployed from the dashboard, so the iPad
constraint alone does not rule them out — but they buy nothing here, and cost
a second deploy surface that GitHub Pages does not carry. See below.

## Rejected alternatives

**A Supabase Edge Function.** The old note in `schema.sql` and
`docs/seed-data-plan.md` assumed this was required. Two things about that:

- It is no longer true that you need the CLI. Supabase ships an in-dashboard
  editor — Edge Functions → *Deploy a new function* → *Via Editor*, write Deno
  in the browser, *Deploy function*, live in 10–30 s
  ([docs](https://supabase.com/docs/guides/functions/quickstart-dashboard)).
  So Isabel *could* run one from an iPad.
- It is still the wrong tool. The docs for that same editor say plainly there
  is "no version control for edits" and recommend it "only for quick testing
  and prototypes". That means the function body would live only inside the
  Supabase dashboard — not in this repo, not reviewable on a phone, not
  deployed by pushing to `main`. For a project whose whole shape is "one file,
  no build step, deploy by commit", adding an untracked second deploy target is
  a worse trade than any code it saves. And it saves nothing: an Edge Function
  would still have to reach into Postgres to count anything, and it reads the
  same spoofable `x-forwarded-for` header the database can read directly.

**A PostgREST pre-request hook.** Supabase documents exactly this —
`alter role authenticator set pgrst.db_pre_request = 'public.check_request'`
with an IP counter in a `private.rate_limits` table
([docs](https://supabase.com/docs/guides/api/securing-your-api)). It is good
prior art and proves the pure-SQL route is supported, not a hack. Rejected as
the primary mechanism because it is global (it fires on every write to every
table, and on `notify pgrst, 'reload config'` timing) and it cannot see the
request body, so it cannot do the proximity check. Worth revisiting later as a
blunt backstop if the reports guard alone proves insufficient.

**PostGIS.** Enabling it is one dashboard click (Database → Extensions →
search `postgis`), so it is available — but unnecessary. One machine, one
point, one distance: eleven lines of haversine in `language sql` is exact
enough at street scale and adds no dependency. Verified below.

**A BEFORE INSERT trigger on `reports` instead of an RPC.** Works, and keeps
the client's `.insert()` call unchanged, but the reporter's coordinates would
have to arrive as columns on `reports` — a table where `reports_read` is
`using (true)`. Even if the trigger nulls them out again, the columns exist and
one future edit forgets to. The RPC takes them as arguments that are never
stored anywhere. Least data wins.

**Storing a device hash or coordinates on `reports`.** No. `reports_read` is
`using (true)` and the anon key is public, so anything on that table is a
world-readable feed. `select ip_hash, created_at from reports` would let anyone
reconstruct who was where and when. All identity data goes in `private`, which
is not in the Data API's exposed-schemas list (only `public` is, by default),
and `anon` has no `usage` on it. Confirmed by test: `anon` gets *permission
denied for schema private*.

## The SQL

Append to `schema.sql`, after the policies. Safe to re-run: the salt is created
once with `on conflict do nothing`, so re-running does not rotate it and
invalidate every counter.

```sql
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
```

The existing `create policy reports_insert on reports for insert with check (true)`
higher up in `schema.sql` should be deleted at the same time, not just dropped
at the bottom — otherwise re-running the file recreates it and the drop
silently depends on statement order.

### How it was tested

Postgres 16.13, locally, with an `anon` role and PostgREST's request GUC
simulated by `set_config('request.headers', '{"x-forwarded-for":"…"}', true)`
inside a transaction that first does `set local role anon` — which is what
PostgREST actually does per request (the settings are transaction-scoped,
[PostgREST docs](https://docs.postgrest.org/en/v12/references/transactions.html)).

Verified:

| case | result |
| --- | --- |
| header read back from `request.headers` | `85.240.10.7` |
| `request.headers` never set | NULL, handled, `ok` |
| `request.headers` reset to `''` after a prior set | handled, `ok` (this crashed the first draft) |
| 40 m from the machine, accuracy 20 | `ok` |
| 60 m indoor drift, accuracy 65 | `ok` |
| same machine, same device, again | `cooldown` |
| same machine, same device, 11 min later | `ok` |
| Braga machine reported from Lisbon | `far` |
| 5 km out with a precise fix (accuracy 25) | `far` |
| 5 km out with an iOS approximate fix (accuracy 5000) | `ok` |
| no coordinates at all | `ok` |
| 20 reports from one device in the last hour | `flood` |
| those same 20 aged past the hour | `ok` |
| 60 from one device in 24 h | `flood` |
| 300 on one IP in an hour, fresh device id | `flood` |
| 300 on one IP, different IP | `ok` |
| unknown machine id / bad status string | `unknown` / `invalid` |
| `anon` doing `insert into reports` directly | *permission denied for table reports* |
| `anon` doing `select from private.report_guard` | *permission denied for schema private* |
| running the whole block twice | salt unchanged, all cases still pass |

Distance maths checked against known pairs: Lisbon–Porto 271 994 m,
Funchal–Ponta Delgada 975 965 m, 0.0045° of latitude exactly 500 m.

Two real bugs were caught this way and are already fixed above:
`pg_catalog.coalesce` does not exist (`coalesce` and `nullif` are SQL
constructs, not catalog functions — they resolve fine unqualified even with
`search_path = ''`), and the empty-string GUC case throws on the `::json` cast.

**Not verified:** the exact shape of `x-forwarded-for` on a live Supabase
project — whether it is one address or a comma-separated chain, and whether the
last element is the real client or an internal hop. There is no Supabase
project to test against yet. This is why the code hashes the *whole* header
string rather than `split_part(…, ',', 1)`, and why the IP limit is only a
backstop. See "Still needs Isabel".

## Client-side changes in `index.html`

No new dependency. `crypto.randomUUID` / `crypto.getRandomValues` and
`navigator.geolocation` are built in. Nothing about the styling changes.

**1. Device id.** Near the storage helpers (around `var KEY = "centimo.v2";`,
line 228, and the `localLoad`/`localSave` block at line ~2700):

```js
var DID_KEY = "centimo.did";

function deviceId(){
  var v = null;
  try { v = localStorage.getItem(DID_KEY); } catch(e){ return null; }
  if(!v){
    if(window.crypto && crypto.randomUUID){
      v = crypto.randomUUID();
    } else if(window.crypto && crypto.getRandomValues){
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      v = Array.prototype.map.call(a, function(b){ return (b + 256).toString(16).slice(1); }).join("");
    } else {
      v = String(Date.now()) + String(Math.random()).slice(2);
    }
    try { localStorage.setItem(DID_KEY, v); } catch(e){}
  }
  return v;
}
```

Private browsing throws on `localStorage`; returning `null` is fine — the
function falls back to the IP hash for identity.

**2. A cached location fix.** New helper, used only when `live`:

```js
var fix = null, FIX_TTL = 2 * 60 * 1000;

function getFix(){
  return new Promise(function(resolve){
    if(fix && Date.now() - fix.at < FIX_TTL){ resolve(fix); return; }
    if(!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      function(p){
        fix = { lat:p.coords.latitude, lng:p.coords.longitude,
                acc:p.coords.accuracy, at:Date.now() };
        resolve(fix);
      },
      function(){ resolve(null); },
      { enableHighAccuracy:true, timeout:6000, maximumAge:60000 }
    );
  });
}
```

It never rejects. Denied permission, a timeout, or no geolocation API all
resolve `null`, and `null` is accepted server-side.

**3. `pushReport` (line 2790).** It currently returns a boolean; make it return
the status string so the caller can say something useful:

```js
async function pushReport(machineId, status){
  if(!live) return "ok";                    // local mode: unchanged, and no geolocation prompt
  var f = await getFix();
  var res = await db.rpc("report_machine", {
    machine: machineId,
    state:   status,
    lat:     f ? f.lat : null,
    lng:     f ? f.lng : null,
    acc:     f ? f.acc : null,
    device:  deviceId()
  });
  if(res.error) return "erro";
  return res.data || "erro";
}
```

The `if(!live) return` on the first line is what keeps local mode working and
stops it ever asking for location — the geolocation call sits below it.

**4. The `.choice` handler (line 2958).** `var ok = await pushReport(...)`
becomes a string, and the branch grows a switch. The important part: **only
`"ok"` appends to `m.reports`.** Everything else must leave the machine's
history alone — a rejected report must not turn a grey pin green, and must not
reset the 18 h clock.

```js
var r = await pushReport(m.id, btn.dataset.s);

if(r === "ok"){
  m.reports = (m.reports || []).concat([{ s: btn.dataset.s, at: Date.now() }]);
  localSave();
  select(m.id);
  toast(live ? "Obrigado — toda a gente vê isto agora" : "Guardado neste dispositivo");
} else if(r === "cooldown"){
  toast("Já reportaste esta máquina há pouco. Volta daqui a uns minutos.");
} else if(r === "far"){
  toast("Só dá para reportar quando estás junto à máquina.");
} else if(r === "flood"){
  toast("Muitos reports deste telemóvel hoje. Tenta mais logo.");
} else if(r === "unknown"){
  toast("Esta máquina já não existe. Recarrega a página.");
} else {
  toast("Não consegui guardar. Tenta outra vez.");
}
```

Register matches what is already there ("Não consegui obter a localização",
"Dá-lhe um nome para as pessoas a encontrarem") — second person singular, no
"por favor", no exclamation marks.

**5. Waiting for the fix.** The buttons are disabled across the `await`, and
the first geolocation call can take the full 6 s. Show something:
`toast("A confirmar que estás junto à máquina…")` immediately before the
`await`, only when `live`. Optionally warm the fix when the sheet opens, but
*only* if permission is already granted, so opening a sheet never triggers the
browser prompt:

```js
if(live && navigator.permissions){
  navigator.permissions.query({ name:"geolocation" })
    .then(function(s){ if(s.state === "granted") getFix(); })
    .catch(function(){});
}
```

**6. Nothing else moves.** `STALE_AFTER`, the 3 h prompt threshold in `select()`
(line 2928), `statusOf`, `pull`, and `localSave` are untouched. The 10 min
cooldown is two orders of magnitude below the 3 h reconfirmation prompt, so
"Ainda está assim?" is never met with a rejection.

## What this does not stop

Be honest about this when describing it to anyone.

- **Coordinates are client-supplied.** The reporter's browser sends `lat`,
  `lng` and `acc`, and anyone with the anon key can send whatever they like.
  Every machine's real coordinates are in `machines`, readable by everybody.
  Forging a nearby position is one line of JavaScript. The proximity check is a
  **speed bump**: it stops accidental misreports (wrong pin tapped from home,
  a stale sheet open in a background tab) and it stops a naive script that
  iterates the machine list without bothering to spoof. It is not a control.
- **The device id is client-supplied and regenerable.** Clearing site data,
  private browsing, or a one-line change produces a fresh identity. Also a
  speed bump — a good one against ordinary spam, useless against anyone
  determined.
- **`x-forwarded-for` can be spoofed.** A client can set the header; Supabase's
  proxy appends the real address rather than replacing the value, so the
  header becomes `spoofed, real`
  ([discussion](https://github.com/orgs/supabase/discussions/34647)). Hashing
  the whole string means a spoofer who varies the header gets a fresh identity
  every request, so the IP backstop is evaded by anyone who reads this file.
  It is still the *hardest* of the three to forge accidentally, and it costs
  a real attacker nothing but is the thing that actually catches
  "someone left a loop running".
- **Shared addresses cut the other way.** CGNAT on Portuguese mobile networks
  and one supermarket's public wifi put many genuine people behind one address.
  That is why the IP limit is 300/hour and not 20 — a tight IP limit would lock
  out real reporters at exactly the moment a machine gets busy.
- **Rejected attempts are free.** The counter row is written in the same
  transaction as the report, so a rejection rolls it back. Someone hammering a
  rejected endpoint stays rejected but is never escalated or locked out. Making
  rejections stick would need an autonomous transaction (`pg_net`, `dblink`) —
  not worth the complexity here.
- **Reads are still wide open.** `reports_read` and `machines_read` are
  `using (true)`. Nothing here limits scraping, and nothing here rate-limits
  `machines_insert` — someone can still add junk machines. Worth doing next,
  the same way.
- **What it does stop, plainly:** one person accidentally or casually spamming
  the same machine, a bored person tapping every pin in the country, and any
  volume of writes that would actually cost money or make the map useless. For
  a community map of ~2 400 machines that is the realistic threat, and this is
  proportionate to it.

## Still needs Isabel

1. **Paste the SQL block into Supabase → SQL Editor → Run** once the project
   exists. It is idempotent and safe alongside a re-run of `schema.sql`.
2. **Order of deployment.** The SQL revokes `insert` on `reports`, which breaks
   any browser still running the old cached `index.html`. Either push the
   `index.html` change first and run the SQL a few minutes later, or accept a
   short window — with a userbase of a few dozen this does not matter, but it
   does once the link is public.
3. **Check what `x-forwarded-for` actually contains.** This could not be
   verified without a live project. Install this temporarily, call it once from
   the browser console on the live site with
   `supabase.rpc('debug_headers')`, read the value, then drop it:

   ```sql
   create or replace function public.debug_headers() returns json
   language sql stable as $$ select current_setting('request.headers', true)::json $$;
   grant execute on function public.debug_headers() to anon;
   -- then, afterwards:
   -- drop function public.debug_headers();
   ```

   If it turns out to be a chain like `client, 10.x.x.x`, tell whoever picks
   this up — the identity may be better built from a specific element than from
   the whole string. Do not leave `debug_headers` installed; it hands every
   caller their own headers back, which is harmless, but it is also a habit
   worth not forming.
4. **Decide the numbers.** 500 m, 10 min, 20/hour, 60/day, 300/hour per IP are
   judgement calls, not findings. The one worth thinking about is 500 m: a
   large retail park or a shopping centre car park can be 300 m across, and a
   phone indoors is often 50–100 m out on top of that. Tightening it below
   500 m starts rejecting people standing at the machine.
5. **A decision, not a task:** whether to ask for location at all. The check
   fails open — no permission means the report still goes through — so the
   worst case for a user who says no is that they see a browser prompt once and
   nothing else changes. If even that feels like too much friction for a map
   that people use for ten seconds at a till, dropping the proximity check and
   keeping only the rate limiting is a defensible choice. The rate limiting is
   the part doing the real work.
