import pool from '../db/pool';

/**
 * Background cleanup job: cancels in-progress matches that have been idle
 * for over 24 hours. "Idle" = no activity (round creation, shot tracking,
 * score progress) on any of the match's players for the full window.
 *
 * Cancelled matches:
 *   • disappear from the live "active round" lookup
 *   • don't count toward stats, handicap, or ELO (those filter on completed)
 *   • stay in the DB for audit / debug — `cancelled = true` is the marker
 *
 * Designed to run every hour. Cheap query on a small index.
 */
export async function cancelStaleMatches() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE matches m
          SET cancelled = TRUE
        WHERE m.completed = FALSE
          AND m.cancelled = FALSE
          AND m.is_practice = FALSE
          -- Most recent signal of life across all players in this match.
          -- If even one player has done anything in the last 24h, keep it.
          AND GREATEST(
                m.created_at,
                COALESCE((SELECT MAX(r.created_at)
                            FROM rounds r WHERE r.match_id = m.match_id), m.created_at),
                COALESCE((SELECT MAX(s.recorded_at)
                            FROM shots s WHERE s.match_id = m.match_id), m.created_at)
              ) < NOW() - INTERVAL '24 hours'`
    );
    if (rowCount && rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[cleanup] Cancelled ${rowCount} stale match${rowCount === 1 ? '' : 'es'}.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cleanup] cancelStaleMatches failed:', err);
  }
}

/**
 * Pairing pass — scans every unmatched, non-practice, non-cancelled match
 * and tries to pair it against another waiting match of the same type/format/
 * num_holes/team-size. Runs on a short interval so duos and squads that
 * weren't paired at creation time (e.g. the opponent was created later)
 * still find each other within a minute or two.
 *
 * Each successful pair merges the older match into the newer one (insert
 * older's players as side 2 of newer, migrate invites and rounds, mark older
 * as superseded). The MatchFoundWatcher on each phone notices the
 * `has_opponent` flag flip on its next /matches poll and fires the VS intro.
 */
export async function runPairingPass() {
  try {
    // Find all currently-unpaired open matches, oldest first so we pair the
    // longest-waiting matches before fresh ones.
    const { rows: candidates } = await pool.query(
      `SELECT m.match_id, m.match_type, m.format, m.num_holes, m.created_at
         FROM matches m
        WHERE m.completed = false
          AND m.cancelled = false
          AND m.is_practice = false
          AND m.superseded_by_match_id IS NULL
          AND m.created_at > NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp
            WHERE mp.match_id = m.match_id AND mp.side != 1
          )
        ORDER BY m.created_at ASC`
    );

    const paired = new Set<string>();   // match_ids already used this pass

    for (const m of candidates) {
      if (paired.has(m.match_id)) continue;

      // Look for an opposing match with matching params, ELO-closest first.
      // Excludes matches that have any player in common with this match.
      const { rows: opps } = await pool.query(
        `SELECT m2.match_id
           FROM matches m2,
                matches m1
          WHERE m1.match_id = $1
            AND m2.match_id != $1
            AND m2.completed = false
            AND m2.cancelled = false
            AND m2.is_practice = false
            AND m2.superseded_by_match_id IS NULL
            AND m2.match_type = $2
            AND m2.format = $3
            AND m2.num_holes = $4
            AND m2.created_at > NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM match_players mp_opp
              WHERE mp_opp.match_id = m2.match_id AND mp_opp.side != 1
            )
            -- No shared player.
            AND NOT EXISTS (
              SELECT 1 FROM match_players mp_a
              JOIN match_players mp_b
                ON mp_a.user_id = mp_b.user_id
              WHERE mp_a.match_id = $1 AND mp_b.match_id = m2.match_id
            )
            -- No shared team (clan_id stored on match).
            AND NOT (m1.clan_id IS NOT NULL AND m1.clan_id = m2.clan_id)
            -- No shared clan member (e.g. teammate created a parallel match).
            AND NOT EXISTS (
              SELECT 1
                FROM match_players mp_a
                JOIN clan_members cm_a ON cm_a.user_id = mp_a.user_id
                JOIN clan_members cm_b ON cm_b.clan_id = cm_a.clan_id
                JOIN match_players mp_b ON mp_b.user_id = cm_b.user_id
               WHERE mp_a.match_id = $1
                 AND mp_b.match_id = m2.match_id
            )
          ORDER BY ABS(
            COALESCE((SELECT AVG(u.elo) FROM match_players mp_x
                      JOIN users u ON u.user_id = mp_x.user_id
                      WHERE mp_x.match_id = $1), 1200) -
            COALESCE((SELECT AVG(u.elo) FROM match_players mp_y
                      JOIN users u ON u.user_id = mp_y.user_id
                      WHERE mp_y.match_id = m2.match_id), 1200)
          )
          LIMIT 1`,
        [m.match_id, m.match_type, m.format, m.num_holes]
      );

      if (!opps.length || paired.has(opps[0].match_id)) continue;

      const oppId = opps[0].match_id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Move opponent's players into m as side 2.
        await client.query(
          `INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
           SELECT $1, user_id, teebox_id, 2, strokes, completed
             FROM match_players
            WHERE match_id = $2
            ON CONFLICT (match_id, user_id) DO NOTHING`,
          [m.match_id, oppId]
        );
        await client.query(
          `UPDATE match_invites SET match_id = $1
            WHERE match_id = $2 AND status = 'pending'`,
          [m.match_id, oppId]
        );
        await client.query(
          `UPDATE rounds SET match_id = $1 WHERE match_id = $2`,
          [m.match_id, oppId]
        );
        await client.query(
          `UPDATE matches SET completed = true, superseded_by_match_id = $1
            WHERE match_id = $2`,
          [m.match_id, oppId]
        );
        await client.query('COMMIT');
        paired.add(m.match_id);
        paired.add(oppId);
        console.log(`[pair] merged ${oppId} into ${m.match_id} (${m.match_type})`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[pair] merge failed', err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('[pair] runPairingPass failed:', err);
  }
}

let cleanupHandle: ReturnType<typeof setInterval> | null = null;
let pairingHandle: ReturnType<typeof setInterval> | null = null;

export function startCleanupSchedule() {
  if (cleanupHandle) return;
  // Run once on boot to catch anything that drifted while the server was
  // down, then every hour thereafter.
  cancelStaleMatches();
  cleanupHandle = setInterval(cancelStaleMatches, 60 * 60 * 1000);

  // Pairing runs more frequently than cleanup — every minute. Cheap query
  // (filtered by indexed columns + a small subset of recent matches).
  runPairingPass();
  pairingHandle = setInterval(runPairingPass, 60 * 1000);
}
