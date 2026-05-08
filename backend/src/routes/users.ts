import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';
import { aggregateSG, Shot, Lie } from '../utils/sg';

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const router = Router();

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.email, u.elo, u.total_matches, u.total_wins, u.total_ties,
            u.avatar_url, u.created_at,
            u.handicap_index, u.bio, u.home_course_id, u.email_verified,
            u.is_premium, u.premium_since, u.premium_until, u.premium_plan,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state,
            c.latitude AS home_course_lat, c.longitude AS home_course_lng
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
}));

router.patch('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex, username, bio, homeCourseId } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  if (pushToken !== undefined) { values.push(pushToken); updates.push(`push_token = $${values.length}`); }
  if (handicapIndex !== undefined) {
    const hi = parseFloat(handicapIndex);
    if (isNaN(hi) || hi < 0 || hi > 54) return res.status(400).json({ error: 'handicapIndex must be 0–54' });
    values.push(hi); updates.push(`handicap_index = $${values.length}`);
  }
  if (bio !== undefined) {
    const trimmed = (bio ?? '').toString().slice(0, 280);
    values.push(trimmed || null); updates.push(`bio = $${values.length}`);
  }
  if (homeCourseId !== undefined) {
    values.push(homeCourseId || null); updates.push(`home_course_id = $${values.length}`);
  }
  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, or underscores' });
    }
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM users WHERE username = $1 AND user_id != $2`,
      [username, req.userId]
    );
    if (existing.length) return res.status(409).json({ error: 'Username already taken' });
    values.push(username); updates.push(`username = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${values.length}`,
    values
  );
  return res.json({ success: true });
}));

router.get('/search', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const raw = String(req.query.q ?? '').trim();
  if (!raw) return res.json([]);
  // Cap query length and strip pattern wildcards so a long/% input can't
  // trigger an expensive scan.
  const q = raw.slice(0, 50).replace(/[%_]/g, '');
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, avatar_url FROM users
     WHERE username ILIKE $1 AND user_id != $2 LIMIT 20`,
    [`${q}%`, req.userId]
  );
  return res.json(rows);
}));

// Friends — must be before /:id
router.get('/me/friends', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.user_id) u.user_id, u.username, u.elo, u.avatar_url, f.status
     FROM friends f
     JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
     ORDER BY u.user_id`,
    [req.userId]
  );
  return res.json(rows);
}));

router.get('/me/friend-requests', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.avatar_url, f.created_at
     FROM friends f JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'`,
    [req.userId]
  );
  return res.json(rows);
}));

router.post('/me/friends/request', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body ?? {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  if (friendId === req.userId) return res.status(400).json({ error: 'Cannot friend yourself' });
  // Verify target user exists (returns a friendlier error than a silent INSERT)
  const { rows: targetRows } = await pool.query(
    `SELECT 1 FROM users WHERE user_id = $1`, [friendId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'User not found' });

  await pool.query(
    `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')
     ON CONFLICT DO NOTHING`,
    [req.userId, friendId]
  );

  const { rows } = await pool.query(
    `SELECT u.push_token, u2.username AS from_name
     FROM users u, users u2
     WHERE u.user_id = $1 AND u2.user_id = $2`,
    [friendId, req.userId]
  );
  if (rows[0]?.push_token) {
    await sendPush(
      [rows[0].push_token],
      'Friend Request',
      `${rows[0].from_name} sent you a friend request!`,
      { type: 'friendRequest' }
    );
  }

  return res.json({ success: true });
}));

router.post('/me/friends/accept', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body ?? {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  // Use RETURNING + rowCount so we surface a real 404 instead of silently
  // succeeding on a non-existent / already-accepted / declined request.
  const { rows } = await pool.query(
    `UPDATE friends SET status = 'accepted'
     WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'
     RETURNING user_id`,
    [friendId, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No pending request from that user' });
  return res.json({ success: true });
}));

// Aggregated stats from a player's completed rounds. Computes a simplified
// 4-category strokes-gained model relative to a "scratch baseline" where a
// hole = (par − 2) full swings to the green + 2 putts. Each component is
// designed so the four categories sum to (par − strokes), matching score-vs-par.
//
//   SG: Putting       = 2 − putts
//   SG: Around-Green  = chips > 0 ? (1 − chips) : 0
//                       (1 chip baseline when off-green; 0 contribution when GIR.
//                        Driving a par-4 green and chipping → GIR + 1 chip is fine,
//                        the chip is the "around-green" stroke and SG_ATG = 0)
//   SG: Approach      = gir ? 0 : −1
//                       (missing the green = a forced extra stroke, attributed here)
//   SG: Off-the-Tee   = (par − strokes) − SG_putting − SG_around_green − SG_approach
//                       (the residual: any strokes saved/lost beyond what the other
//                        three categories account for. Captures eagle-able drives,
//                        first-shot disasters, and par-5 reach-in-2 bonuses.)
//
// Holes without putts AND chips AND gir tracked are excluded from SG averaging
// so old untracked rounds don't dilute new data.
router.get('/:id/stats', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT r.round_id, r.created_at, r.hole_scores, r.hole_stats, r.total_score,
            t.par AS teebox_par, t.num_holes AS teebox_holes,
            ARRAY(
              SELECT h.par FROM holes h
              WHERE h.teebox_id = r.teebox_id
              ORDER BY h.hole_num ASC
            ) AS hole_pars
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.is_practice = false
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [req.params.id]
  );

  // Aggregators
  let roundsCount = 0;
  let holesPlayed = 0;
  let totalStrokes = 0;
  let totalPutts = 0;
  let totalChips = 0;
  let girCount = 0;
  let girEligible = 0;       // holes where chips/putts were tracked
  let fwHits = 0;
  let fwEligible = 0;        // par-4-and-up holes where the player tracked fairwayHit
  let threePuttCount = 0;
  let upAndDownCount = 0;    // chips ≥ 1 and putts == 1 → saved par from off green
  let upAndDownChances = 0;  // any hole with chips ≥ 1 and putts tracked

  // SG aggregators — 4 categories. Only over holes with full stat tracking.
  let sgHoles = 0;
  let sgPutting = 0;
  let sgAroundGreen = 0;
  let sgApproach = 0;
  let sgOffTee = 0;
  let sgTotal = 0;

  for (const r of rows) {
    if (!Array.isArray(r.hole_scores) || r.hole_scores.length === 0) continue;
    roundsCount += 1;
    const stats: any[] = Array.isArray(r.hole_stats) ? r.hole_stats : [];
    const pars: number[] = Array.isArray(r.hole_pars) ? r.hole_pars : [];

    for (let i = 0; i < r.hole_scores.length; i++) {
      const strokes = r.hole_scores[i];
      const par = pars[i] ?? 4;
      holesPlayed += 1;
      totalStrokes += strokes;

      const s = stats[i] ?? {};
      const putts = typeof s.putts === 'number' ? s.putts : null;
      const chips = typeof s.chips === 'number' ? s.chips : null;
      const gir = typeof s.gir === 'boolean' ? s.gir : null;
      const fwHit = typeof s.fairwayHit === 'boolean' ? s.fairwayHit : null;

      if (putts !== null) {
        totalPutts += putts;
        if (putts >= 3) threePuttCount += 1;
      }
      if (chips !== null) totalChips += chips;

      // GIR is now its own input — no longer derived from chips. (You can drive
      // a par-4 green and still chip onto it, which is GIR with chips ≥ 1.)
      if (gir !== null) {
        girEligible += 1;
        if (gir) girCount += 1;
      }

      // Up-and-downs: chip(s) used AND saved par with a single putt
      if (chips !== null && putts !== null && chips >= 1) {
        upAndDownChances += 1;
        if (putts === 1) upAndDownCount += 1;
      }

      // Fairway hits — par ≥ 4 only and only if user tracked it
      if (par >= 4 && fwHit !== null) {
        fwEligible += 1;
        if (fwHit) fwHits += 1;
      }

      // 4-category basic SG — needs putts, chips AND gir tracked.
      // Baselines (Shotscope-style simplified):
      //   • Putting baseline = 2 if the player reached the green (GIR), else 1.
      //     If the player chipped on, they're effectively in 1-putt territory, so
      //     2-putting a chip = 0 SG (par for that recovery), 1-putt = +1, 3-putt = −1.
      //   • Around-Green baseline = 1 chip (when chips > 0).
      //   • Approach baseline = GIR (gir = 0 SG, missed green = −1).
      //   • Off-the-Tee = residual so the four sum to (par − strokes).
      if (putts !== null && chips !== null && gir !== null) {
        sgHoles += 1;
        const puttBaseline = chips > 0 ? 1 : 2;
        const putt = puttBaseline - putts;
        const around = chips > 0 ? (1 - chips) : 0;
        const approach = gir ? 0 : -1;
        const tee = (par - strokes) - putt - around - approach;
        sgPutting += putt;
        sgAroundGreen += around;
        sgApproach += approach;
        sgOffTee += tee;
        sgTotal += (par - strokes);
      }
    }
  }

  const round = (n: number, places = 2) => Math.round(n * Math.pow(10, places)) / Math.pow(10, places);

  return res.json({
    rounds_count: roundsCount,
    holes_played: holesPlayed,
    avg_strokes_per_hole: holesPlayed ? round(totalStrokes / holesPlayed) : null,
    fw_hit_pct: fwEligible ? round((fwHits / fwEligible) * 100, 1) : null,
    fw_hits: fwHits,
    fw_eligible: fwEligible,
    gir_pct: girEligible ? round((girCount / girEligible) * 100, 1) : null,
    gir_count: girCount,
    gir_eligible: girEligible,
    avg_putts_per_hole: girEligible ? round(totalPutts / girEligible) : null,
    avg_putts_per_round: roundsCount && girEligible ? round((totalPutts / girEligible) * (holesPlayed / roundsCount), 1) : null,
    avg_chips_per_round: roundsCount && girEligible ? round((totalChips / girEligible) * (holesPlayed / roundsCount), 1) : null,
    three_putt_count: threePuttCount,
    up_and_down_pct: upAndDownChances ? round((upAndDownCount / upAndDownChances) * 100, 1) : null,
    up_and_downs: upAndDownCount,
    up_and_down_chances: upAndDownChances,
    sg_holes: sgHoles,
    sg_per_round: sgHoles && roundsCount
      ? {
          off_tee:      round((sgOffTee      / sgHoles) * (holesPlayed / roundsCount)),
          approach:     round((sgApproach    / sgHoles) * (holesPlayed / roundsCount)),
          around_green: round((sgAroundGreen / sgHoles) * (holesPlayed / roundsCount)),
          putting:      round((sgPutting     / sgHoles) * (holesPlayed / roundsCount)),
          total:        round((sgTotal       / sgHoles) * (holesPlayed / roundsCount)),
        }
      : null,
  });
}));

/**
 * Past shots this user has tracked at a specific course+hole, across every
 * round they've ever played. Used by the in-round "ghost shots" overlay so
 * the player can see where they've landed shots on this hole in the past.
 *
 * Excludes the current match so the overlay doesn't duplicate the in-progress
 * round's shots, which are already drawn separately. Hole_num is matched
 * across all teeboxes for the course (a par 4 from white tees is the same
 * physical hole as the par 4 from blue tees).
 *
 * Query: ?courseId=<uuid>&holeNum=<int>[&excludeMatchId=<uuid>]
 */
router.get('/:id/hole-shots', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const courseId = String(req.query.courseId ?? '');
  const holeNum = parseInt(String(req.query.holeNum ?? ''), 10);
  const excludeMatchId = String(req.query.excludeMatchId ?? '');
  if (!courseId || !Number.isFinite(holeNum) || holeNum < 1 || holeNum > 36) {
    return res.status(400).json({ error: 'courseId and holeNum required' });
  }
  // Authorisation: only the user themselves (or in future, a friend with
  // explicit consent) can fetch their own historical shots. For now we lock
  // to self so this endpoint can't be used to surveil random players.
  if (req.params.id !== req.userId) {
    return res.status(403).json({ error: 'Can only fetch your own past shots' });
  }

  const params: any[] = [req.params.id, courseId, holeNum];
  let where = `WHERE st.user_id = $1
               AND t.course_id = $2
               AND st.hole_num = $3`;
  if (excludeMatchId) {
    params.push(excludeMatchId);
    where += ` AND st.match_id != $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT st.match_id, st.shots, m.created_at
       FROM shot_tracks st
       JOIN match_players mp ON mp.match_id = st.match_id AND mp.user_id = st.user_id
       JOIN teeboxes t ON t.teebox_id = mp.teebox_id
       JOIN matches m ON m.match_id = st.match_id
      ${where}
      ORDER BY m.created_at DESC
      LIMIT 50`,
    params
  );
  return res.json({
    rounds: rows.map((r: any) => ({
      match_id: r.match_id,
      created_at: r.created_at,
      shots: r.shots,
    })),
  });
}));

/**
 * Per-club stats — aggregates every tracked shot the user has tagged with a
 * `club` field across all of their matches. Returns:
 *   • Per-club counts and median/avg distance (in yards)
 *   • Per-club dispersion points: shots in a normalised 2D frame where the
 *     median shot points "up". The (lateral, longitudinal) deltas show miss
 *     pattern. The mobile heatmap screen renders these directly.
 *
 * Distance comes from haversine between consecutive shots within a hole.
 * Tee shots → next-shot location; final shot before holing out is dropped
 * (no end-point to measure to without the pin coordinates).
 */
router.get('/:id/club-stats', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT st.shots
       FROM shot_tracks st
       JOIN match_players mp ON mp.match_id = st.match_id AND mp.user_id = st.user_id
      WHERE st.user_id = $1
      ORDER BY st.updated_at DESC
      LIMIT 200`,
    [req.params.id]
  );

  // Per-club bucket: collect every shot's (distance_m, bearing_rad) pair,
  // plus the raw start/end so we can normalise.
  type ShotVec = { dist_m: number; bearing: number };
  const byClub = new Map<string, ShotVec[]>();

  // Haversine — meters between two lat/lng points
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Initial bearing in radians, 0 = north, clockwise
  function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x);
  }

  /** Walk the per-hole shot list, normalising both the new segment format
   *  and the legacy point format into (start, end, club) triples. */
  const eachShotSegment = (rawShots: any[]): { start: any; end: any; club: string }[] => {
    if (!rawShots.length) return [];
    if (rawShots[0]?.start && rawShots[0]?.end) {
      // New segment format
      return rawShots
        .filter((s: any) => s?.start && s?.end && typeof s.club === 'string')
        .map((s: any) => ({ start: s.start, end: s.end, club: s.club }));
    }
    // Legacy: points where shots[i] = "where shot i+1 was hit FROM"
    const out: { start: any; end: any; club: string }[] = [];
    for (let i = 0; i < rawShots.length - 1; i++) {
      const cur = rawShots[i];
      const nxt = rawShots[i + 1];
      if (typeof cur?.lat !== 'number' || typeof nxt?.lat !== 'number') continue;
      if (typeof cur.club !== 'string') continue;
      out.push({ start: cur, end: nxt, club: cur.club });
    }
    return out;
  };

  for (const row of rows) {
    const segments = eachShotSegment(Array.isArray(row.shots) ? row.shots : []);
    for (const seg of segments) {
      const dist_m = haversine(seg.start, seg.end);
      if (dist_m < 1 || dist_m > 500) continue; // sanity: drop GPS noise / impossibly long
      const b = bearing(seg.start, seg.end);
      const arr = byClub.get(seg.club) ?? [];
      arr.push({ dist_m, bearing: b });
      byClub.set(seg.club, arr);
    }
  }

  // Build per-club summary + dispersion points
  const M_TO_YDS = 1.0936;
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  };

  const clubs: any[] = [];
  for (const [club, vecs] of byClub.entries()) {
    if (vecs.length < 2) {
      // Not enough samples to call a "median direction"; still report distance.
      const yds = vecs.map(v => v.dist_m * M_TO_YDS);
      clubs.push({
        club,
        shots: vecs.length,
        avg_yds:    Math.round(yds.reduce((a, b) => a + b, 0) / yds.length),
        median_yds: Math.round(median(yds)),
        // Dispersion needs ≥2 samples to define a frame.
        dispersion: [],
      });
      continue;
    }
    // Median bearing — circular median. Crude but fine: rotate so shot 0
    // points "north" (using its bearing as reference), then take the median
    // of the angular offsets, then add back. This avoids the wrap-around at
    // ±π for typical sub-180° spreads.
    const refB = vecs[0].bearing;
    const offsets = vecs.map(v => {
      let o = v.bearing - refB;
      while (o > Math.PI) o -= 2 * Math.PI;
      while (o < -Math.PI) o += 2 * Math.PI;
      return o;
    });
    const medB = refB + median(offsets);

    const yds = vecs.map(v => v.dist_m * M_TO_YDS);
    const medYds = median(yds);

    // Dispersion frame: forward axis = median bearing.
    // For each shot, project (dx_m, dy_m) onto the median frame:
    //   forward  =  dist * cos(bearing − medB)
    //   lateral  =  dist * sin(bearing − medB)   (positive = right of target line)
    // Then offsets relative to median distance: longitudinal = forward − medDist
    const dispersion = vecs.map(v => {
      let off = v.bearing - medB;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      const fwd_m  = v.dist_m * Math.cos(off);
      const lat_m  = v.dist_m * Math.sin(off);
      const fwd_yds = fwd_m * M_TO_YDS;
      const lat_yds = lat_m * M_TO_YDS;
      return {
        // Round to whole yards for compactness
        lateral_yds: Math.round(lat_yds),
        long_yds:    Math.round(fwd_yds - medYds), // signed: + = long, − = short
        dist_yds:    Math.round(fwd_yds),
      };
    });

    clubs.push({
      club,
      shots: vecs.length,
      avg_yds:    Math.round(yds.reduce((a, b) => a + b, 0) / yds.length),
      median_yds: Math.round(medYds),
      dispersion,
    });
  }

  // Stable order: longest median distance first (driver → wedges → putter)
  clubs.sort((a, b) => (b.median_yds || 0) - (a.median_yds || 0));
  return res.json({ clubs });
}));

/**
 * Advanced strokes-gained — the real Mark Broadie / Shotscope model.
 * Requires shot-tracking data with at least lie tags + pin coordinates.
 *
 * For each tracked hole we walk the shot list. Each shot's start lie/distance
 * comes from the player's tag (or sane defaults: shot 0 = 'tee', else
 * 'fairway'). End lie/distance comes from the next shot's tag and position.
 * Final shot ends at the pin (end_dist = 0 if the player holed out per the
 * scorecard).
 *
 * Returns null if too little data is available; clients should fall back to
 * the basic /stats endpoint in that case.
 */
router.get('/:id/sg-advanced', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT st.match_id, st.hole_num, st.shots,
            r.hole_scores, r.teebox_id,
            (SELECT json_agg(json_build_object('hole_num', h.hole_num, 'par', h.par,
                                                'pin_lat', h.pin_lat, 'pin_lng', h.pin_lng))
               FROM holes h WHERE h.teebox_id = r.teebox_id) AS holes
       FROM shot_tracks st
       JOIN rounds r ON r.match_id = st.match_id AND r.user_id = st.user_id
      WHERE st.user_id = $1
      ORDER BY st.updated_at DESC
      LIMIT 200`,
    [req.params.id]
  );

  if (!rows.length) return res.json({ shots_used: 0, sg_per_round: null, holes_used: 0, rounds_used: 0 });

  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const haversineYds = (a: any, b: any) => {
    if (a?.lat == null || b?.lat == null) return null;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return (2 * R * Math.asin(Math.sqrt(h))) * 1.0936;
  };

  const allShots: Shot[] = [];
  const holeIdsSeen = new Set<string>();
  const matchIdsSeen = new Set<string>();

  // Normalize either format into a flat list of {start, end, club, lie} tuples
  // per hole. The new segment format is canonical; legacy points get paired.
  const toSegments = (raw: any[]): { start: any; end: any; club?: string; lie?: string }[] => {
    if (!raw.length) return [];
    if (raw[0]?.start && raw[0]?.end) {
      return raw
        .filter((s: any) => s?.start && s?.end)
        .map((s: any) => ({ start: s.start, end: s.end, club: s.club, lie: s.lie }));
    }
    const out: { start: any; end: any; club?: string; lie?: string }[] = [];
    for (let i = 0; i < raw.length - 1; i++) {
      out.push({ start: raw[i], end: raw[i + 1], club: raw[i]?.club, lie: raw[i]?.lie });
    }
    return out;
  };

  for (const row of rows) {
    const segments = toSegments(Array.isArray(row.shots) ? row.shots : []);
    const holes: any[] = Array.isArray(row.holes) ? row.holes : [];
    const holeMeta = holes.find((h: any) => h.hole_num === row.hole_num);
    if (!holeMeta || holeMeta.pin_lat == null || holeMeta.pin_lng == null) continue;
    if (segments.length === 0) continue;

    const par = holeMeta.par ?? 4;
    const pin = { lat: holeMeta.pin_lat, lng: holeMeta.pin_lng };
    const holed = (Array.isArray(row.hole_scores) ? row.hole_scores[row.hole_num - 1] : null) ?? null;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      const startDist = haversineYds(seg.start, pin);
      const endDist0  = haversineYds(seg.end, pin);
      if (startDist == null) continue;

      // Start lie: prefer player tag, else infer.
      const startLie: Lie = (seg.lie as Lie) ?? (i === 0 ? 'tee' : 'fairway');

      // End lie/distance: holed out on the last shot if scorecard total matches.
      let endLie: Lie;
      let endDist: number;
      if (isLast && typeof holed === 'number' && segments.length === holed) {
        endLie = 'green';
        endDist = 0;
      } else if (endDist0 != null) {
        endLie = endDist0 < 30 ? 'green' : 'fairway';
        endDist = endDist0 < 3 ? 0 : endDist0;
      } else {
        // No usable end distance — skip this shot entirely.
        continue;
      }

      allShots.push({
        start_lie: startLie,
        start_dist_yds: Math.round(startDist),
        end_lie: endLie,
        end_dist_yds: Math.round(endDist),
        par,
        is_tee_shot: i === 0,
      });
    }

    holeIdsSeen.add(`${row.match_id}:${row.hole_num}`);
    matchIdsSeen.add(row.match_id);
  }

  if (!allShots.length) {
    return res.json({ shots_used: 0, sg_per_round: null, holes_used: 0, rounds_used: 0 });
  }

  const totals = aggregateSG(allShots);
  const holesUsed = holeIdsSeen.size;
  const roundsUsed = matchIdsSeen.size;
  const round = (n: number) => Math.round(n * 100) / 100;

  // Per-round = total SG × (18 / holes_used). Crude but interpretable.
  const norm = holesUsed > 0 ? 18 / holesUsed : 0;
  return res.json({
    shots_used: totals.shots_used,
    holes_used: holesUsed,
    rounds_used: roundsUsed,
    sg_per_round: {
      off_tee:      round(totals.off_tee      * norm),
      approach:     round(totals.approach     * norm),
      around_green: round(totals.around_green * norm),
      putting:      round(totals.putting      * norm),
      total:        round(totals.total        * norm),
    },
  });
}));

// Course records — the courses where this user holds the lowest score on
// any teebox. Returns one row per course where they're rank #1.
router.get('/:id/course-records', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT t.course_id, c.course_name, t.name AS teebox_name, r.user_id,
              r.total_score, r.created_at,
              ROW_NUMBER() OVER (PARTITION BY t.course_id ORDER BY r.total_score ASC, r.created_at ASC) AS rk
       FROM rounds r
       JOIN matches m ON m.match_id = r.match_id
       JOIN teeboxes t ON t.teebox_id = r.teebox_id
       JOIN courses c ON c.course_id = t.course_id
       WHERE r.total_score IS NOT NULL
         AND m.completed = true
         AND m.is_practice = false
     )
     SELECT course_id, course_name, teebox_name, total_score, created_at
     FROM ranked
     WHERE rk = 1 AND user_id = $1
     ORDER BY total_score ASC`,
    [req.params.id]
  );
  return res.json(rows);
}));

// Active (unused) perks for the requesting user
router.get('/me/perks', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT perk_id, perk_type, earned_at, earned_match_id
     FROM user_perks
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY earned_at ASC`,
    [req.userId]
  );
  return res.json(rows);
}));

router.get('/leaderboard', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const friendsOnly = req.query.friends === '1' || req.query.friends === 'true';
  if (friendsOnly) {
    // Self + accepted friends, ranked by ELO. Friend rows are stored as a
    // single direction with status='accepted' (the original requester being
    // user_id, friend_id either side depending on who initiated).
    const { rows } = await pool.query(
      `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url
       FROM users u
       WHERE u.user_id = $1
          OR u.user_id IN (
            SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
            FROM friends f
            WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
          )
       ORDER BY u.elo DESC
       LIMIT 100`,
      [req.userId]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, total_matches, total_wins, avatar_url
     FROM users ORDER BY elo DESC LIMIT 100`
  );
  return res.json(rows);
}));

router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.total_ties,
            u.avatar_url, u.created_at,
            u.bio, u.home_course_id,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const userInfo = rows[0];

  // Recent completed rounds (last 5)
  const { rows: recentRounds } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores, r.hole_stats,
            t.teebox_id, t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            m.format, m.match_type
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true
     ORDER BY r.created_at DESC
     LIMIT 5`,
    [req.params.id]
  );

  // Best round (lowest score-to-par across all completed rounds)
  const { rows: bestRows } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores, r.hole_stats,
            t.teebox_id, t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            (r.total_score - t.par) AS to_par
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true AND t.par IS NOT NULL
     ORDER BY (r.total_score - t.par) ASC
     LIMIT 1`,
    [req.params.id]
  );

  return res.json({
    ...userInfo,
    recent_rounds: recentRounds,
    best_round: bestRows[0] ?? null,
  });
}));

router.delete('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Hand off clan leadership BEFORE deleting the user. Otherwise the
  // CASCADE wipes their clan_members row but leaves the clan leaderless.
  // For each clan they currently lead, promote the longest-tenured remaining
  // member; if none, delete the orphaned clan.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ledClans } = await client.query(
      `SELECT clan_id FROM clan_members WHERE user_id = $1 AND role = 'leader' FOR UPDATE`,
      [req.userId]
    );
    for (const c of ledClans) {
      const { rows: heir } = await client.query(
        `SELECT user_id FROM clan_members
         WHERE clan_id = $1 AND user_id != $2
         ORDER BY joined_at ASC
         LIMIT 1`,
        [c.clan_id, req.userId]
      );
      if (heir.length) {
        await client.query(
          `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2`,
          [c.clan_id, heir[0].user_id]
        );
      } else {
        // Last member — clan dies with them.
        await client.query(`DELETE FROM clans WHERE clan_id = $1`, [c.clan_id]);
      }
    }
    await client.query(`DELETE FROM users WHERE user_id = $1`, [req.userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return res.json({ success: true });
}));

// Live in-progress round (if any). Returns null when:
//   - the user has no in-progress match with a teebox set
//   - the requesting viewer is in the same match (anti-cheat)
//   - the round has been idle for more than 4 hours (treat as paused —
//     keeps zombie tabs from showing as "playing now" indefinitely)
//   - the round was cancelled (auto-set by the cleanup cron after 24h idle)
// Returns the round info even if no hole_scores yet, so the friend's profile
// can show "PLAYING NOW" right when they pick a teebox.
router.get('/:id/active-round', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT mp.match_id, mp.teebox_id,
            r.hole_scores, r.created_at AS round_started_at,
            t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            -- Last meaningful activity for this user on this match — pick
            -- the most recent of: round start, score updates (rounds.created_at),
            -- and shot tracking saves. Powers the 4h staleness gate.
            GREATEST(
              m.created_at,
              COALESCE(r.created_at, m.created_at),
              COALESCE((SELECT MAX(updated_at)
                          FROM shot_tracks
                         WHERE match_id = mp.match_id AND user_id = mp.user_id),
                       m.created_at)
            ) AS last_activity_at
     FROM match_players mp
     JOIN matches m ON m.match_id = mp.match_id
     LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
     LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE mp.user_id = $1
       AND m.completed = false
       AND m.cancelled = false
       AND mp.completed = false
       AND m.is_practice = false
       AND mp.teebox_id IS NOT NULL
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [req.params.id]
  );

  // Pause the live status if no activity in the last 4 hours. The match
  // itself stays in-progress (player can resume by tracking another shot or
  // saving a score), but spectators stop seeing it as "live."
  if (rows.length) {
    const last = new Date(rows[0].last_activity_at);
    const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
    if (ageHours >= 4) return res.json(null);
  }
  if (!rows.length) return res.json(null);

  const active = rows[0];

  // Anti-cheat: hide the live scorecard from anyone in the same match
  if (req.userId !== req.params.id) {
    const { rows: shareRows } = await pool.query(
      `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [active.match_id, req.userId]
    );
    if (shareRows.length) return res.json(null);
  }

  // Normalise empty arrays to [] so frontend can safely call .length on them
  if (!active.hole_scores) active.hole_scores = [];
  return res.json(active);
}));

// WHS-style handicap index calculator from a player's last 20 rated rounds.
// Returns { handicap_index, num_rounds_used, total_rounds, differentials }
router.get('/:id/handicap', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: rounds } = await pool.query(
    `SELECT r.round_id, r.total_score, r.created_at, r.hole_scores,
            COALESCE(array_length(r.hole_scores, 1), t.num_holes) AS holes_played,
            t.course_rating, t.slope_rating, t.num_holes AS teebox_holes,
            t.front_course_rating, t.front_slope_rating,
            t.back_course_rating, t.back_slope_rating,
            t.name AS teebox_name, c.course_name
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL
       AND m.completed = true AND m.is_practice = false
       AND t.course_rating IS NOT NULL AND t.slope_rating IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT 20`,
    [req.params.id]
  );

  // Score differential = (113 / slope) × (gross − rating)
  // For 9-hole rounds, use the 9-hole slope and 9-hole rating as-is.
  // The doubling of slope and (score − rating) cancel out, so no extra ×2 is needed.
  //  - 18-hole round on 18-hole teebox: full 18 rating + slope
  //  - 9-hole round on 9-hole teebox:    teebox.course_rating + slope_rating ARE the 9-hole values
  //  - 9-hole round on 18-hole teebox:   use the front-9 rating/slope columns (assumes front 9)
  const differentials = rounds.map((r) => {
    const isNineHoleRound = r.holes_played === 9;
    const isNineHoleTeebox = r.teebox_holes === 9;

    let rating: number;
    let slope: number;

    if (isNineHoleRound && !isNineHoleTeebox) {
      // 9-hole round on an 18-hole teebox — prefer the dedicated front-9 ratings
      rating = r.front_course_rating ?? (r.course_rating / 2);
      slope = r.front_slope_rating ?? r.slope_rating;
    } else {
      // 9-hole teebox OR full 18-hole round — the teebox's primary rating/slope already match
      rating = r.course_rating;
      slope = r.slope_rating;
    }

    const diff = (113 / slope) * (r.total_score - rating);

    return {
      round_id: r.round_id,
      created_at: r.created_at,
      total_score: r.total_score,
      course_name: r.course_name,
      teebox_name: r.teebox_name,
      holes_played: r.holes_played,
      course_rating_used: Math.round(rating * 10) / 10,
      slope_used: slope,
      differential: Math.round(diff * 10) / 10,
      is_nine_hole: isNineHoleRound,
    };
  });

  // WHS lookup: how many of the lowest differentials to use, plus an adjustment
  const N = differentials.length;
  let useCount = 0;
  let adjustment = 0;
  if (N >= 20) { useCount = 8; }
  else if (N >= 19) { useCount = 7; }
  else if (N >= 17) { useCount = 6; }
  else if (N >= 15) { useCount = 5; }
  else if (N >= 12) { useCount = 4; }
  else if (N >= 9)  { useCount = 3; }
  else if (N >= 7)  { useCount = 2; }
  else if (N >= 6)  { useCount = 2; adjustment = -1; }
  else if (N >= 5)  { useCount = 1; }
  else if (N >= 4)  { useCount = 1; adjustment = -1; }
  else if (N >= 3)  { useCount = 1; adjustment = -2; }

  let handicapIndex: number | null = null;
  if (useCount > 0) {
    const sorted = [...differentials].map((d) => d.differential).sort((a, b) => a - b);
    const best = sorted.slice(0, useCount);
    const avg = best.reduce((a, b) => a + b, 0) / best.length;
    handicapIndex = Math.round((avg + adjustment) * 10) / 10;
  }

  return res.json({
    handicap_index: handicapIndex,
    num_rounds_used: useCount,
    total_rated_rounds: N,
    differentials,
  });
}));

// Avatar upload
router.post('/me/avatar', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // Whitelist MIME types — fall back is jpg
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg'
    : null;
  if (!ext) return res.status(400).json({ error: 'Only PNG and JPEG avatars are allowed' });
  // Decode and size-cap before touching disk (2 MB)
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'Invalid image data' });
  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Avatar must be 2 MB or smaller' });
  }
  const filename = `avatar_${req.userId}.${ext}`;
  const filepath = path.join(AVATARS_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  const avatarUrl = `/uploads/avatars/${filename}`;
  await pool.query(`UPDATE users SET avatar_url = $1 WHERE user_id = $2`, [avatarUrl, req.userId]);
  return res.json({ avatar_url: avatarUrl });
}));

// Notifications feed — all sources are filtered to the last 3 days; an unread_count
// is computed against the user's notifications_seen_at timestamp.
router.get('/me/notifications', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const notes: any[] = [];

  // Get user's seen-at timestamp for unread calculation
  const { rows: seenRows } = await pool.query(
    `SELECT notifications_seen_at FROM users WHERE user_id = $1`,
    [req.userId]
  );
  const seenAt = seenRows[0]?.notifications_seen_at ?? new Date(0);

  // Pending friend requests (3-day window)
  const { rows: frs } = await pool.query(
    `SELECT u.user_id, u.username, f.created_at FROM friends f
     JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'
       AND f.created_at > NOW() - INTERVAL '3 days'
     ORDER BY f.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of frs) notes.push({ type: 'friend_request', title: 'Friend Request', body: `${r.username} sent you a friend request`, data: { userId: r.user_id }, created_at: r.created_at });

  // Pending match invites (3-day window)
  const { rows: mis } = await pool.query(
    `SELECT mi.invite_id, mi.match_id, mi.created_at, u.username AS from_name, m.match_type
     FROM match_invites mi JOIN users u ON u.user_id = mi.from_user_id JOIN matches m ON m.match_id = mi.match_id
     WHERE mi.to_user_id = $1 AND mi.status = 'pending'
       AND mi.created_at > NOW() - INTERVAL '3 days'
       AND (mi.expires_at IS NULL OR mi.expires_at > NOW())
     ORDER BY mi.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mis) notes.push({ type: 'match_invite', title: 'Match Invite', body: `${r.from_name} invited you to a ${r.match_type} match`, data: { matchId: r.match_id, inviteId: r.invite_id }, created_at: r.created_at });

  // Pending clan invites (3-day window)
  try {
    const { rows: cis } = await pool.query(
      `SELECT ci.invite_id, ci.clan_id, ci.created_at, u.username AS from_name, c.name AS clan_name
       FROM clan_invites ci JOIN users u ON u.user_id = ci.from_user_id JOIN clans c ON c.clan_id = ci.clan_id
       WHERE ci.to_user_id = $1 AND ci.status = 'pending'
         AND ci.created_at > NOW() - INTERVAL '3 days'
       ORDER BY ci.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of cis) notes.push({ type: 'clan_invite', title: 'Clan Invite', body: `${r.from_name} invited you to join ${r.clan_name}`, data: { clanId: r.clan_id, inviteId: r.invite_id }, created_at: r.created_at });
  } catch { /* table may not exist yet */ }

  // Recent match results (3-day window)
  const { rows: mrs } = await pool.query(
    `SELECT mr.match_id, mr.winner_side, mr.delta_elo, mr.created_at, m.match_type, mp.side AS my_side
     FROM match_results mr JOIN matches m ON m.match_id = mr.match_id
     JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = $1
     WHERE mr.created_at > NOW() - INTERVAL '3 days' AND m.is_practice = false
     ORDER BY mr.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mrs) {
    const won = r.winner_side === r.my_side;
    notes.push({ type: 'match_result', title: won ? 'Victory!' : 'Defeat', body: won ? `You won your ${r.match_type} match (+${r.delta_elo} ELO)` : `You lost your ${r.match_type} match (-${r.delta_elo} ELO)`, data: { matchId: r.match_id }, created_at: r.created_at, won });
  }

  notes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const unreadCount = notes.filter((n) => new Date(n.created_at) > new Date(seenAt)).length;
  return res.json({ notifications: notes, unread_count: unreadCount });
}));

// Mark notifications as seen (resets the unread badge)
router.post('/me/notifications/seen', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE users SET notifications_seen_at = NOW() WHERE user_id = $1`,
    [req.userId]
  );
  return res.json({ success: true });
}));

export default router;
