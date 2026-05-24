/**
 * Sacari Golf public website. Standalone Express server, separate from the
 * mobile app and the API. Server-rendered for rich link previews and SEO.
 * Reads the same Postgres DB read-only.
 *
 *   /                 home / marketing
 *   /leaderboard      global rankings
 *   /courses          course directory + search (?q=)
 *   /course/:id       course detail (tees + best rounds)
 *   /u/:username      public player profile
 *   /privacy /terms /support   legal + support
 *   /sitemap.xml /robots.txt   SEO
 *   /healthz          health check
 */
'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { rankForElo, medallionFor } = require('./rank');
const { backendLogin, apiGet, apiGetSafe, setSession, clearSession, requireAuth } = require('./auth');
const R = require('./render');

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
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ----- Auth: login / logout -------------------------------------------------
app.get('/login', (req, res) => {
  if (req.cookies && req.cookies.sg_token) { res.redirect('/account'); return; }
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
    res.redirect('/account');
  } catch (err) {
    res.status(401).send(R.renderLogin({ error: err.message || 'Invalid email or password.' }));
  }
});

app.get('/logout', (_req, res) => { clearSession(res); res.redirect('/'); });

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

// ----- Home -----------------------------------------------------------------
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.send(R.renderHome());
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

// ----- Course detail --------------------------------------------------------
app.get('/course/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).send(R.renderNotFound('course')); return; }
  try {
    const { rows: cRows } = await pool.query(
      `SELECT course_id, course_name, club_name, city, state, country FROM courses WHERE course_id = $1`,
      [id]
    );
    if (!cRows.length) { res.status(404).send(R.renderNotFound('course')); return; }

    const { rows: teeboxes } = await pool.query(
      `SELECT name, par, num_holes, total_yards, course_rating, slope_rating
         FROM teeboxes WHERE course_id = $1 ORDER BY total_yards DESC NULLS LAST`,
      [id]
    );
    const { rows: topRounds } = await pool.query(
      `SELECT u.username, r.total_score, t.par AS teebox_par, t.name AS teebox_name, r.created_at
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id AND m.completed = true
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
         JOIN users u ON u.user_id = r.user_id
        WHERE t.course_id = $1 AND r.total_score IS NOT NULL AND t.par IS NOT NULL
        ORDER BY (r.total_score - t.par) ASC, r.created_at DESC LIMIT 15`,
      [id]
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderCourse({ course: cRows[0], teeboxes, topRounds }));
  } catch (err) {
    console.error('course error:', err);
    res.status(500).send(R.renderNotFound('course'));
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

    const { rows: roundRows } = await pool.query(
      `SELECT r.total_score, r.created_at, t.par AS teebox_par, c.course_name
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id AND m.completed = true
         LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
         LEFT JOIN courses c ON c.course_id = t.course_id
        WHERE r.user_id = $1 AND r.total_score IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 5`,
      [u.user_id]
    );

    const rank = rankForElo(u.elo);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(R.renderProfile({
      username: u.username,
      avatarUrl: u.avatar_url ? BACKEND_URL + u.avatar_url : null,
      elo: u.elo, totalMatches: u.total_matches, totalWins: u.total_wins, totalTies: u.total_ties,
      handicap: u.handicap_index, bio: u.bio, createdAt: u.created_at,
      recentRounds: roundRows.map((rr) => ({
        courseName: rr.course_name,
        toPar: rr.total_score != null && rr.teebox_par != null ? rr.total_score - rr.teebox_par : null,
        date: rr.created_at,
      })),
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
<p>Account details you provide (username, email). Gameplay data (scores, rounds, shots, stats, ELO and rank). Your location only while you use GPS and shot-tracking features. Photos you choose to upload (avatar, finds).</p>
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

app.get('/privacy', (_req, res) => res.send(R.renderStatic({
  title: 'Privacy Policy', heading: 'Privacy Policy',
  description: 'How Sacari Golf collects and uses your data.', html: PRIVACY_HTML,
})));
app.get('/terms', (_req, res) => res.send(R.renderStatic({
  title: 'Terms of Service', heading: 'Terms of Service',
  description: 'The terms for using Sacari Golf.', html: TERMS_HTML,
})));
app.get('/support', (_req, res) => res.send(R.renderStatic({
  title: 'Support', heading: 'Support',
  description: 'Get help with Sacari Golf.', html: SUPPORT_HTML,
})));

// ----- SEO ------------------------------------------------------------------
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml` : ''}`);
});

app.get('/sitemap.xml', async (_req, res) => {
  const base = SITE_URL || '';
  const urls = ['/', '/leaderboard', '/courses', '/privacy', '/terms', '/support'];
  try {
    const [{ rows: players }, { rows: courses }] = await Promise.all([
      pool.query(`SELECT username FROM users WHERE total_matches > 0 ORDER BY elo DESC LIMIT 500`),
      pool.query(
        `SELECT c.course_id FROM courses c
           JOIN teeboxes t ON t.course_id = c.course_id
           JOIN rounds r ON r.teebox_id = t.teebox_id
          GROUP BY c.course_id ORDER BY COUNT(r.round_id) DESC LIMIT 500`
      ),
    ]);
    for (const p of players) urls.push(`/u/${encodeURIComponent(p.username)}`);
    for (const c of courses) urls.push(`/course/${c.course_id}`);
  } catch (err) {
    console.error('sitemap error:', err);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `<url><loc>${R.esc(base + u)}</loc></url>`).join('\n') + `\n</urlset>`;
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(body);
});

// ----- 404 ------------------------------------------------------------------
app.use((_req, res) => res.status(404).send(R.renderNotFound()));

app.listen(PORT, () => console.log(`Sacari web running on :${PORT}`));
