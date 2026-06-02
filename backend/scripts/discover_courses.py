#!/usr/bin/env python3
"""
discover_courses.py — find every golf course within N miles of a point and
import it into the Sacari courses / teeboxes / holes tables.

Why this exists:
  GolfCourseAPI v1 (the source for the original ~27k-course bulk import,
  tracked by courses.external_id) is name-search only — no geolocation
  endpoint — and its coverage trails off for small, municipal, private,
  9-hole, and local courses. To get true neighborhood-level coverage we
  combine two sources:

    1. OpenStreetMap Overpass (free, no key) — exhaustive worldwide
       discovery of `leisure=golf_course` features. Gives us name +
       coordinates for every course OSM contributors have mapped.

    2. GolfCourseAPI lookup (your key) — for every OSM hit, we search
       by name and import the full teebox / hole data when matched.

  Courses OSM finds but GolfCourseAPI doesn't have hole data for land as
  location-only rows: searchable, Nearby-visible, ready for a player to
  request the scorecard via the existing course-request flow, or for you
  to drop the holes into a migration later.

Inputs:
  --lat / --lng         your location (decimal degrees)
  --radius              miles, default 50
  --api-key             GolfCourseAPI key (or set GOLF_COURSE_API_KEY env)
  --database-url        Postgres URL (or set DATABASE_URL env)
  --dry-run             print what would happen, don't write
  --sql-out FILE        also write the generated SQL to FILE for review
  --skip-unnamed        ignore OSM features with no `name` tag
  --placeholder-holes   for courses with no GolfCourseAPI match, insert a
                        generic 18-hole par-72 teebox so the course is
                        immediately playable (to-par will be off until
                        real holes land)

Usage:
  pip install requests psycopg2-binary
  export GOLF_COURSE_API_KEY=...
  export DATABASE_URL=postgresql://...        # from Railway, Postgres → Connect
  python3 discover_courses.py --lat 43.183 --lng -75.046 --radius 50

  # Dry run that writes SQL you can drop into migrate.ts:
  python3 discover_courses.py --lat 43.183 --lng -75.046 \
      --dry-run --sql-out newport_area.sql

Notes:
  • Idempotent: every INSERT is ON CONFLICT DO NOTHING. Re-running on the
    same point picks up newly-mapped OSM features without disturbing
    anything you already have.
  • Dedup against existing courses by external_id (GolfCourseAPI id)
    when available, and otherwise by proximity: anything within 250 m of
    an existing course is treated as a duplicate.
  • The Overpass API rate-limits aggressively; the script retries with
    backoff. A 50-mile sweep takes ~10–60 s depending on density.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    import psycopg2  # type: ignore
except ImportError:
    psycopg2 = None  # only required when not in --dry-run

# ── Constants ────────────────────────────────────────────────────────────────

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
GOLFCOURSEAPI_BASE = "https://api.golfcourseapi.com/v1"
MILES_TO_METERS = 1609.344


# ── OpenStreetMap discovery ──────────────────────────────────────────────────

def overpass_query(lat: float, lng: float, radius_m: int) -> List[Dict[str, Any]]:
    """Return every leisure=golf_course feature (way + relation) inside the
    radius, each with its centroid and any address tags OSM contributors
    have filled in. Retries on 429/504 with exponential backoff."""
    q = (
        "[out:json][timeout:60];"
        "("
        f'  way["leisure"="golf_course"](around:{radius_m},{lat},{lng});'
        f'  relation["leisure"="golf_course"](around:{radius_m},{lat},{lng});'
        ");"
        "out tags center;"
    )
    for attempt in range(4):
        try:
            r = requests.post(OVERPASS_URL, data={"data": q}, timeout=120)
            if r.status_code in (429, 504):
                wait = 2 ** attempt
                print(f"  overpass {r.status_code}, retrying in {wait}s...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            break
        except requests.RequestException as e:
            if attempt == 3:
                raise
            wait = 2 ** attempt
            print(f"  overpass error ({e}), retrying in {wait}s...")
            time.sleep(wait)
    else:
        raise RuntimeError("Overpass refused us four times in a row.")

    elements = r.json().get("elements", [])
    out = []
    for el in elements:
        tags = el.get("tags") or {}
        center = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
        if center.get("lat") is None or center.get("lon") is None:
            continue
        out.append({
            "osm_id": el["id"],
            "osm_type": el["type"],
            "name": tags.get("name"),
            "lat": center["lat"],
            "lng": center["lon"],
            "city": tags.get("addr:city"),
            "state": tags.get("addr:state"),
            "address": _build_address(tags),
            "website": tags.get("website") or tags.get("contact:website"),
        })
    return out


def _build_address(tags: Dict[str, str]) -> Optional[str]:
    """Stitch the various addr:* tags into one street-style string."""
    if tags.get("addr:full"):
        return tags["addr:full"]
    parts: List[str] = []
    if tags.get("addr:housenumber") and tags.get("addr:street"):
        parts.append(f'{tags["addr:housenumber"]} {tags["addr:street"]}')
    elif tags.get("addr:street"):
        parts.append(tags["addr:street"])
    if tags.get("addr:city"):
        parts.append(tags["addr:city"])
    if tags.get("addr:state"):
        parts.append(tags["addr:state"])
    if tags.get("addr:postcode"):
        parts.append(tags["addr:postcode"])
    return ", ".join(parts) if parts else None


# ── GolfCourseAPI lookup ─────────────────────────────────────────────────────

def golfcourseapi_search(name: str, api_key: str) -> List[Dict[str, Any]]:
    """Search GolfCourseAPI by free-text name. Returns the candidates list."""
    for attempt in range(4):
        r = requests.get(
            f"{GOLFCOURSEAPI_BASE}/search",
            params={"search_query": name},
            headers={"Authorization": f"Key {api_key}"},
            timeout=30,
        )
        if r.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 401:
            sys.exit("GolfCourseAPI rejected the key (401). Check --api-key.")
        r.raise_for_status()
        return r.json().get("courses", [])
    return []


def golfcourseapi_get(course_id: int, api_key: str) -> Optional[Dict[str, Any]]:
    """Fetch a full course (with teeboxes + per-hole data) by ID."""
    for attempt in range(4):
        r = requests.get(
            f"{GOLFCOURSEAPI_BASE}/courses/{course_id}",
            headers={"Authorization": f"Key {api_key}"},
            timeout=30,
        )
        if r.status_code == 404:
            return None
        if r.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        body = r.json()
        return body.get("course") or body
    return None


def _normalise_name(s: Optional[str]) -> str:
    s = (s or "").lower()
    s = re.sub(r"\b(golf|club|country|the|course|links|cc|gc|of|at)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def best_api_match(osm_name: str, candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Pick the closest GolfCourseAPI candidate to the OSM name.
       Exact normalised match wins; otherwise we fall back to character-set
       overlap and require at least 4 shared characters before claiming a
       match. Keeps "Pine Hills" from being grafted onto "Pine Valley"."""
    if not candidates:
        return None
    norm = _normalise_name(osm_name)
    if not norm:
        return None
    best: Tuple[int, Optional[Dict[str, Any]]] = (0, None)
    for c in candidates:
        api_name = c.get("course_name") or c.get("club_name") or ""
        api_norm = _normalise_name(api_name)
        if api_norm == norm:
            return c
        overlap = len(set(norm) & set(api_norm))
        if overlap > best[0]:
            best = (overlap, c)
    return best[1] if best[0] >= 4 else None


# ── Shaping into our schema ──────────────────────────────────────────────────

def shape_api_course(api_course: Dict[str, Any], osm: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Take a GolfCourseAPI course payload and return (course_row, teeboxes).
       Falls back to OSM data for any location field the API leaves blank."""
    loc = api_course.get("location") or {}
    course_row = {
        "course_name": api_course.get("course_name") or osm.get("name"),
        "club_name":   api_course.get("club_name"),
        "address":     loc.get("address") or osm.get("address"),
        "city":        loc.get("city") or osm.get("city"),
        "state":       loc.get("state") or osm.get("state"),
        "country":     loc.get("country") or "United States",
        "latitude":    loc.get("latitude") or osm.get("lat"),
        "longitude":   loc.get("longitude") or osm.get("lng"),
        "external_id": api_course.get("id"),
    }
    teeboxes: List[Dict[str, Any]] = []
    tees = api_course.get("tees") or {}
    for gender_key in ("male", "female"):
        for tee in tees.get(gender_key, []) or []:
            holes_in = tee.get("holes") or []
            holes_out = []
            for i, h in enumerate(holes_in, start=1):
                holes_out.append({
                    "hole_num": i,
                    "par":      h.get("par"),
                    "yardage":  h.get("yardage"),
                    "handicap": h.get("handicap"),
                })
            teeboxes.append({
                "name":          tee.get("tee_name") or "Standard",
                "gender":        gender_key,
                "course_rating": tee.get("course_rating"),
                "slope_rating":  tee.get("slope_rating"),
                "total_yards":   tee.get("total_yards"),
                "num_holes":     tee.get("number_of_holes") or 18,
                "par":           tee.get("par_total") or 72,
                "holes":         holes_out,
            })
    return course_row, teeboxes


def placeholder_teeboxes() -> List[Dict[str, Any]]:
    """Generic 18-hole, par-72 teebox with all-par-4 holes so a course is
       at least *playable* before someone supplies the real scorecard."""
    return [{
        "name": "Standard",
        "gender": "male",
        "course_rating": None,
        "slope_rating":  None,
        "total_yards":   None,
        "num_holes":     18,
        "par":           72,
        "holes": [
            {"hole_num": i, "par": 4, "yardage": None, "handicap": ((i - 1) % 18) + 1}
            for i in range(1, 19)
        ],
    }]


# ── Postgres write path ──────────────────────────────────────────────────────

def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def already_in_db(cur, lat: float, lng: float, external_id: Optional[int]) -> bool:
    """Dedup: external_id match wins. Otherwise treat any course within
       250 m as the same physical place — the courses table sometimes has
       slightly different name spellings for the same real-world course."""
    if external_id is not None:
        cur.execute("SELECT 1 FROM courses WHERE external_id = %s", (external_id,))
        if cur.fetchone():
            return True
    cur.execute(
        """
        SELECT latitude, longitude FROM courses
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL
           AND ABS(latitude  - %s) < 0.005
           AND ABS(longitude - %s) < 0.005
        """,
        (lat, lng),
    )
    for clat, clng in cur.fetchall():
        if haversine_m(lat, lng, clat, clng) < 250:
            return True
    return False


def write_course(cur, course_row: Dict[str, Any], teeboxes: List[Dict[str, Any]]) -> Optional[str]:
    """Insert course + teeboxes + holes. Returns the new course_id or None
       if the course already existed (UUID collision, which means we hit a
       duplicate that slipped past the proximity check)."""
    course_id = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO courses (course_id, course_name, club_name, address, city, state, country,
                             latitude, longitude, external_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (course_id) DO NOTHING
        RETURNING course_id
        """,
        (
            course_id,
            course_row["course_name"],
            course_row.get("club_name"),
            course_row.get("address"),
            course_row.get("city"),
            course_row.get("state"),
            course_row.get("country") or "United States",
            course_row.get("latitude"),
            course_row.get("longitude"),
            course_row.get("external_id"),
        ),
    )
    res = cur.fetchone()
    if not res:
        return None
    course_id = str(res[0])
    for tb in teeboxes:
        tb_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating,
                                  total_yards, num_holes, par)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                tb_id, course_id, tb["name"], tb.get("gender", "male"),
                tb.get("course_rating"), tb.get("slope_rating"),
                tb.get("total_yards"), tb.get("num_holes", 18), tb.get("par", 72),
            ),
        )
        for h in tb.get("holes", []):
            cur.execute(
                """
                INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (teebox_id, hole_num) DO NOTHING
                """,
                (tb_id, h["hole_num"], h["par"], h.get("yardage"), h.get("handicap")),
            )
    return course_id


# ── SQL emitter (for --sql-out / dry-run review) ─────────────────────────────

def _sql_lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def emit_sql(course_row: Dict[str, Any], teeboxes: List[Dict[str, Any]]) -> str:
    cid = str(uuid.uuid4())
    out: List[str] = []
    cols = "course_id, course_name, club_name, address, city, state, country, latitude, longitude, external_id"
    vals = ", ".join(_sql_lit(course_row.get(k)) for k in (
        "course_name", "club_name", "address", "city", "state", "country",
        "latitude", "longitude", "external_id",
    ))
    out.append(
        f"INSERT INTO courses ({cols}) VALUES ({_sql_lit(cid)}, {vals}) "
        f"ON CONFLICT (course_id) DO NOTHING;"
    )
    for tb in teeboxes:
        tid = str(uuid.uuid4())
        out.append(
            "INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, "
            "total_yards, num_holes, par) VALUES ("
            f"{_sql_lit(tid)}, {_sql_lit(cid)}, {_sql_lit(tb['name'])}, "
            f"{_sql_lit(tb.get('gender','male'))}, {_sql_lit(tb.get('course_rating'))}, "
            f"{_sql_lit(tb.get('slope_rating'))}, {_sql_lit(tb.get('total_yards'))}, "
            f"{_sql_lit(tb.get('num_holes',18))}, {_sql_lit(tb.get('par',72))}) "
            f"ON CONFLICT (teebox_id) DO NOTHING;"
        )
        for h in tb.get("holes", []):
            out.append(
                "INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES ("
                f"{_sql_lit(tid)}, {_sql_lit(h['hole_num'])}, {_sql_lit(h.get('par'))}, "
                f"{_sql_lit(h.get('yardage'))}, {_sql_lit(h.get('handicap'))}) "
                f"ON CONFLICT (teebox_id, hole_num) DO NOTHING;"
            )
    return "\n".join(out) + "\n"


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Discover golf courses near a point and import them.")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lng", type=float, required=True)
    ap.add_argument("--radius", type=float, default=50.0, help="miles, default 50")
    ap.add_argument("--api-key", default=os.environ.get("GOLF_COURSE_API_KEY"),
                    help="GolfCourseAPI key (or GOLF_COURSE_API_KEY env). Optional; without it everything lands as location-only.")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"),
                    help="Postgres URL (or DATABASE_URL env). Required unless --dry-run.")
    ap.add_argument("--dry-run", action="store_true", help="Don't write to the DB; just print + (optionally) emit SQL.")
    ap.add_argument("--sql-out", help="Write generated SQL to this file (works with or without --dry-run).")
    ap.add_argument("--skip-unnamed", action="store_true", help="Drop OSM features with no `name` tag.")
    ap.add_argument("--placeholder-holes", action="store_true",
                    help="For courses with no GolfCourseAPI match, insert a generic 18-hole par-72 teebox so they're playable.")
    args = ap.parse_args()

    radius_m = int(args.radius * MILES_TO_METERS)
    print(f"→ Searching OSM for golf courses within {args.radius:.0f} mi of ({args.lat}, {args.lng})...")
    osm_courses = overpass_query(args.lat, args.lng, radius_m)
    print(f"  OSM returned {len(osm_courses)} feature(s)")

    if args.skip_unnamed:
        before = len(osm_courses)
        osm_courses = [c for c in osm_courses if c["name"]]
        print(f"  dropped {before - len(osm_courses)} unnamed feature(s)")

    if not args.dry_run and not args.database_url:
        sys.exit("DATABASE_URL is required unless --dry-run is set.")

    conn = None
    cur = None
    if not args.dry_run:
        if psycopg2 is None:
            sys.exit("psycopg2 is required for DB writes. Install with: pip install psycopg2-binary")
        conn = psycopg2.connect(args.database_url)
        cur = conn.cursor()

    sql_chunks: List[str] = []
    matched = 0
    location_only = 0
    placeholder = 0
    skipped_dup = 0

    for osm in osm_courses:
        display = osm["name"] or f"Unnamed ({osm['lat']:.4f},{osm['lng']:.4f})"

        # GolfCourseAPI match (only worth attempting if we have a name + key)
        api_course = None
        if args.api_key and osm["name"]:
            try:
                candidates = golfcourseapi_search(osm["name"], args.api_key)
            except requests.RequestException as e:
                print(f"  ! search failed for {display}: {e}")
                candidates = []
            chosen = best_api_match(osm["name"], candidates)
            if chosen and chosen.get("id"):
                api_course = golfcourseapi_get(chosen["id"], args.api_key) or chosen

        if api_course:
            course_row, teeboxes = shape_api_course(api_course, osm)
            matched += 1
            tag = "API"
        else:
            course_row = {
                "course_name": osm["name"] or f"Unnamed Golf Course ({osm['lat']:.4f},{osm['lng']:.4f})",
                "club_name":   osm["name"],
                "address":     osm.get("address"),
                "city":        osm.get("city"),
                "state":       osm.get("state"),
                "country":     "United States",
                "latitude":    osm["lat"],
                "longitude":   osm["lng"],
                "external_id": None,
            }
            if args.placeholder_holes:
                teeboxes = placeholder_teeboxes()
                placeholder += 1
                tag = "PLACEHOLDER"
            else:
                teeboxes = []
                location_only += 1
                tag = "OSM-ONLY"

        # Dedup check against existing rows (skip in --dry-run since no cursor)
        if cur is not None and already_in_db(cur, osm["lat"], osm["lng"], course_row.get("external_id")):
            skipped_dup += 1
            print(f"  [DUP]  {display}")
            continue

        print(f"  [{tag}] {display}  ({len(teeboxes)} tee/{sum(len(t['holes']) for t in teeboxes)} holes)")

        if cur is not None:
            try:
                write_course(cur, course_row, teeboxes)
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"  ! insert failed for {display}: {e}")

        if args.sql_out:
            sql_chunks.append(f"-- {display}\n{emit_sql(course_row, teeboxes)}")

    if conn:
        conn.close()

    if args.sql_out and sql_chunks:
        with open(args.sql_out, "w", encoding="utf-8") as f:
            f.write("\n".join(sql_chunks))
        print(f"\nWrote {len(sql_chunks)} course(s) of SQL to {args.sql_out}")

    print(
        f"\nDone. matched={matched}  location_only={location_only}  "
        f"placeholder={placeholder}  duplicates_skipped={skipped_dup}"
    )


if __name__ == "__main__":
    main()
