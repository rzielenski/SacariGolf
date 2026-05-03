import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, email, elo, total_matches, total_wins, avatar_url, created_at,
            handicap_index
     FROM users WHERE user_id = $1`,
    [req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
});

router.patch('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  if (pushToken !== undefined) { values.push(pushToken); updates.push(`push_token = $${values.length}`); }
  if (handicapIndex !== undefined) {
    const hi = parseFloat(handicapIndex);
    if (isNaN(hi) || hi < 0 || hi > 54) return res.status(400).json({ error: 'handicapIndex must be 0–54' });
    values.push(hi); updates.push(`handicap_index = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${values.length}`,
    values
  );
  return res.json({ success: true });
});

router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, avatar_url FROM users
     WHERE username ILIKE $1 AND user_id != $2 LIMIT 20`,
    [`%${q}%`, req.userId]
  );
  return res.json(rows);
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, total_matches, total_wins, avatar_url, created_at
     FROM users WHERE user_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
});

// Friends
router.get('/me/friends', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.avatar_url, f.status
     FROM friends f
     JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'`,
    [req.userId]
  );
  return res.json(rows);
});

router.get('/me/friend-requests', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.avatar_url, f.created_at
     FROM friends f JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'`,
    [req.userId]
  );
  return res.json(rows);
});

router.post('/me/friends/request', requireAuth, async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  try {
    await pool.query(
      `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')
       ON CONFLICT DO NOTHING`,
      [req.userId, friendId]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/me/friends/accept', requireAuth, async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body;
  await pool.query(
    `UPDATE friends SET status = 'accepted'
     WHERE user_id = $1 AND friend_id = $2`,
    [friendId, req.userId]
  );
  return res.json({ success: true });
});

// Global ELO leaderboard
router.get('/leaderboard', requireAuth, async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, total_matches, total_wins, avatar_url
     FROM users
     ORDER BY elo DESC
     LIMIT 100`
  );
  return res.json(rows);
});

// Account deletion — removes user and all associated data via CASCADE
router.delete('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [req.userId]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
