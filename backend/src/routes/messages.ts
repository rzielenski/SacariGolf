import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/conversations', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (other_id)
       other_id,
       u.username AS other_username,
       u.elo AS other_elo,
       last_msg.body AS last_message,
       last_msg.created_at AS last_at
     FROM (
       SELECT
         CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_id,
         body,
         created_at,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END
           ORDER BY created_at DESC
         ) AS rn
       FROM direct_messages
       WHERE from_user_id = $1 OR to_user_id = $1
     ) last_msg
     JOIN users u ON u.user_id = last_msg.other_id
     WHERE last_msg.rn = 1
     ORDER BY other_id, last_msg.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

// Helper: confirm caller is allowed to read/post in this match or clan.
async function memberOfChat(userId: string, matchId?: any, clanId?: any) {
  if (matchId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [matchId, userId]
    );
    return rows.length > 0;
  }
  if (clanId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, userId]
    );
    return rows.length > 0;
  }
  return false;
}

// Helper: confirm two users are friends (for DM gating)
async function areFriends(a: string, b: string) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friends
     WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
       AND status = 'accepted'`,
    [a, b]
  );
  return rows.length > 0;
}

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
  // Anyone can read a match's chat once they're in it; same for clan chats.
  if (!(await memberOfChat(req.userId!, matchId, clanId))) {
    return res.status(403).json({ error: 'Not a member of this chat' });
  }
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
  const { matchId, clanId, toUserId, body } = req.body ?? {};
  // Trim, require non-empty, hard-cap length to prevent message-spam DoS.
  const text = typeof body === 'string' ? body.trim().slice(0, 2000) : '';
  if (!text) return res.status(400).json({ error: 'body required' });

  if (toUserId) {
    if (toUserId === req.userId) return res.status(400).json({ error: 'Cannot DM yourself' });
    // Gate DMs to friends only — keeps random users from spamming.
    if (!(await areFriends(req.userId!, toUserId))) {
      return res.status(403).json({ error: 'You can only DM friends' });
    }
    const { rows } = await pool.query(
      `INSERT INTO direct_messages (from_user_id, to_user_id, body) VALUES ($1, $2, $3)
       RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id`,
      [req.userId, toUserId, text]
    );
    const msg = rows[0];
    const { rows: senderRows } = await pool.query('SELECT username FROM users WHERE user_id = $1', [req.userId]);
    const senderName = senderRows[0]?.username ?? 'Someone';
    const { rows: recipRows } = await pool.query('SELECT push_token FROM users WHERE user_id = $1', [toUserId]);
    if (recipRows[0]?.push_token) {
      await sendPush([recipRows[0].push_token], senderName, text, { type: 'dm', fromUserId: req.userId });
    }
    return res.status(201).json({ ...msg, username: senderName });
  }

  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });

  // Sender must actually be a participant of the match / clan
  if (!(await memberOfChat(req.userId!, matchId, clanId))) {
    return res.status(403).json({ error: 'Not a member of this chat' });
  }

  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  const { rows } = await pool.query(
    `INSERT INTO messages (${col}, user_id, body) VALUES ($1, $2, $3)
     RETURNING message_id, created_at, body, user_id`,
    [val, req.userId, text]
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
    text,
    matchId ? { type: 'chat', matchId } : { type: 'clan_chat', clanId }
  );

  return res.status(201).json({ ...msg, username: senderName });
}));

export default router;
