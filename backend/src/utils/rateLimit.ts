import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';

/**
 * Per-user in-memory rate limiter for authenticated endpoints — primarily the
 * image-upload routes, which write to the Railway disk and so are a fill/abuse
 * vector if a single account loops them.
 *
 * Keyed by userId (falling back to IP) so one account can't bypass the cap by
 * rotating IPs. Process-local: it resets on deploy and isn't shared across a
 * scaled-out fleet — fine as a per-instance abuse cap; move to Redis/Postgres
 * if multi-instance accuracy ever matters. Mirrors the auth limiter's shape.
 */
type Bucket = { count: number; resetAt: number };

export function perUserRateLimit(opts: { max: number; windowMs: number }) {
  const buckets = new Map<string, Bucket>();
  // Prune expired buckets so the map can't grow unbounded.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets.entries()) if (v.resetAt < now) buckets.delete(k);
  }, 60_000).unref?.();

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const key = req.userId || req.ip || 'unknown';
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (b.count >= opts.max) {
      return res.status(429).json({ error: 'Slow down — too many requests. Try again shortly.' });
    }
    b.count += 1;
    return next();
  };
}
