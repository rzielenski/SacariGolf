"use strict";
/**
 * Cosmetics + weekly Sacari Cup endpoints.
 *
 *   GET  /cosmetics/catalog      → all items + each item's unlock rule
 *   GET  /users/me/cosmetics     → my owned set + currently-equipped slots
 *   POST /users/me/cosmetics/equip { kind, cosmetic_id|null }
 *                                → equip an owned item to a slot (null = clear)
 *
 *   GET  /weekly-cup/current     → this week's leaderboard, my row, prizes,
 *                                  time-remaining + the recent champions
 *
 * The catalog is data-driven (rows in the `cosmetics` table), so adding a
 * new cosmetic is a SQL insert, not an app release. visual_data is opaque
 * JSON that the mobile renderer interprets per `kind`.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const asyncHandler_1 = require("../utils/asyncHandler");
const cosmeticSql_1 = require("../utils/cosmeticSql");
const owner_1 = require("../utils/owner");
const router = (0, express_1.Router)();
const VALID_KINDS = new Set(['border', 'background', 'username', 'ball_trail', 'fx']);
const EQUIP_COLUMN = {
    border: 'equipped_border',
    background: 'equipped_background',
    username: 'equipped_username',
    ball_trail: 'equipped_ball_trail',
    fx: 'equipped_fx',
};
router.get('/cosmetics/catalog', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (_req, res) => {
    const { rows } = await pool_1.default.query(`SELECT cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data
       FROM cosmetics
      ORDER BY kind, rarity, name`);
    return res.json({ items: rows });
}));
router.get('/users/me/cosmetics', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    // Owned set + the equipped slot for each kind. Single round-trip; the
    // mobile screen renders the catalog separately and intersects.
    const owner = await (0, owner_1.isOwner)(req.userId);
    const [{ rows: owned }, { rows: equippedRows }] = await Promise.all([
        // Owners dynamically own the entire catalog — no per-item grant rows,
        // so the locker is always complete even as the catalog grows.
        owner
            ? pool_1.default.query(`SELECT cosmetic_id FROM cosmetics`)
            : pool_1.default.query(`SELECT cosmetic_id, unlocked_at, unlock_source
             FROM user_cosmetics
            WHERE user_id = $1`, [req.userId]),
        pool_1.default.query(`SELECT equipped_border, equipped_background, equipped_username,
              equipped_ball_trail, equipped_fx
         FROM users WHERE user_id = $1`, [req.userId]),
    ]);
    const e = equippedRows[0] ?? {};
    return res.json({
        owned: owned.map((r) => r.cosmetic_id),
        equipped: {
            border: e.equipped_border ?? null,
            background: e.equipped_background ?? null,
            username: e.equipped_username ?? null,
            ball_trail: e.equipped_ball_trail ?? null,
            fx: e.equipped_fx ?? null,
        },
    });
}));
router.post('/users/me/cosmetics/equip', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { kind, cosmetic_id } = req.body ?? {};
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind)) {
        return res.status(400).json({ error: 'kind must be border|background|username|ball_trail|fx' });
    }
    const col = EQUIP_COLUMN[kind];
    if (cosmetic_id == null) {
        // Clear the slot.
        await pool_1.default.query(`UPDATE users SET ${col} = NULL WHERE user_id = $1`, [req.userId]);
        return res.json({ success: true, kind, cosmetic_id: null });
    }
    if (typeof cosmetic_id !== 'string') {
        return res.status(400).json({ error: 'cosmetic_id must be string or null' });
    }
    // Ownership + kind check. We do BOTH to prevent equipping a border into
    // the username slot (mismatched-kind UI confusion) AND equipping an item
    // the user doesn't own. Owners skip the ownership half (they own
    // everything) but the kind check still applies to everyone.
    const owner = await (0, owner_1.isOwner)(req.userId);
    const { rows: check } = owner
        ? await pool_1.default.query(`SELECT kind FROM cosmetics WHERE cosmetic_id = $1`, [cosmetic_id])
        : await pool_1.default.query(`SELECT c.kind
           FROM cosmetics c
           JOIN user_cosmetics uc ON uc.cosmetic_id = c.cosmetic_id
          WHERE uc.user_id = $1 AND c.cosmetic_id = $2`, [req.userId, cosmetic_id]);
    if (!check.length) {
        return res.status(403).json({
            error: owner ? 'No such cosmetic' : 'You do not own that cosmetic',
        });
    }
    if (check[0].kind !== kind) {
        return res.status(400).json({ error: `That cosmetic is a ${check[0].kind}, not a ${kind}` });
    }
    await pool_1.default.query(`UPDATE users SET ${col} = $2 WHERE user_id = $1`, [req.userId, cosmetic_id]);
    return res.json({ success: true, kind, cosmetic_id });
}));
/**
 * Weekly Sacari Cup — this week's leaderboard, the caller's row, prizes,
 * time remaining. Mirrors the resolution query in utils/weeklyCup.ts so
 * the live leaderboard players see during the week matches what will be
 * paid out at week's end.
 */
router.get('/weekly-cup/current', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    // Find / create the current week's cup. Defensive: if the background
    // tick hasn't fired yet (very fresh server boot), ensure one here so a
    // first-load doesn't return null.
    await pool_1.default.query(`INSERT INTO weekly_cups (week_starts_at)
     VALUES (date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
     ON CONFLICT (week_starts_at) DO NOTHING`);
    const { rows: cupRows } = await pool_1.default.query(`SELECT cup_id, week_starts_at
       FROM weekly_cups
      WHERE status = 'active'
      ORDER BY week_starts_at DESC
      LIMIT 1`);
    if (!cupRows.length)
        return res.json({ cup: null, leaderboard: [], my_row: null });
    const cup = cupRows[0];
    const weekStartsAt = cup.week_starts_at;
    const weekEnd = new Date(weekStartsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Each player's best round during the window, pro-rated to holes
    // actually played (same formula as the user_profile best_round query).
    const { rows: leaderboard } = await pool_1.default.query(`WITH best AS (
       SELECT r.user_id,
              -- Pre-computed 18-hole-equivalent to-par (app code fills the
              -- column), so 9- and 18-hole rounds compare on one basis.
              MIN(r.normalized_to_par) AS best_to_par,
              MIN(r.created_at) AS first_at
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id
        WHERE r.normalized_to_par IS NOT NULL
          AND m.completed = true
          AND m.is_practice = false
          AND m.match_type = 'solo'   -- Sacari Cup counts SOLO rounds only
          AND r.created_at >= $1
          AND r.created_at <  $2
        GROUP BY r.user_id
     )
     SELECT b.user_id, b.best_to_par,
            u.username, u.avatar_url, u.elo,
            ${(0, cosmeticSql_1.equippedVisualSql)('u')} AS equipped_visual
       FROM best b
       JOIN users u ON u.user_id = b.user_id
      -- Bots can't win the cup, so they're kept out of the standings too.
      WHERE u.is_bot = false
      ORDER BY b.best_to_par ASC, b.first_at ASC
      LIMIT 100`, [weekStartsAt, weekEnd]);
    const ranked = leaderboard.map((r, i) => ({
        ...r,
        rank: i + 1,
        is_me: r.user_id === req.userId,
    }));
    const myRow = ranked.find((r) => r.is_me) ?? null;
    // Past champions strip — the last 4 resolved cups' ACTUAL winners, read
    // straight from weekly_cup_winners (what utils/weeklyCup.ts pinned and paid
    // out). This used to RECOMPUTE the winner from rounds, which picked the
    // wrong name: that subquery had no is_bot filter and used raw (un-normalized)
    // to-par, so a bot or a strong 9-hole round could outrank the real champion.
    // Reading the stored table makes the strip match the trophy + home banner.
    const { rows: pastChamps } = await pool_1.default.query(`SELECT wc.week_starts_at, u.username, u.avatar_url,
            ${(0, cosmeticSql_1.equippedVisualSql)('u')} AS equipped_visual
       FROM weekly_cup_winners w
       JOIN weekly_cups wc ON wc.cup_id = w.cup_id
       JOIN users u        ON u.user_id = w.user_id
      WHERE u.is_bot = false
      ORDER BY wc.week_starts_at DESC
      LIMIT 4`);
    return res.json({
        cup: {
            cup_id: cup.cup_id,
            week_starts_at: weekStartsAt,
            week_ends_at: weekEnd,
        },
        leaderboard: ranked,
        my_row: myRow,
        past_champions: pastChamps,
        // The cup pays out exactly what utils/weeklyCup.ts awards: the
        // champion border + a trophy + the home-page banner for the week.
        // (The old gold-frame/gold-text payouts were cut from the catalog.)
        prizes: {
            first: 'Champion Wreath border, a trophy on your profile, and your name on the home page all week',
            second: null,
            third: null,
        },
    });
}));
/**
 * Last resolved Sacari Cup champion. Drives the home-tab banner. Returns
 * the user + the week + their winning score, or null if no cup has ever
 * resolved (fresh database).
 */
router.get('/weekly-cup/last-champion', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (_req, res) => {
    const { rows } = await pool_1.default.query(`SELECT w.cup_id, w.user_id, w.best_to_par, w.decided_at,
            wc.week_starts_at,
            u.username, u.avatar_url, u.elo,
            ${(0, cosmeticSql_1.equippedVisualSql)('u')} AS equipped_visual
       FROM weekly_cup_winners w
       JOIN weekly_cups wc ON wc.cup_id = w.cup_id
       JOIN users u        ON u.user_id = w.user_id
      WHERE u.is_bot = false   -- never surface a (stale) bot champion
      ORDER BY w.decided_at DESC
      LIMIT 1`);
    return res.json({ champion: rows[0] ?? null });
}));
/**
 * Season Pass — current month's progression for the caller. Includes
 * total XP, days remaining, the full tier ladder with each tier's
 * cosmetic (visual_data resolved) + locked/claimable/claimed state.
 *
 *   GET  /season-pass         → my progression + tier ladder
 *   POST /season-pass/claim   { tier }  → claim a reached tier
 */
router.get('/season-pass', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: seasonRows } = await pool_1.default.query(`SELECT season_id, name, starts_at, ends_at
       FROM seasons
      WHERE NOW() >= starts_at AND NOW() < ends_at
      LIMIT 1`);
    if (!seasonRows.length)
        return res.json({ season: null, tiers: [], xp: 0, claimed: [] });
    const season = seasonRows[0];
    const [{ rows: progressRows }, { rows: tierRows }] = await Promise.all([
        pool_1.default.query(`SELECT xp, claimed_tiers
         FROM season_pass_progress
        WHERE user_id = $1 AND season_id = $2`, [req.userId, season.season_id]),
        pool_1.default.query(`SELECT sp.tier, sp.xp_required,
              sp.cosmetic_id,
              c.name AS cosmetic_name, c.kind, c.rarity, c.visual_data
         FROM season_pass_tiers sp
         LEFT JOIN cosmetics c ON c.cosmetic_id = sp.cosmetic_id
        WHERE sp.season_id = $1
        ORDER BY sp.tier ASC`, [season.season_id]),
    ]);
    const xp = progressRows[0]?.xp ?? 0;
    const claimed = progressRows[0]?.claimed_tiers ?? [];
    return res.json({
        season,
        xp,
        claimed,
        tiers: tierRows.map((t) => ({
            ...t,
            reached: xp >= t.xp_required,
            claimed: claimed.includes(t.tier),
        })),
    });
}));
router.post('/season-pass/claim', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const tier = Number(req.body?.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 50) {
        return res.status(400).json({ error: 'tier must be 1..50' });
    }
    const { rows: seasonRows } = await pool_1.default.query(`SELECT season_id FROM seasons
      WHERE NOW() >= starts_at AND NOW() < ends_at
      LIMIT 1`);
    if (!seasonRows.length)
        return res.status(404).json({ error: 'No active season' });
    const seasonId = seasonRows[0].season_id;
    // Verify the tier exists for this season and the user has reached it.
    const { rows: tierRows } = await pool_1.default.query(`SELECT spt.xp_required, spt.cosmetic_id,
            COALESCE(spp.xp, 0) AS xp,
            COALESCE(spp.claimed_tiers, '{}') AS claimed
       FROM season_pass_tiers spt
       LEFT JOIN season_pass_progress spp
              ON spp.season_id = spt.season_id AND spp.user_id = $2
      WHERE spt.season_id = $1 AND spt.tier = $3`, [seasonId, req.userId, tier]);
    if (!tierRows.length)
        return res.status(404).json({ error: 'Tier not found' });
    const row = tierRows[0];
    if (row.xp < row.xp_required)
        return res.status(403).json({ error: 'Tier not yet reached' });
    if (row.claimed.includes(tier))
        return res.json({ success: true, alreadyClaimed: true });
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        // Append the tier to claimed_tiers + grant the cosmetic.
        await client.query(`INSERT INTO season_pass_progress (user_id, season_id, xp, claimed_tiers, updated_at)
       VALUES ($1, $2, 0, ARRAY[$3]::int[], NOW())
       ON CONFLICT (user_id, season_id)
       DO UPDATE SET claimed_tiers =
         (SELECT array_agg(DISTINCT x ORDER BY x)
            FROM unnest(season_pass_progress.claimed_tiers || EXCLUDED.claimed_tiers) x),
                     updated_at = NOW()`, [req.userId, seasonId, tier]);
        if (row.cosmetic_id) {
            await client.query(`INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, cosmetic_id) DO NOTHING`, [req.userId, row.cosmetic_id, `season_pass_${seasonId}_tier_${tier}`]);
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
    return res.json({ success: true, tier, cosmetic_id: row.cosmetic_id });
}));
exports.default = router;
