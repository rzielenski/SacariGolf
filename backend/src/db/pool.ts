import { Pool } from 'pg';

// Hardened pool. A bare `new Pool({ connectionString })` uses pg's defaults,
// where connectionTimeoutMillis is 0 — so if the DB is unreachable or every
// connection is checked out, queries WAIT FOREVER instead of erroring. That
// turns a transient DB blip into a permanent app freeze: the mobile client
// hangs on /auth/login, /users/me, etc. with no error to recover from (sign-in
// spins forever; the user-gated tabs never load). These settings make the pool
// fail fast and recycle connections instead:
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Stay well under Railway Postgres' connection cap so an overlapping deploy
  // (old + new instance both holding pools) can't exhaust the server.
  max: 10,
  // Fail a checkout after 10s rather than hanging forever — lets the API return
  // a 5xx the client can retry / fall back on, instead of freezing the app.
  connectionTimeoutMillis: 10_000,
  // Close idle connections after 30s. Cloud platforms (Railway included)
  // silently drop idle TCP connections; reusing a dropped one hangs the next
  // query. Recycling first avoids the "first request after a quiet period
  // hangs" failure mode.
  idleTimeoutMillis: 30_000,
  // TCP keepalive so long-lived connections aren't silently severed mid-flight.
  keepAlive: true,
});

// A pool-level error (most commonly: the DB closed an idle connection) MUST be
// handled. Without a listener, pg re-emits it as an unhandled 'error' event on
// the pool, which Node escalates to an uncaught exception that can crash the
// whole process — turning a recoverable blip into a restart loop.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[pg pool] idle client error (recovered):', err.message);
});

export default pool;
