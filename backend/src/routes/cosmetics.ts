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

import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

const VALID_KINDS = new Set(['border', 'background', 'username', 'ball_trail', 'fx']);
const EQUIP_COLUMN: Record<string, string> = {
  border:     'equipped_border',
  background: 'equipped_background',
  username:   'equipped_username',
  ball_trail: 'equipped_ball_trail',
  fx:         'equipped_fx',
};

router.get('/cosmetics/catalog', requireAuth, wrap(async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data
       FROM cosmetics
      ORDER BY kind, rarity, name`,
  );
  return res.json({ items: rows });
}));

router.get('/users/me/cosmetics', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Owned set + the equipped slot for each kind. Single round-trip; the
  // mobile screen renders the catalog separately and intersects.
  const [{ rows: owned }, { rows: equippedRows }] = await Promise.all([
    pool.query(
      `SELECT cosmetic_id, unlocked_at, unlock_source
         FROM user_cosmetics
        WHERE user_id = $1`,
      [req.userId],
    ),
    pool.query(
      `SELECT equipped_border, equipped_background, equipped_username,
              equipped_ball_trail, equipped_fx
         FROM users WHERE user_id = $1`,
      [req.userId],
    ),
  ]);
  const e = equippedRows[0] ?? {};
  return res.json({
    owned: owned.map((r) => r.cosmetic_id),
    equipped: {
      border:     e.equipped_border     ?? null,
      background: e.equipped_background ?? null,
      username:   e.equipped_username   ?? null,
      ball_trail: e.equipped_ball_trail ?? null,
      fx:         e.equipped_fx         ?? null,
    },
  });
}));

router.post('/users/me/cosmetics/equip', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { kind, cosmetic_id } = req.body ?? {};
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind)) {
    return res.status(400).json({ error: 'kind must be border|background|username|ball_trail|fx' });
  }
  const col = EQUIP_COLUMN[kind];

  if (cosmetic_id == null) {
    // Clear the slot.
    await pool.query(`UPDATE users SET ${col} = NULL WHERE user_id = $1`, [req.userId]);
    return res.json({ success: true, kind, cosmetic_id: null });
  }
  if (typeof cosmetic_id !== 'string') {
    return res.status(400).json({ error: 'cosmetic_id must be string or null' });
  }

  // Ownership + kind check. We do BOTH to prevent equipping a border into
  // the username slot (mismatched-kind UI confusion) AND equipping an item
  // the user doesn't own.
  const { rows: check } = await pool.query(
    `SELECT c.kind
       FROM cosmetics c
       JOIN user_cosmetics uc ON uc.cosmetic_id = c.cosmetic_id
      WHERE uc.user_id = $1 AND c.cosmetic_id = $2`,
    [req.userId, cosmetic_id],
  );
  if (!check.length) return res.status(403).json({ error: 'You do not own that cosmetic' });
  if (check[0].kind !== kind) {
    return res.status(400).json({ error: `That cosmetic is a ${check[0].kind}, not a ${kind}` });
  }

  await pool.query(`UPDATE users SET ${col} = $2 WHERE user_id = $1`, [req.userId, cosmetic_id]);
  return res.json({ success: true, kind, cosmetic_id });
}));

/**
 * Weekly Sacari Cup — this week's leaderboard, the caller's row, prizes,
 * time remaining. Mirrors the resolution query in utils/weeklyCup.ts so
 * the live leaderboard players see during the week matches what will be
 * paid out at week's end.
 */
router.get('/weekly-cup/current', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Find / create the current week's cup. Defensive: if the background
  // tick hasn't fired yet (very fresh server boot), ensure one here so a
  // first-load doesn't return null.
  await pool.query(
    `INSERT INTO weekly_cups (week_starts_at)
     VALUES (date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
     ON CONFLICT (week_starts_at) DO NOTHING`,
  );
  const { rows: cupRows } = await pool.query(
    `SELECT cup_id, week_starts_at
       FROM weekly_cups
      WHERE status = 'active'
      ORDER BY week_starts_at DESC
      LIMIT 1`,
  );
  if (!cupRows.length) return res.json({ cup: null, leaderboard: [], my_row: null });
  const cup = cupRows[0];
  const weekStartsAt = cup.week_starts_at as Date;
  const weekEnd = new Date(weekStartsAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Each player's best round during the window, pro-rated to holes
  // actually played (same formula as the user_profile best_round query).
  const { rows: leaderboard } = await pool.query(
    `WITH best AS (
       SELECT r.user_id,
              MIN(r.total_score
                  - ROUND(t.par::numeric
                          * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                          / NULLIF(t.num_holes, 0)::numeric)::int) AS best_to_par,
              MIN(r.created_at) AS first_at
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
        WHERE r.total_score IS NOT NULL
          AND m.completed = true
          AND m.is_practice = false
          AND r.created_at >= $1
          AND r.created_at <  $2
          AND t.par IS NOT NULL
        GROUP BY r.user_id
     )
     SELECT b.user_id, b.best_to_par,
            u.username, u.avatar_url, u.elo
       FROM best b
       JOIN users u ON u.user_id = b.user_id
      ORDER BY b.best_to_par ASC, b.first_at ASC
      LIMIT 100`,
    [weekStartsAt, weekEnd],
  );

  const ranked = leaderboard.map((r: any, i: number) => ({
    ...r,
    rank: i + 1,
    is_me: r.user_id === req.userId,
  }));
  const myRow = ranked.find((r: any) => r.is_me) ?? null;

  // Past champions strip — last 4 resolved cups' winners. Decorates the
  // screen with social proof.
  const { rows: pastChamps } = await pool.query(
    `WITH resolved AS (
       SELECT cup_id, week_starts_at,
              week_starts_at + INTERVAL '7 days' AS week_ends_at
         FROM weekly_cups
        WHERE status = 'resolved'
        ORDER BY week_starts_at DESC
        LIMIT 4
     )
     SELECT res.week_starts_at, u.username, u.avatar_url
       FROM resolved res
       JOIN LATERAL (
         SELECT r.user_id,
                (r.total_score
                 - ROUND(t.par::numeric
                         * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                         / NULLIF(t.num_holes, 0)::numeric)::int) AS to_par
           FROM rounds r
           JOIN matches m ON m.match_id = r.match_id
           JOIN teeboxes t ON t.teebox_id = r.teebox_id
          WHERE r.total_score IS NOT NULL
            AND m.completed = true
            AND m.is_practice = false
            AND r.created_at >= res.week_starts_at
            AND r.created_at <  res.week_ends_at
            AND t.par IS NOT NULL
          ORDER BY to_par ASC
          LIMIT 1
       ) winner ON true
       JOIN users u ON u.user_id = winner.user_id
      ORDER BY res.week_starts_at DESC`,
  );

  return res.json({
    cup: {
      cup_id: cup.cup_id,
      week_starts_at: weekStartsAt,
      week_ends_at: weekEnd,
    },
    leaderboard: ranked,
    my_row: myRow,
    past_champions: pastChamps,
    prizes: {
      first:  'Champion Wreath border + Gold Dust background + Gold Streak ball trail + Champion Gold username',
      second: 'Gold Frame border',
      third:  'Gold Text username',
    },
  });
}));

export default router;
