import pool from '../db/pool';

/**
 * Postgres advisory lock around a cron tick so two server instances can't
 * run the same job concurrently (double-pairing a match, double-resolving
 * a cup). Single-instance today, but Railway redeploys briefly overlap
 * old + new processes, and horizontal scaling would silently double every
 * cron without this.
 *
 * Lock + unlock MUST happen on the same session: advisory locks are
 * per-connection, and pool.query can hand unlock a different connection,
 * leaking the lock until that session dies. So we pin one client.
 */
async function withCronLock(key: number, fn: () => Promise<void>): Promise<void> {
  let client;
  try {
    client = await pool.connect();
  } catch {
    return; // pool exhausted / DB down — skip the tick, next one retries
  }
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS got', [key],
    );
    if (!rows[0]?.got) return; // another instance is mid-tick
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => { });
    }
  } catch (err) {
    console.error(`[cron-lock ${key}] tick failed:`, err);
  } finally {
    client.release();
  }
}

// One stable key per job — arbitrary but never reused across jobs.
const LOCK_STALE_MATCHES = 42101;
const LOCK_PAIRING       = 42102;
const LOCK_FEED_BACKFILL = 42103;
const LOCK_WEEKLY_CUP    = 42104;

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
          -- Never cancel a LINKED match. It already has an opponent (its
          -- paired match), so it's matched, not abandoned-waiting.
          -- Cancelling one half would dangle the other's paired_match_id.
          AND m.paired_match_id IS NULL
          -- NEVER cancel a match where a player has already FINISHED their
          -- round. A duo/squad that completed its round but is still
          -- waiting for an opponent represents real, played golf — the
          -- previous logic silently cancelled it after 24h of "idle"
          -- (idle only meant no NEW round/shot activity, not "nobody
          -- played"), making the round vanish from My Matches. Now those
          -- sit visibly as "awaiting opponent" instead of disappearing.
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp
            WHERE mp.match_id = m.match_id AND mp.completed = TRUE
          )
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
          -- Arena (ffa) matches are invite-only by design — the host
          -- creates the match and personally invites everyone. Excluding
          -- ffa here was the missing guard: two Arena hosts each sitting
          -- on their match waiting for invitees were getting auto-merged
          -- by this pass, slamming one host onto another's match as
          -- side=2 and confusing both sets of invitees.
          AND m.match_type <> 'ffa'
          AND m.superseded_by_match_id IS NULL
          AND m.created_at > NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp
            WHERE mp.match_id = m.match_id AND mp.side != 1
          )
          -- Direct-challenge grace: hold a SOLO match open while it has an
          -- active challenge invite (a friend was challenged within the last
          -- 3 days). After the window lapses it rejoins the pool and this pass
          -- pairs it with the best available option.
          AND (
            m.match_type <> 'solo'
            OR NOT EXISTS (
              SELECT 1 FROM match_invites mi
              WHERE mi.match_id = m.match_id AND mi.status = 'pending'
                AND mi.created_at > NOW() - INTERVAL '3 days'
            )
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
            -- Belt-and-suspenders: the candidates query above already
            -- excludes ffa so $2 will never be 'ffa' on this branch, but
            -- the explicit filter here keeps any future change to the
            -- candidate query from accidentally re-introducing the bug.
            AND m2.match_type <> 'ffa'
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
            -- Same-team protection (DUO / SQUAD only): clanmate filtering
            -- prevents a clan from being pitted against itself. Solo
            -- matches between clanmates are intentionally allowed — two
            -- friends in the same clan should still be able to 1v1.
            AND (
              m1.match_type = 'solo'
              OR (
                NOT (m1.clan_id IS NOT NULL AND m1.clan_id = m2.clan_id)
                AND NOT EXISTS (
                  SELECT 1
                    FROM match_players mp_a
                    JOIN clan_members cm_a ON cm_a.user_id = mp_a.user_id
                    JOIN clan_members cm_b ON cm_b.clan_id = cm_a.clan_id
                    JOIN match_players mp_b ON mp_b.user_id = cm_b.user_id
                   WHERE mp_a.match_id = $1
                     AND mp_b.match_id = m2.match_id
                )
              )
            )
            -- Never grab a SOLO opponent match that has an active challenge.
            AND (
              $2 <> 'solo'
              OR NOT EXISTS (
                SELECT 1 FROM match_invites mi
                WHERE mi.match_id = m2.match_id AND mi.status = 'pending'
                  AND mi.created_at > NOW() - INTERVAL '3 days'
              )
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

    // ── Linked pairing (duo/squad with a shared player) ───────────────
    // The merge pass above refuses any opponent that shares a player,
    // because merging two matches into one can't put a player on both
    // sides (match_players PK + rounds UNIQUE are both (match_id,user_id)).
    // Those matches fall through to here and get LINKED instead: both stay
    // separate, paired_match_id points each at the other, every player
    // plays their own round, and resolution compares the two teams. This
    // is what lets the same player anchor two teams across two matches.
    //
    // The 30-day window (vs 24h for merge) also backfills the current
    // waiting backlog: a duo that finished its round but never found an
    // opponent is kept alive by the stale-match cron, so it can be days or
    // weeks old by the time this rule ships. When the linked pair is
    // already fully played, runLinkedPairingPass resolves it on the spot.
    await runLinkedPairingPass(paired);
  } catch (err) {
    console.error('[pair] runPairingPass failed:', err);
  }
}

/**
 * Link duo/squad matches that share a player but aren't the same roster.
 * `alreadyPaired` carries the match_ids the merge pass consumed this tick
 * so we never touch them. Idempotent: only ever links matches whose
 * paired_match_id is still NULL, under a FOR UPDATE recheck.
 */
async function runLinkedPairingPass(alreadyPaired: Set<string>): Promise<void> {
  const { rows: candidates } = await pool.query(
    `SELECT m.match_id, m.match_type, m.format, m.num_holes
       FROM matches m
      WHERE m.completed = false
        AND m.cancelled = false
        AND m.is_practice = false
        AND m.match_type IN ('duo','squad')
        AND m.superseded_by_match_id IS NULL
        AND m.paired_match_id IS NULL
        AND m.created_at > NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM match_players mp WHERE mp.match_id = m.match_id AND mp.side != 1
        )
      ORDER BY m.created_at ASC`
  );

  const linked = new Set<string>();
  for (const m of candidates) {
    if (linked.has(m.match_id) || alreadyPaired.has(m.match_id)) continue;

    const { rows: opps } = await pool.query(
      `SELECT m2.match_id
         FROM matches m2
        WHERE m2.match_id != $1
          AND m2.completed = false
          AND m2.cancelled = false
          AND m2.is_practice = false
          AND m2.superseded_by_match_id IS NULL
          AND m2.paired_match_id IS NULL
          AND m2.match_type = $2
          AND m2.format = $3
          AND m2.num_holes = $4
          AND m2.created_at > NOW() - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp WHERE mp.match_id = m2.match_id AND mp.side != 1
          )
          -- Must share at least one player — the case the merge pass skips.
          AND EXISTS (
            SELECT 1 FROM match_players a
            JOIN match_players b ON a.user_id = b.user_id
            WHERE a.match_id = $1 AND b.match_id = m2.match_id
          )
          -- ...but NOT be the same roster (a duo of {A,B} vs {A,B} is a
          -- mirror match that always ties — pointless). Require at least
          -- one player in m1 who isn't in m2.
          AND EXISTS (
            SELECT 1 FROM match_players a
            WHERE a.match_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM match_players b
                WHERE b.match_id = m2.match_id AND b.user_id = a.user_id
              )
          )
          -- Same-clan guard, ignoring the shared player(s): don't pit two
          -- DIFFERENT clanmates against each other. A shared player
          -- trivially shares a clan with themselves, so exclude equal ids.
          AND NOT EXISTS (
            SELECT 1
              FROM match_players mp_a
              JOIN clan_members cm_a ON cm_a.user_id = mp_a.user_id
              JOIN clan_members cm_b ON cm_b.clan_id = cm_a.clan_id
              JOIN match_players mp_b ON mp_b.user_id = cm_b.user_id
             WHERE mp_a.match_id = $1
               AND mp_b.match_id = m2.match_id
               AND mp_a.user_id != mp_b.user_id
          )
        ORDER BY ABS(
          COALESCE((SELECT AVG(u.elo) FROM match_players mpx
                    JOIN users u ON u.user_id = mpx.user_id
                    WHERE mpx.match_id = $1), 1200) -
          COALESCE((SELECT AVG(u.elo) FROM match_players mpy
                    JOIN users u ON u.user_id = mpy.user_id
                    WHERE mpy.match_id = m2.match_id), 1200)
        )
        LIMIT 1`,
      [m.match_id, m.match_type, m.format, m.num_holes]
    );

    if (!opps.length) continue;
    const oppId = opps[0].match_id as string;
    if (linked.has(oppId) || alreadyPaired.has(oppId)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check both are still unpaired + open under a row lock so two
      // ticks (or instances) can't link the same match twice.
      const { rows: chk } = await client.query(
        `SELECT match_id FROM matches
          WHERE match_id IN ($1, $2)
            AND paired_match_id IS NULL
            AND completed = false
            AND cancelled = false
          FOR UPDATE`,
        [m.match_id, oppId]
      );
      if (chk.length === 2) {
        await client.query(`UPDATE matches SET paired_match_id = $2 WHERE match_id = $1`, [m.match_id, oppId]);
        await client.query(`UPDATE matches SET paired_match_id = $1 WHERE match_id = $2`, [m.match_id, oppId]);
        // If BOTH teams already finished their rounds — a finished-and-
        // waiting backlog pair we just connected — resolve right now in the
        // same transaction (atomic with the link). resolveLinkedPair is a
        // no-op when either side isn't fully played, so a fresh link just
        // waits for the next score submit. If it throws, the outer catch
        // rolls back the link too, so we never leave a half-resolved pair.
        const { resolveLinkedPair } = await import('../routes/matches');
        await resolveLinkedPair(client, m.match_id, oppId);
        await client.query('COMMIT');
        linked.add(m.match_id);
        linked.add(oppId);
        console.log(`[pair] linked ${m.match_id} <-> ${oppId} (${m.match_type})`);
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[pair] link failed', err);
    } finally {
      client.release();
    }
  }
}

/**
 * Backfill round-posts for every completed non-practice match that doesn't
 * already have one. The auto-post hooks in `resolveElo` / `resolveEloFFA`
 * cover the standard win/loss/tie completion paths, but matches can be
 * marked completed by other code paths (auto-pair supersession, forfeits
 * with edge-case timing, cleanup, etc.) where the hook might not fire.
 * This sweep guarantees the feed eventually picks them up.
 *
 * Idempotent via the NOT EXISTS subquery — only inserts what's missing,
 * so re-running every 5 min costs essentially nothing once the table is
 * caught up. Inherits each post's created_at from the match result (or
 * match creation as fallback) so the timeline reflects when the round
 * actually happened, not when the backfill ran.
 */
/** Batch cap per tick. Prevents a sudden flood (e.g. a one-time DB
 *  migration that completes 10k matches at once) from locking the posts
 *  table for an extended write. At 200 rows / 5 min the catch-up speed
 *  is ~58k rows / day which clears any realistic backlog quickly. */
const BACKFILL_BATCH_SIZE = 200;

export async function backfillRoundPosts() {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO posts (user_id, kind, match_id, created_at)
       SELECT mp.user_id, 'round', mp.match_id,
              COALESCE(mr.created_at, m.created_at)
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.match_id
       LEFT JOIN match_results mr ON mr.match_id = m.match_id
       WHERE m.completed = TRUE
         AND m.is_practice = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM posts p
           WHERE p.user_id  = mp.user_id
             AND p.match_id = m.match_id
             AND p.kind     = 'round'
         )
       ORDER BY m.created_at DESC
       LIMIT $1`,
      [BACKFILL_BATCH_SIZE]
    );
    if (rowCount && rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[feed-backfill] Backfilled ${rowCount} round post${rowCount === 1 ? '' : 's'}.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[feed-backfill] backfillRoundPosts failed:', err);
  }
}

// Module-scoped handles so we can stop + restart cleanly during HMR / hot
// reload — without this, every module re-evaluation would leak the prior
// intervals into the background and double up. Production restarts wipe
// the process state so this only matters in dev, but it's the kind of
// drift that takes hours to track down once it surfaces.
let cleanupHandle: ReturnType<typeof setInterval> | null = null;
let pairingHandle: ReturnType<typeof setInterval> | null = null;
let feedBackfillHandle: ReturnType<typeof setInterval> | null = null;
let weeklyCupHandle: ReturnType<typeof setInterval> | null = null;

export function startCleanupSchedule() {
  // Re-entrancy: stop any previously-running intervals first. If the module
  // is hot-reloaded the existing handles get cleared before fresh ones are
  // installed below, so we end up with exactly one of each tick — not two.
  stopCleanupSchedule();

  // Run once on boot to catch anything that drifted while the server was
  // down, then every hour thereafter. Every tick takes its advisory lock
  // so overlapping deploys / multiple instances can't double-run a job.
  const staleTick   = () => withCronLock(LOCK_STALE_MATCHES, cancelStaleMatches);
  const pairingTick = () => withCronLock(LOCK_PAIRING, runPairingPass);
  const feedTick    = () => withCronLock(LOCK_FEED_BACKFILL, backfillRoundPosts);
  const cupTick     = () => withCronLock(LOCK_WEEKLY_CUP, weeklyCupTick);

  staleTick();
  cleanupHandle = setInterval(staleTick, 60 * 60 * 1000);

  // Pairing runs more frequently than cleanup — every minute. Cheap query
  // (filtered by indexed columns + a small subset of recent matches).
  pairingTick();
  pairingHandle = setInterval(pairingTick, 60 * 1000);

  // Feed backfill — every 5 min. Catches any round that completed through
  // a path the auto-post hook missed (forfeits, supersession merges, etc.)
  // so the home feed always reflects everyone's recent rounds.
  feedTick();
  feedBackfillHandle = setInterval(feedTick, 5 * 60 * 1000);

  // Weekly Sacari Cup — ensure the current week's cup exists and resolve
  // any finished cup that hasn't paid out yet. 60-second cadence keeps
  // the Sunday-23:59 → Monday-00:00 handover crisp without burning DB
  // (the queries hit a unique index + a tiny status='active' set).
  cupTick();
  weeklyCupHandle = setInterval(cupTick, 60 * 1000);
}

async function weeklyCupTick(): Promise<void> {
  try {
    const { ensureCurrentCup, resolveFinishedCups } = await import('./weeklyCup');
    await ensureCurrentCup();
    await resolveFinishedCups();
  } catch (err) {
    console.error('[weekly-cup] tick failed:', err);
  }
  // Same cadence as the cup tick — also ensures the current calendar
  // month's season exists + the tier ladder is seeded.
  try {
    const { ensureCurrentSeason } = await import('./seasonPass');
    await ensureCurrentSeason();
  } catch (err) {
    console.error('[season-pass] tick failed:', err);
  }
}

/** Stop all background tasks. Idempotent; safe to call multiple times. */
export function stopCleanupSchedule() {
  if (cleanupHandle) { clearInterval(cleanupHandle); cleanupHandle = null; }
  if (pairingHandle) { clearInterval(pairingHandle); pairingHandle = null; }
  if (feedBackfillHandle) { clearInterval(feedBackfillHandle); feedBackfillHandle = null; }
  if (weeklyCupHandle) { clearInterval(weeklyCupHandle); weeklyCupHandle = null; }
}
