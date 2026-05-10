// Sacari Golf — End-to-end flow simulator.
// Runs against any reachable API (defaults to localhost). Each test prints
// per-step status and collects bugs into a final report. Exits nonzero if any
// bug was logged so this can plug into CI without extra wiring.
//
//   USAGE:
//     node test_sim.js                      # localhost:3000
//     BASE=https://your-api node test_sim.js
//     ONLY=auth,matches node test_sim.js   # subset of suites
//
// The runner avoids any clever frameworks on purpose — every assertion is a
// plain function call so failures are easy to read in raw stdout.

const BASE = process.env.BASE || 'http://localhost:3000';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
const ADMIN_TOKEN = process.env.PREMIUM_ADMIN_TOKEN || ''; // optional — enables admin-gate tests

const bugs = [];
const log  = (msg) => console.log(`     ${msg}`);
const ok   = (msg) => console.log(`   ✅ ${msg}`);
const bug  = (msg) => { bugs.push(msg); console.error(`   ❌ BUG: ${msg}`); };
const head = (msg) => console.log(`\n──── ${msg} ────`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tiny HTTP wrapper ────────────────────────────────────────────────────────

async function req(method, path, body, token, extraHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* unparseable */ }
  } else {
    data = { _raw: await res.text() };
  }
  return { status: res.status, data };
}

// Random suffix so re-runs don't collide on UNIQUE(email/username).
const RUN = Math.random().toString(36).slice(2, 8);
const NS = (s) => `${s}_${RUN}`;

// ─── Domain helpers ───────────────────────────────────────────────────────────

async function register(name) {
  const username = NS(name);
  const email = `${username}@sim.test`;
  const r = await req('POST', '/auth/register', { username, email, password: 'testpass123' });
  if (r.status !== 201) { bug(`register ${name}: ${r.data?.error}`); return null; }
  return { token: r.data.token, user: r.data.user, username, email };
}

async function login(email, password = 'testpass123') {
  const r = await req('POST', '/auth/login', { email, password });
  return r.status === 200 ? r.data : null;
}

async function getMe(token) {
  return (await req('GET', '/users/me', null, token)).data;
}

async function getUser(token, userId) {
  return (await req('GET', `/users/${userId}`, null, token)).data;
}

async function searchCourse(token, q) {
  const r = await req('GET', `/courses/search?q=${encodeURIComponent(q)}`, null, token);
  return Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
}

async function getCourse(token, id) {
  return (await req('GET', `/courses/${id}`, null, token)).data;
}

// Resolve a usable {course, teebox, holes, pars} triple. Tries the supplied
// course name first, then walks a fallback list so the suite still runs in
// dev DBs that don't have your live seed data.
async function pickCourse(token, preferredName, opts = {}) {
  const candidates = [preferredName, 'Clarkson', 'Camroden', 'Massena', 'Higley', 'Pebble'].filter(Boolean);
  for (const name of candidates) {
    const c = await searchCourse(token, name);
    if (!c) continue;
    const full = await getCourse(token, c.course_id);
    if (!full?.teeboxes?.length) continue;
    // Prefer 18-hole teeboxes by default; opts.preferNineHole flips this.
    const desired = opts.preferNineHole ? 9 : 18;
    const tb = full.teeboxes.find((t) => t.num_holes === desired) || full.teeboxes[0];
    if (!tb?.holes?.length) continue;
    const holes = [...tb.holes].sort((a, b) => a.hole_num - b.hole_num);
    return { course: full, teebox: tb, holes, pars: holes.map((h) => h.par) };
  }
  return null;
}

async function createMatch(token, body) {
  const r = await req('POST', '/matches', body, token);
  if (r.status !== 201) { bug(`createMatch ${body.matchType}: ${r.data?.error}`); return null; }
  return r.data;
}

async function joinMatch(token, matchId, teeboxId) {
  const r = await req('POST', `/matches/${matchId}/join`, { teeboxId }, token);
  if (r.status !== 200) { bug(`joinMatch: ${r.data?.error}`); return null; }
  return r.data;
}

async function submitScores(token, matchId, holeScores, courseId, teeboxId) {
  const r = await req('POST', `/matches/${matchId}/scores`, { holeScores, courseId, teeboxId }, token);
  if (r.status !== 200) { bug(`submitScores: ${r.data?.error}`); return null; }
  return r.data;
}

async function getMatch(token, matchId) {
  return (await req('GET', `/matches/${matchId}`, null, token)).data;
}

function genScores(pars, skill = 0) {
  // skill < 0 = better. Bound to ≥1.
  return pars.map((p) => Math.max(1, p + skill + Math.floor(Math.random() * 3) - 1));
}

function shouldRun(name) { return !ONLY || ONLY.has(name); }

// ─── 1. Auth suite ────────────────────────────────────────────────────────────

async function suiteAuth() {
  if (!shouldRun('auth')) return null;
  head('AUTH');

  // Duplicate-email rejection
  const a = await register('AuthUser');
  if (!a) return null;
  ok(`registered ${a.username}`);

  const dup = await req('POST', '/auth/register', { username: NS('AuthOther'), email: a.email, password: 'x' });
  if (dup.status === 201) bug('duplicate email allowed');
  else ok('duplicate email rejected');

  // Login round-trip
  const li = await login(a.email);
  if (!li?.token) bug('login failed for fresh user');
  else ok('login round-trip works');

  // Wrong password rejected
  const bad = await req('POST', '/auth/login', { email: a.email, password: 'wrong' });
  if (bad.status === 200) bug('wrong password accepted');
  else ok('wrong password rejected');

  // /users/me returns the new fields we expect
  const me = await getMe(a.token);
  for (const f of ['user_id', 'username', 'email', 'elo', 'total_matches', 'total_wins']) {
    if (me[f] === undefined) bug(`/users/me missing field ${f}`);
  }
  if (me.total_ties === undefined) bug('/users/me missing total_ties');
  if (me.is_premium === undefined) bug('/users/me missing is_premium');
  ok('/users/me returns expected shape');

  // Forgot-password should always look successful (no user enumeration)
  const fp = await req('POST', '/auth/forgot', { email: a.email });
  if (fp.status !== 200) bug(`forgot returned ${fp.status}`);
  else ok('forgot endpoint accepts known email');
  const fpUnknown = await req('POST', '/auth/forgot', { email: 'noone@example.invalid' });
  if (fpUnknown.status !== 200) bug('forgot leaks user existence (non-200 for unknown email)');
  else ok('forgot endpoint hides unknown email');

  return a;
}

// ─── 2. Course discovery ──────────────────────────────────────────────────────

async function suiteCourses(token) {
  if (!shouldRun('courses')) return;
  head('COURSES');

  // Search must return something for at least one of these terms
  const queries = ['Clarkson', 'Camroden', 'Massena', 'Higley'];
  let foundAny = false;
  for (const q of queries) {
    const r = await req('GET', `/courses/search?q=${encodeURIComponent(q)}`, null, token);
    if (Array.isArray(r.data) && r.data.length > 0) {
      foundAny = true;
      ok(`search "${q}" → ${r.data[0].course_name}`);
    } else {
      log(`search "${q}" empty (ok if not seeded)`);
    }
  }
  if (!foundAny) bug('no course searches returned anything — check your seed data');

  // Course-detail expansion
  const found = await pickCourse(token);
  if (!found) { bug('cannot find any usable course'); return; }
  const { course, teebox, holes } = found;
  ok(`got ${course.course_name} / ${teebox.name} / ${holes.length} holes`);
  if (typeof teebox.course_rating !== 'number') bug('teebox missing course_rating');
  if (typeof teebox.slope_rating !== 'number') bug('teebox missing slope_rating');
}

// ─── 3. Match flows (solo win, tie, forfeit, cancel) ──────────────────────────

async function suiteMatchSoloWin() {
  if (!shouldRun('matches')) return;
  head('SOLO MATCH — clear winner');

  const p1 = await register('SoloWinA');
  const p2 = await register('SoloWinB');
  if (!p1 || !p2) return;

  const found = await pickCourse(p1.token);
  if (!found) return;
  const { course, teebox, pars } = found;

  const match = await createMatch(p1.token, { matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: 18 });
  if (!match) return;
  if (match.match_type !== 'solo') bug('match_type mismatch');
  if (match.num_holes !== 18) bug(`expected num_holes=18, got ${match.num_holes}`);
  ok(`match created (${match.match_id.slice(0, 8)})`);

  await joinMatch(p2.token, match.match_id, teebox.teebox_id);
  ok('p2 joined');

  const beforeP1 = await getMe(p1.token);
  const beforeP2 = await getMe(p2.token);

  // p1 well over par, p2 well under — outcome is determined.
  const p1Scores = genScores(pars, +3);
  const p2Scores = genScores(pars, -2);

  const r1 = await submitScores(p1.token, match.match_id, p1Scores, course.course_id, teebox.teebox_id);
  if (r1?.result) bug('match resolved with only one submission');
  else ok('first submit waits for opponent');

  const r2 = await submitScores(p2.token, match.match_id, p2Scores, course.course_id, teebox.teebox_id);
  if (!r2?.result) { bug('match did not resolve after both submits'); return; }
  ok(`resolved — winner side ${r2.result.winnerSide}, |Δ ELO| ${r2.result.deltaElo}`);

  if (r2.result.winnerSide !== 2) bug(`expected side 2 to win (lower scores), got ${r2.result.winnerSide}`);
  if (r2.result.tied) bug('non-tie incorrectly flagged tied');

  // Conservation: ELO sums to 0 across both sides
  const afterP1 = await getMe(p1.token);
  const afterP2 = await getMe(p2.token);
  const dP1 = afterP1.elo - beforeP1.elo;
  const dP2 = afterP2.elo - beforeP2.elo;
  if (dP1 + dP2 !== 0) bug(`ELO not conserved (${dP1} + ${dP2} ≠ 0)`);
  else ok(`ELO conserved (${dP1 >= 0 ? '+' : ''}${dP1} / ${dP2 >= 0 ? '+' : ''}${dP2})`);

  if (afterP2.total_wins !== beforeP2.total_wins + 1) bug('winner total_wins not incremented');
  if (afterP1.total_wins !== beforeP1.total_wins) bug('loser total_wins incorrectly incremented');

  // Match shows in /matches list and exposes my_delta_elo
  const list = await req('GET', '/matches', null, p1.token);
  const mine = list.data.find((m) => m.match_id === match.match_id);
  if (!mine) bug('completed match not in /matches list');
  else if (typeof mine.my_delta_elo !== 'number') bug('my_delta_elo missing on list row');
  else if (mine.my_delta_elo >= 0) bug(`p1 lost — expected negative my_delta_elo, got ${mine.my_delta_elo}`);
  else ok(`my_delta_elo signed correctly for p1: ${mine.my_delta_elo}`);
}

async function suiteMatchTie() {
  if (!shouldRun('matches')) return;
  head('SOLO MATCH — exact tie (chess ELO)');

  const p1 = await register('TieA');
  const p2 = await register('TieB');
  if (!p1 || !p2) return;

  const found = await pickCourse(p1.token);
  if (!found) return;
  const { course, teebox, pars } = found;

  const match = await createMatch(p1.token, { matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: 18 });
  await joinMatch(p2.token, match.match_id, teebox.teebox_id);

  // Same-tee, identical scores → identical differentials → tie.
  const sameScores = genScores(pars, 0);
  const beforeP1 = await getMe(p1.token);
  const beforeP2 = await getMe(p2.token);
  await submitScores(p1.token, match.match_id, sameScores, course.course_id, teebox.teebox_id);
  const r2 = await submitScores(p2.token, match.match_id, sameScores, course.course_id, teebox.teebox_id);

  if (!r2?.result) { bug('tie did not resolve'); return; }
  if (r2.result.winnerSide !== null) bug(`tie: winnerSide should be null, got ${r2.result.winnerSide}`);
  if (!r2.result.tied) bug('tie: result.tied not true');
  ok(`tie detected — winnerSide=null, tied=true`);

  // Equal-ELO players → tie should give 0 ELO each (chess: K * (0.5 - 0.5) = 0).
  const afterP1 = await getMe(p1.token);
  const afterP2 = await getMe(p2.token);
  const dP1 = afterP1.elo - beforeP1.elo;
  const dP2 = afterP2.elo - beforeP2.elo;
  if (dP1 !== 0 || dP2 !== 0) {
    bug(`equal-ELO tie should be 0/0, got ${dP1}/${dP2}`);
  } else {
    ok('equal-ELO tie → 0 ELO change for both');
  }
  if (afterP1.total_ties !== beforeP1.total_ties + 1) bug('total_ties not incremented for side 1');
  if (afterP2.total_ties !== beforeP2.total_ties + 1) bug('total_ties not incremented for side 2');
  if (afterP1.total_wins !== beforeP1.total_wins) bug('tie incorrectly incremented wins');
}

async function suiteMatchForfeit() {
  if (!shouldRun('matches')) return;
  head('SOLO MATCH — forfeit');

  const p1 = await register('ForfA');
  const p2 = await register('ForfB');
  if (!p1 || !p2) return;
  const found = await pickCourse(p1.token);
  if (!found) return;
  const { teebox } = found;

  const match = await createMatch(p1.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  await joinMatch(p2.token, match.match_id, teebox.teebox_id);

  const beforeP1 = await getMe(p1.token);
  const beforeP2 = await getMe(p2.token);

  const r = await req('POST', `/matches/${match.match_id}/forfeit`, {}, p1.token);
  if (r.status !== 200) bug(`forfeit failed: ${r.data?.error}`);
  else ok('forfeit accepted');

  const final = await getMatch(p1.token, match.match_id);
  if (!final.completed) bug('forfeited match not completed');
  if (final.result?.winner_side !== 2) bug(`forfeit winner should be side 2, got ${final.result?.winner_side}`);

  const afterP1 = await getMe(p1.token);
  const afterP2 = await getMe(p2.token);
  if (afterP1.elo >= beforeP1.elo) bug('forfeiter ELO did not decrease');
  if (afterP2.elo <= beforeP2.elo) bug('opponent ELO did not increase');
  if (afterP2.total_wins !== beforeP2.total_wins + 1) bug('opponent did not get a win');
  ok(`ELO swing: forfeiter ${afterP1.elo - beforeP1.elo}, opponent +${afterP2.elo - beforeP2.elo}`);
}

async function suiteMatchCancel() {
  if (!shouldRun('matches')) return;
  head('SOLO MATCH — cancel (no-score deletion)');

  const p1 = await register('CanclA');
  const p2 = await register('CanclB');
  if (!p1 || !p2) return;
  const found = await pickCourse(p1.token);
  if (!found) return;
  const { teebox } = found;

  // Cancel before any scores → succeeds, no ELO change
  const m1 = await createMatch(p1.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  await joinMatch(p2.token, m1.match_id, teebox.teebox_id);
  const beforeElo = (await getMe(p1.token)).elo;
  const cancel = await req('DELETE', `/matches/${m1.match_id}`, null, p1.token);
  if (cancel.status !== 200) bug(`cancel pre-score failed: ${cancel.data?.error}`);
  else ok('cancel before any scores → 200');
  const afterElo = (await getMe(p1.token)).elo;
  if (afterElo !== beforeElo) bug(`cancel changed ELO (${beforeElo} → ${afterElo})`);

  const gone = await req('GET', `/matches/${m1.match_id}`, null, p1.token);
  if (gone.status === 200 && gone.data?.match_id) bug('cancelled match still fetchable');
  else ok('cancelled match correctly gone');

  // Cancel after a submission → must be rejected (force forfeit instead)
  const m2 = await createMatch(p1.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  await joinMatch(p2.token, m2.match_id, teebox.teebox_id);
  const pars2 = found.pars;
  await submitScores(p1.token, m2.match_id, genScores(pars2, 0), found.course.course_id, teebox.teebox_id);
  const cancel2 = await req('DELETE', `/matches/${m2.match_id}`, null, p1.token);
  if (cancel2.status === 200) bug('cancel after score submission was allowed');
  else ok(`cancel post-score correctly rejected (${cancel2.data?.error})`);
}

async function suiteMatchPractice() {
  if (!shouldRun('matches')) return;
  head('PRACTICE MATCH — no ELO');

  const p1 = await register('PracA');
  if (!p1) return;
  const found = await pickCourse(p1.token);
  if (!found) return;
  const { course, teebox, pars } = found;

  const beforeElo = (await getMe(p1.token)).elo;
  const m = await createMatch(p1.token, {
    matchType: 'practice', isPractice: true, teeboxId: teebox.teebox_id,
  });
  if (!m) return;
  if (!m.is_practice) bug('is_practice flag false on practice match');
  await submitScores(p1.token, m.match_id, genScores(pars, 0), course.course_id, teebox.teebox_id);
  const afterElo = (await getMe(p1.token)).elo;
  if (beforeElo !== afterElo) bug(`practice changed ELO (${beforeElo} → ${afterElo})`);
  else ok('practice round leaves ELO untouched');
}

async function suiteMatchNineHoleSubsets() {
  if (!shouldRun('matches')) return;
  head('NINE-HOLE — front + back subsets');

  const p1 = await register('NineA');
  const p2 = await register('NineB');
  if (!p1 || !p2) return;
  const found = await pickCourse(p1.token);
  if (!found) return;
  const { course, teebox } = found;

  for (const subset of ['front', 'back']) {
    const m = await createMatch(p1.token, {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: 9, holesSubset: subset,
    });
    if (!m) continue;
    if (m.num_holes !== 9) bug(`${subset}-9: num_holes wrong (${m.num_holes})`);
    await joinMatch(p2.token, m.match_id, teebox.teebox_id);

    // Pick the corresponding 9 holes from the teebox
    const offset = subset === 'back' ? 9 : 0;
    const slice = found.pars.slice(offset, offset + 9);
    if (slice.length !== 9) { log(`teebox doesn't have ${subset} 9 set`); continue; }

    await submitScores(p1.token, m.match_id, genScores(slice, 1), course.course_id, teebox.teebox_id);
    const r = await submitScores(p2.token, m.match_id, genScores(slice, -1), course.course_id, teebox.teebox_id);
    if (!r?.result) bug(`${subset}-9 did not resolve`);
    else ok(`${subset}-9 resolved cleanly`);
  }
}

// ─── 4. Friend / challenge / invite flow ──────────────────────────────────────

async function suiteSocialChallenge() {
  if (!shouldRun('social')) return;
  head('FRIENDS + CHALLENGE');

  const a = await register('SocA');
  const b = await register('SocB');
  if (!a || !b) return;

  // Friend request → accept
  let r = await req('POST', '/users/me/friends/request', { friendId: b.user.user_id }, a.token);
  if (r.status !== 200) bug(`friend request: ${r.data?.error}`);
  else ok('friend request sent');

  r = await req('POST', '/users/me/friends/accept', { friendId: a.user.user_id }, b.token);
  if (r.status !== 200) bug(`friend accept: ${r.data?.error}`);
  else ok('friend request accepted');

  const friends = (await req('GET', '/users/me/friends', null, a.token)).data;
  if (!Array.isArray(friends) || !friends.find((f) => f.user_id === b.user.user_id)) {
    bug('friend not in /users/me/friends');
  } else { ok(`friend visible in list (${friends.length} total)`); }

  // Challenge: create a solo match and send an invite to b
  const found = await pickCourse(a.token);
  if (!found) return;
  const m = await createMatch(a.token, {
    matchType: 'solo', teeboxId: found.teebox.teebox_id,
    name: 'Challenge Test',
  });
  if (!m) return;
  const inv = await req('POST', '/invites', { matchId: m.match_id, toUserId: b.user.user_id }, a.token);
  if (inv.status !== 200 && inv.status !== 201) bug(`invite send: ${inv.data?.error}`);
  else ok('invite sent');

  const bsInvites = (await req('GET', '/invites', null, b.token)).data;
  const myInv = Array.isArray(bsInvites) && bsInvites.find((i) => i.match_id === m.match_id);
  if (!myInv) bug('invite not visible to recipient');
  else ok(`invite visible to b (id ${myInv.invite_id?.slice(0, 8)})`);

  if (myInv) {
    const acc = await req('POST', `/invites/${myInv.invite_id}/accept`, null, b.token);
    if (acc.status !== 200) bug(`invite accept: ${acc.data?.error}`);
    else ok('invite accepted');
  }

  // After accept, b should be in the match's player list
  const filled = await getMatch(a.token, m.match_id);
  if (filled.players?.length !== 2) bug(`expected 2 players post-accept, got ${filled.players?.length}`);
  else ok('match now has both players');
}

// ─── 5. Live progress + spectator ─────────────────────────────────────────────

async function suiteLiveProgress() {
  if (!shouldRun('live')) return;
  head('LIVE PROGRESS — active-round + anti-cheat');

  const a = await register('LiveA');
  const b = await register('LiveB');
  const c = await register('LiveC'); // unrelated viewer
  if (!a || !b || !c) return;

  const found = await pickCourse(a.token);
  if (!found) return;
  const { teebox, pars } = found;

  const m = await createMatch(a.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  await joinMatch(b.token, m.match_id, teebox.teebox_id);

  // a sends progress through hole 3
  const partial = pars.slice(0, 3).map((p) => p);
  const prog = await req('POST', `/matches/${m.match_id}/progress`,
    { holeScores: partial, teeboxId: teebox.teebox_id }, a.token);
  if (prog.status !== 200) bug(`progress: ${prog.data?.error}`);
  else ok('progress accepted');

  // c (not in match) can see active-round
  const activeForC = await req('GET', `/users/${a.user.user_id}/active-round`, null, c.token);
  if (!activeForC.data) bug('outside viewer cannot see live round');
  else if (activeForC.data.hole_scores?.length !== 3) bug(`expected 3 hole scores, got ${activeForC.data.hole_scores?.length}`);
  else ok(`outside viewer sees ${activeForC.data.hole_scores.length} holes`);

  // b (in same match) must NOT — anti-cheat
  const activeForB = await req('GET', `/users/${a.user.user_id}/active-round`, null, b.token);
  if (activeForB.data) bug('opponent can see live round (anti-cheat broken!)');
  else ok('opponent correctly blocked from live round');
}

// ─── 6. Round social (reactions + comments) ───────────────────────────────────

async function suiteRoundSocial() {
  if (!shouldRun('social')) return;
  head('ROUND REACTIONS + COMMENTS');

  // Need a completed match to attach reactions to
  const a = await register('RxnA');
  const b = await register('RxnB');
  if (!a || !b) return;
  const found = await pickCourse(a.token);
  if (!found) return;

  const m = await createMatch(a.token, { matchType: 'solo', teeboxId: found.teebox.teebox_id });
  await joinMatch(b.token, m.match_id, found.teebox.teebox_id);
  await submitScores(a.token, m.match_id, genScores(found.pars, 0), found.course.course_id, found.teebox.teebox_id);
  await submitScores(b.token, m.match_id, genScores(found.pars, 0), found.course.course_id, found.teebox.teebox_id);

  // Find a's round_id
  const aRounds = (await getUser(a.token, a.user.user_id))?.recent_rounds ?? [];
  const myRound = aRounds[0];
  if (!myRound?.round_id) { bug('no round_id on recent_rounds'); return; }
  ok(`got round_id ${myRound.round_id.slice(0, 8)}`);

  // b reacts with FIRE
  const rxn = await req('POST', `/rounds/${myRound.round_id}/reactions`, { reaction: 'fire' }, b.token);
  if (rxn.status !== 200) bug(`reaction add: ${rxn.data?.error}`);
  else ok('reaction added');

  // Same call again toggles it off
  const rxn2 = await req('POST', `/rounds/${myRound.round_id}/reactions`, { reaction: 'fire' }, b.token);
  if (rxn2.data?.added !== false) bug('second toggle did not remove');
  else ok('reaction toggle off works');

  // Re-add for the count check
  await req('POST', `/rounds/${myRound.round_id}/reactions`, { reaction: 'fire' }, b.token);

  // Invalid reaction rejected
  const badRxn = await req('POST', `/rounds/${myRound.round_id}/reactions`, { reaction: 'NOT_A_THING' }, b.token);
  if (badRxn.status !== 400) bug('invalid reaction not rejected');
  else ok('invalid reaction rejected');

  // Comment
  const cmt = await req('POST', `/rounds/${myRound.round_id}/comments`, { body: 'Nice round!' }, b.token);
  if (cmt.status !== 200) bug(`comment add: ${cmt.data?.error}`);
  else ok(`comment added (${cmt.data?.comment_id?.slice(0, 8)})`);

  // Empty comment rejected
  const empty = await req('POST', `/rounds/${myRound.round_id}/comments`, { body: '   ' }, b.token);
  if (empty.status !== 400) bug('empty comment accepted');
  else ok('empty comment rejected');

  // Social aggregate endpoint
  const social = (await req('GET', `/rounds/${myRound.round_id}/social`, null, a.token)).data;
  if (!social?.reactions || !social?.comments) bug('/rounds/:id/social shape wrong');
  else if (!social.reactions.find((r) => r.reaction === 'fire' && r.count >= 1)) bug('fire reaction missing from social');
  else if (!social.comments.find((c) => c.body === 'Nice round!')) bug('comment missing from social');
  else ok(`social: ${social.reactions.length} reactions, ${social.comments.length} comments`);

  // Owner can delete own comment, but not others' (b's comment, a tries to delete)
  const aTriesDelete = await req('DELETE', `/rounds/${myRound.round_id}/comments/${cmt.data?.comment_id}`, null, a.token);
  if (aTriesDelete.status === 200) bug('user could delete someone else\'s comment');
  else ok('non-owner cannot delete comment');

  const bDeletes = await req('DELETE', `/rounds/${myRound.round_id}/comments/${cmt.data?.comment_id}`, null, b.token);
  if (bDeletes.status !== 200) bug('owner cannot delete own comment');
  else ok('owner can delete own comment');
}

// ─── 7. Profile data ─────────────────────────────────────────────────────────

async function suiteProfileData() {
  if (!shouldRun('profile')) return;
  head('PROFILE — recent rounds, best round, handicap');

  const a = await register('ProfA');
  const b = await register('ProfB');
  if (!a || !b) return;
  const found = await pickCourse(a.token);
  if (!found) return;
  const { course, teebox, pars } = found;

  // Play 3 rounds so handicap has data
  for (let i = 0; i < 3; i++) {
    const m = await createMatch(a.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
    await joinMatch(b.token, m.match_id, teebox.teebox_id);
    await submitScores(a.token, m.match_id, genScores(pars, i), course.course_id, teebox.teebox_id);
    await submitScores(b.token, m.match_id, genScores(pars, i), course.course_id, teebox.teebox_id);
  }

  const profile = await getUser(a.token, a.user.user_id);
  if (!Array.isArray(profile.recent_rounds) || profile.recent_rounds.length < 3) {
    bug(`expected ≥3 recent rounds, got ${profile.recent_rounds?.length}`);
  } else {
    ok(`recent_rounds populated (${profile.recent_rounds.length})`);
  }
  if (!profile.best_round) bug('best_round null after multiple rounds');
  else ok(`best_round: ${profile.best_round.total_score} (Δ par ${profile.best_round.to_par})`);

  // Handicap endpoint
  const hcp = (await req('GET', `/users/${a.user.user_id}/handicap`, null, a.token)).data;
  if (typeof hcp.handicap_index !== 'number' && hcp.handicap_index !== null) bug('handicap_index wrong type');
  if (!Array.isArray(hcp.differentials)) bug('handicap differentials missing');
  else ok(`handicap: index=${hcp.handicap_index}, ${hcp.differentials.length} diffs`);

  // 9-hole differentials should be flagged
  // (Best-effort — only meaningful if seed has 9-hole rounds)
  if (hcp.differentials.some((d) => d.is_nine_hole)) {
    ok('9-hole differentials are flagged');
  }
}

// ─── 8. Notifications ────────────────────────────────────────────────────────

async function suiteNotifications() {
  if (!shouldRun('notifs')) return;
  head('NOTIFICATIONS');

  const a = await register('NotifA');
  if (!a) return;
  const r = (await req('GET', '/users/me/notifications', null, a.token)).data;
  if (!r || !Array.isArray(r.notifications) || typeof r.unread_count !== 'number') {
    bug('/users/me/notifications shape wrong');
  } else {
    ok(`fresh user has ${r.unread_count} unread, ${r.notifications.length} total`);
  }
  const seen = await req('POST', '/users/me/notifications/seen', {}, a.token);
  if (seen.status !== 200) bug(`mark seen failed: ${seen.data?.error}`);
  else ok('mark-seen works');
}

// ─── 9. Premium redeem ───────────────────────────────────────────────────────

async function suitePremium() {
  if (!shouldRun('premium')) return;
  head('PREMIUM — promo code redemption');

  const a = await register('PremA');
  if (!a) return;
  const cat = (await req('GET', '/premium/catalog', null, a.token)).data;
  if (!Array.isArray(cat?.features) || !Array.isArray(cat?.plans)) bug('/premium/catalog shape wrong');
  else ok(`catalog: ${cat.features.length} features, ${cat.plans.length} plans`);

  // Bad code
  const bad = await req('POST', '/premium/redeem', { code: 'NOT-A-REAL-CODE' }, a.token);
  if (bad.status !== 404) bug(`bogus code should 404, got ${bad.status}`);
  else ok('bogus code rejected');

  // Real founder code (case-insensitive)
  const ok1 = await req('POST', '/premium/redeem', { code: 'f32dk4' }, a.token);
  if (ok1.status !== 200) {
    bug(`founder code redeem: ${ok1.data?.error}`);
  } else if (ok1.data?.plan !== 'lifetime') {
    bug(`founder code should grant lifetime, got ${ok1.data?.plan}`);
  } else {
    ok(`founder code redeemed → plan=${ok1.data.plan}, premium_until=${ok1.data.premium_until}`);
    // Verify is_premium now true on /users/me
    const me = await getMe(a.token);
    if (!me.is_premium) bug('is_premium not true after redeem');
    else ok('is_premium=true on /users/me');
  }
}

// ─── 10. Edge cases ──────────────────────────────────────────────────────────

async function suiteEdgeCases() {
  if (!shouldRun('edge')) return;
  head('EDGE CASES');

  const a = await register('EdgeA');
  const b = await register('EdgeB');
  if (!a || !b) return;
  const found = await pickCourse(a.token);
  if (!found) return;
  const { course, teebox, pars } = found;

  // Empty holeScores rejected
  const m = await createMatch(a.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  await joinMatch(b.token, m.match_id, teebox.teebox_id);
  const empty = await req('POST', `/matches/${m.match_id}/scores`,
    { holeScores: [], courseId: course.course_id, teeboxId: teebox.teebox_id }, a.token);
  if (empty.status === 200) bug('empty holeScores accepted');
  else ok('empty holeScores rejected');

  // Joining a completed match rejected
  await submitScores(a.token, m.match_id, genScores(pars, 0), course.course_id, teebox.teebox_id);
  await submitScores(b.token, m.match_id, genScores(pars, 0), course.course_id, teebox.teebox_id);
  const c = await register('LateJoiner');
  const join = await req('POST', `/matches/${m.match_id}/join`, { teeboxId: teebox.teebox_id }, c?.token);
  if (join.status === 200) bug('joining completed match accepted');
  else ok(`joining completed match rejected (${join.data?.error})`);

  // Cancelling someone else's match rejected
  const m2 = await createMatch(a.token, { matchType: 'solo', teeboxId: teebox.teebox_id });
  const stranger = await register('Stranger');
  const sCancel = await req('DELETE', `/matches/${m2.match_id}`, null, stranger.token);
  if (sCancel.status === 200) bug('non-participant could cancel match');
  else ok('non-participant blocked from cancelling');

  // Wrong path on /users/:id (well-formed but nonexistent UUID)
  const fake = await req('GET', '/users/00000000-0000-0000-0000-000000000000', null, a.token);
  if (fake.status !== 404) bug(`unknown user expected 404, got ${fake.status}`);
  else ok('unknown user → 404');

  // Comment rate-limit-ish: long body trimmed to 280
  // (Just verify no crash — backend trims silently)
  // Need a real round_id; reuse m above
  const round = (await getUser(a.token, a.user.user_id))?.recent_rounds?.[0];
  if (round?.round_id) {
    const longBody = 'x'.repeat(2000);
    const cmt = await req('POST', `/rounds/${round.round_id}/comments`, { body: longBody }, b.token);
    if (cmt.status !== 200) bug(`long comment crashed (${cmt.data?.error})`);
    else ok('long comment accepted (server should trim to 280)');
  }
}

// ─── 11. Weather + premium admin (optional) ──────────────────────────────────

// ─── 12. Relative-elevation crowdsourcing ────────────────────────────────────

async function suiteRelativeElevation() {
  if (!shouldRun('elevation')) return;
  head('RELATIVE ELEVATION CROWDSOURCING');

  const a = await register('ElevA');
  const b = await register('ElevB');
  if (!a || !b) return;

  const found = await pickCourse(a.token);
  if (!found) return;
  const { course } = found;

  // Player A is the first contributor — seeds origin = 0 at their teebox.
  const aRef = await req('POST', `/courses/${course.course_id}/elevation-reference`,
    { lat: 40.0001, lng: -74.0001, deviceAltM: 102 }, a.token);
  if (aRef.status !== 200) bug(`A reference failed: ${aRef.data?.error}`);
  else if (aRef.data.mode !== 'seed' && aRef.data.mode !== 'anchor') bug(`unexpected mode ${aRef.data.mode}`);
  else ok(`A seeded course at (40.0001, -74.0001), offset=${aRef.data.offsetM}m mode=${aRef.data.mode}`);

  // Player A walks 50m east and uphill 5m: device alt 107m → rel = 5m.
  // We also drop a few samples around them.
  const aSamples = [
    { lat: 40.0001, lng: -74.0001, elevationRelM: 0 },
    { lat: 40.0002, lng: -74.0001, elevationRelM: 1.2 },
    { lat: 40.0003, lng: -74.0001, elevationRelM: 2.8 },
    { lat: 40.0004, lng: -74.0001, elevationRelM: 4.5 },
    { lat: 40.0005, lng: -74.0001, elevationRelM: 5.0 }, // pin is here, ~55m away, +5m uphill
  ];
  const upload = await req('POST', `/courses/${course.course_id}/elevation-points`,
    { samples: aSamples }, a.token);
  if (upload.status !== 200) bug(`A upload failed: ${upload.data?.error}`);
  else if (upload.data.accepted !== aSamples.length) bug(`expected ${aSamples.length} accepted, got ${upload.data.accepted}`);
  else ok(`A uploaded ${upload.data.accepted} elevation samples`);

  // Lookup A's pin location — should hit one of the cached points.
  const lookup = await req('GET',
    `/courses/${course.course_id}/elevation-at?lat=40.0005&lng=-74.0001&radiusM=20`,
    null, a.token);
  if (lookup.status !== 200 || !lookup.data) bug(`pin lookup empty/failed`);
  else if (Math.abs(lookup.data.elevationRelM - 5.0) > 0.1) bug(`expected ~5.0m, got ${lookup.data.elevationRelM}`);
  else ok(`pin lookup returned ${lookup.data.elevationRelM}m (sample size ${lookup.data.samples})`);

  // Player B arrives — different barometer reading. Their actual altitude
  // at the same teebox is 250m (drifted barometer / different device).
  // The reference endpoint should return offset = 250 - 0 = 250 (anchor mode).
  const bRef = await req('POST', `/courses/${course.course_id}/elevation-reference`,
    { lat: 40.0001, lng: -74.0001, deviceAltM: 250 }, b.token);
  if (bRef.status !== 200) bug(`B reference failed: ${bRef.data?.error}`);
  else if (bRef.data.mode !== 'anchor') bug(`B expected 'anchor' mode, got '${bRef.data.mode}'`);
  else if (Math.abs(bRef.data.offsetM - 250) > 0.5) bug(`B offset wrong: expected ~250, got ${bRef.data.offsetM}`);
  else ok(`B aligned to A's frame: offset=${bRef.data.offsetM}m, mode=${bRef.data.mode}, distM=${bRef.data.distM ?? '—'}`);

  // B at the pin (250 + 5 = 255 in their frame) — converting to relative
  // gives 255 - 250 = 5m. Same result as A despite the 150m absolute drift.
  const bAtPin = 255 - bRef.data.offsetM;
  if (Math.abs(bAtPin - 5.0) > 0.5) bug(`B's calibration produced ${bAtPin}m at pin, expected ~5m`);
  else ok(`B's relative reading at pin = ${bAtPin}m (matches A's ${5.0}m)`);

  // Bad input rejected
  const bad = await req('POST', `/courses/${course.course_id}/elevation-points`,
    { samples: [{ lat: 999, lng: 999, elevationRelM: 5 }] }, a.token);
  if (bad.status === 200 && bad.data.accepted > 0) bug('elevation accepted out-of-range coords');
  else ok('elevation rejected out-of-range coords');

  // Out-of-radius lookup → null
  const far = await req('GET',
    `/courses/${course.course_id}/elevation-at?lat=41.5&lng=-72.5&radiusM=20`,
    null, a.token);
  if (far.status !== 200) bug(`far lookup failed: ${far.data?.error}`);
  else if (far.data !== null) bug('expected null for far lookup, got data');
  else ok('far lookup correctly returns null');

  // Data-quality endpoint — fresh course should look low-data
  const dq = await req('GET', `/courses/${course.course_id}/data-quality`, null, a.token);
  if (dq.status !== 200) bug(`data-quality failed: ${dq.data?.error}`);
  else if (typeof dq.data.low_data !== 'boolean') bug('data-quality missing low_data flag');
  else if (typeof dq.data.elevation_points !== 'number' || typeof dq.data.holes_with_pins !== 'number') bug('data-quality missing counts');
  else ok(`data-quality: low_data=${dq.data.low_data} (${dq.data.elevation_points} elev pts, ${dq.data.holes_with_pins}/${dq.data.total_holes} pins)`);
}

async function suiteWeather() {
  if (!shouldRun('weather')) return;
  head('WEATHER');

  const a = await register('Wx');
  if (!a) return;
  // Pebble Beach-ish coords
  const w = (await req('GET', '/weather?lat=36.5683&lng=-121.9495', null, a.token)).data;
  if (!w || w.temperature_f == null) bug('weather did not return temperature');
  else ok(`weather OK — ${w.temperature_f}°F, wind ${w.wind_speed_mph}mph`);

  const e = (await req('GET', '/weather/elevation?lat=36.5683&lng=-121.9495', null, a.token)).data;
  if (!e || typeof e.elevation_m !== 'number') bug('elevation did not return number');
  else ok(`elevation OK — ${e.elevation_m}m via ${e.source}`);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(64));
  console.log(`  SACARI GOLF — flow simulator`);
  console.log(`  base: ${BASE}`);
  console.log(`  run:  ${RUN}`);
  if (ONLY) console.log(`  only: ${[...ONLY].join(', ')}`);
  console.log('═'.repeat(64));

  const a = await suiteAuth();
  if (a) await suiteCourses(a.token);

  await suiteMatchSoloWin();
  await suiteMatchTie();
  await suiteMatchForfeit();
  await suiteMatchCancel();
  await suiteMatchPractice();
  await suiteMatchNineHoleSubsets();

  await suiteSocialChallenge();
  await suiteLiveProgress();
  await suiteRoundSocial();
  await suiteProfileData();
  await suiteNotifications();
  await suitePremium();
  await suiteWeather();
  await suiteRelativeElevation();
  await suiteEdgeCases();

  console.log('\n' + '═'.repeat(64));
  if (bugs.length === 0) {
    console.log('  ✅  ALL TESTS PASSED');
  } else {
    console.log(`  ❌  ${bugs.length} BUG${bugs.length === 1 ? '' : 'S'} FOUND:`);
    bugs.forEach((b, i) => console.log(`     ${i + 1}. ${b}`));
  }
  console.log('═'.repeat(64));
  process.exit(bugs.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
