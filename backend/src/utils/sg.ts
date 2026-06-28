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
 * Distances in yards (or feet for putts). Linear interpolation between rows.
 * Sources: Broadie's published tables, Shotscope baselines.  */
const ES_TEE: Array<[number, number]> = [
  [100, 2.92], [150, 2.97], [200, 3.05], [250, 3.27], [300, 3.65], [400, 4.30], [500, 4.85], [600, 5.30],
];
const ES_FAIRWAY: Array<[number, number]> = [
  [10, 2.18], [20, 2.40], [30, 2.52], [40, 2.60], [60, 2.70], [80, 2.80],
  [100, 2.85], [120, 2.91], [140, 2.96], [160, 3.02], [180, 3.10], [200, 3.20],
  [220, 3.30], [240, 3.40], [260, 3.50],
];
const ES_ROUGH: Array<[number, number]> = [
  [10, 2.45], [20, 2.65], [30, 2.78], [40, 2.85], [60, 2.95], [80, 3.05],
  [100, 3.15], [120, 3.20], [140, 3.27], [160, 3.35], [180, 3.45], [200, 3.55],
  [220, 3.65], [240, 3.75], [260, 3.85],
];
const ES_BUNKER: Array<[number, number]> = [
  [10, 2.60], [20, 2.85], [30, 2.92], [40, 3.00], [60, 3.15], [80, 3.25],
  [100, 3.30], [150, 3.50], [200, 3.75],
];
const ES_RECOVERY: Array<[number, number]> = [
  [50, 3.80], [100, 3.85], [150, 3.95], [200, 4.05], [250, 4.20],
];
/** Putting expected-strokes by distance in FEET (not yards). */
const ES_GREEN_FT: Array<[number, number]> = [
  [1, 1.001], [2, 1.009], [3, 1.053], [4, 1.147], [5, 1.265], [6, 1.385],
  [7, 1.493], [8, 1.589], [10, 1.751], [15, 1.989], [20, 2.094],
  [30, 2.273], [40, 2.392], [50, 2.476], [60, 2.546], [90, 2.788],
];

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
