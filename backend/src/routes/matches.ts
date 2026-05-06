import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

// ELO helpers
function expectedScore(rA: number, rB: number) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function kFactor(totalMatches: number, elo: number) {
  if (totalMatches < 30) return 32;
  if (elo >= 2400) return 16;
  return 24;
}

// Score differential scaled to an 18-hole equivalent so players on different
// courses, different teeboxes, and different hole counts can be compared fairly.
//
//   18-hole round on an 18-hole teebox  → standard formula
//   9-hole round on a 9-hole teebox     → standard formula on 9-hole rating, then ×2
//   9-hole round on an 18-hole teebox   → use ½ the 18-hole rating (assume front 9), then ×2
//
// The doubling converts a 9-hole "strokes over rating" into an 18-hole equivalent
// so a 5-stroke-over diff on 9 holes is treated like a 10-stroke-over diff on 18.
function diff18(gross: number, courseRating: number, slopeRating: number, holesPlayed = 18, teeboxHoles = 18) {
  let r = courseRating;
  if (holesPlayed === 9 && teeboxHoles === 18) {
    r = courseRating / 2; // assume the player completed the front 9
  }
  const raw = (gross - r) * (113 / slopeRating);
  return holesPlayed === 9 ? raw * 2 : raw;
}

// Kept for backwards compatibility / one place that still wants the un-doubled value
function scoreDifferential(gross: number, courseRating: number, slopeRating: number, holesPlayed = 18, teeboxHoles = 18) {
  const adjustedRating = courseRating * (holesPlayed / teeboxHoles);
  return (gross - adjustedRating) * (113 / slopeRating);
}

// Create match
router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchType, name, isPractice, teeboxId, clanId, format, numHoles } = req.body;
  if (!matchType) return res.status(400).json({ error: 'matchType required' });
  const resolvedFormat = (matchType === 'duo' || matchType === 'squad') && format === 'scramble' ? 'scramble' : 'stroke';
  const resolvedNumHoles = (numHoles === 9) ? 9 : 18;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Squad matches: only clan leaders can create
    if (matchType === 'squad' && clanId) {
      const { rows: roleRows } = await client.query(
        `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [clanId, req.userId]
      );
      if (!roleRows.length || roleRows[0].role !== 'leader') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the clan leader can start a squad match' });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO matches (match_type, name, is_practice, format, num_holes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [matchType, name || null, isPractice || false, resolvedFormat, resolvedNumHoles]
    );
    const match = rows[0];

    await client.query(
      `INSERT INTO match_players (match_id, user_id, teebox_id, side)
       VALUES ($1, $2, $3, 1)`,
      [match.match_id, req.userId, teeboxId || null]
    );

    // Auto-invite clan members for duo/squad matches
    if ((matchType === 'duo' || matchType === 'squad') && clanId) {
      const { rows: memberRows } = await client.query(
        `SELECT cm.user_id, u.push_token, u.username,
                me.username AS my_name
         FROM clan_members cm
         JOIN users u ON u.user_id = cm.user_id
         JOIN users me ON me.user_id = $2
         WHERE cm.clan_id = $1 AND cm.user_id != $2`,
        [clanId, req.userId]
      );

      const { rows: senderRows } = await client.query(
        `SELECT username FROM users WHERE user_id = $1`, [req.userId]
      );
      const senderName = senderRows[0]?.username ?? 'Your partner';

      for (const member of memberRows) {
        await client.query(
          `INSERT INTO match_invites (match_id, from_user_id, to_user_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
           ON CONFLICT DO NOTHING`,
          [match.match_id, req.userId, member.user_id]
        );
        if (member.push_token) {
          await sendPush(
            [member.push_token],
            `${matchType === 'duo' ? 'Duo' : 'Squad'} Match Invite`,
            `${senderName} is starting a ${matchType} match — accept within 24 hours!`,
            { type: 'invite', matchId: match.match_id }
          );
        }
      }
    }

    await client.query('COMMIT');
    return res.status(201).json(match);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Get match details
router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: matchRows } = await pool.query(
    `SELECT * FROM matches WHERE match_id = $1`,
    [req.params.id]
  );
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });

  const { rows: players } = await pool.query(
    `SELECT mp.user_id, mp.side, mp.strokes, mp.completed, mp.teebox_id,
            u.username, u.elo, u.avatar_url,
            t.name AS teebox_name, t.course_rating, t.slope_rating, t.par,
            t.course_id, t.num_holes,
            c.course_name,
            r.round_id, r.hole_scores, r.hole_stats
     FROM match_players mp
     JOIN users u ON u.user_id = mp.user_id
     LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
     WHERE mp.match_id = $1`,
    [req.params.id]
  );

  const { rows: resultRows } = await pool.query(
    `SELECT * FROM match_results WHERE match_id = $1`,
    [req.params.id]
  );

  // Pre-compute the requesting user's signed ELO delta so UIs don't have to
  // figure out whether they were favored or not in a tie. Honor perk overrides.
  let my_delta_elo: number | null = null;
  let my_perk: any = null;
  if (resultRows.length) {
    const result = resultRows[0];
    const me = players.find((p: any) => p.user_id === req.userId);
    if (me) {
      if (result.winner_side === null) {
        const key = me.side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        my_delta_elo = result.details?.[key] ?? 0;
      } else {
        my_delta_elo = result.winner_side === me.side ? result.delta_elo : -result.delta_elo;
      }
      // Apply perk override if I consumed one on this match
      const perks = result.details?.perks ?? [];
      my_perk = perks.find((pa: any) => pa.user_id === req.userId) ?? null;
      if (my_perk) my_delta_elo = my_perk.adjusted;
    }
  }

  return res.json({ ...matchRows[0], players, result: resultRows[0] || null, my_delta_elo, my_perk });
}));

// List my matches
router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT m.match_id, m.match_type, m.name, m.completed, m.created_at, m.is_practice,
            mr.winner_side, mr.delta_elo, mr.details,
            mp_me.side AS my_side, mp_me.strokes AS my_strokes
     FROM matches m
     JOIN match_players mp_me ON mp_me.match_id = m.match_id AND mp_me.user_id = $1
     LEFT JOIN match_results mr ON mr.match_id = m.match_id
     WHERE m.superseded_by_match_id IS NULL
     ORDER BY m.created_at DESC LIMIT 50`,
    [req.userId]
  );
  // Compute signed my_delta_elo per row, honoring perks.
  const decorated = rows.map((r) => {
    let my_delta_elo: number | null = null;
    if (r.delta_elo != null && r.my_side != null) {
      if (r.winner_side == null) {
        const key = r.my_side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        my_delta_elo = r.details?.[key] ?? 0;
      } else {
        my_delta_elo = r.winner_side === r.my_side ? r.delta_elo : -r.delta_elo;
      }
      const perks = r.details?.perks ?? [];
      const myPerk = perks.find((pa: any) => pa.user_id === req.userId);
      if (myPerk) my_delta_elo = myPerk.adjusted;
    }
    return { ...r, my_delta_elo };
  });
  return res.json(decorated);
}));

// Join a match (opponent side)
router.post('/:id/join', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { teeboxId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: matchRows } = await client.query(
      `SELECT * FROM matches WHERE match_id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!matchRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found' });
    }
    const match = matchRows[0];
    if (match.completed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Match already completed' });
    }
    // Check if already in
    const { rows: existingRows } = await client.query(
      `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already in match' });
    }
    const { rows: sideRows } = await client.query(
      `SELECT MAX(side) AS max_side FROM match_players WHERE match_id = $1`,
      [req.params.id]
    );
    const nextSide = (sideRows[0].max_side || 0) + 1;
    await client.query(
      `INSERT INTO match_players (match_id, user_id, teebox_id, side)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, req.userId, teeboxId || null, nextSide]
    );
    await client.query('COMMIT');
    return res.json({ success: true, side: nextSide });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Sanitise a hole_stats array — same length as scores, each entry has
// putts (0–10), chips (0–10), gir (bool), fairwayHit (bool|null) plus the
// optional advanced fields fairwayMiss / greenMiss / puttDistances. Bad input
// is silently dropped rather than failing the whole submission.
const FAIRWAY_MISS_VALUES = new Set(['left', 'right']);
const GREEN_MISS_VALUES = new Set(['left', 'right', 'short', 'long']);
// Snap stops for putt-distance entry, in feet. Anything else is dropped.
const PUTT_DIST_STOPS = new Set([3, 6, 10, 15, 20, 30, 40, 50]);

function cleanHoleStats(input: any, expectedLength: number): any[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, expectedLength).map((h: any) => {
    if (h == null || typeof h !== 'object') return {};
    const cleaned: any = {};
    if (typeof h.putts === 'number' && h.putts >= 0 && h.putts <= 10) cleaned.putts = Math.floor(h.putts);
    if (typeof h.chips === 'number' && h.chips >= 0 && h.chips <= 10) cleaned.chips = Math.floor(h.chips);
    if (typeof h.gir === 'boolean') cleaned.gir = h.gir;
    if (typeof h.fairwayHit === 'boolean') cleaned.fairwayHit = h.fairwayHit;
    if (typeof h.fairwayMiss === 'string' && FAIRWAY_MISS_VALUES.has(h.fairwayMiss)) {
      cleaned.fairwayMiss = h.fairwayMiss;
    }
    if (typeof h.greenMiss === 'string' && GREEN_MISS_VALUES.has(h.greenMiss)) {
      cleaned.greenMiss = h.greenMiss;
    }
    if (Array.isArray(h.puttDistances)) {
      // Cap at the player's putt count when known, else 10. Drop non-stop values.
      const max = typeof cleaned.putts === 'number' ? cleaned.putts : 10;
      const dists = h.puttDistances
        .slice(0, max)
        .map((d: any) => Number(d))
        .filter((d: number) => Number.isFinite(d) && PUTT_DIST_STOPS.has(d));
      if (dists.length) cleaned.puttDistances = dists;
    }
    return cleaned;
  });
}

// Submit scores for a round
router.post('/:id/scores', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { holeScores, holeStats, courseId, teeboxId } = req.body;
  if (!Array.isArray(holeScores) || holeScores.length === 0) {
    return res.status(400).json({ error: 'holeScores array required' });
  }
  const cleanStats = cleanHoleStats(holeStats, holeScores.length);

  const totalScore = (holeScores as number[]).reduce((a, b) => a + b, 0);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get match + my player row
    const { rows: matchRows } = await client.query(
      `SELECT m.*, mp.side, mp.teebox_id AS player_teebox
       FROM matches m JOIN match_players mp ON mp.match_id = m.match_id
       WHERE m.match_id = $1 AND mp.user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId]
    );
    if (!matchRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match or player not found' });
    }
    if (matchRows[0].completed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Match already completed' });
    }

    const matchFormat: string = matchRows[0].format ?? 'stroke';
    const myeSide: number = matchRows[0].side;
    const resolvedTeeboxId = teeboxId || matchRows[0].player_teebox;

    // Validate hole count against teebox capacity to keep ELO math consistent.
    // (Otherwise a client could submit 18 scores against a 9-hole teebox and
    // diff18() would produce a hybrid result.)
    if (resolvedTeeboxId) {
      const { rows: teeRows } = await client.query(
        `SELECT num_holes FROM teeboxes WHERE teebox_id = $1`,
        [resolvedTeeboxId]
      );
      const cap = teeRows[0]?.num_holes;
      if (cap && holeScores.length > cap) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot submit ${holeScores.length} holes on a ${cap}-hole tee box` });
      }
    }

    // Scramble: validate equal team sizes before accepting first submission
    if (matchFormat === 'scramble') {
      const { rows: sideCountRows } = await client.query(
        `SELECT side, COUNT(*) AS cnt FROM match_players WHERE match_id = $1 GROUP BY side`,
        [req.params.id]
      );
      if (sideCountRows.length >= 2) {
        const counts = sideCountRows.map((r: any) => parseInt(r.cnt, 10));
        const allEqual = counts.every((c: number) => c === counts[0]);
        if (!allEqual) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Scramble requires equal players on each side' });
        }
      }
    }

    // Upsert round (only for the submitting player; scramble teammates share the same final score)
    await client.query(
      `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats, total_score, round_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (match_id, user_id)
       DO UPDATE SET hole_scores = $5, hole_stats = $6, total_score = $7, teebox_id = $4`,
      [req.params.id, req.userId, courseId || null, resolvedTeeboxId || null, holeScores, JSON.stringify(cleanStats), totalScore, matchRows[0].match_type]
    );

    // Update match_players for the submitting player
    await client.query(
      `UPDATE match_players SET strokes = $1, completed = true, teebox_id = COALESCE($2, teebox_id)
       WHERE match_id = $3 AND user_id = $4`,
      [totalScore, resolvedTeeboxId, req.params.id, req.userId]
    );

    // Pin-contribution reward: if a majority of the holes the player COULD have
    // contributed to (still NULL, or filled by them) actually were filled by
    // them, grant a 'lucky_round' perk. The feature only applies when at least
    // one hole the player played was missing pin data — if every pin was
    // already known, there was nothing to contribute and no perk possible.
    let perkAwarded = false;
    if (!matchRows[0].is_practice && Array.isArray(holeScores) && holeScores.length > 0 && resolvedTeeboxId) {
      // Count "eligible" holes among the ones this player played:
      //   - pin still NULL (they had the chance, missed it), OR
      //   - pin_set_by = me (they took the chance and filled it)
      // Rows where someone else filled the pin before the player arrived don't count.
      const { rows: opportunityRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM holes
         WHERE teebox_id = $1
           AND hole_num <= $2
           AND (pin_lat IS NULL OR pin_set_by = $3)`,
        [resolvedTeeboxId, holeScores.length, req.userId]
      );
      const opportunityCount = opportunityRows[0]?.n ?? 0;

      const { rows: contribRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM pin_contributions
         WHERE user_id = $1 AND match_id = $2`,
        [req.userId, req.params.id]
      );
      const contribCount = contribRows[0]?.n ?? 0;

      if (opportunityCount > 0 && contribCount * 2 > opportunityCount) {
        // Avoid double-awarding for the same match (duo/squad — multiple submitters)
        const { rows: alreadyRows } = await client.query(
          `SELECT 1 FROM user_perks WHERE user_id = $1 AND earned_match_id = $2`,
          [req.userId, req.params.id]
        );
        if (!alreadyRows.length) {
          await client.query(
            `INSERT INTO user_perks (user_id, perk_type, earned_match_id) VALUES ($1, 'lucky_round', $2)`,
            [req.userId, req.params.id]
          );
          perkAwarded = true;
        }
      }
    }

    // Scramble: mark ALL teammates on the same side as done with the same score,
    // AND copy the submitter's rounds row to each so resolveElo's COALESCE on
    // hole_scores.length doesn't fall back to 18 for their teammates.
    if (matchFormat === 'scramble') {
      await client.query(
        `UPDATE match_players SET strokes = $1, completed = true, teebox_id = COALESCE($2, teebox_id)
         WHERE match_id = $3 AND side = $4 AND user_id != $5`,
        [totalScore, resolvedTeeboxId, req.params.id, myeSide, req.userId]
      );
      // Mirror the submitter's rounds row to each teammate so holes_played
      // (derived from array_length(hole_scores, 1)) stays consistent. Also
      // propagate hole_stats so derived stats (GIR, FW%, putts, SG) match.
      await client.query(
        `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats, total_score, round_type)
         SELECT $1, mp.user_id, $2, $3, $4, $5, $6, $7
         FROM match_players mp
         WHERE mp.match_id = $1 AND mp.side = $8 AND mp.user_id != $9
         ON CONFLICT (match_id, user_id)
         DO UPDATE SET hole_scores = EXCLUDED.hole_scores, hole_stats = EXCLUDED.hole_stats, total_score = EXCLUDED.total_score, teebox_id = EXCLUDED.teebox_id`,
        [req.params.id, courseId || null, resolvedTeeboxId || null, holeScores, JSON.stringify(cleanStats), totalScore, matchRows[0].match_type, myeSide, req.userId]
      );
    }

    // Check if all players have submitted
    const { rows: allPlayers } = await client.query(
      `SELECT mp.user_id, mp.side, mp.strokes, mp.teebox_id,
              t.course_rating, t.slope_rating, t.par,
              t.num_holes AS teebox_num_holes,
              COALESCE(array_length(r.hole_scores, 1), 18) AS holes_played,
              u.elo, u.total_matches
       FROM match_players mp
       JOIN users u ON u.user_id = mp.user_id
       LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
       LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
       WHERE mp.match_id = $1`,
      [req.params.id]
    );

    const allDone = allPlayers.every((p) => p.strokes != null);
    let result: any = null;

    const resolveElo = async (
      side1Players: typeof allPlayers,
      side2Players: typeof allPlayers,
      matchId: string,
      matchType: string
    ) => {
      const getDiff = (players: typeof allPlayers, topN?: number) => {
        const diffs = players.map((p) =>
          p.course_rating && p.slope_rating
            ? diff18(p.strokes, p.course_rating, p.slope_rating, p.holes_played, p.teebox_num_holes || p.holes_played)
            : p.strokes
        ).sort((a: number, b: number) => a - b); // ascending — lower is better in golf
        const used = topN ? diffs.slice(0, topN) : diffs;
        return used.reduce((a: number, b: number) => a + b, 0) / used.length;
      };
      // If team sizes differ, compare using the smaller team's count (best N scores)
      const compareCount = Math.min(side1Players.length, side2Players.length);
      const side1Diff = getDiff(side1Players, compareCount);
      const side2Diff = getDiff(side2Players, compareCount);

      // Tie when the two differentials are within 0.05 of each other (about
      // 1/20 of a stroke). Wider than the float-precision threshold so it
      // catches genuine near-ties, narrower than 1 full stroke equivalent.
      // Chess-style: actual score 0.5 for both sides. Higher-rated player
      // loses ELO, lower-rated gains. delta = K × (0.5 − expected).
      const isTie = Math.abs(side1Diff - side2Diff) < 0.05;
      const side1Wins = !isTie && side1Diff < side2Diff;

      const p1 = side1Players[0];
      const p2 = side2Players[0];
      const expA = expectedScore(p1.elo, p2.elo);
      const k = kFactor(p1.total_matches, p1.elo);
      const side1ActualScore = isTie ? 0.5 : (side1Wins ? 1 : 0);
      const side1Delta = Math.round(k * (side1ActualScore - expA));
      const side2Delta = -side1Delta;

      // Track per-player perk applications to surface in the response
      const perkApplications: { user_id: string; original: number; adjusted: number; type: string }[] = [];

      // Batch-fetch unused perks for everyone in this match. CRITICAL: exclude
      // perks earned on THIS match — they're for the player's *next* match.
      const allPlayerIds = [...side1Players, ...side2Players].map((p) => p.user_id);
      const { rows: perkRows } = await client.query(
        `SELECT DISTINCT ON (user_id) user_id, perk_id
         FROM user_perks
         WHERE user_id = ANY($1)
           AND consumed_at IS NULL
           AND (earned_match_id IS NULL OR earned_match_id != $2)
         ORDER BY user_id, earned_at ASC`,
        [allPlayerIds, matchId]
      );
      const perkByUser = new Map<string, string>(
        perkRows.map((r: any) => [r.user_id, r.perk_id])
      );

      for (const p of [...side1Players, ...side2Players]) {
        const onSide1 = side1Players.includes(p);
        const baseChange = onSide1 ? side1Delta : side2Delta;
        const won = !isTie && onSide1 === side1Wins;

        // Check for an unused 'lucky_round' perk and apply it.
        // - Loss  → set ELO change to 0 (loss prevention)
        // - Win   → double the ELO gain
        // - 0 ELO → don't consume (no benefit; nothing to absorb or double)
        let eloChange = baseChange;
        const perkId = perkByUser.get(p.user_id);
        if (perkId && baseChange !== 0) {
          if (eloChange < 0) eloChange = 0;
          else eloChange = eloChange * 2;
          await client.query(
            `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
            [perkId, matchId]
          );
          perkApplications.push({ user_id: p.user_id, original: baseChange, adjusted: eloChange, type: 'lucky_round' });
        }

        await client.query(
          `UPDATE users
           SET elo = GREATEST(100, elo + $1),
               total_matches = total_matches + 1,
               total_wins = total_wins + $2,
               total_ties = total_ties + $3
           WHERE user_id = $4`,
          [eloChange, won ? 1 : 0, isTie ? 1 : 0, p.user_id]
        );
      }

      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
         side2_score_differential, delta_elo, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          matchId,
          matchType,
          isTie ? null : (side1Wins ? 1 : 2),
          side1Diff,
          side2Diff,
          Math.abs(side1Delta),
          JSON.stringify({
            side1Players: side1Players.map((p) => p.user_id),
            side2Players: side2Players.map((p) => p.user_id),
            tied: isTie,
            side1DeltaSignedElo: side1Delta,
            side2DeltaSignedElo: side2Delta,
            perks: perkApplications, // [{ user_id, original, adjusted, type }]
          }),
        ]
      );
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [matchId]);
      return {
        winnerSide: isTie ? null : (side1Wins ? 1 : 2),
        tied: isTie,
        deltaElo: Math.abs(side1Delta),
        side1Diff,
        side2Diff,
        perks: perkApplications,
      };
    };

    if (allDone && !matchRows[0].is_practice && allPlayers.length >= 2) {
      // Multiple players already in match — resolve normally
      const sides: Record<number, typeof allPlayers> = {};
      for (const p of allPlayers) {
        if (!sides[p.side]) sides[p.side] = [];
        sides[p.side].push(p);
      }
      if (Object.keys(sides).length >= 2) {
        result = await resolveElo(sides[1], sides[2], req.params.id, matchRows[0].match_type);
      }

    } else if (allDone && !matchRows[0].is_practice && allPlayers.length === 1) {
      // Solo submission — find the best-ELO match from the pending pool
      const myP = allPlayers[0];
      const myHolesPlayed = holeScores.length;

      const pendingPoolQuery = (holesFilter: 'same' | 'different') => client.query(
        `SELECT mp.match_id AS opp_match_id, mp.user_id, mp.strokes, mp.teebox_id,
                u.username, u.elo, u.total_matches,
                array_length(r.hole_scores, 1) AS holes_played
         FROM match_players mp
         JOIN users u ON u.user_id = mp.user_id
         JOIN matches m ON m.match_id = mp.match_id
         JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
         WHERE mp.user_id != $1
           AND mp.completed = true
           AND m.is_practice = false
           AND m.completed = false
           AND m.match_type = $2
           AND array_length(r.hole_scores, 1) ${holesFilter === 'same' ? '=' : '!='} $4
           AND NOT EXISTS (
             SELECT 1 FROM match_players mp2
             WHERE mp2.match_id = mp.match_id AND mp2.user_id != mp.user_id
           )
         ORDER BY ABS(u.elo - $3)
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [myP.user_id, matchRows[0].match_type, myP.elo, myHolesPlayed]
      );

      // Prefer same-format (9v9 or 18v18). Fall back to cross-format only if pool is empty.
      let { rows: candidates } = await pendingPoolQuery('same');
      let isCrossFormat = false;
      if (!candidates.length) {
        ({ rows: candidates } = await pendingPoolQuery('different'));
        isCrossFormat = candidates.length > 0;
      }

      if (candidates.length > 0) {
        const opp = candidates[0];
        // Fetch teebox data for opponent separately (can't LEFT JOIN with FOR UPDATE)
        if (opp.teebox_id) {
          const { rows: tbRows } = await client.query(
            `SELECT course_rating, slope_rating, num_holes AS teebox_num_holes FROM teeboxes WHERE teebox_id = $1`,
            [opp.teebox_id]
          );
          if (tbRows.length) {
            opp.course_rating = tbRows[0].course_rating;
            opp.slope_rating = tbRows[0].slope_rating;
            opp.teebox_num_holes = tbRows[0].teebox_num_holes;
          }
        }

        // Add opponent into this match as side 2 (store the real strokes, not normalised)
        await client.query(
          `INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
           VALUES ($1, $2, $3, 2, $4, true)`,
          [req.params.id, opp.user_id, opp.teebox_id, opp.strokes]
        );

        // Copy the opponent's round (from their original match) into THIS match
        // so the allPlayers query in resolveElo gets correct holes_played for them.
        // Without this, the LEFT JOIN to rounds returns null and COALESCE defaults
        // to 18 — wrong for 9-hole opponents.
        await client.query(
          `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, total_score, round_type)
           SELECT $1, user_id, course_id, teebox_id, hole_scores, total_score, round_type
           FROM rounds WHERE match_id = $2 AND user_id = $3
           ON CONFLICT (match_id, user_id) DO NOTHING`,
          [req.params.id, opp.opp_match_id, opp.user_id]
        );

        // No special-case normalization needed — diff18() inside resolveElo
        // already converts each player's score to an 18-hole equivalent so a
        // 9-hole player vs an 18-hole player compares fairly.
        const oppForElo = { ...opp, side: 2 };
        result = await resolveElo([myP], [oppForElo], req.params.id, matchRows[0].match_type);
        result.autoMatched = true;
        result.crossFormat = isCrossFormat;
        result.opponentUsername = opp.username;
        // Close opponent's pending match AND mark it superseded by the current
        // match. The matches-list endpoint filters out superseded rows so the
        // opponent's match list doesn't show a phantom TIE — they see this
        // match instead, where they're listed as side 2 with the real result.
        await client.query(
          `UPDATE matches SET completed = true, superseded_by_match_id = $2 WHERE match_id = $1`,
          [opp.opp_match_id, req.params.id]
        );
      }
      // No candidate → stay pending (match.completed stays false, scores are recorded)

    } else if (allDone) {
      // Practice round — just complete it
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [req.params.id]);
    }

    // Decorate the response with the submitter's signed ELO delta so the
    // client doesn't have to figure out which side they were on.
    if (result) {
      const tied = result.tied || result.winnerSide === null;
      const submitterIsSide1 = myeSide === 1;
      const baseDelta = result.deltaElo ?? 0;
      if (tied) {
        const { rows: mrRows } = await client.query(
          `SELECT details FROM match_results WHERE match_id = $1`,
          [req.params.id]
        );
        const details = mrRows[0]?.details;
        const key = submitterIsSide1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        result.myDeltaElo = details?.[key] ?? 0;
      } else {
        const won = (result.winnerSide === 1 && submitterIsSide1) || (result.winnerSide === 2 && !submitterIsSide1);
        result.myDeltaElo = won ? baseDelta : -baseDelta;
      }
      // Override with per-player perk-adjusted delta if the submitter consumed a perk
      const myPerk = (result.perks ?? []).find((pa: any) => pa.user_id === req.userId);
      if (myPerk) result.myDeltaElo = myPerk.adjusted;
    }

    // Surface whether THIS submission earned the user a fresh perk
    if (perkAwarded) {
      if (!result) result = {} as any;
      result.perkAwarded = 'lucky_round';
    }

    await client.query('COMMIT');
    return res.json({ success: true, totalScore, result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Forfeit a match (counts as a loss with ELO penalty)
router.post('/:id/forfeit', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: playerRows } = await client.query(
      `SELECT mp.side, m.completed, m.is_practice, m.match_type
       FROM match_players mp JOIN matches m ON m.match_id = mp.match_id
       WHERE mp.match_id = $1 AND mp.user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId]
    );
    if (!playerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not in this match' });
    }
    if (playerRows[0].completed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Match already completed' });
    }
    const mySide: number = playerRows[0].side;
    const isPractice: boolean = playerRows[0].is_practice;

    const { rows: allPlayers } = await client.query(
      `SELECT mp.user_id, mp.side, u.elo, u.total_matches
       FROM match_players mp JOIN users u ON u.user_id = mp.user_id
       WHERE mp.match_id = $1`,
      [req.params.id]
    );
    const mySidePlayers = allPlayers.filter((p) => p.side === mySide);
    const otherSidePlayers = allPlayers.filter((p) => p.side !== mySide);

    if (otherSidePlayers.length === 0 || isPractice) {
      // No real opponent — just abandon
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [req.params.id]);
      await client.query('COMMIT');
      return res.json({ success: true, forfeited: false });
    }

    // ELO calculation — forfeit = full loss
    const p1 = mySidePlayers[0];
    const p2 = otherSidePlayers[0];
    const expA = expectedScore(p1.elo, p2.elo);
    const k = kFactor(p1.total_matches, p1.elo);
    const deltaElo = Math.round(k * (0 - expA)); // negative for forfeiter

    // Pull unused 'lucky_round' perks for everyone in this match (excluding any
    // earned on this match — those are reserved for their next ranked match).
    const allForfeitPlayerIds = [...mySidePlayers, ...otherSidePlayers].map((p) => p.user_id);
    const { rows: forfeitPerkRows } = await client.query(
      `SELECT DISTINCT ON (user_id) user_id, perk_id
       FROM user_perks
       WHERE user_id = ANY($1)
         AND consumed_at IS NULL
         AND (earned_match_id IS NULL OR earned_match_id != $2)
       ORDER BY user_id, earned_at ASC`,
      [allForfeitPlayerIds, req.params.id]
    );
    const forfeitPerkByUser = new Map<string, string>(
      forfeitPerkRows.map((r: any) => [r.user_id, r.perk_id])
    );
    const forfeitPerkApplications: { user_id: string; original: number; adjusted: number; type: string }[] = [];

    for (const p of mySidePlayers) {
      let change = deltaElo; // negative for forfeiter
      const perkId = forfeitPerkByUser.get(p.user_id);
      if (perkId && change < 0) {
        await client.query(
          `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
          [perkId, req.params.id]
        );
        forfeitPerkApplications.push({ user_id: p.user_id, original: change, adjusted: 0, type: 'lucky_round' });
        change = 0;
      }
      await client.query(
        `UPDATE users SET elo = GREATEST(100, elo + $1), total_matches = total_matches + 1 WHERE user_id = $2`,
        [change, p.user_id]
      );
    }
    for (const p of otherSidePlayers) {
      let change = -deltaElo; // positive for opponents
      const perkId = forfeitPerkByUser.get(p.user_id);
      if (perkId && change > 0) {
        await client.query(
          `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
          [perkId, req.params.id]
        );
        forfeitPerkApplications.push({ user_id: p.user_id, original: change, adjusted: change * 2, type: 'lucky_round' });
        change = change * 2;
      }
      await client.query(
        `UPDATE users SET elo = GREATEST(100, elo + $1), total_matches = total_matches + 1, total_wins = total_wins + 1 WHERE user_id = $2`,
        [change, p.user_id]
      );
    }

    await client.query(
      `INSERT INTO match_results (match_id, match_type, winner_side, delta_elo, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.params.id, playerRows[0].match_type,
        mySide === 1 ? 2 : 1,
        Math.abs(deltaElo),
        JSON.stringify({
          forfeit: true,
          forfeitUserId: req.userId,
          side1DeltaSignedElo: mySide === 1 ? deltaElo : -deltaElo,
          side2DeltaSignedElo: mySide === 1 ? -deltaElo : deltaElo,
          perks: forfeitPerkApplications,
        }),
      ]
    );
    await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [req.params.id]);

    await client.query('COMMIT');
    return res.json({ success: true, forfeited: true, deltaElo });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Save in-progress hole scores so friends (not in this match) can watch live.
// Stores partial scores on the rounds row without marking it complete.
// Optionally accepts teeboxId/courseId so a player who just picked their teebox
// in the scoring screen gets it persisted on match_players too (needed for
// challenge matches where no teebox was set at match creation).
router.post('/:id/progress', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { holeScores, holeStats, teeboxId } = req.body;
  if (!Array.isArray(holeScores)) return res.status(400).json({ error: 'holeScores required' });
  const cleanStats = cleanHoleStats(holeStats, holeScores.length);

  // Don't accept progress for already-finished matches
  const { rows: matchRows } = await pool.query(
    `SELECT completed FROM matches WHERE match_id = $1`,
    [req.params.id]
  );
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
  if (matchRows[0]?.completed) return res.json({ success: true, ignored: 'completed' });

  // If client passed a teeboxId, persist it on match_players when not already set
  if (teeboxId) {
    await pool.query(
      `UPDATE match_players SET teebox_id = COALESCE(teebox_id, $1)
       WHERE match_id = $2 AND user_id = $3`,
      [teeboxId, req.params.id, req.userId]
    );
  }

  // Resolve teebox + course from match_players (now that we may have just set it)
  const { rows: pRows } = await pool.query(
    `SELECT mp.teebox_id, t.course_id FROM match_players mp
     LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     WHERE mp.match_id = $1 AND mp.user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!pRows.length) return res.status(404).json({ error: 'Not in this match' });

  await pool.query(
    `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (match_id, user_id)
     DO UPDATE SET hole_scores = $5,
                   hole_stats = $6,
                   course_id = COALESCE(rounds.course_id, EXCLUDED.course_id),
                   teebox_id = COALESCE(rounds.teebox_id, EXCLUDED.teebox_id)`,
    [req.params.id, req.userId, pRows[0].course_id, pRows[0].teebox_id, holeScores, JSON.stringify(cleanStats)]
  );
  return res.json({ success: true });
}));

// Notify friends that the user has started a round. Idempotent — only fires once per match.
router.post('/:id/started', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Verify caller is in the match BEFORE we flip the bit, otherwise a
  // non-member could grief the notification by calling this first.
  const { rows: playerRows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!playerRows.length) return res.json({ success: true, sent: false });

  // Atomic flip: only the first caller for this match gets a row back
  const { rows: flipped } = await pool.query(
    `UPDATE matches SET started_notified = true
     WHERE match_id = $1 AND started_notified = false AND completed = false AND is_practice = false
     RETURNING match_id`,
    [req.params.id]
  );
  if (!flipped.length) return res.json({ success: true, sent: false });

  // Course name (from any player's teebox), starter username
  const { rows: meRows } = await pool.query(`SELECT username FROM users WHERE user_id = $1`, [req.userId]);
  const starterName = meRows[0]?.username ?? 'A friend';

  const { rows: courseRows } = await pool.query(
    `SELECT c.course_name FROM match_players mp
     JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     JOIN courses c ON c.course_id = t.course_id
     WHERE mp.match_id = $1 LIMIT 1`,
    [req.params.id]
  );
  const courseName = courseRows[0]?.course_name ?? 'a course';

  // Friends with push tokens — bidirectional (the friends table stores one
  // row per friendship; the friend can be on either side of user_id/friend_id).
  const { rows: friends } = await pool.query(
    `SELECT DISTINCT u.push_token FROM friends f
     JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1)
       AND f.status = 'accepted'
       AND u.push_token IS NOT NULL`,
    [req.userId]
  );
  const tokens = friends.map((f) => f.push_token).filter(Boolean);
  if (tokens.length) {
    await sendPush(
      tokens,
      `${starterName} started a round`,
      `Tap to watch their scorecard live at ${courseName}`,
      { type: 'round_started', userId: req.userId, matchId: req.params.id }
    );
  }
  return res.json({ success: true, sent: true, recipientCount: tokens.length });
}));

// POST a pin location for a hole during a round.
//   body: { holeId: UUID, lat: number, lng: number }
// Updates the hole's pin coords iff they're not already set (first contributor wins).
// Records a contribution credit so we can reward the user for pinning ≥50% of holes.
router.post('/:id/pin', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { holeId, lat, lng, elevationM } = req.body ?? {};
  if (typeof holeId !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'holeId, lat, lng required' });
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'invalid coords' });
  }
  // Sanity check elevation: -500m (Dead Sea) to +9000m (Everest)
  const elev = (typeof elevationM === 'number' && elevationM > -500 && elevationM < 9000)
    ? elevationM : null;

  // Verify the user is in this match AND the hole belongs to their teebox.
  const { rows: pRows } = await pool.query(
    `SELECT 1 FROM match_players mp
     JOIN holes h ON h.teebox_id = mp.teebox_id
     WHERE mp.match_id = $1 AND mp.user_id = $2 AND h.hole_id = $3`,
    [req.params.id, req.userId, holeId]
  );
  if (!pRows.length) {
    return res.status(404).json({ error: 'Not in match or hole not on your teebox' });
  }

  // First contributor wins — only set the pin if it's currently null.
  // Elevation is also only set on the first contribution (avoids drift across
  // many players' GPS altitudes; later we can crowd-average if we want).
  await pool.query(
    `UPDATE holes
     SET pin_lat = $2, pin_lng = $3,
         pin_elevation_m = COALESCE(pin_elevation_m, $5),
         pin_set_at = NOW(), pin_set_by = $4
     WHERE hole_id = $1 AND pin_lat IS NULL`,
    [holeId, lat, lng, req.userId, elev]
  );
  // If the pin was already set but elevation wasn't, fill it in (lets the data
  // get better as more players walk the course with altitude-capable devices).
  if (elev != null) {
    await pool.query(
      `UPDATE holes SET pin_elevation_m = $2
       WHERE hole_id = $1 AND pin_elevation_m IS NULL`,
      [holeId, elev]
    );
  }
  await pool.query(
    `INSERT INTO pin_contributions (user_id, match_id, hole_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [req.userId, req.params.id, holeId]
  );
  return res.json({ success: true });
}));

// PUT a player's shot track for a single hole. Replaces the full array.
//   body: { shots: Array<{ lat: number, lng: number }> }
router.put('/:id/shots/:holeNum', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const holeNum = parseInt(req.params.holeNum, 10);
  if (isNaN(holeNum) || holeNum < 1 || holeNum > 36) {
    return res.status(400).json({ error: 'invalid holeNum' });
  }
  const shots = req.body?.shots;
  if (!Array.isArray(shots)) return res.status(400).json({ error: 'shots array required' });

  // Allowed clubs and lies — keep these short, lower-cased identifiers.
  // Front-end labels can be richer; here we just whitelist values to avoid
  // free-text growing organically.
  const ALLOWED_CLUBS = new Set([
    'driver', '3w', '5w', '7w', 'hybrid',
    '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i',
    'pw', 'gw', 'sw', 'lw', 'putter',
  ]);
  const ALLOWED_LIES = new Set(['tee', 'fairway', 'rough', 'bunker', 'recovery', 'green', 'fringe']);

  // Validate shape — clamp to reasonable values; reject anything obviously bogus.
  // Elevation, club, and lie are optional (older clients won't send them) but
  // persisted when present.
  const clean = shots
    .filter((s: any) => typeof s?.lat === 'number' && typeof s?.lng === 'number'
      && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180)
    .slice(0, 30) // hard cap shots per hole
    .map((s: any) => {
      const out: any = { lat: s.lat, lng: s.lng };
      if (typeof s.elevation_m === 'number' && s.elevation_m > -500 && s.elevation_m < 9000) {
        out.elevation_m = s.elevation_m;
      }
      if (typeof s.club === 'string' && ALLOWED_CLUBS.has(s.club.toLowerCase())) {
        out.club = s.club.toLowerCase();
      }
      if (typeof s.lie === 'string' && ALLOWED_LIES.has(s.lie.toLowerCase())) {
        out.lie = s.lie.toLowerCase();
      }
      return out;
    });

  // Verify membership
  const { rows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not in match' });

  await pool.query(
    `INSERT INTO shot_tracks (match_id, user_id, hole_num, shots, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (match_id, user_id, hole_num)
     DO UPDATE SET shots = EXCLUDED.shots, updated_at = NOW()`,
    [req.params.id, req.userId, holeNum, JSON.stringify(clean)]
  );
  return res.json({ success: true, count: clean.length });
}));

// GET shot tracks for a match — optionally filter by user.
//   query: ?user=<userId> to restrict to one player
// Returns rows: [{ user_id, hole_num, shots: [{lat,lng}, ...] }, ...]
router.get('/:id/shots', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const userFilter = req.query.user as string | undefined;
  const params: any[] = [req.params.id];
  let where = `WHERE match_id = $1`;
  if (userFilter) { params.push(userFilter); where += ` AND user_id = $2`; }

  const { rows } = await pool.query(
    `SELECT user_id, hole_num, shots FROM shot_tracks ${where}
     ORDER BY user_id, hole_num`,
    params
  );
  return res.json(rows);
}));

// Cancel / delete a match — only allowed if no player has submitted scores yet (no ELO penalty)
router.delete('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Must be a participant
    const { rows: playerRows } = await client.query(
      `SELECT mp.user_id FROM match_players mp
       WHERE mp.match_id = $1 AND mp.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!playerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not in this match' });
    }

    // Reject if anyone has already submitted scores
    const { rows: scoredRows } = await client.query(
      `SELECT 1 FROM match_players WHERE match_id = $1 AND completed = true LIMIT 1`,
      [req.params.id]
    );
    if (scoredRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Scores have already been submitted — use Forfeit instead.' });
    }

    // DELETE cascades to match_players, rounds, match_invites, match_results, messages
    await client.query(`DELETE FROM matches WHERE match_id = $1`, [req.params.id]);

    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

export default router;
