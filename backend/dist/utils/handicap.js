"use strict";
/**
 * WHS-style handicap index, shared by the live GET /users/:id/handicap endpoint
 * and the one-off backfill so they can never disagree.
 *
 * The score-differential math (roundDifferential) now lives in utils/scoring.ts
 * so the leaderboards and the handicap index share ONE definition. It's
 * re-exported here so existing importers (routes/users.ts) are unchanged.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundDifferential = void 0;
exports.whsHandicapIndex = whsHandicapIndex;
exports.backfillHandicaps = backfillHandicaps;
const pool_1 = __importDefault(require("../db/pool"));
const scoring_1 = require("./scoring");
Object.defineProperty(exports, "roundDifferential", { enumerable: true, get: function () { return scoring_1.roundDifferential; } });
/** WHS lookup: how many of the lowest differentials to average + the
 *  small-sample adjustment, then the resulting index (or null if too few
 *  rounds). Input is the raw differential list (any order). */
function whsHandicapIndex(differentials) {
    const N = differentials.length;
    let useCount = 0;
    let adjustment = 0;
    if (N >= 20) {
        useCount = 8;
    }
    else if (N >= 19) {
        useCount = 7;
    }
    else if (N >= 17) {
        useCount = 6;
    }
    else if (N >= 15) {
        useCount = 5;
    }
    else if (N >= 12) {
        useCount = 4;
    }
    else if (N >= 9) {
        useCount = 3;
    }
    else if (N >= 7) {
        useCount = 2;
    }
    else if (N >= 6) {
        useCount = 2;
        adjustment = -1;
    }
    else if (N >= 5) {
        useCount = 1;
    }
    else if (N >= 4) {
        useCount = 1;
        adjustment = -1;
    }
    else if (N >= 3) {
        useCount = 1;
        adjustment = -2;
    }
    if (useCount === 0)
        return { handicapIndex: null, useCount };
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
async function backfillHandicaps() {
    const { rows } = await pool_1.default.query(`
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
    const byUser = new Map();
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
            const d = (0, scoring_1.roundDifferential)(r).diff;
            return r.holes_played === 9 ? d * 2 : d;
        });
        const { handicapIndex } = whsHandicapIndex(diffs);
        if (handicapIndex == null)
            continue;
        await pool_1.default.query(`UPDATE users SET handicap_index = $1 WHERE user_id = $2`, [handicapIndex, userId]);
        usersUpdated++;
    }
    return { usersUpdated };
}
