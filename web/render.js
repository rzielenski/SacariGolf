/**
 * Server-side HTML rendering for the public site. Pure functions: data in,
 * HTML string out. No DB access here (that lives in server.js).
 */
'use strict';

const { TIERS } = require('./rank');

const APP_STORE_URL = process.env.APP_STORE_URL || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}
function fmtToPar(n) {
  if (n == null || isNaN(n)) return '';
  if (n === 0) return 'E';
  return n > 0 ? '+' + n : String(n);
}
function fmtHandicap(h) {
  if (h == null || isNaN(h)) return 'NR';
  return h < 0 ? '+' + Math.abs(h).toFixed(1) : h.toFixed(1);
}
function toParClass(n) { return n == null ? '' : n <= 0 ? 'good' : 'bad'; }

function nav(active) {
  const link = (href, key, label) =>
    `<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  const cta = APP_STORE_URL ? `<a class="nav-cta" href="${esc(APP_STORE_URL)}">Get the app</a>` : '';
  return `<header class="topbar">
    <a class="brand" href="/">SACARI<span>GOLF</span></a>
    <nav class="nav">
      ${link('/leaderboard', 'leaderboard', 'Rankings')}
      ${link('/courses', 'courses', 'Courses')}
      ${cta}
    </nav>
  </header>`;
}

function foot() {
  return `<footer class="foot">
    <div class="foot-links">
      <a href="/leaderboard">Rankings</a>
      <a href="/courses">Courses</a>
      <a href="/support">Support</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </div>
    <div class="foot-copy">Sacari Golf. Competitive golf with ranked divisions, clans, and shot tracking.</div>
  </footer>`;
}

function page({ title, description, ogImage, ogUrl, body, active, bodyClass }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="icon" href="/crests/gold.png" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}" />` : ''}
${ogUrl ? `<meta property="og:url" content="${esc(ogUrl)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}" />` : ''}
<link rel="stylesheet" href="/styles.css" />
</head>
<body class="${bodyClass || ''}">
${nav(active)}
<main>${body}</main>
${foot()}
</body>
</html>`;
}

function appStoreButton(label) {
  return APP_STORE_URL ? `<a class="cta" href="${esc(APP_STORE_URL)}">${esc(label || 'Download on the App Store')}</a>` : '';
}

function crestLadder() {
  const cells = TIERS.map((t) => {
    const range = t.key === 'obsidian' ? '1500+' :
      `${t.floor} to ${t.floor + 200}`;
    return `<div class="ladder-cell">
      <img src="/crests/${t.key}.png" alt="${esc(t.name)} crest" loading="lazy" />
      <div class="ladder-name" style="color:${t.color}">${esc(t.name)}</div>
      <div class="ladder-range">${esc(range)} ELO</div>
    </div>`;
  }).join('');
  return `<div class="ladder">${cells}</div>`;
}

// ----- Home -----------------------------------------------------------------
function renderHome() {
  const body = `
  <section class="hero">
    <h1>Competitive golf, ranked.</h1>
    <p class="hero-sub">Climb from Wood to Obsidian, battle clans, and track every shot. The free, competitive way to play the game you already love.</p>
    <div class="hero-cta">
      ${appStoreButton('Download on the App Store')}
      <a class="cta-ghost" href="/leaderboard">See the rankings</a>
    </div>
    <img class="hero-crest" src="/crests/diamond.png" alt="Diamond rank crest" />
  </section>

  <section class="feature">
    <h2>Earn your rank</h2>
    <p>Every ranked match moves you up a real ladder. Eight tiers, fifty LP per division, seasonal climbs, and crests you actually want to show off.</p>
    ${crestLadder()}
  </section>

  <section class="feature alt">
    <div class="feature-grid">
      <div class="feature-card">
        <h3>Know your game</h3>
        <p>Per-club dispersion heatmaps, strokes gained, and weather-adjusted plays-like distances from every tracked shot.</p>
      </div>
      <div class="feature-card">
        <h3>Bring your crew</h3>
        <p>Solo, duo, and full-squad matches. Form a clan, battle other clans, and talk trash in live match chat.</p>
      </div>
      <div class="feature-card">
        <h3>Free, no paywall</h3>
        <p>Every premium feature is unlocked free during open beta. GPS, stats, heatmaps, the works. No card, no ads.</p>
      </div>
      <div class="feature-card">
        <h3>Your own profile</h3>
        <p>A shareable page at sacarigolf.com/u/your-name showing your rank, record, and recent rounds.</p>
      </div>
    </div>
  </section>

  <section class="cta-band">
    <h2>Start climbing.</h2>
    ${appStoreButton('Download on the App Store')}
  </section>`;

  return page({
    title: 'Sacari Golf. Competitive golf with ranked divisions and shot tracking.',
    description: 'Climb a ranked ladder from Wood to Obsidian, battle clans, and track every shot. The free, competitive golf app.',
    ogImage: SITE_URL ? `${SITE_URL}/crests/diamond.png` : '/crests/diamond.png',
    ogUrl: SITE_URL || '',
    active: 'home',
    bodyClass: 'home',
    body,
  });
}

// ----- Leaderboard ----------------------------------------------------------
function renderLeaderboard({ players }) {
  const rows = players.map((p, i) => {
    const rank = p.rank;
    const losses = Math.max(0, p.total_matches - p.total_wins - (p.total_ties || 0));
    const medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : '';
    return `<a class="lb-row ${medal}" href="/u/${encodeURIComponent(p.username)}">
      <span class="lb-pos">${i + 1}</span>
      <span class="lb-crest"><img src="/crests/${rank.tier.key}.png" alt="" loading="lazy" /></span>
      <span class="lb-name">${esc(p.username)}</span>
      <span class="lb-rank" style="color:${rank.color}">${esc(rank.isObsidian ? 'Obsidian ' + rank.displayElo : rank.label)}</span>
      <span class="lb-rec">${p.total_wins}-${losses}-${p.total_ties || 0}</span>
    </a>`;
  }).join('');

  const body = `
  <section class="page-head">
    <h1>Global Rankings</h1>
    <p>The top players climbing the Sacari ladder. Tap any player for their full profile.</p>
  </section>
  <section class="lb">
    <div class="lb-head">
      <span class="lb-pos">#</span><span class="lb-crest"></span>
      <span class="lb-name">Player</span><span class="lb-rank">Rank</span><span class="lb-rec">W-L-T</span>
    </div>
    ${rows || '<div class="empty">No ranked players yet.</div>'}
  </section>`;

  return page({
    title: 'Global Rankings. Sacari Golf',
    description: 'The top-ranked players on Sacari Golf, from Wood to Obsidian.',
    ogImage: SITE_URL ? `${SITE_URL}/crests/obsidian.png` : '',
    ogUrl: SITE_URL ? `${SITE_URL}/leaderboard` : '',
    active: 'leaderboard',
    body,
  });
}

// ----- Courses index --------------------------------------------------------
function courseCard(c) {
  const loc = [c.city, c.state, c.country].filter(Boolean).join(', ');
  const plays = c.plays != null ? `<span class="course-plays">${c.plays} round${c.plays === 1 ? '' : 's'}</span>` : '';
  return `<a class="course-card" href="/course/${esc(c.course_id)}">
    <span class="course-name">${esc(c.course_name)}</span>
    <span class="course-loc">${esc(loc)}</span>
    ${plays}
  </a>`;
}

function renderCoursesIndex({ popular, results, q }) {
  const searchVal = q ? esc(q) : '';
  let listing;
  if (q) {
    listing = `<h2>Results for "${esc(q)}"</h2>
      <div class="course-grid">${(results || []).map(courseCard).join('') || '<div class="empty">No courses match. Request it in the app.</div>'}</div>`;
  } else {
    listing = `<h2>Popular courses</h2>
      <div class="course-grid">${(popular || []).map(courseCard).join('') || '<div class="empty">No rounds logged yet.</div>'}</div>`;
  }
  const body = `
  <section class="page-head">
    <h1>Courses</h1>
    <p>Browse courses played on Sacari, see tee info and the best rounds posted at each.</p>
    <form class="course-search" method="get" action="/courses">
      <input type="text" name="q" value="${searchVal}" placeholder="Search course, club, city..." />
      <button type="submit">Search</button>
    </form>
  </section>
  <section class="courses">${listing}</section>`;

  return page({
    title: q ? `Courses matching "${q}". Sacari Golf` : 'Golf Courses. Sacari Golf',
    description: 'Browse golf courses on Sacari Golf, with tee info and the best rounds posted at each.',
    ogUrl: SITE_URL ? `${SITE_URL}/courses` : '',
    active: 'courses',
    body,
  });
}

// ----- Course detail --------------------------------------------------------
function renderCourse({ course, teeboxes, topRounds }) {
  const loc = [course.city, course.state, course.country].filter(Boolean).join(', ');
  const tees = (teeboxes || []).map((t) => `<tr>
    <td>${esc(t.name || '')}</td>
    <td>${t.par != null ? esc(t.par) : ''}</td>
    <td>${t.num_holes != null ? esc(t.num_holes) : ''}</td>
    <td>${t.total_yards != null ? Number(t.total_yards).toLocaleString() : ''}</td>
    <td>${t.course_rating != null ? esc(t.course_rating) : ''}</td>
    <td>${t.slope_rating != null ? esc(t.slope_rating) : ''}</td>
  </tr>`).join('');

  const rounds = (topRounds || []).map((r, i) => {
    const tp = r.total_score != null && r.teebox_par != null ? r.total_score - r.teebox_par : null;
    return `<li class="round">
      <span class="lb-pos">${i + 1}</span>
      <a class="round-course" href="/u/${encodeURIComponent(r.username)}">${esc(r.username)}</a>
      <span class="round-meta">${esc(r.teebox_name || '')} · ${esc(fmtDate(r.created_at))}</span>
      <span class="round-score">${r.total_score != null ? esc(r.total_score) : ''}</span>
      ${tp != null ? `<span class="round-topar ${toParClass(tp)}">${esc(fmtToPar(tp))}</span>` : ''}
    </li>`;
  }).join('');

  const body = `
  <section class="page-head">
    <h1>${esc(course.course_name)}</h1>
    ${loc ? `<p>${esc(loc)}</p>` : ''}
  </section>
  ${tees ? `<section class="tees">
    <h2>Tees</h2>
    <table class="tee-table"><thead><tr><th>Tee</th><th>Par</th><th>Holes</th><th>Yards</th><th>Rating</th><th>Slope</th></tr></thead>
    <tbody>${tees}</tbody></table>
  </section>` : ''}
  <section class="course-board">
    <h2>Best rounds here</h2>
    <ul class="rounds">${rounds || '<div class="empty">No rounds posted at this course yet.</div>'}</ul>
  </section>
  <section class="cta-band">
    <h2>Play it on Sacari.</h2>
    ${appStoreButton('Download on the App Store')}
  </section>`;

  return page({
    title: `${course.course_name}${loc ? ', ' + loc : ''}. Sacari Golf`,
    description: `${course.course_name} on Sacari Golf. Tee info, ratings, and the best rounds posted here.`,
    ogUrl: SITE_URL ? `${SITE_URL}/course/${course.course_id}` : '',
    active: 'courses',
    body,
  });
}

// ----- Profile --------------------------------------------------------------
function avatarLayer(data) {
  const m = data.medallion;
  const left = (m.cx - m.diameter / 2) * 100;
  const top = (m.cy - m.diameter / 2) * 100;
  const wh = m.diameter * 100;
  const pos = `left:${left}%;top:${top}%;width:${wh}%;height:${wh}%;`;
  const inner = data.avatarUrl
    ? `<div class="av-photo" style="background-image:url('${esc(data.avatarUrl)}')"></div>`
    : `<div class="av-letter">${esc((data.username[0] || '?').toUpperCase())}</div>`;
  return `<div class="av-well" style="${pos}">
    ${inner}
    <div class="av-vignette"></div>
    <div class="av-wash" style="background:${esc(data.rank.color)}1f"></div>
  </div>`;
}
function statCell(label, value) {
  return `<div class="stat"><div class="stat-val">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;
}
function renderProfile(data) {
  const r = data.rank;
  const losses = Math.max(0, data.totalMatches - data.totalWins - data.totalTies);
  const winRate = data.totalMatches > 0 ? Math.round((data.totalWins / data.totalMatches) * 100) : 0;
  const rankLine = r.isObsidian ? `Obsidian ${r.displayElo}` : r.label;
  const sub = r.isObsidian ? `${r.displayElo} ELO` : `${r.lp} LP`;

  const recent = (data.recentRounds || []).map((round) => {
    const tp = fmtToPar(round.toPar);
    return `<li class="round">
      <span class="round-course">${esc(round.courseName || 'Round')}</span>
      <span class="round-meta">${esc(fmtDate(round.date))}</span>
      ${tp ? `<span class="round-topar ${toParClass(round.toPar)}">${esc(tp)}</span>` : ''}
    </li>`;
  }).join('');

  const body = `
  <section class="card">
    <div class="crest">
      <img class="crest-img" src="/crests/${esc(r.tier.key)}.png" alt="${esc(r.tier.name)} crest" />
      ${avatarLayer(data)}
    </div>
    <h1 class="name">${esc(data.username)}</h1>
    <div class="rank" style="color:${esc(r.color)}">${esc(rankLine)}</div>
    <div class="rank-sub">${esc(sub)}</div>
    ${data.bio ? `<p class="bio">${esc(data.bio)}</p>` : ''}
    <div class="stats">
      ${statCell('Record', `${data.totalWins}-${losses}-${data.totalTies}`)}
      ${statCell('Win rate', `${winRate}%`)}
      ${statCell('Handicap', fmtHandicap(data.handicap))}
      ${statCell('Since', fmtDate(data.createdAt))}
    </div>
    ${recent ? `<div class="recent"><div class="recent-title">Recent rounds</div><ul class="rounds">${recent}</ul></div>` : ''}
    ${appStoreButton('Get Sacari Golf')}
  </section>`;

  return page({
    title: `${data.username} · ${rankLine} on Sacari Golf`,
    description: `${data.username} is ${rankLine} on Sacari Golf with a ${data.totalWins}-${losses}-${data.totalTies} record. Track your rounds, climb the ranked ladder, and battle clans.`,
    ogImage: `${data.siteUrl}/crests/${r.tier.key}.png`,
    ogUrl: data.profileUrl,
    active: '',
    body,
  });
}

// ----- Static + 404 ---------------------------------------------------------
function renderStatic({ title, description, heading, html }) {
  const body = `<section class="doc"><h1>${esc(heading || title)}</h1>${html}</section>`;
  return page({ title: `${title}. Sacari Golf`, description, active: '', body });
}

function renderNotFound(what) {
  const body = `<section class="card landing">
    <h1 class="hero-small">Not found</h1>
    <p class="lead">${what ? `We couldn't find "${esc(what)}".` : 'That page does not exist.'}</p>
    <a class="cta-link" href="/">Back home</a>
  </section>`;
  return page({ title: 'Not found. Sacari Golf', description: 'Page not found.', active: '', body });
}

module.exports = {
  renderHome, renderLeaderboard, renderCoursesIndex, renderCourse,
  renderProfile, renderStatic, renderNotFound, esc,
};
