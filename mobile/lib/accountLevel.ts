/**
 * Persistent account level — derived purely from lifetime matches played, so it
 * ONLY ever rises (matches never decrease) and every existing player is already
 * "backfilled": total_matches is the only input. This is the long-game progress
 * that sits alongside SR (which can fall). Your level is your mileage; your SR
 * is your current form.
 *
 * Advancing from level L to L+1 costs one more match than the last level, so the
 * first levels come quickly and high levels feel earned.
 */
const BASE_COST = 3;   // matches to go from level 1 to level 2
const STEP = 1;        // each level costs one more match than the previous

export interface AccountLevel {
  level: number;
  /** Matches earned into the current level. */
  into: number;
  /** Total matches the current level costs (into / toNext = progress). */
  toNext: number;
  /** Lifetime matches (the input). */
  total: number;
}

export function accountLevel(totalMatches: number | null | undefined): AccountLevel {
  let remaining = Math.max(0, Math.floor(totalMatches || 0));
  const total = remaining;
  let level = 1;
  let cost = BASE_COST;
  while (remaining >= cost) {
    remaining -= cost;
    level += 1;
    cost = BASE_COST + (level - 1) * STEP;
  }
  return { level, into: remaining, toNext: cost, total };
}
