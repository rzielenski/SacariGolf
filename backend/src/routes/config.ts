/**
 * Server-driven app configuration + admin operations.
 *
 *   GET  /config                  → public; the app_config table as one
 *                                   object ({ min_version, banner,
 *                                   features, ... }) + server_time.
 *                                   Fetched by the app on boot and cached,
 *                                   so a key flip reaches users in minutes
 *                                   with no release.
 *   GET  /admin/migration-status  → admin; the schema_migrations ledger,
 *                                   failures first. The answer to "did
 *                                   that deploy's migration actually run"
 *                                   without trawling Railway logs.
 *   POST /admin/config            → admin; upsert one config key.
 *                                   body: { key: string, value: any }
 *
 * Admin endpoints use the same x-admin-token gate (PREMIUM_ADMIN_TOKEN or
 * ADMIN_PIN) as the other admin surfaces, with its built-in rate limiter.
 */

import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { wrap } from '../utils/asyncHandler';
import { isAdminAuthed } from '../utils/adminAuth';

export const configRouter = Router();
export const adminRouter = Router();

configRouter.get('/', wrap(async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`SELECT key, value FROM app_config`);
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  out.server_time = new Date().toISOString();
  return res.json(out);
}));

adminRouter.get('/migration-status', wrap(async (req: Request, res: Response) => {
  if (!isAdminAuthed(req, res)) return;
  const { rows } = await pool.query(
    `SELECT name, ok, error, last_ran_at
       FROM schema_migrations
      ORDER BY ok ASC, last_ran_at DESC`,
  );
  return res.json({
    healthy: rows.every((r) => r.ok),
    failed: rows.filter((r) => !r.ok).map((r) => r.name),
    migrations: rows,
  });
}));

adminRouter.post('/config', wrap(async (req: Request, res: Response) => {
  if (!isAdminAuthed(req, res)) return;
  const { key, value } = req.body ?? {};
  if (typeof key !== 'string' || !key || key.length > 64) {
    return res.status(400).json({ error: 'key required (string, <= 64 chars)' });
  }
  if (value === undefined) {
    return res.status(400).json({ error: 'value required (any JSON)' });
  }
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
  return res.json({ success: true, key, value });
}));
