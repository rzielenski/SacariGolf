import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';

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
import { configRouter, adminRouter } from './routes/config';
import { runMigrations } from './db/migrate';
import { startCleanupSchedule } from './utils/cleanup';
import { startTwitterDigestSchedule } from './utils/twitterDigest';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

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
  app.listen(PORT, () => console.log(`Sacari Golf API running on :${PORT}`));
})();
