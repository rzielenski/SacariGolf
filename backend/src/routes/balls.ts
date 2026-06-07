/**
 * Lost/found golf-ball tracker.
 *
 * A running count of balls the player has found vs. lost on the course, plus
 * a leaderboard. Each tap logs one event (found or lost) into `ball_log`; the
 * headline number is net = found − lost (it can go negative — a fun "ball
 * karma" stat for the player who keeps splashing them).
 *
 * Endpoints:
 *   GET  /balls/me           → caller's { found, lost, net } + recent log.
 *   POST /balls/log {kind}   → log one found|lost ball, returns new totals.
 *   POST /balls/undo         → delete the caller's most recent log entry.
 *   GET  /balls/leaderboard  → top players by net (?friends=1 to scope).
 */

import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

async function totalsFor(userId: string) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE kind = 'found')::int AS found,
            COUNT(*) FILTER (WHERE kind = 'lost')::int  AS lost
       FROM ball_log WHERE user_id = $1`,
    [userId]
  );
  const found = rows[0]?.found ?? 0;
  const lost = rows[0]?.lost ?? 0;
  return { found, lost, net: found - lost };
}

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const totals = await totalsFor(req.userId!);
  const { rows: recent } = await pool.query(
    `SELECT log_id, kind, created_at
       FROM ball_log WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 30`,
    [req.userId]
  );
  return res.json({ ...totals, recent });
}));

router.post('/log', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const kind = (req.body ?? {}).kind;
  const clientId = typeof req.body?.clientId === 'string' && req.body.clientId.length > 0
    ? req.body.clientId.slice(0, 64) : null;
  if (kind !== 'found' && kind !== 'lost') {
    return res.status(400).json({ error: "kind must be 'found' or 'lost'" });
  }
  // ── Idempotent path: client-supplied id collapses retries to a single row.
  // Partial unique index covers only rows with a non-null client_id, so the
  // ON CONFLICT specifies the same WHERE predicate. Legacy callers (no
  // clientId) keep the original "insert a new row" behaviour.
  if (clientId) {
    await pool.query(
      `INSERT INTO ball_log (user_id, kind, client_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING`,
      [req.userId, kind, clientId]
    );
  } else {
    await pool.query(
      `INSERT INTO ball_log (user_id, kind) VALUES ($1, $2)`,
      [req.userId, kind]
    );
  }
  return res.json(await totalsFor(req.userId!));
}));

router.post('/undo', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const clientId = typeof req.body?.clientId === 'string' && req.body.clientId.length > 0
    ? req.body.clientId.slice(0, 64) : null;

  // ── Idempotent retries: if this clientId has already been processed,
  // short-circuit and just return the current totals. Without this, a
  // retried undo deletes a *different* row each time it lands.
  if (clientId) {
    const { rows: prev } = await pool.query(
      `SELECT 1 FROM ball_log_undo WHERE user_id = $1 AND client_id = $2`,
      [req.userId, clientId]
    );
    if (prev.length > 0) {
      return res.json(await totalsFor(req.userId!));
    }
  }

  // Delete most recent entry + record the undo, transactional so they
  // can't drift apart.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: deleted } = await client.query(
      `DELETE FROM ball_log
        WHERE log_id = (
          SELECT log_id FROM ball_log
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1
        )
       RETURNING log_id`,
      [req.userId]
    );
    if (clientId) {
      await client.query(
        `INSERT INTO ball_log_undo (user_id, client_id, deleted_log_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, client_id) DO NOTHING`,
        [req.userId, clientId, deleted[0]?.log_id ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return res.json(await totalsFor(req.userId!));
}));

router.get('/leaderboard', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const friendsOnly = req.query.friends === '1' || req.query.friends === 'true';

  // Friends scope = self + accepted friends, mirroring the ELO leaderboard.
  const friendScopeCte = `
    WITH scope AS (
      SELECT $1::uuid AS user_id
      UNION
      SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
        FROM friends f
       WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
    )`;
  // Global scope hides users the caller has blocked (Apple Guideline 1.2).
  const scopeFilter = friendsOnly
    ? 'u.user_id IN (SELECT user_id FROM scope)'
    : 'u.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $1)';

  const { rows } = await pool.query(
    `${friendsOnly ? friendScopeCte : ''}
     SELECT u.user_id, u.username, u.avatar_url,
            COUNT(*) FILTER (WHERE b.kind = 'found')::int AS found,
            COUNT(*) FILTER (WHERE b.kind = 'lost')::int  AS lost,
            (COUNT(*) FILTER (WHERE b.kind = 'found')
             - COUNT(*) FILTER (WHERE b.kind = 'lost'))::int AS net
       FROM users u
       JOIN ball_log b ON b.user_id = u.user_id
      WHERE ${scopeFilter}
      GROUP BY u.user_id
      ORDER BY net DESC, found DESC, u.username ASC
      LIMIT 100`,
    [req.userId]
  );

  return res.json(rows.map((r: any, i: number) => ({ ...r, rank: i + 1 })));
}));

export default router;
