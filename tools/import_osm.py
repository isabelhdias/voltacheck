#!/usr/bin/env python3
"""
Import Portugal's deposit-return machines (Volta / SDR) from OpenStreetMap.

Run this by hand when you want to refresh the machine list. It writes three
things and nothing else:

    seed/machines.csv   — paste-free import via Supabase → Table editor → Import
    seed/machines.sql   — same data as an upsert, for the SQL editor
    index.html          — rewrites the SEED block used by local mode

The app itself stays a single static index.html with no build step. This script
is a one-off generator; its output is committed.

Python 3 standard library only — no pip install, nothing to set up.

    python3 tools/import_osm.py             # use cached Overpass responses
    python3 tools/import_osm.py --refresh   # re-download from Overpass

Data source
-----------
OpenStreetMap, via Overpass. The Portuguese community mapped the whole Volta
network under `operator:wikidata=Q138952882` (SDR Portugal), following
https://wiki.openstreetmap.org/wiki/Volta_PT — roughly 2,400 machines, which
matches the ~2,500 the operator claims.

OSM data is ODbL. We use it, so the map has to credit OpenStreetMap — it does,
in the Leaflet attribution control.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")

# SDR Portugal, the operator behind the Volta brand.
OPERATOR_WIKIDATA = "Q138952882"

# Overpass instances, tried in order. overpass-api.de is the main one; the rest
# are mirrors that have covered for it when it is down or unreachable.
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

USER_AGENT = "VoltaCheck-importer/1.0 (+https://github.com/isabelhdias/voltacheck)"

# Mainland, Madeira, Azores.
BOXES = [
    (36.80, -9.62, 42.25, -6.10),
    (32.30, -17.35, 33.20, -16.20),
    (36.85, -31.40, 39.90, -24.90),
]

MACHINES_Q = f"""
[out:json][timeout:300];
nwr["operator:wikidata"="{OPERATOR_WIKIDATA}"](30.0,-32.0,43.0,-5.5);
out center tags;
"""

BOUNDARIES_Q = "[out:json][timeout:300];(" + "".join(
    f'relation["boundary"="administrative"]["admin_level"="7"]({a},{b},{c},{d});'
    for a, b, c, d in BOXES
) + ");out geom;"


# ───────────────────────── fetching ─────────────────────────

def overpass(query, cache_name, refresh):
    """Run an Overpass query, caching the raw response so re-runs are free."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)

    if not refresh and os.path.exists(path):
        print(f"  cached  {cache_name}")
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    body = urllib.parse.urlencode({"data": query}).encode()
    last = None

    for url in ENDPOINTS:
        host = urllib.parse.urlparse(url).hostname
        try:
            print(f"  querying {host} …", end="", flush=True)
            req = urllib.request.Request(
                url, data=body, headers={"User-Agent": USER_AGENT}
            )
            with urllib.request.urlopen(req, timeout=600) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
        except Exception as err:                     # noqa: BLE001 — any failure, try next
            print(f" {type(err).__name__}")
            last = err
            time.sleep(2)
            continue

        print(f" {len(data.get('elements', []))} elements")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        return data

    sys.exit(f"every Overpass endpoint failed; last error: {last}")


# ───────────────────── municipality lookup ─────────────────────
#
# Each machine gets a `town` — its concelho. Point-in-polygon against the OSM
# admin_level=7 boundaries, done here rather than by reverse-geocoding 2,400
# points against Nominatim, which their usage policy asks you not to do.

def load_areas(data):
    areas = []
    for rel in data.get("elements", []):
        name = rel.get("tags", {}).get("name")
        if not name:
            continue
        segs = []
        for mem in rel.get("members", []):
            geom = mem.get("geometry")
            if mem.get("type") != "way" or not geom:
                continue
            if mem.get("role") not in ("outer", "inner", ""):
                continue
            for a, b in zip(geom, geom[1:]):
                segs.append((a["lon"], a["lat"], b["lon"], b["lat"]))
        if not segs:
            continue
        xs = [s[0] for s in segs] + [s[2] for s in segs]
        ys = [s[1] for s in segs] + [s[3] for s in segs]
        areas.append({
            "name": name,
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "segs": segs,
        })
    return areas


def contains(area, lon, lat):
    """Even-odd ray cast eastward. Counting crossings over every boundary
    segment gives the right answer without stitching the ways into rings —
    inner rings (enclaves) fall out correctly as two extra crossings."""
    x0, y0, x1, y1 = area["bbox"]
    if not (x0 <= lon <= x1 and y0 <= lat <= y1):
        return False
    odd = False
    for ax, ay, bx, by in area["segs"]:
        if (ay > lat) != (by > lat):
            if ax + (lat - ay) * (bx - ax) / (by - ay) > lon:
                odd = not odd
    return odd


def nearest_area(areas, lon, lat):
    """Fallback for a point that sits just off the coastline in OSM."""
    best, best_d = None, None
    for area in areas:
        for ax, ay, _, _ in area["segs"]:
            d = (ax - lon) ** 2 + (ay - lat) ** 2
            if best_d is None or d < best_d:
                best, best_d = area["name"], d
    return best


def town_for(areas, lon, lat):
    for area in areas:
        if contains(area, lon, lat):
            return area["name"], True
    return nearest_area(areas, lon, lat), False


# ───────────────────────── machines ─────────────────────────

def build(machines_data, areas):
    rows, skipped, approx = [], 0, 0

    for el in machines_data.get("elements", []):
        tags = el.get("tags", {})

        # Only reverse vending machines. The network also has thousands of
        # manual counters at tills, and "cheia" means nothing for those.
        if tags.get("recycling_type") != "reverse_vending_machine":
            skipped += 1
            continue

        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lon is None:
            skipped += 1
            continue

        lat, lon = round(float(lat), 5), round(float(lon), 5)
        town, exact = town_for(areas, lon, lat)
        if not exact:
            approx += 1

        name = (tags.get("name") or "").strip()
        if not name:
            name = f"Máquina Volta ({town})" if town else "Máquina Volta"
        name = name[:80]

        rows.append({
            "external_id": f"osm:{el['type']}/{el['id']}",
            "osm_id": el["id"],
            "name": name,
            "lat": lat,
            "lng": lon,
            "town": town or "",
        })

    rows.sort(key=lambda r: (r["town"], r["name"], r["osm_id"]))
    return rows, skipped, approx


# ───────────────────────── output ─────────────────────────

def write_csv(rows, path):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["external_id", "name", "lat", "lng", "town", "source"])
        for r in rows:
            w.writerow([r["external_id"], r["name"], r["lat"], r["lng"], r["town"], "osm"])


def sql_str(value):
    return "'" + str(value).replace("'", "''") + "'"


def write_sql(rows, path):
    head = f"""\
-- VoltaCheck — {len(rows)} máquinas de depósito (RVM) do OpenStreetMap.
--
-- Gerado por tools/import_osm.py. Não editar à mão.
-- Dados © contribuidores do OpenStreetMap, sob ODbL.
--
-- Correr depois de schema.sql. Voltar a correr é seguro: faz upsert por
-- external_id, por isso actualiza em vez de duplicar, e não toca nas máquinas
-- adicionadas por pessoas (source = 'user').

insert into machines (external_id, name, lat, lng, town, source) values
"""
    values = ",\n".join(
        "  ({}, {}, {}, {}, {}, 'osm')".format(
            sql_str(r["external_id"]), sql_str(r["name"]),
            r["lat"], r["lng"], sql_str(r["town"]),
        )
        for r in rows
    )
    tail = """
on conflict (external_id) do update set
  name = excluded.name,
  lat  = excluded.lat,
  lng  = excluded.lng,
  town = excluded.town;
"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(head + values + tail)


SEED_START = "  /* ── SEED START — gerado por tools/import_osm.py ──"
SEED_END = "  /* ── SEED END ── */"


def write_seed_block(rows, path):
    lines = [
        SEED_START,
        "     {} máquinas do OpenStreetMap (ODbL). Não editar à mão:".format(len(rows)),
        "     correr `python3 tools/import_osm.py` outra vez.",
        "     [nome, lat, lng, concelho, id OSM]",
        "     ──────────────────────────────────────────────────── */",
        "  var SEED = [",
    ]
    for i, r in enumerate(rows):
        comma = "," if i < len(rows) - 1 else ""
        lines.append("  [{},{},{},{},{}]{}".format(
            json.dumps(r["name"], ensure_ascii=False),
            r["lat"], r["lng"],
            json.dumps(r["town"], ensure_ascii=False),
            r["osm_id"], comma,
        ))
    lines.append("  ];")
    lines.append(SEED_END)
    block = "\n".join(lines)

    with open(path, encoding="utf-8") as fh:
        html = fh.read()

    pattern = re.compile(
        re.escape(SEED_START) + r".*?" + re.escape(SEED_END), re.S
    )
    if not pattern.search(html):
        sys.exit(
            f"could not find the SEED block markers in {path}.\n"
            f"Expected a line starting with: {SEED_START.strip()}"
        )

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(pattern.sub(lambda _: block, html, count=1))


# ───────────────────────── main ─────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true",
                    help="re-download from Overpass instead of using tools/.cache")
    args = ap.parse_args()

    print("Machines:")
    machines_data = overpass(MACHINES_Q, "machines.json", args.refresh)
    print("Concelho boundaries:")
    bounds_data = overpass(BOUNDARIES_Q, "boundaries.json", args.refresh)

    areas = load_areas(bounds_data)
    rows, skipped, approx = build(machines_data, areas)

    if not rows:
        sys.exit("no machines found — refusing to overwrite the seed with nothing")

    seen = {}
    for r in rows:
        seen.setdefault(r["external_id"], 0)
        seen[r["external_id"]] += 1
    dupes = [k for k, n in seen.items() if n > 1]
    if dupes:
        sys.exit(f"duplicate external_id, would break the upsert: {dupes[:5]}")

    os.makedirs(os.path.join(ROOT, "seed"), exist_ok=True)
    write_csv(rows, os.path.join(ROOT, "seed", "machines.csv"))
    write_sql(rows, os.path.join(ROOT, "seed", "machines.sql"))
    write_seed_block(rows, os.path.join(ROOT, "index.html"))

    towns = sorted({r["town"] for r in rows if r["town"]})
    print()
    print(f"  {len(rows)} máquinas, {len(towns)} concelhos")
    print(f"  {skipped} elementos ignorados (não são RVM)")
    if approx:
        print(f"  {approx} sem concelho exacto — usado o mais próximo")
    print()
    print("  wrote seed/machines.csv, seed/machines.sql, and the SEED block in index.html")


if __name__ == "__main__":
    main()
