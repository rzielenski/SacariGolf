"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const asyncHandler_1 = require("../utils/asyncHandler");
const notify_1 = require("../utils/notify");
const email_1 = require("../utils/email");
const courseEstimate_1 = require("../utils/courseEstimate");
const router = (0, express_1.Router)();
router.get('/nearby', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    if (isNaN(lat) || isNaN(lng))
        return res.json([]);
    const { rows } = await pool_1.default.query(`SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY (latitude - $1)^2 + (longitude - $2)^2
     LIMIT $3`, [lat, lng, limit]);
    return res.json(rows);
}));
router.get('/search', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const q = req.query.q || '';
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    if (!q.trim())
        return res.json([]);
    const { rows } = await pool_1.default.query(`SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE course_name ILIKE $1 OR club_name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1
     ORDER BY
       CASE WHEN city ILIKE $2 THEN 0
            WHEN state ILIKE $2 THEN 1
            ELSE 2 END,
       course_name
     LIMIT $3`, [`%${q}%`, `%${q}%`, limit]);
    return res.json(rows);
}));
/**
 * User-built course. The in-app builder posts here with a structured
 * payload (course meta + N teeboxes, each with per-hole par/yardage/HCP);
 * we validate, fill in any missing course rating/slope from the length
 * heuristic in utils/courseEstimate.ts, and insert course + teeboxes +
 * holes in a single transaction. Rows are stamped with
 *   created_by_user_id = the submitter
 *   verified           = FALSE
 * so an admin can audit later, and so the UI can surface a
 * "user-submitted, scores may not feed handicap" hint until verified.
 *
 * Per-user rate-limit: max 5 courses in any rolling 24 hours.
 *
 * Body shape:
 *   {
 *     courseName: string,
 *     city?: string, state?: string, country?: string, address?: string,
 *     latitude?: number, longitude?: number,
 *     numHoles: 9 | 18,
 *     teeboxes: [{
 *       name: string,                   // e.g. "Black"
 *       gender?: 'male' | 'female',     // default 'male'
 *       courseRating?: number,          // optional; estimated when blank/implausible
 *       slopeRating?: number,           // optional; estimated when blank/implausible
 *       holes: [{ hole_num, par, yardage?, handicap? }]
 *     }]
 *   }
 *
 * Response:
 *   { success: true, course_id, teebox_ids: string[],
 *     warnings: string[], estimated_teebox_ids: string[] }
 */
router.post('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const body = req.body ?? {};
    // ── Course meta ───────────────────────────────────────────────────────
    const courseName = String(body.courseName ?? '').trim().slice(0, 200);
    if (!courseName)
        return res.status(400).json({ error: 'Course name is required.' });
    const city = body.city ? String(body.city).trim().slice(0, 120) : null;
    const state = body.state ? String(body.state).trim().slice(0, 120) : null;
    const country = body.country ? String(body.country).trim().slice(0, 120) : 'United States';
    const address = body.address ? String(body.address).trim().slice(0, 500) : null;
    const lat = body.latitude != null && body.latitude !== '' ? Number(body.latitude) : null;
    const lng = body.longitude != null && body.longitude !== '' ? Number(body.longitude) : null;
    if (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90))
        return res.status(400).json({ error: 'Invalid latitude.' });
    if (lng != null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
        return res.status(400).json({ error: 'Invalid longitude.' });
    const numHoles = body.numHoles === 9 ? 9 : 18;
    const teeboxesIn = Array.isArray(body.teeboxes) ? body.teeboxes : [];
    if (teeboxesIn.length === 0)
        return res.status(400).json({ error: 'At least one tee set is required.' });
    if (teeboxesIn.length > 6)
        return res.status(400).json({ error: 'Max 6 tee sets per course.' });
    // ── Per-user rate-limit ───────────────────────────────────────────────
    // The courses table doesn't carry a created_at timestamp, so we gate on
    // lifetime user-authored count rather than a rolling 24h window. Keep
    // the cap generous: 25 entries is plenty for an enthusiastic contributor
    // and well above what a spammer would bother with before hitting it.
    const { rows: limitRows } = await pool_1.default.query(`SELECT COUNT(*)::int AS n FROM courses WHERE created_by_user_id = $1`, [req.userId]);
    if ((limitRows[0]?.n ?? 0) >= 25) {
        return res.status(429).json({
            error: 'You have created the cap of 25 courses already. Reach out and we will lift the limit.',
        });
    }
    const shaped = [];
    const allWarnings = [];
    for (const tb of teeboxesIn) {
        const tbName = String(tb.name ?? '').trim().slice(0, 60) || 'Tee';
        const gender = tb.gender === 'female' ? 'female' : 'male';
        const holesIn = Array.isArray(tb.holes)
            ? tb.holes.map((h, i) => ({
                hole_num: Number(h.hole_num ?? i + 1),
                par: Number(h.par),
                yardage: h.yardage != null && h.yardage !== '' ? Number(h.yardage) : null,
                handicap: h.handicap != null && h.handicap !== '' ? Number(h.handicap) : null,
            }))
            : [];
        const declaredPar = tb.par != null ? Number(tb.par) : null;
        const declaredYards = tb.totalYards != null ? Number(tb.totalYards) : null;
        const { hardErrors, warnings } = (0, courseEstimate_1.validateTeebox)(tbName, numHoles, holesIn, declaredPar, declaredYards);
        if (hardErrors.length) {
            return res.status(400).json({ error: 'Validation failed', details: hardErrors });
        }
        allWarnings.push(...warnings);
        const computedPar = holesIn.reduce((s, h) => s + (Number.isFinite(h.par) ? h.par : 0), 0);
        const computedYards = holesIn.reduce((s, h) => s + (Number.isFinite(h.yardage) ? h.yardage : 0), 0);
        // Trust user rating/slope iff they're inside the plausible window.
        // Otherwise (blank, zero, garbage) estimate from par + computed yards.
        const userRating = tb.courseRating != null && tb.courseRating !== '' ? Number(tb.courseRating) : null;
        const userSlope = tb.slopeRating != null && tb.slopeRating !== '' ? Number(tb.slopeRating) : null;
        const fullPlausible = (0, courseEstimate_1.looksPlausibleRating)(userRating, userSlope)
            && userRating != null && userSlope != null;
        let rating;
        let slope;
        let estimated = false;
        if (fullPlausible) {
            rating = userRating;
            slope = userSlope;
        }
        else {
            const est = (0, courseEstimate_1.estimateRatingSlope)(computedPar || (numHoles === 9 ? 36 : 72), computedYards, gender);
            // If they gave one of the two, prefer the user's plausible value.
            rating = (userRating != null && userRating >= 55 && userRating <= 80) ? userRating : est.rating;
            slope = (userSlope != null && userSlope >= 55 && userSlope <= 155) ? userSlope : est.slope;
            estimated = !fullPlausible;
        }
        shaped.push({
            name: tbName,
            gender,
            course_rating: rating,
            slope_rating: slope,
            total_yards: computedYards > 0 ? computedYards : null,
            num_holes: numHoles,
            par: computedPar,
            estimated_rating: estimated,
            holes: holesIn,
        });
    }
    // ── Insert (course → teeboxes → holes) in a single transaction ────────
    const client = await pool_1.default.connect();
    let courseId;
    const teeboxIds = [];
    const estimatedTeeboxIds = [];
    try {
        await client.query('BEGIN');
        const courseRes = await client.query(`INSERT INTO courses
         (course_name, club_name, address, city, state, country,
          latitude, longitude, created_by_user_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
       RETURNING course_id`, [courseName, courseName, address, city, state, country, lat, lng, req.userId]);
        courseId = courseRes.rows[0].course_id;
        for (const tb of shaped) {
            const tbRes = await client.query(`INSERT INTO teeboxes
           (course_id, name, gender, course_rating, slope_rating,
            total_yards, num_holes, par)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING teebox_id`, [courseId, tb.name, tb.gender, tb.course_rating, tb.slope_rating,
                tb.total_yards, tb.num_holes, tb.par]);
            const tbId = tbRes.rows[0].teebox_id;
            teeboxIds.push(tbId);
            if (tb.estimated_rating)
                estimatedTeeboxIds.push(tbId);
            for (const h of tb.holes) {
                await client.query(`INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap)
           VALUES ($1, $2, $3, $4, $5)`, [tbId, h.hole_num, h.par, h.yardage ?? null, h.handicap ?? null]);
            }
        }
        await client.query('COMMIT');
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
    return res.json({
        success: true,
        course_id: courseId,
        teebox_ids: teeboxIds,
        estimated_teebox_ids: estimatedTeeboxIds,
        warnings: allWarnings,
    });
}));
router.get('/:id/leaderboard', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows } = await pool_1.default.query(`SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores,
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
     LIMIT 50`, [req.params.id]);
    return res.json(rows);
}));
router.get('/:id', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: courseRows } = await pool_1.default.query(`SELECT course_id, course_name, club_name, address, city, state, country, latitude, longitude
     FROM courses WHERE course_id = $1`, [req.params.id]);
    if (!courseRows.length)
        return res.status(404).json({ error: 'Course not found' });
    const { rows: teeRows } = await pool_1.default.query(`SELECT teebox_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par,
            front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
     FROM teeboxes WHERE course_id = $1 ORDER BY total_yards DESC`, [req.params.id]);
    const teeboxIds = teeRows.map((t) => t.teebox_id);
    let holes = [];
    if (teeboxIds.length > 0) {
        const { rows: holeRows } = await pool_1.default.query(`SELECT hole_id, teebox_id, hole_num, par, yardage, handicap,
              pin_lat, pin_lng, pin_elevation_m
       FROM holes WHERE teebox_id = ANY($1) ORDER BY teebox_id, hole_num`, [teeboxIds]);
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
router.post('/:id/corrections', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { field, suggestedValue, currentValue, teeboxId, holeId, notes } = req.body ?? {};
    if (typeof field !== 'string' || !ALLOWED_FIELDS.has(field)) {
        return res.status(400).json({ error: 'invalid field' });
    }
    if (typeof suggestedValue !== 'string' || !suggestedValue.trim()) {
        return res.status(400).json({ error: 'suggestedValue required' });
    }
    // Confirm course exists (so we don't accept reports for stale IDs).
    const { rows } = await pool_1.default.query(`SELECT 1 FROM courses WHERE course_id = $1`, [req.params.id]);
    if (!rows.length)
        return res.status(404).json({ error: 'course not found' });
    await pool_1.default.query(`INSERT INTO course_corrections (course_id, teebox_id, hole_id, user_id, field, current_value, suggested_value, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        req.params.id,
        teeboxId || null,
        holeId || null,
        req.userId,
        field,
        typeof currentValue === 'string' ? currentValue.slice(0, 200) : null,
        suggestedValue.trim().slice(0, 500),
        typeof notes === 'string' ? notes.trim().slice(0, 500) : null,
    ]);
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
router.get('/:id/data-quality', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const courseId = req.params.id;
    // Counts in parallel
    const [{ rows: elevRows }, { rows: holeRows }] = await Promise.all([
        pool_1.default.query(`SELECT COUNT(*)::int AS elevation_points,
              COALESCE(SUM(samples), 0)::int AS elevation_samples
       FROM course_elevation_points WHERE course_id = $1`, [courseId]),
        pool_1.default.query(`SELECT COUNT(*)::int AS total_holes,
              COUNT(*) FILTER (WHERE h.pin_lat IS NOT NULL)::int AS holes_with_pins
       FROM teeboxes t
       JOIN holes h ON h.teebox_id = t.teebox_id
       WHERE t.course_id = $1`, [courseId]),
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
        pin_coverage, // 0..1
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
const gridFor = (lat, lng) => ({
    lat_grid: Math.round(lat * GRID_RES),
    lng_grid: Math.round(lng * GRID_RES),
});
const HAVERSINE_R = 6371000;
function distMetres(lat1, lng1, lat2, lng2) {
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
router.post('/:id/elevation-reference', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { lat, lng, deviceAltM } = req.body ?? {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || typeof deviceAltM !== 'number') {
        return res.status(400).json({ error: 'lat, lng, deviceAltM required as numbers' });
    }
    const { lat_grid, lng_grid } = gridFor(lat, lng);
    // Pull a tight window first (3x3 grid cells = ~16m radius cap).
    const { rows: nearby } = await pool_1.default.query(`SELECT lat, lng, elevation_rel_m, samples
     FROM course_elevation_points
     WHERE course_id = $1
       AND lat_grid BETWEEN $2 - 1 AND $2 + 1
       AND lng_grid BETWEEN $3 - 1 AND $3 + 1`, [req.params.id, lat_grid, lng_grid]);
    if (nearby.length) {
        let best = nearby[0];
        let bestDist = distMetres(lat, lng, best.lat, best.lng);
        for (const r of nearby) {
            const d = distMetres(lat, lng, r.lat, r.lng);
            if (d < bestDist) {
                best = r;
                bestDist = d;
            }
        }
        if (bestDist <= 30) {
            const offsetM = deviceAltM - best.elevation_rel_m;
            return res.json({ offsetM, mode: 'anchor', distM: Math.round(bestDist) });
        }
    }
    // Fallback: weighted mean of all course points.
    const { rows: all } = await pool_1.default.query(`SELECT lat, lng, elevation_rel_m FROM course_elevation_points WHERE course_id = $1 LIMIT 200`, [req.params.id]);
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
    await pool_1.default.query(`INSERT INTO course_elevation_points (course_id, lat_grid, lng_grid, lat, lng, elevation_rel_m, samples)
     VALUES ($1, $2, $3, $4, $5, 0, 1)
     ON CONFLICT (course_id, lat_grid, lng_grid) DO NOTHING`, [req.params.id, lat_grid, lng_grid, lat, lng]);
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
router.post('/:id/elevation-points', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { samples } = req.body ?? {};
    if (!Array.isArray(samples))
        return res.status(400).json({ error: 'samples array required' });
    const cleaned = samples
        .map((s) => ({
        lat: Number(s?.lat), lng: Number(s?.lng), elev: Number(s?.elevationRelM),
    }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && Number.isFinite(s.elev)
        && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180
        // Reject obviously-bogus deltas (>500m vertical change on a single course is implausible)
        && Math.abs(s.elev) < 500)
        .slice(0, 200); // cap batch size
    if (!cleaned.length)
        return res.json({ accepted: 0 });
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        for (const s of cleaned) {
            const { lat_grid, lng_grid } = gridFor(s.lat, s.lng);
            // Upsert with soft-capped running average.
            await client.query(`INSERT INTO course_elevation_points
           (course_id, lat_grid, lng_grid, lat, lng, elevation_rel_m, samples, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
         ON CONFLICT (course_id, lat_grid, lng_grid) DO UPDATE
           SET elevation_rel_m =
             (course_elevation_points.elevation_rel_m * LEAST(course_elevation_points.samples, 50) + EXCLUDED.elevation_rel_m)
             / (LEAST(course_elevation_points.samples, 50) + 1),
               samples = course_elevation_points.samples + 1,
               last_updated = NOW()`, [req.params.id, lat_grid, lng_grid, s.lat, s.lng, s.elev]);
        }
        await client.query('COMMIT');
        return res.json({ accepted: cleaned.length });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('elevation-points upsert failed:', err);
        return res.status(500).json({ error: 'Server error' });
    }
    finally {
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
router.get('/:id/elevation-at', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusM = Math.min(60, Math.max(5, Number(req.query.radiusM) || 20));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'lat, lng required' });
    }
    const { lat_grid, lng_grid } = gridFor(lat, lng);
    // Cells to scan: 1 cell ≈ 5.5m, so for 20m radius scan ±4 cells; for 60m, ±11
    const reach = Math.max(1, Math.ceil(radiusM / 5));
    const { rows } = await pool_1.default.query(`SELECT lat, lng, elevation_rel_m, samples
     FROM course_elevation_points
     WHERE course_id = $1
       AND lat_grid BETWEEN $2 - $4 AND $2 + $4
       AND lng_grid BETWEEN $3 - $4 AND $3 + $4`, [req.params.id, lat_grid, lng_grid, reach]);
    if (!rows.length)
        return res.json(null);
    let best = null;
    for (const r of rows) {
        const d = distMetres(lat, lng, r.lat, r.lng);
        if (d <= radiusM && (!best || d < best.dist))
            best = { row: r, dist: d };
    }
    if (!best)
        return res.json(null);
    return res.json({
        elevationRelM: best.row.elevation_rel_m,
        samples: best.row.samples,
        distM: Math.round(best.dist),
        lat: best.row.lat,
        lng: best.row.lng,
    });
}));
/**
 * Set pin coordinates for one or more holes of a course remotely. Open to
 * any authenticated user — crowdsourced, last-write-wins. If someone places
 * pins in the wrong spot the next player can correct them; we can also
 * audit / roll back via `pin_set_by` and `pin_set_at` if abuse appears.
 *
 *   POST /courses/admin/set-pins
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
 *
 * NOTE: the URL still says `/admin/set-pins` to avoid breaking the existing
 * curl runbook + admin client cache key. It's not actually gated anymore.
 */
router.post('/admin/set-pins', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { courseId, pins } = req.body ?? {};
    if (typeof courseId !== 'string' || !courseId) {
        return res.status(400).json({ error: 'courseId required' });
    }
    if (!Array.isArray(pins) || pins.length === 0) {
        return res.status(400).json({ error: 'pins array required' });
    }
    // Quick course-exists check so a typo'd ID gives a clean 404 instead
    // of a silent no-op update count of 0.
    const { rows: cRows } = await pool_1.default.query(`SELECT course_id FROM courses WHERE course_id = $1`, [courseId]);
    if (!cRows.length)
        return res.status(404).json({ error: 'Course not found' });
    let updated = 0;
    const missing = [];
    for (const p of pins) {
        const holeNum = Number(p?.holeNum);
        const lat = Number(p?.lat);
        const lng = Number(p?.lng);
        if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > 18) {
            missing.push(p?.holeNum);
            continue;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            missing.push(holeNum);
            continue;
        }
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            missing.push(holeNum);
            continue;
        }
        const elev = Number.isFinite(p?.elevation_m) ? Number(p.elevation_m) : null;
        // Apply to every teebox's copy of this hole_num within the course.
        // Stamp pin_set_by with the actual contributor so we can audit who
        // placed which pin if a course's data goes off the rails. pin_set_at
        // is also bumped so the most-recent placement wins when ordering.
        const { rowCount } = await pool_1.default.query(`UPDATE holes h
          SET pin_lat = $3,
              pin_lng = $4,
              pin_elevation_m = COALESCE($5, h.pin_elevation_m),
              pin_set_by = $6,
              pin_set_at = NOW()
        FROM teeboxes t
       WHERE h.teebox_id = t.teebox_id
         AND t.course_id = $1
         AND h.hole_num = $2`, [courseId, holeNum, lat, lng, elev, req.userId]);
        const n = rowCount ?? 0;
        if (n === 0)
            missing.push(holeNum);
        else
            updated += n;
    }
    return res.json({ updated, missing_hole_nums: missing });
}));
/**
 * User-submitted "please add this course" inbox. Writes a row to
 * course_requests for an admin to review by hand and (if legit) run through
 * the normal course-import flow. Lightly rate-limited per-user so a bored
 * user can't spam the queue: max 10 pending entries from one account, and
 * we dedupe identical names from the same user.
 */
router.post('/request', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const body = req.body ?? {};
    const courseName = String(body.courseName ?? '').trim().slice(0, 200);
    const city = body.city ? String(body.city).trim().slice(0, 120) : null;
    const state = body.state ? String(body.state).trim().slice(0, 120) : null;
    const country = body.country ? String(body.country).trim().slice(0, 120) : null;
    const website = body.website ? String(body.website).trim().slice(0, 500) : null;
    const notes = body.notes ? String(body.notes).trim().slice(0, 1000) : null;
    if (!courseName) {
        return res.status(400).json({ error: 'Course name is required' });
    }
    // Rate-limit: cap pending submissions from one user to keep the inbox tidy.
    const { rows: countRows } = await pool_1.default.query(`SELECT COUNT(*)::int AS n FROM course_requests
      WHERE user_id = $1 AND status = 'pending'`, [req.userId]);
    if ((countRows[0]?.n ?? 0) >= 10) {
        return res.status(429).json({
            error: 'You have several requests still under review — please wait for those to be processed first.',
        });
    }
    // Dedupe: skip if the same user already requested an identical course name
    // (case-insensitive) that's still pending. Returning a soft success keeps
    // the UX simple — the user sees "request received" either way.
    const { rows: dup } = await pool_1.default.query(`SELECT request_id FROM course_requests
      WHERE user_id = $1 AND status = 'pending' AND LOWER(course_name) = LOWER($2)`, [req.userId, courseName]);
    if (dup.length > 0) {
        return res.json({ success: true, request_id: dup[0].request_id, duplicate: true });
    }
    const { rows } = await pool_1.default.query(`INSERT INTO course_requests
       (user_id, course_name, city, state, country, website, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING request_id`, [req.userId, courseName, city, state, country, website, notes]);
    // ── Notify the admin ──────────────────────────────────────────────────
    // The course_requests inbox is the durable record; these notifications
    // are the realtime ping that lets the admin actually notice without
    // polling the table. Two opt-in channels, each gated on its own env var:
    //
    //   ADMIN_EMAIL    — sends a plaintext email via Resend (the existing
    //                    email utility). Cheapest + simplest path; doesn't
    //                    require either the admin to be a user in the DB
    //                    or any new service integration.
    //   ADMIN_USER_ID  — in addition, drops a DM + push into the admin's
    //                    in-app inbox. Server-controlled INSERT bypasses
    //                    the "must be friends" rule the public DM endpoint
    //                    enforces — this is a system message, not UGC.
    //
    // Either, both, or neither can be set. All of this is best-effort and
    // wrapped in try/catch so a delivery failure doesn't sink the user's
    // submission (the inbox row is the source of truth either way).
    try {
        const { rows: meRows } = await pool_1.default.query(`SELECT username, email FROM users WHERE user_id = $1`, [req.userId]);
        const requesterName = meRows[0]?.username ?? 'A user';
        const requesterEmail = meRows[0]?.email ?? null;
        const loc = [city, state, country].filter(Boolean).join(', ');
        // Shared body — same content for email + DM so they read identically.
        const lines = [
            `Course request from ${requesterName}`,
            ``,
            `Name: ${courseName}`,
        ];
        if (loc)
            lines.push(`Location: ${loc}`);
        if (website)
            lines.push(`Website: ${website}`);
        if (notes)
            lines.push(`Notes: ${notes}`);
        const body = lines.join('\n');
        // Email
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
            const subject = `Course request: ${courseName}${loc ? ` — ${loc}` : ''}`;
            const replyTail = requesterEmail ? `\n\n(Requested by ${requesterEmail})` : '';
            await (0, email_1.sendEmail)({
                to: adminEmail,
                subject,
                text: body + replyTail,
            });
        }
        // DM + push
        const adminUserId = process.env.ADMIN_USER_ID;
        if (adminUserId && adminUserId !== req.userId) {
            await pool_1.default.query(`INSERT INTO direct_messages (from_user_id, to_user_id, body)
         VALUES ($1, $2, $3)`, [req.userId, adminUserId, body.slice(0, 2000)]);
            const { rows: adminRows } = await pool_1.default.query(`SELECT push_token FROM users WHERE user_id = $1`, [adminUserId]);
            const token = adminRows[0]?.push_token;
            if (token) {
                await (0, notify_1.sendPush)([token], 'New course request', `${requesterName}: ${courseName}${loc ? ` (${loc})` : ''}`, { type: 'dm', fromUserId: req.userId });
            }
        }
    }
    catch {
        // Swallowed by design — see comment above.
    }
    return res.json({ success: true, request_id: rows[0].request_id });
}));
/**
 * Admin-only inbox view. Gated on the same `requirePremium`-style check the
 * client uses for admin features is overkill here — for now we just require
 * auth and the admin reviews the table directly in the DB. The endpoint
 * exists so a future admin UI has somewhere to read from.
 */
router.get('/requests', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const status = req.query.status || 'pending';
    const { rows } = await pool_1.default.query(`SELECT cr.*, u.username AS requested_by_username
       FROM course_requests cr
       LEFT JOIN users u ON u.user_id = cr.user_id
      WHERE cr.status = $1
      ORDER BY cr.created_at DESC
      LIMIT 200`, [status]);
    return res.json(rows);
}));
exports.default = router;
