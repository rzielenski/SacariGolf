/**
 * Creator-league helpers: auto-posting a member's solo round onto their league
 * leaderboard, writing league-feed events, and the recurring-season tick that
 * auto-crowns a champion and resets a league weekly / monthly.
 *
 * Scoring reuses the tournament machinery: a creator league IS a tournament, and
 * its leaderboard aggregates rounds from matches linked via matches.tournament_id.
 * Auto-post simply links a finished solo match to the member's league, so the
 * round counts with zero new scoring tables. A `season_started_at` cutoff scopes
 * each season; the reset just records the champion and advances the cutoff.
 */
import pool from '../db/pool';

/** Postgres client or pool — anything with .query. */
type Exec = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** "+N" / "E" / "-N" from an 18-hole-equivalent to-par. */
function fmtToPar(v: number | null | undefined): string {
  if (v == null) return '';
  const n = Math.round(Number(v));
  return n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`;
}

/** Write a system event to a league's feed (best-effort; never throws to the caller). */
export async function postLeagueEvent(exec: Exec, leagueId: string, userId: string | null, body: string): Promise<void> {
  try {
    await exec.query(
      `INSERT INTO league_posts (league_id, user_id, kind, body) VALUES ($1, $2, 'event', $3)`,
      [leagueId, userId, body.slice(0, 300)],
    );
  } catch (e) {
    console.error('[league] postLeagueEvent failed', e);
  }
}

/**
 * Link a member's just-finished SOLO round to the creator league they've opted
 * into auto-posting for, so it lands on that league's leaderboard. Only links an
 * UNLINKED match (a round already counting somewhere is left alone). Fires a
 * "beat the creator" feed event when the round clears the league's target.
 * Runs inside the submit transaction (pass the same client).
 */
export async function autoPostSoloRoundToLeague(
  client: Exec, userId: string, matchId: string, roundId: string,
): Promise<void> {
  // Gate on the match itself: only an unlinked, non-practice SOLO round auto-posts.
  const { rows: m } = await client.query(
    `SELECT tournament_id, match_type, is_practice FROM matches WHERE match_id = $1`, [matchId],
  );
  if (!m.length) return;
  if (m[0].tournament_id) return;          // already counts somewhere — don't steal it
  if (m[0].match_type !== 'solo') return;  // only solo rounds auto-post
  if (m[0].is_practice) return;            // never practice rounds

  const { rows: lg } = await client.query(
    `SELECT t.tournament_id, t.target_to_par, t.league_type, t.handicap_adjusted
       FROM tournament_players tp
       JOIN tournaments t ON t.tournament_id = tp.tournament_id
      WHERE tp.user_id = $1 AND tp.auto_post = TRUE
        AND t.league_type IN ('creator', 'buddies') AND t.status = 'active'
      ORDER BY tp.joined_at ASC
      LIMIT 1`,
    [userId],
  );
  if (!lg.length) return;
  const league = lg[0];

  await client.query(`UPDATE matches SET tournament_id = $1 WHERE match_id = $2`, [league.tournament_id, matchId]);

  // Feed moment for the round (best-effort — the leaderboard already updated).
  // A beat-the-creator league celebrates clearing the target; a buddies league
  // just keeps the feed alive with each posted round, shown NET when the league
  // is handicap-adjusted so the number matches the standings.
  const { rows: rr } = await client.query(
    `SELECT r.normalized_to_par, COALESCE(u.handicap_index, 0) AS hcp, u.username
       FROM rounds r JOIN users u ON u.user_id = r.user_id
      WHERE r.round_id = $1`,
    [roundId],
  );
  const info = rr[0];
  if (info && info.normalized_to_par != null) {
    const gross = Number(info.normalized_to_par);
    const name = info.username ?? 'A member';
    if (league.target_to_par != null && gross <= Number(league.target_to_par)) {
      await postLeagueEvent(client, league.tournament_id, userId, `🎯 ${name} beat the creator with ${fmtToPar(gross)}`);
    } else {
      const shown = league.handicap_adjusted ? Math.round(gross - Number(info.hcp)) : gross;
      await postLeagueEvent(
        client, league.tournament_id, userId,
        `⛳ ${name} posted ${fmtToPar(shown)}${league.handicap_adjusted ? ' net' : ''}`,
      );
    }
  }
}

/**
 * Recurring-season tick. For every active creator league whose reset_period has
 * elapsed since season_started_at, crown the season's best player (award the
 * tournament-champion cosmetic + a feed event), then advance the season cutoff
 * so the leaderboard starts fresh. Idempotent + instance-safe via a row lock.
 */
export async function runCreatorLeagueSeasons(): Promise<void> {
  try {
    const { rows: due } = await pool.query(
      `SELECT tournament_id
         FROM tournaments
        WHERE league_type IN ('creator', 'buddies')
          AND status = 'active'
          AND reset_period IN ('weekly', 'monthly')
          AND season_started_at IS NOT NULL
          AND season_started_at < NOW() - (CASE reset_period
                WHEN 'weekly' THEN INTERVAL '7 days' ELSE INTERVAL '1 month' END)`,
    );

    for (const d of due) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: chk } = await client.query(
          `SELECT season_started_at, reset_period, scoring, handicap_adjusted, league_type
             FROM tournaments WHERE tournament_id = $1 FOR UPDATE`,
          [d.tournament_id],
        );
        if (!chk.length) { await client.query('ROLLBACK'); continue; }
        const interval = chk[0].reset_period === 'weekly' ? '7 days' : '1 month';
        const { rows: stillDue } = await client.query(
          `SELECT (season_started_at < NOW() - $2::interval) AS due FROM tournaments WHERE tournament_id = $1`,
          [d.tournament_id, interval],
        );
        if (!stillDue[0]?.due) { await client.query('ROLLBACK'); continue; }
        const seasonStart = chk[0].season_started_at;

        // Crown by NET when the league is handicap-adjusted, matching how its
        // leaderboard ranks (server-derived expr, safe to interpolate).
        const netExpr = chk[0].handicap_adjusted
          ? '(r.normalized_to_par - COALESCE(u.handicap_index, 0))'
          : 'r.normalized_to_par';
        const order = chk[0].scoring === 'total_strokes' ? `SUM(${netExpr})` : `MIN(${netExpr})`;
        const { rows: top } = await client.query(
          `SELECT u.user_id, u.username
             FROM tournament_players tp
             JOIN users u ON u.user_id = tp.user_id
             JOIN matches m ON m.tournament_id = tp.tournament_id AND (m.completed IS NULL OR m.completed = true)
             JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
            WHERE tp.tournament_id = $1 AND u.is_bot = false AND r.normalized_to_par IS NOT NULL
              AND r.created_at >= $2
            GROUP BY u.user_id, u.username
            ORDER BY ${order} ASC
            LIMIT 1`,
          [d.tournament_id, seasonStart],
        );
        const winnerId: string | null = top[0]?.user_id ?? null;
        const winnerName: string | null = top[0]?.username ?? null;

        if (winnerId) {
          // Exclusive prize cosmetics are creator-league only. a buddies
          // champion gets the crown + bragging rights, not a scarce cosmetic
          // (else any 2-person league could mint them and dilute the pool).
          if (chk[0].league_type !== 'buddies') {
            await client.query(
              `INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
                 SELECT $1, c.cosmetic_id, $2 FROM cosmetics c
                  WHERE c.unlock_kind = 'tournament_winner' AND (c.unlock_data ->> 'place')::int = 1
               ON CONFLICT (user_id, cosmetic_id) DO NOTHING`,
              [winnerId, `league_${d.tournament_id}_season`],
            );
          }
          await postLeagueEvent(client, d.tournament_id, winnerId, `🏆 Season champion: ${winnerName}. A new season has begun.`);
        } else {
          await postLeagueEvent(client, d.tournament_id, null, 'A new season has begun.');
        }

        await client.query(
          `UPDATE tournaments
              SET last_champion_id = $2, last_champion_at = NOW(), season_started_at = NOW()
            WHERE tournament_id = $1`,
          [d.tournament_id, winnerId],
        );
        await client.query('COMMIT');
        console.log(`[league-season] reset ${d.tournament_id} (champion=${winnerName ?? 'none'})`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[league-season] reset failed', err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('[league-season] runCreatorLeagueSeasons failed:', err);
  }
}
