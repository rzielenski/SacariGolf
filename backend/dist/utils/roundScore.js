"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncRoundNormalized = syncRoundNormalized;
exports.reconcileNormalizedScores = reconcileNormalizedScores;
/**
 * Keeps the stored `rounds.normalized_to_par` column in sync, computed ONLY in
 * app code (never in SQL). The value is `normalizedScore` from utils/scoring.ts
 * — an 18-hole-equivalent score that is rating/slope-adjusted (a USGA score
 * differential) when the teebox has course rating + slope, else a par-based
 * to-par fallback. Either way it's one comparable integer every cross-player
 * board ranks on with a plain `ORDER BY normalized_to_par`.
 *
 * Two entry points:
 *   • syncRoundNormalized(exec, roundId) — recompute one round, synchronously,
 *     at the moment its score is written (pass the open transaction client so
 *     it commits atomically with the submit). Gives instant ranking.
 *   • reconcileNormalizedScores() — fill every round that has a score but no
 *     stored value yet. Run on boot (backfills history) and on the background
 *     tick (catches bots, solo auto-play, organizer rounds, and anything the
 *     submit hook didn't touch). Pure code, batched.
 */
const pool_1 = __importDefault(require("../db/pool"));
const scoring_1 = require("./scoring");
/** The columns both the sync + reconcile queries select for a round, joined to
 *  its teebox (par + rating/slope) and match (holes_subset). */
const ROUND_SCORE_COLS = `
  r.total_score, r.hole_scores,
  t.par, t.num_holes,
  t.course_rating, t.slope_rating,
  t.front_course_rating, t.front_slope_rating,
  t.back_course_rating, t.back_slope_rating,
  m.holes_subset
`;
/** Compute the stored value from a joined row, or null when the round can't be
 *  scored yet (no total, or a teebox without par). holesPlayed mirrors the SQL
 *  `array_length(hole_scores, 1)` — array length, not non-null count. */
function valueFor(row) {
    if (row.total_score == null || row.par == null || !row.num_holes)
        return null;
    // Match SQL array_length(hole_scores, 1): an empty/absent array is NULL there
    // and falls back to num_holes — JS [].length would be 0 and divide by zero.
    const len = Array.isArray(row.hole_scores) ? row.hole_scores.length : 0;
    const holesPlayed = len > 0 ? len : Number(row.num_holes);
    const num = (v) => (v != null ? Number(v) : null);
    return (0, scoring_1.normalizedScore)({
        totalScore: Number(row.total_score),
        par: Number(row.par),
        numHoles: Number(row.num_holes),
        holesPlayed,
        courseRating: num(row.course_rating),
        slopeRating: num(row.slope_rating),
        holesSubset: row.holes_subset ?? null,
        frontCourseRating: num(row.front_course_rating),
        frontSlopeRating: num(row.front_slope_rating),
        backCourseRating: num(row.back_course_rating),
        backSlopeRating: num(row.back_slope_rating),
    });
}
/**
 * Recompute + store normalized_to_par for one round. Safe to call on every
 * submit (including re-submits / score edits) — it overwrites with the fresh
 * value. Pass the transaction client at submit time so it's atomic; defaults to
 * the pool otherwise.
 */
async function syncRoundNormalized(exec, roundId) {
    const { rows } = await exec.query(`SELECT ${ROUND_SCORE_COLS}
       FROM rounds r
       JOIN teeboxes t ON t.teebox_id = r.teebox_id
       LEFT JOIN matches m ON m.match_id = r.match_id
      WHERE r.round_id = $1`, [roundId]);
    if (!rows.length)
        return;
    await exec.query(`UPDATE rounds SET normalized_to_par = $2 WHERE round_id = $1`, [roundId, valueFor(rows[0])]);
}
/**
 * Fill any round that has a score but no stored normalized_to_par yet (a fresh
 * INSERT from a path the submit hook doesn't cover, or historical rows on first
 * deploy). Batched + bounded so a tick can never run away. Returns how many it
 * filled. Rounds on a teebox without par are skipped permanently (can't score).
 */
async function reconcileNormalizedScores() {
    let filled = 0;
    for (let batch = 0; batch < 200; batch++) { // hard cap: 200 * 1000 rounds
        const { rows } = await pool_1.default.query(`SELECT r.round_id, ${ROUND_SCORE_COLS}
         FROM rounds r
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
         LEFT JOIN matches m ON m.match_id = r.match_id
        WHERE r.total_score IS NOT NULL
          AND r.normalized_to_par IS NULL
          AND t.par IS NOT NULL
        LIMIT 1000`);
        if (!rows.length)
            break;
        for (const row of rows) {
            const v = valueFor(row);
            if (v == null)
                continue;
            await pool_1.default.query(`UPDATE rounds SET normalized_to_par = $2 WHERE round_id = $1`, [row.round_id, v]);
            filled++;
        }
        if (rows.length < 1000)
            break;
    }
    return filled;
}
