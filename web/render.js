/**
 * Server-side HTML rendering for the public site. Pure functions: data in,
 * HTML string out. No DB access here (that lives in server.js).
 */
'use strict';

const { TIERS, medallionFor, rankForElo } = require('./rank');

const APP_STORE_URL = process.env.APP_STORE_URL || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
// Cache-buster for static assets, fixed at server start. Each deploy/restart
// gives a new value so browsers fetch fresh CSS/JS instead of a stale cached
// copy (static files are served with a 1h cache).
const ASSET_V = Date.now();
const SITE_NAME = 'Sacari Golf';
// Numeric App Store id (e.g. id6480000000 → 6480000000), used for the Safari
// Smart App Banner. Empty if APP_STORE_URL isn't an apps.apple.com/...id link.
const APP_ID = (String(APP_STORE_URL).match(/id(\d+)/) || [])[1] || '';
// Fallback social-share image so every page unfurls with something.
const DEFAULT_OG = SITE_URL ? `${SITE_URL}/crests/diamond.png` : '';

/** Render one or more schema.org objects as JSON-LD <script> tags. */
function jsonLdTag(objs) {
  const arr = Array.isArray(objs) ? objs : (objs ? [objs] : []);
  return arr.filter(Boolean)
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`)
    .join('\n');
}

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
function fmtAgo(d) {
  if (!d) return '';
  const then = new Date(d).getTime();
  if (isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const days = h / 24; if (days < 30) return `${Math.floor(days)}d ago`;
  const mo = days / 30; if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function nav(active, authed) {
  const link = (href, key, label) =>
    `<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  // Logged out: marketing + install. Logged in: the web app opens up, with a
  // prominent Play action.
  const items = authed
    ? `${link('/app', 'apphome', 'Home')}
       ${link('/leaderboard', 'leaderboard', 'Rankings')}
       ${link('/courses', 'courses', 'Courses')}
       ${link('/account', 'account', 'Profile')}
       <a href="/logout">Log out</a>
       <a class="nav-cta ${active === 'play' ? 'on' : ''}" href="/app/play">Play</a>`
    : `${link('/how-to-play', 'howto', 'How to Play')}
       ${link('/leaderboard', 'leaderboard', 'Rankings')}
       ${link('/matches', 'matches', 'Matches')}
       ${link('/courses', 'courses', 'Courses')}
       ${link('/login', 'login', 'Log in')}
       ${APP_STORE_URL ? `<a class="nav-cta" href="${esc(APP_STORE_URL)}">Get the app</a>` : ''}`;
  return `<header class="topbar">
    <a class="brand" href="${authed ? '/app' : '/'}" aria-label="Sacari Golf home">
      <img class="brand-logo" src="/logo.jpg" alt="Sacari Golf" />
    </a>
    <nav class="nav">${items}</nav>
  </header>`;
}

function foot() {
  return `<footer class="foot">
    <a class="foot-brand" href="/"><img src="/logo.jpg" alt="Sacari Golf" /></a>
    <div class="foot-links">
      <a href="/how-to-play">How to Play</a>
      <a href="/leaderboard">Rankings</a>
      <a href="/matches">Matches</a>
      <a href="/courses">Courses</a>
      <a href="/support">Support</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </div>
    <div class="foot-copy">Sacari Golf. Competitive golf with ranked divisions, clans, and shot tracking.</div>
  </footer>`;
}

function page({ title, description, ogImage, ogUrl, canonical, noindex, jsonLd, body, active, bodyClass, authed, bare }) {
  const img = ogImage || DEFAULT_OG;
  const canon = canonical || ogUrl || '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow'}" />
${canon ? `<link rel="canonical" href="${esc(canon)}" />` : ''}
<link rel="icon" href="/crests/gold.png" />
<link rel="apple-touch-icon" href="/crests/gold.png" />
<link rel="manifest" href="/site.webmanifest" />
<meta name="theme-color" content="#000000" />
${APP_ID ? `<meta name="apple-itunes-app" content="app-id=${esc(APP_ID)}" />` : ''}
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(SITE_NAME)}" />
<meta property="og:locale" content="en_US" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
${img ? `<meta property="og:image" content="${esc(img)}" />` : ''}
${canon ? `<meta property="og:url" content="${esc(canon)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
${img ? `<meta name="twitter:image" content="${esc(img)}" />` : ''}
<link rel="preload" href="/fonts/fraunces-var-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/inter-var-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/styles.css?v=${ASSET_V}" />
${jsonLdTag(jsonLd)}
</head>
<body class="${bodyClass || ''}">
${bare ? '' : nav(active, authed)}
<main>${body}</main>
${bare ? '' : foot()}
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
      <div class="ladder-range">${esc(range)} SR</div>
    </div>`;
  }).join('');
  return `<div class="ladder">${cells}</div>`;
}

// ----- Home -----------------------------------------------------------------
function renderHome() {
  const body = `
  <section class="hero">
    <img class="hero-crest" src="/logo.jpg" alt="Sacari Golf logo" />
    <div class="hero-eyebrow">Free · iOS · Ranked</div>
    <h1>Competitive golf, ranked.</h1>
    <p class="hero-sub">Climb from Wood to Obsidian, battle clans, and track every shot. The free, competitive way to play the game you already love.</p>
    <div class="hero-cta">
      ${appStoreButton('Download on the App Store')}
      <a class="cta-ghost" href="/how-to-play">How it works</a>
    </div>
  </section>

  <section class="feature">
    <h2>Earn your rank</h2>
    <p>Every ranked match moves you up a real ladder. Eight tiers, four divisions each, and placement games that fast-track new players to their true rank. Crests you actually want to show off.</p>
    ${crestLadder()}
  </section>

  <section class="feature alt">
    <div class="feature-grid">
      <div class="feature-card">
        <h3>Climb &amp; compete</h3>
        <p>Ranked solo, duo, and squad matches with live SR. Six-month seasons, the weekly Sacari Cup, and a partial reset each season so every climb counts.</p>
      </div>
      <div class="feature-card">
        <h3>Bring your crew</h3>
        <p>Form a clan to play as a duo or squad, climb the team leaderboard, and talk trash in live match chat. Agree to a live scoreboard and watch the battle hole-by-hole.</p>
      </div>
      <div class="feature-card">
        <h3>Make it yours</h3>
        <p>Unlock animated borders, profile backgrounds, and ball-trail effects in the Locker Room and Season Pass. Your look follows your name everywhere.</p>
      </div>
      <div class="feature-card">
        <h3>Know your game</h3>
        <p>Per-club dispersion, strokes gained, and weather-adjusted plays-like distances from every tracked shot. Plus a shareable profile at sacarigolf.com/u/your-name.</p>
      </div>
    </div>
  </section>

  <section class="cta-band">
    <h2>Start climbing.</h2>
    <div class="hero-cta">
      ${appStoreButton('Download on the App Store')}
      <a class="cta-ghost" href="/how-to-play">Read the guide</a>
    </div>
  </section>`;

  const jsonLd = SITE_URL ? [
    { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: SITE_URL, logo: `${SITE_URL}/crests/gold.png` },
    {
      '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE_URL,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE_URL}/courses?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org', '@type': 'MobileApplication', name: SITE_NAME,
      operatingSystem: 'iOS', applicationCategory: 'SportsApplication',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      ...(APP_STORE_URL ? { downloadUrl: APP_STORE_URL, installUrl: APP_STORE_URL } : {}),
    },
  ] : [];

  return page({
    title: 'Sacari Golf. Competitive golf with ranked divisions and shot tracking.',
    description: 'Climb a ranked ladder from Wood to Obsidian, battle clans, and track every shot. The free, competitive golf app.',
    ogImage: SITE_URL ? `${SITE_URL}/crests/diamond.png` : '/crests/diamond.png',
    ogUrl: SITE_URL || '',
    active: 'home',
    bodyClass: 'home',
    jsonLd,
    body,
  });
}

// ----- How to play ----------------------------------------------------------
function renderHowTo() {
  const step = (n, title, body) => `<li class="guide-step">
    <span class="guide-num">${n}</span>
    <div><h3>${title}</h3><p>${body}</p></div>
  </li>`;
  const card = (title, body) => `<div class="guide-card"><h3>${title}</h3><p>${body}</p></div>`;

  const body = `
  <section class="page-head">
    <h1>How to play</h1>
    <p>Everything you need to go from a fresh account to climbing the ranked ladder.</p>
  </section>

  <section class="guide">
    <h2 class="guide-h">Get started</h2>
    <ol class="guide-steps">
      ${step(1, 'Download &amp; sign up', 'Grab Sacari Golf from the App Store and create an account. You start at the Wood floor (100 SR) and climb from there.')}
      ${step(2, 'Set your home course', 'Pick your home course in Profile so the app can center maps, measure shot distances, and put you on your local feed. Missing a course? Tap "+ Request" on the Courses tab to add it.')}
      ${step(3, 'Play a ranked match', 'From the Play tab choose Solo, Duo, or Squad, pick your tees, and head out. Enter your score hole-by-hole; optionally track each shot on the satellite map for distances and stats.')}
      ${step(4, 'Submit and get matched', 'Finish your round and submit. Solo rounds auto-match you against a similar-rated opponent who also played; duos and squads pair against another team. SR is settled the moment both sides are in.')}
    </ol>

    <h2 class="guide-h">Climb the ladder</h2>
    <p class="guide-lead">Eight tiers, Wood through Obsidian. Each tier has four divisions of 50 SR. Your rank is just your SR, shown as division + SR (for example <strong>B III 23</strong> is Bronze 3, 23 SR).</p>
    <div class="guide-grid">
      ${card('Placement games', 'Your first 5 ranked matches each season swing hard, so a few good rounds rocket you toward your true rank instead of grinding up from the bottom.')}
      ${card('Every win counts', 'A win always moves you up by a guaranteed minimum, so beating a weaker opponent still climbs you. No more winning and gaining nothing.')}
      ${card('Seasons &amp; resets', 'Seasons run six months (Summer and Winter). At each rollover your SR gets a partial reset toward the start, so every season is a fresh climb that still rewards skill.')}
      ${card('The Sacari Cup', 'A weekly best-round competition. Top the cup and you earn the Champion Wreath border and a spot on the home page for the week.')}
    </div>

    <h2 class="guide-h">Team up</h2>
    <p class="guide-lead">Form a clan to play as a duo or squad. Clans have their own name, roster, and a team leaderboard ranked by your combined rating. Talk trash in live match chat with friends, teammates, and opponents.</p>

    <h2 class="guide-h">Make it yours</h2>
    <div class="guide-grid">
      ${card('The Locker Room', 'Equip animated avatar borders, profile backgrounds, ball-trail effects on the shot map, and username flair. They show up everywhere your name appears.')}
      ${card('Season Pass', 'Earn cosmetics by playing ranked rounds each month. Ten rounds completes the pass. No paid skips.')}
      ${card('Live scoreboard', 'In a match, both sides can agree to share scores in real time, so you can follow the battle hole-by-hole as it happens.')}
      ${card('Know your game', 'Per-club dispersion, strokes gained, and weather-adjusted plays-like distances from every tracked shot.')}
    </div>
  </section>

  <section class="cta-band">
    <h2>Ready to climb?</h2>
    ${appStoreButton('Download on the App Store')}
  </section>`;

  return page({
    title: 'How to play. Sacari Golf',
    description: 'Learn how to play Sacari Golf: ranked matches, divisions, placements, clans, cosmetics, and the live scoreboard.',
    canonical: SITE_URL ? `${SITE_URL}/how-to-play` : '',
    active: 'howto',
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
    <p>The top players climbing the Sacari ladder. Search any player, or tap a row for their full profile.</p>
    <div class="course-search-wrap">
      <form class="course-search" method="get" action="/leaderboard" autocomplete="off">
        <input type="text" name="q" id="player-q" placeholder="Search players by username..." autocomplete="off" />
        <button type="submit">Search</button>
      </form>
      <div class="ac-list" id="player-ac" hidden></div>
    </div>
  </section>
  <section class="lb">
    <div class="lb-head">
      <span class="lb-pos">#</span><span class="lb-crest"></span>
      <span class="lb-name">Player</span><span class="lb-rank">Rank</span><span class="lb-rec">W-L-T</span>
    </div>
    ${rows || '<div class="empty">No ranked players yet.</div>'}
  </section>
  <script src="/players.js?v=${ASSET_V}" defer></script>`;

  return page({
    title: 'Global Rankings. Sacari Golf',
    description: 'The top-ranked players on Sacari Golf, from Wood to Obsidian.',
    ogImage: SITE_URL ? `${SITE_URL}/crests/obsidian.png` : '',
    ogUrl: SITE_URL ? `${SITE_URL}/leaderboard` : '',
    active: 'leaderboard',
    body,
  });
}

// ----- Recent matches feed --------------------------------------------------
function feedSide(side) {
  const rep = side.players[0];
  const rk = rankForElo(rep.elo);
  const names = side.players.map((p) => p.is_bot
    ? `<span class="feed-name">${esc(p.username)}</span>`
    : `<a class="feed-name" href="/u/${encodeURIComponent(p.username)}">${esc(p.username)}</a>`).join(' &amp; ');
  const rankLabel = rk.isObsidian ? `Obsidian ${rk.displayElo}` : rk.label;
  let score = '';
  if (side.players.length === 1 && rep.total_score != null) {
    // Prefer the stored 18-hole-equivalent to-par (same value the app + course
    // board use); raw par-diff only as a fallback for un-backfilled rounds.
    const tpVal = rep.normalized_to_par != null
      ? rep.normalized_to_par
      : (rep.teebox_par != null ? rep.total_score - rep.teebox_par : null);
    const tp = tpVal != null ? fmtToPar(tpVal) : '';
    score = `${esc(rep.total_score)}${tp ? ` <small>${esc(tp)}</small>` : ''}`;
  }
  return `<div class="feed-side ${side.isWinner ? 'win' : ''}">
    <img class="feed-crest" src="/crests/${esc(rk.tier.key)}.png" alt="" loading="lazy" />
    <span class="feed-id">
      <span class="feed-names">${names}</span>
      <span class="feed-rank" style="color:${esc(rk.color)}">${esc(rankLabel)}</span>
    </span>
    <span class="feed-sc">${score}</span>
  </div>`;
}
function feedItem(match) {
  const bySide = new Map();
  for (const p of (match.players || [])) {
    if (!bySide.has(p.side)) bySide.set(p.side, []);
    bySide.get(p.side).push(p);
  }
  const tied = match.winner_side == null;
  const sides = [...bySide.entries()].sort((a, b) => a[0] - b[0]).map(([side, players]) => ({
    side, players, isWinner: !tied && side === match.winner_side,
  }));
  if (sides.length < 2) return '';
  const course = (match.players.find((p) => p.course_name) || {}).course_name;
  const meta = [tied ? 'Tied' : null, course, fmtAgo(match.resolved_at)].filter(Boolean).map(esc).join(' · ');
  return `<div class="feed-item">
    ${sides.map(feedSide).join('')}
    <div class="feed-foot">
      <span class="feed-meta">${meta}</span>
      <a class="feed-recap-link" href="/r/${esc(match.match_id)}">Recap →</a>
    </div>
  </div>`;
}
function renderMatchesFeed(data) {
  const items = (data.matches || []).map(feedItem).join('');
  const body = `
  <section class="page-head">
    <h1>Recent matches</h1>
    <p>The latest resolved ranked matches on Sacari Golf. Tap a player for their profile, or open the full recap.</p>
  </section>
  <section class="feed">${items || '<div class="empty">No matches resolved yet.</div>'}</section>
  <section class="cta-band">
    <h2>Get in the mix.</h2>
    ${appStoreButton('Download on the App Store')}
  </section>`;

  return page({
    title: 'Recent Matches. Sacari Golf',
    description: 'A live feed of the latest resolved ranked golf matches on Sacari Golf, with scores, results, and SR swings.',
    ogImage: SITE_URL ? `${SITE_URL}/crests/diamond.png` : '',
    ogUrl: SITE_URL ? `${SITE_URL}/matches` : '',
    canonical: SITE_URL ? `${SITE_URL}/matches` : '',
    active: 'matches',
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
    <div class="course-search-wrap">
      <form class="course-search" method="get" action="/courses" autocomplete="off">
        <input type="text" name="q" id="course-q" value="${searchVal}" placeholder="Search course, club, city..." autocomplete="off" />
        <button type="submit">Search</button>
      </form>
      <div class="ac-list" id="course-ac" hidden></div>
    </div>
  </section>
  <section class="courses">${listing}</section>
  <script src="/courses.js?v=${ASSET_V}" defer></script>`;

  return page({
    title: q ? `Courses matching "${q}". Sacari Golf` : 'Golf Courses. Sacari Golf',
    description: 'Browse golf courses on Sacari Golf, with tee info and the best rounds posted at each.',
    // Search-result pages are thin/duplicative: canonicalize to /courses and
    // keep them out of the index (links still followed).
    ogUrl: SITE_URL ? `${SITE_URL}/courses` : '',
    canonical: SITE_URL ? `${SITE_URL}/courses` : '',
    noindex: !!q,
    active: 'courses',
    body,
  });
}

// ----- Course detail --------------------------------------------------------
/** Collapse the per-tee hole rows into (a) one tee per yardage column and
 *  (b) one aggregate row per hole (par, stroke index, and the first known
 *  tee/pin coordinates) for the scorecard + map viewer. */
function courseHoleData(holeRows) {
  const teeMap = new Map();   // teebox_id -> { name, total_yards, yards: {holeNum: yd} }
  const holeMap = new Map();  // hole_num  -> { n, par, si, plat, plng, tlat, tlng }
  for (const r of holeRows || []) {
    let tee = teeMap.get(r.teebox_id);
    if (!tee) {
      tee = { name: r.tee_name || 'Tees', total_yards: r.total_yards != null ? Number(r.total_yards) : null, yards: {} };
      teeMap.set(r.teebox_id, tee);
    }
    if (r.yardage != null) tee.yards[r.hole_num] = Number(r.yardage);

    let h = holeMap.get(r.hole_num);
    if (!h) { h = { n: r.hole_num, par: null, si: null, plat: null, plng: null, tlat: null, tlng: null }; holeMap.set(r.hole_num, h); }
    if (h.par == null && r.par != null) h.par = Number(r.par);
    if (h.si == null && r.handicap != null) h.si = Number(r.handicap);
    if (h.plat == null && r.pin_lat != null) { h.plat = Number(r.pin_lat); h.plng = Number(r.pin_lng); }
    if (h.tlat == null && r.tee_lat != null) { h.tlat = Number(r.tee_lat); h.tlng = Number(r.tee_lng); }
  }
  const tees = [...teeMap.values()];                          // longest first (query order)
  const holes = [...holeMap.values()].sort((a, b) => a.n - b.n);
  return { tees, holes };
}

/** Classic golf scorecard: a Par row, a yardage row per tee, and a stroke-index
 *  row, with Out / In / Total summary columns when the course has a back nine. */
function courseScorecard(tees, holes) {
  if (!holes.length) return '';
  const front = holes.filter((h) => h.n <= 9);
  const back = holes.filter((h) => h.n > 9);
  const has18 = back.length > 0;
  const sum = (arr, fn) => arr.reduce((a, h) => { const v = fn(h); return a + (v != null && !isNaN(v) ? v : 0); }, 0);
  const cell = (v) => `<td>${v != null && v !== '' ? esc(v) : '-'}</td>`;
  const tot = (v) => `<td class="sc-tot">${v ? esc(v) : ''}</td>`;

  const headCells = (arr) => arr.map((h) => `<th>${esc(h.n)}</th>`).join('');
  let header = `<th class="sc-rl">Hole</th>${headCells(front)}`;
  if (has18) header += `<th class="sc-tot">Out</th>${headCells(back)}<th class="sc-tot">In</th>`;
  header += `<th class="sc-tot">Total</th>`;

  const dataRow = (label, fn, cls) => {
    const f = sum(front, fn), b = sum(back, fn);
    let cells = `<th class="sc-rl">${esc(label)}</th>` + front.map((h) => cell(fn(h))).join('');
    if (has18) cells += tot(f) + back.map((h) => cell(fn(h))).join('') + tot(b);
    cells += tot(f + b);
    return `<tr class="${cls || ''}">${cells}</tr>`;
  };

  const parRow = dataRow('Par', (h) => h.par, 'sc-par');
  const teeRows = tees.map((t) => {
    const yd = (h) => (t.yards[h.n] != null ? t.yards[h.n] : null);
    const f = sum(front, yd), b = sum(back, yd);
    let cells = `<th class="sc-rl">${esc(t.name)}</th>` + front.map((h) => cell(yd(h))).join('');
    if (has18) cells += tot(f) + back.map((h) => cell(yd(h))).join('') + tot(b);
    cells += tot(t.total_yards != null ? t.total_yards : (f + b));
    return `<tr>${cells}</tr>`;
  }).join('');

  // Stroke index row only if at least one hole carries it.
  let siRow = '';
  if (holes.some((h) => h.si != null)) {
    let cells = `<th class="sc-rl">Hcp</th>` + front.map((h) => cell(h.si)).join('');
    if (has18) cells += tot('') + back.map((h) => cell(h.si)).join('') + tot('');
    cells += tot('');
    siRow = `<tr class="sc-si">${cells}</tr>`;
  }

  return `<section class="course-card-sec">
    <h2>Scorecard</h2>
    <div class="sc-wrap"><table class="scorecard">
      <thead><tr>${header}</tr></thead>
      <tbody>${parRow}${teeRows}${siRow}</tbody>
    </table></div>
  </section>`;
}

/** Interactive, read-only hole-by-hole viewer: a satellite map (tee → green)
 *  plus par / yardage / stroke index, driven client-side by /course.js. Mirrors
 *  the in-app course preview without GPS. */
function courseHoleViewer(tees, holes, center) {
  if (!holes.length) return '';
  const showMap = !!center || holes.some((h) => h.plat != null || h.tlat != null);
  const holeBtns = holes.map((h) =>
    `<button type="button" class="hole-btn${h.plat != null ? ' has-pin' : ''}" data-n="${esc(h.n)}">
      <span class="hole-n">${esc(h.n)}</span><span class="hole-par">${h.par != null ? 'Par ' + esc(h.par) : '·'}</span>
    </button>`).join('');
  const teeSel = tees.length > 1
    ? `<label class="ch-tee">Tees <select id="hv-tee">${tees.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select></label>`
    : '';
  const data = {
    center: center || null,
    holes: holes.map((h) => ({ n: h.n, par: h.par, si: h.si, plat: h.plat, plng: h.plng, tlat: h.tlat, tlng: h.tlng })),
    tees: tees.map((t) => ({ name: t.name, yards: t.yards })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<section class="course-holes course-card-sec">
    <div class="ch-head"><h2>Hole by hole</h2>${teeSel}</div>
    <div class="hole-grid">${holeBtns}</div>
    ${showMap ? `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
    <div id="hv-map" class="course-map"></div>` : ''}
    <div class="hv-bar">
      <button type="button" id="hv-prev" class="hv-nav">‹</button>
      <div id="hv-info" class="hv-info">Select a hole.</div>
      <button type="button" id="hv-next" class="hv-nav">›</button>
    </div>
    <script>window.COURSE_DATA = ${json};</script>
    ${showMap ? `<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>` : ''}
    <script src="/course.js?v=${ASSET_V}" defer></script>
  </section>`;
}

function renderCourse({ course, teeboxes, topRounds, holeRows }) {
  const loc = [course.city, course.state, course.country].filter(Boolean).join(', ');
  const tees = (teeboxes || []).map((t) => `<tr>
    <td>${esc(t.name || '')}</td>
    <td>${t.par != null ? esc(t.par) : ''}</td>
    <td>${t.num_holes != null ? esc(t.num_holes) : ''}</td>
    <td>${t.total_yards != null ? Number(t.total_yards).toLocaleString() : ''}</td>
    <td>${t.course_rating != null ? esc(t.course_rating) : ''}</td>
    <td>${t.slope_rating != null ? esc(t.slope_rating) : ''}</td>
  </tr>`).join('');

  const { tees: scTees, holes } = courseHoleData(holeRows);
  let center = (course.latitude != null && course.longitude != null)
    ? [Number(course.latitude), Number(course.longitude)] : null;
  if (!center) {
    const wp = holes.find((h) => h.plat != null) || holes.find((h) => h.tlat != null);
    if (wp) center = wp.plat != null ? [wp.plat, wp.plng] : [wp.tlat, wp.tlng];
  }
  const scorecard = courseScorecard(scTees, holes);
  const viewer = courseHoleViewer(scTees, holes, center);

  const rounds = (topRounds || []).map((r, i) => {
    // 18-hole-equivalent to-par from the query (what the board is ranked on);
    // fall back to a raw par-diff only for older payloads without to_par.
    const tp = r.to_par != null
      ? r.to_par
      : (r.total_score != null && r.teebox_par != null ? r.total_score - r.teebox_par : null);
    return `<li class="round">
      <span class="lb-pos">${i + 1}</span>
      <a class="round-course" href="/u/${encodeURIComponent(r.username)}">${esc(r.username)}</a>
      <span class="round-meta">${esc(r.teebox_name || '')} · ${r.holes_played != null ? esc(r.holes_played) + ' holes · ' : ''}${esc(fmtDate(r.created_at))}</span>
      <span class="round-score">${r.total_score != null ? esc(r.total_score) : ''}</span>
      ${tp != null ? `<span class="round-topar ${toParClass(tp)}">${esc(fmtToPar(tp))}</span>` : ''}
    </li>`;
  }).join('');

  const body = `
  <section class="page-head">
    <h1>${esc(course.course_name)}</h1>
    ${loc ? `<p>${esc(loc)}</p>` : ''}
    <a class="cta-ghost" href="/course/${esc(course.course_id)}/pins">Add or correct pin locations</a>
  </section>
  ${tees ? `<section class="tees course-card-sec">
    <h2>Tees</h2>
    <table class="tee-table"><thead><tr><th>Tee</th><th>Par</th><th>Holes</th><th>Yards</th><th>Rating</th><th>Slope</th></tr></thead>
    <tbody>${tees}</tbody></table>
  </section>` : ''}
  ${scorecard}
  ${viewer}
  <section class="course-board course-card-sec">
    <h2>Best rounds here</h2>
    <ul class="rounds">${rounds || '<div class="empty">No rounds posted at this course yet.</div>'}</ul>
  </section>
  <section class="cta-band">
    <h2>Play it on Sacari.</h2>
    ${appStoreButton('Download on the App Store')}
  </section>`;

  let courseLd = null;
  if (SITE_URL) {
    courseLd = { '@context': 'https://schema.org', '@type': 'GolfCourse', name: course.course_name, url: `${SITE_URL}/course/${course.course_id}` };
    const addr = {};
    if (course.city) addr.addressLocality = course.city;
    if (course.state) addr.addressRegion = course.state;
    if (course.country) addr.addressCountry = course.country;
    if (Object.keys(addr).length) courseLd.address = { '@type': 'PostalAddress', ...addr };
    if (course.latitude != null && course.longitude != null) {
      courseLd.geo = { '@type': 'GeoCoordinates', latitude: Number(course.latitude), longitude: Number(course.longitude) };
    }
  }

  // Breadcrumb trail (Home › Courses › this course): a currently-supported
  // rich result, and a clearer hierarchy signal to crawlers.
  const courseCrumbs = SITE_URL ? {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Courses', item: `${SITE_URL}/courses` },
      { '@type': 'ListItem', position: 3, name: course.course_name, item: `${SITE_URL}/course/${course.course_id}` },
    ],
  } : null;

  return page({
    title: `${course.course_name}${loc ? ', ' + loc : ''}. Sacari Golf`,
    description: `${course.course_name} on Sacari Golf. Full scorecard, hole-by-hole satellite views, tee ratings, and the best rounds posted here.`,
    ogUrl: SITE_URL ? `${SITE_URL}/course/${course.course_id}` : '',
    jsonLd: [courseLd, courseCrumbs],
    active: 'courses',
    body,
  });
}

// ----- Match recap ----------------------------------------------------------
function fmtFormat(format) {
  switch (format) {
    case 'stableford': return 'Stableford';
    case 'match_play': return 'Match Play';
    case 'skins': return 'Skins';
    case 'scramble': return 'Scramble';
    default: return 'Stroke Play';
  }
}
function recapPlayerLink(p) {
  // Bots get their (now real-looking) name shown but no profile link — a bot
  // profile page isn't meaningful and we keep them off the rest of the site.
  return p.isBot ? esc(p.username) : `<a href="/u/${encodeURIComponent(p.username)}">${esc(p.username)}</a>`;
}
function recapSide(side, tied) {
  const stateClass = tied ? 'tie' : side.isWinner ? 'win' : 'loss';
  const players = side.players.map((p) => {
    const r = p.rank;
    const rankLine = r.isObsidian ? `Obsidian ${r.displayElo}` : r.label;
    const dlChip = p.delta
      ? `<span class="rc-elo ${p.delta > 0 ? 'up' : 'down'}">${p.delta > 0 ? '+' : ''}${p.delta} SR</span>`
      : '';
    return `<div class="rc-player">
      <img class="rc-crest" src="/crests/${esc(r.tier.key)}.png" alt="${esc(r.tier.name)} crest" loading="lazy" />
      <div class="rc-pmeta">
        <div class="rc-name">${recapPlayerLink(p)}</div>
        <div class="rc-rank" style="color:${esc(r.color)}">${esc(rankLine)}</div>
      </div>
      ${dlChip}
    </div>`;
  }).join('');

  // Single-player side (the common solo 1v1 / bot case): show the gross score
  // and to-par. Team sides: show the side's score differential instead.
  const rep = side.players[0];
  let scoreBlock = '';
  if (side.players.length === 1 && rep && rep.gross != null) {
    const tp = rep.toPar;
    scoreBlock = `<div class="rc-score">
      <div class="rc-gross">${esc(rep.gross)}</div>
      ${tp != null ? `<div class="round-topar ${toParClass(tp)}">${esc(fmtToPar(tp))}</div>` : ''}
      ${rep.courseName ? `<div class="rc-course">${esc(rep.courseName)}${rep.teeName ? ` · ${esc(rep.teeName)}` : ''}</div>` : ''}
    </div>`;
  } else if (side.diff != null) {
    scoreBlock = `<div class="rc-score">
      <div class="rc-gross">${esc(Math.round(side.diff * 10) / 10)}</div>
      <div class="rc-difflabel">differential</div>
    </div>`;
  }

  const badge = !tied && side.isWinner ? `<div class="rc-badge">Winner</div>` : '';
  return `<div class="rc-side ${stateClass}">${badge}${players}${scoreBlock}</div>`;
}
/** Golf score-vs-par class for a scorecard cell (eagle/birdie/bogey/double+). */
function scoreClass(d) {
  if (d == null) return '';
  if (d <= -2) return 'sc-eagle';
  if (d === -1) return 'sc-birdie';
  if (d === 1) return 'sc-bogey';
  if (d >= 2) return 'sc-dbl';
  return '';
}
/** One player's hole-by-hole scorecard: a Par row and a Score row (colored by
 *  score vs par), with Out / In / Total when the round is more than 9 holes. */
function recapScorecard(p) {
  const holes = p.holes || [];
  if (!holes.length) return '';
  const split = holes.length > 9;
  const front = split ? holes.slice(0, 9) : holes;
  const back = split ? holes.slice(9) : [];
  const sum = (arr, k) => arr.reduce((a, h) => a + (h[k] != null ? Number(h[k]) : 0), 0);
  const headNums = (arr) => arr.map((h) => `<th>${esc(h.hole_num)}</th>`).join('');
  const scoreCell = (h) => {
    if (h.score == null) return `<td>-</td>`;
    const cls = h.par != null ? scoreClass(h.score - h.par) : '';
    return `<td class="${cls}">${esc(h.score)}</td>`;
  };
  let header = `<th class="sc-rl">Hole</th>${headNums(front)}`;
  if (split) header += `<th class="sc-tot">Out</th>${headNums(back)}<th class="sc-tot">In</th>`;
  header += `<th class="sc-tot">Tot</th>`;
  const pf = sum(front, 'par'), pb = sum(back, 'par');
  let parR = `<th class="sc-rl">Par</th>${front.map((h) => `<td>${h.par != null ? esc(h.par) : '-'}</td>`).join('')}`;
  if (split) parR += `<td class="sc-tot">${pf || ''}</td>${back.map((h) => `<td>${h.par != null ? esc(h.par) : '-'}</td>`).join('')}<td class="sc-tot">${pb || ''}</td>`;
  parR += `<td class="sc-tot">${(pf + pb) || ''}</td>`;
  const sf = sum(front, 'score'), sb = sum(back, 'score');
  let scR = `<th class="sc-rl">Score</th>${front.map(scoreCell).join('')}`;
  if (split) scR += `<td class="sc-tot">${sf || ''}</td>${back.map(scoreCell).join('')}<td class="sc-tot">${sb || ''}</td>`;
  scR += `<td class="sc-tot">${(sf + sb) || ''}</td>`;
  const sub = [p.courseName, p.teeName].filter(Boolean).join(' · ');
  return `<div class="rc-sc-card">
    <div class="rc-sc-title">${recapPlayerLink(p)}${sub ? ` <span class="rc-sc-sub">${esc(sub)}</span>` : ''}</div>
    <div class="sc-wrap"><table class="scorecard">
      <thead><tr>${header}</tr></thead>
      <tbody><tr class="sc-par">${parR}</tr><tr>${scR}</tr></tbody>
    </table></div>
  </div>`;
}
function renderRecap(data) {
  const { sides, tied, numHoles, format, date } = data;
  const fmtLabel = fmtFormat(format);
  const sideName = (s) => s.players.map((p) => p.username).join(' & ');
  const winner = sides.find((s) => s.isWinner);
  const loser = sides.find((s) => !s.isWinner);
  const headline = (tied || !winner || !loser)
    ? sides.map(sideName).join(' tied ')
    : `${sideName(winner)} beat ${sideName(loser)}`;

  const arena = sides.map((s) => recapSide(s, tied)).join('<div class="rc-vs">VS</div>');
  const scorecards = sides.flatMap((s) => s.players).map(recapScorecard).filter(Boolean).join('');

  const body = `
  <section class="page-head rc-head">
    <div class="rc-kicker">Match Recap</div>
    <h1>${esc(headline)}</h1>
    <p>${esc(fmtLabel)} · ${esc(numHoles)} holes · ${esc(fmtDate(date))}</p>
  </section>
  <section class="rc">${arena}</section>
  ${scorecards ? `<section class="rc-scorecards course-card-sec">
    <h2>Scorecards</h2>
    <div class="rc-sc-list">${scorecards}</div>
  </section>` : ''}
  <section class="cta-band">
    <div class="rc-kicker">Free · ranked golf</div>
    <h2>${winner ? `Think you can beat ${esc(winner.players[0].username)}?` : 'Think you can take them?'}</h2>
    <p>Track every round, get a live handicap, and climb the ranked ladder. Free to play, instant matches.</p>
    ${appStoreButton('Get Sacari Golf — free')}
  </section>`;

  const ogCrest = winner ? winner.players[0].rank.tier.key : 'diamond';
  return page({
    title: `${headline} · Sacari Golf`,
    description: `${headline} in a ${numHoles}-hole ${fmtLabel} match on Sacari Golf. See the full recap, then climb the ranked ladder yourself.`,
    ogImage: data.siteUrl ? `${data.siteUrl}/crests/${ogCrest}.png` : '',
    ogUrl: data.recapUrl,
    // Per-match share targets: rich link previews, but too many + too thin to
    // belong in the search index.
    noindex: true,
    active: '',
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
/** One recap row: a link to /r/<matchId> showing W/L/T, opponent, course/date,
 *  to-par, and the SR swing. Shared by the profile + the per-user recaps page. */
function recapRow(rec) {
  const cls = rec.result; // win | loss | tie
  const letter = rec.result === 'win' ? 'W' : rec.result === 'loss' ? 'L' : 'T';
  const tp = fmtToPar(rec.toPar);
  const dl = rec.delta;
  const elo = dl
    ? `<span class="recap-elo ${dl > 0 ? 'up' : 'down'}">${dl > 0 ? '+' : ''}${dl}</span>`
    : `<span class="recap-elo"></span>`;
  return `<a class="recap-row ${cls}" href="/r/${esc(rec.matchId)}">
    <span class="recap-result ${cls}">${letter}</span>
    <span class="recap-main">
      <span class="recap-vs">vs ${esc(rec.oppName || 'opponent')}</span>
      <span class="recap-meta">${esc(rec.courseName || 'Round')}${rec.date ? ' · ' + esc(fmtDate(rec.date)) : ''}</span>
    </span>
    <span class="round-topar ${tp ? toParClass(rec.toPar) : ''}">${tp ? esc(tp) : ''}</span>
    ${elo}
  </a>`;
}
function renderProfile(data) {
  const r = data.rank;
  const losses = Math.max(0, data.totalMatches - data.totalWins - data.totalTies);
  const winRate = data.totalMatches > 0 ? Math.round((data.totalWins / data.totalMatches) * 100) : 0;
  const rankLine = r.isObsidian ? `Obsidian ${r.displayElo}` : r.label;
  const sub = r.isObsidian ? `${r.displayElo} SR` : `${r.lp} SR`;

  const recapRows = (data.recaps || []).map(recapRow).join('');
  const recapsPath = `/u/${encodeURIComponent(data.username)}/recaps`;

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
    ${recapRows ? `<div class="recent">
      <div class="recent-title">Recent recaps</div>
      <div class="recaps">${recapRows}</div>
      ${data.hasMoreRecaps ? `<a class="recaps-all" href="${esc(recapsPath)}">See all recaps →</a>` : ''}
    </div>` : ''}
    ${appStoreButton('Get Sacari Golf')}
  </section>`;

  const profileLd = data.profileUrl ? {
    '@context': 'https://schema.org', '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person', name: data.username, url: data.profileUrl,
      description: `${rankLine} on Sacari Golf`,
    },
  } : null;

  const profileCrumbs = data.siteUrl ? {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: data.siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Rankings', item: `${data.siteUrl}/leaderboard` },
      { '@type': 'ListItem', position: 3, name: data.username, item: data.profileUrl },
    ],
  } : null;

  return page({
    title: `${data.username} · ${rankLine} on Sacari Golf`,
    description: `${data.username} is ${rankLine} on Sacari Golf with a ${data.totalWins}-${losses}-${data.totalTies} record. Track your rounds, climb the ranked ladder, and battle clans.`,
    ogImage: `${data.siteUrl}/crests/${r.tier.key}.png`,
    ogUrl: data.profileUrl,
    jsonLd: [profileLd, profileCrumbs],
    active: '',
    body,
  });
}

// ----- Per-user recaps page -------------------------------------------------
function renderUserRecaps(data) {
  const r = data.rank;
  const rankLine = r.isObsidian ? `Obsidian ${r.displayElo}` : r.label;
  const rows = (data.recaps || []).map(recapRow).join('');
  const body = `
  <section class="page-head">
    <a class="recaps-back" href="/u/${encodeURIComponent(data.username)}">&larr; ${esc(data.username)}</a>
    <h1>${esc(data.username)} · Recaps</h1>
    <p>Round and match recaps for ${esc(data.username)}, ${esc(rankLine)} on Sacari Golf.</p>
  </section>
  <section class="recaps-page">
    <div class="recaps">${rows || '<div class="empty">No recaps yet. Play a ranked round in the app.</div>'}</div>
  </section>
  <section class="cta-band">
    <h2>Play your own ranked rounds.</h2>
    ${appStoreButton('Get Sacari Golf')}
  </section>`;

  return page({
    title: `${data.username} recaps · Sacari Golf`,
    description: `Every round and match recap for ${data.username} on Sacari Golf, with results, scores, and SR swings.`,
    ogImage: data.siteUrl ? `${data.siteUrl}/crests/${r.tier.key}.png` : '',
    ogUrl: data.recapsUrl,
    canonical: data.recapsUrl,
    active: '',
    body,
  });
}

// ----- Static + 404 ---------------------------------------------------------
function renderStatic({ title, description, heading, html, path }) {
  const body = `<section class="doc"><h1>${esc(heading || title)}</h1>${html}</section>`;
  return page({
    title: `${title}. Sacari Golf`, description,
    canonical: (SITE_URL && path) ? `${SITE_URL}${path}` : '',
    active: '', body,
  });
}

function renderNotFound(what) {
  const body = `<section class="card landing">
    <h1 class="hero-small">Not found</h1>
    <p class="lead">${what ? `We couldn't find "${esc(what)}".` : 'That page does not exist.'}</p>
    <a class="cta-link" href="/">Back home</a>
  </section>`;
  return page({ title: 'Not found. Sacari Golf', description: 'Page not found.', active: '', noindex: true, body });
}

// ----- Authenticated pages --------------------------------------------------
const CLUB_LABELS = {
  driver: 'Driver', '3w': '3 Wood', '5w': '5 Wood', '7w': '7 Wood', hybrid: 'Hybrid',
  '2i': '2 Iron', '3i': '3 Iron', '4i': '4 Iron', '5i': '5 Iron', '6i': '6 Iron',
  '7i': '7 Iron', '8i': '8 Iron', '9i': '9 Iron', pw: 'Pitching Wedge', gw: 'Gap Wedge',
  sw: 'Sand Wedge', lw: 'Lob Wedge', putter: 'Putter',
};
function clubLabel(c) { return CLUB_LABELS[c] || (c ? String(c).toUpperCase() : 'Club'); }
function sgFmt(n) { if (n == null || isNaN(n)) return 'NR'; const r = Math.round(n * 10) / 10; return (r > 0 ? '+' : '') + r; }
function pctFmt(n) { return n == null ? 'NR' : `${n}%`; }
function numFmt(n) { return n == null ? 'NR' : String(n); }

function crestBlock(d) {
  return `<div class="crest crest-sm">
    <img class="crest-img" src="/crests/${esc(d.rank.tier.key)}.png" alt="${esc(d.rank.tier.name)} crest" />
    ${avatarLayer(d)}
  </div>`;
}

function renderLogin({ error }) {
  const body = `
  <div class="login-wrap">
    <aside class="login-brand">
      <a href="/" class="login-logo-link"><img class="login-logo" src="/logo.jpg?v=${ASSET_V}" alt="Sacari Golf" /></a>
      <h2 class="login-tag">Competitive golf, ranked.</h2>
      <p class="login-sub">Climb from Wood to Obsidian, track every shot, and battle clans. Your account, on the web.</p>
    </aside>
    <section class="login-panel">
      <div class="login-card">
        <h1>Welcome back</h1>
        <p class="login-card-sub">Log in to see your rank, stats, and clubs.</p>
        ${error ? `<div class="form-error">${esc(error)}</div>` : ''}
        <form method="post" action="/login" class="form">
          <label class="field">
            <span class="field-label">Email</span>
            <span class="input-wrap"><span class="input-icon">@</span><input type="email" name="email" placeholder="you@email.com" autocomplete="email" required /></span>
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <span class="input-wrap"><span class="input-icon">&#9679;</span><input type="password" name="password" placeholder="Your password" autocomplete="current-password" required /></span>
          </label>
          <button class="login-btn" type="submit">Log in</button>
        </form>
        <p class="muted-note">New here? <a href="/signup">Create an account</a> and play right in your browser.</p>
        <a class="login-home" href="/">&larr; Back to sacarigolf.com</a>
      </div>
    </section>
  </div>`;
  return page({ title: 'Log in. Sacari Golf', description: 'Log in to Sacari Golf to view your stats.', active: 'login', authed: false, bare: true, bodyClass: 'login-body', noindex: true, body });
}

function renderSignup({ error, values }) {
  const v = values || {};
  const body = `
  <div class="login-wrap">
    <aside class="login-brand">
      <a href="/" class="login-logo-link"><img class="login-logo" src="/logo.jpg?v=${ASSET_V}" alt="Sacari Golf" /></a>
      <h2 class="login-tag">Play golf, ranked.</h2>
      <p class="login-sub">Create an account and play right here in your browser. Climb from Wood to Obsidian, no install needed.</p>
    </aside>
    <section class="login-panel">
      <div class="login-card">
        <h1>Create your account</h1>
        <p class="login-card-sub">Free, and you can start a ranked round in seconds.</p>
        ${error ? `<div class="form-error">${esc(error)}</div>` : ''}
        <form method="post" action="/signup" class="form">
          <label class="field">
            <span class="field-label">Username</span>
            <span class="input-wrap"><span class="input-icon">#</span><input type="text" name="username" value="${esc(v.username || '')}" placeholder="yourname" autocomplete="username" maxlength="24" required /></span>
          </label>
          <label class="field">
            <span class="field-label">Email</span>
            <span class="input-wrap"><span class="input-icon">@</span><input type="email" name="email" value="${esc(v.email || '')}" placeholder="you@email.com" autocomplete="email" required /></span>
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <span class="input-wrap"><span class="input-icon">&#9679;</span><input type="password" name="password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required /></span>
          </label>
          <button class="login-btn" type="submit">Create account</button>
        </form>
        <p class="muted-note">Already have an account? <a href="/login">Log in</a></p>
        <a class="login-home" href="/">&larr; Back to sacarigolf.com</a>
      </div>
    </section>
  </div>`;
  return page({ title: 'Sign up. Sacari Golf', description: 'Create a free Sacari Golf account and play ranked golf in your browser.', active: '', authed: false, bare: true, bodyClass: 'login-body', noindex: true, body });
}

function renderVerifyEmail({ error, email }) {
  const body = `
  <div class="login-wrap">
    <aside class="login-brand">
      <a href="/" class="login-logo-link"><img class="login-logo" src="/logo.jpg?v=${ASSET_V}" alt="Sacari Golf" /></a>
      <h2 class="login-tag">One quick step.</h2>
      <p class="login-sub">We emailed you a 6-digit code${email ? ` at ${esc(email)}` : ''}. Enter it to confirm your account.</p>
    </aside>
    <section class="login-panel">
      <div class="login-card">
        <h1>Verify your email</h1>
        <p class="login-card-sub">Check your inbox for the code.</p>
        ${error ? `<div class="form-error">${esc(error)}</div>` : ''}
        <form method="post" action="/verify-email" class="form">
          <label class="field">
            <span class="field-label">6-digit code</span>
            <span class="input-wrap"><span class="input-icon">#</span><input type="text" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" autocomplete="one-time-code" required /></span>
          </label>
          <button class="login-btn" type="submit">Verify &amp; continue</button>
        </form>
        <form method="post" action="/resend-verification"><button class="link-btn" type="submit">Resend code</button></form>
        <a class="login-home" href="/app">Skip for now &rarr;</a>
      </div>
    </section>
  </div>`;
  return page({ title: 'Verify email. Sacari Golf', description: 'Verify your Sacari Golf account.', active: '', authed: true, bare: true, bodyClass: 'login-body', noindex: true, body });
}

// ----- Web app: play loop ---------------------------------------------------
function appMatchRow(m, meId) {
  const opp = (m.players || []).find((p) => p.user_id !== meId);
  const mine = (m.players || []).find((p) => p.user_id === meId);
  const fmt = fmtFormat(m.format);
  let status, cls;
  if (m.completed) {
    const tied = !m.result || m.result.winner_side == null;
    const won = !tied && mine && m.result && Number(mine.side) === Number(m.result.winner_side);
    cls = tied ? 'tie' : won ? 'win' : 'loss';
    status = tied ? 'Tied' : won ? 'Won' : 'Lost';
    const dl = m.my_delta_elo;
    if (typeof dl === 'number' && dl !== 0) status += ` ${dl > 0 ? '+' : ''}${dl}`;
  } else if (mine && mine.completed) {
    cls = 'pending'; status = 'Waiting';
  } else {
    cls = 'active'; status = 'Play now';
  }
  const title = m.is_practice ? 'Practice round' : (opp ? `vs ${esc(opp.username)}` : 'Ranked round');
  return `<a class="app-row" href="/app/match/${esc(m.match_id)}">
    <span class="app-row-main">
      <span class="app-row-title">${title}</span>
      <span class="app-row-sub">${esc(fmt)} · ${esc(m.num_holes || 18)} holes · ${esc(fmtAgo(m.created_at))}</span>
    </span>
    <span class="app-status ${cls}">${esc(status)}</span>
  </a>`;
}
function renderAppHome({ me, rank, matches }) {
  const rankLine = rank.isObsidian ? `Obsidian ${rank.displayElo}` : rank.label;
  const meId = me.user_id;
  const active = (matches || []).filter((m) => !m.completed);
  const done = (matches || []).filter((m) => m.completed);
  const verifyBanner = me.email_verified === false
    ? `<a class="app-banner" href="/verify-email">Verify your email to secure your account. Enter your code &rarr;</a>` : '';
  const list = (arr) => arr.map((m) => appMatchRow(m, meId)).join('');
  const body = `
  ${verifyBanner}
  <section class="app-hero">
    <div class="app-hero-id">
      <img class="app-hero-crest" src="/crests/${esc(rank.tier.key)}.png" alt="" />
      <div>
        <div class="app-hello">Hey, ${esc(me.username)}</div>
        <div class="app-rank" style="color:${esc(rank.color)}">${esc(rankLine)} · ${esc(me.elo)} SR</div>
      </div>
    </div>
    <a class="cta app-play-cta" href="/app/play">Play a round</a>
  </section>
  ${active.length
    ? `<section class="app-sec"><h2>Your matches</h2><div class="app-list">${list(active)}</div></section>`
    : `<section class="app-sec"><div class="empty">No active rounds. Start one above.</div></section>`}
  ${done.length ? `<section class="app-sec"><h2>Recent results</h2><div class="app-list">${list(done.slice(0, 12))}</div></section>` : ''}`;
  return page({ title: 'Home · Sacari Golf', description: 'Your Sacari Golf web app.', active: 'apphome', authed: true, noindex: true, body });
}
function renderAppPlay() {
  const body = `
  <section class="page-head">
    <a class="recaps-back" href="/app">&larr; Home</a>
    <h1>Play a round</h1>
    <p>Start a ranked round (or practice). Pick your course and tees, then score it hole by hole.</p>
  </section>
  <section class="app-form" data-page="play">
    <div class="af-group">
      <span class="af-label">Mode</span>
      <div class="af-seg" id="play-mode">
        <button type="button" data-val="solo" class="on">Ranked</button>
        <button type="button" data-val="practice">Practice</button>
      </div>
    </div>
    <div class="af-group">
      <span class="af-label">Holes</span>
      <div class="af-seg" id="play-holes">
        <button type="button" data-val="18" class="on">18</button>
        <button type="button" data-val="front9">Front 9</button>
        <button type="button" data-val="back9">Back 9</button>
      </div>
    </div>
    <div class="af-group">
      <span class="af-label">Course</span>
      <div class="course-search-wrap">
        <input type="text" id="play-course-q" placeholder="Search course or city..." autocomplete="off" />
        <div class="ac-list" id="play-course-ac" hidden></div>
      </div>
      <div id="play-course-picked" class="af-picked" hidden></div>
    </div>
    <div class="af-group" id="play-tee-group" hidden>
      <span class="af-label">Tees</span>
      <select id="play-tee" class="af-select"></select>
    </div>
    <div id="play-msg" class="app-msg"></div>
    <button id="play-create" class="cta" type="button" disabled>Create round</button>
  </section>
  <script src="/app.js?v=${ASSET_V}" defer></script>`;
  return page({ title: 'Play · Sacari Golf', description: 'Start a ranked round on Sacari Golf.', active: 'play', authed: true, noindex: true, body });
}
function renderAppMatch({ me, match }) {
  const meId = me.user_id;
  const mine = (match.players || []).find((p) => p.user_id === meId);
  const opp = (match.players || []).find((p) => p.user_id !== meId);
  const fmt = fmtFormat(match.format);
  let panel;
  if (match.completed) {
    const tied = !match.result || match.result.winner_side == null;
    const won = !tied && mine && match.result && Number(mine.side) === Number(match.result.winner_side);
    const dl = match.my_delta_elo;
    const cls = tied ? 'tie' : won ? 'win' : 'loss';
    panel = `<div class="app-result ${cls}">
      <div class="app-result-big">${tied ? 'Tied' : won ? 'You won' : 'You lost'}</div>
      ${typeof dl === 'number' && dl !== 0 ? `<div class="app-result-elo ${dl > 0 ? 'up' : 'down'}">${dl > 0 ? '+' : ''}${dl} SR</div>` : ''}
      <a class="cta" href="/r/${esc(match.match_id)}">View full recap</a>
    </div>`;
  } else if (mine && mine.completed) {
    panel = `<div class="app-result pending">
      <div class="app-result-big">Round submitted</div>
      <p class="muted-note">Waiting for your opponent to finish. We settle the SR once they are in.</p>
    </div>`;
  } else {
    panel = `<div class="app-result active">
      <div class="app-result-big">Ready to play</div>
      <p class="muted-note">${match.is_practice ? 'Practice rounds do not affect your rank.' : 'This is a ranked round.'} Enter your scores hole by hole.</p>
      <a class="cta" href="/app/score/${esc(match.match_id)}">Score round</a>
    </div>`;
  }
  const players = (match.players || []).map((p) => {
    const isMe = p.user_id === meId;
    return `<div class="app-player">
      <span class="app-player-name">${isMe ? 'You' : esc(p.username || 'Opponent')}</span>
      ${p.strokes != null ? `<span class="app-player-score">${esc(p.strokes)}</span>` : `<span class="app-player-score muted">${p.completed ? 'in' : '—'}</span>`}
    </div>`;
  }).join('');
  const body = `
  <section class="page-head">
    <a class="recaps-back" href="/app">&larr; Home</a>
    <h1>${match.is_practice ? 'Practice round' : (opp ? `vs ${esc(opp.username)}` : 'Ranked round')}</h1>
    <p>${esc(fmt)} · ${esc(match.num_holes || 18)} holes</p>
  </section>
  <section class="app-sec">${panel}</section>
  ${players ? `<section class="app-sec"><h2>Players</h2><div class="app-players">${players}</div></section>` : ''}`;
  return page({ title: 'Match · Sacari Golf', description: 'Match detail.', active: 'apphome', authed: true, noindex: true, body });
}
function renderAppScore({ matchId }) {
  const body = `
  <section class="page-head">
    <a class="recaps-back" href="/app/match/${esc(matchId)}">&larr; Match</a>
    <h1>Scorecard</h1>
    <p>Enter your score for each hole, then submit.</p>
  </section>
  <section class="app-score" data-page="score" data-match="${esc(matchId)}">
    <div id="score-body"><div class="empty">Loading your round...</div></div>
  </section>
  <script src="/app.js?v=${ASSET_V}" defer></script>`;
  return page({ title: 'Scorecard · Sacari Golf', description: 'Enter your scores.', active: 'play', authed: true, noindex: true, body });
}

function renderDashboard({ me, rank, season, stats, ball }) {
  const d = { rank, medallion: medallionFor(rank.tier.key), username: me.username, avatarUrl: me.avatar_url ? BACKEND_URL + me.avatar_url : null };
  const losses = Math.max(0, (me.total_matches || 0) - (me.total_wins || 0) - (me.total_ties || 0));
  const winRate = me.total_matches > 0 ? Math.round((me.total_wins / me.total_matches) * 100) : 0;
  const rankLine = rank.isObsidian ? `Obsidian ${rank.displayElo}` : rank.label;

  let seasonCard = '';
  if (season && season.me && season.me.record) {
    const rec = season.me.record;
    const sl = Math.max(0, (rec.matches || 0) - (rec.wins || 0) - (rec.ties || 0));
    const st = season.me.streak || { current: 0, best: 0 };
    seasonCard = `<div class="dash-card">
      <div class="dash-card-title">This season${season.season ? ' · ' + esc(season.season.name) : ''}</div>
      <div class="stats">
        ${statCell('Record', `${rec.wins || 0}-${sl}-${rec.ties || 0}`)}
        ${statCell('Points', numFmt(rec.points))}
        ${statCell('Streak', String(st.current || 0))}
        ${statCell('Best streak', String(st.best || 0))}
      </div>
    </div>`;
  }

  let perf;
  if (stats && stats.rounds_count > 0) {
    perf = `<div class="dash-card">
      <div class="dash-card-title">Performance · ${stats.rounds_count} rounds, ${stats.holes_played} holes</div>
      <div class="stats">
        ${statCell('GIR', pctFmt(stats.gir_pct))}
        ${statCell('Fairways', pctFmt(stats.fw_hit_pct))}
        ${statCell('Putts/Rd', numFmt(stats.avg_putts_per_round))}
        ${statCell('3-putts', numFmt(stats.three_putt_count))}
        ${statCell('Up &amp; Down', pctFmt(stats.up_and_down_pct))}
        ${statCell('Avg/Hole', numFmt(stats.avg_strokes_per_hole))}
      </div>
    </div>
    ${stats.sg_per_round ? `<div class="dash-card">
      <div class="dash-card-title">Strokes gained per round</div>
      <div class="stats">
        ${statCell('Off tee', sgFmt(stats.sg_per_round.off_tee))}
        ${statCell('Approach', sgFmt(stats.sg_per_round.approach))}
        ${statCell('Around grn', sgFmt(stats.sg_per_round.around_green))}
        ${statCell('Putting', sgFmt(stats.sg_per_round.putting))}
        ${statCell('Total', sgFmt(stats.sg_per_round.total))}
      </div>
    </div>` : ''}`;
  } else {
    perf = `<div class="dash-card"><div class="dash-card-title">Performance</div><p class="muted-note">No tracked rounds yet. Play and track a round in the app and your stats show up here.</p></div>`;
  }

  const ballCard = ball ? `<div class="dash-card">
      <div class="dash-card-title">Ball count</div>
      <div class="stats">
        ${statCell('Found', numFmt(ball.found))}
        ${statCell('Lost', numFmt(ball.lost))}
        ${statCell('Net', `${ball.net > 0 ? '+' : ''}${ball.net}`)}
      </div>
    </div>` : '';

  const body = `
  <section class="dash">
    <div class="dash-head">
      ${crestBlock(d)}
      <div class="dash-id">
        <h1 class="name">${esc(me.username)}</h1>
        <div class="rank" style="color:${esc(rank.color)}">${esc(rankLine)}</div>
        <div class="dash-actions">
          <a class="cta-ghost" href="/u/${encodeURIComponent(me.username)}">Public profile</a>
          <a class="cta-ghost" href="/account/clubs">Club stats</a>
        </div>
      </div>
    </div>
    <div class="stats">
      ${statCell('Lifetime', `${me.total_wins || 0}-${losses}-${me.total_ties || 0}`)}
      ${statCell('Win rate', `${winRate}%`)}
      ${statCell('Handicap', fmtHandicap(me.handicap_index))}
      ${statCell('Since', fmtDate(me.created_at))}
    </div>
    ${seasonCard}
    ${perf}
    ${ballCard}
  </section>`;

  return page({ title: `${me.username} · My Account. Sacari Golf`, description: 'Your Sacari Golf stats.', active: 'account', authed: true, noindex: true, body });
}

function renderClubs({ sg, clubs }) {
  const sgBlock = sg && sg.sg_per_round ? `<div class="dash-card">
      <div class="dash-card-title">Strokes gained (advanced) · ${sg.rounds_used} rounds, ${sg.shots_used} shots</div>
      <div class="stats">
        ${statCell('Off tee', sgFmt(sg.sg_per_round.off_tee))}
        ${statCell('Approach', sgFmt(sg.sg_per_round.approach))}
        ${statCell('Around grn', sgFmt(sg.sg_per_round.around_green))}
        ${statCell('Putting', sgFmt(sg.sg_per_round.putting))}
        ${statCell('Total', sgFmt(sg.sg_per_round.total))}
      </div>
    </div>` : '';

  const rows = (clubs || []).map((c) => {
    const disp = Array.isArray(c.dispersion) ? c.dispersion : [];
    let tendency = 'NR';
    if (disp.length) {
      const lat = disp.reduce((a, b) => a + (b.lateral_yds || 0), 0) / disp.length;
      const r = Math.round(lat);
      tendency = Math.abs(r) < 1 ? 'Straight' : `${Math.abs(r)} yd ${r > 0 ? 'R' : 'L'}`;
    }
    return `<tr>
      <td>${esc(clubLabel(c.club))}</td>
      <td>${numFmt(c.shots)}</td>
      <td>${numFmt(c.median_yds)}</td>
      <td>${numFmt(c.avg_yds)}</td>
      <td>${esc(tendency)}</td>
    </tr>`;
  }).join('');

  const body = `
  <section class="page-head">
    <h1>Club stats</h1>
    <p>Distances and shot tendencies from every shot you have tracked.</p>
    <a class="cta-ghost" href="/account">Back to account</a>
  </section>
  <section class="tees">
    ${sgBlock}
    ${rows
      ? `<table class="tee-table"><thead><tr><th>Club</th><th>Shots</th><th>Median</th><th>Avg</th><th>Tendency</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No tracked shots yet. Track shots in the app to build your club profile.</div>'}
  </section>`;

  return page({ title: 'Club stats. Sacari Golf', description: 'Your club distances and dispersion.', active: 'account', authed: true, noindex: true, body });
}

function renderCoursePins({ course, holes }) {
  const lat = course.latitude != null ? Number(course.latitude) : null;
  const lng = course.longitude != null ? Number(course.longitude) : null;
  let center = (lat != null && lng != null) ? [lat, lng] : null;
  if (!center) {
    const wp = (holes || []).find((h) => h.pin_lat != null && h.pin_lng != null);
    if (wp) center = [Number(wp.pin_lat), Number(wp.pin_lng)];
  }
  const loc = [course.city, course.state].filter(Boolean).join(', ');
  const data = {
    postUrl: `/course/${course.course_id}/pins`,
    center,
    holes: (holes || []).map((h) => ({
      n: h.hole_num, par: h.par,
      lat: h.pin_lat != null ? Number(h.pin_lat) : null,
      lng: h.pin_lng != null ? Number(h.pin_lng) : null,
    })),
  };
  const holeBtns = (holes || []).map((h) =>
    `<button type="button" class="hole-btn${h.pin_lat != null ? ' has-pin' : ''}" data-n="${h.hole_num}">
      <span class="hole-n">${esc(h.hole_num)}</span><span class="hole-par">Par ${h.par != null ? esc(h.par) : '-'}</span>
    </button>`).join('');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const body = `
  <section class="page-head">
    <h1>Place pin locations</h1>
    <p>${esc(course.course_name)}${loc ? ' · ' + esc(loc) : ''}</p>
    <a class="cta-ghost" href="/course/${esc(course.course_id)}">Back to course</a>
  </section>
  <section class="pins">
    <ol class="pin-steps">
      <li>Pick a hole below.</li>
      <li>Zoom into the green and click the cup location on the satellite map. You can drag the pin to fine-tune.</li>
      <li>Press Save. Accurate pins give everyone better distances.</li>
    </ol>
    ${(holes && holes.length) ? `
    <div class="hole-grid">${holeBtns}</div>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
    <div id="map" class="pin-map"></div>
    <div class="pin-bar">
      <div id="pin-info" class="pin-info">Select a hole to begin.</div>
      <button id="pin-save" class="cta" disabled>Save pin</button>
    </div>
    <div id="pin-msg" class="pin-msg"></div>
    <script>window.PIN_DATA = ${json};</script>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
    <script src="/pins.js?v=${ASSET_V}" defer></script>
    ` : '<div class="empty">This course has no hole data yet.</div>'}
  </section>`;

  return page({ title: `Place pins · ${course.course_name}. Sacari Golf`, description: 'Add crowd-sourced pin locations on Sacari Golf.', active: 'courses', authed: true, noindex: true, body });
}

// ----- Invite landing -------------------------------------------------------
/**
 * Public referral landing. Tapping a /invite/<code> link sent by an existing
 * user lands here. We render the inviter's name + the code prominently with
 * tap-to-copy + an App Store button, so the recipient can install the app,
 * sign up, and paste the code in the "Referral code (optional)" field.
 *
 * OG tags carry the inviter's name so the link preview in iMessage / SMS /
 * Slack reads "Richard invited you to Sacari Golf" instead of a generic title.
 */
function renderInvite({ inviter, code, appStoreUrl, siteUrl }) {
  const safeCode = esc(code);
  const safeName = esc(inviter || 'A friend');
  const shareUrl = siteUrl ? `${siteUrl}/invite/${safeCode}` : '';
  const body = `<style>
    .invite-card { text-align: center; max-width: 540px; margin: 32px auto; }
    .invite-code-box {
      background: rgba(212, 169, 63, 0.07);
      border: 2px solid var(--gold, #d4a93f);
      border-radius: 12px;
      padding: 26px 16px 22px;
      margin: 28px auto 22px;
      max-width: 360px;
    }
    .invite-code-label { color: var(--text-muted, #999); font-size: 11px; font-weight: 800; letter-spacing: 2px; }
    .invite-code {
      font-family: serif;
      color: var(--gold, #d4a93f);
      font-size: 42px;
      font-weight: 900;
      letter-spacing: 6px;
      margin-top: 6px;
    }
    .invite-copy-btn {
      margin-top: 14px;
      background: var(--gold, #d4a93f);
      color: var(--bg, #0a0a0a);
      border: none;
      border-radius: 8px;
      padding: 10px 22px;
      font-weight: 900;
      font-size: 13px;
      letter-spacing: 0.5px;
      cursor: pointer;
    }
    .invite-fineprint { font-size: 13px; color: var(--text-muted, #999); margin-top: 18px; }
  </style>
  <section class="card landing invite-card">
    <h1 class="hero-small">${safeName} invited you to Sacari Golf</h1>
    <p class="lead">Ranked rounds, SR ladder, satellite shot-tracking. Tap below to install, then enter the code on the sign-up screen.</p>

    <div class="invite-code-box" data-code="${safeCode}">
      <div class="invite-code-label">YOUR INVITE CODE</div>
      <div class="invite-code">${safeCode}</div>
      <button type="button" class="invite-copy-btn" id="invite-copy">Tap to copy</button>
    </div>

    ${appStoreUrl ? `<a class="cta" href="${esc(appStoreUrl)}">Download on the App Store</a>` : ''}
    <p class="lead invite-fineprint">No account yet? Install Sacari, open Sign Up, paste the code in the "Referral code (optional)" field. ${safeName} earns a Lucky Round perk in their next ranked match.</p>
  </section>
  <script>
    (function(){
      var btn = document.getElementById('invite-copy');
      var box = btn && btn.closest('.invite-code-box');
      if (!btn || !box) return;
      btn.addEventListener('click', function(){
        var code = box.getAttribute('data-code') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function(){
            btn.textContent = 'Copied · ' + code;
            setTimeout(function(){ btn.textContent = 'Tap to copy'; }, 2200);
          }).catch(function(){
            btn.textContent = code;
          });
        } else {
          btn.textContent = code;
        }
      });
    })();
  </script>`;
  return page({
    title: `${safeName} invited you. Sacari Golf`,
    description: `Join Sacari Golf with invite code ${safeCode}. ${safeName} earns a Lucky Round perk when you sign up.`,
    ogUrl: shareUrl,
    // Personalized share landing, one per referral code: great link preview,
    // not search-index material.
    noindex: true,
    active: '',
    body,
  });
}

// Standalone 3D hole renderer for the mobile app's WebView. Served over https
// so Mapbox GL JS gets a REAL origin (an inline HTML string in a WebView has no
// origin, so Mapbox's workers never start and the map hangs). The app injects
// window.__CFG__ (token, style, shots, bounds, bearing, pin) via
// injectedJavaScriptBeforeContentLoaded before this page's script runs. No
// server-side data and no token here; it's a dumb renderer.
function render3dEmbed() {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link href="https://cdn.jsdelivr.net/npm/mapbox-gl@2/dist/mapbox-gl.css" rel="stylesheet" />
<style>
  html,body{margin:0;height:100%;width:100%;background:#0b0e14;overflow:hidden}
  #map{position:absolute;inset:0}
  .mapboxgl-canvas{width:100%!important;height:100%!important}
  #status{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:#cfd3c8;font:600 14px -apple-system,Segoe UI,Roboto,sans-serif;padding:0 26px;line-height:1.5;z-index:5}
</style>
</head><body>
<div id="map"></div>
<div id="status">Loading 3D course…</div>
<script>
function post(o){try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function setStatus(t,err){var s=document.getElementById('status');if(!s)return;if(t===null){s.style.display='none';return;}s.style.display='block';s.textContent=t;s.style.color=err?'#ff9a9a':'#cfd3c8';}
function hx(h){h=(h||'#f0c95a').replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function load(src){return new Promise(function(res,rej){var el=document.createElement('script');el.src=src;el.crossOrigin='anonymous';el.onload=function(){res();};el.onerror=function(){rej(new Error('load failed: '+src));};document.head.appendChild(el);});}
window.onerror=function(m){post({type:'error',msg:'js: '+m});};
window.addEventListener('unhandledrejection',function(ev){post({type:'error',msg:'reject: '+(ev&&ev.reason&&(ev.reason.message||ev.reason))});});
(function(){
  var C=window.__CFG__||{};
  post({type:'info',msg:'cfg token='+(C.token?('yes('+C.token.length+')'):'NO')+' shots='+((C.shots&&C.shots.length)||0)+' bounds='+(C.bounds?'yes':'no')});
  if(!C.token){setStatus('No Mapbox token was provided to the map.',true);post({type:'error',msg:'no token'});return;}
  var cv=document.createElement('canvas');
  if(!(cv.getContext('webgl2')||cv.getContext('webgl'))){setStatus('This device WebView has no WebGL.',true);post({type:'error',msg:'no webgl'});return;}
  setStatus('Loading map engine…');
  load('https://cdn.jsdelivr.net/npm/mapbox-gl@2/dist/mapbox-gl.js')
    .then(function(){return load('https://cdn.jsdelivr.net/npm/deck.gl@9/dist.min.js').catch(function(){post({type:'warn',msg:'deck load failed (arcs off)'});});})
    .then(function(){
      if(!window.mapboxgl){throw new Error('mapbox-gl missing after load');}
      post({type:'info',msg:'mapbox-gl v'+(mapboxgl.version||'?')});
      setStatus('Starting map…');
      mapboxgl.accessToken=C.token;
      var opts={container:'map',style:C.style||'mapbox://styles/mapbox/satellite-streets-v12',antialias:true,attributionControl:false};
      if(C.bounds){opts.bounds=C.bounds;opts.fitBoundsOptions={padding:55};}else{opts.center=[0,0];opts.zoom=1;}
      var map=new mapboxgl.Map(opts);
      post({type:'info',msg:'map created'});
      map.on('styledata',function(){post({type:'info',msg:'styledata'});});
      var wd=setTimeout(function(){setStatus('Map did not finish loading (check network or token).',true);post({type:'error',msg:'load timeout (see events above)'});},16000);
      map.on('idle',function(){setStatus(null);});
      map.on('load',function(){
        clearTimeout(wd);
        post({type:'info',msg:'load fired'});
        try{map.addSource('dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1',tileSize:512,maxzoom:14});map.setTerrain({source:'dem',exaggeration:1.3});map.setFog({'color':'rgb(186,180,160)','horizon-blend':0.18,'high-color':'rgb(76,98,120)','space-color':'rgb(16,20,28)','star-intensity':0});}catch(e){}
        try{map.easeTo({pitch:66,bearing:C.bearing||0,duration:0});}catch(e){}
        try{
          if(window.deck&&deck.MapboxOverlay&&C.shots&&C.shots.length){
            var arcs=new deck.ArcLayer({id:'arcs',data:C.shots,getSourcePosition:function(d){return [d.start.lng,d.start.lat];},getTargetPosition:function(d){return [d.end.lng,d.end.lat];},getSourceColor:function(d){return hx(d.color).concat([240]);},getTargetColor:function(){return [255,255,255,240];},getWidth:4,getHeight:0.5});
            var dots=new deck.ScatterplotLayer({id:'dots',data:C.shots,getPosition:function(d){return [d.start.lng,d.start.lat];},getFillColor:function(d){return hx(d.color).concat([255]);},radiusUnits:'pixels',getRadius:4,stroked:true,getLineColor:[255,255,255,255],lineWidthMinPixels:1.5});
            map.addControl(new deck.MapboxOverlay({layers:[arcs,dots]}));
          }
        }catch(e){post({type:'warn',msg:'arcs failed: '+(e&&e.message)});}
        if(C.pin){try{var pole=document.createElement('div');pole.style.cssText='position:absolute;left:0;bottom:0;width:2px;height:22px;background:#eee';var fl=document.createElement('div');fl.style.cssText='position:absolute;left:2px;top:0;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:11px solid #e8772f';var w=document.createElement('div');w.style.cssText='position:relative;width:13px;height:22px';w.appendChild(pole);w.appendChild(fl);new mapboxgl.Marker({element:w,anchor:'bottom'}).setLngLat([C.pin.lng,C.pin.lat]).addTo(map);}catch(e){}}
        setStatus(null);
        post({type:'ready'});
      });
      map.on('error',function(e){var er=(e&&e.error)||{};post({type:'error',msg:'maperr status='+(er.status||'?')+' '+(er.message||'')+(er.url?(' url='+er.url):'')});setStatus('Map error: '+(er.message||er.status||'unknown'),true);});
    })
    .catch(function(err){setStatus('Could not load the 3D map engine. ('+(err&&err.message||err)+')',true);post({type:'error',msg:String(err&&err.message||err)});});
})();
</script></body></html>`;
}

module.exports = {
  render3dEmbed,
  renderHome, renderHowTo, renderLeaderboard, renderMatchesFeed, renderCoursesIndex, renderCourse,
  renderRecap, renderProfile, renderUserRecaps, renderStatic, renderNotFound, esc,
  renderLogin, renderSignup, renderVerifyEmail,
  renderAppHome, renderAppPlay, renderAppMatch, renderAppScore,
  renderDashboard, renderClubs, renderCoursePins,
  renderInvite,
};
