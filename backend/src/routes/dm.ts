import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { sendPush } from '../utils/notify';

const router = Router();
router.use(requireAuth);

// GET /dm/:userId — conversation with another user
router.get('/:userId', async (req: Request, res: Response) => {
  const me = (req as any).userId;
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT dm.dm_id AS message_id, dm.created_at, dm.body,
              dm.from_user_id AS user_id, u.username
       FROM direct_messages dm
       JOIN users u ON u.user_id = dm.from_user_id
       WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
          OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
       ORDER BY dm.created_at ASC
       LIMIT 100`,
      [me, userId]
    );
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dm/:userId — send a direct message
router.post('/:userId', async (req: Request, res: Response) => {
  const me = (req as any).userId;
  const { userId } = req.params;
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO direct_messages (from_user_id, to_user_id, body)
       VALUES ($1, $2, $3)
       RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id`,
      [me, userId, body.trim()]
    );
    const msg = rows[0];

    // Push notification to recipient
    const sender = await pool.query('SELECT username FROM users WHERE user_id = $1', [me]);
    const recipient = await pool.query('SELECT push_token FROM users WHERE user_id = $1', [userId]);
    const senderName = sender.rows[0]?.username ?? 'Someone';
    const token = recipient.rows[0]?.push_token;
    if (token) await sendPush([token], senderName, body.trim(), { type: 'dm', fromUserId: me });

    res.status(201).json({ ...msg, username: senderName });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
