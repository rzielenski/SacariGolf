/**
 * Practice sessions — "The Grind". Range + putting reps logged from the
 * session screens. Lifetime shot totals power the profile stat + the hub
 * banner. Device-agnostic (server-stored) so the total follows the user.
 */
import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

const KINDS = new Set(['range', 'putting']);

// POST /practice/sessions — log a completed practice session.
router.post('/sessions', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const kind = String(req.body?.kind ?? '');
  if (!KINDS.has(kind)) return res.status(400).json({ error: 'kind must be range or putting' });
  const shots = Math.max(0, Math.min(100000, Math.floor(Number(req.body?.shots) || 0)));
  const durationS = Math.max(0, Math.min(86400, Math.floor(Number(req.body?.durationS) || 0)));
  const bpmRaw = Number(req.body?.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? Math.min(400, Math.floor(bpmRaw)) : null;
  // Nothing to grind — don't clutter history with empty sessions.
  if (shots <= 0) return res.json({ success: true, skipped: true });
  const { rows } = await pool.query(
    `INSERT INTO practice_sessions (user_id, kind, shots, duration_s, bpm)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING session_id, kind, shots, duration_s, bpm, created_at`,
    [req.userId, kind, shots, durationS, bpm]
  );
  return res.status(201).json(rows[0]);
}));

// GET /practice/sessions — recent sessions for The Grind history.
router.get('/sessions', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT session_id, kind, shots, duration_s, bpm, created_at
       FROM practice_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [req.userId]
  );
  return res.json(rows);
}));

// GET /practice/summary — lifetime totals for the hub banner + profile stat.
router.get('/summary', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT
        COALESCE(SUM(shots), 0)::int                                   AS total_shots,
        COALESCE(SUM(shots) FILTER (WHERE kind = 'range'), 0)::int     AS range_shots,
        COALESCE(SUM(shots) FILTER (WHERE kind = 'putting'), 0)::int   AS putting_shots,
        COUNT(*)::int                                                  AS session_count
       FROM practice_sessions
      WHERE user_id = $1`,
    [req.userId]
  );
  return res.json(rows[0]);
}));

export default router;
