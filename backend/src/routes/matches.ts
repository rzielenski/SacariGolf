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
            r.hole_scores
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
  // figure out whether they were favored or not in a tie.
  let my_delta_elo: number | null = null;
  if (resultRows.length) {
    const result = resultRows[0];
    const me = players.find((p: any) => p.user_id === req.userId);
    if (me) {
      if (result.winner_side === null) {
        // Tie — pull the signed delta from details
        const key = me.side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        my_delta_elo = result.details?.[key] ?? 0;
      } else {
        my_delta_elo = result.winner_side === me.side ? result.delta_elo : -result.delta_elo;
      }
    }
  }

  return res.json({ ...matchRows[0], players, result: resultRows[0] || null, my_delta_elo });
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
     ORDER BY m.created_at DESC LIMIT 50`,
    [req.userId]
  );
  // Compute signed my_delta_elo per row
  const decorated = rows.map((r) => {
    let my_delta_elo: number | null = null;
    if (r.delta_elo != null && r.my_side != null) {
      if (r.winner_side == null) {
        const key = r.my_side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        my_delta_elo = r.details?.[key] ?? 0;
      } else {
        my_delta_elo = r.winner_side === r.my_side ? r.delta_elo : -r.delta_elo;
      }
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

// Submit scores for a round
router.post('/:id/scores', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { holeScores, courseId, teeboxId } = req.body;
  if (!Array.isArray(holeScores) || holeScores.length === 0) {
    return res.status(400).json({ error: 'holeScores array required' });
  }

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
      `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, total_score, round_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (match_id, user_id)
       DO UPDATE SET hole_scores = $5, total_score = $6, teebox_id = $4`,
      [req.params.id, req.userId, courseId || null, resolvedTeeboxId || null, holeScores, totalScore, matchRows[0].match_type]
    );

    // Update match_players for the submitting player
    await client.query(
      `UPDATE match_players SET strokes = $1, completed = true, teebox_id = COALESCE($2, teebox_id)
       WHERE match_id = $3 AND user_id = $4`,
      [totalScore, resolvedTeeboxId, req.params.id, req.userId]
    );

    // Scramble: mark ALL teammates on the same side as done with the same score
    if (matchFormat === 'scramble') {
      await client.query(
        `UPDATE match_players SET strokes = $1, completed = true, teebox_id = COALESCE($2, teebox_id)
         WHERE match_id = $3 AND side = $4 AND user_id != $5`,
        [totalScore, resolvedTeeboxId, req.params.id, myeSide, req.userId]
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

      // Tie when the two differentials round to the same hundredth.
      // Chess-style: actual score 0.5 for both sides. Higher-rated player loses ELO,
      // lower-rated gains. delta = K × (0.5 − expected).
      const isTie = Math.round(side1Diff * 100) === Math.round(side2Diff * 100);
      const side1Wins = !isTie && side1Diff < side2Diff;

      const p1 = side1Players[0];
      const p2 = side2Players[0];
      const expA = expectedScore(p1.elo, p2.elo);
      const k = kFactor(p1.total_matches, p1.elo);
      const side1ActualScore = isTie ? 0.5 : (side1Wins ? 1 : 0);
      const side1Delta = Math.round(k * (side1ActualScore - expA));
      const side2Delta = -side1Delta;

      for (const p of [...side1Players, ...side2Players]) {
        const onSide1 = side1Players.includes(p);
        const eloChange = onSide1 ? side1Delta : side2Delta;
        const won = !isTie && onSide1 === side1Wins;
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

        // No special-case normalization needed — diff18() inside resolveElo
        // already converts each player's score to an 18-hole equivalent so a
        // 9-hole player vs an 18-hole player compares fairly.
        const oppForElo = { ...opp, side: 2 };
        result = await resolveElo([myP], [oppForElo], req.params.id, matchRows[0].match_type);
        result.autoMatched = true;
        result.crossFormat = isCrossFormat;
        result.opponentUsername = opp.username;
        // Close opponent's pending match so it doesn't re-enter the pool
        await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [opp.opp_match_id]);
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
        // For ties, side1's signed delta is K*(0.5 - expA). The magnitude is
        // result.deltaElo and the side that gained ELO is whoever was lower-rated.
        // We can't reliably reconstruct sign without expA — but we tracked it in details.
        // Simpler: pull from match_results we just inserted.
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

    for (const p of mySidePlayers) {
      await client.query(
        `UPDATE users SET elo = GREATEST(100, elo + $1), total_matches = total_matches + 1 WHERE user_id = $2`,
        [deltaElo, p.user_id]
      );
    }
    for (const p of otherSidePlayers) {
      await client.query(
        `UPDATE users SET elo = GREATEST(100, elo + $1), total_matches = total_matches + 1, total_wins = total_wins + 1 WHERE user_id = $2`,
        [-deltaElo, p.user_id]
      );
    }

    await client.query(
      `INSERT INTO match_results (match_id, match_type, winner_side, delta_elo, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.params.id, playerRows[0].match_type,
        mySide === 1 ? 2 : 1,
        Math.abs(deltaElo),
        JSON.stringify({ forfeit: true, forfeitUserId: req.userId }),
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
  const { holeScores, teeboxId } = req.body;
  if (!Array.isArray(holeScores)) return res.status(400).json({ error: 'holeScores required' });

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
    `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (match_id, user_id)
     DO UPDATE SET hole_scores = $5,
                   course_id = COALESCE(rounds.course_id, EXCLUDED.course_id),
                   teebox_id = COALESCE(rounds.teebox_id, EXCLUDED.teebox_id)`,
    [req.params.id, req.userId, pRows[0].course_id, pRows[0].teebox_id, holeScores]
  );
  return res.json({ success: true });
}));

// Notify friends that the user has started a round. Idempotent — only fires once per match.
router.post('/:id/started', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Atomic flip: only the first caller for this match gets a row back
  const { rows: flipped } = await pool.query(
    `UPDATE matches SET started_notified = true
     WHERE match_id = $1 AND started_notified = false AND completed = false AND is_practice = false
     RETURNING match_id`,
    [req.params.id]
  );
  if (!flipped.length) return res.json({ success: true, sent: false });

  // Verify caller is in the match
  const { rows: playerRows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!playerRows.length) return res.json({ success: true, sent: false });

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

  // Friends with push tokens
  const { rows: friends } = await pool.query(
    `SELECT u.push_token FROM friends f
     JOIN users u ON u.user_id = f.friend_id
     WHERE f.user_id = $1 AND f.status = 'accepted' AND u.push_token IS NOT NULL`,
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
