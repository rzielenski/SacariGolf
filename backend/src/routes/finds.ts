import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function expectedScore(rA: number, rB: number) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType, description } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // MIME whitelist
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg'
    : null;
  if (!ext) return res.status(400).json({ error: 'Only PNG and JPEG images are allowed' });

  // Decode + size cap (5 MB)
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'Invalid image data' });
  if (buffer.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image must be 5 MB or smaller' });
  }
  // Trim + cap description
  const desc = typeof description === 'string'
    ? description.trim().slice(0, 280)
    : null;

  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  try {
    fs.writeFileSync(filepath, buffer);
  } catch {
    return res.status(500).json({ error: 'Failed to save image' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO finds (user_id, photo_url, description) VALUES ($1, $2, $3) RETURNING *`,
      [req.userId, `/uploads/${filename}`, desc || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    throw err;
  }
}));

router.get('/pair', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Matchup-based ranking: we pick a pair of finds the user hasn't seen
  // BEFORE, not just two individual unseen finds. Critical when new finds
  // get uploaded later — a long-tenured find can be re-shown against
  // every newcomer instead of being permanently retired once the user
  // first voted on it.
  //
  // Apple Guideline 1.2: blocked users' finds must not appear to the
  // blocker. Same query also drops the caller's own finds (existing).

  // First pull the eligible pool — caller's finds + blocked users' finds
  // excluded. Capped at 500 so a runaway pool can't blow memory; if you
  // hit that ceiling we have happier problems to solve first.
  const { rows: pool_rows } = await pool.query(
    `SELECT f.find_id
     FROM finds f
     JOIN users u ON u.user_id = f.user_id
     WHERE f.user_id != $1
       AND u.user_id NOT IN (
         SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
       )
     LIMIT 500`,
    [req.userId]
  );
  if (pool_rows.length < 2) return res.status(404).json({ error: 'not_enough' });

  // Random first pick, then look for any second pick that hasn't been
  // paired with the first for this user. Re-roll up to a few times if
  // the first pick happens to have no unseen partners.
  const shuffled = pool_rows.map((r) => r.find_id).sort(() => Math.random() - 0.5);
  let chosen: [string, string] | null = null;
  for (let attempt = 0; attempt < Math.min(8, shuffled.length); attempt++) {
    const first = shuffled[attempt];
    const { rows: partnerRows } = await pool.query(
      `SELECT find_id FROM finds
        WHERE find_id != $1
          AND find_id = ANY($2::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM find_pair_seen
            WHERE user_id = $3
              AND find_a_id = LEAST(find_id::uuid, $1::uuid)
              AND find_b_id = GREATEST(find_id::uuid, $1::uuid)
          )
        ORDER BY RANDOM()
        LIMIT 1`,
      [first, shuffled, req.userId]
    );
    if (partnerRows.length) {
      chosen = [first, partnerRows[0].find_id];
      break;
    }
  }

  if (!chosen) {
    // Every pair involving the random first picks was already seen. Full
    // pool exhaust check: count matchups the user has seen vs N*(N−1)/2.
    // We could compute that precisely, but for simplicity just return
    // not_enough — the client renders the "no more matchups" empty state.
    return res.status(404).json({ error: 'not_enough' });
  }

  // Canonicalise for the (LEAST, GREATEST) constraint on find_pair_seen,
  // then record this matchup as seen BEFORE returning so a skip / app-
  // close still counts and we don't loop the same pair next request.
  const [a, b] = chosen;
  const [pa, pb] = a < b ? [a, b] : [b, a];
  await pool.query(
    `INSERT INTO find_pair_seen (user_id, find_a_id, find_b_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, find_a_id, find_b_id) DO NOTHING`,
    [req.userId, pa, pb]
  );

  // Hydrate the chosen pair with the full row data the client renders.
  const { rows } = await pool.query(
    `SELECT f.find_id, f.photo_url, f.description, f.elo, f.total_votes,
            u.username, u.user_id
     FROM finds f
     JOIN users u ON u.user_id = f.user_id
     WHERE f.find_id = ANY($1::uuid[])`,
    [[a, b]]
  );
  // Preserve the picked order so the client can rely on rows[0] / rows[1].
  rows.sort((x: any, y: any) => (x.find_id === a ? -1 : 1));
  return res.json(rows);
}));

router.post('/vote', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
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
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/leaderboard', requireAuth, wrap(async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT f.find_id, f.photo_url, f.description, f.elo, f.total_votes, f.created_at,
            u.username, u.user_id
     FROM finds f JOIN users u ON u.user_id = f.user_id
     ORDER BY f.elo DESC LIMIT 50`
  );
  return res.json(rows);
}));

router.get('/mine', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT find_id, photo_url, description, elo, total_votes, created_at
     FROM finds WHERE user_id = $1 ORDER BY elo DESC`,
    [req.userId]
  );
  const avgElo = rows.length > 0
    ? Math.round(rows.reduce((s, f) => s + f.elo, 0) / rows.length)
    : null;
  return res.json({ finds: rows, avgElo });
}));

router.post('/:id/report', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'reason required' });
  await pool.query(
    `INSERT INTO find_reports (find_id, reporter_id, reason)
     VALUES ($1, $2, $3) ON CONFLICT (find_id, reporter_id) DO NOTHING`,
    [req.params.id, req.userId, reason]
  );
  return res.json({ success: true });
}));

router.delete('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `DELETE FROM finds WHERE find_id = $1 AND user_id = $2 RETURNING photo_url`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Find not found or not yours' });
  // Strict filename whitelist: only delete files that match our generated naming
  // (UUID.ext). Defends against any malformed/legacy photo_url entries that
  // might try to escape the uploads directory.
  const base = path.basename(String(rows[0].photo_url));
  if (/^[a-zA-Z0-9-]+\.(png|jpg|jpeg)$/.test(base)) {
    const filepath = path.join(UPLOADS_DIR, base);
    // Ensure resolved path stays inside UPLOADS_DIR
    const resolved = path.resolve(filepath);
    const root = path.resolve(UPLOADS_DIR);
    if (resolved.startsWith(root + path.sep) || resolved === root) {
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    }
  }
  return res.json({ success: true });
}));

export default router;
