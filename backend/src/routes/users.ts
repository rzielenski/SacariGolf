import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const AVATARS_DIR = '/app/uploads/avatars';
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const router = Router();

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.email, u.elo, u.total_matches, u.total_wins, u.avatar_url, u.created_at,
            u.handicap_index, u.bio, u.home_course_id,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
}));

router.patch('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex, username, bio, homeCourseId } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  if (pushToken !== undefined) { values.push(pushToken); updates.push(`push_token = $${values.length}`); }
  if (handicapIndex !== undefined) {
    const hi = parseFloat(handicapIndex);
    if (isNaN(hi) || hi < 0 || hi > 54) return res.status(400).json({ error: 'handicapIndex must be 0–54' });
    values.push(hi); updates.push(`handicap_index = $${values.length}`);
  }
  if (bio !== undefined) {
    const trimmed = (bio ?? '').toString().slice(0, 280);
    values.push(trimmed || null); updates.push(`bio = $${values.length}`);
  }
  if (homeCourseId !== undefined) {
    values.push(homeCourseId || null); updates.push(`home_course_id = $${values.length}`);
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
    `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url, u.created_at,
            u.bio, u.home_course_id,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const userInfo = rows[0];

  // Recent completed rounds (last 5)
  const { rows: recentRounds } = await pool.query(
    `SELECT r.round_id, r.total_score, r.created_at, r.hole_scores,
            t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            m.format, m.match_type
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true
     ORDER BY r.created_at DESC
     LIMIT 5`,
    [req.params.id]
  );

  // Best round (lowest score-to-par across all completed rounds)
  const { rows: bestRows } = await pool.query(
    `SELECT r.round_id, r.total_score, r.created_at,
            t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            (r.total_score - t.par) AS to_par
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true AND t.par IS NOT NULL
     ORDER BY (r.total_score - t.par) ASC
     LIMIT 1`,
    [req.params.id]
  );

  return res.json({
    ...userInfo,
    recent_rounds: recentRounds,
    best_round: bestRows[0] ?? null,
  });
}));

router.delete('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(`DELETE FROM users WHERE user_id = $1`, [req.userId]);
  return res.json({ success: true });
}));

// Avatar upload
router.post('/me/avatar', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = `avatar_${req.userId}.${ext}`;
  const filepath = path.join(AVATARS_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(imageBase64, 'base64'));
  const avatarUrl = `/uploads/avatars/${filename}`;
  await pool.query(`UPDATE users SET avatar_url = $1 WHERE user_id = $2`, [avatarUrl, req.userId]);
  return res.json({ avatar_url: avatarUrl });
}));

// Notifications feed
router.get('/me/notifications', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const notes: any[] = [];

  // Pending friend requests
  const { rows: frs } = await pool.query(
    `SELECT u.user_id, u.username, f.created_at FROM friends f
     JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending' ORDER BY f.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of frs) notes.push({ type: 'friend_request', title: 'Friend Request', body: `${r.username} sent you a friend request`, data: { userId: r.user_id }, created_at: r.created_at });

  // Pending match invites
  const { rows: mis } = await pool.query(
    `SELECT mi.invite_id, mi.match_id, mi.created_at, u.username AS from_name, m.match_type
     FROM match_invites mi JOIN users u ON u.user_id = mi.from_user_id JOIN matches m ON m.match_id = mi.match_id
     WHERE mi.to_user_id = $1 AND mi.status = 'pending'
     AND (mi.expires_at IS NULL OR mi.expires_at > NOW()) ORDER BY mi.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mis) notes.push({ type: 'match_invite', title: 'Match Invite', body: `${r.from_name} invited you to a ${r.match_type} match`, data: { matchId: r.match_id, inviteId: r.invite_id }, created_at: r.created_at });

  // Pending clan invites (if clan_invites table exists)
  try {
    const { rows: cis } = await pool.query(
      `SELECT ci.invite_id, ci.clan_id, ci.created_at, u.username AS from_name, c.name AS clan_name
       FROM clan_invites ci JOIN users u ON u.user_id = ci.from_user_id JOIN clans c ON c.clan_id = ci.clan_id
       WHERE ci.to_user_id = $1 AND ci.status = 'pending' ORDER BY ci.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of cis) notes.push({ type: 'clan_invite', title: 'Clan Invite', body: `${r.from_name} invited you to join ${r.clan_name}`, data: { clanId: r.clan_id, inviteId: r.invite_id }, created_at: r.created_at });
  } catch { /* table may not exist yet */ }

  // Recent match results (last 48h)
  const { rows: mrs } = await pool.query(
    `SELECT mr.match_id, mr.winner_side, mr.delta_elo, mr.created_at, m.match_type, mp.side AS my_side
     FROM match_results mr JOIN matches m ON m.match_id = mr.match_id
     JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = $1
     WHERE mr.created_at > NOW() - INTERVAL '48 hours' AND m.is_practice = false
     ORDER BY mr.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mrs) {
    const won = r.winner_side === r.my_side;
    notes.push({ type: 'match_result', title: won ? 'Victory!' : 'Defeat', body: won ? `You won your ${r.match_type} match (+${r.delta_elo} ELO)` : `You lost your ${r.match_type} match (-${r.delta_elo} ELO)`, data: { matchId: r.match_id }, created_at: r.created_at, won });
  }

  notes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return res.json(notes);
}));

export default router;
