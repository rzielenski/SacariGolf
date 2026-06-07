/**
 * Pure-logic checks for the daily digest text composer (no DB). Covers the
 * "Richard lost 13 balls today" headline, the privacy rule (non-opted-in
 * players are never named), and the quiet-day skip. Run after `npm run build`.
 */
const assert = require('assert');
const { composeDigest } = require('../dist/utils/twitterDigest');

// 1) Full day, opted-in loser → names Richard with the count.
const text = composeDigest(
  {
    roundsToday: 8,
    ballsLost: 24,
    ballsFound: 9,
    topLoser: { username: 'Richard', optedIn: true, count: 13 },
    topFinder: { username: 'Dana', optedIn: true, count: 7 },
    roundOfDay: { username: 'Sam', course: 'Potsdam CC', toPar: -2, holes: 18 },
  },
  '2026-06-07',
);
assert.ok(text, 'expected a digest string');
assert.ok(text.includes('Richard lost 13 balls today'), 'missing the loser headline');
assert.ok(text.includes('8 rounds logged'), 'missing activity line');
assert.ok(text.includes('2 under par') && text.includes('Sam'), 'missing round of the day');
assert.ok(text.includes('Dana'), 'missing finder shout-out');
assert.ok(text.length <= 280, `tweet exceeds 280 chars (${text.length})`);
console.log('--- sample digest ---\n' + text + '\n---------------------');

// 2) Non-opted-in loser must be anonymised, never named.
const anon = composeDigest(
  { roundsToday: 3, ballsLost: 12, ballsFound: 0, topLoser: { username: 'PrivatePerson', optedIn: false, count: 9 }, topFinder: null, roundOfDay: null },
  '2026-06-07',
);
assert.ok(anon.includes('Someone out there lost 9 balls'), 'should anonymise the loser');
assert.ok(!anon.includes('PrivatePerson'), 'leaked a non-opted-in username!');

// 3) Below the funny threshold → no loser line at all.
const small = composeDigest(
  { roundsToday: 2, ballsLost: 3, ballsFound: 0, topLoser: { username: 'X', optedIn: true, count: 2 }, topFinder: null, roundOfDay: null },
  '2026-06-07',
);
assert.ok(small && !/lost \d+ balls today/.test(small), 'should not roast a 2-ball day');

// 4) Quiet day → null (caller skips posting).
assert.strictEqual(
  composeDigest({ roundsToday: 0, ballsLost: 0, ballsFound: 0, topLoser: null, topFinder: null, roundOfDay: null }, '2026-06-07'),
  null,
  'quiet day should return null',
);

console.log('Digest compose tests passed ✓');
