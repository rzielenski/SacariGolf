import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';

const router = Router();

router.get('/', requireAuth, async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.clan_id, c.name, c.clan_mode, c.elo, c.total_matches, c.total_wins, c.is_public,
            COUNT(cm.user_id)::int AS member_count, c.max_players
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.is_public = true GROUP BY c.clan_id ORDER BY c.elo DESC LIMIT 50`
  );
  return res.json(rows);
});

router.get('/mine', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.clan_id, c.name, c.clan_mode, c.elo, c.total_matches, c.total_wins,
            cm.role, c.max_players, COUNT(cm2.user_id)::int AS member_count
     FROM clans c
     JOIN clan_members cm ON cm.clan_id = c.clan_id AND cm.user_id = $1
     LEFT JOIN clan_members cm2 ON cm2.clan_id = c.clan_id
     WHERE cm.user_id = $1
     GROUP BY c.clan_id, cm.role`,
    [req.userId]
  );
  return res.json(rows);
});

// GET /clans/invites — my pending clan invites (must be before /:id)
router.get('/invites', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT ci.invite_id, ci.clan_id, ci.created_at,
            u.username AS from_username,
            c.name AS clan_name, c.clan_mode, c.elo AS clan_elo, c.max_players,
            COUNT(cm.user_id)::int AS member_count
     FROM clan_invites ci
     JOIN users u ON u.user_id = ci.from_user_id
     JOIN clans c ON c.clan_id = ci.clan_id
     LEFT JOIN clan_members cm ON cm.clan_id = ci.clan_id
     WHERE ci.to_user_id = $1
       AND ci.status = 'pending'
       AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
     GROUP BY ci.invite_id, u.username, c.clan_id
     ORDER BY ci.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
});

// POST /clans/invites/:inviteId/accept (must be before /:id)
router.post('/invites/:inviteId/accept', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `UPDATE clan_invites SET status = 'accepted'
     WHERE invite_id = $1 AND to_user_id = $2 AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING clan_id`,
    [req.params.inviteId, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invite not found or expired' });
  const { clan_id: clanId } = rows[0];

  const { rows: clanRows } = await pool.query(
    `SELECT c.max_players, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [clanId]
  );
  if (clanRows[0]?.member_count >= clanRows[0]?.max_players) {
    return res.status(409).json({ error: 'Clan is now full' });
  }
  await pool.query(
    `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [clanId, req.userId]
  );
  return res.json({ clanId });
});

// POST /clans/invites/:inviteId/decline (must be before /:id)
router.post('/invites/:inviteId/decline', requireAuth, async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE clan_invites SET status = 'declined' WHERE invite_id = $1 AND to_user_id = $2`,
    [req.params.inviteId, req.userId]
  );
  return res.json({ success: true });
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, clanMode } = req.body;
  if (!name || !clanMode) return res.status(400).json({ error: 'name and clanMode required' });
  const maxPlayers = clanMode === 'duo' ? 2 : 4;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clans (name, clan_mode, max_players) VALUES ($1, $2, $3) RETURNING *`,
      [name, clanMode, maxPlayers]
    );
    const clan = rows[0];
    await client.query(
      `INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')`,
      [clan.clan_id, req.userId]
    );
    await client.query('COMMIT');
    return res.status(201).json(clan);
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Get clan details with members
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows: clanRows } = await pool.query(
    `SELECT c.*, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [req.params.id]
  );
  if (!clanRows.length) return res.status(404).json({ error: 'Clan not found' });

  const { rows: members } = await pool.query(
    `SELECT cm.user_id, cm.role, cm.joined_at,
            u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url
     FROM clan_members cm JOIN users u ON u.user_id = cm.user_id
     WHERE cm.clan_id = $1 ORDER BY cm.role = 'leader' DESC, u.elo DESC`,
    [req.params.id]
  );

  return res.json({ ...clanRows[0], members });
});

// Update clan (leader only) — name and/or is_public
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, isPublic } = req.body;
  const { rows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length || rows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the clan leader can do this' });
  }
  const updates: string[] = [];
  const vals: any[] = [];
  if (name !== undefined) { vals.push(name); updates.push(`name = $${vals.length}`); }
  if (isPublic !== undefined) { vals.push(isPublic); updates.push(`is_public = $${vals.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const { rows: updated } = await pool.query(
    `UPDATE clans SET ${updates.join(', ')} WHERE clan_id = $${vals.length} RETURNING *`,
    vals
  );
  return res.json(updated[0]);
});

// Kick a member (leader only) or leave (self)
router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  const isSelf = req.params.userId === req.userId;
  if (!isSelf) {
    const { rows } = await pool.query(
      `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!rows.length || rows[0].role !== 'leader') {
      return res.status(403).json({ error: 'Only the clan leader can kick members' });
    }
    // Cannot kick leader
    const { rows: target } = await pool.query(
      `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    if (target[0]?.role === 'leader') return res.status(400).json({ error: 'Cannot kick the leader' });
  } else {
    // Leaving — leader must transfer first
    const { rows } = await pool.query(
      `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (rows[0]?.role === 'leader') {
      const { rows: others } = await pool.query(
        `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id != $2 LIMIT 1`,
        [req.params.id, req.userId]
      );
      if (others.length) return res.status(400).json({ error: 'Transfer leadership before leaving' });
    }
  }
  await pool.query(
    `DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.params.userId]
  );
  return res.json({ success: true });
});

// Transfer leadership
router.post('/:id/transfer', requireAuth, async (req: AuthRequest, res: Response) => {
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  const { rows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length || rows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the clan leader can transfer leadership' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE clan_members SET role = 'member' WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    await client.query(
      `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, toUserId]
    );
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/:id/join', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows: clanRows } = await pool.query(
    `SELECT c.clan_id, c.max_players, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [req.params.id]
  );
  if (!clanRows.length) return res.status(404).json({ error: 'Clan not found' });
  const clan = clanRows[0];
  if (clan.member_count >= clan.max_players) {
    return res.status(409).json({ error: 'Clan is full' });
  }
  try {
    await pool.query(
      `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.userId]
    );
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /clans/:id/invite — leader invites a friend
router.post('/:id/invite', requireAuth, async (req: AuthRequest, res: Response) => {
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });

  const { rows: roleRows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!roleRows.length || roleRows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the clan leader can invite members' });
  }

  const { rows: clanRows } = await pool.query(
    `SELECT c.max_players, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [req.params.id]
  );
  if (!clanRows.length) return res.status(404).json({ error: 'Clan not found' });
  if (clanRows[0].member_count >= clanRows[0].max_players) {
    return res.status(409).json({ error: 'Clan is full' });
  }

  try {
    await pool.query(
      `INSERT INTO clan_invites (clan_id, from_user_id, to_user_id)
       VALUES ($1, $2, $3) ON CONFLICT (clan_id, to_user_id) DO NOTHING`,
      [req.params.id, req.userId, toUserId]
    );

    const { rows } = await pool.query(
      `SELECT u.push_token, u2.username AS from_name, c.name AS clan_name
       FROM users u, users u2, clans c
       WHERE u.user_id = $1 AND u2.user_id = $2 AND c.clan_id = $3`,
      [toUserId, req.userId, req.params.id]
    );
    if (rows[0]?.push_token) {
      await sendPush(
        [rows[0].push_token],
        'Clan Invite',
        `${rows[0].from_name} invited you to join ${rows[0].clan_name}!`,
        { type: 'clanInvite', clanId: req.params.id }
      );
    }
    return res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
