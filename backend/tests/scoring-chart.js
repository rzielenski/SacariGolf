/**
 * Runs a spread of round types through the REAL compiled normalizedScore and
 * prints a chart. Build first:  npm run build && node tests/scoring-chart.js
 *
 * These rows mirror the shape of real DB rows (teebox par/num_holes + course
 * rating/slope, plus the match's holes_subset). To chart ACTUAL rounds, paste
 * rows from the SQL dump into `rounds` below — the columns line up 1:1.
 */
const { normalizedScore } = require('../dist/utils/scoring');

const rounds = [
  // scenario,                  course,             par, nH, played, subset, gross, CR,    slope, frontCR, frontSl
  ['Scratch · tough track',     'Ironwood (Black)',  72, 18, 18,    null,    76,   74.5,  145,   null,    null],
  ['Same 76 · easy muni',       'City Muni',         72, 18, 18,    null,    76,   69.0,  110,   null,    null],
  ['Bogey golfer · avg course', 'Parkland (White)',  72, 18, 18,    null,    90,   71.0,  125,   null,    null],
  ['Even par · champ tees',     'Ironwood (Tips)',   72, 18, 18,    null,    72,   76.2,  150,   null,    null],
  ['Blow-up · easy course',     'City Muni',         72, 18, 18,    null,   105,   68.0,  105,   null,    null],
  ['Front 9 · tough track',     'Ironwood (Black)',  72, 18,  9,    'front', 39,   74.5,  145,   37.2,    146],
  ['Back 9 · no nine rating',   'City Muni',         72, 18,  9,    'back',  41,   69.0,  110,   null,    null],
  ['Local 9 (half-scale data)', 'Creekside 9',       36,  9,  9,    null,    41,   35.2,  48,    null,    null],
  ['Creekside 9 played twice',  'Creekside 9 x2',    36,  9, 18,    null,    82,   35.2,  48,    null,    null],
  ['Par-3 executive',           'Pines Par-3',       54, 18, 18,    null,    60,   54.0,  82,    null,    null],
  ['No rating (fallback)',      'User-added 18',     72, 18, 18,    null,    88,   null,  null,  null,    null],
  ['9h, no rating (fallback)',  'User-added 9',      72, 18,  9,    null,    44,   null,  null,  null,    null],
];

// What the boards showed BEFORE course adjustment: par-based, scaled to 18.
function parBased18(par, numHoles, holesPlayed, gross) {
  const hp = holesPlayed || numHoles;
  const exact = ((gross - (par * hp) / numHoles) * 18) / hp;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}
const sgn = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const rows = rounds.map((r) => {
  const [who, course, par, numHoles, holesPlayed, holesSubset, gross, CR, slope, fCR, fSl] = r;
  const norm = normalizedScore({
    totalScore: gross, par, numHoles, holesPlayed,
    courseRating: CR, slopeRating: slope, holesSubset,
    frontCourseRating: fCR, frontSlopeRating: fSl,
    backCourseRating: null, backSlopeRating: null,
  });
  const mode = CR != null && slope != null ? 'differential' : 'par fallback';
  const roundToPar = gross - Math.round((par * (holesPlayed || numHoles)) / numHoles); // for the holes played
  return {
    who, course, rs: CR != null ? `${CR}/${slope}` : '—',
    holes: holesPlayed === numHoles ? `${holesPlayed}` : `${holesPlayed}${holesSubset ? ' ' + holesSubset : ''}`,
    gross, roundToPar: sgn(roundToPar),
    old: sgn(parBased18(par, numHoles, holesPlayed, gross)),
    neu: sgn(norm), mode,
  };
});

const H = ['Round', 'Course (par·R/S)', 'Holes', 'Gross', 'ToPar', 'Old(18)', 'NEW', 'Mode'];
const W = [27, 26, 7, 6, 6, 8, 6, 13];
const line = (cells) =>
  cells.map((c, i) => (i >= 3 && i <= 6 ? padL(c, W[i]) : pad(c, W[i]))).join(' | ');

console.log('');
console.log(line(H));
console.log(W.map((w) => '-'.repeat(w)).join('-+-'));
for (const r of rows) {
  console.log(line([r.who, `${r.course} (${r.rs})`, r.holes, r.gross, r.roundToPar, r.old, r.neu, r.mode]));
}
console.log('');
console.log('ToPar   = score vs par for the holes actually played (what the golfer shot)');
console.log('Old(18) = previous board value: par-based, scaled to 18 (no course difficulty)');
console.log('NEW     = normalizedScore now: rating/slope-adjusted differential (or par fallback)');
console.log('');
