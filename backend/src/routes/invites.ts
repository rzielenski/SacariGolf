import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId, toUserId } = req.body ?? {};
  if (!matchId || !toUserId) return res.status(400).json({ error: 'matchId and toUserId required' });
  if (toUserId === req.userId) return res.status(400).json({ error: 'Cannot invite yourself' });

  // Sender must be a participant of the match. Without this, someone with a
  // match_id could spam invites to anyone.
  const { rows: memberRows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [matchId, req.userId]
  );
  if (!memberRows.length) return res.status(403).json({ error: 'Not in this match' });

  // Reject inviting to a completed match
  const { rows: matchInfo } = await pool.query(
    `SELECT completed FROM matches WHERE match_id = $1`, [matchId]
  );
  if (!matchInfo.length) return res.status(404).json({ error: 'Match not found' });
  if (matchInfo[0].completed) return res.status(409).json({ error: 'Match already completed' });

  await pool.query(
    `INSERT INTO match_invites (match_id, from_user_id, to_user_id, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
     ON CONFLICT (match_id, to_user_id) DO NOTHING`,
    [matchId, req.userId, toUserId]
  );

  const { rows } = await pool.query(
    `SELECT u.push_token, u2.username AS from_name
     FROM users u, users u2
     WHERE u.user_id = $1 AND u2.user_id = $2`,
    [toUserId, req.userId]
  );
  if (rows[0]?.push_token) {
    await sendPush(
      [rows[0].push_token],
      'Match Invite',
      `${rows[0].from_name} invited you to a match!`,
      { type: 'invite', matchId }
    );
  }

  return res.status(201).json({ success: true });
}));

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT i.invite_id, i.match_id, i.created_at, i.expires_at,
            u.username AS from_username, u.elo AS from_elo,
            m.match_type, m.name AS match_name
     FROM match_invites i
     JOIN users u ON u.user_id = i.from_user_id
     JOIN matches m ON m.match_id = i.match_id
     WHERE i.to_user_id = $1
       AND i.status = 'pending'
       AND m.completed = false
       AND (i.expires_at IS NULL OR i.expires_at > NOW())
     ORDER BY i.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

router.post('/:id/accept', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atomic check + status update. If the invite is gone, expired, or already
    // accepted, RETURNING is empty.
    const { rows } = await client.query(
      `UPDATE match_invites SET status = 'accepted'
       WHERE invite_id = $1 AND to_user_id = $2 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING match_id, from_user_id`,
      [req.params.id, req.userId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or expired' });
    }

    const { match_id: matchId, from_user_id: fromUserId } = rows[0];

    // Lock the match row so concurrent accepts can't oversize it
    const { rows: matchRows } = await client.query(
      `SELECT match_type, completed FROM matches WHERE match_id = $1 FOR UPDATE`,
      [matchId]
    );
    if (!matchRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found' });
    }
    if (matchRows[0].completed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Match already completed' });
    }
    const matchType = matchRows[0].match_type;

    // Already in this match? No-op success.
    const { rows: existing } = await client.query(
      `SELECT side FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [matchId, req.userId]
    );
    if (existing.length) {
      await client.query('COMMIT');
      return res.json({ matchId });
    }

    // Player-count caps so resolveElo never sees an invalid match shape.
    const SIDE_CAPS: Record<string, number> = { solo: 2, duo: 4, squad: 8 };
    const cap = SIDE_CAPS[matchType] ?? 2;
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM match_players WHERE match_id = $1`, [matchId]
    );
    if ((countRows[0]?.n ?? 0) >= cap) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Match is full' });
    }

    let side: number;
    if (matchType === 'duo' || matchType === 'squad') {
      const { rows: sideRows } = await client.query(
        `SELECT side FROM match_players WHERE match_id = $1 AND user_id = $2`,
        [matchId, fromUserId]
      );
      side = sideRows[0]?.side ?? 1;
    } else {
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(side), 0) + 1 AS next FROM match_players WHERE match_id = $1`,
        [matchId]
      );
      side = Math.min(maxRows[0].next, 2); // solo never goes above side 2
    }

    await client.query(
      `INSERT INTO match_players (match_id, user_id, side)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [matchId, req.userId, side]
    );

    await client.query('COMMIT');
    return res.json({ matchId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/decline', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE match_invites SET status = 'declined'
     WHERE invite_id = $1 AND to_user_id = $2`,
    [req.params.id, req.userId]
  );
  return res.json({ success: true });
}));

export default router;
