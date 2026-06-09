/**
 * Season Pass — one season per calendar month, 10 tiers, XP earned by
 * playing ranked rounds (1 XP per completed ranked round). Each tier
 * unlocks a cosmetic from the season's reward ladder; full unlock at
 * tier 10 = 10 XP = 10 rounds.
 *
 * Lifecycle:
 *   • ensureCurrentSeason() on boot + every minute creates the current
 *     month's season if missing and writes the tier ladder rows.
 *   • awardRoundXp(userId) is called by routes/matches.ts after a
 *     successful score submit on a non-practice match.
 *
 * The reward ladder is data-driven via season_pass_tiers rows. Today
 * we seed every season with the same 10 cosmetics in a fixed order —
 * future seasons can ship a different ladder by changing the seed
 * function below without touching the schema.
 */

import pool from '../db/pool';

/** Ten cosmetics ordered easiest → most prestigious. Each season seed
 *  inserts these as tiers 1..10. */
const TIER_LADDER: string[] = [
  'trail_neon',         // 1  — easy unlock, premium-tier feel
  'uname_ice',          // 2
  'border_storm',       // 3
  'bg_volcanic',        // 4
  'trail_fire',         // 5
  'bg_cosmic',          // 6
  'uname_fire',         // 7
  'bg_storm',           // 8
  'trail_galaxy',       // 9
  'bg_america',         // 10 — capstone
];

/** Format the season's display name: "June 2026", "September 2025", ... */
function seasonName(monthStart: Date): string {
  return monthStart.toLocaleString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** Ensure the current month's season exists. Idempotent via unique
 *  index on starts_at. Also seeds the tier ladder rows. */
export async function ensureCurrentSeason(): Promise<void> {
  // First-of-month UTC for the current month.
  const { rows: anchor } = await pool.query(
    `SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS s,
            (date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
              + INTERVAL '1 month') AS e`,
  );
  if (!anchor.length) return;
  const startsAt: Date = anchor[0].s;
  const endsAt: Date = anchor[0].e;
  const name = seasonName(startsAt);

  const { rows: ins } = await pool.query(
    `INSERT INTO seasons (starts_at, ends_at, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (starts_at) DO NOTHING
     RETURNING season_id`,
    [startsAt, endsAt, name],
  );

  // If we created the row, also seed the tier ladder. Otherwise verify
  // the ladder is populated (covers the case where a partial setup left
  // the season without any tier rows — defensive but cheap).
  let seasonId: string | null = ins[0]?.season_id ?? null;
  if (!seasonId) {
    const { rows: existing } = await pool.query(
      `SELECT season_id FROM seasons WHERE starts_at = $1 LIMIT 1`,
      [startsAt],
    );
    seasonId = existing[0]?.season_id ?? null;
  }
  if (!seasonId) return;

  for (let i = 0; i < TIER_LADDER.length; i++) {
    const tier = i + 1;
    await pool.query(
      `INSERT INTO season_pass_tiers (season_id, tier, xp_required, cosmetic_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (season_id, tier) DO NOTHING`,
      [seasonId, tier, tier, TIER_LADDER[i]],
    );
  }
}

/** Grant +1 XP to a user for the current season. Creates the
 *  progress row on first call. Safe to call multiple times per round
 *  (the matches.ts caller only fires once per submit anyway). */
export async function awardRoundXp(userId: string): Promise<void> {
  await ensureCurrentSeason();
  await pool.query(
    `INSERT INTO season_pass_progress (user_id, season_id, xp, updated_at)
     SELECT $1, s.season_id, 1, NOW()
       FROM seasons s
      WHERE NOW() >= s.starts_at AND NOW() < s.ends_at
      LIMIT 1
     ON CONFLICT (user_id, season_id)
     DO UPDATE SET xp         = season_pass_progress.xp + 1,
                   updated_at = NOW()`,
    [userId],
  );
}
