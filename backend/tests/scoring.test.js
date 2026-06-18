/**
 * Pure-logic checks for the cross-player score normalization + winner rule
 * (no DB). Run after `npm run build`:  node tests/scoring.test.js
 *
 * Covers the two modes normalizedScore can produce:
 *   • par-based 18-hole-equivalent to-par (no course rating/slope), and
 *   • the rating/slope-adjusted USGA differential (when rating + slope given),
 * plus the winner rule both feed.
 */
const assert = require('assert');
const { normalizedScore, rankByScore, diff18 } = require('../dist/utils/scoring');

// ── Fallback (no course rating/slope) = par-based 18-hole-equivalent to-par ──

// 1) The headline rule: +7 over 9 (→ +14) must NOT beat +12 over 18 (→ +12).
{
  const nine = normalizedScore({ totalScore: 43, par: 72, numHoles: 18, holesPlayed: 9 });
  const full = normalizedScore({ totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18 });
  assert.strictEqual(nine, 14, '+7 over 9 normalizes to +14');
  assert.strictEqual(full, 12, '+12 over 18 stays +12');
  assert.ok(full < nine, 'the 18-hole +12 round ranks ahead of the 9-hole +7 round');
}

// 2) Even par is 0 on any hole count; a full -4 stays -4; legacy rows (no
//    holesPlayed) fall back to the teebox hole count.
{
  assert.strictEqual(normalizedScore({ totalScore: 72, par: 72, numHoles: 18, holesPlayed: 18 }), 0);
  assert.strictEqual(normalizedScore({ totalScore: 36, par: 72, numHoles: 18, holesPlayed: 9 }), 0);
  assert.strictEqual(normalizedScore({ totalScore: 68, par: 72, numHoles: 18, holesPlayed: 18 }), -4);
  assert.strictEqual(normalizedScore({ totalScore: 84, par: 72, numHoles: 18 }), 12);
}

// ── Difficulty-adjusted (USGA score differential) when rating + slope present ──

// 3) On a neutral course (72.0 / 113) the differential equals plain to-par.
{
  assert.strictEqual(
    normalizedScore({ totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18, courseRating: 72, slopeRating: 113 }),
    12, 'neutral 72.0/113 course → differential equals to-par');
}

// 4) The same gross on a HARDER course is a better (lower) score: 84 on a
//    75.0/140 course → (113/140)*(84-75) ≈ 7, ahead of 84 on an easy course.
{
  const easy = normalizedScore({ totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18, courseRating: 72, slopeRating: 113 });
  const hard = normalizedScore({ totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18, courseRating: 75, slopeRating: 140 });
  assert.strictEqual(easy, 12, 'easy course 84 → 12');
  assert.strictEqual(hard, 7, 'hard course 84 → 7');
  assert.ok(hard < easy, 'the same gross on a harder course ranks better');
}

// 5) A 9-hole differential is scaled to an 18-hole equivalent. Front 9 of an
//    18-hole course with no published front rating → halve (36), +7 → ×2 = 14.
{
  assert.strictEqual(
    normalizedScore({ totalScore: 43, par: 72, numHoles: 18, holesPlayed: 9, courseRating: 72, slopeRating: 113, holesSubset: 'front' }),
    14, '9-on-18, halved rating, doubled to an 18-hole equivalent');
}

// ── Winner rule ──

// 6) rankByScore picks the right winner; result[0] is the winner.
{
  const ranked = rankByScore([
    { id: 'nineFluke', totalScore: 43, par: 72, numHoles: 18, holesPlayed: 9 },  // +14 (fallback)
    { id: 'easyPar',   totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18, courseRating: 72, slopeRating: 113 }, // 12
    { id: 'hardPar',   totalScore: 84, par: 72, numHoles: 18, holesPlayed: 18, courseRating: 75, slopeRating: 140 }, // 7
  ]);
  assert.strictEqual(ranked[0].id, 'hardPar', 'same gross on the hardest course wins');
  assert.strictEqual(ranked[1].id, 'easyPar', 'easy-course 84 second');
  assert.strictEqual(ranked[2].id, 'nineFluke', '9-hole +7 ranks last on an 18-basis');
}

// 7) Ties keep input order (deterministic when caller pre-sorts by tiebreak).
{
  const ranked = rankByScore([
    { id: 'first',  totalScore: 75, par: 72, numHoles: 18, holesPlayed: 18 }, // +3
    { id: 'second', totalScore: 75, par: 72, numHoles: 18, holesPlayed: 18 }, // +3
  ]);
  assert.strictEqual(ranked[0].id, 'first', 'equal scores keep input order');
}

// ── A spread of real-world round types (mirrors tests/scoring-chart.js) — locks
//    normalizedScore across courses, hole counts, and the no-rating fallback ──
{
  const N = (o) => normalizedScore({
    numHoles: 18, holesSubset: null,
    frontCourseRating: null, frontSlopeRating: null,
    backCourseRating: null, backSlopeRating: null, ...o,
  });
  // Same gross (76), different course difficulty → different score.
  assert.strictEqual(N({ totalScore: 76, par: 72, holesPlayed: 18, courseRating: 74.5, slopeRating: 145 }), 1, 'scratch on a tough track');
  assert.strictEqual(N({ totalScore: 76, par: 72, holesPlayed: 18, courseRating: 69.0, slopeRating: 110 }), 7, 'same 76 on an easy muni');
  // Even par on championship tees beats the rating → negative.
  assert.strictEqual(N({ totalScore: 72, par: 72, holesPlayed: 18, courseRating: 76.2, slopeRating: 150 }), -3, 'even par on champ tees');
  assert.strictEqual(N({ totalScore: 105, par: 72, holesPlayed: 18, courseRating: 68.0, slopeRating: 105 }), 40, 'blow-up on an easy course');
  // Front 9 with a published nine rating; back 9 without one (halve 18 rating).
  assert.strictEqual(N({ totalScore: 39, par: 72, holesPlayed: 9, holesSubset: 'front', courseRating: 74.5, slopeRating: 145, frontCourseRating: 37.2, frontSlopeRating: 146 }), 3, 'front 9 w/ published nine rating');
  assert.strictEqual(N({ totalScore: 41, par: 72, holesPlayed: 9, holesSubset: 'back', courseRating: 69.0, slopeRating: 110 }), 13, 'back 9, no nine rating');
  // A 9-hole course (half-scale data), played 9 and played 18 → same pace.
  assert.strictEqual(N({ totalScore: 41, par: 36, numHoles: 9, holesPlayed: 9, courseRating: 35.2, slopeRating: 48 }), 14, 'local 9, half-scale data');
  assert.strictEqual(N({ totalScore: 82, par: 36, numHoles: 9, holesPlayed: 18, courseRating: 35.2, slopeRating: 48 }), 14, 'same 9-hole course played twice');
  assert.strictEqual(N({ totalScore: 60, par: 54, holesPlayed: 18, courseRating: 54.0, slopeRating: 82 }), 8, 'par-3 executive');
  // No rating/slope → par-based fallback (18, and 9-on-18 doubled).
  assert.strictEqual(N({ totalScore: 88, par: 72, holesPlayed: 18 }), 16, 'no rating, 18 holes → par fallback');
  assert.strictEqual(N({ totalScore: 44, par: 72, holesPlayed: 9 }), 16, 'no rating, 9-on-18 → par fallback doubled');
}

// ── diff18 (the ELO differential, now an adapter over roundDifferential) must
//    equal the previous standalone formula exactly for every 9/18 input ──
{
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  assert.strictEqual(diff18(84, 72, 113, 18, 18), 12, '18-on-18 standard');
  assert.strictEqual(diff18(43, 72, 113, 9, 18), 14, '9-on-18, no published nine rating → full 18 rating');
  close(diff18(43, 35, 55, 9, 9), (113 / 110) * (86 - 70), '9 on a 9-hole teebox (half-scale data doubled)');
  close(diff18(40, 72, 113, 9, 18, 35, 120), (113 / 120) * (80 - 70), '9-on-18 with a front-9 rating/slope override');
  close(diff18(90, 65, 130, 18, 18), (113 / 130) * (90 - 65), '18-on-18 on a harder course');
}

console.log('Scoring tests passed ✓');
