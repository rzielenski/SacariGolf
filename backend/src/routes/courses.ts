import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/nearby', requireAuth, wrap(async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (isNaN(lat) || isNaN(lng)) return res.json([]);
  const { rows } = await pool.query(
    `SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY (latitude - $1)^2 + (longitude - $2)^2
     LIMIT $3`,
    [lat, lng, limit]
  );
  return res.json(rows);
}));

router.get('/search', requireAuth, wrap(async (req: Request, res: Response) => {
  const q = (req.query.q as string) || '';
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (!q.trim()) return res.json([]);
  const { rows } = await pool.query(
    `SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE course_name ILIKE $1 OR club_name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1
     ORDER BY
       CASE WHEN city ILIKE $2 THEN 0
            WHEN state ILIKE $2 THEN 1
            ELSE 2 END,
       course_name
     LIMIT $3`,
    [`%${q}%`, `%${q}%`, limit]
  );
  return res.json(rows);
}));

router.get('/:id/leaderboard', requireAuth, wrap(async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores,
            array_length(r.hole_scores, 1) AS holes_played,
            u.username, u.user_id, u.avatar_url,
            t.teebox_id, t.name AS teebox_name, t.par, t.num_holes,
            m.match_type, m.format
     FROM rounds r
     JOIN users u ON u.user_id = r.user_id
     JOIN teeboxes t ON t.teebox_id = r.teebox_id
     JOIN matches m ON m.match_id = r.match_id
     WHERE t.course_id = $1 AND r.total_score IS NOT NULL AND m.completed = true AND m.is_practice = false
     ORDER BY r.total_score ASC
     LIMIT 50`,
    [req.params.id]
  );
  return res.json(rows);
}));

router.get('/:id', requireAuth, wrap(async (req: Request, res: Response) => {
  const { rows: courseRows } = await pool.query(
    `SELECT course_id, course_name, club_name, address, city, state, country, latitude, longitude
     FROM courses WHERE course_id = $1`,
    [req.params.id]
  );
  if (!courseRows.length) return res.status(404).json({ error: 'Course not found' });

  const { rows: teeRows } = await pool.query(
    `SELECT teebox_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par,
            front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
     FROM teeboxes WHERE course_id = $1 ORDER BY total_yards DESC`,
    [req.params.id]
  );

  const teeboxIds = teeRows.map((t) => t.teebox_id);
  let holes: any[] = [];
  if (teeboxIds.length > 0) {
    const { rows: holeRows } = await pool.query(
      `SELECT hole_id, teebox_id, hole_num, par, yardage, handicap,
              pin_lat, pin_lng, pin_elevation_m
       FROM holes WHERE teebox_id = ANY($1) ORDER BY teebox_id, hole_num`,
      [teeboxIds]
    );
    holes = holeRows;
  }

  const teeboxes = teeRows.map((t) => ({
    ...t,
    holes: holes.filter((h) => h.teebox_id === t.teebox_id),
  }));

  return res.json({ ...courseRows[0], teeboxes });
}));

// Crowd-sourced course data correction. Players hit obviously-wrong
// course/teebox/hole data and tap a "Report" button — we collect their
// suggested fix here for human review. Intentionally light: no auto-apply,
// no voting, just a queue. Same player can submit multiple corrections to
// the same course (different fields).
//
//   POST /courses/:id/corrections
//     body: {
//       field: 'course_rating' | 'slope_rating' | 'par' | 'yardage' | 'tee_name' | 'pin_location' | 'other',
//       suggestedValue: string,        // free-form so we can capture anything
//       currentValue?: string,         // what the user saw before (for diffing)
//       teeboxId?: string,             // narrows the report to a specific teebox
//       holeId?: string,               // narrows further to a specific hole
//       notes?: string,                // free-form comment
//     }
const ALLOWED_FIELDS = new Set([
  'course_rating', 'slope_rating', 'par', 'yardage', 'tee_name',
  'pin_location', 'club_name', 'course_name', 'address', 'other',
]);
router.post('/:id/corrections', requireAuth, wrap(async (req: any, res: Response) => {
  const { field, suggestedValue, currentValue, teeboxId, holeId, notes } = req.body ?? {};
  if (typeof field !== 'string' || !ALLOWED_FIELDS.has(field)) {
    return res.status(400).json({ error: 'invalid field' });
  }
  if (typeof suggestedValue !== 'string' || !suggestedValue.trim()) {
    return res.status(400).json({ error: 'suggestedValue required' });
  }

  // Confirm course exists (so we don't accept reports for stale IDs).
  const { rows } = await pool.query(`SELECT 1 FROM courses WHERE course_id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'course not found' });

  await pool.query(
    `INSERT INTO course_corrections (course_id, teebox_id, hole_id, user_id, field, current_value, suggested_value, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      req.params.id,
      teeboxId || null,
      holeId || null,
      req.userId,
      field,
      typeof currentValue === 'string' ? currentValue.slice(0, 200) : null,
      suggestedValue.trim().slice(0, 500),
      typeof notes === 'string' ? notes.trim().slice(0, 500) : null,
    ]
  );
  return res.json({ success: true });
}));

/**
 * Course data-quality probe. Returns counts that drive the "this course is
 * underdocumented" warning at round start. Cheap aggregate queries; safe to
 * call on every match start.
 *
 * Thresholds returned alongside so the client doesn't have to hard-code
 * them — server can tune the cutoff (e.g. 30 elevation points, 50% of holes
 * with pins) without an app release.
 */
router.get('/:id/data-quality', requireAuth, wrap(async (req: any, res: Response) => {
  const courseId = req.params.id;

  // Counts in parallel
  const [{ rows: elevRows }, { rows: holeRows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS elevation_points,
              COALESCE(SUM(samples), 0)::int AS elevation_samples
       FROM course_elevation_points WHERE course_id = $1`,
      [courseId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total_holes,
              COUNT(*) FILTER (WHERE h.pin_lat IS NOT NULL)::int AS holes_with_pins
       FROM teeboxes t
       JOIN holes h ON h.teebox_id = t.teebox_id
       WHERE t.course_id = $1`,
      [courseId]
    ),
  ]);

  const elevation_points = elevRows[0]?.elevation_points ?? 0;
  const elevation_samples = elevRows[0]?.elevation_samples ?? 0;
  const total_holes = holeRows[0]?.total_holes ?? 0;
  const holes_with_pins = holeRows[0]?.holes_with_pins ?? 0;
  const pin_coverage = total_holes > 0 ? holes_with_pins / total_holes : 0;

  // "Low data" thresholds — chosen so that a brand new course or one with
  // sparse community contribution shows the warning, while a well-played
  // course (couple rounds in the bag) does not.
  const LOW_ELEV_POINTS = 30;
  const LOW_PIN_COVERAGE = 0.5;
  const low_elevation = elevation_points < LOW_ELEV_POINTS;
  const low_pins = pin_coverage < LOW_PIN_COVERAGE;
  const low_data = low_elevation || low_pins;

  return res.json({
    elevation_points,
    elevation_samples,
    total_holes,
    holes_with_pins,
    pin_coverage,                      // 0..1
    low_elevation,
    low_pins,
    low_data,
    thresholds: { LOW_ELEV_POINTS, LOW_PIN_COVERAGE },
  });
}));

// ─── Relative-elevation crowdsourcing ────────────────────────────────────────
//
// Phone barometers are sub-meter accurate at *relative* altitude over short
// timespans, but their *absolute* reading drifts. By anchoring every point
// on a course to the FIRST player's first reading (origin = 0m), each cached
// point becomes a barometric-quality delta — useful for slope-to-pin even
// when device altitudes are off by 10m+.
//
// Grid bucket: 1 / 20000 deg ≈ 5.5m N/S. Lookups search the immediate cell
// plus its 8 neighbors so a 30m radius is well covered.
const GRID_RES = 20000;
const gridFor = (lat: number, lng: number) => ({
  lat_grid: Math.round(lat * GRID_RES),
  lng_grid: Math.round(lng * GRID_RES),
});
const HAVERSINE_R = 6371000;
function distMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return HAVERSINE_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Establish the caller's per-round elevation offset for this course.
 * The client sends its current GPS position + raw device altitude. We
 * compute `offset_m` such that:
 *
 *   relative_elevation = device_altitude − offset_m
 *
 * yields a value consistent with our cached origin = 0 frame.
 *
 * Three cases:
 *   1. Course has cached points within 30m → align to the closest one
 *      (strongest signal: the closer the anchor, the less drift in the
 *      offset). offset = device_altitude − anchor.elevation_rel_m
 *   2. Course has cached points but caller is not near any → fall back to
 *      the global mean of cached samples weighted by inverse distance.
 *      Less ideal but still better than refusing to calibrate.
 *   3. Course has no cached points → caller is the first contributor.
 *      offset = device_altitude (so this position becomes the origin = 0).
 *
 * Body: { lat: number, lng: number, deviceAltM: number }
 * Returns: { offsetM: number, mode: 'anchor' | 'global' | 'seed', distM?: number }
 */
router.post('/:id/elevation-reference', requireAuth, wrap(async (req: any, res: Response) => {
  const { lat, lng, deviceAltM } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof deviceAltM !== 'number') {
    return res.status(400).json({ error: 'lat, lng, deviceAltM required as numbers' });
  }
  const { lat_grid, lng_grid } = gridFor(lat, lng);

  // Pull a tight window first (3x3 grid cells = ~16m radius cap).
  const { rows: nearby } = await pool.query(
    `SELECT lat, lng, elevation_rel_m, samples
     FROM course_elevation_points
     WHERE course_id = $1
       AND lat_grid BETWEEN $2 - 1 AND $2 + 1
       AND lng_grid BETWEEN $3 - 1 AND $3 + 1`,
    [req.params.id, lat_grid, lng_grid]
  );
  if (nearby.length) {
    let best = nearby[0];
    let bestDist = distMetres(lat, lng, best.lat, best.lng);
    for (const r of nearby) {
      const d = distMetres(lat, lng, r.lat, r.lng);
      if (d < bestDist) { best = r; bestDist = d; }
    }
    if (bestDist <= 30) {
      const offsetM = deviceAltM - best.elevation_rel_m;
      return res.json({ offsetM, mode: 'anchor', distM: Math.round(bestDist) });
    }
  }

  // Fallback: weighted mean of all course points.
  const { rows: all } = await pool.query(
    `SELECT lat, lng, elevation_rel_m FROM course_elevation_points WHERE course_id = $1 LIMIT 200`,
    [req.params.id]
  );
  if (all.length) {
    let weightSum = 0;
    let weightedElev = 0;
    for (const r of all) {
      const d = Math.max(1, distMetres(lat, lng, r.lat, r.lng));
      const w = 1 / (d * d);
      weightSum += w;
      weightedElev += w * r.elevation_rel_m;
    }
    const meanRel = weightedElev / weightSum;
    const offsetM = deviceAltM - meanRel;
    return res.json({ offsetM, mode: 'global' });
  }

  // Seed: the caller is the first contributor. Their reading anchors origin = 0.
  await pool.query(
    `INSERT INTO course_elevation_points (course_id, lat_grid, lng_grid, lat, lng, elevation_rel_m, samples)
     VALUES ($1, $2, $3, $4, $5, 0, 1)
     ON CONFLICT (course_id, lat_grid, lng_grid) DO NOTHING`,
    [req.params.id, lat_grid, lng_grid, lat, lng]
  );
  return res.json({ offsetM: deviceAltM, mode: 'seed' });
}));

/**
 * Batch-upload sampled relative elevations for this course. Each entry is
 * already in the course's relative frame (caller subtracted their offset).
 *
 * Body: { samples: [{ lat, lng, elevationRelM }] }
 *
 * Per-row upsert maintains a running average:
 *   new_avg = (avg * samples + new_value) / (samples + 1)
 * with a soft cap on samples so a fixed sensor at one spot can't dominate
 * forever — once samples ≥ 50, new readings count as if existing samples
 * were 50 (treats post-50 samples as ~2% per drop).
 */
router.post('/:id/elevation-points', requireAuth, wrap(async (req: any, res: Response) => {
  const { samples } = req.body ?? {};
  if (!Array.isArray(samples)) return res.status(400).json({ error: 'samples array required' });

  const cleaned = samples
    .map((s: any) => ({
      lat: Number(s?.lat), lng: Number(s?.lng), elev: Number(s?.elevationRelM),
    }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && Number.isFinite(s.elev)
                && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180
                // Reject obviously-bogus deltas (>500m vertical change on a single course is implausible)
                && Math.abs(s.elev) < 500)
    .slice(0, 200); // cap batch size

  if (!cleaned.length) return res.json({ accepted: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of cleaned) {
      const { lat_grid, lng_grid } = gridFor(s.lat, s.lng);
      // Upsert with soft-capped running average.
      await client.query(
        `INSERT INTO course_elevation_points
           (course_id, lat_grid, lng_grid, lat, lng, elevation_rel_m, samples, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
         ON CONFLICT (course_id, lat_grid, lng_grid) DO UPDATE
           SET elevation_rel_m =
             (course_elevation_points.elevation_rel_m * LEAST(course_elevation_points.samples, 50) + EXCLUDED.elevation_rel_m)
             / (LEAST(course_elevation_points.samples, 50) + 1),
               samples = course_elevation_points.samples + 1,
               last_updated = NOW()`,
        [req.params.id, lat_grid, lng_grid, s.lat, s.lng, s.elev]
      );
    }
    await client.query('COMMIT');
    return res.json({ accepted: cleaned.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('elevation-points upsert failed:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

/**
 * Look up the nearest cached relative elevation. Returns null when nothing
 * is within radius. Caller does its own delta math (pin_rel − user_rel) so
 * a single GET serves both endpoints of a slope query when batched.
 *
 * Query: ?lat=X&lng=Y&radiusM=20  (default radius 20m)
 */
router.get('/:id/elevation-at', requireAuth, wrap(async (req: any, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusM = Math.min(60, Math.max(5, Number(req.query.radiusM) || 20));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat, lng required' });
  }
  const { lat_grid, lng_grid } = gridFor(lat, lng);
  // Cells to scan: 1 cell ≈ 5.5m, so for 20m radius scan ±4 cells; for 60m, ±11
  const reach = Math.max(1, Math.ceil(radiusM / 5));
  const { rows } = await pool.query(
    `SELECT lat, lng, elevation_rel_m, samples
     FROM course_elevation_points
     WHERE course_id = $1
       AND lat_grid BETWEEN $2 - $4 AND $2 + $4
       AND lng_grid BETWEEN $3 - $4 AND $3 + $4`,
    [req.params.id, lat_grid, lng_grid, reach]
  );
  if (!rows.length) return res.json(null);
  let best = null as null | { row: any; dist: number };
  for (const r of rows) {
    const d = distMetres(lat, lng, r.lat, r.lng);
    if (d <= radiusM && (!best || d < best.dist)) best = { row: r, dist: d };
  }
  if (!best) return res.json(null);
  return res.json({
    elevationRelM: best.row.elevation_rel_m,
    samples: best.row.samples,
    distM: Math.round(best.dist),
    lat: best.row.lat,
    lng: best.row.lng,
  });
}));

/**
 * Admin: set pin coordinates for one or more holes of a course remotely.
 *
 * Avoids the "must be physically at the course to crowdsource a pin" loop
 * for course owners / operators seeding data ahead of launch. Same admin
 * token gate as the premium grant/revoke endpoints (PREMIUM_ADMIN_TOKEN).
 *
 *   POST /courses/admin/set-pins
 *   header:  x-admin-token: <PREMIUM_ADMIN_TOKEN>
 *   body: {
 *     courseId: UUID,
 *     // Pins are applied to EVERY teebox row that shares the same
 *     // hole_num within the course — the holes table has one row per
 *     // (teebox, hole_num) but the pin is a physical-world property
 *     // that should be identical across teeboxes.
 *     pins: [
 *       { holeNum: 1, lat: 40.7128, lng: -74.0060, elevation_m?: number },
 *       { holeNum: 2, lat: ...,     lng: ... },
 *       ...
 *     ]
 *   }
 *
 * Response: { updated: N, missing_hole_nums: [...] }
 */
router.post('/admin/set-pins', wrap(async (req: Request, res: Response) => {
  const expected = process.env.PREMIUM_ADMIN_TOKEN;
  const provided = req.header('x-admin-token');
  if (!expected || !provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { courseId, pins } = req.body ?? {};
  if (typeof courseId !== 'string' || !courseId) {
    return res.status(400).json({ error: 'courseId required' });
  }
  if (!Array.isArray(pins) || pins.length === 0) {
    return res.status(400).json({ error: 'pins array required' });
  }

  // Quick course-exists check so a typo'd ID gives a clean 404 instead
  // of a silent no-op update count of 0.
  const { rows: cRows } = await pool.query(
    `SELECT course_id FROM courses WHERE course_id = $1`, [courseId]
  );
  if (!cRows.length) return res.status(404).json({ error: 'Course not found' });

  let updated = 0;
  const missing: number[] = [];
  for (const p of pins) {
    const holeNum = Number(p?.holeNum);
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > 18) {
      missing.push(p?.holeNum); continue;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { missing.push(holeNum); continue; }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180)      { missing.push(holeNum); continue; }
    const elev = Number.isFinite(p?.elevation_m) ? Number(p.elevation_m) : null;
    // Apply to every teebox's copy of this hole_num within the course.
    const { rowCount } = await pool.query(
      `UPDATE holes h
          SET pin_lat = $3,
              pin_lng = $4,
              pin_elevation_m = COALESCE($5, h.pin_elevation_m),
              pin_set_by = NULL
        FROM teeboxes t
       WHERE h.teebox_id = t.teebox_id
         AND t.course_id = $1
         AND h.hole_num = $2`,
      [courseId, holeNum, lat, lng, elev]
    );
    const n = rowCount ?? 0;
    if (n === 0) missing.push(holeNum);
    else updated += n;
  }
  return res.json({ updated, missing_hole_nums: missing });
}));

export default router;
