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
const LOCK_ELO_RESET     = 42105;
const LOCK_UNPAIR        = 42106;
const LOCK_BOTS          = 42107;

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
          -- Fresh matches search for 24h; a match where a side already FINISHED
          -- keeps searching for up to 30 days (don't strand a played round
          -- whose opponent never showed). Abandoned, never-played matches stop
          -- at 24h (and get cancelled by the 3-day rule).
          AND m.created_at > NOW() - INTERVAL '30 days'
          AND (
            m.created_at > NOW() - INTERVAL '24 hours'
            OR EXISTS (
              SELECT 1 FROM match_players mpc
              WHERE mpc.match_id = m.match_id AND mpc.completed = true
            )
          )
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

      // Is THIS candidate already finished (a played round waiting for an
      // opponent)? Resolution only fires on a post-merge score submit, so two
      // already-finished matches must never merge each other (nobody would
      // submit again → the merged match would hang unresolved forever).
      const { rows: cf } = await pool.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE NOT completed) AS pending
           FROM match_players WHERE match_id = $1 AND side = 1`,
        [m.match_id],
      );
      const candidateFinished = Number(cf[0]?.total ?? 0) > 0 && Number(cf[0]?.pending ?? 0) === 0;

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
            AND m2.created_at > NOW() - INTERVAL '30 days'
            AND (
              m2.created_at > NOW() - INTERVAL '24 hours'
              OR EXISTS (
                SELECT 1 FROM match_players mpc2
                WHERE mpc2.match_id = m2.match_id AND mpc2.completed = true
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM match_players mp_opp
              WHERE mp_opp.match_id = m2.match_id AND mp_opp.side != 1
            )
            -- Never merge two already-finished matches (see candidateFinished):
            -- if this candidate is finished, the opponent must still have a
            -- round left to play so its submit resolves the merged match.
            AND (
              $5 = false
              OR EXISTS (
                SELECT 1 FROM match_players mpx
                WHERE mpx.match_id = m2.match_id AND mpx.completed = false
              )
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
                      WHERE mp_x.match_id = $1), 100) -
            COALESCE((SELECT AVG(u.elo) FROM match_players mp_y
                      JOIN users u ON u.user_id = mp_y.user_id
                      WHERE mp_y.match_id = m2.match_id), 100)
          )
          LIMIT 1`,
        [m.match_id, m.match_type, m.format, m.num_holes, candidateFinished]
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
          -- Share EXACTLY ONE player — the single anchor the rule allows.
          -- This count is symmetric, so it can't slip through in one
          -- direction the way a one-sided check could:
          --   0 shared → the normal merge pass's job, not linked here
          --   1 shared → the intended "same player on both teams" case
          --   2+ shared → the two groups are essentially the same team
          --               (including the identical-roster {A,B} vs {A,B}
          --               mirror) — never match them.
          AND (
            SELECT COUNT(*) FROM match_players a
            JOIN match_players b ON a.user_id = b.user_id
            WHERE a.match_id = $1 AND b.match_id = m2.match_id
          ) = 1
          -- NOTE: no same-clan guard here, on purpose. The regular merge
          -- pass uses one to avoid pitting a clan against itself in a real
          -- 4-distinct-player match. But the linked pass IS the deliberate
          -- shared-player case (teams {anchor,B} vs {anchor,C} — only three
          -- people), who in a small group are almost always clanmates. A
          -- clan guard here just blocks the exact pairing this rule exists
          -- to allow, so it's intentionally omitted.
        ORDER BY ABS(
          COALESCE((SELECT AVG(u.elo) FROM match_players mpx
                    JOIN users u ON u.user_id = mpx.user_id
                    WHERE mpx.match_id = $1), 100) -
          COALESCE((SELECT AVG(u.elo) FROM match_players mpy
                    JOIN users u ON u.user_id = mpy.user_id
                    WHERE mpy.match_id = m2.match_id), 100)
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
        await client.query(`UPDATE matches SET paired_match_id = $2, paired_at = NOW() WHERE match_id = $1`, [m.match_id, oppId]);
        await client.query(`UPDATE matches SET paired_match_id = $1, paired_at = NOW() WHERE match_id = $2`, [m.match_id, oppId]);
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

/** True when every player on a match has finished their round (and there is
 *  at least one player). A linked match is one team, so this is that team's
 *  "side complete" signal. */
async function sideComplete(client: any, matchId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE NOT completed) AS pending
       FROM match_players WHERE match_id = $1`,
    [matchId],
  );
  const total = Number(rows[0]?.total ?? 0);
  const pending = Number(rows[0]?.pending ?? 0);
  return total > 0 && pending === 0;
}

/**
 * Release linked pairs that have gone stale. If a match has been linked
 * (paired_match_id set) for more than 3 days and the pair still hasn't
 * resolved (one side never finished their round), un-pair both so the side
 * that DID finish can search for a fresh opponent. The side(s) that never
 * finished are cancelled (they abandoned) — that also stops the two from
 * simply re-linking to each other on the next pairing tick.
 *
 *   • both sides done (rare — would normally have resolved): un-pair + reopen
 *     both so the next pairing pass re-links and resolves them.
 *   • one side done: reopen the finished side (reset created_at so the pairing
 *     windows include it again), cancel the unfinished side.
 *   • neither done: cancel both — nobody played.
 *
 * Backfilled to the current backlog via matches.paired_at = created_at.
 */
export async function unpairStaleLinkedMatches() {
  try {
    const { rows: stale } = await pool.query(
      `SELECT m.match_id, m.paired_match_id
         FROM matches m
        WHERE m.paired_match_id IS NOT NULL
          AND m.completed = false
          AND m.cancelled = false
          AND m.is_practice = false
          AND m.paired_at IS NOT NULL
          AND m.paired_at < NOW() - INTERVAL '3 days'`,
    );

    const handled = new Set<string>();
    for (const row of stale) {
      const a = row.match_id as string;
      const b = row.paired_match_id as string;
      if (handled.has(a) || handled.has(b)) continue;
      handled.add(a); handled.add(b);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock both and re-verify they're still a mutually-linked, unresolved
        // pair (another tick / a late submit may have changed things).
        const { rows: chk } = await client.query(
          `SELECT match_id, paired_match_id, completed, cancelled
             FROM matches WHERE match_id IN ($1, $2) FOR UPDATE`,
          [a, b],
        );
        const ma = chk.find((r: any) => r.match_id === a);
        const mb = chk.find((r: any) => r.match_id === b);
        if (!ma || !mb
            || ma.paired_match_id !== b || mb.paired_match_id !== a
            || ma.completed || mb.completed || ma.cancelled || mb.cancelled) {
          await client.query('ROLLBACK');
          continue;
        }

        const aDone = await sideComplete(client, a);
        const bDone = await sideComplete(client, b);

        // Un-pair both.
        await client.query(
          `UPDATE matches SET paired_match_id = NULL, paired_at = NULL WHERE match_id IN ($1, $2)`,
          [a, b],
        );

        const reopen: string[] = [];
        const cancel: string[] = [];
        (aDone ? reopen : cancel).push(a);
        (bDone ? reopen : cancel).push(b);

        // Reopen finished side(s): reset created_at so the pairing windows
        // (merge 24h / linked 30d) treat them as freshly searching.
        if (reopen.length) {
          await client.query(
            `UPDATE matches SET created_at = NOW() WHERE match_id = ANY($1)`,
            [reopen],
          );
        }
        // Cancel abandoned side(s).
        if (cancel.length) {
          await client.query(
            `UPDATE matches SET cancelled = true WHERE match_id = ANY($1)`,
            [cancel],
          );
        }

        await client.query('COMMIT');
        console.log(`[unpair] released stale linked pair ${a} <-> ${b} (reopen=${reopen.length}, cancel=${cancel.length})`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[unpair] pair release failed', err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('[unpair] unpairStaleLinkedMatches failed:', err);
  }
}

/** Strip the side that never finished and promote the finished side to side 1,
 *  so a half-played MERGED match re-enters matchmaking for the player who
 *  actually played. The match keeps that player's completed round. */
async function reopenFinishedSide(client: any, matchId: string, keepSide: number, dropSide: number) {
  // Remove the no-show side's partial rounds + roster rows.
  await client.query(
    `DELETE FROM rounds
       WHERE match_id = $1
         AND user_id IN (SELECT user_id FROM match_players WHERE match_id = $1 AND side = $2)`,
    [matchId, dropSide],
  );
  await client.query(`DELETE FROM match_players WHERE match_id = $1 AND side = $2`, [matchId, dropSide]);
  if (keepSide !== 1) {
    await client.query(`UPDATE match_players SET side = 1 WHERE match_id = $1 AND side = $2`, [matchId, keepSide]);
  }
  // Reset the matchmaking clock so the pairing windows include it again.
  await client.query(`UPDATE matches SET created_at = NOW(), paired_at = NULL WHERE match_id = $1`, [matchId]);
}

/**
 * The general 3-day rule for non-linked matches. Any unresolved, non-practice
 * match older than 3 days:
 *   • one side finished, the other never played (e.g. a merged 1v1 where the
 *     opponent ghosted) → strip the no-show side and reopen the finished side
 *     so it searches for a NEW opponent (keeps the played round).
 *   • nobody finished → cancel it (a round not finished 3 days after it
 *     started is abandoned).
 *   • both finished but somehow unresolved → leave it for normal resolution.
 * Finished-but-waiting matches (a side played, no opponent yet) are left alone
 * here — the widened pairing window keeps them searchable.
 */
export async function reopenOrCancelStaleMatches() {
  try {
    const { rows } = await pool.query(
      `SELECT m.match_id
         FROM matches m
        WHERE m.completed = false
          AND m.cancelled = false
          AND m.is_practice = false
          AND m.paired_match_id IS NULL          -- linked pairs handled separately
          AND m.superseded_by_match_id IS NULL
          AND m.match_type <> 'ffa'              -- arena is invite-only
          AND m.created_at < NOW() - INTERVAL '3 days'`,
    );

    for (const row of rows) {
      const id = row.match_id as string;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: chk } = await client.query(
          `SELECT completed, cancelled FROM matches WHERE match_id = $1 FOR UPDATE`, [id],
        );
        if (!chk.length || chk[0].completed || chk[0].cancelled) { await client.query('ROLLBACK'); continue; }

        const { rows: sides } = await client.query(
          `SELECT side, COUNT(*) AS total, COUNT(*) FILTER (WHERE completed) AS done
             FROM match_players WHERE match_id = $1 GROUP BY side`, [id],
        );
        const s1 = sides.find((r: any) => Number(r.side) === 1);
        const s2 = sides.find((r: any) => Number(r.side) === 2);
        const side1Done = !!s1 && Number(s1.total) > 0 && Number(s1.done) === Number(s1.total);
        const side2Exists = !!s2 && Number(s2.total) > 0;
        const side2Done = side2Exists && Number(s2.done) === Number(s2.total);

        let action = 'skip';
        if (side2Exists) {
          if (side1Done && !side2Done) { await reopenFinishedSide(client, id, 1, 2); action = 'reopen side1'; }
          else if (side2Done && !side1Done) { await reopenFinishedSide(client, id, 2, 1); action = 'reopen side2'; }
          else if (!side1Done && !side2Done) { await client.query(`UPDATE matches SET cancelled = true WHERE match_id = $1`, [id]); action = 'cancel (neither finished)'; }
        } else {
          // No opponent ever attached.
          if (!side1Done) { await client.query(`UPDATE matches SET cancelled = true WHERE match_id = $1`, [id]); action = 'cancel (never finished)'; }
          else { await client.query(`UPDATE matches SET created_at = NOW() WHERE match_id = $1`, [id]); action = 'reopen (waiting)'; }
        }
        await client.query('COMMIT');
        if (action !== 'skip') console.log(`[stale-3d] ${id}: ${action}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[stale-3d] failed for', id, err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('[stale-3d] reopenOrCancelStaleMatches failed:', err);
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
       JOIN users u ON u.user_id = mp.user_id AND u.is_bot = FALSE
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
let unpairHandle: ReturnType<typeof setInterval> | null = null;
let botHandle: ReturnType<typeof setInterval> | null = null;
let pairingHandle: ReturnType<typeof setInterval> | null = null;
let feedBackfillHandle: ReturnType<typeof setInterval> | null = null;
let weeklyCupHandle: ReturnType<typeof setInterval> | null = null;
let seasonResetHandle: ReturnType<typeof setInterval> | null = null;

// ── Partial ELO reset at season rollover ──────────────────────────────
// Anchor + retention for the soft reset: at each new competitive season,
// every rating is pulled halfway back toward the new-player baseline:
//   new = ANCHOR + (elo - ANCHOR) * KEEP   (floored at ANCHOR)
// 100 = the users.elo starting value; 0.5 = "Standard" strength. Skill
// order is preserved (a higher rating still resets higher), but the
// spread compresses so each season is a fresh climb.
const ELO_RESET_ANCHOR = 100;
const ELO_RESET_KEEP = 0.5;

/**
 * Apply the partial ELO reset ONCE per season rollover.
 *
 * The competitive season id (e.g. "2026-summer") comes from seasons.ts.
 * We track the last season we reset for in app_config.elo_reset_season:
 *   • unset (first ever run) → record the CURRENT season as the baseline
 *     and do NOT reset. This is critical — it stops a deploy in the middle
 *     of a season from nuking everyone's ELO immediately. The reset only
 *     fires when the season id actually CHANGES afterward.
 *   • same as current → nothing to do.
 *   • different → a rollover happened → apply the reset to every user,
 *     then record the new season id.
 *
 * The whole thing runs under a FOR UPDATE lock on the config row (plus the
 * cron advisory lock), so overlapping instances can't double-apply it.
 */
async function applySeasonEloReset(): Promise<void> {
  const { currentSeason } = await import('../routes/seasons');
  const seasonId: string = currentSeason().id;

  const { rows } = await pool.query(
    `SELECT value FROM app_config WHERE key = 'elo_reset_season'`
  );
  const lastId = typeof rows[0]?.value === 'string' ? rows[0].value : null;

  if (!lastId) {
    // First run: establish the baseline season, never reset mid-season.
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('elo_reset_season', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(seasonId)]
    );
    console.log(`[season] ELO-reset baseline set to ${seasonId} (no reset on first run)`);
    return;
  }
  if (lastId === seasonId) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-read under a row lock so a second instance that already applied
    // the reset this rollover makes us a no-op.
    const { rows: chk } = await client.query(
      `SELECT value FROM app_config WHERE key = 'elo_reset_season' FOR UPDATE`
    );
    const curLast = typeof chk[0]?.value === 'string' ? chk[0].value : null;
    if (curLast === seasonId) { await client.query('ROLLBACK'); return; }

    const { rowCount } = await client.query(
      `UPDATE users
          SET elo = GREATEST($1, ROUND($1 + (elo - $1) * $2))::int
        WHERE elo > $1`,
      [ELO_RESET_ANCHOR, ELO_RESET_KEEP]
    );
    await client.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('elo_reset_season', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(seasonId)]
    );
    await client.query('COMMIT');
    console.log(`[season] partial ELO reset applied for ${seasonId}: ${rowCount} users`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[season] ELO reset failed:', err);
  } finally {
    client.release();
  }
}

export function startCleanupSchedule() {
  // Re-entrancy: stop any previously-running intervals first. If the module
  // is hot-reloaded the existing handles get cleared before fresh ones are
  // installed below, so we end up with exactly one of each tick — not two.
  stopCleanupSchedule();

  // Run once on boot to catch anything that drifted while the server was
  // down, then every hour thereafter. Every tick takes its advisory lock
  // so overlapping deploys / multiple instances can't double-run a job.
  const staleTick   = () => withCronLock(LOCK_STALE_MATCHES, cancelStaleMatches);
  const unpairTick  = () => withCronLock(LOCK_UNPAIR, async () => {
    await unpairStaleLinkedMatches();    // linked pairs (paired_match_id)
    await reopenOrCancelStaleMatches();  // merged + waiting matches (3-day rule)
  });
  const botTick     = () => withCronLock(LOCK_BOTS, async () => {
    const { runBotMatchPass } = await import('./bots');
    await runBotMatchPass();
  });
  const pairingTick = () => withCronLock(LOCK_PAIRING, runPairingPass);
  const feedTick    = () => withCronLock(LOCK_FEED_BACKFILL, backfillRoundPosts);
  const cupTick     = () => withCronLock(LOCK_WEEKLY_CUP, weeklyCupTick);
  const eloResetTick = () => withCronLock(LOCK_ELO_RESET, applySeasonEloReset);

  staleTick();
  cleanupHandle = setInterval(staleTick, 60 * 60 * 1000);

  // Release stale linked pairs (3-day rule). Hourly is plenty — the window is
  // measured in days. Runs once on boot to clear any current backlog.
  unpairTick();
  unpairHandle = setInterval(unpairTick, 60 * 60 * 1000);

  // CPU opponents: ensure the bot accounts exist, then fill any solo match
  // that's gone a few hours without a human. Seeding is fire-and-forget and
  // idempotent; the fill pass runs every 10 min (the wait window is in hours).
  import('./bots').then(({ seedBots }) => seedBots()).catch((e) => console.error('[bots] seed error', e));
  botTick();
  botHandle = setInterval(botTick, 10 * 60 * 1000);

  // Partial ELO reset at season rollover. Checked hourly — the boundary is
  // a 6-month one, so hourly is plenty to catch it within an hour of the
  // new season starting. Runs once on boot to establish the baseline.
  eloResetTick();
  seasonResetHandle = setInterval(eloResetTick, 60 * 60 * 1000);

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
    // FOMO: once per week, nudge active players a few hours before it closes.
    const { notifyCupEndingSoon } = await import('./notifyFomo');
    await notifyCupEndingSoon();
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
  if (unpairHandle) { clearInterval(unpairHandle); unpairHandle = null; }
  if (botHandle) { clearInterval(botHandle); botHandle = null; }
  if (pairingHandle) { clearInterval(pairingHandle); pairingHandle = null; }
  if (feedBackfillHandle) { clearInterval(feedBackfillHandle); feedBackfillHandle = null; }
  if (weeklyCupHandle) { clearInterval(weeklyCupHandle); weeklyCupHandle = null; }
  if (seasonResetHandle) { clearInterval(seasonResetHandle); seasonResetHandle = null; }
}
