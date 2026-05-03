import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';

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
    `SELECT c.clan_id, c.name, c.clan_mode, c.elo, c.total_matches, c.total_wins, cm.role
     FROM clans c JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE cm.user_id = $1`,
    [req.userId]
  );
  return res.json(rows);
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

export default router;
