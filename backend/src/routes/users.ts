import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, email, elo, total_matches, total_wins, avatar_url, created_at,
            handicap_index
     FROM users WHERE user_id = $1`,
    [req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
}));

router.patch('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex, username } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  if (pushToken !== undefined) { values.push(pushToken); updates.push(`push_token = $${values.length}`); }
  if (handicapIndex !== undefined) {
    const hi = parseFloat(handicapIndex);
    if (isNaN(hi) || hi < 0 || hi > 54) return res.status(400).json({ error: 'handicapIndex must be 0–54' });
    values.push(hi); updates.push(`handicap_index = $${values.length}`);
  }
  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, or underscores' });
    }
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM users WHERE username = $1 AND user_id != $2`,
      [username, req.userId]
    );
    if (existing.length) return res.status(409).json({ error: 'Username already taken' });
    values.push(username); updates.push(`username = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${values.length}`,
    values
  );
  return res.json({ success: true });
}));

router.get('/search', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, avatar_url FROM users
     WHERE username ILIKE $1 AND user_id != $2 LIMIT 20`,
    [`%${q}%`, req.userId]
  );
  return res.json(rows);
}));

// Friends — must be before /:id
router.get('/me/friends', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.user_id) u.user_id, u.username, u.elo, u.avatar_url, f.status
     FROM friends f
     JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
     ORDER BY u.user_id`,
    [req.userId]
  );
  return res.json(rows);
}));

router.get('/me/friend-requests', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.avatar_url, f.created_at
     FROM friends f JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'`,
    [req.userId]
  );
  return res.json(rows);
}));

router.post('/me/friends/request', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'friendId required' });

  await pool.query(
    `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')
     ON CONFLICT DO NOTHING`,
    [req.userId, friendId]
  );

  const { rows } = await pool.query(
    `SELECT u.push_token, u2.username AS from_name
     FROM users u, users u2
     WHERE u.user_id = $1 AND u2.user_id = $2`,
    [friendId, req.userId]
  );
  if (rows[0]?.push_token) {
    await sendPush(
      [rows[0].push_token],
      'Friend Request',
      `${rows[0].from_name} sent you a friend request!`,
      { type: 'friendRequest' }
    );
  }

  return res.json({ success: true });
}));

router.post('/me/friends/accept', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body;
  await pool.query(
    `UPDATE friends SET status = 'accepted' WHERE user_id = $1 AND friend_id = $2`,
    [friendId, req.userId]
  );
  return res.json({ success: true });
}));

router.get('/leaderboard', requireAuth, wrap(async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, total_matches, total_wins, avatar_url
     FROM users ORDER BY elo DESC LIMIT 100`
  );
  return res.json(rows);
}));

router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, total_matches, total_wins, avatar_url, created_at
     FROM users WHERE user_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
}));

router.delete('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(`DELETE FROM users WHERE user_id = $1`, [req.userId]);
  return res.json({ success: true });
}));

export default router;
