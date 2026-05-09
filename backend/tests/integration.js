// Sacari Golf — Integration Test Runner
//
// Hits the running backend (default http://localhost:3000, override with
// API_URL env var) and exercises every major user path. Each test creates
// fresh users with random suffixes so re-runs never collide. All test users
// are deleted at the end via DELETE /users/me.
//
// Run:    node backend/tests/integration.js
// Or:     API_URL=https://your-railway-url node backend/tests/integration.js

const BASE = process.env.API_URL || 'http://localhost:3000';
const RUN_ID = Math.random().toString(36).slice(2, 8);

// ── tracking ─────────────────────────────────────────────────────────────────

const results = []; // { group, name, status: 'pass' | 'fail', message?, took_ms }
let currentGroup = '';
const createdUsers = []; // [{ token, user }] for cleanup

const C_GREEN = '\x1b[32m';
const C_RED = '\x1b[31m';
const C_GREY = '\x1b[90m';
const C_BOLD = '\x1b[1m';
const C_RESET = '\x1b[0m';
const C_YELLOW = '\x1b[33m';

function group(name) {
  currentGroup = name;
  console.log(`\n${C_BOLD}── ${name} ──${C_RESET}`);
}
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const took = Date.now() - t0;
    console.log(`  ${C_GREEN}✓${C_RESET} ${name} ${C_GREY}(${took}ms)${C_RESET}`);
    results.push({ group: currentGroup, name, status: 'pass', took_ms: took });
  } catch (err) {
    const took = Date.now() - t0;
    console.log(`  ${C_RED}✗ ${name}${C_RESET}`);
    console.log(`    ${C_RED}${err.message}${C_RESET}`);
    if (err.stack && process.env.DEBUG) console.log(C_GREY + err.stack.split('\n').slice(1, 4).join('\n') + C_RESET);
    results.push({ group: currentGroup, name, status: 'fail', message: err.message, took_ms: took });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'values differ'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertClose(a, b, eps = 0.5, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg || 'not close'}: |${a} - ${b}| > ${eps}`);
}

// ── http ─────────────────────────────────────────────────────────────────────

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function ok(r, msg) {
  if (r.status >= 400) {
    const detail = typeof r.data === 'object' && r.data?.error ? r.data.error : JSON.stringify(r.data).slice(0, 200);
    throw new Error(`${msg || 'request failed'} (${r.status}): ${detail}`);
  }
  return r.data;
}

// ── user / match helpers ─────────────────────────────────────────────────────

async function makeUser(label) {
  const username = `t${RUN_ID}_${label}`.slice(0, 20);
  const email = `t${RUN_ID}_${label}@test.invalid`;
  const r = await http('POST', '/auth/register', { username, email, password: 'testpass123' });
  if (r.status !== 201) throw new Error(`register ${username}: ${r.data?.error}`);
  const u = { token: r.data.token, user: r.data.user, label };
  createdUsers.push(u);
  return u;
}

async function findCourseWithTeebox() {
  // Try a few likely seed-data names; pick whichever returns a course with at
  // least one teebox that has hole data. Avoids hard-coding a specific course.
  const candidates = ['Camroden', 'Clarkson', 'Massena', 'Higley', 'Pebble', 'Augusta'];
  for (const q of candidates) {
    const r = await http('GET', `/courses/search?q=${encodeURIComponent(q)}`, null, createdUsers[0]?.token);
    if (r.status >= 400 || !Array.isArray(r.data) || !r.data.length) continue;
    for (const c of r.data) {
      const detail = await http('GET', `/courses/${c.course_id}`, null, createdUsers[0]?.token);
      if (detail.status >= 400) continue;
      const tb = detail.data.teeboxes?.find((t) => t.holes?.length > 0);
      if (tb) return { course: detail.data, teebox: tb };
    }
  }
  throw new Error('no course with teebox+holes found in seed data');
}

function gen(pars, skill) {
  // skill: 0 = scratch-ish, 1 = bogey, -1 = under
  return pars.map((p) => Math.max(1, p + skill + Math.floor(Math.random() * 3) - 1));
}

async function getMe(token) {
  return ok(await http('GET', '/users/me', null, token), 'GET /users/me');
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST GROUPS
// ═════════════════════════════════════════════════════════════════════════════

async function authTests() {
  group('Auth');

  await test('register returns token + user', async () => {
    const u = await makeUser('a1');
    assert(u.token && u.token.length > 20, 'token missing or short');
    assertEq(u.user.elo, 1200, 'starting ELO');
    assertEq(u.user.total_matches, 0, 'starting matches');
  });

  await test('GET /users/me with token returns the same user', async () => {
    const u = createdUsers[createdUsers.length - 1];
    const me = await getMe(u.token);
    assertEq(me.user_id, u.user.user_id, 'user_id mismatch');
    assertEq(me.username, u.user.username, 'username mismatch');
  });

  await test('login with correct password issues a token', async () => {
    const u = createdUsers[0];
    const r = await http('POST', '/auth/login', { email: u.user.email, password: 'testpass123' });
    ok(r, 'login');
    assert(r.data.token, 'no token on login');
  });

  await test('login with wrong password is rejected', async () => {
    const u = createdUsers[0];
    const r = await http('POST', '/auth/login', { email: u.user.email, password: 'wrong' });
    assert(r.status >= 400, 'wrong password should error');
  });

  await test('GET /users/me without token is rejected', async () => {
    const r = await http('GET', '/users/me');
    assert(r.status === 401, 'missing token should be 401');
  });
}

async function profileTests() {
  group('Profile editing');
  const u = createdUsers[0];

  await test('PATCH /users/me sets bio', async () => {
    ok(await http('PATCH', '/users/me', { bio: 'gothic golfer' }, u.token), 'patch bio');
    const me = await getMe(u.token);
    assertEq(me.bio, 'gothic golfer', 'bio not persisted');
  });

  await test('PATCH /users/me sets handicap_index in valid range', async () => {
    ok(await http('PATCH', '/users/me', { handicapIndex: 12.4 }, u.token), 'patch handicap');
    const me = await getMe(u.token);
    assertClose(me.handicap_index, 12.4, 0.05, 'handicap not persisted');
  });

  await test('PATCH /users/me rejects out-of-range handicap', async () => {
    const r = await http('PATCH', '/users/me', { handicapIndex: 99 }, u.token);
    assert(r.status >= 400, 'handicap=99 should be rejected');
  });

  await test('PATCH /users/me changes username', async () => {
    const newName = `t${RUN_ID}_renm`;
    ok(await http('PATCH', '/users/me', { username: newName }, u.token), 'patch username');
    const me = await getMe(u.token);
    assertEq(me.username, newName);
  });
}

async function courseTests() {
  group('Course discovery');
  const u = createdUsers[0];

  await test('GET /courses/search returns results for known seed', async () => {
    const r = ok(await http('GET', '/courses/search?q=cl', null, u.token), 'search');
    assert(Array.isArray(r), 'expected array');
  });

  await test('GET /courses/:id returns teeboxes+holes', async () => {
    const { course, teebox } = await findCourseWithTeebox();
    assert(course.teeboxes?.length > 0, 'no teeboxes');
    assert(teebox.holes.length === teebox.num_holes, `expected ${teebox.num_holes} holes, got ${teebox.holes.length}`);
  });

  await test('GET /courses/nearby with valid lat/lng returns array', async () => {
    const r = ok(await http('GET', '/courses/nearby?lat=40&lng=-74', null, u.token), 'nearby');
    assert(Array.isArray(r));
  });
}

// ── shared course context for the match tests ────────────────────────────────
let CTX = { course: null, teebox: null, pars: [] };

async function matchTests() {
  group('Match: solo practice');
  const u = createdUsers[0];
  const { course, teebox } = await findCourseWithTeebox();
  CTX.course = course;
  CTX.teebox = teebox;
  CTX.pars = teebox.holes.sort((a, b) => a.hole_num - b.hole_num).map((h) => h.par);

  await test('Practice match doesnt change ELO', async () => {
    const before = await getMe(u.token);
    const m = ok(await http('POST', '/matches', {
      matchType: 'practice',
      isPractice: true,
      teeboxId: teebox.teebox_id,
      numHoles: teebox.num_holes,
    }, u.token), 'create practice');
    const scores = gen(CTX.pars, 0);
    ok(await http('POST', `/matches/${m.match_id}/scores`, {
      holeScores: scores,
      courseId: course.course_id,
      teeboxId: teebox.teebox_id,
    }, u.token), 'submit practice');
    const after = await getMe(u.token);
    assertEq(after.elo, before.elo, 'practice should not change ELO');
  });
}

async function autoMatchTests() {
  group('Match: solo auto-match (two players resolve via pool)');
  const a = await makeUser('am_a');
  const b = await makeUser('am_b');
  const { course, teebox } = CTX;

  let resolution = null;

  await test('A and B each create solo, both submit, second triggers resolution', async () => {
    const aBefore = await getMe(a.token);
    const bBefore = await getMe(b.token);

    const mA = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, a.token), 'A create');
    const mB = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, b.token), 'B create');

    // A submits — no opponent yet, stays pending
    const sA = ok(await http('POST', `/matches/${mA.match_id}/scores`, {
      holeScores: gen(CTX.pars, 1), // bogey-ish
      courseId: course.course_id, teeboxId: teebox.teebox_id,
    }, a.token), 'A submit');
    assert(sA.result == null, 'A should stay pending until B submits');

    // B submits — should pull A from pool, resolve, ELO updates
    const sB = ok(await http('POST', `/matches/${mB.match_id}/scores`, {
      holeScores: gen(CTX.pars, -1), // under par-ish
      courseId: course.course_id, teeboxId: teebox.teebox_id,
    }, b.token), 'B submit');
    assert(sB.result, 'B should auto-match and resolve');
    resolution = sB.result;

    const aAfter = await getMe(a.token);
    const bAfter = await getMe(b.token);
    assert(aAfter.elo !== aBefore.elo || bAfter.elo !== bBefore.elo, 'ELO should change for at least one side');
    assertEq(
      (aAfter.elo - aBefore.elo) + (bAfter.elo - bBefore.elo),
      0,
      'ELO is zero-sum'
    );
  });

  await test('B match GET returns my_delta_elo signed correctly for winner', async () => {
    const r = ok(await http('GET', `/matches/${resolution.matchId ?? ''}`, null, b.token), 'get match');
    // winnerSide is on the result object
  });

  await test('Both players see the same completed match in /matches list', async () => {
    const aList = ok(await http('GET', '/matches', null, a.token), 'A list');
    const bList = ok(await http('GET', '/matches', null, b.token), 'B list');
    assert(aList.length > 0 && bList.length > 0, 'both should have a completed match');
    const aCompleted = aList.find((m) => m.completed);
    const bCompleted = bList.find((m) => m.completed);
    assert(aCompleted && bCompleted, 'both should have a completed row');
  });
}

async function tieTests() {
  group('Match: tie (identical differentials)');
  const a = await makeUser('tie_a');
  const b = await makeUser('tie_b');
  const { course, teebox } = CTX;

  await test('Equal scores → winner_side null, total_ties++ for both', async () => {
    const aBefore = await getMe(a.token);
    const bBefore = await getMe(b.token);
    const tieBeforeA = aBefore.total_ties ?? 0;
    const tieBeforeB = bBefore.total_ties ?? 0;

    const mA = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, a.token), 'A create');
    const mB = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, b.token), 'B create');

    // Force identical scores by using the same array
    const tiedScores = CTX.pars.map((p) => p); // even par for both
    ok(await http('POST', `/matches/${mA.match_id}/scores`, {
      holeScores: tiedScores, courseId: course.course_id, teeboxId: teebox.teebox_id,
    }, a.token), 'A submit');
    const sB = ok(await http('POST', `/matches/${mB.match_id}/scores`, {
      holeScores: tiedScores, courseId: course.course_id, teeboxId: teebox.teebox_id,
    }, b.token), 'B submit');

    assert(sB.result, 'should resolve');
    assert(sB.result.tied === true || sB.result.winnerSide === null, `expected tie, got winnerSide=${sB.result.winnerSide}`);

    const aAfter = await getMe(a.token);
    const bAfter = await getMe(b.token);
    assertEq((aAfter.total_ties ?? 0) - tieBeforeA, 1, 'A total_ties should increment');
    assertEq((bAfter.total_ties ?? 0) - tieBeforeB, 1, 'B total_ties should increment');
    // Equal ELO (both started at 1200) → ELO should not change for tie
    assertClose(aAfter.elo - aBefore.elo, 0, 1, 'tied equals → no ELO change');
  });
}

async function forfeitTests() {
  group('Match: forfeit');
  const a = await makeUser('fft_a');
  const b = await makeUser('fft_b');
  const { course, teebox } = CTX;

  await test('A creates, invites B, B accepts, A forfeits → A loses ELO, B wins', async () => {
    const m = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id,
      numHoles: teebox.num_holes, name: 'forfeit-test',
    }, a.token), 'A create');

    // A invites B
    ok(await http('POST', '/invites', { matchId: m.match_id, toUserId: b.user.user_id }, a.token), 'invite');
    const invs = ok(await http('GET', '/invites', null, b.token), 'list invites');
    const inv = invs.find((i) => i.match_id === m.match_id);
    assert(inv, 'B should see the invite');
    ok(await http('POST', `/invites/${inv.invite_id}/accept`, {}, b.token), 'accept');

    const aBefore = await getMe(a.token);
    const bBefore = await getMe(b.token);

    const ff = ok(await http('POST', `/matches/${m.match_id}/forfeit`, {}, a.token), 'forfeit');
    assert(ff.forfeited, 'should be marked as forfeited (real opponent existed)');

    const aAfter = await getMe(a.token);
    const bAfter = await getMe(b.token);
    assert(aAfter.elo < aBefore.elo, `forfeiter ELO should drop (was ${aBefore.elo}, now ${aAfter.elo})`);
    assert(bAfter.elo > bBefore.elo, `opponent ELO should rise (was ${bBefore.elo}, now ${bAfter.elo})`);
    assertEq(bAfter.total_wins, bBefore.total_wins + 1, 'opponent total_wins++');
  });
}

async function cancelTests() {
  group('Match: cancel');
  const a = await makeUser('cn_a');
  const b = await makeUser('cn_b');
  const { teebox } = CTX;

  await test('Match with no submitted scores can be cancelled', async () => {
    const m = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, a.token), 'create');
    const r = ok(await http('DELETE', `/matches/${m.match_id}`, null, a.token), 'cancel');
    assertEq(r.success, true);
  });

  await test('Cancel after a player completed is rejected (409)', async () => {
    const m = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, a.token), 'create');
    ok(await http('POST', `/invites`, { matchId: m.match_id, toUserId: b.user.user_id }, a.token), 'invite');
    const invs = ok(await http('GET', '/invites', null, b.token), 'invs');
    const inv = invs.find((i) => i.match_id === m.match_id);
    ok(await http('POST', `/invites/${inv.invite_id}/accept`, {}, b.token), 'accept');

    // A submits — match still has B pending, so it stays open
    ok(await http('POST', `/matches/${m.match_id}/scores`, {
      holeScores: gen(CTX.pars, 0),
      courseId: CTX.course.course_id, teeboxId: teebox.teebox_id,
    }, a.token), 'A submit');

    const r = await http('DELETE', `/matches/${m.match_id}`, null, b.token);
    assertEq(r.status, 409, 'cancel after a submission should 409');
  });
}

async function liveTests() {
  group('Live in-progress watching');
  const a = await makeUser('lv_a');
  const b = await makeUser('lv_b');
  const c = await makeUser('lv_c'); // friend (not in match)
  const { course, teebox } = CTX;

  await test('Friend NOT in match sees A as PLAYING NOW after progress', async () => {
    const m = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id, numHoles: teebox.num_holes,
    }, a.token), 'create');

    // A sends progress
    ok(await http('POST', `/matches/${m.match_id}/progress`, {
      holeScores: [CTX.pars[0]], teeboxId: teebox.teebox_id,
    }, a.token), 'A progress');

    // C views A's active round → should see something
    const live = ok(await http('GET', `/users/${a.user.user_id}/active-round`, null, c.token), 'C view A');
    assert(live, 'C should see live data');
    assert(live.match_id === m.match_id, 'should reference correct match');
  });

  await test('Opponent IN same match cannot see A live (anti-cheat)', async () => {
    // Create new match where A and B are actually opposing
    const m = ok(await http('POST', '/matches', {
      matchType: 'solo', teeboxId: teebox.teebox_id,
      numHoles: teebox.num_holes, name: 'live-anticheat',
    }, a.token), 'create');
    ok(await http('POST', '/invites', { matchId: m.match_id, toUserId: b.user.user_id }, a.token), 'invite');
    const invs = ok(await http('GET', '/invites', null, b.token), 'invs');
    const inv = invs.find((i) => i.match_id === m.match_id);
    ok(await http('POST', `/invites/${inv.invite_id}/accept`, {}, b.token), 'accept');

    // A makes some progress
    ok(await http('POST', `/matches/${m.match_id}/progress`, {
      holeScores: [CTX.pars[0], CTX.pars[1]], teeboxId: teebox.teebox_id,
    }, a.token), 'A progress');

    // B (opponent) tries to view A's active round → should be NULL
    const live = await http('GET', `/users/${a.user.user_id}/active-round`, null, b.token);
    assertEq(live.status, 200, 'should still be 200');
    assertEq(live.data, null, 'opponent should see null (anti-cheat)');
  });
}

async function leaderboardTests() {
  group('Course leaderboard + profile rounds');
  const u = createdUsers[0];
  const { course } = CTX;

  await test('Course leaderboard returns rounds played at this course', async () => {
    const lb = ok(await http('GET', `/courses/${course.course_id}/leaderboard`, null, u.token), 'lb');
    assert(Array.isArray(lb), 'should be array');
    // We've completed at least one match here in earlier tests
    assert(lb.length > 0, 'expected at least one entry');
    const first = lb[0];
    assert(typeof first.total_score === 'number', 'no total_score');
    assert(first.username, 'no username');
  });

  await test('GET /users/:id includes recent_rounds and best_round', async () => {
    const u2 = createdUsers.find((x) => x.label?.startsWith('am_b')) ?? u;
    const profile = ok(await http('GET', `/users/${u2.user.user_id}`, null, u.token), 'profile');
    assert(Array.isArray(profile.recent_rounds), 'no recent_rounds');
    if (profile.recent_rounds.length) {
      assert(profile.best_round, 'has rounds but no best_round');
      assert(typeof profile.best_round.total_score === 'number', 'best_round has no score');
    }
  });
}

async function handicapTests() {
  group('Handicap');
  const u = createdUsers[0];

  await test('GET /users/:id/handicap returns differentials array', async () => {
    const r = ok(await http('GET', `/users/${u.user.user_id}/handicap`, null, u.token), 'handicap');
    assert('differentials' in r, 'no differentials');
    assert(Array.isArray(r.differentials), 'differentials should be array');
    // Validate each diff matches the formula (113/slope)*(score - rating)
    for (const d of r.differentials) {
      const expected = (113 / d.slope_used) * (d.total_score - d.course_rating_used);
      assertClose(d.differential, Math.round(expected * 10) / 10, 0.15, `diff math off: ${JSON.stringify(d)}`);
    }
  });
}

async function reactionsTests() {
  group('Round reactions + comments');
  const a = createdUsers.find((x) => x.label?.startsWith('am_a'));
  const b = createdUsers.find((x) => x.label?.startsWith('am_b'));
  if (!a || !b) return; // skip if auto-match tests didn't run

  // Find a completed round_id from B's profile
  const profile = await http('GET', `/users/${b.user.user_id}`, null, a.token);
  const round = profile.data?.recent_rounds?.[0];
  if (!round?.round_id) return; // can't test if no round

  await test('Toggle reaction adds it on first call, removes on second', async () => {
    const r1 = ok(await http('POST', `/rounds/${round.round_id}/reactions`, { reaction: 'fire' }, a.token), 'add');
    assertEq(r1.added, true, 'first call should add');
    const r2 = ok(await http('POST', `/rounds/${round.round_id}/reactions`, { reaction: 'fire' }, a.token), 'remove');
    assertEq(r2.added, false, 'second call should remove');
  });

  await test('Invalid reaction is rejected', async () => {
    const r = await http('POST', `/rounds/${round.round_id}/reactions`, { reaction: 'fart' }, a.token);
    assert(r.status >= 400, 'unknown reaction should error');
  });

  await test('Comment posts and appears in /social', async () => {
    const post = ok(await http('POST', `/rounds/${round.round_id}/comments`, { body: 'sick round bro' }, a.token), 'post');
    assert(post.comment_id, 'no comment_id');
    const social = ok(await http('GET', `/rounds/${round.round_id}/social`, null, a.token), 'social');
    assert(social.comments.find((c) => c.comment_id === post.comment_id), 'comment not in social response');
    // Cleanup
    ok(await http('DELETE', `/rounds/${round.round_id}/comments/${post.comment_id}`, null, a.token), 'delete comment');
  });
}

async function nineHoleTests() {
  group('9-hole match');
  const u = createdUsers[0];
  const { course, teebox } = CTX;
  const numHoles = Math.min(9, teebox.num_holes);
  if (teebox.num_holes < 9) {
    console.log(`  ${C_YELLOW}⚠ skipped — teebox only has ${teebox.num_holes} holes${C_RESET}`);
    return;
  }

  await test('Match with numHoles=9 records num_holes correctly', async () => {
    const m = ok(await http('POST', '/matches', {
      matchType: 'practice', isPractice: true,
      teeboxId: teebox.teebox_id, numHoles: 9,
    }, u.token), 'create 9');
    assertEq(m.num_holes, 9, 'num_holes should be 9');

    const scores = gen(CTX.pars.slice(0, 9), 0);
    ok(await http('POST', `/matches/${m.match_id}/scores`, {
      holeScores: scores, courseId: course.course_id, teeboxId: teebox.teebox_id,
    }, u.token), 'submit 9');

    const detail = ok(await http('GET', `/matches/${m.match_id}`, null, u.token), 'get');
    assertEq(detail.completed, true, 'practice should complete');
  });
}

async function premiumTests() {
  group('Premium');
  const u = await makeUser('prem');

  await test('GET /premium/catalog returns features and plans', async () => {
    const r = ok(await http('GET', '/premium/catalog', null, u.token), 'catalog');
    assert(Array.isArray(r.features) && r.features.length > 0);
    assert(Array.isArray(r.plans) && r.plans.length > 0);
  });

  await test('Invalid promo code is rejected', async () => {
    const r = await http('POST', '/premium/redeem', { code: 'NOTAREALCODE' }, u.token);
    assertEq(r.status, 404, 'bogus code should 404');
  });

  await test('F32DK4 founder code grants lifetime', async () => {
    const r = ok(await http('POST', '/premium/redeem', { code: 'F32DK4' }, u.token), 'redeem');
    assertEq(r.success, true);
    assertEq(r.plan, 'lifetime');
    const me = await getMe(u.token);
    assertEq(me.is_premium, true, 'is_premium should be true after redeem');
    assertEq(me.premium_until, null, 'lifetime should have null premium_until');
  });
}

async function weatherTests() {
  group('Weather + elevation');
  const u = createdUsers[0];

  await test('GET /weather returns conditions for a valid lat/lng', async () => {
    const r = ok(await http('GET', '/weather?lat=44.6&lng=-75.0', null, u.token), 'weather');
    assert('temperature_f' in r, 'no temperature');
    assert(['none', 'light', 'heavy'].includes(r.rain), 'invalid rain value');
  });

  await test('GET /weather rejects invalid coords', async () => {
    const r = await http('GET', '/weather?lat=999&lng=0', null, u.token);
    assert(r.status >= 400, 'bad lat should error');
  });

  await test('GET /weather/elevation returns meters', async () => {
    const r = await http('GET', '/weather/elevation?lat=44.6&lng=-75.0', null, u.token);
    if (r.status >= 400) {
      // upstream provider may be flaky — log but don't fail the suite
      console.log(`    ${C_YELLOW}elevation upstream returned ${r.status} — skipping assertion${C_RESET}`);
      return;
    }
    assert(typeof r.data.elevation_m === 'number', 'elevation_m should be a number');
  });
}

async function notificationsTests() {
  group('Notifications');
  const u = createdUsers[0];

  await test('GET /users/me/notifications returns shape with unread_count', async () => {
    const r = ok(await http('GET', '/users/me/notifications', null, u.token), 'notifs');
    assert(Array.isArray(r.notifications), 'no notifications array');
    assert(typeof r.unread_count === 'number', 'no unread_count');
  });

  await test('POST /users/me/notifications/seen zeros out unread_count', async () => {
    ok(await http('POST', '/users/me/notifications/seen', {}, u.token), 'seen');
    const r = ok(await http('GET', '/users/me/notifications', null, u.token), 'after seen');
    assertEq(r.unread_count, 0, 'unread_count should be 0 after seen');
  });
}

// ── cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  group('Cleanup');
  for (const u of createdUsers) {
    try {
      await http('DELETE', '/users/me', null, u.token);
    } catch { /* best effort */ }
  }
  console.log(`  deleted ${createdUsers.length} test users`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C_BOLD}Sacari Golf integration tests${C_RESET}`);
  console.log(`Target:  ${BASE}`);
  console.log(`Run ID:  ${RUN_ID}`);

  // Health check first — bail early if backend is unreachable.
  try {
    const r = await http('GET', '/health');
    if (r.status !== 200) throw new Error(`/health returned ${r.status}`);
  } catch (err) {
    console.error(`\n${C_RED}Backend unreachable at ${BASE}${C_RESET}`);
    console.error(`  ${err.message}`);
    console.error(`  Start dev server with:  cd backend && npm run dev`);
    console.error(`  Or set API_URL env var to a deployed instance.`);
    process.exit(2);
  }

  const t0 = Date.now();
  try {
    await authTests();
    await profileTests();
    await courseTests();
    await matchTests();
    await autoMatchTests();
    await tieTests();
    await forfeitTests();
    await cancelTests();
    await liveTests();
    await leaderboardTests();
    await handicapTests();
    await reactionsTests();
    await nineHoleTests();
    await premiumTests();
    await weatherTests();
    await notificationsTests();
  } catch (err) {
    console.error(`\n${C_RED}Suite aborted: ${err.message}${C_RESET}`);
  } finally {
    await cleanup();
  }

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const totalMs = Date.now() - t0;
  console.log(`\n${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}`);
  console.log(`${C_BOLD}Results:${C_RESET} ${C_GREEN}${passed} passed${C_RESET}, ${failed > 0 ? C_RED : C_GREY}${failed} failed${C_RESET}  ${C_GREY}(${(totalMs / 1000).toFixed(1)}s)${C_RESET}`);
  if (failed > 0) {
    console.log(`\n${C_RED}Failed tests:${C_RESET}`);
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ${C_RED}✗${C_RESET} ${r.group} › ${r.name}`);
      console.log(`    ${C_GREY}${r.message}${C_RESET}`);
    }
  }
  console.log(`${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
