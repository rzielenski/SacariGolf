import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';

const router = Router();

// POST /invites — invite a friend to a match
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { matchId, toUserId } = req.body;
  if (!matchId || !toUserId) return res.status(400).json({ error: 'matchId and toUserId required' });

  try {
    await pool.query(
      `INSERT INTO match_invites (match_id, from_user_id, to_user_id)
       VALUES ($1, $2, $3) ON CONFLICT (match_id, to_user_id) DO NOTHING`,
      [matchId, req.userId, toUserId]
    );

    // Push notify the invitee
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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /invites — get my pending invites
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT i.invite_id, i.match_id, i.created_at,
            u.username AS from_username, u.elo AS from_elo,
            m.match_type, m.name AS match_name
     FROM match_invites i
     JOIN users u ON u.user_id = i.from_user_id
     JOIN matches m ON m.match_id = i.match_id
     WHERE i.to_user_id = $1 AND i.status = 'pending' AND m.completed = false
     ORDER BY i.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
});

// POST /invites/:id/accept
router.post('/:id/accept', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `UPDATE match_invites SET status = 'accepted'
     WHERE invite_id = $1 AND to_user_id = $2
     RETURNING match_id`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invite not found' });

  // Auto-join the match
  try {
    await pool.query(
      `INSERT INTO match_players (match_id, user_id, side)
       SELECT $1, $2, COALESCE(MAX(side), 0) + 1 FROM match_players WHERE match_id = $1
       ON CONFLICT DO NOTHING`,
      [rows[0].match_id, req.userId]
    );
  } catch { /* already a player */ }

  return res.json({ matchId: rows[0].match_id });
});

// POST /invites/:id/decline
router.post('/:id/decline', requireAuth, async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE match_invites SET status = 'declined'
     WHERE invite_id = $1 AND to_user_id = $2`,
    [req.params.id, req.userId]
  );
  return res.json({ success: true });
});

export default router;
