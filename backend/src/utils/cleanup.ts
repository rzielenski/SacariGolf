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
                COALESCE((SELECT MAX(st.updated_at)
                            FROM shot_tracks st WHERE st.match_id = m.match_id), m.created_at)
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

/** Hour-spaced interval handle so we can clear it on shutdown if needed. */
let cleanupHandle: ReturnType<typeof setInterval> | null = null;

export function startCleanupSchedule() {
  if (cleanupHandle) return;
  // Run once on boot to catch anything that drifted while the server was
  // down, then every hour thereafter.
  cancelStaleMatches();
  cleanupHandle = setInterval(cancelStaleMatches, 60 * 60 * 1000);
}
