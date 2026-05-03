import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const UPLOADS_DIR = '/app/uploads';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function expectedScore(rA: number, rB: number) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

// Upload a find
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType, description } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  try {
    fs.writeFileSync(filepath, Buffer.from(imageBase64, 'base64'));
  } catch {
    return res.status(500).json({ error: 'Failed to save image' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO finds (user_id, photo_url, description) VALUES ($1, $2, $3) RETURNING *`,
      [req.userId, `/uploads/${filename}`, description?.trim() || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    fs.unlinkSync(filepath);
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Random pair for voting (never the current user's own finds)
router.get('/pair', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT f.find_id, f.photo_url, f.description, f.elo, f.total_votes,
            u.username, u.user_id
     FROM finds f JOIN users u ON u.user_id = f.user_id
     WHERE f.user_id != $1
     ORDER BY RANDOM()
     LIMIT 2`,
    [req.userId]
  );
  if (rows.length < 2) return res.status(404).json({ error: 'not_enough' });
  return res.json(rows);
});

// Vote — winner beats loser
router.post('/vote', requireAuth, async (req: AuthRequest, res: Response) => {
  const { winnerId, loserId } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'winnerId and loserId required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT find_id, elo FROM finds WHERE find_id = ANY($1) FOR UPDATE`,
      [[winnerId, loserId]]
    );
    if (rows.length < 2) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Find not found' }); }

    const w = rows.find((r) => r.find_id === winnerId)!;
    const l = rows.find((r) => r.find_id === loserId)!;
    const K = 32;
    const delta = Math.round(K * (1 - expectedScore(w.elo, l.elo)));

    await client.query(
      `UPDATE finds SET elo = GREATEST(100, elo + $1), total_votes = total_votes + 1 WHERE find_id = $2`,
      [delta, winnerId]
    );
    await client.query(
      `UPDATE finds SET elo = GREATEST(100, elo - $1), total_votes = total_votes + 1 WHERE find_id = $2`,
      [delta, loserId]
    );

    await client.query('COMMIT');
    return res.json({ delta, winnerElo: w.elo + delta, loserElo: Math.max(100, l.elo - delta) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Global leaderboard
router.get('/leaderboard', requireAuth, async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT f.find_id, f.photo_url, f.description, f.elo, f.total_votes, f.created_at,
            u.username, u.user_id
     FROM finds f JOIN users u ON u.user_id = f.user_id
     ORDER BY f.elo DESC LIMIT 50`
  );
  return res.json(rows);
});

// My finds + average ELO
router.get('/mine', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT find_id, photo_url, description, elo, total_votes, created_at
     FROM finds WHERE user_id = $1 ORDER BY elo DESC`,
    [req.userId]
  );
  const avgElo = rows.length > 0
    ? Math.round(rows.reduce((s, f) => s + f.elo, 0) / rows.length)
    : null;
  return res.json({ finds: rows, avgElo });
});

// Report a find
router.post('/:id/report', requireAuth, async (req: AuthRequest, res: Response) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  try {
    await pool.query(
      `INSERT INTO find_reports (find_id, reporter_id, reason)
       VALUES ($1, $2, $3) ON CONFLICT (find_id, reporter_id) DO NOTHING`,
      [req.params.id, req.userId, reason]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete a find (own only)
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `DELETE FROM finds WHERE find_id = $1 AND user_id = $2 RETURNING photo_url`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Find not found or not yours' });
  const filepath = path.join(UPLOADS_DIR, path.basename(rows[0].photo_url));
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  return res.json({ success: true });
});

export default router;
