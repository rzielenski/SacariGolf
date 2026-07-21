import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';
import { sendPush } from '../utils/notify';
import { sendEmail } from '../utils/email';
import {
  estimateRatingSlope, looksPlausibleRating, validateTeebox, HoleInput,
} from '../utils/courseEstimate';
import { scanScorecard, ScorecardScanError } from '../utils/scorecardScan';
import { perUserRateLimit } from '../utils/rateLimit';

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
  // Cap length and strip LIKE wildcards (% and _) so a wildcard-bomb can't force
  // a full-table ILIKE scan — same hardening as the user search.
  const q = ((req.query.q as string) || '').slice(0, 80).replace(/[%_]/g, '');
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
router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const body = req.body ?? {};

  // ── Course meta ───────────────────────────────────────────────────────
  const courseName = String(body.courseName ?? '').trim().slice(0, 200);
  if (!courseName) return res.status(400).json({ error: 'Course name is required.' });

  const city    = body.city    ? String(body.city).trim().slice(0, 120)    : null;
  const state   = body.state   ? String(body.state).trim().slice(0, 120)   : null;
  const country = body.country ? String(body.country).trim().slice(0, 120) : 'United States';
  const address = body.address ? String(body.address).trim().slice(0, 500) : null;

  const lat = body.latitude  != null && body.latitude  !== '' ? Number(body.latitude)  : null;
  const lng = body.longitude != null && body.longitude !== '' ? Number(body.longitude) : null;
  if (lat != null && (!Number.isFinite(lat) || lat < -90  || lat > 90))  return res.status(400).json({ error: 'Invalid latitude.' });
  if (lng != null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return res.status(400).json({ error: 'Invalid longitude.' });

  const numHoles = body.numHoles === 9 ? 9 : 18;

  const teeboxesIn = Array.isArray(body.teeboxes) ? body.teeboxes : [];
  if (teeboxesIn.length === 0) return res.status(400).json({ error: 'At least one tee set is required.' });
  if (teeboxesIn.length > 6)   return res.status(400).json({ error: 'Max 6 tee sets per course.' });

  // ── Per-user rate-limit ───────────────────────────────────────────────
  // The courses table doesn't carry a created_at timestamp, so we gate on
  // lifetime user-authored count rather than a rolling 24h window. Keep
  // the cap generous: 25 entries is plenty for an enthusiastic contributor
  // and well above what a spammer would bother with before hitting it.
  const { rows: limitRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM courses WHERE created_by_user_id = $1`,
    [req.userId]
  );
  if ((limitRows[0]?.n ?? 0) >= 25) {
    return res.status(429).json({
      error: 'You have created the cap of 25 courses already. Reach out and we will lift the limit.',
    });
  }

  // ── Validate + shape every teebox ─────────────────────────────────────
  interface ShapedTeebox {
    name: string;
    gender: 'male' | 'female';
    course_rating: number;
    slope_rating: number;
    total_yards: number | null;
    num_holes: number;
    par: number;
    estimated_rating: boolean;
    holes: HoleInput[];
  }
  const shaped: ShapedTeebox[] = [];
  const allWarnings: string[] = [];

  for (const tb of teeboxesIn) {
    const tbName: string = String(tb.name ?? '').trim().slice(0, 60) || 'Tee';
    const gender: 'male' | 'female' = tb.gender === 'female' ? 'female' : 'male';

    const holesIn: HoleInput[] = Array.isArray(tb.holes)
      ? tb.holes.map((h: any, i: number) => ({
          hole_num: Number(h.hole_num ?? i + 1),
          par:      Number(h.par),
          yardage:  h.yardage  != null && h.yardage  !== '' ? Number(h.yardage)  : null,
          handicap: h.handicap != null && h.handicap !== '' ? Number(h.handicap) : null,
        }))
      : [];

    const declaredPar   = tb.par         != null ? Number(tb.par)         : null;
    const declaredYards = tb.totalYards  != null ? Number(tb.totalYards)  : null;

    const { hardErrors, warnings } = validateTeebox(
      tbName, numHoles, holesIn, declaredPar, declaredYards,
    );
    if (hardErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: hardErrors });
    }
    allWarnings.push(...warnings);

    const computedPar   = holesIn.reduce((s, h) => s + (Number.isFinite(h.par)     ? h.par     : 0), 0);
    const computedYards = holesIn.reduce((s, h) => s + (Number.isFinite(h.yardage as number) ? (h.yardage as number) : 0), 0);

    // Trust user rating/slope iff they're inside the plausible window.
    // Otherwise (blank, zero, garbage) estimate from par + computed yards.
    const userRating = tb.courseRating != null && tb.courseRating !== '' ? Number(tb.courseRating) : null;
    const userSlope  = tb.slopeRating  != null && tb.slopeRating  !== '' ? Number(tb.slopeRating)  : null;
    const fullPlausible = looksPlausibleRating(userRating, userSlope, numHoles)
                          && userRating != null && userSlope != null;
    // Plausible windows differ by hole count: 9-hole tees are half-scale.
    const ratingMin = numHoles === 9 ? 27 : 55, ratingMax = numHoles === 9 ? 42 : 80;
    const slopeMin  = numHoles === 9 ? 40 : 55, slopeMax  = numHoles === 9 ? 90 : 155;

    let rating: number;
    let slope: number;
    let estimated = false;
    if (fullPlausible) {
      rating = userRating as number;
      slope  = userSlope as number;
    } else {
      const est = estimateRatingSlope(computedPar || (numHoles === 9 ? 36 : 72), computedYards, gender, numHoles);
      // If they gave one of the two, prefer the user's plausible value.
      rating = (userRating != null && userRating >= ratingMin && userRating <= ratingMax) ? userRating : est.rating;
      slope  = (userSlope  != null && userSlope  >= slopeMin  && userSlope  <= slopeMax)  ? userSlope  : est.slope;
      estimated = !fullPlausible;
    }

    shaped.push({
      name: tbName,
      gender,
      course_rating: rating,
      slope_rating:  slope,
      total_yards:   computedYards > 0 ? computedYards : null,
      num_holes:     numHoles,
      par:           computedPar,
      estimated_rating: estimated,
      holes: holesIn,
    });
  }

  // ── Insert (course → teeboxes → holes) in a single transaction ────────
  const client = await pool.connect();
  let courseId: string;
  const teeboxIds: string[] = [];
  const estimatedTeeboxIds: string[] = [];
  try {
    await client.query('BEGIN');

    const courseRes = await client.query(
      `INSERT INTO courses
         (course_name, club_name, address, city, state, country,
          latitude, longitude, created_by_user_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
       RETURNING course_id`,
      [courseName, courseName, address, city, state, country, lat, lng, req.userId],
    );
    courseId = courseRes.rows[0].course_id;

    for (const tb of shaped) {
      const tbRes = await client.query(
        `INSERT INTO teeboxes
           (course_id, name, gender, course_rating, slope_rating,
            total_yards, num_holes, par)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING teebox_id`,
        [courseId, tb.name, tb.gender, tb.course_rating, tb.slope_rating,
         tb.total_yards, tb.num_holes, tb.par],
      );
      const tbId = tbRes.rows[0].teebox_id;
      teeboxIds.push(tbId);
      if (tb.estimated_rating) estimatedTeeboxIds.push(tbId);

      for (const h of tb.holes) {
        await client.query(
          `INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap)
           VALUES ($1, $2, $3, $4, $5)`,
          [tbId, h.hole_num, h.par, h.yardage ?? null, h.handicap ?? null],
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
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

/**
 * Scorecard OCR. The in-app course builder posts a photo of a paper
 * scorecard here; we relay it to Claude's vision API and return structured
 * tee/hole data the builder drops straight into its form, so a player can add
 * a course by snapping one photo instead of typing ~90 numbers.
 *
 * The image is NOT persisted — it's relayed to Anthropic and discarded; only
 * the parsed numbers come back.
 *
 *   POST /courses/scan-scorecard
 *     body: { imageBase64: string, mimeType: 'image/jpeg' | 'image/png' }
 *   response: { courseName?, city?, state?, numHoles, teeboxes[], warnings[] }
 */
router.post('/scan-scorecard', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  const mediaType = mimeType === 'image/png' ? 'image/png'
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'image/jpeg'
    : null;
  if (!mediaType) return res.status(400).json({ error: 'Only PNG and JPEG images are allowed' });

  // Size cap (5 MB decoded). express.json is capped at 8mb, so a base64
  // payload above ~5 MB binary risks bouncing off the body-parser limit
  // before it even reaches here.
  const approxBytes = Math.floor((imageBase64.length * 3) / 4);
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image must be 5 MB or smaller' });
  }

  // Per-user daily cap. Every scan that reaches the vision API costs money, so
  // we gate on billed attempts in the trailing 24h (counted from the
  // scorecard_scans log below), NOT on courses actually added. This is the
  // hard stop against a bored or malicious user spamming the endpoint to run
  // up the API bill. The Anthropic Console spend limit is the global backstop.
  const SCAN_DAILY_CAP = 20;
  const { rows: capRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scorecard_scans
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [req.userId],
  );
  if ((capRows[0]?.n ?? 0) >= SCAN_DAILY_CAP) {
    return res.status(429).json({
      error: `You've reached the daily limit of ${SCAN_DAILY_CAP} scorecard scans. Try again tomorrow, or enter the course manually.`,
    });
  }

  // Log a billed attempt so it counts against the cap. We only count outcomes
  // where Anthropic actually returned a 200 and generated tokens (success, or
  // a 422 "couldn't read / refused" — both are billed). Pre-flight failures
  // (no key → 503) and transport/API errors (→ 502, not billed by Anthropic)
  // don't consume the user's quota.
  const logScan = () =>
    pool.query(`INSERT INTO scorecard_scans (user_id) VALUES ($1)`, [req.userId]).catch(() => {});

  try {
    const result = await scanScorecard(imageBase64, mediaType);
    await logScan();
    return res.json(result);
  } catch (e) {
    if (e instanceof ScorecardScanError) {
      if (e.status === 422) await logScan();
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }
}));

router.get('/:id/leaderboard', requireAuth, wrap(async (req: Request, res: Response) => {
  // Separate boards, selected by query params:
  //   • format = solo (default) | scramble. Solo board counts SOLO ranked
  //     rounds only; scramble board counts scramble-format team rounds (each
  //     player carries the shared team score — mirrored rounds).
  //   • holes = 9 | 18 (default 18). Boards are per round LENGTH so raw
  //     strokes compare like-for-like (a 9-hole course's "18" board is the
  //     played-9-twice card; an 18-hole course's "9" board is front/back
  //     nines). This replaced one mixed board where DISTINCT ON kept a single
  //     row per player across ALL formats/lengths — if your best was a
  //     scramble, your solo round vanished entirely.
  // One row per player (their best), ranked by RAW to-par within the board.
  // `to_par` (the 18-hole-equivalent normalized differential) is still
  // returned — clients show it as the labeled secondary figure.
  const format = req.query.format === 'scramble' ? 'scramble' : 'solo';
  const holes = String(req.query.holes ?? '18') === '9' ? 9 : 18;
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (r.user_id)
              r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores,
              array_length(r.hole_scores, 1) AS holes_played,
              r.normalized_to_par AS to_par,
              pp.par_played,
              (r.total_score - pp.par_played)::int AS raw_to_par,
              u.username, u.user_id, u.avatar_url,
              t.teebox_id, t.name AS teebox_name, t.par, t.num_holes,
              m.match_type, m.format
         FROM rounds r
         JOIN users u ON u.user_id = r.user_id
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
         JOIN matches m ON m.match_id = r.match_id
         CROSS JOIN LATERAL (
           -- Par for the holes ACTUALLY played, so raw to-par is honest:
           -- full card = teebox par; 9-hole course played twice = par * 2;
           -- front/back nine of an 18 = that nine's summed par.
           SELECT CASE
             WHEN array_length(r.hole_scores, 1) = t.num_holes THEN t.par
             WHEN array_length(r.hole_scores, 1) = 18 AND t.num_holes = 9 THEN t.par * 2
             WHEN array_length(r.hole_scores, 1) = 9 AND t.num_holes = 18 THEN
               (SELECT SUM(h.par)::int FROM holes h
                 WHERE h.teebox_id = t.teebox_id
                   AND h.hole_num >= CASE WHEN m.holes_subset = 'back' THEN 10 ELSE 1 END
                   AND h.hole_num <= CASE WHEN m.holes_subset = 'back' THEN 18 ELSE 9 END)
             ELSE NULL
           END AS par_played
         ) pp
        WHERE t.course_id = $1
          AND m.completed = true AND m.is_practice = false
          AND u.is_bot = false
          AND r.total_score IS NOT NULL
          AND array_length(r.hole_scores, 1) = $2
          AND pp.par_played IS NOT NULL
          AND (CASE WHEN $3 = 'scramble'
                    THEN m.format = 'scramble'
                    ELSE m.match_type = 'solo' AND COALESCE(m.format, 'stroke') <> 'scramble' END)
        ORDER BY r.user_id, (r.total_score - pp.par_played) ASC, r.created_at ASC
     ) best
     ORDER BY raw_to_par ASC, total_score ASC, created_at ASC
     LIMIT 50`,
    [req.params.id, holes, format]
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
              pin_lat, pin_lng, pin_elevation_m, tee_lat, tee_lng
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
router.post('/admin/set-pins', requireAuth,
  // NOT admin-gated. The "Place / Correct Pins" screen is offered to every
  // player from the course page, and pin coverage is what unlocks distance /
  // slope / weather for everyone, so gating this behind an admin token broke
  // the whole crowd-sourcing loop (every contributor just got a 403).
  // Abuse is contained WITHOUT locking contributors out: this per-user rate
  // limit caps mass overwrites, `pin_set_by` / `pin_set_at` leave an audit
  // trail to roll back, and last-write-wins lets the next player correct a bad
  // pin. In-round per-player contributions still flow through /matches/:id/pin.
  perUserRateLimit({ max: 15, windowMs: 60_000 }),
  wrap(async (req: any, res: Response) => {
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
    // Stamp pin_set_by with the actual contributor so we can audit who
    // placed which pin if a course's data goes off the rails. pin_set_at
    // is also bumped so the most-recent placement wins when ordering.
    const { rowCount } = await pool.query(
      `UPDATE holes h
          SET pin_lat = $3,
              pin_lng = $4,
              pin_elevation_m = COALESCE($5, h.pin_elevation_m),
              pin_set_by = $6,
              pin_set_at = NOW()
        FROM teeboxes t
       WHERE h.teebox_id = t.teebox_id
         AND t.course_id = $1
         AND h.hole_num = $2`,
      [courseId, holeNum, lat, lng, elev, req.userId]
    );
    const n = rowCount ?? 0;
    if (n === 0) missing.push(holeNum);
    else updated += n;
  }
  return res.json({ updated, missing_hole_nums: missing });
}));

/**
 * POST /courses/admin/set-teeboxes
 *   body: { teeboxId, tees: [{ holeNum, lat, lng }] }
 *
 * Tee markers for the course-preview feature. Unlike pins, a tee box is
 * specific to ONE teebox set (the Black tee and Red tee start in different
 * places), so this writes only to the given teebox's holes. Crowd-sourced,
 * last-write-wins, stamped with the contributor like pins.
 *
 * Response: { updated: N, missing_hole_nums: [...] }
 */
router.post('/admin/set-teeboxes', requireAuth,
  // Same story as set-pins: the "Mark Tee Boxes" button sits next to
  // "Place / Correct Pins" on the course page and is open to every player, so
  // an admin token here 403'd every legitimate contributor. Rate-limited +
  // stamped with the contributor + last-write-wins instead.
  perUserRateLimit({ max: 15, windowMs: 60_000 }),
  wrap(async (req: any, res: Response) => {
  const { teeboxId, tees } = req.body ?? {};
  if (typeof teeboxId !== 'string' || !teeboxId) {
    return res.status(400).json({ error: 'teeboxId required' });
  }
  if (!Array.isArray(tees) || tees.length === 0) {
    return res.status(400).json({ error: 'tees array required' });
  }
  const { rows: tRows } = await pool.query(
    `SELECT teebox_id FROM teeboxes WHERE teebox_id = $1`, [teeboxId]
  );
  if (!tRows.length) return res.status(404).json({ error: 'Teebox not found' });

  let updated = 0;
  const missing: number[] = [];
  for (const tee of tees) {
    const holeNum = Number(tee?.holeNum);
    const lat = Number(tee?.lat);
    const lng = Number(tee?.lng);
    if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > 18) { missing.push(tee?.holeNum); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { missing.push(holeNum); continue; }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { missing.push(holeNum); continue; }
    const { rowCount } = await pool.query(
      `UPDATE holes
          SET tee_lat = $3, tee_lng = $4, tee_set_by = $5, tee_set_at = NOW()
        WHERE teebox_id = $1 AND hole_num = $2`,
      [teeboxId, holeNum, lat, lng, req.userId]
    );
    const n = rowCount ?? 0;
    if (n === 0) missing.push(holeNum);
    else updated += n;
  }
  return res.json({ updated, missing_hole_nums: missing });
}));

/**
 * GET /courses/:id/my-shots
 *
 * The requesting user's tracked shots across all rounds on this course,
 * keyed for the course-preview per-hole heatmap. Returns a flat list the
 * client groups by hole_num — each row is one shot's start→end segment.
 */
router.get('/:id/my-shots', requireAuth, wrap(async (req: any, res: Response) => {
  const { rows } = await pool.query(
    `SELECT s.hole_num, s.club, s.shot_index,
            s.start_lat, s.start_lng, s.end_lat, s.end_lng, s.total_yds
       FROM shots s
       JOIN holes h ON h.hole_id = s.hole_id
       JOIN teeboxes t ON t.teebox_id = h.teebox_id
      WHERE t.course_id = $1 AND s.user_id = $2
        AND s.start_lat IS NOT NULL AND s.end_lat IS NOT NULL
      ORDER BY s.hole_num, s.shot_index
      LIMIT 3000`,
    [req.params.id, req.userId]
  );
  return res.json({ shots: rows });
}));

/**
 * User-submitted "please add this course" inbox. Writes a row to
 * course_requests for an admin to review by hand and (if legit) run through
 * the normal course-import flow. Lightly rate-limited per-user so a bored
 * user can't spam the queue: max 10 pending entries from one account, and
 * we dedupe identical names from the same user.
 */
router.post('/request', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const body = req.body ?? {};
  const courseName = String(body.courseName ?? '').trim().slice(0, 200);
  const city       = body.city    ? String(body.city).trim().slice(0, 120)    : null;
  const state      = body.state   ? String(body.state).trim().slice(0, 120)   : null;
  const country    = body.country ? String(body.country).trim().slice(0, 120) : null;
  const website    = body.website ? String(body.website).trim().slice(0, 500) : null;
  const notes      = body.notes   ? String(body.notes).trim().slice(0, 1000)  : null;

  if (!courseName) {
    return res.status(400).json({ error: 'Course name is required' });
  }

  // Rate-limit: cap pending submissions from one user to keep the inbox tidy.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM course_requests
      WHERE user_id = $1 AND status = 'pending'`,
    [req.userId]
  );
  if ((countRows[0]?.n ?? 0) >= 10) {
    return res.status(429).json({
      error: 'You have several requests still under review — please wait for those to be processed first.',
    });
  }

  // Dedupe: skip if the same user already requested an identical course name
  // (case-insensitive) that's still pending. Returning a soft success keeps
  // the UX simple — the user sees "request received" either way.
  const { rows: dup } = await pool.query(
    `SELECT request_id FROM course_requests
      WHERE user_id = $1 AND status = 'pending' AND LOWER(course_name) = LOWER($2)`,
    [req.userId, courseName]
  );
  if (dup.length > 0) {
    return res.json({ success: true, request_id: dup[0].request_id, duplicate: true });
  }

  const { rows } = await pool.query(
    `INSERT INTO course_requests
       (user_id, course_name, city, state, country, website, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING request_id`,
    [req.userId, courseName, city, state, country, website, notes]
  );

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
    const { rows: meRows } = await pool.query(
      `SELECT username, email FROM users WHERE user_id = $1`, [req.userId]
    );
    const requesterName = meRows[0]?.username ?? 'A user';
    const requesterEmail = meRows[0]?.email ?? null;
    const loc = [city, state, country].filter(Boolean).join(', ');

    // Shared body — same content for email + DM so they read identically.
    const lines = [
      `Course request from ${requesterName}`,
      ``,
      `Name: ${courseName}`,
    ];
    if (loc)     lines.push(`Location: ${loc}`);
    if (website) lines.push(`Website: ${website}`);
    if (notes)   lines.push(`Notes: ${notes}`);
    const body = lines.join('\n');

    // Email
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const subject = `Course request: ${courseName}${loc ? ` — ${loc}` : ''}`;
      const replyTail = requesterEmail ? `\n\n(Requested by ${requesterEmail})` : '';
      await sendEmail({
        to: adminEmail,
        subject,
        text: body + replyTail,
      });
    }

    // DM + push
    const adminUserId = process.env.ADMIN_USER_ID;
    if (adminUserId && adminUserId !== req.userId) {
      await pool.query(
        `INSERT INTO direct_messages (from_user_id, to_user_id, body)
         VALUES ($1, $2, $3)`,
        [req.userId, adminUserId, body.slice(0, 2000)]
      );
      const { rows: adminRows } = await pool.query(
        `SELECT push_token FROM users WHERE user_id = $1`, [adminUserId]
      );
      const token = adminRows[0]?.push_token;
      if (token) {
        await sendPush(
          [token],
          'New course request',
          `${requesterName}: ${courseName}${loc ? ` (${loc})` : ''}`,
          { type: 'dm', fromUserId: req.userId },
        );
      }
    }
  } catch {
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
router.get('/requests', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const status = (req.query.status as string) || 'pending';
  const { rows } = await pool.query(
    `SELECT cr.*, u.username AS requested_by_username
       FROM course_requests cr
       LEFT JOIN users u ON u.user_id = cr.user_id
      WHERE cr.status = $1
      ORDER BY cr.created_at DESC
      LIMIT 200`,
    [status]
  );
  return res.json(rows);
}));

export default router;
