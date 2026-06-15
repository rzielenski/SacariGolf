/**
 * WHS-style handicap math, shared by the live GET /users/:id/handicap
 * endpoint and the one-off backfill so they can never disagree.
 *
 * A score differential is (113 / slope) x (gross - course rating). The whole
 * trick is using the RIGHT rating + slope for how many holes were actually
 * played versus how many holes the course has:
 *
 *   9-hole course,  played 9   → use the stored 9-hole rating + slope as-is.
 *                                (A 9-hole course legitimately has a low
 *                                 rating, e.g. ~34 for par 36.)
 *   9-hole course,  played 18  → two loops: DOUBLE the rating. Slope is a
 *                                difficulty ratio and stays the same.
 *   18-hole course, played 9   → use the dedicated front/back-9 rating + slope
 *                                if the course has them; otherwise HALVE the
 *                                18-hole rating. Slope stays the same.
 *   18-hole course, played 18  → use the stored rating + slope as-is.
 *
 * A course counts as 9-hole when its num_holes is 9 OR its rating/slope is
 * below 55 — a sub-55 rating/slope IS the marker of a 9-hole course in this
 * data model. Course RATING scales with the hole count (double for two loops,
 * half a front/back nine).
 *
 * The 113 in the differential is the STANDARD 18-hole slope. A sub-55 slope
 * is a half-scale 9-hole slope, so the reference is halved to 56.5 to match
 * (identical to doubling the slope) — otherwise dividing a 9-hole slope into
 * the full 113 doubles the differential. No clamp/guard: stored values are
 * used exactly as-is; only the reference scale is matched to the slope.
 *
 * 9-hole rounds keep the per-round "strokes over rating" convention here
 * (NOT doubled to an 18-hole equivalent) — that is the figure shown in the
 * handicap round list. Match scoring uses its own diff18 (which does double).
 */

import pool from '../db/pool';

const NEUTRAL_SLOPE = 113;

export interface HandicapRound {
  total_score: number;
  holes_played: number;
  /** The tee/course's hole count (9 or 18). */
  teebox_holes: number | null;
  /** Which nine a 9-on-18 round covered: 'front' | 'back' | 'full' | null. */
  holes_subset: string | null;
  course_rating: number | null;
  slope_rating: number | null;
  front_course_rating: number | null;
  front_slope_rating: number | null;
  back_course_rating: number | null;
  back_slope_rating: number | null;
}

/** Resolve the effective rating + slope for a round (handling 9 vs 18 holes
 *  on 9 vs 18-hole courses) and return the resulting score differential. */
export function roundDifferential(r: HandicapRound): { rating: number; slope: number; diff: number } {
  const CR = r.course_rating ?? 0;
  const S = r.slope_rating ?? NEUTRAL_SLOPE;
  // 9-hole course if num_holes says so, OR if the rating/slope is sub-55 —
  // a low rating/slope is the tell-tale of a 9-hole course in this data model.
  const teeNine =
    (r.teebox_holes ?? 18) === 9 ||
    (CR > 0 && CR < 55) ||
    (r.slope_rating != null && r.slope_rating < 55);
  const playedNine = r.holes_played === 9;

  let rating: number;
  let slope: number;

  if (teeNine) {
    // 9-hole course — stored rating/slope ARE the 9-hole values.
    if (playedNine) {
      rating = CR;       // played the 9 → use as-is
      slope = S;
    } else {
      rating = CR * 2;   // played 18 (two loops) → double the rating
      slope = S;
    }
  } else {
    // 18-hole course.
    if (playedNine) {
      const useBack = r.holes_subset === 'back';
      const sideRating = useBack ? r.back_course_rating : r.front_course_rating;
      const sideSlope = useBack ? r.back_slope_rating : r.front_slope_rating;
      if (typeof sideRating === 'number' && sideRating > 0) {
        // Course publishes a dedicated 9-hole rating/slope for this nine.
        rating = sideRating;
        slope = typeof sideSlope === 'number' && sideSlope > 0 ? sideSlope : S;
      } else {
        rating = CR / 2;  // only an 18-hole rating exists → halve it
        slope = S;
      }
    } else {
      rating = CR;        // played 18 → use as-is
      slope = S;
    }
  }

  // Match the 113 reference to the slope's scale: a sub-55 (9-hole) slope
  // uses 56.5, a full 18-hole slope uses 113.
  const reference = slope < 55 ? 113 / 2 : 113;
  const diff = (reference / slope) * (r.total_score - rating);
  return { rating, slope, diff };
}

/** WHS lookup: how many of the lowest differentials to average + the
 *  small-sample adjustment, then the resulting index (or null if too few
 *  rounds). Input is the raw differential list (any order). */
export function whsHandicapIndex(differentials: number[]): { handicapIndex: number | null; useCount: number } {
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

  if (useCount === 0) return { handicapIndex: null, useCount };
  const best = [...differentials].sort((a, b) => a - b).slice(0, useCount);
  const avg = best.reduce((a, b) => a + b, 0) / best.length;
  return { handicapIndex: Math.round((avg + adjustment) * 10) / 10, useCount };
}

/**
 * One-off: recompute every player's stored handicap_index from their last
 * 20 SOLO rated rounds using the formula above, so the stored value (used on
 * the profile + strokes-gained baseline) matches the live handicap view.
 * Only writes users with enough rated solo rounds for an index — fewer than 3
 * keeps whatever they had. This DOES overwrite a manually-entered handicap
 * for anyone with 3+ solo rated rounds.
 */
export async function backfillHandicaps(): Promise<{ usersUpdated: number }> {
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT r.user_id, r.total_score,
             COALESCE(array_length(r.hole_scores, 1), t.num_holes) AS holes_played,
             t.num_holes AS teebox_holes,
             m.holes_subset,
             t.course_rating, t.slope_rating,
             t.front_course_rating, t.front_slope_rating,
             t.back_course_rating, t.back_slope_rating,
             row_number() OVER (PARTITION BY r.user_id ORDER BY r.created_at DESC) AS rn
        FROM rounds r
        JOIN matches m ON m.match_id = r.match_id
        JOIN teeboxes t ON t.teebox_id = r.teebox_id
       WHERE r.total_score IS NOT NULL
         AND m.completed = true AND m.is_practice = false
         AND m.match_type = 'solo'
         AND t.course_rating IS NOT NULL AND t.slope_rating IS NOT NULL
    )
    SELECT * FROM ranked WHERE rn <= 20
  `);

  const byUser = new Map<string, HandicapRound[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }

  let usersUpdated = 0;
  for (const [userId, rs] of byUser) {
    const diffs = rs.map((r) => roundDifferential(r).diff);
    const { handicapIndex } = whsHandicapIndex(diffs);
    if (handicapIndex == null) continue;
    await pool.query(`UPDATE users SET handicap_index = $1 WHERE user_id = $2`, [handicapIndex, userId]);
    usersUpdated++;
  }
  return { usersUpdated };
}
