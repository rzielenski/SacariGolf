import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import pool from './db/pool';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import coursesRouter from './routes/courses';
import matchesRouter from './routes/matches';
import clansRouter from './routes/clans';
import findsRouter from './routes/finds';
import messagesRouter from './routes/messages';
import invitesRouter from './routes/invites';
import dmRouter from './routes/dm';
import roundsRouter from './routes/rounds';
import premiumRouter from './routes/premium';
import weatherRouter from './routes/weather';
import tournamentsRouter from './routes/tournaments';
import postsRouter from './routes/posts';
import seasonsRouter from './routes/seasons';
import ballsRouter from './routes/balls';
import cosmeticsRouter from './routes/cosmetics';
import titlesRouter from './routes/titles';
import closestToPinRouter from './routes/closestToPin';
import practiceRouter from './routes/practice';
import telemetryRouter from './routes/telemetry';
import { configRouter, adminRouter } from './routes/config';
import { runMigrations } from './db/migrate';
import { startCleanupSchedule } from './utils/cleanup';
import { startTwitterDigestSchedule } from './utils/twitterDigest';

const app = express();

// Behind Railway's proxy: trust the first hop so req.ip is the real client IP
// (not a spoofable raw x-forwarded-for) for rate-limit keying.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers. CSP is left off (this is a JSON API + static images, not an
// HTML app, so a page CSP buys little and risks breaking image embeds); the
// resource policy is cross-origin so the native app and web can load /uploads.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS. React Native fetch sends NO Origin header and does not enforce CORS, so
// the mobile client is unaffected by this lockdown. Browser origins are denied
// unless explicitly allowlisted via CORS_ORIGINS (comma-separated). With the env
// unset, only no-origin callers (native / server-to-server) are allowed.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                  // native / curl / same-origin
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);                              // unknown browser origin → no CORS headers
  },
}));

app.use(express.json({ limit: '8mb' }));

// Lightweight request log: errors + slow requests only, to keep volume sane.
// Skips health/static so the log isn't drowned by probes and asset fetches.
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/uploads') || req.path.startsWith('/avatars')) {
    return next();
  }
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 400 || ms > 1500) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// Serve uploaded find photos and avatars (path overridable via UPLOADS_DIR env var)
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Bot profile photos. Bots store a RELATIVE avatar_url (/avatars/bot/N) so it
// renders through the exact same API_BASE-prefixed path as a real uploaded
// avatar — no client change needed, and it resolves on every screen. We
// redirect to a real-face portrait CDN so a bot is indistinguishable from a
// human at a glance. Public on purpose: <Image> loads avatars without an auth
// header, same as /uploads. Swapping the portrait source later is a one-liner.
app.get('/avatars/bot/:n', (req, res) => {
  const n = Math.max(0, Math.min(99, parseInt(req.params.n, 10) || 0));
  res.set('Cache-Control', 'public, max-age=2592000'); // 30 days
  res.redirect(302, `https://randomuser.me/api/portraits/men/${n}.jpg`);
});

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/courses', coursesRouter);
app.use('/matches', matchesRouter);
app.use('/clans', clansRouter);
app.use('/finds', findsRouter);
app.use('/messages', messagesRouter);
app.use('/invites', invitesRouter);
app.use('/dm', dmRouter);
app.use('/rounds', roundsRouter);
app.use('/premium', premiumRouter);
app.use('/weather', weatherRouter);
app.use('/tournaments', tournamentsRouter);
app.use('/posts', postsRouter);
app.use('/seasons', seasonsRouter);
app.use('/balls', ballsRouter);
app.use('/titles', titlesRouter);
app.use('/closest-to-pin', closestToPinRouter);
app.use('/practice', practiceRouter);
// Client crash telemetry: POST /telemetry/crash (optional auth) + GET
// /telemetry/crashes (x-admin-token gated).
app.use('/', telemetryRouter);
// Server-driven config (public) + admin ops (x-admin-token gated).
app.use('/config', configRouter);
app.use('/admin', adminRouter);
// Cosmetics router declares its own multi-prefix routes (/cosmetics/...,
// /users/me/cosmetics/..., /weekly-cup/...) so it mounts at the root.
app.use('/', cosmeticsRouter);

// Catch unhandled errors so the server doesn't crash
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// A truly uncaught exception leaves the process in an undefined state, but this
// app's posture is to stay up (same as the rejection handler above) — log it so
// it's diagnosable in Railway rather than silently crash-looping.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const PORT = process.env.PORT || 3000;

// Migrations run TO COMPLETION before the server starts taking traffic.
// The old .finally() pattern listened immediately, so for the first few
// seconds after a deploy, requests could hit routes whose tables the
// still-running migration hadn't created yet. Railway keeps the previous
// deploy serving until this one binds the port, so the await costs nothing.
(async () => {
  try {
    await runMigrations();
  } catch (e) {
    console.error('Migration runner crashed (continuing anyway):', e);
  }
  // Kick off the hourly cleanup that auto-cancels stale (>24h idle) rounds.
  // Runs immediately once on boot too, in case we slept through a window.
  startCleanupSchedule();
  // Once-a-day @Sacari Twitter/X recap (no-op until TWITTER_* env is set).
  startTwitterDigestSchedule();
  const server = app.listen(PORT, () => console.log(`Sacari Golf API running on :${PORT}`));

  // Graceful shutdown: on a Railway redeploy (SIGTERM) stop accepting new
  // connections, let in-flight requests finish, close the DB pool, then exit.
  // A 10s backstop force-exits if a connection won't drain.
  const shutdown = (sig: string) => {
    console.log(`${sig} received — draining and shutting down`);
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
