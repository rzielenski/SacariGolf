/**
 * Client crash telemetry.
 *
 *   POST /telemetry/crash        → the app self-reports a crash (see the
 *                                  crash_reports migration for the kinds).
 *                                  OPTIONAL auth: we attribute the report to a
 *                                  user when a valid bearer token is present,
 *                                  but accept anonymous reports too — a crash
 *                                  can happen before login, and the report is
 *                                  still worth having.
 *   GET  /telemetry/crashes      → recent reports, x-admin-token gated, so the
 *                                  owner can eyeball what's crashing from a
 *                                  phone or curl without opening the DB.
 *
 * This is deliberately homegrown + tiny rather than pulling in Sentry (which
 * needs a native build). It won't give a symbolicated native stack, but the
 * breadcrumb trail + iOS memory-warning count + which OTA update crashed is
 * enough to localize "random force-close while navigating" bugs.
 */
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/pool';
import { wrap } from '../utils/asyncHandler';
import { isAdminAuthed } from '../utils/adminAuth';

const router = Router();

/** Clamp a value to a string of at most `max` chars (or null). Keeps a runaway
 *  client from writing megabytes — stacks and breadcrumb blobs are bounded. */
function str(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** Best-effort user attribution: verify the bearer token if one was sent, else
 *  treat the report as anonymous. Never rejects — telemetry must not 401. */
function optionalUserId(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as { userId: string };
    return payload.userId ?? null;
  } catch {
    return null;
  }
}

const VALID_KINDS = new Set(['js_fatal', 'js_boundary', 'unhandled_rejection', 'abnormal_exit']);

router.post('/telemetry/crash', wrap(async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const kind = typeof b.kind === 'string' && VALID_KINDS.has(b.kind) ? b.kind : 'js_fatal';
  const userId = optionalUserId(req);

  // Breadcrumbs come as an array of {t,type,msg}; store the JSON but bound it.
  let breadcrumbs: any = null;
  if (Array.isArray(b.breadcrumbs)) {
    breadcrumbs = b.breadcrumbs.slice(-60).map((c: any) => ({
      t: typeof c?.t === 'number' ? c.t : null,
      type: str(c?.type, 40),
      msg: str(c?.msg, 300),
    }));
  }

  await pool.query(
    `INSERT INTO crash_reports
       (user_id, kind, message, stack, last_route, breadcrumbs, mem_warns,
        app_version, update_id, platform, os_version, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      userId,
      kind,
      str(b.message, 2000),
      str(b.stack, 8000),
      str(b.lastRoute, 300),
      breadcrumbs ? JSON.stringify(breadcrumbs) : null,
      Number.isFinite(b.memWarns) ? Math.min(100000, Math.max(0, Math.floor(b.memWarns))) : null,
      str(b.appVersion, 40),
      str(b.updateId, 80),
      str(b.platform, 20),
      str(b.osVersion, 40),
      b.extra && typeof b.extra === 'object' ? JSON.stringify(b.extra).slice(0, 4000) : null,
    ],
  );

  // 204: fire-and-forget from the client's perspective; nothing to read back.
  return res.status(204).end();
}));

router.get('/telemetry/crashes', wrap(async (req: Request, res: Response) => {
  if (!isAdminAuthed(req, res)) return;   // isAdminAuthed already wrote 403/429
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  const kind = typeof req.query.kind === 'string' && VALID_KINDS.has(req.query.kind)
    ? req.query.kind : null;

  const { rows } = await pool.query(
    `SELECT c.crash_id, c.kind, c.message, c.last_route, c.mem_warns,
            c.app_version, c.update_id, c.platform, c.os_version,
            c.breadcrumbs, c.stack, c.created_at,
            u.username
       FROM crash_reports c
       LEFT JOIN users u ON u.user_id = c.user_id
      WHERE ($1::text IS NULL OR c.kind = $1)
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [kind, limit],
  );

  // A tiny at-a-glance rollup so "what's crashing" is answerable without
  // reading every row: counts per kind + per app_version over the last 7 days.
  const { rows: summary } = await pool.query(
    `SELECT kind, app_version, COUNT(*)::int AS n,
            MAX(created_at) AS last_seen,
            MAX(mem_warns)  AS worst_mem_warns
       FROM crash_reports
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY kind, app_version
      ORDER BY n DESC`,
  );

  return res.json({ summary, reports: rows });
}));

export default router;
