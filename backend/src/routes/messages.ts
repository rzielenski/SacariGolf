import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';

const router = Router();

// GET /messages?matchId=&clan_id= — fetch last 100 messages
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { matchId, clanId } = req.query;
  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId or clanId required' });

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
});

// POST /messages — send a message
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { matchId, clanId, body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId or clanId required' });

  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (${col}, user_id, body) VALUES ($1, $2, $3)
       RETURNING message_id, created_at, body, user_id`,
      [val, req.userId, body.trim()]
    );
    const msg = rows[0];

    // Fetch sender username for response
    const { rows: senderRows } = await pool.query(
      `SELECT username FROM users WHERE user_id = $1`, [req.userId]
    );
    const senderName = senderRows[0]?.username ?? 'Someone';

    // Push all other members of this match/clan
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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
