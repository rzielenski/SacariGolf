"use strict";
/**
 * Competitive Seasons + Divisions ladder.
 *
 * Model (v1):
 *   • DIVISION = a persistent skill tier derived from the player's lifetime
 *     ELO (Bronze → Diamond). It's where they sit on the ladder; climbing ELO
 *     promotes them. No reset — ELO is the durable skill signal.
 *   • SEASON   = a recurring 6-month window aligned to the golf calendar:
 *     Summer (May–Oct, the playing season) and Winter (Nov–Apr, off-season).
 *     Within it, players compete for STANDINGS in their division, scored by
 *     ranked-match results during the season (win = 3, tie = 1, loss = 0).
 *     The standings reset each season; the top of each division earns
 *     end-of-season rewards (distributed by a future cron).
 *
 * Endpoints:
 *   GET /seasons/current             → the active season + the caller's
 *                                       division, progress to the next tier,
 *                                       and their season record.
 *   GET /seasons/current/standings   → the season leaderboard, filterable by
 *                                       division and global/friends scope.
 *
 * The season window is computed from the date (UTC), so no rollover cron is
 * needed for the ladder itself — only the eventual reward payout.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const asyncHandler_1 = require("../utils/asyncHandler");
const router = (0, express_1.Router)();
// 8-tier ladder (mirrors mobile/lib/rank.ts). New players start at the 100-ELO
// floor (Wood); each tier spans 200 ELO and is split client-side into 4
// divisions of 50 LP. Obsidian (1500+) is the open-ended elite tier. These
// bands are TIER-level — the sub-division (Wood 4 → Wood 1) is derived on the
// client from the raw ELO; here we only need the tier for filters/labels.
const DIVISIONS = [
    { key: 'wood', name: 'Wood', color: '#9c7b4f', min: 0, max: 300 },
    { key: 'bronze', name: 'Bronze', color: '#c8863f', min: 300, max: 500 },
    { key: 'silver', name: 'Silver', color: '#aeb6c2', min: 500, max: 700 },
    { key: 'gold', name: 'Gold', color: '#d4a93f', min: 700, max: 900 },
    { key: 'platinum', name: 'Platinum', color: '#74bd9a', min: 900, max: 1100 },
    { key: 'ruby', name: 'Ruby', color: '#d83a5e', min: 1100, max: 1300 },
    { key: 'diamond', name: 'Diamond', color: '#a89cf0', min: 1300, max: 1500 },
    { key: 'obsidian', name: 'Obsidian', color: '#e8623a', min: 1500, max: Infinity },
];
// Placement matches (League of Legends / Overwatch convention): the first N
// ranked matches of a season "place" the player before their season standing
// is considered locked in. Purely motivational here — it gates nothing, it
// just gives a new season a satisfying on-ramp.
const PLACEMENT_MATCHES = 5;
function divisionForElo(elo) {
    return DIVISIONS.find((d) => elo >= d.min && elo < d.max) ?? DIVISIONS[0];
}
function nextDivision(d) {
    const i = DIVISIONS.findIndex((x) => x.key === d.key);
    return i >= 0 && i < DIVISIONS.length - 1 ? DIVISIONS[i + 1] : null;
}
/** Current season window (UTC), aligned to the golf calendar (deterministic
 *  from the date):
 *   • SUMMER — May 1 → Nov 1 (the May-through-October playing season).
 *   • WINTER — Nov 1 → May 1 (the off-season; spans the year boundary).
 *  Six months each, so the division climb carries real weight before reset. */
function currentSeason() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0 = Jan
    let id, name, start, end;
    if (m >= 4 && m <= 9) {
        // Main golf season: May 1 → Nov 1 (May through October).
        start = new Date(Date.UTC(y, 4, 1));
        end = new Date(Date.UTC(y, 10, 1));
        id = `${y}-summer`;
        name = `Summer ${y}`;
    }
    else {
        // Off-season: Nov 1 → May 1, anchored to the November it began in
        // (Nov/Dec use this year's November; Jan–Apr use last year's).
        const sy = m >= 10 ? y : y - 1;
        start = new Date(Date.UTC(sy, 10, 1));
        end = new Date(Date.UTC(sy + 1, 4, 1));
        id = `${sy}-winter`;
        name = `Winter ${sy}–${String((sy + 1) % 100).padStart(2, '0')}`;
    }
    const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));
    return { id, name, starts_at: start.toISOString(), ends_at: end.toISOString(), days_left: daysLeft };
}
/** Per-user season record aggregation, shared by both endpoints. */
const RECORD_SELECT = `
  COUNT(*)::int AS matches,
  COALESCE(SUM(CASE WHEN mr.winner_side = mp.side THEN 1 ELSE 0 END), 0)::int AS wins,
  COALESCE(SUM(CASE WHEN mr.winner_side IS NULL THEN 1 ELSE 0 END), 0)::int AS ties,
  COALESCE(SUM(CASE WHEN mr.winner_side IS NOT NULL AND mr.winner_side <> mp.side THEN 1 ELSE 0 END), 0)::int AS losses,
  COALESCE(SUM(CASE WHEN mr.winner_side = mp.side THEN 3 WHEN mr.winner_side IS NULL THEN 1 ELSE 0 END), 0)::int AS points
`;
router.get('/current', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const season = currentSeason();
    const { rows: uRows } = await pool_1.default.query(`SELECT elo FROM users WHERE user_id = $1`, [req.userId]);
    const elo = uRows[0]?.elo ?? 1200;
    const division = divisionForElo(elo);
    const next = nextDivision(division);
    const { rows: recRows } = await pool_1.default.query(`SELECT ${RECORD_SELECT}
       FROM match_results mr
       JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
       JOIN match_players mp ON mp.match_id = mr.match_id AND mp.user_id = $1
      WHERE mr.created_at >= $2 AND mr.created_at < $3`, [req.userId, season.starts_at, season.ends_at]);
    const record = recRows[0] ?? { matches: 0, wins: 0, ties: 0, losses: 0, points: 0 };
    // ── Ranked-ladder polish borrowed from competitive games ────────────────
    //   • WIN STREAKS (Hearthstone / Destiny 2 Valor): the player's trailing run
    //     of consecutive ranked wins this season, plus their best run. Only a win
    //     extends the current streak; a loss or tie ends it.
    //   • PLACEMENTS (League of Legends / Overwatch): how far through the
    //     PLACEMENT_MATCHES on-ramp the player is this season.
    const { rows: outcomeRows } = await pool_1.default.query(`SELECT CASE
              WHEN mr.winner_side = mp.side THEN 'win'
              WHEN mr.winner_side IS NULL   THEN 'tie'
              ELSE 'loss'
            END AS outcome
       FROM match_results mr
       JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
       JOIN match_players mp ON mp.match_id = mr.match_id AND mp.user_id = $1
      WHERE mr.created_at >= $2 AND mr.created_at < $3
      ORDER BY mr.created_at DESC`, [req.userId, season.starts_at, season.ends_at]);
    // outcomeRows is newest→oldest. Current streak = leading run of wins.
    let currentStreak = 0;
    for (const r of outcomeRows) {
        if (r.outcome === 'win')
            currentStreak += 1;
        else
            break;
    }
    // Best streak = longest run of consecutive wins anywhere this season.
    let bestStreak = 0, run = 0;
    for (const r of outcomeRows) {
        if (r.outcome === 'win') {
            run += 1;
            if (run > bestStreak)
                bestStreak = run;
        }
        else
            run = 0;
    }
    const played = record.matches ?? 0;
    return res.json({
        season,
        divisions: DIVISIONS.map((d) => ({ key: d.key, name: d.name, color: d.color })),
        me: {
            elo,
            division: {
                key: division.key, name: division.name, color: division.color,
                min: division.min,
                // JSON can't carry Infinity — the top tier reports null (no ceiling).
                max: division.max === Infinity ? null : division.max,
            },
            next_division: next ? { key: next.key, name: next.name, color: next.color, min: next.min } : null,
            elo_to_next: next ? Math.max(0, next.min - elo) : null,
            record,
            streak: { current: currentStreak, best: bestStreak },
            placement: {
                played,
                required: PLACEMENT_MATCHES,
                placing: played < PLACEMENT_MATCHES,
            },
        },
    });
}));
router.get('/current/standings', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const season = currentSeason();
    // Division filter — default to the caller's own division so they land on the
    // most relevant board. 'all' shows every player who competed this season.
    const divKey = typeof req.query.division === 'string' ? req.query.division : null;
    let band;
    if (divKey === 'all') {
        band = { min: 0, max: Number.MAX_SAFE_INTEGER };
    }
    else if (divKey && DIVISIONS.some((d) => d.key === divKey)) {
        const d = DIVISIONS.find((x) => x.key === divKey);
        band = { min: d.min, max: d.max === Infinity ? Number.MAX_SAFE_INTEGER : d.max };
    }
    else {
        const { rows } = await pool_1.default.query(`SELECT elo FROM users WHERE user_id = $1`, [req.userId]);
        const d = divisionForElo(rows[0]?.elo ?? 1200);
        band = { min: d.min, max: d.max === Infinity ? Number.MAX_SAFE_INTEGER : d.max };
    }
    const friendsOnly = req.query.scope === 'friends';
    const params = [season.starts_at, season.ends_at, band.min, band.max];
    let friendClause = '';
    if (friendsOnly) {
        params.push(req.userId);
        friendClause = `AND (u.user_id = $5 OR u.user_id IN (
      SELECT friend_id FROM friends WHERE user_id = $5 AND status = 'accepted'
      UNION
      SELECT user_id FROM friends WHERE friend_id = $5 AND status = 'accepted'
    ))`;
    }
    const { rows } = await pool_1.default.query(`WITH season AS (
       SELECT mp.user_id, ${RECORD_SELECT}
         FROM match_results mr
         JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
         JOIN match_players mp ON mp.match_id = mr.match_id
        WHERE mr.created_at >= $1 AND mr.created_at < $2
        GROUP BY mp.user_id
     ),
     -- Per-user current win streak (Hearthstone-style 🔥). Number each user's
     -- ranked results newest-first; the streak is the count of leading wins
     -- before the first non-win row. No non-win → every result was a win.
     ranked AS (
       SELECT mp.user_id,
              (mr.winner_side IS NULL OR mr.winner_side <> mp.side) AS not_won,
              row_number() OVER (PARTITION BY mp.user_id ORDER BY mr.created_at DESC) AS rn
         FROM match_results mr
         JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
         JOIN match_players mp ON mp.match_id = mr.match_id
        WHERE mr.created_at >= $1 AND mr.created_at < $2
     ),
     streaks AS (
       SELECT user_id,
              COALESCE(MIN(rn) FILTER (WHERE not_won) - 1, COUNT(*))::int AS current_streak
         FROM ranked
        GROUP BY user_id
     )
     SELECT u.user_id, u.username, u.avatar_url, u.elo,
            s.matches, s.wins, s.ties, s.losses, s.points,
            COALESCE(st.current_streak, 0) AS current_streak
       FROM season s
       JOIN users u ON u.user_id = s.user_id
       LEFT JOIN streaks st ON st.user_id = s.user_id
      WHERE u.elo >= $3 AND u.elo < $4
        ${friendClause}
      ORDER BY s.points DESC, s.wins DESC, s.matches ASC, u.elo DESC
      LIMIT 100`, params);
    // Tag each row with its division key so the client can badge mixed lists.
    const standings = rows.map((r, i) => ({
        ...r,
        rank: i + 1,
        division_key: divisionForElo(r.elo).key,
    }));
    return res.json({ season, division: divKey ?? null, standings });
}));
exports.default = router;
