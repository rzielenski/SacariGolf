// Sacari Golf — Match Simulation
// Tests solo and duo matches across multiple courses, logs all bugs found.

const BASE = 'http://localhost:3000';
const bugs = [];
const log = (msg) => console.log(`  ${msg}`);
const bug = (msg) => { bugs.push(msg); console.error(`  ❌ BUG: ${msg}`); };
const ok = (msg) => console.log(`  ✅ ${msg}`);

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerUser(username, email) {
  const { status, data } = await req('POST', '/auth/register', { username, email, password: 'testpass123' });
  if (status !== 201) { bug(`register ${username}: ${data.error}`); return null; }
  ok(`registered ${username} (ELO ${data.user.elo})`);
  return { token: data.token, user: data.user };
}

async function searchCourse(token, query) {
  const { data } = await req('GET', `/courses/search?q=${encodeURIComponent(query)}`, null, token);
  if (!Array.isArray(data) || data.length === 0) { bug(`course search "${query}" returned nothing`); return null; }
  return data[0];
}

async function getCourse(token, courseId) {
  const { data } = await req('GET', `/courses/${courseId}`, null, token);
  if (!data.teeboxes || data.teeboxes.length === 0) { bug(`course ${data.course_name} has no teeboxes`); return null; }
  return data;
}

async function createMatch(token, matchType, teeboxId, name, isPractice = false) {
  const { status, data } = await req('POST', '/matches', { matchType, teeboxId, name, isPractice }, token);
  if (status !== 201) { bug(`createMatch ${matchType}: ${data.error}`); return null; }
  return data;
}

async function joinMatch(token, matchId, teeboxId) {
  const { status, data } = await req('POST', `/matches/${matchId}/join`, { teeboxId }, token);
  if (status !== 200) { bug(`joinMatch ${matchId}: ${data.error}`); return null; }
  return data;
}

async function submitScores(token, matchId, holeScores, courseId, teeboxId) {
  const { status, data } = await req('POST', `/matches/${matchId}/scores`, { holeScores, courseId, teeboxId }, token);
  if (status !== 200) { bug(`submitScores ${matchId}: ${data.error}`); return null; }
  return data;
}

async function getMatch(token, matchId) {
  const { data } = await req('GET', `/matches/${matchId}`, null, token);
  return data;
}

async function getUser(token) {
  const { data } = await req('GET', '/users/me', null, token);
  return data;
}

// Generate realistic scores for a given par array
function generateScores(pars, skill = 0) {
  // skill: negative = good player, positive = high handicap
  return pars.map(par => Math.max(1, par + skill + Math.floor(Math.random() * 4) - 1));
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testSoloMatch(p1, p2, courseName) {
  console.log(`\n🏌️  Solo match at ${courseName}`);
  const course = await searchCourse(p1.token, courseName);
  if (!course) return;
  const full = await getCourse(p1.token, course.course_id);
  if (!full) return;

  const tb = full.teeboxes[0];
  const holes = tb.holes?.sort((a,b) => a.hole_num - b.hole_num);
  if (!holes || holes.length === 0) { bug(`${courseName} teebox has no holes`); return; }
  log(`Course: ${full.course_name} | Teebox: ${tb.name} | Rating: ${tb.course_rating} | Slope: ${tb.slope_rating} | Holes: ${holes.length}`);

  const pars = holes.map(h => h.par);

  // Create match
  const match = await createMatch(p1.token, 'solo', tb.teebox_id, `Solo @ ${courseName}`);
  if (!match) return;

  // Check match has correct type
  if (match.match_type !== 'solo') bug(`match_type should be "solo", got "${match.match_type}"`);
  else ok(`match created: ${match.match_id.slice(0,8)}`);

  // P2 joins
  const joinResult = await joinMatch(p2.token, match.match_id, tb.teebox_id);
  if (!joinResult) return;
  ok(`p2 joined (side ${joinResult.side})`);

  // Check match state before scores
  const beforeMatch = await getMatch(p1.token, match.match_id);
  if (beforeMatch.completed) bug('match shows completed before any scores submitted');
  if (beforeMatch.players?.length !== 2) bug(`expected 2 players, got ${beforeMatch.players?.length}`);

  const p1Before = await getUser(p1.token);
  const p2Before = await getUser(p2.token);

  // P1 submits scores
  const p1Scores = generateScores(pars, 1);  // slightly over par
  const p2Scores = generateScores(pars, -1); // slightly under par
  const p1Total = p1Scores.reduce((a,b)=>a+b,0);
  const p2Total = p2Scores.reduce((a,b)=>a+b,0);
  log(`P1 scores: ${p1Total} | P2 scores: ${p2Total}`);

  const p1Result = await submitScores(p1.token, match.match_id, p1Scores, full.course_id, tb.teebox_id);
  if (!p1Result) return;
  if (p1Result.result != null) { bug('match resolved with only 1 player submitted'); }
  else ok('p1 scores submitted, waiting for p2');

  const p2Result = await submitScores(p2.token, match.match_id, p2Scores, full.course_id, tb.teebox_id);
  if (!p2Result) return;

  if (!p2Result.result) { bug('match did not resolve after both players submitted'); return; }
  ok(`match resolved — winner side: ${p2Result.result.winnerSide}, ELO delta: ±${p2Result.result.deltaElo}`);

  // Verify ELO changed correctly
  const p1After = await getUser(p1.token);
  const p2After = await getUser(p2.token);
  const p1EloChange = p1After.elo - p1Before.elo;
  const p2EloChange = p2After.elo - p2Before.elo;
  log(`ELO changes — P1: ${p1EloChange > 0 ? '+' : ''}${p1EloChange} | P2: ${p2EloChange > 0 ? '+' : ''}${p2EloChange}`);

  if (p1EloChange === 0 && p2EloChange === 0) bug('ELO did not change for either player');
  if (p1EloChange + p2EloChange !== 0) bug(`ELO sum is not zero: ${p1EloChange + p2EloChange}`);

  // Lower score diff should win
  const p1Diff = (p1Total - tb.course_rating) * (113 / tb.slope_rating);
  const p2Diff = (p2Total - tb.course_rating) * (113 / tb.slope_rating);
  const expectedWinner = p1Diff <= p2Diff ? 1 : 2;
  if (p2Result.result.winnerSide !== expectedWinner) {
    bug(`wrong winner: p1Diff=${p1Diff.toFixed(2)} p2Diff=${p2Diff.toFixed(2)} expected side ${expectedWinner} got ${p2Result.result.winnerSide}`);
  } else {
    ok(`correct winner (lower differential wins) ✓`);
  }

  // Verify match shows completed
  const finalMatch = await getMatch(p1.token, match.match_id);
  if (!finalMatch.completed) bug('match.completed not true after resolution');
  else ok('match.completed = true ✓');

  // Check match_history shows up
  const { data: history } = await req('GET', '/matches', null, p1.token);
  const found = history.find(m => m.match_id === match.match_id);
  if (!found) bug('completed match not in history');
  else ok('match appears in history ✓');
}

async function testDuoMatch(p1, p2, p3, p4, courseName) {
  console.log(`\n👥  Duo match at ${courseName}`);
  const course = await searchCourse(p1.token, courseName);
  if (!course) return;
  const full = await getCourse(p1.token, course.course_id);
  if (!full) return;

  const tb = full.teeboxes[0];
  const holes = tb.holes?.sort((a,b) => a.hole_num - b.hole_num);
  if (!holes || holes.length === 0) { bug(`${courseName} teebox has no holes`); return; }
  log(`Course: ${full.course_name} | Teebox: ${tb.name} | Holes: ${holes.length} | Par: ${tb.par}`);

  const pars = holes.map(h => h.par);

  const match = await createMatch(p1.token, 'duo', tb.teebox_id, `Duo @ ${courseName}`);
  if (!match) return;
  if (match.match_type !== 'duo') bug(`expected duo, got ${match.match_type}`);
  else ok(`duo match created`);

  // P2 is p1's partner (same side 1 — but our current schema assigns sides sequentially)
  // Join order: p2 side2, p3 side3, p4 side4 — note: duo logic may need clan grouping
  // For now test with simple sequential joining
  await joinMatch(p2.token, match.match_id, tb.teebox_id);
  await joinMatch(p3.token, match.match_id, tb.teebox_id);
  await joinMatch(p4.token, match.match_id, tb.teebox_id);

  const checkMatch = await getMatch(p1.token, match.match_id);
  log(`Players in match: ${checkMatch.players?.length}`);
  if (checkMatch.players?.length !== 4) bug(`expected 4 players in duo, got ${checkMatch.players?.length}`);
  else ok('4 players joined ✓');

  // All 4 submit scores
  const allScores = [
    generateScores(pars, 2),
    generateScores(pars, 1),
    generateScores(pars, -1),
    generateScores(pars, 0),
  ];
  const tokens = [p1.token, p2.token, p3.token, p4.token];

  let finalResult = null;
  for (let i = 0; i < 4; i++) {
    const res = await submitScores(tokens[i], match.match_id, allScores[i], full.course_id, tb.teebox_id);
    if (!res) return;
    if (i < 3 && res.result != null) bug(`match resolved too early after player ${i+1} submitted`);
    if (i === 3) finalResult = res;
  }

  if (!finalResult?.result) { bug('duo match did not resolve after all 4 players submitted'); return; }
  ok(`duo resolved — winner side: ${finalResult.result.winnerSide}, delta ELO: ±${finalResult.result.deltaElo}`);

  const finalM = await getMatch(p1.token, match.match_id);
  if (!finalM.completed) bug('duo match not marked completed');
  else ok('duo match.completed = true ✓');
}

async function testPracticeMatch(p1, courseName) {
  console.log(`\n⛳  Practice round at ${courseName}`);
  const course = await searchCourse(p1.token, courseName);
  if (!course) return;
  const full = await getCourse(p1.token, course.course_id);
  if (!full) return;

  const tb = full.teeboxes[0];
  if (!tb.holes?.length) { bug(`${courseName} has no holes`); return; }
  const pars = tb.holes.sort((a,b)=>a.hole_num-b.hole_num).map(h=>h.par);

  const p1Before = await getUser(p1.token);
  const match = await createMatch(p1.token, 'practice', tb.teebox_id, null, true);
  if (!match) return;
  if (!match.is_practice) bug('practice match is_practice flag is false');
  else ok('is_practice = true ✓');

  const scores = generateScores(pars, 0);
  const res = await submitScores(p1.token, match.match_id, scores, full.course_id, tb.teebox_id);
  if (!res) return;

  const p1After = await getUser(p1.token);
  if (p1After.elo !== p1Before.elo) bug(`practice match changed ELO: ${p1Before.elo} → ${p1After.elo}`);
  else ok('practice match did not affect ELO ✓');
  ok(`practice round complete — score: ${scores.reduce((a,b)=>a+b,0)}`);
}

async function testEdgeCases(p1, p2) {
  console.log('\n🔬  Edge cases');

  // Double submit (same player submits twice)
  const course = await searchCourse(p1.token, 'Clarkson');
  const full = await getCourse(p1.token, course.course_id);
  const tb = full.teeboxes[0];
  const pars = tb.holes.sort((a,b)=>a.hole_num-b.hole_num).map(h=>h.par);

  const match = await createMatch(p1.token, 'solo', tb.teebox_id, 'Edge Test');
  await joinMatch(p2.token, match.match_id, tb.teebox_id);
  const scores = generateScores(pars, 0);
  await submitScores(p1.token, match.match_id, scores, full.course_id, tb.teebox_id);
  await submitScores(p2.token, match.match_id, scores, full.course_id, tb.teebox_id);

  // Try to submit again after match completed
  const { status } = await req('POST', `/matches/${match.match_id}/scores`,
    { holeScores: scores, courseId: full.course_id, teeboxId: tb.teebox_id }, p1.token);
  // This should still return 200 (upsert) — just verify it doesn't crash
  if (status === 500) bug('server crashed on double-submit after match complete');
  else ok('double-submit after completion handled without crash ✓');

  // Try joining a completed match
  const { status: joinStatus, data: joinData } = await req('POST', `/matches/${match.match_id}/join`, { teeboxId: tb.teebox_id }, p1.token);
  if (joinStatus === 200) bug('allowed joining a completed match');
  else ok(`joining completed match correctly rejected (${joinData.error}) ✓`);

  // Solo match with 0-stroke score (invalid)
  const badMatch = await createMatch(p1.token, 'solo', tb.teebox_id, 'Bad Score Test');
  await joinMatch(p2.token, badMatch.match_id, tb.teebox_id);
  const { status: badStatus } = await req('POST', `/matches/${badMatch.match_id}/scores`,
    { holeScores: [], courseId: full.course_id, teeboxId: tb.teebox_id }, p1.token);
  if (badStatus === 200) bug('empty holeScores array accepted without error');
  else ok('empty holeScores correctly rejected ✓');
}

async function testCourseSearch(token) {
  console.log('\n🔍  Course search');
  const tests = [
    { q: 'Camroden', expect: 'Camroden' },
    { q: 'Clarkson', expect: 'Clarkson' },
    { q: 'Massena', expect: 'Massena' },
    { q: 'Pebble Beach', expect: 'Pebble' },
    { q: 'Augusta', expect: 'Augusta' },
    { q: 'Potsdam', expect: 'Potsdam' },
  ];
  for (const t of tests) {
    const { data } = await req('GET', `/courses/search?q=${encodeURIComponent(t.q)}`, null, token);
    if (!Array.isArray(data) || data.length === 0) {
      bug(`search "${t.q}" returned no results`);
    } else if (!data[0].course_name.toLowerCase().includes(t.expect.toLowerCase()) &&
               !data[0].city?.toLowerCase().includes(t.expect.toLowerCase())) {
      bug(`search "${t.q}" top result is "${data[0].course_name}" — expected something matching "${t.expect}"`);
    } else {
      ok(`"${t.q}" → ${data[0].course_name} (${data[0].city ?? '—'}, ${data[0].state ?? '—'})`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('   CLASH OF CLUBS — MATCH SIMULATION');
  console.log('='.repeat(60));

  // Register 4 test players
  console.log('\n👤  Registering players...');
  const p1 = await registerUser('SimPlayer1', 'sim1@test.com');
  const p2 = await registerUser('SimPlayer2', 'sim2@test.com');
  const p3 = await registerUser('SimPlayer3', 'sim3@test.com');
  const p4 = await registerUser('SimPlayer4', 'sim4@test.com');
  if (!p1 || !p2 || !p3 || !p4) { console.error('Registration failed, aborting'); return; }

  await testCourseSearch(p1.token);
  await testSoloMatch(p1, p2, 'Clarkson');
  await testSoloMatch(p3, p4, 'Camroden');
  await testSoloMatch(p1, p3, 'Massena');
  await testDuoMatch(p1, p2, p3, p4, 'Higley');
  await testPracticeMatch(p2, 'Clarkson');
  await testEdgeCases(p1, p2);

  // Final ELO snapshot
  console.log('\n📊  Final ELO standings:');
  for (const [name, p] of [['SimPlayer1',p1],['SimPlayer2',p2],['SimPlayer3',p3],['SimPlayer4',p4]]) {
    const u = await getUser(p.token);
    log(`${name}: ${u.elo} ELO (${u.total_wins}W / ${u.total_matches}M)`);
  }

  console.log('\n' + '='.repeat(60));
  if (bugs.length === 0) {
    console.log('   ✅  ALL TESTS PASSED — no bugs found');
  } else {
    console.log(`   ❌  ${bugs.length} BUG(S) FOUND:`);
    bugs.forEach((b, i) => console.log(`   ${i+1}. ${b}`));
  }
  console.log('='.repeat(60));

  // Cleanup test users
  process.exit(bugs.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
