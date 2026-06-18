/**
 * Earned titles.
 *   GET  /titles         → the full catalog + which the caller owns + equipped
 *   POST /titles/equip   { titleId | null }  → equip an owned title (null clears)
 */
import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.title_id, t.name, t.description, t.rarity, t.sort,
            (ut.user_id IS NOT NULL) AS owned,
            (u.equipped_title = t.title_id) AS equipped
       FROM titles t
       LEFT JOIN user_titles ut ON ut.title_id = t.title_id AND ut.user_id = $1
       LEFT JOIN users u        ON u.user_id = $1
      ORDER BY t.sort, t.name`,
    [req.userId],
  );
  return res.json({ titles: rows });
}));

router.post('/equip', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const titleId: string | null = req.body?.titleId ?? req.body?.title_id ?? null;
  if (titleId === null) {
    await pool.query(`UPDATE users SET equipped_title = NULL WHERE user_id = $1`, [req.userId]);
    return res.json({ success: true, equipped_title: null });
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM user_titles WHERE user_id = $1 AND title_id = $2`,
    [req.userId, titleId],
  );
  if (!rows.length) return res.status(403).json({ error: 'You have not earned that title yet' });
  await pool.query(`UPDATE users SET equipped_title = $2 WHERE user_id = $1`, [req.userId, titleId]);
  return res.json({ success: true, equipped_title: titleId });
}));

export default router;
