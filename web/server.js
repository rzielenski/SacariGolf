/**
 * Sacari Golf public website. Standalone Express server, separate from the
 * mobile app and the API. Server-rendered for rich link previews and SEO.
 * Reads the same Postgres DB read-only.
 *
 *   /                 home / marketing
 *   /leaderboard      global rankings
 *   /courses          course directory + search (?q=)
 *   /course/:id       course detail (tees + best rounds)
 *   /r/:matchId       shareable match recap (no-install link preview)
 *   /u/:username      public player profile
 *   /privacy /terms /support   legal + support
 *   /sitemap.xml /robots.txt   SEO
 *   /healthz          health check
 */
'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { rankForElo, medallionFor } = require('./rank');
const { backendLogin, backendRegister, apiGet, apiGetSafe, apiPost, setSession, clearSession, requireAuth } = require('./auth');
const R = require('./render');

/** CSRF guard for state-changing requests: when the browser sends an Origin,
 *  it must match our host. Combined with the sameSite=lax session cookie this
 *  blocks cross-site forged posts. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations may omit Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const PORT = process.env.PORT || 4000;
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const APP_STORE_URL = process.env.APP_STORE_URL || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@sacarigolf.com';
const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Railway terminates TLS; needed for secure cookies
app.use(cookieParser());
app.use(express.urlencoded({ extended: false })); // login form posts
app.use(express.json()); // pin editor AJAX posts
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ----- Auth: login / signup / logout ----------------------------------------
app.get('/login', (req, res) => {
  if (req.cookies && req.cookies.sg_token) { res.redirect('/app'); return; }
  res.send(R.renderLogin({}));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).send(R.renderLogin({ error: 'Enter your email and password.' }));
    return;
  }
  try {
    const { token } = await backendLogin(String(email), String(password));
    setSession(req, res, token);
    res.redirect('/app');
  } catch (err) {
    res.status(401).send(R.renderLogin({ error: err.message || 'Invalid email or password.' }));
  }
});

// New Android users sign up here (the app handles signup on iOS).
app.get('/signup', (req, res) => {
  if (req.cookies && req.cookies.sg_token) { res.redirect('/app'); return; }
  res.send(R.renderSignup({}));
});

app.post('/signup', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    res.status(400).send(R.renderSignup({ error: 'Fill in every field.', values: { username, email } }));
    return;
  }
  try {
    const { token } = await backendRegister(String(username), String(email), String(password));
    setSession(req, res, token);
    res.redirect('/verify-email');
  } catch (err) {
    res.status(400).send(R.renderSignup({ error: err.message || 'Could not create your account.', values: { username, email } }));
  }
});

// Email verification (new signups get a 6-digit code by email).
app.get('/verify-email', requireAuth, async (req, res) => {
  const me = await apiGetSafe('/users/me', req.token);
  if (me && me.email_verified) { res.redirect('/app'); return; }
  res.send(R.renderVerifyEmail({ email: me && me.email }));
});

app.post('/verify-email', requireAuth, async (req, res) => {
  if (!sameOrigin(req)) { res.status(403).send(R.renderVerifyEmail({ error: 'Bad origin.' })); return; }
  const code = String((req.body && req.body.code) || '').trim();
  try {
    await apiPost('/auth/verify-email', req.token, { code });
    res.redirect('/app');
  } catch (err) {
    res.status(400).send(R.renderVerifyEmail({ error: err.message || 'That code did not work.' }));
  }
});

app.post('/resend-verification', requireAuth, async (req, res) => {
  try { await apiPost('/auth/resend-verification', req.token, {}); } catch { /* best effort */ }
  res.redirect('/verify-email');
});

app.get('/logout', (_req, res) => { clearSession(res); res.redirect('/'); });

// ----- Secure same-origin API proxy -----------------------------------------
// The browser never sees the JWT (it lives in an httpOnly cookie). Authed
// client pages call /app/api/<backend-path>; we attach the bearer token and
// forward to the backend, returning its response verbatim. This is what lets
// the web app use every backend endpoint the iOS app uses.
app.all(/^\/app\/api\/.+/, requireAuth, async (req, res) => {
  if (req.method !== 'GET' && !sameOrigin(req)) { res.status(403).json({ error: 'bad origin' }); return; }
  // Everything after '/app/api', including the query string. Block protocol-
  // relative paths so this can't be pointed at another host.
  let backendPath = req.originalUrl.slice('/app/api'.length);
  if (!backendPath.startsWith('/') || backendPath.startsWith('//')) {
    res.status(400).json({ error: 'bad path' }); return;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
  try {
    const upstream = await fetch(`${BACKEND_URL}${backendPath}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${req.token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
    });
    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    console.error('app proxy error:', err);
    res.status(502).json({ error: 'upstream unavailable' });
  }
});

// ----- Authenticated account dashboard --------------------------------------
app.get('/account', requireAuth, async (req, res) => {
  try {
    const me = await apiGet('/users/me', req.token);
    const [season, stats, ball] = await Promise.all([
      apiGetSafe('/seasons/current', req.token),
      apiGetSafe(`/users/${me.user_id}/stats`, req.token),
      apiGetSafe('/balls/me', req.token),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.send(R.renderDashboard({ me, rank: rankForElo(me.elo), season, stats, ball }));
  } catch (err) {
    if (err.code === 401) { clearSession(res); res.redirect('/login'); return; }
    console.error('account error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// ----- Web app: the play loop -----------------------------------------------
// Hub: greeting, rank, quick actions, and the player's matches.
app.get('/app', requireAuth, async (req, res) => {
  try {
    const me = await apiGet('/users/me', req.token);
    const matches = (await apiGetSafe('/matches', req.token)) || [];
    res.set('Cache-Control', 'private, no-store');
    res.send(R.renderAppHome({ me, rank: rankForElo(me.elo), matches }));
  } catch (err) {
    if (err.code === 401) { clearSession(res); res.redirect('/login'); return; }
    console.error('app home error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// Create / find a match (interactive; client JS drives it via the proxy).
app.get('/app/play', requireAuth, (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.send(R.renderAppPlay({}));
});

// Match detail / lobby (SSR result + a "score round" link).
app.get('/app/match/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('match')); return; }
  try {
    const [me, match] = await Promise.all([
      apiGet('/users/me', req.token),
      apiGet(`/matches/${id}`, req.token),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.send(R.renderAppMatch({ me, match }));
  } catch (err) {
    if (err.code === 401) { clearSession(res); res.redirect('/login'); return; }
    if (err.code === 404) { res.status(404).send(R.renderNotFound('match')); return; }
    console.error('app match error:', err);
    res.status(500).send(R.renderNotFound('match'));
  }
});

// Scorecard entry (interactive; client JS loads holes + submits via the proxy).
app.get('/app/score/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('match')); return; }
  res.set('Cache-Control', 'private, no-store');
  res.send(R.renderAppScore({ matchId: id }));
});

// Review Sesh: upload a swing video, play it back slow, draw on it. Purely
// client-side (video stays in the browser tab via an object URL — no upload,
// no backend call), so this route just serves the shell.
app.get('/app/review', requireAuth, (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.send(R.renderAppReview());
});

// Compare Sesh: two swing videos side by side. Same client-only model.
app.get('/app/review/compare', requireAuth, (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.send(R.renderAppReviewCompare());
});

app.get('/account/clubs', requireAuth, async (req, res) => {
  try {
    const me = await apiGet('/users/me', req.token);
    const [sg, clubStats] = await Promise.all([
      apiGetSafe(`/users/${me.user_id}/sg-advanced`, req.token),
      apiGetSafe(`/users/${me.user_id}/club-stats`, req.token),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.send(R.renderClubs({ sg, clubs: clubStats ? clubStats.clubs : [] }));
  } catch (err) {
    if (err.code === 401) { clearSession(res); res.redirect('/login'); return; }
    console.error('clubs error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// ----- Performance data export ----------------------------------------------
// Downloads the caller's full stats bundle (club dispersion, strokes gained,
// approach proximity, putting) as a stable versioned JSON another app can
// re-ingest. Proxies the backend's self-only /data-export and forces a file
// download. The JWT stays in the httpOnly cookie — never exposed to the page.
app.get('/account/export.json', requireAuth, async (req, res) => {
  try {
    const me = await apiGet('/users/me', req.token);
    const data = await apiGet(`/users/${me.user_id}/data-export`, req.token);
    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = String(me.username || 'data').replace(/[^a-z0-9]/gi, '') || 'data';
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sacari-${safeName}-${stamp}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    if (err.code === 401) { clearSession(res); res.redirect('/login'); return; }
    console.error('export error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// ----- Pin editor (crowdsourced pin placement) ------------------------------
app.get('/course/:id/pins', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('course')); return; }
  try {
    const { rows: cRows } = await pool.query(
      `SELECT course_id, course_name, club_name, city, state, latitude, longitude
         FROM courses WHERE course_id = $1`,
      [id]
    );
    if (!cRows.length) { res.status(404).send(R.renderNotFound('course')); return; }
    const { rows: holes } = await pool.query(
      `SELECT h.hole_num,
              MAX(h.par) AS par,
              BOOL_OR(h.pin_lat IS NOT NULL) AS has_pin,
              (ARRAY_AGG(h.pin_lat) FILTER (WHERE h.pin_lat IS NOT NULL))[1] AS pin_lat,
              (ARRAY_AGG(h.pin_lng) FILTER (WHERE h.pin_lng IS NOT NULL))[1] AS pin_lng
         FROM teeboxes t JOIN holes h ON h.teebox_id = t.teebox_id
        WHERE t.course_id = $1
        GROUP BY h.hole_num ORDER BY h.hole_num`,
      [id]
    );
    res.set('Cache-Control', 'private, no-store');
    res.send(R.renderCoursePins({ course: cRows[0], holes }));
  } catch (err) {
    console.error('pins page error:', err);
    res.status(500).send(R.renderNotFound('course'));
  }
});

app.post('/course/:id/pins', requireAuth, async (req, res) => {
  if (!sameOrigin(req)) { res.status(403).json({ error: 'bad origin' }); return; }
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(400).json({ error: 'bad course id' }); return; }
  const holeNum = Number(req.body && req.body.holeNum);
  const lat = Number(req.body && req.body.lat);
  const lng = Number(req.body && req.body.lng);
  if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > 18
   || !Number.isFinite(lat) || !Number.isFinite(lng)
   || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'Invalid hole or coordinates' });
    return;
  }
  try {
    const result = await apiPost('/courses/admin/set-pins', req.token, {
      courseId: id, pins: [{ holeNum, lat, lng }],
    });
    res.json({ ok: (result.updated || 0) > 0, ...result });
  } catch (err) {
    if (err.code === 401) { res.status(401).json({ error: 'Session expired. Log in again.' }); return; }
    console.error('set-pin error:', err);
    res.status(500).json({ error: 'Could not save pin' });
  }
});

// ----- Home -----------------------------------------------------------------
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.send(R.renderHome());
});

// ----- How to play ----------------------------------------------------------
app.get('/how-to-play', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.send(R.renderHowTo());
});

// ----- Leaderboard ----------------------------------------------------------
app.get('/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username, elo, total_matches, total_wins, total_ties, avatar_url
         FROM users WHERE total_matches > 0
        ORDER BY elo DESC LIMIT 100`
    );
    const players = rows.map((p) => ({ ...p, rank: rankForElo(p.elo) }));
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderLeaderboard({ players }));
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// JSON autocomplete for the player search box (type-ahead by username).
app.get('/api/players/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40).replace(/[%_]/g, '') : '';
  if (q.length < 2) { res.json([]); return; }
  try {
    const { rows } = await pool.query(
      `SELECT username, elo FROM users
        WHERE is_bot = false AND username ILIKE $1
        ORDER BY (lower(username) = lower($2)) DESC, elo DESC
        LIMIT 8`,
      [`${q}%`, q]
    );
    res.set('Cache-Control', 'public, max-age=30');
    res.json(rows.map((r) => {
      const rk = rankForElo(r.elo);
      return { username: r.username, rankLabel: rk.isObsidian ? `Obsidian ${rk.displayElo}` : rk.label, color: rk.color };
    }));
  } catch (err) {
    console.error('player search error:', err);
    res.status(500).json([]);
  }
});

// ----- Recent matches feed --------------------------------------------------
app.get('/matches', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.match_id, mr.created_at AS resolved_at, mr.winner_side, m.num_holes, m.format,
              json_agg(json_build_object(
                'side', mp.side, 'username', u.username, 'elo', u.elo, 'is_bot', u.is_bot,
                'total_score', r.total_score, 'teebox_par', t.par, 'course_name', c.course_name,
                'normalized_to_par', r.normalized_to_par
              ) ORDER BY mp.side) AS players
         FROM match_results mr
         JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
         JOIN match_players mp ON mp.match_id = m.match_id
         JOIN users u ON u.user_id = mp.user_id
         LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = mp.user_id
         LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
         LEFT JOIN courses c ON c.course_id = t.course_id
        GROUP BY m.match_id, mr.created_at, mr.winner_side, m.num_holes, m.format
        -- Drop any match involving a bot (bot-vs-bot or human-vs-bot) so the
        -- public feed only shows real head-to-heads.
        HAVING bool_or(u.is_bot) = false
        ORDER BY mr.created_at DESC
        LIMIT 40`
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.send(R.renderMatchesFeed({ matches: rows }));
  } catch (err) {
    console.error('matches feed error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// ----- Courses index + search ----------------------------------------------
app.get('/courses', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60).replace(/[%_]/g, '') : '';
  try {
    if (q) {
      const { rows } = await pool.query(
        `SELECT course_id, course_name, city, state, country FROM courses
          WHERE course_name ILIKE $1 OR city ILIKE $1
          ORDER BY course_name LIMIT 50`,
        [`${q}%`]
      );
      res.set('Cache-Control', 'public, max-age=120');
      res.send(R.renderCoursesIndex({ results: rows, q }));
    } else {
      const { rows } = await pool.query(
        `SELECT c.course_id, c.course_name, c.city, c.state, c.country, COUNT(r.round_id)::int AS plays
           FROM courses c
           JOIN teeboxes t ON t.course_id = c.course_id
           JOIN rounds r ON r.teebox_id = t.teebox_id
           JOIN matches m ON m.match_id = r.match_id AND m.completed = true
          GROUP BY c.course_id
          ORDER BY plays DESC LIMIT 24`
      );
      res.set('Cache-Control', 'public, max-age=600');
      res.send(R.renderCoursesIndex({ popular: rows }));
    }
  } catch (err) {
    console.error('courses error:', err);
    res.status(500).send(R.renderNotFound());
  }
});

// JSON autocomplete for the course search box (type-ahead).
app.get('/api/courses/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60).replace(/[%_]/g, '') : '';
  if (q.length < 2) { res.json([]); return; }
  try {
    const { rows } = await pool.query(
      `SELECT course_id, course_name, city, state, country FROM courses
        WHERE course_name ILIKE $1 OR city ILIKE $1
        ORDER BY course_name LIMIT 8`,
      [`${q}%`]
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json(rows);
  } catch (err) {
    console.error('course search error:', err);
    res.status(500).json([]);
  }
});

// ----- Course detail --------------------------------------------------------
app.get('/course/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('course')); return; }
  try {
    const { rows: cRows } = await pool.query(
      `SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
         FROM courses WHERE course_id = $1`,
      [id]
    );
    if (!cRows.length) { res.status(404).send(R.renderNotFound('course')); return; }

    const { rows: teeboxes } = await pool.query(
      `SELECT name, par, num_holes, total_yards, course_rating, slope_rating
         FROM teeboxes WHERE course_id = $1 ORDER BY total_yards DESC NULLS LAST`,
      [id]
    );
    // Per-tee hole detail for the scorecard + hole-by-hole map viewer. Ordered
    // longest tee first so render.js's first yardage column is the back tees.
    const { rows: holeRows } = await pool.query(
      `SELECT t.teebox_id, t.name AS tee_name, t.total_yards,
              h.hole_num, h.par, h.yardage, h.handicap,
              h.pin_lat, h.pin_lng, h.tee_lat, h.tee_lng
         FROM teeboxes t
         JOIN holes h ON h.teebox_id = t.teebox_id
        WHERE t.course_id = $1
        ORDER BY t.total_yards DESC NULLS LAST, t.teebox_id, h.hole_num`,
      [id]
    );
    // Each player's single best round here (lowest to-par; ties → most recent),
    // not every round they've ever posted. Bots are excluded — they play real
    // teeboxes when filling matches, so they'd otherwise leak onto the board.
    // Read the stored 18-hole-equivalent to-par (normalized_to_par) that the
    // app computes and writes — no scoring formula in SQL here either, just an
    // ORDER BY on the column.
    const { rows: topRounds } = await pool.query(
      `SELECT username, total_score, teebox_par, teebox_name, num_holes, holes_played, to_par, created_at
         FROM (
           SELECT DISTINCT ON (r.user_id)
                  u.username, r.total_score, t.par AS teebox_par,
                  t.name AS teebox_name, t.num_holes,
                  COALESCE(array_length(r.hole_scores, 1), t.num_holes) AS holes_played,
                  r.normalized_to_par AS to_par,
                  r.created_at
             FROM rounds r
             JOIN matches m ON m.match_id = r.match_id AND m.completed = true
             JOIN teeboxes t ON t.teebox_id = r.teebox_id
             JOIN users u ON u.user_id = r.user_id
            WHERE t.course_id = $1 AND r.normalized_to_par IS NOT NULL
              AND u.is_bot = false
            ORDER BY r.user_id, r.normalized_to_par ASC, r.created_at DESC
         ) best
        ORDER BY to_par ASC, created_at DESC
        LIMIT 15`,
      [id]
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderCourse({ course: cRows[0], teeboxes, topRounds, holeRows }));
  } catch (err) {
    console.error('course error:', err);
    res.status(500).send(R.renderNotFound('course'));
  }
});

// Zip a round's hole_scores array against its teebox pars into
// [{hole_num, par, score}], honoring a front/back subset. Scores of 0 (an
// unentered hole) become null so the scorecard shows a dash, not a 0.
function alignHoleScores(allHoles, holeScores, subset) {
  if (!Array.isArray(holeScores) || !holeScores.length || !allHoles.length) return [];
  const n = holeScores.length;
  let slice;
  if (allHoles.length === n) slice = allHoles;
  else if (subset === 'back') slice = allHoles.slice(allHoles.length - n);
  else slice = allHoles.slice(0, n);
  return slice.map((h, i) => {
    const s = Number(holeScores[i]);
    return { hole_num: h.hole_num, par: h.par, score: Number.isFinite(s) && s > 0 ? s : null };
  });
}

// ----- Match recap (shareable, no-install) ----------------------------------
// A resolved match's result rendered for link previews + a no-download CTA.
// Linked from the app's share sheet as /r/<matchId>. 404 unless the match has
// a result row (i.e. it actually resolved).
app.get('/r/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('match')); return; }
  try {
    const { rows: mRows } = await pool.query(
      `SELECT m.match_id, m.match_type, m.format, m.num_holes, m.is_practice, m.holes_subset,
              mr.winner_side, mr.side1_score_differential, mr.side2_score_differential,
              mr.details, mr.created_at AS resolved_at
         FROM matches m
         JOIN match_results mr ON mr.match_id = m.match_id
        WHERE m.match_id = $1`,
      [id]
    );
    if (!mRows.length || mRows[0].is_practice) { res.status(404).send(R.renderNotFound('match')); return; }
    const m = mRows[0];

    const { rows: pRows } = await pool.query(
      `SELECT mp.user_id, mp.side, u.username, u.elo, u.is_bot,
              r.total_score, r.hole_scores, r.teebox_id, r.normalized_to_par, t.par AS teebox_par, t.name AS teebox_name, c.course_name
         FROM match_players mp
         JOIN users u ON u.user_id = mp.user_id
         LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
         LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
         LEFT JOIN courses c ON c.course_id = t.course_id
        WHERE mp.match_id = $1
        ORDER BY mp.side, u.username`,
      [id]
    );
    if (pRows.length < 2) { res.status(404).send(R.renderNotFound('match')); return; }

    // Per-hole pars for every teebox in the match, to zip against hole_scores.
    const teeboxIds = [...new Set(pRows.map((p) => p.teebox_id).filter(Boolean))];
    const parByTeebox = new Map();
    if (teeboxIds.length) {
      const { rows: hRows } = await pool.query(
        `SELECT teebox_id, hole_num, par FROM holes WHERE teebox_id = ANY($1) ORDER BY teebox_id, hole_num`,
        [teeboxIds]
      );
      for (const h of hRows) {
        if (!parByTeebox.has(h.teebox_id)) parByTeebox.set(h.teebox_id, []);
        parByTeebox.get(h.teebox_id).push({ hole_num: h.hole_num, par: h.par });
      }
    }

    const deltas = (m.details && m.details.playerDeltas) || {};
    const bySide = new Map();
    for (const p of pRows) {
      const entry = {
        username: p.username,
        isBot: p.is_bot,
        rank: rankForElo(p.elo),
        gross: p.total_score,
        // 18-hole-equivalent to-par from the stored column (same value the app +
        // course board rank on); raw par-diff only as a fallback.
        toPar: p.normalized_to_par != null
          ? p.normalized_to_par
          : (p.total_score != null && p.teebox_par != null ? p.total_score - p.teebox_par : null),
        delta: Math.round(Number(deltas[p.user_id] ?? 0)),
        courseName: p.course_name,
        teeName: p.teebox_name,
        holes: alignHoleScores(parByTeebox.get(p.teebox_id) || [], p.hole_scores, m.holes_subset),
      };
      if (!bySide.has(p.side)) bySide.set(p.side, []);
      bySide.get(p.side).push(entry);
    }
    const tied = m.winner_side == null;
    const sides = [...bySide.entries()].sort((a, b) => a[0] - b[0]).map(([side, players]) => ({
      side,
      players,
      isWinner: !tied && side === m.winner_side,
      diff: side === 1 ? m.side1_score_differential : side === 2 ? m.side2_score_differential : null,
    }));

    res.set('Cache-Control', 'public, max-age=600');
    res.send(R.renderRecap({
      sides,
      tied,
      numHoles: m.num_holes,
      format: m.format,
      date: m.resolved_at,
      siteUrl: SITE_URL,
      recapUrl: SITE_URL ? `${SITE_URL}/r/${m.match_id}` : '',
    }));
  } catch (err) {
    console.error('recap error:', err);
    res.status(500).send(R.renderNotFound('match'));
  }
});

// Pull a user's recent resolved (non-practice) matches as recap rows: result,
// opponent, score, SR swing, course, date. Shared by the profile + recaps page.
async function fetchUserRecaps(userId, limit) {
  const { rows } = await pool.query(
    `SELECT m.match_id, mr.created_at AS resolved_at, mr.winner_side, mr.details,
            mp.side AS my_side, r.total_score, r.normalized_to_par, t.par AS teebox_par, c.course_name,
            opp.username AS opp_username, opp.is_bot AS opp_is_bot
       FROM match_players mp
       JOIN matches m ON m.match_id = mp.match_id AND m.is_practice = false
       JOIN match_results mr ON mr.match_id = m.match_id
       LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = mp.user_id
       LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
       LEFT JOIN courses c ON c.course_id = t.course_id
       LEFT JOIN LATERAL (
         SELECT u2.username, u2.is_bot
           FROM match_players mp2 JOIN users u2 ON u2.user_id = mp2.user_id
          WHERE mp2.match_id = m.match_id AND mp2.side <> mp.side
          ORDER BY mp2.side LIMIT 1
       ) opp ON true
      WHERE mp.user_id = $1
      ORDER BY mr.created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map((row) => {
    const deltas = (row.details && row.details.playerDeltas) || {};
    const tied = row.winner_side == null;
    return {
      matchId: row.match_id,
      date: row.resolved_at,
      result: tied ? 'tie' : (Number(row.my_side) === Number(row.winner_side) ? 'win' : 'loss'),
      oppName: row.opp_username,
      oppIsBot: row.opp_is_bot,
      toPar: row.normalized_to_par != null
        ? row.normalized_to_par
        : (row.total_score != null && row.teebox_par != null ? row.total_score - row.teebox_par : null),
      courseName: row.course_name,
      delta: Math.round(Number(deltas[userId] ?? 0)),
    };
  });
}

// ----- Player recaps (browse all of a player's round + match recaps) --------
app.get('/u/:username/recaps', async (req, res) => {
  const username = String(req.params.username || '').slice(0, 40);
  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, elo FROM users WHERE lower(username) = lower($1) LIMIT 1`,
      [username]
    );
    if (!rows.length) { res.status(404).send(R.renderNotFound(username)); return; }
    const u = rows[0];
    const recaps = await fetchUserRecaps(u.user_id, 60);
    const rank = rankForElo(u.elo);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderUserRecaps({
      username: u.username, rank, recaps,
      siteUrl: SITE_URL,
      recapsUrl: SITE_URL ? `${SITE_URL}/u/${encodeURIComponent(u.username)}/recaps` : '',
    }));
  } catch (err) {
    console.error('user recaps error:', err);
    res.status(500).send(R.renderNotFound(username));
  }
});

// ----- Player profile -------------------------------------------------------
app.get('/u/:username', async (req, res) => {
  const username = String(req.params.username || '').slice(0, 40);
  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, elo, total_matches, total_wins, total_ties,
              avatar_url, handicap_index, bio, created_at
         FROM users WHERE lower(username) = lower($1) LIMIT 1`,
      [username]
    );
    if (!rows.length) { res.status(404).send(R.renderNotFound(username)); return; }
    const u = rows[0];

    const PROFILE_RECAPS = 6;
    const recaps = await fetchUserRecaps(u.user_id, PROFILE_RECAPS + 1);
    const hasMoreRecaps = recaps.length > PROFILE_RECAPS;

    const rank = rankForElo(u.elo);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderProfile({
      username: u.username,
      avatarUrl: u.avatar_url ? BACKEND_URL + u.avatar_url : null,
      elo: u.elo, totalMatches: u.total_matches, totalWins: u.total_wins, totalTies: u.total_ties,
      handicap: u.handicap_index, bio: u.bio, createdAt: u.created_at,
      recaps: recaps.slice(0, PROFILE_RECAPS),
      hasMoreRecaps,
      rank, medallion: medallionFor(rank.tier.key),
      siteUrl: SITE_URL, appStoreUrl: APP_STORE_URL,
      profileUrl: SITE_URL ? `${SITE_URL}/u/${encodeURIComponent(u.username)}` : '',
    }));
  } catch (err) {
    console.error('profile error:', err);
    res.status(500).send(R.renderNotFound(username));
  }
});

// ----- Legal + support ------------------------------------------------------
const PRIVACY_HTML = `
<p>This policy covers the Sacari Golf app and this website. It is a plain-language summary; review it with your own counsel before launch.</p>
<h2>What we collect</h2>
<p>Account details you provide (username, email). Gameplay data (scores, rounds, shots, stats, SR and rank). Your location only while you use GPS and shot-tracking features. Photos you choose to upload (avatar, finds).</p>
<h2>How we use it</h2>
<p>To run matches and scoring, compute your stats and ranking, power leaderboards and public profiles, and improve crowd-sourced course data.</p>
<h2>What is public</h2>
<p>Your username, rank, win-loss record, recent rounds, and avatar appear on public leaderboards and your profile page. Your email is never shown publicly.</p>
<h2>Sharing</h2>
<p>We do not sell your personal data. We use service providers (hosting, push notifications) only to operate the app.</p>
<h2>Your choices</h2>
<p>Edit your profile or delete your account at any time from the app. Deleting your account removes your personal data.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`;

const TERMS_HTML = `
<p>By using Sacari Golf you agree to these terms. This is a plain-language template; review it with your own counsel before launch.</p>
<h2>Fair play</h2>
<p>Play honestly. Falsifying scores, abusing other players, or exploiting the app may result in suspension or removal.</p>
<h2>Your content</h2>
<p>You are responsible for content you post (usernames, photos, messages, captions). Do not post anything illegal, harassing, or infringing.</p>
<h2>No warranty</h2>
<p>The app is provided as is, without warranty. Distances, stats, and ratings are for entertainment and may be inaccurate.</p>
<h2>Changes</h2>
<p>We may update the app and these terms over time. Continued use means you accept the changes.</p>
<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`;

const SUPPORT_HTML = `
<p>Need help? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we will get back to you.</p>
<h2>My course is missing</h2>
<p>Open the Courses tab in the app and tap "+ Request" to submit the course details. New courses are typically added within a couple of days.</p>
<h2>Delete my account</h2>
<p>Go to your Profile in the app and choose delete account. This permanently removes your data.</p>
<h2>Report a problem</h2>
<p>Use the report option in the app on any post, message, or profile, or email us directly.</p>`;

/**
 * Public referral landing. Tapping a /invite/<code> link from a current
 * user lands here. We resolve the code → inviter username, render the
 * code + an App Store button, and link-preview OG tags carry the
 * inviter's name so iMessage / SMS / Slack show "Richard invited you
 * to Sacari Golf" instead of a generic page title.
 *
 * Unknown / malformed codes get a 404 so a typo doesn't render a
 * misleading "A friend invited you" landing.
 */
app.get('/invite/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!code) {
    res.status(404);
    return res.send(R.renderNotFound('invite link'));
  }
  try {
    const { rows } = await pool.query(
      `SELECT username FROM users WHERE referral_code = $1 LIMIT 1`,
      [code]
    );
    if (!rows.length) {
      res.status(404);
      return res.send(R.renderNotFound('invite link'));
    }
    res.send(R.renderInvite({
      inviter: rows[0].username,
      code,
      appStoreUrl: APP_STORE_URL,
      siteUrl: SITE_URL,
    }));
  } catch (e) {
    res.status(500);
    return res.send(R.renderNotFound('invite link'));
  }
});

app.get('/privacy', (_req, res) => res.send(R.renderStatic({
  title: 'Privacy Policy', heading: 'Privacy Policy', path: '/privacy',
  description: 'How Sacari Golf collects and uses your data.', html: PRIVACY_HTML,
})));
app.get('/terms', (_req, res) => res.send(R.renderStatic({
  title: 'Terms of Service', heading: 'Terms of Service', path: '/terms',
  description: 'The terms for using Sacari Golf.', html: TERMS_HTML,
})));
app.get('/support', (_req, res) => res.send(R.renderStatic({
  title: 'Support', heading: 'Support', path: '/support',
  description: 'Get help with Sacari Golf.', html: SUPPORT_HTML,
})));

// ----- SEO ------------------------------------------------------------------
app.get('/robots.txt', (_req, res) => {
  // Block only the private surfaces + thin search-query pages from crawl.
  // Recap (/r/) and invite (/invite/) pages stay crawlable so social + search
  // card bots can read their OG tags; they carry a noindex meta instead, which
  // keeps them out of the index without blocking link-preview scrapers.
  res.type('text/plain').send(
    `User-agent: *\n` +
    `Disallow: /account\n` +
    `Disallow: /login\n` +
    `Disallow: /courses?\n` +
    `Allow: /\n` +
    `${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml` : ''}`
  );
});

app.get('/sitemap.xml', async (_req, res) => {
  const base = SITE_URL || '';
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { loc: '/', priority: '1.0', lastmod: today },
    { loc: '/how-to-play', priority: '0.8', lastmod: today },
    { loc: '/leaderboard', priority: '0.8' },
    { loc: '/matches', priority: '0.7' },
    { loc: '/courses', priority: '0.8' },
    { loc: '/privacy', priority: '0.3', lastmod: today },
    { loc: '/terms', priority: '0.3', lastmod: today },
    { loc: '/support', priority: '0.3', lastmod: today },
  ];
  try {
    const [{ rows: courses }, { rows: players }] = await Promise.all([
      pool.query(
        `SELECT c.course_id FROM courses c
           JOIN teeboxes t ON t.course_id = c.course_id
           JOIN rounds r ON r.teebox_id = t.teebox_id
          GROUP BY c.course_id ORDER BY COUNT(r.round_id) DESC LIMIT 1000`
      ),
      pool.query(`SELECT username FROM users WHERE total_matches > 0 AND is_bot = false ORDER BY elo DESC LIMIT 1000`),
    ]);
    for (const c of courses) entries.push({ loc: `/course/${c.course_id}`, priority: '0.6' });
    for (const p of players) entries.push({ loc: `/u/${encodeURIComponent(p.username)}`, priority: '0.5' });
  } catch (err) {
    console.error('sitemap error:', err);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.map((e) =>
      `<url><loc>${R.esc(base + e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}<priority>${e.priority}</priority></url>`
    ).join('\n') + `\n</urlset>`;
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(body);
});

// ----- 404 ------------------------------------------------------------------
app.use((_req, res) => res.status(404).send(R.renderNotFound()));

app.listen(PORT, () => console.log(`Sacari web running on :${PORT}`));
