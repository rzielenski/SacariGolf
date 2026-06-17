/**
 * Pure-logic checks for the live-leaderboard math (no DB). Run after
 * `npm run build`:  node tests/leaderboard.test.js
 */
const assert = require('assert');
const { computeLeaderboard } = require('../dist/utils/leaderboard');

const par3 = [4, 4, 4]; // simple 3-hole par grid
const byUser = (rows) => Object.fromEntries(rows.map((r) => [r.user_id, r]));

// 1) Stroke play, partial rounds: lower to-par leads; a 2-thru player ranks on
//    just the holes they've played.
{
  const rows = computeLeaderboard([
    { user_id: 'alice', username: 'Alice', side: 1, hole_scores: [4, 4, 4], parByHole: par3, completed: true },
    { user_id: 'bob',   username: 'Bob',   side: 2, hole_scores: [3, 4, 4], parByHole: par3, completed: true },
    { user_id: 'carol', username: 'Carol', side: 3, hole_scores: [5, 5, null], parByHole: par3, completed: false },
  ], 'stroke');
  const m = byUser(rows);
  assert.strictEqual(m.bob.toPar, -1, 'bob to-par');
  assert.strictEqual(m.alice.toPar, 0, 'alice to-par');
  assert.strictEqual(m.carol.thru, 2, 'carol thru 2 holes');
  assert.strictEqual(m.carol.total, 10, 'carol gross');
  assert.strictEqual(m.carol.toPar, 2, 'carol to-par over the 2 holes played');
  assert.strictEqual(m.bob.position, 1, 'bob leads');
  assert.strictEqual(m.alice.position, 2, 'alice 2nd');
  assert.strictEqual(m.carol.position, 3, 'carol 3rd');
}

// 2) Ties share a position (golf "T1"), next player skips to 3rd.
{
  const rows = computeLeaderboard([
    { user_id: 'dave',  username: 'Dave',  side: 1, hole_scores: [3, 4, 4], parByHole: par3, completed: true },
    { user_id: 'eve',   username: 'Eve',   side: 2, hole_scores: [4, 3, 4], parByHole: par3, completed: true },
    { user_id: 'frank', username: 'Frank', side: 3, hole_scores: [4, 4, 4], parByHole: par3, completed: true },
  ], 'stroke');
  const m = byUser(rows);
  assert.strictEqual(m.dave.toPar, -1, 'dave -1');
  assert.strictEqual(m.eve.toPar, -1, 'eve -1');
  assert.strictEqual(m.dave.position, 1, 'dave T1');
  assert.strictEqual(m.eve.position, 1, 'eve T1 (shares)');
  assert.strictEqual(m.frank.position, 3, 'frank skips to 3rd after the tie');
}

// 3) A player who hasn't teed off sorts to the bottom.
{
  const rows = computeLeaderboard([
    { user_id: 'heidi', username: 'Heidi', side: 2, hole_scores: [], parByHole: par3, completed: false },
    { user_id: 'grace', username: 'Grace', side: 1, hole_scores: [4, null, null], parByHole: par3, completed: false },
  ], 'stroke');
  assert.strictEqual(rows[0].user_id, 'grace', 'started player first');
  assert.strictEqual(rows[1].user_id, 'heidi', 'unplayed player last');
  assert.strictEqual(rows[1].thru, 0, 'heidi thru 0');
}

// 4) Stableford ranks by points (high = good), not to-par.
{
  const rows = computeLeaderboard([
    { user_id: 'ivan', username: 'Ivan', side: 1, hole_scores: [3, 3, 4], parByHole: par3, completed: true }, // 2+2+0 = 4
    { user_id: 'judy', username: 'Judy', side: 2, hole_scores: [4, 4, 4], parByHole: par3, completed: true }, // 0+0+0 = 0
    { user_id: 'ken',  username: 'Ken',  side: 3, hole_scores: [2, 4, 4], parByHole: par3, completed: true }, // 5+0+0 = 5
  ], 'stableford');
  const m = byUser(rows);
  assert.strictEqual(m.ken.points, 5, 'ken points');
  assert.strictEqual(m.ivan.points, 4, 'ivan points');
  assert.strictEqual(m.judy.points, 0, 'judy points');
  assert.strictEqual(m.ken.position, 1, 'ken leads on points (despite ivan being lower to-par-ish)');
  assert.strictEqual(m.ivan.position, 2, 'ivan 2nd');
  assert.strictEqual(m.judy.position, 3, 'judy 3rd');
}

console.log('Leaderboard tests passed ✓');
