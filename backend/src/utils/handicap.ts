/**
 * WHS-style handicap index, shared by the live GET /users/:id/handicap endpoint
 * and the one-off backfill so they can never disagree.
 *
 * The score-differential math (roundDifferential) now lives in utils/scoring.ts
 * so the leaderboards and the handicap index share ONE definition. It's
 * re-exported here so existing importers (routes/users.ts) are unchanged.
 */

import pool from '../db/pool';
import { roundDifferential, type HandicapRound } from './scoring';

// Re-export: callers keep importing the differential from here, while the math
// itself stays centralized in scoring.ts (same value the leaderboards rank on).
export { roundDifferential };
export type { HandicapRound };

/**
 * Handicap index = the average of the BEST 8 (lowest) differentials of the last
 * 20 rounds. With fewer than 8 rounds in the window, average all of them EXCEPT
 * the single worst, so one blow-up round doesn't anchor a new player's handicap.
 * With a single round there's nothing to drop, so that round is used as-is.
 * Returns null only when there are no rounds.
 *
 * The caller passes the last-20 differentials (any order), already scaled to
 * 18-hole equivalents. The 20-round window is enforced by the caller's query.
 */
export function whsHandicapIndex(differentials: number[]): { handicapIndex: number | null; useCount: number } {
  const N = differentials.length;
  if (N === 0) return { handicapIndex: null, useCount: 0 };
  const sorted = [...differentials].sort((a, b) => a - b); // best (lowest) first
  const chosen = N >= 8
    ? sorted.slice(0, 8)        // best 8 of the last 20
    : N === 1
      ? sorted                  // one round: nothing to drop
      : sorted.slice(0, N - 1); // drop only the single worst
  const avg = chosen.reduce((a, b) => a + b, 0) / chosen.length;
  return { handicapIndex: Math.round(avg * 10) / 10, useCount: chosen.length };
}

/**
 * One-off: recompute every player's stored handicap_index from their last
 * 20 SOLO rated rounds using the formula above, so the stored value (used on
 * the profile + strokes-gained baseline) matches the live handicap view.
 * Only writes users with at least one rated solo round; with none, it keeps
 * whatever they had. This DOES overwrite a manually-entered handicap for
 * anyone with rated solo rounds.
 */
export async function backfillHandicaps(): Promise<{ usersUpdated: number }> {
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT r.user_id, r.total_score,
             -- per-hole array length → else the MATCH's hole count → else the
             -- teebox's (a 9-hole total-only round on an 18-hole tee must not
             -- read as 18). Mirrors the live /handicap query.
             COALESCE(array_length(r.hole_scores, 1), m.num_holes, t.num_holes) AS holes_played,
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
    // 18-hole equivalent for the index: a 9-hole differential is half-scale,
    // so double it before pooling (mirrors the live /handicap endpoint).
    const diffs = rs.map((r) => {
      const d = roundDifferential(r).diff;
      return r.holes_played === 9 ? d * 2 : d;
    });
    const { handicapIndex } = whsHandicapIndex(diffs);
    if (handicapIndex == null) continue;
    await pool.query(`UPDATE users SET handicap_index = $1 WHERE user_id = $2`, [handicapIndex, userId]);
    usersUpdated++;
  }
  return { usersUpdated };
}
