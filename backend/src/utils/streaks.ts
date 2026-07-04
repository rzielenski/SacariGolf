/**
 * Current win-streak computation — the basis of the "bounty" feature. A player
 * whose current ranked win streak is >= BOUNTY_THRESHOLD has a bounty on their
 * head: the leaderboard / profile flags them, and whoever ends the streak earns
 * the "Giant Slayer" title (granted in the match-resolution path).
 *
 * The streak is the count of LEADING wins among a player's most recent ranked
 * (non-practice) results — a loss OR a tie breaks it. This is the exact rule
 * utils/titles.ts already uses for the streak titles (Unstoppable at 5, etc.),
 * just computed in one batched query so a whole leaderboard page is one round
 * trip instead of N.
 *
 * Read from match_results, so inside a resolution transaction you get each
 * player's PRE-match streak as long as you call it BEFORE this match's
 * match_results rows are written.
 */
import pool from '../db/pool';

/** A streak at or above this puts a bounty on the player. Matches the
 *  'unstoppable' title threshold so the two stay in lockstep. */
export const BOUNTY_THRESHOLD = 5;

type DB = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/** Map of userId -> current win streak for the given users (0 if none). */
export async function computeWinStreaks(userIds: string[], db: DB = pool): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return out;
  for (const id of ids) out.set(id, 0);

  const { rows } = await db.query(
    `WITH ordered AS (
       SELECT mp.user_id,
              (mp.side = mr.winner_side) AS won,   -- tie => winner_side NULL => NULL (a break)
              ROW_NUMBER() OVER (
                PARTITION BY mp.user_id
                ORDER BY mr.created_at DESC, mr.match_id DESC
              ) AS rn
         FROM match_results mr
         JOIN match_players mp ON mp.match_id = mr.match_id AND mp.user_id = ANY($1::uuid[])
         JOIN matches m        ON m.match_id = mr.match_id AND m.is_practice = false
     ),
     breaks AS (
       SELECT user_id, MIN(rn) AS first_break
         FROM ordered
        WHERE won IS DISTINCT FROM true       -- first loss/tie from the top
        GROUP BY user_id
     )
     SELECT o.user_id,
            CASE WHEN b.first_break IS NULL THEN COUNT(*)::int    -- all results are wins
                 ELSE (b.first_break - 1)::int END AS streak      -- leading wins before the break
       FROM ordered o
       LEFT JOIN breaks b ON b.user_id = o.user_id
      GROUP BY o.user_id, b.first_break`,
    [ids],
  );
  for (const r of rows) out.set(r.user_id, Number(r.streak) || 0);
  return out;
}

/** Attach `win_streak` + `bounty` to a set of rows that carry a `user_id`.
 *  Mutates and returns the same rows for convenience. */
export async function attachBounties<T extends { user_id: string }>(rows: T[], db: DB = pool): Promise<T[]> {
  if (!rows.length) return rows;
  const streaks = await computeWinStreaks(rows.map((r) => r.user_id), db);
  for (const r of rows as any[]) {
    const s = streaks.get(r.user_id) ?? 0;
    r.win_streak = s;
    r.bounty = s >= BOUNTY_THRESHOLD;
  }
  return rows;
}
