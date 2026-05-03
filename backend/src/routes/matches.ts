import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';

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

// holesPlayed / teeboxHoles scales the rating for partial rounds (e.g. 9 holes on an 18-hole course)
function scoreDifferential(gross: number, courseRating: number, slopeRating: number, holesPlayed = 18, teeboxHoles = 18) {
  const adjustedRating = courseRating * (holesPlayed / teeboxHoles);
  return (gross - adjustedRating) * (113 / slopeRating);
}

// Create match
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { matchType, name, isPractice, teeboxId } = req.body;
  if (!matchType) return res.status(400).json({ error: 'matchType required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO matches (match_type, name, is_practice)
       VALUES ($1, $2, $3) RETURNING *`,
      [matchType, name || null, isPractice || false]
    );
    const match = rows[0];
    await client.query(
      `INSERT INTO match_players (match_id, user_id, teebox_id, side)
       VALUES ($1, $2, $3, 1)`,
      [match.match_id, req.userId, teeboxId || null]
    );
    await client.query('COMMIT');
    return res.status(201).json(match);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Get match details
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows: matchRows } = await pool.query(
    `SELECT * FROM matches WHERE match_id = $1`,
    [req.params.id]
  );
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });

  const { rows: players } = await pool.query(
    `SELECT mp.user_id, mp.side, mp.strokes, mp.completed, mp.teebox_id,
            u.username, u.elo, u.avatar_url,
            t.name AS teebox_name, t.course_rating, t.slope_rating, t.par,
            t.course_id, t.num_holes
     FROM match_players mp
     JOIN users u ON u.user_id = mp.user_id
     LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     WHERE mp.match_id = $1`,
    [req.params.id]
  );

  const { rows: resultRows } = await pool.query(
    `SELECT * FROM match_results WHERE match_id = $1`,
    [req.params.id]
  );

  return res.json({ ...matchRows[0], players, result: resultRows[0] || null });
});

// List my matches
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT m.match_id, m.match_type, m.name, m.completed, m.created_at, m.is_practice,
            mr.winner_side, mr.delta_elo,
            mp_me.side AS my_side, mp_me.strokes AS my_strokes
     FROM matches m
     JOIN match_players mp_me ON mp_me.match_id = m.match_id AND mp_me.user_id = $1
     LEFT JOIN match_results mr ON mr.match_id = m.match_id
     ORDER BY m.created_at DESC LIMIT 50`,
    [req.userId]
  );
  return res.json(rows);
});

// Join a match (opponent side)
router.post('/:id/join', requireAuth, async (req: AuthRequest, res: Response) => {
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
});

// Submit scores for a round
router.post('/:id/scores', requireAuth, async (req: AuthRequest, res: Response) => {
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

    const resolvedTeeboxId = teeboxId || matchRows[0].player_teebox;

    // Upsert round
    await client.query(
      `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, total_score, round_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (match_id, user_id)
       DO UPDATE SET hole_scores = $5, total_score = $6, teebox_id = $4`,
      [req.params.id, req.userId, courseId || null, resolvedTeeboxId || null, holeScores, totalScore, matchRows[0].match_type]
    );

    // Update match_players
    await client.query(
      `UPDATE match_players SET strokes = $1, completed = true, teebox_id = COALESCE($2, teebox_id)
       WHERE match_id = $3 AND user_id = $4`,
      [totalScore, resolvedTeeboxId, req.params.id, req.userId]
    );

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
      const getDiff = (players: typeof allPlayers) => {
        const diffs = players.map((p) =>
          p.course_rating && p.slope_rating
            ? scoreDifferential(p.strokes, p.course_rating, p.slope_rating, p.holes_played, p.teebox_num_holes || p.holes_played)
            : p.strokes
        );
        return diffs.reduce((a: number, b: number) => a + b, 0) / diffs.length;
      };
      const side1Diff = getDiff(side1Players);
      const side2Diff = getDiff(side2Players);
      const side1Wins = side1Diff <= side2Diff;
      const p1 = side1Players[0];
      const p2 = side2Players[0];
      const expA = expectedScore(p1.elo, p2.elo);
      const k = kFactor(p1.total_matches, p1.elo);
      const deltaElo = Math.round(k * ((side1Wins ? 1 : 0) - expA));

      for (const p of [...side1Players, ...side2Players]) {
        const won = (side1Players.includes(p)) === side1Wins;
        const eloChange = side1Players.includes(p) ? deltaElo : -deltaElo;
        await client.query(
          `UPDATE users SET elo = GREATEST(100, elo + $1), total_matches = total_matches + 1,
           total_wins = total_wins + $2 WHERE user_id = $3`,
          [eloChange, won ? 1 : 0, p.user_id]
        );
      }

      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
         side2_score_differential, delta_elo, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          matchId, matchType, side1Wins ? 1 : 2, side1Diff, side2Diff, Math.abs(deltaElo),
          JSON.stringify({
            side1Players: side1Players.map((p) => p.user_id),
            side2Players: side2Players.map((p) => p.user_id),
          }),
        ]
      );
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [matchId]);
      return { winnerSide: side1Wins ? 1 : 2, deltaElo, side1Diff, side2Diff };
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

        // Build the player objects used only for ELO resolution.
        // Cross-format: normalise the 18-hole player to a 9-hole equivalent by halving
        // their strokes (average of front 9 and back 9) and their course rating.
        // scoreDifferential then compares both players on the same 9-hole basis.
        let myPForElo = { ...myP };
        let oppForElo = { ...opp, side: 2 };

        if (isCrossFormat) {
          const myIs18 = myP.holes_played > opp.holes_played;
          const eighteenSide = myIs18 ? myPForElo : oppForElo;
          eighteenSide.strokes = Math.round(eighteenSide.strokes / 2);
          if (eighteenSide.course_rating) eighteenSide.course_rating = eighteenSide.course_rating / 2;
          eighteenSide.holes_played = 9;
          eighteenSide.teebox_num_holes = 9;
        }

        result = await resolveElo([myPForElo], [oppForElo], req.params.id, matchRows[0].match_type);
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

    await client.query('COMMIT');
    return res.json({ success: true, totalScore, result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Fix: add unique constraint for rounds
// We need to handle the ON CONFLICT — add it to schema.

export default router;
