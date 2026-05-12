/**
 * Admin auth — shared gate for endpoints that aren't tied to a user account.
 *
 * Accepts EITHER of two secrets in the `x-admin-token` header:
 *   • PREMIUM_ADMIN_TOKEN — long random hex (for curl / scripts)
 *   • ADMIN_PIN           — short numeric code (for in-app entry on a phone)
 *
 * The short PIN is genuinely brute-forceable on its own (a million tries
 * for 6 digits is nothing to a script), so we lean on the rate limiter
 * below: 5 failed attempts per IP per 15 minutes → 429. That puts a
 * single attacker at ~480 guesses per day per IP, which means 6-digit
 * exhaustion takes well over a millennium of sustained guessing — fine.
 *
 * In-memory rate limit state. Survives only until the process restarts,
 * which on Railway means it resets on deploy. Acceptable since the limit
 * is meant to slow a sustained attack, not stop a one-shot leak.
 */

import { Request, Response } from 'express';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;

interface Bucket { fails: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

function getIp(req: Request): string {
  // Trust the first IP if behind a proxy (Railway sets X-Forwarded-For).
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

function takeBucket(ip: string): Bucket {
  const now = Date.now();
  const cur = buckets.get(ip);
  if (!cur || now > cur.resetAt) {
    const fresh: Bucket = { fails: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, fresh);
    return fresh;
  }
  return cur;
}

/** True iff request is admin-authed. Increments failure counter on bad
 *  attempts and responds with 403/429 directly when not authed; caller
 *  should check the return value and bail without further work. */
export function isAdminAuthed(req: Request, res: Response): boolean {
  const provided = req.header('x-admin-token');
  const token = process.env.PREMIUM_ADMIN_TOKEN;
  const pin = process.env.ADMIN_PIN;

  // If neither secret is configured, fail closed — we'd rather break the
  // admin endpoints than ship them wide-open.
  if (!token && !pin) {
    res.status(503).json({ error: 'Admin auth not configured' });
    return false;
  }

  const ip = getIp(req);
  const bucket = takeBucket(ip);
  if (bucket.fails >= MAX_FAILS_PER_IP) {
    const wait = Math.ceil((bucket.resetAt - Date.now()) / 1000);
    res.status(429).json({
      error: 'Too many failed admin attempts. Try again later.',
      retry_after_seconds: wait,
    });
    return false;
  }

  const ok = typeof provided === 'string'
    && provided.length > 0
    && ((!!token && provided === token) || (!!pin && provided === pin));

  if (!ok) {
    bucket.fails += 1;
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  // Successful auth resets the failure counter for this IP so a fat-finger
  // earlier in the session doesn't lock us out later.
  bucket.fails = 0;
  return true;
}
