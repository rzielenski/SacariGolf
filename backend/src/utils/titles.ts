/**
 * Title awarding. Every title in the catalog is DERIVABLE from a player's
 * existing stats (rating, matches, wins, shots, rounds, cup wins), so the same
 * pass both awards new titles live and backfills the whole player base on boot.
 * Idempotent: re-running only ever adds titles, never removes them.
 *
 * Wired from utils/cleanup.ts: a periodic sweep over recently-active players
 * plus a one-time backfill on boot.
 */
import pool from '../db/pool';

/** Award any title this user newly qualifies for. */
export async function evaluateTitles(userId: string): Promise<void> {
  const { rows: ur } = await pool.query(
    `SELECT u.elo, u.total_matches, u.total_wins,
            (SELECT COUNT(*) FROM shots s WHERE s.user_id = u.user_id) AS shots,
            (SELECT COUNT(DISTINCT t.course_id)
               FROM rounds r
               JOIN matches m  ON m.match_id = r.match_id AND m.completed = true
               JOIN teeboxes t ON t.teebox_id = r.teebox_id
              WHERE r.user_id = u.user_id) AS courses,
            EXISTS (SELECT 1 FROM weekly_cup_winners w WHERE w.user_id = u.user_id) AS cup_champ
       FROM users u
      WHERE u.user_id = $1 AND u.is_bot = false`,
    [userId],
  );
  if (!ur.length) return;
  const u = ur[0];
  const elo = Number(u.elo), matches = Number(u.total_matches), wins = Number(u.total_wins);
  const shots = Number(u.shots), courses = Number(u.courses);
  const winRate = matches > 0 ? wins / matches : 0;

  // Eagles / aces / albatrosses, per-hole score vs that hole's par. The +9
  // offset realigns a back-nine round's hole_scores array onto holes 10-18.
  const { rows: hr } = await pool.query(
    `WITH hole_results AS (
       SELECT hs.score::int AS score, h.par::int AS par
         FROM rounds r
         JOIN matches m  ON m.match_id = r.match_id AND m.completed = true
         JOIN teeboxes t ON t.teebox_id = r.teebox_id
         CROSS JOIN LATERAL unnest(r.hole_scores) WITH ORDINALITY AS hs(score, ord)
         JOIN holes h ON h.teebox_id = r.teebox_id
           AND h.hole_num = hs.ord + (CASE WHEN m.holes_subset = 'back' THEN 9 ELSE 0 END)
        WHERE r.user_id = $1 AND hs.score IS NOT NULL AND hs.score > 0
     )
     SELECT COUNT(*) FILTER (WHERE score = 1)       AS aces,
            COUNT(*) FILTER (WHERE score = par - 2) AS eagles,
            COUNT(*) FILTER (WHERE score = par - 3) AS albatrosses
       FROM hole_results`,
    [userId],
  );
  const aces = Number(hr[0]?.aces ?? 0);
  const eagles = Number(hr[0]?.eagles ?? 0);
  const albatrosses = Number(hr[0]?.albatrosses ?? 0);

  // Current win streak: leading wins among the most recent ranked results
  // (a loss or tie — winner_side null → `won` is NULL → falsy — breaks it).
  const { rows: recent } = await pool.query(
    `SELECT (mp.side = mr.winner_side) AS won
       FROM match_results mr
       JOIN match_players mp ON mp.match_id = mr.match_id AND mp.user_id = $1
       JOIN matches m        ON m.match_id = mr.match_id AND m.is_practice = false
      ORDER BY mr.created_at DESC
      LIMIT 30`,
    [userId],
  );
  let streak = 0;
  for (const r of recent) { if (r.won) streak++; else break; }

  const earned: string[] = [];
  if (wins >= 1) earned.push('first_blood');
  if (streak >= 3) earned.push('dominating');
  if (streak >= 5) earned.push('unstoppable');
  if (streak >= 8) earned.push('godlike');
  if (streak >= 12) earned.push('legendary');
  if (elo >= 1500) earned.push('challenger');
  if (elo >= 1300 && matches < 30) earned.push('prodigy');
  if (matches >= 50) earned.push('veteran');
  if (matches >= 20 && winRate >= 0.7) earned.push('smurf');
  if (eagles >= 5) earned.push('eagle_hunter');
  if (albatrosses >= 1) earned.push('albatross');
  if (aces >= 1) earned.push('ace');
  if (shots >= 100) earned.push('iron_tour');
  if (courses >= 10) earned.push('globetrotter');
  if (u.cup_champ) earned.push('cup_champion');

  if (!earned.length) return;
  await pool.query(
    `INSERT INTO user_titles (user_id, title_id)
     SELECT $1, t FROM unnest($2::text[]) AS t
     ON CONFLICT (user_id, title_id) DO NOTHING`,
    [userId, earned],
  );
}

/** Evaluate titles for everyone with a resolved match in the last 2 days —
 *  the post-resolution sweep (cheap; runs on the cleanup tick). */
export async function evaluateRecentTitles(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT DISTINCT mp.user_id
       FROM match_results mr
       JOIN match_players mp ON mp.match_id = mr.match_id
       JOIN users u          ON u.user_id = mp.user_id AND u.is_bot = false
      WHERE mr.created_at > NOW() - INTERVAL '2 days'`,
  );
  for (const r of rows) { try { await evaluateTitles(r.user_id); } catch { /* best-effort */ } }
  return rows.length;
}

/** Backfill every existing non-bot player once (boot). */
export async function backfillTitles(): Promise<number> {
  const { rows } = await pool.query(`SELECT user_id FROM users WHERE is_bot = false`);
  for (const r of rows) { try { await evaluateTitles(r.user_id); } catch { /* best-effort */ } }
  return rows.length;
}
