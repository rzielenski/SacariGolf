"use strict";
/**
 * Weekly Sacari Cup — auto-recurring free-to-enter tournament.
 *
 *   • One cup per week, week_starts_at = Monday 00:00 UTC.
 *   • Players' BEST round (lowest pro-rated to-par) during the week counts.
 *   • Resolution awards cup-winner cosmetics to top 3 finishers, posts a
 *     feed card, and sends a push notification.
 *
 * No cron daemon: invoked at server boot and folded into the existing
 * pairing-pass interval. That gives at-most-60-seconds latency on the
 * "Sunday → Monday handover" while keeping the surface area small.
 *
 * Resolution is idempotent — guarded by status='active' + UPDATE …
 * RETURNING so concurrent restarts only run the payout block once. The
 * unique index on week_starts_at protects creation likewise.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureCurrentCup = ensureCurrentCup;
exports.resolveFinishedCups = resolveFinishedCups;
const pool_1 = __importDefault(require("../db/pool"));
const notify_1 = require("./notify");
/** Round a TIMESTAMPTZ down to its containing Monday 00:00 UTC.
 *  Postgres syntax used everywhere so we don't drift from server clock. */
const MONDAY_OF_NOW_SQL = `date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
/** Ensure the current week has an open cup. Idempotent via the unique
 *  index on week_starts_at — a concurrent boot just hits ON CONFLICT. */
async function ensureCurrentCup() {
    await pool_1.default.query(`INSERT INTO weekly_cups (week_starts_at)
     VALUES (${MONDAY_OF_NOW_SQL})
     ON CONFLICT (week_starts_at) DO NOTHING`);
}
/** Resolve any active cup whose week has already ended. Returns the
 *  number of cups resolved (zero is the steady-state during the week). */
async function resolveFinishedCups() {
    // Find finished-but-still-active cups (week ended at least 1s ago).
    const { rows: cups } = await pool_1.default.query(`SELECT cup_id, week_starts_at
       FROM weekly_cups
      WHERE status = 'active'
        AND week_starts_at < ${MONDAY_OF_NOW_SQL}`);
    let resolved = 0;
    for (const cup of cups) {
        const ok = await resolveOne(cup.cup_id, cup.week_starts_at);
        if (ok)
            resolved++;
    }
    return resolved;
}
/** Resolve a single cup. Atomic-ish: the leaderboard read + payouts run
 *  outside a transaction (the payouts are best-effort idempotent on their
 *  own), but the status flip is conditional on the previous status so a
 *  second concurrent caller for the same cup is a no-op. */
async function resolveOne(cupId, weekStartsAt) {
    // Claim the cup. RETURNING-empty means another caller beat us to it.
    const { rows: claim } = await pool_1.default.query(`UPDATE weekly_cups
        SET status = 'resolved', resolved_at = NOW()
      WHERE cup_id = $1 AND status = 'active'
      RETURNING cup_id`, [cupId]);
    if (!claim.length)
        return false;
    // ── Leaderboard query ──────────────────────────────────────────────
    // Each player's BEST round during the week, pro-rated to holes played.
    // Same SQL formula as the profile screen / Best Round card so the
    // ranking matches what the player sees on their own card.
    const weekEnd = new Date(weekStartsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const { rows: top } = await pool_1.default.query(`WITH best AS (
       SELECT r.user_id,
              MIN(r.total_score
                  - ROUND(t.par::numeric
                          * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                          / NULLIF(t.num_holes, 0)::numeric)::int) AS best_to_par,
              MIN(r.round_id::text) AS round_id
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
        WHERE r.total_score IS NOT NULL
          AND m.completed = true
          AND m.is_practice = false
          AND m.match_type = 'solo'   -- Sacari Cup counts SOLO rounds only
          AND r.created_at >= $1
          AND r.created_at <  $2
          AND t.par IS NOT NULL
        GROUP BY r.user_id
     )
     SELECT b.user_id, b.best_to_par, u.username, u.push_token
       FROM best b
       JOIN users u ON u.user_id = b.user_id
      WHERE u.is_bot = false   -- bots never win the Sacari Cup
      ORDER BY b.best_to_par ASC
      LIMIT 3`, [weekStartsAt, weekEnd]);
    // No entries: still resolved (status flipped above), no payouts.
    if (!top.length)
        return true;
    // ── Pin the winner so the home banner + profile trophy row can
    // count cups won later. ────────────────────────────────────────────
    const champion = top[0];
    await pool_1.default.query(`INSERT INTO weekly_cup_winners (cup_id, user_id, best_to_par)
     VALUES ($1, $2, $3)
     ON CONFLICT (cup_id) DO NOTHING`, [cupId, champion.user_id, champion.best_to_par]);
    // ── Award cup-winner cosmetics ─────────────────────────────────────
    // Only the #1 finisher gets a cosmetic (the Champion Wreath border).
    // Per user request: dropped the gold-frame + gold-text payouts —
    // the trophy itself (tracked above) is the prestige. Idempotent via
    // PK on user_cosmetics.
    await pool_1.default.query(`INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
       SELECT $1, c.cosmetic_id, $2
         FROM cosmetics c
        WHERE c.unlock_kind = 'cup_winner'
          AND (c.unlock_data ->> 'place')::int = 1
     ON CONFLICT (user_id, cosmetic_id) DO NOTHING`, [champion.user_id, `cup_${cupId}_winner`]);
    // ── Push notify finishers ──────────────────────────────────────────
    // Only the champion gets a cosmetic + trophy, but 2nd/3rd still get a
    // congratulatory ping so they know they were on the podium.
    const tokens = top
        .map((w, i) => ({ token: w.push_token, place: i + 1, name: w.username }))
        .filter((w) => !!w.token);
    for (const w of tokens) {
        const medal = w.place === 1 ? '🥇' : w.place === 2 ? '🥈' : '🥉';
        await (0, notify_1.sendPush)([w.token], `${medal} Sacari Cup result`, w.place === 1
            ? `You won this week's Sacari Cup! 🏆 Champion Wreath border + trophy added to your profile.`
            : `You finished #${w.place} in this week's Sacari Cup. So close — try again this week.`, { type: 'cup_result', cupId, place: w.place });
    }
    // ── Feed post — single card under the champion summarising podium ─
    try {
        const podium = top.map((w, i) => `${i + 1}. ${w.username}`).join('  ·  ');
        await pool_1.default.query(`INSERT INTO posts (user_id, kind, body)
       VALUES ($1, 'text', $2)`, [
            champion.user_id,
            `🏆 Sacari Cup Champion — Week of ${weekStartsAt.toISOString().slice(0, 10)}\n${podium}`,
        ]);
    }
    catch (e) {
        // Non-fatal: payouts already landed.
        console.error('[weekly-cup] feed post failed:', e);
    }
    return true;
}
