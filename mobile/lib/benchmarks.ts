/**
 * Skill benchmarks for the stats dashboard: PGA Tour, scratch, and a
 * 10-handicap, for every stat the dashboard can compare.
 *
 * SOURCING, honestly stated:
 *   • PGA Tour rows are published figures — ShotLink season averages and the
 *     tour tables in Broadie's "Every Shot Counts" (make% by distance,
 *     proximity by distance, SG identity = 0 by definition).
 *   • Scratch and 10-handicap rows are ESTIMATES assembled from published
 *     amateur datasets: Broadie's amateur SG/putting tables (the book bands
 *     golfers by score; scratch ≈ his "75 golfer", 10-hcp ≈ his "85 golfer")
 *     and the USGA/Arccos distance reports for driving. They are the right
 *     ballpark, not measurements of this app's players. When enough Sacari
 *     rounds exist per handicap band these should be recomputed from real
 *     data and this file becomes the fallback.
 *
 * Distances in yards, proximity + putt distances in feet, SG in strokes per
 * round vs the tour baseline.
 */

export type BenchTier = 'tour' | 'scratch' | 'hcp10';

export const TIER_LABEL: Record<BenchTier, string> = {
  tour: 'PGA Tour',
  scratch: 'Scratch',
  hcp10: '10 HCP',
};

/** Which way is better for a stat. Deltas are colored with this. */
export type Direction = 'higher' | 'lower';

export interface BenchStat {
  tour: number;
  scratch: number;
  hcp10: number;
  direction: Direction;
  /** Display formatter, so % / ft / yds render consistently everywhere. */
  unit: 'pct' | 'yds' | 'ft' | 'per_round' | 'sg';
}

const b = (
  tour: number, scratch: number, hcp10: number,
  direction: Direction, unit: BenchStat['unit'],
): BenchStat => ({ tour, scratch, hcp10, direction, unit });

/** Headline on-course stats. */
export const BENCH = {
  driving_distance: b(300, 262, 241, 'higher', 'yds'),
  fairway_pct:      b(59, 55, 47, 'higher', 'pct'),
  gir_pct:          b(66, 53, 32, 'higher', 'pct'),
  putts_per_round:  b(28.9, 30.6, 32.4, 'lower', 'per_round'),
  three_putts_per_round: b(0.5, 0.8, 1.6, 'lower', 'per_round'),
  up_and_down_pct:  b(59, 44, 27, 'higher', 'pct'),
} as const;

/** Strokes gained per round vs the tour baseline (tour = 0 by definition;
 *  amateur rows from Broadie's per-category tables). */
export const BENCH_SG = {
  total:        b(0, -4.4, -14.3, 'higher', 'sg'),
  off_tee:      b(0, -1.2, -3.7, 'higher', 'sg'),
  approach:     b(0, -1.8, -5.8, 'higher', 'sg'),
  around_green: b(0, -0.7, -2.6, 'higher', 'sg'),
  putting:      b(0, -0.7, -2.2, 'higher', 'sg'),
} as const;

/** Putting make % by first-putt distance. Keys match the shot-stats buckets. */
export const BENCH_PUTT_MAKE: Record<string, BenchStat> = {
  '0-3 ft':   b(99, 98, 96, 'higher', 'pct'),
  '4-6 ft':   b(77, 66, 56, 'higher', 'pct'),
  '7-10 ft':  b(49, 39, 31, 'higher', 'pct'),
  '11-15 ft': b(28, 22, 16, 'higher', 'pct'),
  '16-25 ft': b(12, 9, 6, 'higher', 'pct'),
  '26+ ft':   b(5, 3.5, 2.5, 'higher', 'pct'),
};

/** Median approach proximity (ft) by start distance. Keys match shot-stats. */
export const BENCH_PROXIMITY: Record<string, BenchStat> = {
  '<50 yd (chip)': b(10, 14, 19, 'lower', 'ft'),
  '50-100 yd':     b(15, 21, 29, 'lower', 'ft'),
  '100-150 yd':    b(22, 31, 44, 'lower', 'ft'),
  '150-200 yd':    b(34, 48, 68, 'lower', 'ft'),
  '200+ yd':       b(55, 75, 100, 'lower', 'ft'),
};

export function benchValue(stat: BenchStat, tier: BenchTier): number {
  return stat[tier];
}

/** Format a value in a stat's native unit. */
export function fmtBench(v: number | null | undefined, unit: BenchStat['unit']): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'pct': return `${Math.round(v * 10) / 10}%`;
    case 'yds': return `${Math.round(v)} yds`;
    case 'ft': return `${Math.round(v)} ft`;
    case 'per_round': return `${(Math.round(v * 10) / 10).toFixed(1)}`;
    case 'sg': return `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}`;
  }
}

/**
 * Is `mine` better than, worse than, or level with the benchmark?
 * "Level" is a half-step band so a rounding-width difference doesn't get a
 * misleading color.
 */
export function compare(
  mine: number | null | undefined, stat: BenchStat, tier: BenchTier,
): 'better' | 'worse' | 'level' | null {
  if (mine == null || !Number.isFinite(mine)) return null;
  const bench = stat[tier];
  const tol = Math.max(Math.abs(bench) * 0.02, 0.05);
  const diff = stat.direction === 'higher' ? mine - bench : bench - mine;
  if (diff > tol) return 'better';
  if (diff < -tol) return 'worse';
  return 'level';
}
