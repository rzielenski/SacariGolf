import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId, clanId, toUserId } = req.query;

  if (toUserId) {
    const { rows } = await pool.query(
      `SELECT dm.dm_id AS message_id, dm.created_at, dm.body, dm.from_user_id AS user_id, u.username
       FROM direct_messages dm JOIN users u ON u.user_id = dm.from_user_id
       WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
          OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
       ORDER BY dm.created_at ASC LIMIT 100`,
      [req.userId, toUserId]
    );
    return res.json(rows);
  }

  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });
  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  const { rows } = await pool.query(
    `SELECT m.message_id, m.created_at, m.body, m.user_id, u.username
     FROM messages m JOIN users u ON u.user_id = m.user_id
     WHERE m.${col} = $1
     ORDER BY m.created_at ASC
     LIMIT 100`,
    [val]
  );
  return res.json(rows);
}));

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId, clanId, toUserId, body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });

  if (toUserId) {
    const { rows } = await pool.query(
      `INSERT INTO direct_messages (from_user_id, to_user_id, body) VALUES ($1, $2, $3)
       RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id`,
      [req.userId, toUserId, body.trim()]
    );
    const msg = rows[0];
    const { rows: senderRows } = await pool.query('SELECT username FROM users WHERE user_id = $1', [req.userId]);
    const senderName = senderRows[0]?.username ?? 'Someone';
    const { rows: recipRows } = await pool.query('SELECT push_token FROM users WHERE user_id = $1', [toUserId]);
    if (recipRows[0]?.push_token) {
      await sendPush([recipRows[0].push_token], senderName, body.trim(), { type: 'dm', fromUserId: req.userId });
    }
    return res.status(201).json({ ...msg, username: senderName });
  }

  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });

  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  const { rows } = await pool.query(
    `INSERT INTO messages (${col}, user_id, body) VALUES ($1, $2, $3)
     RETURNING message_id, created_at, body, user_id`,
    [val, req.userId, body.trim()]
  );
  const msg = rows[0];

  const { rows: senderRows } = await pool.query(
    `SELECT username FROM users WHERE user_id = $1`, [req.userId]
  );
  const senderName = senderRows[0]?.username ?? 'Someone';

  let tokenRows: { push_token: string }[] = [];
  if (matchId) {
    const r = await pool.query(
      `SELECT u.push_token FROM match_players mp
       JOIN users u ON u.user_id = mp.user_id
       WHERE mp.match_id = $1 AND mp.user_id != $2 AND u.push_token IS NOT NULL`,
      [matchId, req.userId]
    );
    tokenRows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT u.push_token FROM clan_members cm
       JOIN users u ON u.user_id = cm.user_id
       WHERE cm.clan_id = $1 AND cm.user_id != $2 AND u.push_token IS NOT NULL`,
      [clanId, req.userId]
    );
    tokenRows = r.rows;
  }

  await sendPush(
    tokenRows.map((r) => r.push_token),
    senderName,
    body.trim(),
    matchId ? { type: 'chat', matchId } : { type: 'clan_chat', clanId }
  );

  return res.status(201).json({ ...msg, username: senderName });
}));

export default router;
