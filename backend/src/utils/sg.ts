/**
 * Advanced strokes-gained engine.
 *
 * Implements the Mark Broadie / PGA-Tour-style model: each shot's SG is the
 * change in expected strokes-to-hole-out, minus the stroke just played.
 *
 *     SG_shot = ES(start_lie, start_dist) - ES(end_lie, end_dist) - 1
 *
 * Categorisation:
 *   • Off-the-Tee   — shots from the tee on par 4/5 holes
 *   • Approach      — shots from tee on par 3, OR fairway/rough/sand outside
 *                     30 yards on par 4/5
 *   • Around-Green  — shots from off the green within 30 yards
 *   • Putting       — shots from the green
 *
 * Baseline tables come from publicly published PGA-Tour-average expected-strokes
 * data. They're approximations — close enough for category-level comparisons,
 * but not absolute fidelity. Easy to swap for a more precise table later.
 *
 * See https://shotscope.com/blog/practice-green/stats-and-data/understanding-strokes-gained/
 * for a friendly explainer of the same model.
 */

export type Lie = 'tee' | 'fairway' | 'rough' | 'bunker' | 'recovery' | 'green' | 'fringe';
export type SGCategory = 'off_tee' | 'approach' | 'around_green' | 'putting';

export interface Shot {
  start_lie: Lie;
  start_dist_yds: number;   // distance to hole BEFORE this shot
  end_lie: Lie;
  end_dist_yds: number;     // distance to hole AFTER this shot. 0 if holed out.
  par: number;              // par for the hole (3/4/5)
  is_tee_shot: boolean;     // first shot of the hole
}

/** PGA-Tour average expected strokes from each lie at given distance.
 * Distances in yards (feet for the green table). Linear interpolation between
 * knots, clamped at the ends.
 *
 * These are Mark Broadie's published benchmark tables from "Every Shot Counts"
 * (the appendix tables his strokes-gained model is built on), lightly rounded.
 * Getting these right matters more than anything else in the SG engine: every
 * per-shot figure is a difference of two lookups here, so a table that's 0.1
 * high at one distance silently reshapes a player's whole category profile.
 * Notable true-to-book shapes kept on purpose:
 *   • TEE flattens toward 4.0 at 400-440 (tour players average ~even par on
 *     long par 4s, NOT 4.3 — the old table overpaid every long-hole drive).
 *   • SAND dips at 100-140 vs 60-80 (a full-swing fairway bunker shot is
 *     easier than an awkward half-swing one — the book's table is
 *     non-monotonic there and that's real, not a typo).
 *   • GREEN is the tour putting curve: 50% make at 8 ft (1.50), 1.78 at 15 ft,
 *     ~2.0 at 30 ft. The old table was far more pessimistic (1.99 at 15 ft),
 *     which inflated everyone's putting SG and understated everyone's need to
 *     practice the long game — the exact bias the book was written to kill. */
const ES_TEE: Array<[number, number]> = [
  [100, 2.92], [120, 2.99], [140, 2.97], [160, 2.99], [180, 3.05], [200, 3.12],
  [220, 3.17], [240, 3.25], [260, 3.45], [280, 3.65], [300, 3.71], [320, 3.79],
  [340, 3.86], [360, 3.92], [380, 3.96], [400, 3.99], [420, 4.02], [440, 4.08],
  [460, 4.17], [480, 4.28], [500, 4.41], [520, 4.54], [540, 4.65], [560, 4.74],
  [580, 4.79], [600, 4.82],
];
const ES_FAIRWAY: Array<[number, number]> = [
  [10, 2.18], [20, 2.40], [30, 2.52], [40, 2.60], [50, 2.66], [60, 2.70],
  [70, 2.72], [80, 2.75], [90, 2.77], [100, 2.80], [120, 2.85], [140, 2.91],
  [160, 2.98], [180, 3.08], [200, 3.19], [220, 3.32], [240, 3.42], [260, 3.53],
  [280, 3.62], [300, 3.71], [320, 3.79], [340, 3.86], [360, 3.92], [380, 3.96],
  [400, 3.99], [440, 4.10], [480, 4.34], [520, 4.59], [560, 4.78], [600, 4.88],
];
const ES_ROUGH: Array<[number, number]> = [
  [10, 2.34], [20, 2.59], [30, 2.70], [40, 2.78], [50, 2.87], [60, 2.91],
  [80, 2.96], [100, 3.02], [120, 3.08], [140, 3.15], [160, 3.23], [180, 3.31],
  [200, 3.42], [220, 3.53], [240, 3.64], [260, 3.74], [280, 3.83], [300, 3.90],
  [340, 4.06], [380, 4.22], [420, 4.38], [460, 4.54], [500, 4.70],
];
const ES_BUNKER: Array<[number, number]> = [
  [10, 2.43], [20, 2.53], [30, 2.66], [40, 2.82], [50, 2.99], [60, 3.15],
  [70, 3.20], [80, 3.24], [100, 3.23], [120, 3.21], [140, 3.22], [160, 3.28],
  [180, 3.40], [200, 3.55], [220, 3.70], [240, 3.84], [260, 3.93], [280, 4.00],
  [300, 4.04], [350, 4.30], [400, 4.69], [450, 5.04], [500, 5.40],
];
const ES_RECOVERY: Array<[number, number]> = [
  [100, 3.80], [140, 3.80], [180, 3.82], [220, 3.92], [260, 4.03], [300, 4.20],
  [340, 4.44], [380, 4.66], [420, 4.79], [460, 4.91], [500, 5.03],
];
/** Putting expected-strokes by distance in FEET (not yards). Book values:
 *  make% at 8 ft is exactly 50%, the 2-putt/lag boundary sits near 33 ft. */
const ES_GREEN_FT: Array<[number, number]> = [
  [1, 1.001], [2, 1.009], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34],
  [7, 1.42], [8, 1.50], [9, 1.56], [10, 1.61], [12, 1.68], [15, 1.78],
  [20, 1.87], [25, 1.93], [30, 1.98], [35, 2.02], [40, 2.06], [45, 2.10],
  [50, 2.14], [60, 2.21], [70, 2.28], [80, 2.34], [90, 2.40], [100, 2.46],
];

/** "Every Shot Counts" ch. 3: for typical amateurs the LONG game (driving +
 *  approach) explains ~two-thirds of the scoring gap to better players; the
 *  short game ~20% and putting only ~15%. Served alongside a player's own
 *  leak decomposition so the app can show "you vs the typical amateur" —
 *  the book's central argument, personalised. */
export const TYPICAL_AMATEUR_LOSS_SPLIT: Record<SGCategory, number> = {
  off_tee: 0.28, approach: 0.37, around_green: 0.20, putting: 0.15,
};

/** Effective green radius used across the app's analytics (12 yds ≈ 36 ft). */
export const GREEN_RADIUS_YDS = 12;

function lerp(table: Array<[number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return table[table.length - 1][1];
}

/** Expected strokes from a given lie at a given distance to the hole. */
export function expectedStrokes(lie: Lie, distYds: number): number {
  if (distYds <= 0) return 0; // holed out
  switch (lie) {
    case 'tee':      return lerp(ES_TEE, distYds);
    case 'fairway':  return lerp(ES_FAIRWAY, distYds);
    case 'fringe':   return lerp(ES_FAIRWAY, distYds); // treat fringe as fairway
    case 'rough':    return lerp(ES_ROUGH, distYds);
    case 'bunker':   return lerp(ES_BUNKER, distYds);
    case 'recovery': return lerp(ES_RECOVERY, distYds);
    case 'green':    return lerp(ES_GREEN_FT, distYds * 3); // yards → feet
  }
}

/** Expected putts to hole out from a given distance IN FEET (PGA-Tour putting
 *  baseline). Used by the input-based putting/chipping SG, which works off the
 *  putt distances the player types in rather than GPS-tracked shots. */
export function expectedPutts(distFt: number): number {
  if (distFt <= 0) return 0;          // already holed
  return lerp(ES_GREEN_FT, distFt);
}

/** Strokes-gained for a single shot. */
export function sgForShot(shot: Shot): number {
  const before = expectedStrokes(shot.start_lie, shot.start_dist_yds);
  const after  = shot.end_dist_yds <= 0 ? 0 : expectedStrokes(shot.end_lie, shot.end_dist_yds);
  return before - after - 1;
}

/** Categorise a shot into the four standard SG buckets. */
export function categorize(shot: Shot): SGCategory {
  if (shot.start_lie === 'green') return 'putting';
  if (shot.is_tee_shot && shot.par >= 4) return 'off_tee';
  if (shot.start_dist_yds <= 30 && shot.start_lie !== 'tee') return 'around_green';
  return 'approach';
}

export interface RoundSGAdvanced {
  off_tee: number;
  approach: number;
  around_green: number;
  putting: number;
  total: number;
  shots_used: number;
}

/** Sum SG by category over a list of shots. */
export function aggregateSG(shots: Shot[]): RoundSGAdvanced {
  const out: RoundSGAdvanced = {
    off_tee: 0, approach: 0, around_green: 0, putting: 0, total: 0, shots_used: 0,
  };
  for (const s of shots) {
    const sg = sgForShot(s);
    if (!Number.isFinite(sg)) continue;
    const cat = categorize(s);
    out[cat] += sg;
    out.total += sg;
    out.shots_used += 1;
  }
  return out;
}
