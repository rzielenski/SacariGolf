import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { processMentions } from '../utils/mentions';
import { wrap } from '../utils/asyncHandler';
import { equippedVisualSql } from '../utils/cosmeticSql';
import { computeLeaderboard } from '../utils/leaderboard';
import { ALLOWED_CLUBS_SHOT as ALLOWED_CLUBS } from '../utils/clubs';
import { syncRoundNormalized } from '../utils/roundScore';
import { diff18 } from '../utils/scoring';
import { currentSeason, divisionForElo } from './seasons';

const router = Router();

// ELO helpers
export function expectedScore(rA: number, rB: number) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

export function kFactor(totalMatches: number, elo: number) {
  if (totalMatches < 30) return 32;
  if (elo >= 2400) return 16;
  return 24;
}

// ── Ranked-climb shaping (League-style) ───────────────────────────────
// Two levers make the ladder feel climbable instead of glacial:
//   • PLACEMENTS — your first few ranked matches each SEASON swing much
//     harder (both ways), so a new or returning player rockets to their
//     true rank instead of grinding up from the floor. This is what lets
//     you "skip divisions": a placement win can be worth a whole band.
//   • MINIMUM WIN — every win moves you up by at least a floor amount, so
//     beating a weaker opponent still progresses you (the classic "I won
//     but gained +1" stall at the top of a band is gone).
// The seasonal partial reset (utils/cleanup.ts) mops up the mild ELO
// inflation the minimum-win floor introduces, so it stays self-correcting.
const PLACEMENT_MATCHES = 5;          // mirrors seasons.ts
const PLACEMENT_MULTIPLIER = 3;       // placement results swing 3x
const PLACEMENT_MIN_WIN_DELTA = 50;   // a placement WIN is at least this
const MIN_WIN_DELTA = 12;             // any other win is at least this
// Asymmetric climb: a win gains more than the matching loss costs, so players
// trend upward and the ladder feels good to climb. The seasonal partial reset
// (utils/cleanup.ts) compresses the resulting mild inflation each season, so
// it stays self-correcting. Applied to the WIN side only.
const WIN_GAIN_MULTIPLIER = 1.35;

/** Set of user_ids still in their season placements — fewer than
 *  PLACEMENT_MATCHES completed ranked matches THIS season (excluding the
 *  match currently resolving). Those players get the big placement swing. */
export async function placementUserSet(
  client: any, userIds: string[], excludeMatchId: string,
): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const season = currentSeason();
  const { rows } = await client.query(
    `SELECT mp.user_id, COUNT(*)::int AS n
       FROM match_results mr
       JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
       JOIN match_players mp ON mp.match_id = mr.match_id
      WHERE mp.user_id = ANY($1)
        AND mr.match_id <> $2
        AND mr.created_at >= $3 AND mr.created_at < $4
      GROUP BY mp.user_id`,
    [userIds, excludeMatchId, season.starts_at, season.ends_at]
  );
  const counts = new Map<string, number>(rows.map((r: any) => [r.user_id, r.n]));
  return new Set(userIds.filter((id) => (counts.get(id) ?? 0) < PLACEMENT_MATCHES));
}

/** Shape a base signed ELO delta: apply the placement multiplier, then
 *  floor a win to its minimum. Placement losses scale 3x too (you fall to
 *  your true rank fast); losses are otherwise left as computed. */
export function shapeDelta(base: number, won: boolean, isPlacement: boolean): number {
  let d = isPlacement ? base * PLACEMENT_MULTIPLIER : base;
  // Wins climb faster than losses fall (asymmetric, win side only).
  if (won && d > 0) d *= WIN_GAIN_MULTIPLIER;
  d = Math.round(d);
  if (won) {
    const floor = isPlacement ? PLACEMENT_MIN_WIN_DELTA : MIN_WIN_DELTA;
    if (d < floor) d = floor;
  }
  return d;
}

// diff18 (the 18-hole-equivalent score differential used for ELO) now lives in
// utils/scoring.ts — the single home for all round-scoring math — and is
// imported at the top of this file. The old un-doubled scoreDifferential was
// dead code (no call sites) and was removed.

// Create match
// Allowed match formats. `stroke` is the default (gross score wins). The new
// formats only affect HOW the winner is decided + how the result UI reads —
// the underlying score arrays / shot tracks / handicap math don't change.
//   • stableford   — Modified Stableford: -2/-1/0/1/2/3+ → 5/2/0/-1/-3/-3 pts (higher wins)
//   • match_play   — One point per hole won (lower stroke wins the hole; halves get nothing)
//   • skins        — Like match play, but ties carry the skin to the next hole
//   • scramble     — Existing team format (one final team score per side)
const VALID_FORMATS = new Set(['stroke', 'stableford', 'match_play', 'skins', 'scramble']);
router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchType, name, isPractice, teeboxId, clanId, format, numHoles, holesSubset, challengeUserId, tournamentId } = req.body;
  // A direct challenge to one friend. When set, the match is earmarked for
  // them (invite created in the same transaction) and auto-pairing is skipped,
  // so it can never grab a stranger before/while the friend is invited.
  const challengeTarget = (typeof challengeUserId === 'string' && challengeUserId && challengeUserId !== req.userId)
    ? challengeUserId : null;
  if (!matchType) return res.status(400).json({ error: 'matchType required' });
  // Scramble remains team-only; the rest are open to any match type.
  let resolvedFormat = 'stroke';
  if (typeof format === 'string' && VALID_FORMATS.has(format)) {
    if (format === 'scramble' && matchType !== 'duo' && matchType !== 'squad') {
      resolvedFormat = 'stroke'; // silently downgrade — solo/ffa scramble doesn't make sense
    } else if ((format === 'match_play' || format === 'skins') && matchType === 'ffa') {
      // match_play / skins are inherently 1v1 — for arena (3+ players) we
      // fall back to stroke. Stableford works fine for N players (sum points).
      resolvedFormat = 'stroke';
    } else {
      resolvedFormat = format;
    }
  }
  const resolvedNumHoles = (numHoles === 9) ? 9 : 18;
  // Front vs back is only meaningful for 9-hole matches. 18-hole = 'full'.
  // Default to 'front' if the client picked 9 but didn't say which.
  const resolvedHolesSubset = resolvedNumHoles === 9
    ? (holesSubset === 'back' ? 'back' : 'front')
    : 'full';

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
        return res.status(403).json({ error: 'Only the team leader can start a squad match' });
      }
    }

    // Tournament tagging: a round counts toward a tournament only if the creator
    // is a registered player of an ACTIVE tournament. Otherwise it's silently
    // dropped (the round still plays, just untagged) so a bad id can't 500 a
    // legitimate match create.
    let resolvedTournamentId: string | null = null;
    if (typeof tournamentId === 'string' && tournamentId) {
      const { rows: tg } = await client.query(
        `SELECT 1 FROM tournaments t
           JOIN tournament_players tp ON tp.tournament_id = t.tournament_id AND tp.user_id = $2
          WHERE t.tournament_id = $1 AND t.status = 'active'`,
        [tournamentId, req.userId],
      );
      if (tg.length) resolvedTournamentId = tournamentId;
    }

    const { rows } = await client.query(
      `INSERT INTO matches (match_type, name, is_practice, format, num_holes, clan_id, holes_subset, tournament_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [matchType, name || null, isPractice || false, resolvedFormat, resolvedNumHoles, clanId || null, resolvedHolesSubset, resolvedTournamentId]
    );
    const match = rows[0];

    await client.query(
      `INSERT INTO match_players (match_id, user_id, teebox_id, side)
       VALUES ($1, $2, $3, 1)`,
      [match.match_id, req.userId, teeboxId || null]
    );

    // Direct challenge: attach the invite to the chosen opponent inside the
    // same transaction, before any auto-pairing can run. Combined with the
    // auto-pair skip below, the match waits for this friend (3-day window).
    if (challengeTarget) {
      await client.query(
        `INSERT INTO match_invites (match_id, from_user_id, to_user_id, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '3 days')
         ON CONFLICT (match_id, to_user_id) DO NOTHING`,
        [match.match_id, req.userId, challengeTarget]
      );
    }

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

    // ── Auto-pairing on creation (solo, duo, squad) ─────────────────────
    // Try to immediately pair this match against another open match in the
    // pool. The MatchFoundWatcher on both phones detects `has_opponent`
    // flipping and fires the VS intro animation — the user sees it the
    // moment they create the match (or the moment their opponent's leader
    // does, in which case it pops up on their existing match).
    //
    // Wrapped in try/catch so a transient error (e.g. cancelled column not
    // yet migrated) only skips pairing instead of failing match creation.
    let autoPairedOpponentMatchId: string | null = null;
    try {
    // Arena (ffa) matches are invite-only — never auto-paired against
    // strangers. The host invites friends; accepters join as new sides.
    // Direct challenges also skip auto-pair — they wait for the invited friend.
    if (!isPractice && matchType !== 'ffa' && !challengeTarget) {
      // Find candidate opponent matches:
      //   • same match_type, format, num_holes
      //   • still open (not completed, not cancelled, not superseded)
      //   • created in the last 24 h (don't pair stale stuff)
      //   • doesn't already have an opponent (no players on side != 1)
      //   • doesn't include the creator as a player
      // Sorted by ELO proximity using each team's average ELO.
      const { rows: candidates } = await client.query(
        `SELECT m.match_id
         FROM matches m
         WHERE m.match_id != $1
           AND m.match_type = $2
           AND m.format = $3
           AND m.num_holes = $4
           AND m.completed = false
           AND m.cancelled = false
           AND m.superseded_by_match_id IS NULL
           AND m.is_practice = false
           AND m.created_at > NOW() - INTERVAL '24 hours'
           AND NOT EXISTS (
             SELECT 1 FROM match_players mp_opp
             WHERE mp_opp.match_id = m.match_id AND mp_opp.side != 1
           )
           -- Self-pair protection (always on): never pair against my own
           -- user — that would auto-match me with myself.
           AND NOT EXISTS (
             SELECT 1 FROM match_players mp_self
             WHERE mp_self.match_id = m.match_id AND mp_self.user_id = $5
           )
           -- Same-team protection (DUO / SQUAD only): two clanmates would
           -- never want their TEAM to play itself. But for solo matches,
           -- two players who happen to share a clan should absolutely be
           -- able to 1v1 — that's a normal "in-house" matchup, just like
           -- two friends who play in the same league. The match_type test
           -- gates the clan filter to only the team-vs-team formats.
           AND (
             $2 = 'solo'
             OR (
               NOT (m.clan_id IS NOT NULL AND m.clan_id = $6)
               AND NOT EXISTS (
                 SELECT 1 FROM match_players mp_cand
                 JOIN clan_members cm_me ON cm_me.user_id = $5
                 JOIN clan_members cm_them ON cm_them.user_id = mp_cand.user_id
                                          AND cm_them.clan_id = cm_me.clan_id
                 WHERE mp_cand.match_id = m.match_id
               )
             )
           )
           -- Direct-challenge grace: never auto-pair against a SOLO match that
           -- has an active challenge invite (a friend was challenged within the
           -- last 3 days). It rejoins the pool once the invite is answered or
           -- the 3-day window lapses.
           AND (
             $2 <> 'solo'
             OR NOT EXISTS (
               SELECT 1 FROM match_invites mi
               WHERE mi.match_id = m.match_id AND mi.status = 'pending'
                 AND mi.created_at > NOW() - INTERVAL '3 days'
             )
           )
         ORDER BY ABS(
           COALESCE((SELECT AVG(u.elo) FROM match_players mp_a
                     JOIN users u ON u.user_id = mp_a.user_id
                     WHERE mp_a.match_id = $1), 100) -
           COALESCE((SELECT AVG(u.elo) FROM match_players mp_b
                     JOIN users u ON u.user_id = mp_b.user_id
                     WHERE mp_b.match_id = m.match_id), 100)
         )
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [match.match_id, matchType, resolvedFormat, resolvedNumHoles, req.userId, clanId || null]
      );

      if (candidates.length) {
        autoPairedOpponentMatchId = candidates[0].match_id;
        // Move opponent team's players into THIS match as side 2.
        await client.query(
          `INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
           SELECT $1, user_id, teebox_id, 2, strokes, completed
           FROM match_players
           WHERE match_id = $2
           ON CONFLICT (match_id, user_id) DO NOTHING`,
          [match.match_id, autoPairedOpponentMatchId]
        );
        // Migrate any pending invites from the opponent's match so their
        // teammates who haven't accepted yet end up on side 2 of THIS match.
        await client.query(
          `UPDATE match_invites SET match_id = $1
           WHERE match_id = $2 AND status = 'pending'`,
          [match.match_id, autoPairedOpponentMatchId]
        );
        // Migrate the opponent's round (if any score data was already saved)
        await client.query(
          `UPDATE rounds SET match_id = $1
           WHERE match_id = $2`,
          [match.match_id, autoPairedOpponentMatchId]
        );
        // Mark opponent's original match as superseded so it disappears from
        // their list and they only see THIS match (where they're side 2).
        await client.query(
          `UPDATE matches SET completed = true, superseded_by_match_id = $1
           WHERE match_id = $2`,
          [match.match_id, autoPairedOpponentMatchId]
        );
        // Push-notify the opponent team that they've been matched.
        const { rows: oppPushRows } = await client.query(
          `SELECT u.push_token FROM match_players mp
           JOIN users u ON u.user_id = mp.user_id
           WHERE mp.match_id = $1 AND u.push_token IS NOT NULL`,
          [match.match_id]
        );
        const oppTokens = oppPushRows.map((r: any) => r.push_token).filter(Boolean);
        if (oppTokens.length) {
          await sendPush(
            oppTokens,
            'Match Found',
            `Your ${matchType} match has been paired with an opponent!`,
            { type: 'matchFound', matchId: match.match_id }
          );
        }
      }
    }
    } catch (pairErr) {
      // Pairing is best-effort — log and continue. The match is still valid
      // without an opponent (player can wait for next pool sweep on their
      // submission, or for the next opposing leader to create a match).
      console.warn('[match-create] auto-pair failed:', pairErr);
    }

    await client.query('COMMIT');

    // Notify a directly-challenged friend (best-effort, after commit).
    if (challengeTarget) {
      try {
        const { rows: pushRows } = await pool.query(
          `SELECT u.push_token, me.username AS from_name
             FROM users u, users me
            WHERE u.user_id = $1 AND me.user_id = $2`,
          [challengeTarget, req.userId]
        );
        if (pushRows[0]?.push_token) {
          await sendPush(
            [pushRows[0].push_token],
            'Match Challenge',
            `${pushRows[0].from_name} challenged you to a match — accept within 3 days!`,
            { type: 'invite', matchId: match.match_id }
          );
        }
      } catch { /* push is best-effort */ }
    }

    return res.status(201).json({ ...match, auto_paired: !!autoPairedOpponentMatchId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Full per-player projection for the match-detail screen. Shared between
// the primary match and (for linked matches) the paired match, whose
// players are presented as the opponent side. $1 = match_id.
const MATCH_DETAIL_PLAYERS_SQL = `
  SELECT mp.user_id, mp.side, mp.strokes, mp.completed, mp.teebox_id,
         mp.live_scores_optin,
         u.username, u.elo, u.avatar_url, u.handicap_index,
         ${equippedVisualSql('u')} AS equipped_visual,
         t.name AS teebox_name, t.course_rating, t.slope_rating, t.par,
         t.course_id, t.num_holes,
         c.course_name,
         r.round_id, r.hole_scores, r.hole_stats,
         -- Personal theme song — falls back to this if no team theme.
         u.theme_track_title   AS user_theme_title,
         u.theme_track_artist  AS user_theme_artist,
         u.theme_track_artwork AS user_theme_artwork,
         u.theme_track_preview AS user_theme_preview,
         -- Team attribution (for the match-found "VS" transition).
         -- Picks the player's most-recently-joined team as their banner.
         cl.clan_id,
         cl.name              AS clan_name,
         cl.elo               AS clan_elo,
         cl.avatar_url        AS clan_avatar_url,
         cl.theme_track_title AS clan_theme_title,
         cl.theme_track_artist AS clan_theme_artist,
         cl.theme_track_artwork AS clan_theme_artwork,
         cl.theme_track_preview AS clan_theme_preview
  FROM match_players mp
  JOIN users u ON u.user_id = mp.user_id
  LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
  LEFT JOIN courses c ON c.course_id = t.course_id
  LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
  LEFT JOIN LATERAL (
    SELECT cl.clan_id, cl.name, cl.elo, cl.avatar_url,
           cl.theme_track_title, cl.theme_track_artist,
           cl.theme_track_artwork, cl.theme_track_preview
      FROM clan_members cm
      JOIN clans cl ON cl.clan_id = cm.clan_id
     WHERE cm.user_id = mp.user_id
     ORDER BY cm.joined_at DESC
     LIMIT 1
  ) cl ON true
  WHERE mp.match_id = $1`;

// Per-player projection used by score resolution (ratings + holes played +
// ELO). Shared between a match and, for linked matches, its paired match.
// $1 = match_id.
const MATCH_SCORING_PLAYERS_SQL = `
  SELECT mp.user_id, mp.side, mp.strokes, mp.teebox_id,
         t.course_rating, t.slope_rating, t.par,
         t.front_course_rating, t.front_slope_rating,
         t.back_course_rating,  t.back_slope_rating,
         t.num_holes AS teebox_num_holes,
         r.hole_scores,
         COALESCE(array_length(r.hole_scores, 1), 18) AS holes_played,
         u.elo, u.total_matches
  FROM match_players mp
  JOIN users u ON u.user_id = mp.user_id
  LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
  LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
  WHERE mp.match_id = $1`;

/**
 * Resolve a LINKED pair of matches (matchA's team vs matchB's team).
 *
 * Single source of truth for linked resolution — called from BOTH the
 * score-submit handler (when the last player of the pair finishes) AND
 * the cron link pass (to immediately resolve a pair that was ALREADY
 * fully played before being linked, e.g. two finished-and-waiting matches
 * the backfill just connected).
 *
 * Self-contained and idempotent: loads both matches' meta + players +
 * par-by-hole itself, returns null (no-op) unless BOTH matches are fully
 * played and neither is already completed. Applies ELO exactly once
 * across both rosters, writes a perspective-correct match_results row to
 * each match (its own players = side 1; winner_side + signed deltas flip),
 * completes both, and posts a round card per player on their own match.
 *
 * A shared player appears in both rosters with two different rounds: they
 * net ~0 ELO (win one side, lose the other) and both matches count toward
 * their record, because they genuinely played two rounds.
 *
 * MUST be passed a client already inside a transaction.
 */
export async function resolveLinkedPair(
  client: any,
  matchAId: string,
  matchBId: string,
): Promise<any | null> {
  const { rows: meta } = await client.query(
    `SELECT match_id, match_type, format, holes_subset, num_holes, completed, is_practice
       FROM matches WHERE match_id IN ($1, $2)`,
    [matchAId, matchBId]
  );
  const a = meta.find((m: any) => m.match_id === matchAId);
  const b = meta.find((m: any) => m.match_id === matchBId);
  if (!a || !b) return null;
  if (a.completed || b.completed) return null;       // already resolved
  if (a.is_practice || b.is_practice) return null;

  const { rows: curPlayers } = await client.query(MATCH_SCORING_PLAYERS_SQL, [matchAId]);
  const { rows: parPlayers } = await client.query(MATCH_SCORING_PLAYERS_SQL, [matchBId]);
  if (!curPlayers.length || !parPlayers.length) return null;
  if (!curPlayers.every((p: any) => p.strokes != null)) return null;
  if (!parPlayers.every((p: any) => p.strokes != null)) return null;

  const matchFormat: string = a.format ?? 'stroke';
  const holesSubsetForCalc: string = a.holes_subset ?? 'full';
  const matchType: string = a.match_type;

  // Per-hole pars for the played slice (hole-by-hole formats only).
  let parByHoleIdx: number[] = [];
  const tbId = curPlayers.find((p: any) => p.teebox_id)?.teebox_id;
  if (tbId) {
    const { rows: holeRows } = await client.query(
      `SELECT hole_num, par FROM holes WHERE teebox_id = $1 ORDER BY hole_num`,
      [tbId]
    );
    const offset = holesSubsetForCalc === 'back' ? 9 : 0;
    const want = a.num_holes ?? 18;
    parByHoleIdx = holeRows.slice(offset, offset + want).map((r: any) => r.par);
  }

  // ── Format-perf helpers (lower = better), mirroring the 1v1/team path ──
  const modifiedStablefordPoints = (score: number, par: number): number => {
    const d = score - par;
    if (d <= -2) return 5;
    if (d === -1) return 2;
    if (d === 0) return 0;
    if (d === 1) return -1;
    return -3;
  };
  const bestHoleScore = (side: any[], idx: number): number | null => {
    let best: number | null = null;
    for (const p of side) {
      const s = (p.hole_scores as number[] | null)?.[idx];
      if (typeof s !== 'number') continue;
      if (best == null || s < best) best = s;
    }
    return best;
  };
  const computeFormatPerf = (format: string, side1: any[], side2: any[]) => {
    const N = parByHoleIdx.length;
    if (!N) return null;
    if (format === 'stableford') {
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        const x = bestHoleScore(side1, i);
        const y = bestHoleScore(side2, i);
        if (x != null) s1 += modifiedStablefordPoints(x, parByHoleIdx[i]);
        if (y != null) s2 += modifiedStablefordPoints(y, parByHoleIdx[i]);
      }
      return { side1Perf: -s1, side2Perf: -s2, details: { s1Points: s1, s2Points: s2 } };
    }
    if (format === 'match_play') {
      let s1Wins = 0, s2Wins = 0, halved = 0;
      for (let i = 0; i < N; i++) {
        const x = bestHoleScore(side1, i);
        const y = bestHoleScore(side2, i);
        if (x == null || y == null) continue;
        if (x < y) s1Wins++; else if (y < x) s2Wins++; else halved++;
      }
      return { side1Perf: -s1Wins, side2Perf: -s2Wins, details: { s1Holes: s1Wins, s2Holes: s2Wins, halved } };
    }
    if (format === 'skins') {
      let s1Skins = 0, s2Skins = 0, carry = 1;
      for (let i = 0; i < N; i++) {
        const x = bestHoleScore(side1, i);
        const y = bestHoleScore(side2, i);
        if (x == null || y == null) continue;
        const value = carry;
        if (x < y) { s1Skins += value; carry = 1; }
        else if (y < x) { s2Skins += value; carry = 1; }
        else { carry += 1; }
      }
      return { side1Perf: -s1Skins, side2Perf: -s2Skins, details: { s1Skins, s2Skins } };
    }
    return null;
  };

  const getDiff = (ps: any[], topN?: number) => {
    const diffs = ps.map((p: any) => {
      if (!p.course_rating || !p.slope_rating) return p.strokes;
      const overrideRating =
        holesSubsetForCalc === 'front' ? p.front_course_rating
        : holesSubsetForCalc === 'back'  ? p.back_course_rating
        : null;
      const overrideSlope =
        holesSubsetForCalc === 'front' ? p.front_slope_rating
        : holesSubsetForCalc === 'back'  ? p.back_slope_rating
        : null;
      return diff18(
        p.strokes, p.course_rating, p.slope_rating,
        p.holes_played, p.teebox_num_holes || p.holes_played,
        overrideRating, overrideSlope,
      );
    }).sort((x: number, y: number) => x - y);
    const used = topN ? diffs.slice(0, topN) : diffs;
    return used.reduce((x: number, y: number) => x + y, 0) / used.length;
  };

  const compareCount = Math.min(curPlayers.length, parPlayers.length);
  const strokeCurDiff = getDiff(curPlayers, compareCount);
  const strokeParDiff = getDiff(parPlayers, compareCount);
  const formatPerf = computeFormatPerf(matchFormat, curPlayers, parPlayers);
  const curDiff = formatPerf ? formatPerf.side1Perf : strokeCurDiff;
  const parDiff = formatPerf ? formatPerf.side2Perf : strokeParDiff;
  const formatDetails = formatPerf?.details ?? null;

  const isTie = Math.abs(curDiff - parDiff) < 0.05;
  const curWins = !isTie && curDiff < parDiff;

  const c1 = curPlayers[0];
  const p1 = parPlayers[0];
  const expCur = expectedScore(c1.elo, p1.elo);
  const k = kFactor(c1.total_matches, c1.elo);
  const curActual = isTie ? 0.5 : (curWins ? 1 : 0);
  const curDelta = Math.round(k * (curActual - expCur));
  const parDelta = -curDelta;

  const perkApplications: { user_id: string; original: number; adjusted: number; type: string }[] = [];
  const allIds = [...curPlayers, ...parPlayers].map((p: any) => p.user_id);
  const { rows: perkRows } = await client.query(
    `SELECT DISTINCT ON (user_id) user_id, perk_id
     FROM user_perks
     WHERE user_id = ANY($1)
       AND consumed_at IS NULL
       AND (earned_match_id IS NULL OR (earned_match_id != $2 AND earned_match_id != $3))
     ORDER BY user_id, earned_at ASC`,
    [allIds, matchAId, matchBId]
  );
  const perkByUser = new Map<string, string>(perkRows.map((r: any) => [r.user_id, r.perk_id]));
  const perkConsumed = new Set<string>();

  // Placement shaping. The shared player is on BOTH sides, so each side's
  // final delta is tracked separately — their match-A screen should show
  // their side-A delta, their match-B screen the side-B delta.
  const placementSet = await placementUserSet(client, allIds, matchAId);
  const curDeltas: Record<string, number> = {};
  const parDeltas: Record<string, number> = {};

  const applySide = async (
    ps: any[], delta: number, sideWon: boolean, into: Record<string, number>,
  ) => {
    for (const p of ps) {
      let eloChange = shapeDelta(delta, sideWon, placementSet.has(p.user_id));
      const perkId = perkByUser.get(p.user_id);
      // A shared player can appear on both sides; let their perk fire once.
      if (perkId && eloChange !== 0 && !perkConsumed.has(p.user_id)) {
        const before = eloChange;
        if (eloChange < 0) eloChange = 0; else eloChange = eloChange * 2;
        perkConsumed.add(p.user_id);
        await client.query(
          `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
          [perkId, matchAId]
        );
        perkApplications.push({ user_id: p.user_id, original: before, adjusted: eloChange, type: 'lucky_round' });
      }
      into[p.user_id] = eloChange;
      await client.query(
        `UPDATE users
         SET elo = GREATEST(100, elo + $1),
             total_matches = total_matches + 1,
             total_wins = total_wins + $2,
             total_ties = total_ties + $3
         WHERE user_id = $4`,
        [eloChange, sideWon ? 1 : 0, isTie ? 1 : 0, p.user_id]
      );
    }
  };
  await applySide(curPlayers, curDelta, !isTie && curWins, curDeltas);
  await applySide(parPlayers, parDelta, !isTie && !curWins, parDeltas);

  const writeResult = async (
    matchId: string, s1: any[], s2: any[],
    s1Diff: number, s2Diff: number, s1Delta: number, s2Delta: number, s1Won: boolean,
    playerDeltas: Record<string, number>,
  ) => {
    await client.query(
      `INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
       side2_score_differential, delta_elo, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (match_id) DO NOTHING`,
      [
        matchId, matchType,
        isTie ? null : (s1Won ? 1 : 2),
        s1Diff, s2Diff, Math.abs(curDelta),
        JSON.stringify({
          side1Players: s1.map((p: any) => p.user_id),
          side2Players: s2.map((p: any) => p.user_id),
          tied: isTie,
          side1DeltaSignedElo: s1Delta,
          side2DeltaSignedElo: s2Delta,
          playerDeltas,
          perks: perkApplications,
          format: matchFormat,
          formatDetails,
          linked: true,
        }),
      ]
    );
    await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [matchId]);
    await client.query(
      `INSERT INTO posts (user_id, kind, match_id, body)
       SELECT pid, 'round', $2, r.caption
         FROM unnest($1::uuid[]) AS pid
         LEFT JOIN rounds r ON r.match_id = $2 AND r.user_id = pid`,
      [s1.map((p: any) => p.user_id), matchId]
    );
  };

  // Each row's playerDeltas favors ITS side-1 players (the shared player's
  // side-appropriate delta wins the merge).
  await writeResult(matchAId, curPlayers, parPlayers, curDiff, parDiff, curDelta, parDelta, curWins, { ...parDeltas, ...curDeltas });
  await writeResult(matchBId, parPlayers, curPlayers, parDiff, curDiff, parDelta, curDelta, !isTie && !curWins, { ...curDeltas, ...parDeltas });

  return {
    linked: true,
    winnerSide: isTie ? null : (curWins ? 1 : 2),
    tied: isTie,
    deltaElo: Math.abs(curDelta),
    side1Diff: curDiff,
    side2Diff: parDiff,
    perks: perkApplications,
  };
}

// Get match details
router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: matchRows } = await pool.query(
    `SELECT * FROM matches WHERE match_id = $1`,
    [req.params.id]
  );
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });

  const { rows: ownPlayers } = await pool.query(MATCH_DETAIL_PLAYERS_SQL, [req.params.id]);

  // Linked match: pull the paired match's players and present them as the
  // opponent side (side 2), each carrying their OWN match's round data.
  // The mobile screen groups purely by `side` and reads inline hole_scores,
  // so this is all it takes to render a linked matchup as one VS screen.
  // A shared player legitimately appears twice — side 1 (this match) and
  // side 2 (their round in the paired match).
  let players = ownPlayers;
  if (matchRows[0].paired_match_id) {
    const { rows: oppPlayers } = await pool.query(
      MATCH_DETAIL_PLAYERS_SQL, [matchRows[0].paired_match_id]
    );
    players = [...ownPlayers, ...oppPlayers.map((p: any) => ({ ...p, side: 2 }))];
  }

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
      // Prefer the per-player delta (placement + perk already baked in;
      // also the only correct source for FFA). Fall back to the side-level
      // value for legacy result rows written before playerDeltas existed.
      const pd = result.details?.playerDeltas;
      const mine = pd && req.userId ? pd[req.userId] : undefined;
      if (mine != null) {
        my_delta_elo = mine;
      } else if (result.winner_side === null) {
        const key = me.side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
        my_delta_elo = result.details?.[key] ?? 0;
      } else {
        my_delta_elo = result.winner_side === me.side ? result.delta_elo : -result.delta_elo;
      }
      // Perk badge for the result screen. The delta override only matters
      // for legacy rows — playerDeltas already includes the perk.
      const perks = result.details?.perks ?? [];
      my_perk = perks.find((pa: any) => pa.user_id === req.userId) ?? null;
      if (my_perk && mine == null) my_delta_elo = my_perk.adjusted;
    }
  }

  // ── Anti-cheat: hide opponent per-hole detail while the match is live ──
  // Even if my opponent is my friend, I shouldn't be able to scout their
  // round before mine is in. Redact hole_scores / hole_stats / strokes /
  // round_id on any player whose side differs from mine until the match
  // is completed. For Arena (ffa) every other player is a different side,
  // so they're all hidden. Same-side teammates (duo/squad) stay visible —
  // we're on the same team, our scores need to combine.
  // NOTE: we ALWAYS leave the array length intact via a sanitized stub so
  // the UI can still show "thru hole N" without leaking actual scores.
  const matchCompleted = !!matchRows[0].completed;
  const me = players.find((p: any) => p.user_id === req.userId);
  const mySide = me?.side ?? null;

  // Live scoreboard: when at least one player on EACH side has opted in
  // ("both sides agree"), the anti-cheat redaction lifts and everyone sees
  // live scores hole-by-hole. Consensual, so it's not a cheat vector.
  const side1Optin = players.some((p: any) => p.side === 1 && p.live_scores_optin);
  const side2Optin = players.some((p: any) => p.side !== 1 && p.live_scores_optin);
  const liveScoresActive = side1Optin && side2Optin;

  const redactedPlayers = players.map((p: any) => {
    if (matchCompleted) return p;
    if (liveScoresActive) return p;          // both sides agreed → show live
    if (p.user_id === req.userId) return p;
    if (mySide != null && p.side === mySide) return p;
    const playedLen = Array.isArray(p.hole_scores) ? p.hole_scores.length : 0;
    return {
      ...p,
      hole_scores: playedLen > 0 ? new Array(playedLen).fill(null) : [],
      hole_stats: null,
      strokes: null,
      round_id: null,
    };
  });

  return res.json({
    ...matchRows[0],
    players: redactedPlayers,
    result: resultRows[0] || null,
    my_delta_elo, my_perk,
    // Live-scoreboard state for the client.
    live_scores_active: liveScoresActive,
    my_live_optin: !!me?.live_scores_optin,
  });
}));

// List my matches
router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT m.match_id, m.match_type, m.name, m.completed, m.cancelled,
            m.created_at, m.is_practice,
            mr.winner_side, mr.delta_elo, mr.details,
            mp_me.side AS my_side, mp_me.strokes AS my_strokes,
            -- Server-side record that the intro animation has fired for
            -- THIS user on THIS match. Watcher uses this to decide whether
            -- to play the VS reveal — guaranteed-once across devices.
            mp_me.intro_shown_at,
            -- True once an opponent exists — either a side-2 player in this
            -- match (merge pairing) OR a linked partner match (linked
            -- pairing, where the opponents live in their own match record).
            -- Powers the "match found" intro on the client — when this flips
            -- from false to true between polls we know to fire the animation.
            (EXISTS(
              SELECT 1 FROM match_players mp_opp
              WHERE mp_opp.match_id = m.match_id
                AND mp_opp.side != mp_me.side
            ) OR m.paired_match_id IS NOT NULL) AS has_opponent
     FROM matches m
     JOIN match_players mp_me ON mp_me.match_id = m.match_id AND mp_me.user_id = $1
     LEFT JOIN match_results mr ON mr.match_id = m.match_id
     WHERE m.superseded_by_match_id IS NULL
     -- Active rounds (not completed AND not cancelled) sort to the TOP so
     -- the LIMIT can never truncate a current/in-progress round off the
     -- list — even for a player with hundreds of finished matches. Within
     -- each group, newest first. Limit bumped to 100 for extra headroom on
     -- the finished-match history below the actives.
     ORDER BY
       (m.completed = false AND m.cancelled = false) DESC,
       m.created_at DESC
     LIMIT 100`,
    [req.userId]
  );
  // Compute signed my_delta_elo per row, honoring perks.
  const decorated = rows.map((r) => {
    let my_delta_elo: number | null = null;
    // Prefer the per-player delta (placement + perk baked in; correct for
    // FFA too). Fall back to the side-level value for legacy rows.
    const pd = r.details?.playerDeltas;
    const mine = pd && req.userId ? pd[req.userId] : undefined;
    if (mine != null) {
      my_delta_elo = mine;
    } else if (r.delta_elo != null && r.my_side != null) {
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

// Opt in / out of the live scoreboard for a match. When at least one
// player on EACH side has opted in, GET /:id stops redacting opponent
// scores so everyone follows the round live (the client re-fetches the
// match to pick up live_scores_active).
router.post('/:id/live-scores', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const optIn = req.body?.optIn === true;
  const { rowCount } = await pool.query(
    `UPDATE match_players SET live_scores_optin = $3
      WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId, optIn]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not in this match' });
  return res.json({ success: true, optIn });
}));

// Live leaderboard for a match: ranked standings (position, thru, to-par /
// points) computed from each player's posted holes. Same consent rule as the
// live scoreboard — we only expose in-progress standings when both sides have
// opted in (or the match is final), so this is never a scouting vector. Open
// to non-participants too once live, which is what lets friends spectate.
router.get('/:id/leaderboard', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const id = req.params.id;
  const { rows: mRows } = await pool.query(
    `SELECT match_id, format, num_holes, holes_subset, completed, is_practice, guest_players
       FROM matches WHERE match_id = $1`,
    [id],
  );
  if (!mRows.length) return res.status(404).json({ error: 'Match not found' });
  const m = mRows[0];

  const { rows: players } = await pool.query(
    `SELECT mp.user_id, mp.side, mp.completed, mp.teebox_id, mp.live_scores_optin,
            u.username, u.avatar_url, u.elo, u.is_bot,
            ${equippedVisualSql('u')} AS equipped_visual,
            r.hole_scores
       FROM match_players mp
       JOIN users u ON u.user_id = mp.user_id
       LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
      WHERE mp.match_id = $1`,
    [id],
  );
  if (!players.length) return res.status(404).json({ error: 'Match not found' });

  // Casual group rounds (is_practice) are organizer-scored on one device with
  // nothing to hide, so their board is always live. Ranked matches still need
  // both sides to opt in (or be final) so it can't be used to scout.
  const side1Optin = players.some((p: any) => p.side === 1 && p.live_scores_optin);
  const side2Optin = players.some((p: any) => p.side !== 1 && p.live_scores_optin);
  const liveActive = m.is_practice || (side1Optin && side2Optin);
  if (!liveActive && !m.completed) {
    return res.json({ active: false, completed: false, format: m.format, num_holes: m.num_holes, leaderboard: [] });
  }

  // Per-hole pars per teebox (cached), sliced to the nine/eighteen played.
  const offset = m.holes_subset === 'back' ? 9 : 0;
  const want = m.num_holes ?? 18;
  const parCache = new Map<string, number[]>();
  const parsFor = async (teeboxId: string | null): Promise<number[]> => {
    if (!teeboxId) return [];
    const hit = parCache.get(teeboxId);
    if (hit) return hit;
    const { rows } = await pool.query(
      `SELECT par FROM holes WHERE teebox_id = $1 ORDER BY hole_num`, [teeboxId],
    );
    const arr = rows.slice(offset, offset + want).map((h: any) => h.par);
    parCache.set(teeboxId, arr);
    return arr;
  };

  const entries = [];
  for (const p of players) {
    entries.push({
      user_id: p.user_id, username: p.username, side: p.side,
      hole_scores: p.hole_scores ?? [],
      parByHole: await parsFor(p.teebox_id),
      completed: p.completed,
      meta: { avatar_url: p.avatar_url, elo: p.elo, is_bot: p.is_bot, equipped_visual: p.equipped_visual },
    });
  }

  // Guests (organizer-scored non-account players) rank right alongside accounts.
  // They use their own teebox's pars, falling back to the host's teebox.
  const fallbackTee = players.find((p: any) => p.teebox_id)?.teebox_id ?? null;
  const guests = Array.isArray(m.guest_players) ? m.guest_players : [];
  for (let gi = 0; gi < guests.length; gi++) {
    const g = guests[gi];
    const scores = Array.isArray(g?.scores) ? g.scores : [];
    if (!scores.some((s: any) => typeof s === 'number' && s > 0)) continue;   // not yet scored
    entries.push({
      user_id: `guest:${gi}`, username: (g?.name || `Guest ${gi + 1}`) as string, side: 0,
      hole_scores: scores,
      parByHole: await parsFor(g?.teebox_id ?? fallbackTee),
      completed: !!m.completed,
      meta: { is_guest: true },
    });
  }

  const leaderboard = computeLeaderboard(entries, m.format);
  return res.json({ active: liveActive, completed: m.completed, format: m.format, num_holes: want, leaderboard });
}));

// Organizer scoring: one person enters hole-by-hole scores for a whole group on
// one device. CASUAL ONLY (is_practice) — these scores never touch ranked ELO,
// and practice rounds are already excluded from handicap + best-round, so an
// organizer typing scores for the table can't game anything. Account players
// must already be in the match (they consented by joining); non-accounts are
// stored as guests. Call repeatedly with partial scores to drive the live
// leaderboard; pass finish:true to lock it in.
//   body: { accounts?: [{ user_id, hole_scores:number[] }],
//           guests?:   [{ name, scores:number[], teebox_id? }],
//           finish?: boolean }
router.post('/:id/organizer-scores', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const id = req.params.id;
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
  const guests = Array.isArray(req.body?.guests) ? req.body.guests : [];
  const finish = req.body?.finish === true;

  const { rows: mRows } = await pool.query(
    `SELECT match_id, is_practice, completed, num_holes, match_type FROM matches WHERE match_id = $1`,
    [id],
  );
  if (!mRows.length) return res.status(404).json({ error: 'Match not found' });
  const m = mRows[0];
  if (m.completed) return res.status(409).json({ error: 'Match already completed' });
  if (!m.is_practice) return res.status(403).json({ error: 'Organizer scoring is only for casual group rounds' });

  const { rows: memberRows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`, [id, req.userId],
  );
  if (!memberRows.length) return res.status(403).json({ error: 'Not in this match' });

  const N = m.num_holes ?? 18;
  const clampScores = (arr: any): number[] => {
    const a = Array.isArray(arr) ? arr : [];
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      const n = parseInt(a[i], 10);
      out.push(Number.isFinite(n) && n > 0 && n < 30 ? n : 0);
    }
    return out;
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const acc of accounts) {
      const uid = acc?.user_id;
      if (!uid) continue;
      // Only write rounds for players actually in this match (consent gate).
      const { rows: chk } = await client.query(
        `SELECT teebox_id FROM match_players WHERE match_id = $1 AND user_id = $2`, [id, uid],
      );
      if (!chk.length) continue;
      const scores = clampScores(acc.hole_scores);
      const total = scores.reduce((s, n) => s + n, 0);
      const tee = chk[0].teebox_id ?? null;
      await client.query(
        `INSERT INTO rounds (match_id, user_id, teebox_id, hole_scores, total_score, round_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (match_id, user_id)
         DO UPDATE SET hole_scores = $4, total_score = $5, teebox_id = COALESCE($3, rounds.teebox_id)`,
        [id, uid, tee, scores, total, m.match_type],
      );
      await client.query(
        `UPDATE match_players
            SET strokes = $1,
                completed = $2,
                completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END
          WHERE match_id = $3 AND user_id = $4`,
        [total, finish, id, uid],
      );
    }

    const cleanedGuests = guests
      .filter((g: any) => (g?.name ?? '').toString().trim())
      .slice(0, 16)
      .map((g: any) => ({
        name: g.name.toString().trim().slice(0, 30),
        scores: clampScores(g.scores),
        teebox_id: g.teebox_id ?? null,
      }));
    await client.query(
      `UPDATE matches SET guest_players = $1::jsonb WHERE match_id = $2`,
      [JSON.stringify(cleanedGuests), id],
    );

    if (finish) {
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [id]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return res.json({ success: true, finished: finish });
}));

// Sanitise a hole_stats array — same length as scores, each entry has
// putts (0–10), chips (0–10), gir (bool), fairwayHit (bool|null) plus the
// optional advanced fields fairwayMiss / greenMiss / puttDistances. Bad input
// is silently dropped rather than failing the whole submission.
const FAIRWAY_MISS_VALUES = new Set(['left', 'right']);
const GREEN_MISS_VALUES = new Set(['left', 'right', 'short', 'long']);
// Putt distances are integer feet, range 0–120 (a 120-ft putt would be a
// nearly-cross-green lag — any longer is almost certainly bad input).
const PUTT_DIST_MAX_FT = 120;

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
      // Cap at the player's putt count when known, else 10. Each entry is an
      // integer feet value; reject negatives, oversized, and non-numeric.
      const max = typeof cleaned.putts === 'number' ? cleaned.putts : 10;
      const dists = h.puttDistances
        .slice(0, max)
        .map((d: any) => Math.round(Number(d)))
        .filter((d: number) => Number.isFinite(d) && d >= 0 && d <= PUTT_DIST_MAX_FT);
      if (dists.length) cleaned.puttDistances = dists;
    }
    return cleaned;
  });
}

// Submit scores for a round
router.post('/:id/scores', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { holeScores, holeStats, courseId, teeboxId, beers, caption } = req.body;
  if (!Array.isArray(holeScores) || holeScores.length === 0) {
    return res.status(400).json({ error: 'holeScores array required' });
  }
  const cleanStats = cleanHoleStats(holeStats, holeScores.length);
  // Beers logged this round — clamp to a sane 0–50 so a buggy client can't
  // poison the Beer Ranker leaderboards. Default 0 when omitted.
  const beerCount = Math.max(0, Math.min(50, Math.round(Number(beers) || 0)));
  // Optional note attached to the round → becomes the body of the 'round'
  // feed post created at resolution (and is scanned for @mentions there).
  // Trimmed + capped so a buggy client can't store a novel.
  const roundCaption = typeof caption === 'string' && caption.trim()
    ? caption.trim().slice(0, 280)
    : null;

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
      // Allow holeScores.length to exceed the teebox cap when it's an integer
      // multiple — that's the "play this 9-hole course as 18" mode. Without
      // this exception a doubled-up round would 400 at submit time. We still
      // reject mismatched lengths (e.g. 12 scores on a 9-hole teebox) to
      // catch real client bugs.
      if (cap && holeScores.length > cap) {
        const isDoubleUp = holeScores.length % cap === 0;
        if (!isDoubleUp) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Cannot submit ${holeScores.length} holes on a ${cap}-hole tee box` });
        }
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
    const { rows: submittedRound } = await client.query(
      `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats, total_score, round_type, beers, caption)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (match_id, user_id)
       DO UPDATE SET hole_scores = $5, hole_stats = $6, total_score = $7, teebox_id = $4, beers = $9, caption = $10
       RETURNING round_id`,
      [req.params.id, req.userId, courseId || null, resolvedTeeboxId || null, holeScores, JSON.stringify(cleanStats), totalScore, matchRows[0].match_type, beerCount, roundCaption]
    );

    // Store this round's 18-hole-equivalent to-par now, computed in app code
    // (utils/roundScore.ts), so it ranks on the cup / course / profile boards
    // immediately. The reconcile tick covers every other write path.
    if (submittedRound[0]?.round_id) {
      await syncRoundNormalized(client, submittedRound[0].round_id);
    }

    // Update match_players for the submitting player
    await client.query(
      `UPDATE match_players SET strokes = $1, completed = true, completed_at = NOW(), teebox_id = COALESCE($2, teebox_id)
       WHERE match_id = $3 AND user_id = $4`,
      [totalScore, resolvedTeeboxId, req.params.id, req.userId]
    );

    // Reconcile the match's hole count with what was ACTUALLY played. A match
    // created as 9 holes where the player logged all 18 (or vice versa) left a
    // stale num_holes that made par, hole-by-hole scoring, and the feed card
    // read against the wrong number of holes. Snap it to the real round length
    // (only the two valid lengths) and fix holes_subset to match. ELO is
    // unaffected — it derives each player's holes from their own hole_scores.
    const playedHoles = holeScores.length;
    if ((playedHoles === 9 || playedHoles === 18) && playedHoles !== matchRows[0].num_holes) {
      const newSubset = playedHoles === 18
        ? 'full'
        : (matchRows[0].holes_subset === 'back' ? 'back' : 'front');
      await client.query(
        `UPDATE matches SET num_holes = $2, holes_subset = $3 WHERE match_id = $1`,
        [req.params.id, playedHoles, newSubset]
      );
      matchRows[0].num_holes = playedHoles;
      matchRows[0].holes_subset = newSubset;
    }

    // Contribution reward: if a majority of the holes the player played were
    // contributed to via EITHER pin marking OR shot tracking, grant a
    // 'lucky_round' perk. Two qualifying paths so a player who never marks
    // pins (because they're filled already) can still earn through tracking,
    // and vice-versa. Either path counts: pin-majority OR shot-majority.
    let perkAwarded = false;
    if (!matchRows[0].is_practice && Array.isArray(holeScores) && holeScores.length > 0 && resolvedTeeboxId) {
      const holesPlayed = holeScores.length;

      // Path A: pin-mark contributions — only counts holes where the player
      // had the chance (pin still null or filled by them).
      const { rows: opportunityRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM holes
         WHERE teebox_id = $1
           AND hole_num <= $2
           AND (pin_lat IS NULL OR pin_set_by = $3)`,
        [resolvedTeeboxId, holesPlayed, req.userId]
      );
      const pinOpportunity = opportunityRows[0]?.n ?? 0;
      const { rows: pinRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM pin_contributions
         WHERE user_id = $1 AND match_id = $2`,
        [req.userId, req.params.id]
      );
      const pinContribs = pinRows[0]?.n ?? 0;
      const pinMajority = pinOpportunity > 0 && pinContribs * 2 > pinOpportunity;

      // Path B: shot-track contributions — distinct holes where this user
      // recorded at least one shot in this match. Always available regardless
      // of pin state, so a player on a fully-pinned course can still qualify.
      const { rows: shotHoleRows } = await client.query(
        `SELECT COUNT(DISTINCT hole_num)::int AS n FROM shots
         WHERE user_id = $1 AND match_id = $2 AND hole_num IS NOT NULL`,
        [req.userId, req.params.id]
      );
      const shotHoles = shotHoleRows[0]?.n ?? 0;
      const shotMajority = shotHoles * 2 > holesPlayed;

      if (pinMajority || shotMajority) {
        // Avoid double-awarding for the same match (duo/squad — multiple submitters)
        const { rows: alreadyRows } = await client.query(
          `SELECT 1 FROM user_perks WHERE user_id = $1 AND earned_match_id = $2`,
          [req.userId, req.params.id]
        );
        if (!alreadyRows.length) {
          await client.query(
            `INSERT INTO user_perks (user_id, perk_type, earned_match_id, earned_reason)
             VALUES ($1, 'lucky_round', $2, $3)`,
            [
              req.userId,
              req.params.id,
              pinMajority && shotMajority ? 'pins+shots' : pinMajority ? 'pins' : 'shots',
            ]
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
        `UPDATE match_players SET strokes = $1, completed = true, completed_at = NOW(), teebox_id = COALESCE($2, teebox_id)
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

    // Check if all players have submitted. Pull both the standard and the
    // front/back ratings — the resolver below picks the right one based on
    // matches.holes_subset.
    const { rows: allPlayers } = await client.query(MATCH_SCORING_PLAYERS_SQL, [req.params.id]);

    const holesSubsetForCalc: string = matchRows[0].holes_subset ?? 'full';

    // Per-hole pars for the played holes, in hole order. Used by the
    // hole-by-hole formats (stableford, match_play, skins) — stroke and
    // scramble ignore this. We sample from the first player who has a teebox.
    let parByHoleIdx: number[] = [];
    {
      const tbId = allPlayers.find((p: any) => p.teebox_id)?.teebox_id;
      if (tbId) {
        const { rows: holeRows } = await client.query(
          `SELECT hole_num, par FROM holes WHERE teebox_id = $1 ORDER BY hole_num`,
          [tbId]
        );
        const offset = holesSubsetForCalc === 'back' ? 9 : 0;
        const want = matchRows[0].num_holes ?? 18;
        parByHoleIdx = holeRows.slice(offset, offset + want).map((r: any) => r.par);
      }
    }

    // ── Format-specific scoring ───────────────────────────────────────────
    // For non-stroke formats we compute a "performance number" per side where
    // LOWER IS ALWAYS BETTER, so the existing tie/win logic in resolveElo
    // works without branching. For stableford we negate (more points = lower
    // perf). For match_play / skins we negate hole wins.
    function modifiedStablefordPoints(score: number, par: number): number {
      const d = score - par;
      if (d <= -2) return 5;   // eagle or better
      if (d === -1) return 2;  // birdie
      if (d === 0)  return 0;  // par
      if (d === 1)  return -1; // bogey
      return -3;               // double or worse
    }
    function bestHoleScore(side: typeof allPlayers, idx: number): number | null {
      let best: number | null = null;
      for (const p of side) {
        const s = (p.hole_scores as number[] | null)?.[idx];
        if (typeof s !== 'number') continue;
        if (best == null || s < best) best = s;
      }
      return best;
    }
    function computeFormatPerf(
      format: string,
      side1: typeof allPlayers,
      side2: typeof allPlayers,
    ): { side1Perf: number; side2Perf: number; details: any } | null {
      const N = parByHoleIdx.length;
      if (!N) return null;
      if (format === 'stableford') {
        // Sum of best-per-hole modified-stableford points per side.
        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
          const a = bestHoleScore(side1, i);
          const b = bestHoleScore(side2, i);
          if (a != null) s1 += modifiedStablefordPoints(a, parByHoleIdx[i]);
          if (b != null) s2 += modifiedStablefordPoints(b, parByHoleIdx[i]);
        }
        return { side1Perf: -s1, side2Perf: -s2, details: { s1Points: s1, s2Points: s2 } };
      }
      if (format === 'match_play') {
        let s1Wins = 0, s2Wins = 0, halved = 0;
        for (let i = 0; i < N; i++) {
          const a = bestHoleScore(side1, i);
          const b = bestHoleScore(side2, i);
          if (a == null || b == null) continue;
          if (a < b) s1Wins++;
          else if (b < a) s2Wins++;
          else halved++;
        }
        return { side1Perf: -s1Wins, side2Perf: -s2Wins, details: { s1Holes: s1Wins, s2Holes: s2Wins, halved } };
      }
      if (format === 'skins') {
        // Each hole worth 1 skin. Halved holes carry the value into the next.
        let s1Skins = 0, s2Skins = 0, carry = 1;
        for (let i = 0; i < N; i++) {
          const a = bestHoleScore(side1, i);
          const b = bestHoleScore(side2, i);
          if (a == null || b == null) { continue; }
          const value = carry; // current hole worth this much
          if (a < b)     { s1Skins += value; carry = 1; }
          else if (b < a) { s2Skins += value; carry = 1; }
          else            { carry += 1; }       // halved → roll over
        }
        return { side1Perf: -s1Skins, side2Perf: -s2Skins, details: { s1Skins, s2Skins } };
      }
      return null;
    }

    const allDone = allPlayers.every((p) => p.strokes != null);
    let result: any = null;

    const resolveElo = async (
      side1Players: typeof allPlayers,
      side2Players: typeof allPlayers,
      matchId: string,
      matchType: string
    ) => {
      const getDiff = (players: typeof allPlayers, topN?: number) => {
        const diffs = players.map((p) => {
          if (!p.course_rating || !p.slope_rating) return p.strokes;
          // Pick the proper rating override for 9-hole rounds based on
          // whether the match was front, back, or full. Falls back to the
          // half-rating logic inside diff18 when front/back ratings aren't
          // populated for this teebox.
          const subset = holesSubsetForCalc;
          const overrideRating =
            subset === 'front' ? p.front_course_rating
            : subset === 'back'  ? p.back_course_rating
            : null;
          const overrideSlope =
            subset === 'front' ? p.front_slope_rating
            : subset === 'back'  ? p.back_slope_rating
            : null;
          return diff18(
            p.strokes, p.course_rating, p.slope_rating,
            p.holes_played, p.teebox_num_holes || p.holes_played,
            overrideRating, overrideSlope,
          );
        }).sort((a: number, b: number) => a - b);
        const used = topN ? diffs.slice(0, topN) : diffs;
        return used.reduce((a: number, b: number) => a + b, 0) / used.length;
      };
      // If team sizes differ, compare using the smaller team's count (best N scores)
      const compareCount = Math.min(side1Players.length, side2Players.length);
      const strokeSide1Diff = getDiff(side1Players, compareCount);
      const strokeSide2Diff = getDiff(side2Players, compareCount);

      // Format override — for stableford / match_play / skins the winner is
      // decided by the format-specific perf number (lower = better). When the
      // helper returns null (missing pars or unknown format) we fall back to
      // the standard stroke differential.
      const formatPerf = computeFormatPerf(matchFormat, side1Players, side2Players);
      const side1Diff = formatPerf ? formatPerf.side1Perf : strokeSide1Diff;
      const side2Diff = formatPerf ? formatPerf.side2Perf : strokeSide2Diff;
      const formatDetails = formatPerf?.details ?? null;

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

      // Placement status per player + the actual signed delta each player
      // ends up with (after placement shaping + perk), so the result screen
      // shows the real number instead of the side-level approximation.
      const placementSet = await placementUserSet(client, allPlayerIds, matchId);
      const playerDeltas: Record<string, number> = {};

      for (const p of [...side1Players, ...side2Players]) {
        const onSide1 = side1Players.includes(p);
        const baseChange = onSide1 ? side1Delta : side2Delta;
        const won = !isTie && onSide1 === side1Wins;

        // Placement multiplier + minimum-win floor (see shapeDelta).
        let eloChange = shapeDelta(baseChange, won, placementSet.has(p.user_id));

        // Check for an unused 'lucky_round' perk and apply it.
        // - Loss  → set ELO change to 0 (loss prevention)
        // - Win   → double the ELO gain
        // - 0 ELO → don't consume (no benefit; nothing to absorb or double)
        const perkId = perkByUser.get(p.user_id);
        if (perkId && eloChange !== 0) {
          const before = eloChange;
          if (eloChange < 0) eloChange = 0;
          else eloChange = eloChange * 2;
          await client.query(
            `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
            [perkId, matchId]
          );
          perkApplications.push({ user_id: p.user_id, original: before, adjusted: eloChange, type: 'lucky_round' });
        }

        playerDeltas[p.user_id] = eloChange;
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
            // Per-player final signed delta (placement + perk shaped). The
            // read endpoints prefer this over the side-level value.
            playerDeltas,
            perks: perkApplications,
            // Stableford / match_play / skins details so the result screen
            // can render "12 to 9 in points" / "won 5&3" / "8 skins to 4" etc.
            format: matchFormat,
            formatDetails,
          }),
        ]
      );
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [matchId]);
      // Auto-post a 'round' card to each player's feed in one batch INSERT
      // (one row per player, all in one round-trip). Each friend's wall
      // shows their own ELO swing / score line via the joined match row.
      // Reuses the same allPlayerIds list we built earlier for the perk
      // lookup so we don't re-traverse the two side arrays.
      await client.query(
        `INSERT INTO posts (user_id, kind, match_id, body)
         SELECT pid, 'round', $2, r.caption
           FROM unnest($1::uuid[]) AS pid
           LEFT JOIN rounds r ON r.match_id = $2 AND r.user_id = pid`,
        [allPlayerIds, matchId]
      );
      return {
        winnerSide: isTie ? null : (side1Wins ? 1 : 2),
        tied: isTie,
        deltaElo: Math.abs(side1Delta),
        side1Diff,
        side2Diff,
        perks: perkApplications,
      };
    };

    // Linked-match resolution lives in the module-level resolveLinkedPair()
    // (defined above, near the player-projection SQL). It's shared with the
    // cron link pass so a pair that was ALREADY fully played before being
    // linked — two finished-and-waiting matches the backfill just connected
    // — resolves the instant it's linked, not only on a future score submit.

    /**
     * Arena (free-for-all) ELO resolution. Each player is on their own
     * side and gets ranked against the entire field by score
     * differential. For N players we run N×(N−1)/2 virtual 1v1s; each
     * player's per-match delta is the SUM of their virtual 1v1 results,
     * divided by 2(N−1)/N — chosen so that every doubling of the field
     * roughly doubles the ELO swing (the "this felt twice as big as a
     * 1v1" intuition, taken seriously).
     *
     * Concretely, the magnitude a clean-sweep winner takes at K=24:
     *
     *   • N=2   (1v1)   →  divisor 1.000  →  +12 / −12
     *   • N=4   arena   →  divisor 1.500  →  +24 / −24    (2× a 1v1)
     *   • N=8   arena   →  divisor 1.750  →  +48 / −48    (4× a 1v1)
     *   • N=16  arena   →  divisor 1.875  →  +96 / −96    (8× a 1v1)
     *
     * Mathematically the per-match swing is exactly linear in N
     * (≈ K·N/4 for a sweep at equal ELOs). N=2 is continuous with the
     * 1v1 path so the math doesn't jump when a 2-player Arena
     * coincidentally happens. Cap the field at 16 elsewhere to keep
     * the upper bound sane.
     *
     * Tie handling: differentials within 0.05 strokes of each other count
     * as a draw for that pair (each gets 0.5). Standard chess-Elo tie
     * semantics.
     *
     * Stableford support: when the match format is stableford we use the
     * negated points sum as the "differential" so lower = better, matching
     * the existing 1v1 path's convention.
     */
    const resolveEloFFA = async (players: typeof allPlayers, matchId: string) => {
      // Compute each player's standard 18-hole score differential.
      type Entry = { p: typeof allPlayers[number]; diff: number; rawPoints?: number };
      const N = players.length;
      const useStableford = matchFormat === 'stableford' && parByHoleIdx.length > 0;

      const entries: Entry[] = players.map((p) => {
        if (useStableford) {
          // Sum of modified-stableford points across holes. Higher = better,
          // so we negate so the same "lower = better" comparator works.
          let pts = 0;
          const scores = (p.hole_scores as number[] | null) ?? [];
          for (let i = 0; i < parByHoleIdx.length; i++) {
            const s = scores[i];
            if (typeof s !== 'number') continue;
            pts += modifiedStablefordPoints(s, parByHoleIdx[i]);
          }
          return { p, diff: -pts, rawPoints: pts };
        }
        if (!p.course_rating || !p.slope_rating) return { p, diff: p.strokes };
        const subset = holesSubsetForCalc;
        const overrideRating =
          subset === 'front' ? p.front_course_rating
          : subset === 'back'  ? p.back_course_rating
          : null;
        const overrideSlope =
          subset === 'front' ? p.front_slope_rating
          : subset === 'back'  ? p.back_slope_rating
          : null;
        return {
          p,
          diff: diff18(
            p.strokes, p.course_rating, p.slope_rating,
            p.holes_played, p.teebox_num_holes || p.holes_played,
            overrideRating, overrideSlope,
          ),
        };
      });

      // Per-player accumulators
      const deltaByUser = new Map<string, number>(entries.map(e => [e.p.user_id, 0]));
      const winsByUser  = new Map<string, number>(entries.map(e => [e.p.user_id, 0]));
      const tiesByUser  = new Map<string, number>(entries.map(e => [e.p.user_id, 0]));

      // Every unordered pair plays a "virtual 1v1". K factor uses the
      // individual player's tenure / ELO (same as the existing path).
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = entries[i], b = entries[j];
          const tie = Math.abs(a.diff - b.diff) < 0.05;
          const aWins = !tie && a.diff < b.diff;
          const expA = expectedScore(a.p.elo, b.p.elo);
          const expB = 1 - expA;
          const kA = kFactor(a.p.total_matches, a.p.elo);
          const kB = kFactor(b.p.total_matches, b.p.elo);
          const actualA = tie ? 0.5 : (aWins ? 1 : 0);
          const actualB = 1 - actualA;
          deltaByUser.set(a.p.user_id, (deltaByUser.get(a.p.user_id) ?? 0) + kA * (actualA - expA));
          deltaByUser.set(b.p.user_id, (deltaByUser.get(b.p.user_id) ?? 0) + kB * (actualB - expB));
          if (tie) {
            tiesByUser.set(a.p.user_id, (tiesByUser.get(a.p.user_id) ?? 0) + 1);
            tiesByUser.set(b.p.user_id, (tiesByUser.get(b.p.user_id) ?? 0) + 1);
          } else if (aWins) {
            winsByUser.set(a.p.user_id, (winsByUser.get(a.p.user_id) ?? 0) + 1);
          } else {
            winsByUser.set(b.p.user_id, (winsByUser.get(b.p.user_id) ?? 0) + 1);
          }
        }
      }

      // divisor = 2(N−1)/N makes the per-match swing linear in N:
      //   every doubling of field size doubles the ELO change.
      //   (1v1 = ±12, 4-player = ±24, 8-player = ±48, 16-player = ±96.)
      // Floor at 1 keeps N=2 continuous with the Solo / 1v1 path and
      // guards against a degenerate N=1 (which should be impossible —
      // Arena needs ≥2 — but cheap to defend against).
      const divisor = Math.max(1, (2 * (N - 1)) / N);

      // Sort entries by differential (best → worst) to compute placements.
      const placement = [...entries].sort((a, b) => a.diff - b.diff);
      const placementByUser = new Map<string, number>();
      placement.forEach((e, idx) => placementByUser.set(e.p.user_id, idx + 1));

      // Perks: same as 1v1 — a 'lucky_round' perk converts a net-negative
      // result into 0 and doubles a net-positive result.
      const allPlayerIds = players.map(p => p.user_id);
      const { rows: perkRows } = await client.query(
        `SELECT DISTINCT ON (user_id) user_id, perk_id
         FROM user_perks
         WHERE user_id = ANY($1)
           AND consumed_at IS NULL
           AND (earned_match_id IS NULL OR earned_match_id != $2)
         ORDER BY user_id, earned_at ASC`,
        [allPlayerIds, matchId]
      );
      const perkByUser = new Map<string, string>(perkRows.map((r: any) => [r.user_id, r.perk_id]));
      const perkApplications: { user_id: string; original: number; adjusted: number; type: string }[] = [];

      const placementSet = await placementUserSet(client, allPlayerIds, matchId);
      const playerDeltas: Record<string, number> = {};

      for (const e of entries) {
        const baseRaw = (deltaByUser.get(e.p.user_id) ?? 0) / divisor;
        // Arena ELO is the RAW round-robin result: a clean, symmetric spread by
        // finishing position — top gains, bottom loses, the middle ≈ 0 — already
        // tilted by rank differences via the pairwise expected scores (a low-ELO
        // player who places high gains more, a favourite who flops loses more).
        // e.g. a 5-player field at even ELO is +30 / +15 / 0 / −15 / −30.
        //
        // We deliberately do NOT apply the solo win-gain multiplier or min-win
        // floor here — those are 1v1 mechanics that break the zero-sum and let
        // the whole field gain ELO. The placement multiplier still applies (a
        // new player's first matches swing 3x), symmetrically, so it keeps the
        // shape and only scales the magnitude.
        const isPlacement = placementSet.has(e.p.user_id);
        let eloChange = Math.round(baseRaw * (isPlacement ? PLACEMENT_MULTIPLIER : 1));
        const perkId = perkByUser.get(e.p.user_id);
        if (perkId && eloChange !== 0) {
          const before = eloChange;
          if (eloChange < 0) eloChange = 0;
          else eloChange = eloChange * 2;
          await client.query(
            `UPDATE user_perks SET consumed_at = NOW(), consumed_match_id = $2 WHERE perk_id = $1`,
            [perkId, matchId]
          );
          perkApplications.push({ user_id: e.p.user_id, original: before, adjusted: eloChange, type: 'lucky_round' });
        }
        playerDeltas[e.p.user_id] = eloChange;

        const place = placementByUser.get(e.p.user_id) ?? 0;
        const isWinner = place === 1;
        const tiedForFirst = placement.filter(x => Math.abs(x.diff - placement[0].diff) < 0.05).length > 1;
        await client.query(
          `UPDATE users
           SET elo = GREATEST(100, elo + $1),
               total_matches = total_matches + 1,
               total_wins = total_wins + $2,
               total_ties = total_ties + $3
           WHERE user_id = $4`,
          [
            eloChange,
            isWinner && !tiedForFirst ? 1 : 0,
            isWinner && tiedForFirst ? 1 : 0,
            e.p.user_id,
          ]
        );
      }

      // Build a placements array for the result UI: { user_id, side, place,
      // strokes, diff }, sorted by placement.
      const placements = placement.map((e) => ({
        user_id: e.p.user_id,
        side: e.p.side,
        place: placementByUser.get(e.p.user_id) ?? 0,
        strokes: e.p.strokes,
        diff: e.diff,
        // The ACTUAL applied change (placement + perk shaped), not the raw
        // pre-shaping value.
        delta_elo_signed: playerDeltas[e.p.user_id] ?? 0,
        stableford_points: e.rawPoints,
      }));

      // For the match_results row we record the winner's side; rendering code
      // that needs the full ordering reads `details.placements`.
      const winnerSide = placement[0].p.side;
      const isOverallTie = placements.length > 1
        && Math.abs(placements[0].diff - placements[1].diff) < 0.05;

      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
         side2_score_differential, delta_elo, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          matchId,
          'ffa',
          isOverallTie ? null : winnerSide,
          placements[0]?.diff ?? null,
          placements[1]?.diff ?? null,
          // Biggest single ELO swing in the field — used as the "this match
          // was worth ±X" headline.
          Math.max(...placements.map(p => Math.abs(p.delta_elo_signed))),
          JSON.stringify({
            ffa: true,
            placements,
            playerDeltas,
            tied: isOverallTie,
            perks: perkApplications,
            format: matchFormat,
          }),
        ]
      );
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [matchId]);
      // Auto-post a 'round' card to each Arena player's feed — one batch
      // INSERT to keep round-trip count flat regardless of field size.
      await client.query(
        `INSERT INTO posts (user_id, kind, match_id, body)
         SELECT pid, 'round', $2, r.caption
           FROM unnest($1::uuid[]) AS pid
           LEFT JOIN rounds r ON r.match_id = $2 AND r.user_id = pid`,
        [players.map((p) => p.user_id), matchId]
      );
      return {
        ffa: true,
        winnerSide: isOverallTie ? null : winnerSide,
        tied: isOverallTie,
        placements,
        perks: perkApplications,
      };
    };

    // ── Linked match: resolve against the paired match, not in-place ──
    // A linked match never has side-2 players of its own and must never
    // auto-match a solo opponent. It resolves only when BOTH it and its
    // partner are fully done; the trigger fires on whichever match's last
    // score lands. linkedHandled suppresses every normal branch below.
    const pairedMatchId = matchRows[0].paired_match_id as string | null;
    let linkedHandled = false;
    if (pairedMatchId && !matchRows[0].is_practice && matchRows[0].match_type !== 'ffa') {
      linkedHandled = true;
      if (allDone) {
        // resolveLinkedPair is a no-op unless BOTH matches are fully played
        // and neither is already completed — so it's safe to call on every
        // submit, and it also guards the double-submit race itself.
        result = await resolveLinkedPair(client, req.params.id, pairedMatchId);
      }
    }

    if (!linkedHandled && allDone && !matchRows[0].is_practice && allPlayers.length >= 2) {
      // Multiple players already in match — resolve normally.
      const sides: Record<number, typeof allPlayers> = {};
      for (const p of allPlayers) {
        if (!sides[p.side]) sides[p.side] = [];
        sides[p.side].push(p);
      }
      if (matchRows[0].match_type === 'ffa') {
        // Arena — every player on their own side, N-way ranked resolution.
        result = await resolveEloFFA(allPlayers, req.params.id);
      } else if (Object.keys(sides).length >= 2) {
        result = await resolveElo(sides[1], sides[2], req.params.id, matchRows[0].match_type);
      }

    } else if (!linkedHandled && allDone && !matchRows[0].is_practice && allPlayers.length === 1) {
      // Solo submission — find the best-ELO match from the pending pool
      const myP = allPlayers[0];
      const myHolesPlayed = holeScores.length;

      // Direct-challenge grace: if THIS match was a challenge to a specific
      // friend (a pending invite from the last 3 days) and the challenger
      // finished first, do NOT auto-pair with a stranger. Hold it open so the
      // challenged friend still has time to accept and play. After 3 days the
      // invite lapses and the every-minute pairing pass matches it with the
      // best available option.
      const { rows: chalRows } = await client.query(
        `SELECT 1 FROM match_invites
          WHERE match_id = $1 AND status = 'pending'
            AND created_at > NOW() - INTERVAL '3 days' LIMIT 1`,
        [req.params.id]
      );
      const holdForChallenge = chalRows.length > 0;

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
           -- Don't grab a candidate that is itself an active challenge match.
           AND NOT EXISTS (
             SELECT 1 FROM match_invites mi
             WHERE mi.match_id = mp.match_id AND mi.status = 'pending'
               AND mi.created_at > NOW() - INTERVAL '3 days'
           )
         ORDER BY ABS(u.elo - $3)
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [myP.user_id, matchRows[0].match_type, myP.elo, myHolesPlayed]
      );

      // Prefer same-format (9v9 or 18v18). Fall back to cross-format only if pool is empty.
      // Skip entirely while holding for a challenged friend.
      let candidates: any[] = [];
      let isCrossFormat = false;
      if (!holdForChallenge) {
        ({ rows: candidates } = await pendingPoolQuery('same'));
        if (!candidates.length) {
          ({ rows: candidates } = await pendingPoolQuery('different'));
          isCrossFormat = candidates.length > 0;
        }
      }

      if (candidates.length > 0) {
        const opp = candidates[0];
        // Defensive: the pool query already filters `mp.user_id != $1` AND
        // the match_players (match_id, user_id) PK would also reject this.
        // But we double-check here so a future refactor of the pool query
        // can't accidentally pair a user against themselves.
        if (opp.user_id === myP.user_id) {
          console.warn('[match] skipped self-match candidate', { userId: myP.user_id, matchId: req.params.id });
          // Fall through as if no candidate found — match stays pending.
        } else {
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
        }  // end !self-match guard
      }
      // No candidate → stay pending (match.completed stays false, scores are recorded)

    } else if (!linkedHandled && allDone) {
      // Practice round — just complete it
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [req.params.id]);
    }

    // Decorate the response with the submitter's signed ELO delta so the
    // client doesn't have to figure out which side they were on.
    if (result) {
      const { rows: mrRows } = await client.query(
        `SELECT details FROM match_results WHERE match_id = $1`,
        [req.params.id]
      );
      const details = mrRows[0]?.details;
      // Prefer the per-player delta (placement + perk baked in). Fall back
      // to the side-level computation for legacy rows.
      const mine = details?.playerDeltas && req.userId ? details.playerDeltas[req.userId] : undefined;
      if (mine != null) {
        result.myDeltaElo = mine;
      } else {
        const tied = result.tied || result.winnerSide === null;
        const submitterIsSide1 = myeSide === 1;
        const baseDelta = result.deltaElo ?? 0;
        if (tied) {
          const key = submitterIsSide1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
          result.myDeltaElo = details?.[key] ?? 0;
        } else {
          const won = (result.winnerSide === 1 && submitterIsSide1) || (result.winnerSide === 2 && !submitterIsSide1);
          result.myDeltaElo = won ? baseDelta : -baseDelta;
        }
        const myPerk = (result.perks ?? []).find((pa: any) => pa.user_id === req.userId);
        if (myPerk) result.myDeltaElo = myPerk.adjusted;
      }
    }

    // Surface whether THIS submission earned the user a fresh perk
    if (perkAwarded) {
      if (!result) result = {} as any;
      result.perkAwarded = 'lucky_round';
    }

    await client.query('COMMIT');

    // ── Push: notify EACH participant of the resolved result. We do this
    // post-commit so a push failure can't roll back the round, and outside
    // the transaction so the network call doesn't hold a DB connection.
    // Each user gets their personal narrative (you won / lost / tied + Δ).
    if (result && (result.winnerSide != null || result.tied)) {
      try {
        const { rows: pushRows } = await pool.query(
          `SELECT mp.user_id, mp.side, u.push_token, u.username, u.elo,
                  m.match_type, m.format
           FROM match_players mp
           JOIN users u ON u.user_id = mp.user_id
           JOIN matches m ON m.match_id = mp.match_id
           WHERE mp.match_id = $1 AND u.push_token IS NOT NULL`,
          [req.params.id]
        );
        const detailsRow = await pool.query(
          `SELECT details FROM match_results WHERE match_id = $1`,
          [req.params.id]
        );
        const detailsBlob = detailsRow.rows[0]?.details ?? {};
        const winnerSide: number | null = result.winnerSide ?? null;
        for (const row of pushRows) {
          const tied = winnerSide == null;
          const won = !tied && row.side === winnerSide;
          const key = row.side === 1 ? 'side1DeltaSignedElo' : 'side2DeltaSignedElo';
          // Per-player delta (placement + perk baked in) preferred; legacy
          // rows fall back to the side-level value + perk override.
          const perPlayer = detailsBlob.playerDeltas?.[row.user_id];
          let delta: number = perPlayer ?? detailsBlob[key] ?? 0;
          if (perPlayer == null) {
            const perk = (detailsBlob.perks ?? []).find((p: any) => p.user_id === row.user_id);
            if (perk) delta = perk.adjusted;
          }
          const sign = delta > 0 ? '+' : '';
          const title = tied ? 'Match drawn' : won ? 'You won!' : 'Match decided';
          let body = tied
            ? `Even round. ELO ${sign}${delta}.`
            : won
              ? `Nice round. ELO ${sign}${delta}.`
              : `Better luck next time. ELO ${sign}${delta}.`;
          // FOMO hook: call out a tier promotion / demotion from this result.
          const afterElo = Number(row.elo);
          const beforeElo = afterElo - delta;
          const beforeTier = divisionForElo(beforeElo);
          const afterTier = divisionForElo(afterElo);
          if (afterTier.key !== beforeTier.key) {
            body += afterElo > beforeElo
              ? `  You climbed to ${afterTier.name}! 📈`
              : `  You dropped to ${afterTier.name}.`;
          }
          // Fire-and-forget — sendPush already swallows network errors.
          sendPush(
            [row.push_token],
            title, body,
            { type: 'match_result', matchId: req.params.id, won, delta }
          );
        }
      } catch (e) {
        console.error('match_result push failed:', e);
      }
    }

    // Process @mentions in this match's round-caption posts. Round posts are
    // created at resolution (above), so this only runs once the match is
    // resolved. Best-effort + post-commit so it never blocks the score save.
    if (result) {
      try {
        const { rows: rposts } = await pool.query(
          `SELECT p.post_id, p.user_id, p.body
             FROM posts p
            WHERE p.match_id = $1 AND p.kind = 'round' AND p.body IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM post_mentions pm WHERE pm.post_id = p.post_id)`,
          [req.params.id]
        );
        for (const rp of rposts) {
          await processMentions(rp.post_id, rp.user_id, rp.body);
        }
      } catch (e) {
        console.error('round-caption mention processing failed:', e);
      }
    }

    // ── Season Pass XP ─────────────────────────────────────────────────
    // +1 XP per completed non-practice round. The full pass is 10 XP =
    // 10 rounds. Best-effort post-commit: a failure to grant XP doesn't
    // roll back the score save, and the next round resync (or the
    // boot-time ensureCurrentSeason) keeps the ladder healthy.
    if (!matchRows[0].is_practice) {
      try {
        const { awardRoundXp } = await import('../utils/seasonPass');
        await awardRoundXp(req.userId!);
      } catch (e) {
        console.error('[season-pass] xp grant failed:', e);
      }
    }

    // ── Friend push: "<name> just finished a round" ─────────────────────
    // Atomically flips match_players.finished_notified so each finisher's
    // friends get exactly one push regardless of score edits / re-submits
    // / scramble teammate auto-completions. Skipped for practice matches
    // so range sessions don't spam the timeline. Best-effort post-commit
    // so a push outage can't roll back the score save.
    if (!matchRows[0].is_practice) {
      try {
        const { rows: flipped } = await pool.query(
          `UPDATE match_players
              SET finished_notified = TRUE
            WHERE match_id = $1 AND user_id = $2 AND finished_notified = FALSE
            RETURNING match_id`,
          [req.params.id, req.userId]
        );
        if (flipped.length > 0) {
          const { rows: meRows } = await pool.query(
            `SELECT username FROM users WHERE user_id = $1`, [req.userId]
          );
          const finisherName = meRows[0]?.username ?? 'A friend';
          const { rows: courseRows } = resolvedTeeboxId
            ? await pool.query(
                `SELECT c.course_name
                   FROM teeboxes t
                   JOIN courses c ON c.course_id = t.course_id
                  WHERE t.teebox_id = $1`,
                [resolvedTeeboxId]
              )
            : { rows: [] as any[] };
          const courseName = courseRows[0]?.course_name ?? 'a course';

          // Friends with push tokens — bidirectional (friends table stores
          // one directional row; the friend can be on either side).
          const { rows: friends } = await pool.query(
            `SELECT DISTINCT u.push_token
               FROM friends f
               JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
              WHERE (f.user_id = $1 OR f.friend_id = $1)
                AND f.status = 'accepted'
                AND u.push_token IS NOT NULL`,
            [req.userId]
          );
          const tokens = friends.map((f: any) => f.push_token).filter(Boolean);
          if (tokens.length) {
            const holesPlayed = holeScores.length;
            await sendPush(
              tokens,
              `${finisherName} finished a round`,
              `Shot ${totalScore} on ${holesPlayed} holes at ${courseName}. Tap to see the scorecard.`,
              { type: 'round_finished', userId: req.userId, matchId: req.params.id }
            );
          }
        }
      } catch (e) {
        console.error('round-finished friend notification failed:', e);
      }
    }

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
      `SELECT mp.side, m.completed, m.is_practice, m.match_type, m.paired_match_id
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
    const pairedMatchId: string | null = playerRows[0].paired_match_id;

    const { rows: allPlayers } = await client.query(
      `SELECT mp.user_id, mp.side, u.elo, u.total_matches
       FROM match_players mp JOIN users u ON u.user_id = mp.user_id
       WHERE mp.match_id = $1`,
      [req.params.id]
    );
    const mySidePlayers = allPlayers.filter((p) => p.side === mySide);
    let otherSidePlayers = allPlayers.filter((p) => p.side !== mySide);

    // Linked match: the opponents live in the PAIRED match, not as side-2
    // rows here. Pull them so the forfeit resolves as a real loss to that
    // team (and a win for them) instead of a silent abandon that would
    // dangle the partner's paired_match_id forever.
    const linkedForfeit = otherSidePlayers.length === 0 && !isPractice && !!pairedMatchId;
    if (linkedForfeit) {
      const { rows: pp } = await client.query(
        `SELECT mp.user_id, 2 AS side, u.elo, u.total_matches
           FROM match_players mp JOIN users u ON u.user_id = mp.user_id
          WHERE mp.match_id = $1`,
        [pairedMatchId]
      );
      otherSidePlayers = pp;
    }

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

    // Linked forfeit: also write the winning result to the PARTNER match
    // (their players = side 1, they won) and complete it, so both players
    // see the outcome on their own match screen and neither dangles.
    if (linkedForfeit && pairedMatchId) {
      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side, delta_elo, details)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (match_id) DO NOTHING`,
        [
          pairedMatchId, playerRows[0].match_type, Math.abs(deltaElo),
          JSON.stringify({
            forfeit: true,
            forfeitByOpponent: true,
            side1DeltaSignedElo: -deltaElo,   // partner team won
            side2DeltaSignedElo: deltaElo,    // forfeiter team lost
            perks: forfeitPerkApplications,
            linked: true,
          }),
        ]
      );
      await client.query(`UPDATE matches SET completed = true WHERE match_id = $1`, [pairedMatchId]);
    }

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

  // Don't accept progress for already-finished matches.
  // We also pull format here so the scramble teammate-mirror below can
  // tell whether to broadcast — scramble teams play ONE physical ball, so
  // their scorecard is genuinely shared. Other formats (stroke / stableford
  // / match_play / skins) keep per-player drafts as today.
  const { rows: matchRows } = await pool.query(
    `SELECT completed, format FROM matches WHERE match_id = $1`,
    [req.params.id]
  );
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
  if (matchRows[0]?.completed) return res.json({ success: true, ignored: 'completed' });
  const matchFormat = matchRows[0]?.format as string | null;

  // If client passed a teeboxId, persist it on match_players when not already set
  if (teeboxId) {
    await pool.query(
      `UPDATE match_players SET teebox_id = COALESCE(teebox_id, $1)
       WHERE match_id = $2 AND user_id = $3`,
      [teeboxId, req.params.id, req.userId]
    );
  }

  // Resolve teebox + course + side from match_players (now that we may have just
  // set teebox_id above). Side is included so the scramble mirror below knows
  // which other rows to write to.
  const { rows: pRows } = await pool.query(
    `SELECT mp.teebox_id, mp.side, t.course_id FROM match_players mp
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

  // ── Scramble: mirror to teammates on the same side ─────────────────
  // Scramble teams play ONE ball per shot — they share a single scorecard
  // in real life — so the in-progress draft has to be shared too. We
  // upsert each teammate's rounds row with the same hole_scores +
  // hole_stats so their scoring screens see the latest edits on the
  // next poll. Without this they each maintained an independent draft
  // and only converged at submit time, which the user reported as the
  // bug: "we each could put in our individual scores."
  //
  // Last-write-wins per hole; whichever teammate's POST lands at the
  // server later overrides earlier values. In practice a single phone
  // keeps the card, so collisions are vanishingly rare.
  //
  // We DON'T overwrite course_id / teebox_id when a teammate already
  // picked their own — kept symmetric with the per-player UPSERT above
  // so a player who set a different teebox doesn't lose it (rare for
  // scramble, but harmless to be defensive).
  if (matchFormat === 'scramble' && pRows[0].side != null) {
    await pool.query(
      `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats)
       SELECT $1, mp.user_id, $3, $4, $5, $6
         FROM match_players mp
        WHERE mp.match_id = $1
          AND mp.side    = $7
          AND mp.user_id <> $2
       ON CONFLICT (match_id, user_id)
       DO UPDATE SET hole_scores = EXCLUDED.hole_scores,
                     hole_stats  = EXCLUDED.hole_stats,
                     course_id   = COALESCE(rounds.course_id, EXCLUDED.course_id),
                     teebox_id   = COALESCE(rounds.teebox_id, EXCLUDED.teebox_id)`,
      [req.params.id, req.userId, pRows[0].course_id, pRows[0].teebox_id,
       holeScores, JSON.stringify(cleanStats), pRows[0].side]
    );
  }

  // ── Celebration detection ──────────────────────────────────────────
  // Scan the just-saved hole_scores for any birdie/eagle/HIO. The unique
  // constraint on (match_id, user_id, hole_num) means a celebration fires
  // exactly once per (player, hole) pair — re-saving the same score, or a
  // duplicate progress call from a flaky retry, is a no-op via
  // ON CONFLICT DO NOTHING.
  //
  // Hole-in-one wins over the par-3 eagle interpretation: a 1 on a par-3
  // is an ACE, not just an eagle. The check kind order encodes that.
  try {
    const { rows: holeRows } = await pool.query(
      `SELECT hole_num, par FROM holes
        WHERE teebox_id = $1
        ORDER BY hole_num ASC`,
      [pRows[0].teebox_id]
    );
    const pars = new Map<number, number>(
      holeRows.map((h) => [Number(h.hole_num), Number(h.par)])
    );
    // Build a flat insert payload for any qualifying holes we haven't
    // already recorded. We batch into a single INSERT … VALUES (…), (…), (…)
    // because most rounds will only have one new celebration per save
    // anyway and the per-call overhead matters more than the query cost.
    const events: { hole: number; score: number; par: number; kind: string }[] = [];
    for (let i = 0; i < holeScores.length; i++) {
      const score = Number(holeScores[i]);
      if (!Number.isFinite(score) || score <= 0) continue;
      const par = pars.get(i + 1);
      if (par == null) continue;
      const diff = score - par;
      let kind: string | null = null;
      if (score === 1) kind = 'ace';
      else if (diff === -2) kind = 'eagle';
      else if (diff <= -3) kind = 'albatross';
      else if (diff === -1) kind = 'birdie';
      if (kind) events.push({ hole: i + 1, score, par, kind });
    }
    if (events.length) {
      // Multi-row INSERT with conflict-do-nothing — safe to call repeatedly
      // because the unique constraint on (match_id, user_id, hole_num)
      // dedupes per hole regardless of how many times /progress fires.
      const phs: string[] = [];
      const vs: any[] = [];
      events.forEach((e, idx) => {
        const base = idx * 6;
        phs.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        vs.push(req.params.id, req.userId, e.hole, e.score, e.par, e.kind);
      });
      await pool.query(
        `INSERT INTO celebrations (match_id, user_id, hole_num, score, par, kind)
         VALUES ${phs.join(', ')}
         ON CONFLICT (match_id, user_id, hole_num) DO NOTHING`,
        vs
      );
    }
  } catch (err) {
    // Celebrations are best-effort eye candy. A failure here must never
    // block the score save itself — the score is already persisted above.
    console.error('celebration write failed', err);
  }

  return res.json({ success: true });
}));

/**
 * Pull all celebrations for this match. Caller passes `since` (an ISO
 * timestamp from the previous poll) and we return only events newer than
 * that — keeps the response tiny in the steady state.
 *
 * NOTE: deliberately does NOT filter by expires_at. The async-match case
 * (Player A finishes Monday, Player B plays the same match Saturday) needs
 * a full retro of A's birdies/eagles/HIO when B opens the scoring screen,
 * so the client can fire them as B reaches each corresponding hole. The
 * client-side gate is "has the local player reached hole_num" — server is
 * the firehose, client is the gate.
 *
 * Joins the celebrating user's theme info (personal theme for solos, clan
 * theme for team matches) so the client doesn't need a second round-trip
 * to figure out what music to play. We let the CLIENT decide which theme
 * source to pick based on its own knowledge of the match type — both sets
 * of fields come back and the client chooses.
 *
 * Authorization: any player IN the match can see the celebrations. A
 * separate spectator endpoint exists for non-players (TODO if/when we
 * expand spectator views to opponents' real-time scoring).
 */
router.get('/:id/celebrations', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: pm } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!pm.length) return res.status(403).json({ error: 'Not in this match' });
  // `since` is best-effort — accept anything Postgres can parse; otherwise
  // fall through to "anything still un-expired."
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  const { rows } = await pool.query(
    `SELECT
        c.celebration_id, c.user_id, c.hole_num, c.score, c.par, c.kind,
        c.created_at,
        u.username,
        u.avatar_url,
        u.elo,
        u.theme_track_title   AS user_theme_title,
        u.theme_track_artist  AS user_theme_artist,
        u.theme_track_artwork AS user_theme_artwork,
        u.theme_track_preview AS user_theme_preview,
        cl.clan_id,
        cl.name               AS clan_name,
        cl.theme_track_title  AS clan_theme_title,
        cl.theme_track_artist AS clan_theme_artist,
        cl.theme_track_artwork AS clan_theme_artwork,
        cl.theme_track_preview AS clan_theme_preview
       FROM celebrations c
       JOIN users u ON u.user_id = c.user_id
       LEFT JOIN LATERAL (
         SELECT cl.clan_id, cl.name,
                cl.theme_track_title, cl.theme_track_artist,
                cl.theme_track_artwork, cl.theme_track_preview
           FROM clan_members cm
           JOIN clans cl ON cl.clan_id = cm.clan_id
          WHERE cm.user_id = c.user_id
          ORDER BY cm.joined_at DESC
          LIMIT 1
       ) cl ON true
      WHERE c.match_id = $1
        ${since ? 'AND c.created_at > $2' : ''}
      ORDER BY c.created_at ASC`,
    since ? [req.params.id, since] : [req.params.id]
  );
  return res.json(rows);
}));

/**
 * Mark the match-found intro as having been shown to the requesting user.
 * Called by the mobile MatchFoundWatcher the moment it triggers the VS
 * animation. Idempotent — uses COALESCE so the FIRST trigger wins and
 * subsequent calls are no-ops, which keeps the "first time" timestamp
 * accurate even if the watcher fires twice during a race.
 *
 * The list endpoint exposes mp_me.intro_shown_at so the watcher can avoid
 * even fetching the full match detail on subsequent polls.
 */
router.post('/:id/mark-intro-shown', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rowCount } = await pool.query(
    `UPDATE match_players
        SET intro_shown_at = COALESCE(intro_shown_at, NOW())
      WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not in match' });
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

  // Upsert this user's contribution for this match+hole. Re-marking by the
  // same user during the same match overwrites their previous reading
  // (helpful: their GPS may have improved since the first attempt).
  await pool.query(
    `INSERT INTO pin_contributions (user_id, match_id, hole_id, lat, lng, elevation_m)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, match_id, hole_id) DO UPDATE
       SET lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           elevation_m = COALESCE(EXCLUDED.elevation_m, pin_contributions.elevation_m),
           created_at = NOW()`,
    [req.userId, req.params.id, holeId, lat, lng, elev]
  );

  // Recompute the canonical pin position from ALL contributors (across every
  // match) using a median to stay robust against an outlier from someone who
  // marked while walking past the green. PostgreSQL's percentile_cont(0.5)
  // gives us a continuous median which is fine for lat/lng.
  const { rows: medRows } = await pool.query(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lat) AS med_lat,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lng) AS med_lng,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY elevation_m)
         FILTER (WHERE elevation_m IS NOT NULL)              AS med_elev,
       COUNT(*)::int                                          AS samples
     FROM pin_contributions
     WHERE hole_id = $1 AND lat IS NOT NULL AND lng IS NOT NULL`,
    [holeId]
  );
  const med = medRows[0];
  if (med?.med_lat != null && med.med_lng != null) {
    // Try to upgrade pin elevation to a DEM (digital elevation model) value
    // from Open-Meteo's terrain API, which is far more accurate than median
    // GPS altitude (~1m DEM error vs ±15m GPS error). We fall back to the
    // median GPS reading if DEM lookup fails so slope still works.
    let elevToStore: number | null = med.med_elev ?? null;
    try {
      const dResp = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${med.med_lat}&longitude=${med.med_lng}`
      );
      if (dResp.ok) {
        const dData = await dResp.json() as any;
        const demM = dData?.elevation?.[0];
        if (typeof demM === 'number') elevToStore = demM;
      }
    } catch { /* DEM is best-effort — fall through to GPS median */ }

    await pool.query(
      `UPDATE holes
         SET pin_lat = $2,
             pin_lng = $3,
             pin_elevation_m = COALESCE($4, pin_elevation_m),
             pin_set_at = NOW(),
             pin_set_by = COALESCE(pin_set_by, $5)
       WHERE hole_id = $1`,
      [holeId, med.med_lat, med.med_lng, elevToStore, req.userId]
    );
  }

  return res.json({ success: true, samples: med?.samples ?? 1 });
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

  // ALLOWED_CLUBS comes from the shared whitelist (utils/clubs) so the bag
  // editor and shot tracking can never drift. It includes 'chip', a special
  // non-attributing tag (skipped by /club-stats) for tracking-only shots.
  const ALLOWED_LIES = new Set(['tee', 'fairway', 'rough', 'bunker', 'recovery', 'green', 'fringe']);

  // Validate one Pt (used for start/end of segments AND for legacy points).
  const cleanPt = (p: any): { lat: number; lng: number; elevation_m?: number } | null => {
    if (typeof p?.lat !== 'number' || typeof p?.lng !== 'number') return null;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    const out: any = { lat: p.lat, lng: p.lng };
    if (typeof p.elevation_m === 'number' && p.elevation_m > -500 && p.elevation_m < 9000) {
      out.elevation_m = p.elevation_m;
    }
    return out;
  };

  // Accept BOTH formats:
  //   • New (segments): { club, lie?, start: Pt, end: Pt, recorded_at? }
  //   • Legacy (points): { lat, lng, elevation_m?, club?, lie? }
  // Old clients that send legacy data still work; new clients send segments.
  const clean = shots.slice(0, 30).map((s: any) => {
    if (s?.start && s?.end) {
      const start = cleanPt(s.start);
      const end = cleanPt(s.end);
      if (!start || !end) return null;
      const out: any = { start, end };
      if (typeof s.club === 'string' && ALLOWED_CLUBS.has(s.club.toLowerCase())) {
        out.club = s.club.toLowerCase();
      } else if (typeof s.club === 'string') {
        out.club = 'unknown';
      }
      // Partial-swing tag: a percentage ('75%') or clock ('9:00') label, or
      // absent for a full swing. Validated to exactly one of those two shapes.
      if (typeof s.partial_value === 'string') {
        const pv = s.partial_value.trim().slice(0, 8);
        if (/^\d{1,3}%$/.test(pv) || /^\d{1,2}:\d{2}$/.test(pv)) out.partial_value = pv;
      }
      if (typeof s.lie === 'string' && ALLOWED_LIES.has(s.lie.toLowerCase())) {
        out.lie = s.lie.toLowerCase();
      }
      if (typeof s.recorded_at === 'string') out.recorded_at = s.recorded_at;
      // Plays-like yardage: client-computed at finalize time using the
      // current weather snapshot + slope. Optional — older clients omit it.
      if (typeof s.plays_like_yds === 'number'
          && s.plays_like_yds >= 0
          && s.plays_like_yds < 1000) {
        out.plays_like_yds = s.plays_like_yds;
      }
      // Aim point: where the player aimed at the moment they finalised the
      // shot, captured from the draggable on-map heatmap target. Stored so
      // downstream lateral-accuracy stats can compare against the start→aim
      // line instead of the default start→pin centerline. Validated as a
      // sane lat/lng pair; ignored otherwise.
      if (s.aim && typeof s.aim.lat === 'number' && typeof s.aim.lng === 'number'
          && Math.abs(s.aim.lat) <= 90 && Math.abs(s.aim.lng) <= 180) {
        out.aim = { lat: s.aim.lat, lng: s.aim.lng };
      }
      // Frozen-at-finalize geometry. Sanity-clamped so a buggy client
      // can't poison the column with nonsense — anything beyond a long
      // par-5's worth of yards is rejected.
      if (typeof s.total_yds === 'number' && s.total_yds >= 0 && s.total_yds < 1000) {
        out.total_yds = Math.round(s.total_yds);
      }
      if (typeof s.lateral_yds === 'number' && s.lateral_yds > -500 && s.lateral_yds < 500) {
        out.lateral_yds = Math.round(s.lateral_yds);
      }
      if (s.lateral_ref === 'aim' || s.lateral_ref === 'pin') {
        out.lateral_ref = s.lateral_ref;
      }
      return out;
    }
    // Legacy point format
    const pt = cleanPt(s);
    if (!pt) return null;
    const out: any = { ...pt };
    if (typeof s.club === 'string' && ALLOWED_CLUBS.has(s.club.toLowerCase())) {
      out.club = s.club.toLowerCase();
    }
    if (typeof s.partial_value === 'string') {
      const pv = s.partial_value.trim().slice(0, 8);
      if (/^\d{1,3}%$/.test(pv) || /^\d{1,2}:\d{2}$/.test(pv)) out.partial_value = pv;
    }
    if (typeof s.lie === 'string' && ALLOWED_LIES.has(s.lie.toLowerCase())) {
      out.lie = s.lie.toLowerCase();
    }
    return out;
  }).filter((s: any) => s !== null);

  // Verify membership
  const { rows: members } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!members.length) return res.status(404).json({ error: 'Not in match' });

  // Atomic replace: delete this user's shots for this hole, then insert the
  // new set. Same effective semantics as the old UPSERT-on-JSONB approach
  // but each shot is its own durable row in the new `shots` table.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM shots WHERE match_id = $1 AND user_id = $2 AND hole_num = $3`,
      [req.params.id, req.userId, holeNum]
    );
    for (let i = 0; i < clean.length; i++) {
      const s = clean[i];
      const start = s.start ?? { lat: s.lat, lng: s.lng, elevation_m: s.elevation_m };
      // Legacy single-point format gets stored as a degenerate segment
      // (start == end). Backward-compat for any client that hasn't
      // upgraded to segment shape.
      const end = s.end ?? start;
      await client.query(
        `INSERT INTO shots (
           user_id, match_id, hole_num, shot_index,
           club, lie,
           start_lat, start_lng, start_elevation_m,
           end_lat,   end_lng,   end_elevation_m,
           recorded_at, source, plays_like_yds,
           aim_lat, aim_lng,
           total_yds, lateral_yds, lateral_ref, partial_value
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'gps',$14,$15,$16,$17,$18,$19,$20)`,
        [
          req.userId, req.params.id, holeNum, i,
          s.club ?? 'unknown', s.lie ?? null,
          start.lat, start.lng, start.elevation_m ?? null,
          end.lat,   end.lng,   end.elevation_m ?? null,
          s.recorded_at ?? new Date().toISOString(),
          s.plays_like_yds ?? null,
          s.aim?.lat ?? null, s.aim?.lng ?? null,
          s.total_yds ?? null, s.lateral_yds ?? null, s.lateral_ref ?? null, s.partial_value ?? null,
        ]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, count: clean.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET shot tracks for a match — optionally filter by user.
// Returns the shape the old shot_tracks endpoint did so mobile clients
// don't need to change: [{ user_id, hole_num, shots: [{start, end, club, lie}, ...] }]
router.get('/:id/shots', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const userFilter = req.query.user as string | undefined;
  const params: any[] = [req.params.id];
  // Qualified with the shots alias: the users join makes a bare user_id
  // ambiguous.
  let where = `WHERE s.match_id = $1`;
  if (userFilter) { params.push(userFilter); where += ` AND s.user_id = $2`; }

  const { rows } = await pool.query(
    `SELECT s.user_id, s.hole_num,
            json_agg(
              json_build_object(
                'club',  s.club,
                'lie',   s.lie,
                'start', json_build_object(
                  'lat', s.start_lat, 'lng', s.start_lng, 'elevation_m', s.start_elevation_m
                ),
                'end',   json_build_object(
                  'lat', s.end_lat, 'lng', s.end_lng, 'elevation_m', s.end_elevation_m
                ),
                'recorded_at', s.recorded_at,
                'plays_like_yds', s.plays_like_yds,
                'total_yds', s.total_yds,
                'lateral_yds', s.lateral_yds,
                'lateral_ref', s.lateral_ref,
                'aim', CASE WHEN s.aim_lat IS NOT NULL AND s.aim_lng IS NOT NULL
                            THEN json_build_object('lat', s.aim_lat, 'lng', s.aim_lng)
                            ELSE NULL END
              )
              ORDER BY s.shot_index
            ) AS shots,
            -- Shooter's equipped ball-trail cosmetic, resolved to its
            -- visual_data so the shot map can paint the trail effect.
            (SELECT visual_data FROM cosmetics
              WHERE cosmetic_id = u.equipped_ball_trail) AS trail_visual
     FROM shots s
     JOIN users u ON u.user_id = s.user_id
     ${where}
     GROUP BY s.user_id, s.hole_num, u.equipped_ball_trail
     ORDER BY s.user_id, s.hole_num`,
    params
  );
  return res.json(rows);
}));

// Group-scoring endpoint: replace the match's guest_players list with whatever
// the host sends. Guests are non-account players whose scorecards are tracked
// alongside the real players' but never affect ELO or matchmaking — pure
// "one phone, four people" use case.
//
// Only a participant in the match can edit the guest list (so randos can't
// add ghost players). On every save we OVERWRITE the array so the client can
// just send the current state without diffing.
//
// Body shape:
//   { guests: [
//       { name: string, scores: number[], teebox_id?: string | null }
//     ]
//   }
//
// Each entry's `scores` array is parallel to the host's hole_scores — index 0
// is the first hole played (front-9 vs back-9 already factored in by the
// match's holes_subset).
router.put('/:id/guests', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { guests } = req.body ?? {};
  if (!Array.isArray(guests)) return res.status(400).json({ error: 'guests array required' });

  // Permission: must be a player in the match.
  const { rows: meRows } = await pool.query(
    `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!meRows.length) return res.status(403).json({ error: 'Not in this match' });

  // Lightly validate each guest. We accept up to 7 guests (round of 8 max
  // including the host); names get trimmed + truncated to 30 chars; scores
  // are clamped to a sane stroke range so a typo doesn't break the UI.
  const cleaned = guests.slice(0, 7).map((g: any) => ({
    name: typeof g?.name === 'string' ? g.name.trim().slice(0, 30) : 'Guest',
    scores: Array.isArray(g?.scores)
      ? g.scores.map((s: any) => {
          const n = Number(s);
          return Number.isFinite(n) && n > 0 && n < 30 ? Math.round(n) : 0;
        })
      : [],
    teebox_id: typeof g?.teebox_id === 'string' ? g.teebox_id : null,
  })).filter((g: any) => g.name);

  await pool.query(
    `UPDATE matches SET guest_players = $1::jsonb WHERE match_id = $2`,
    [JSON.stringify(cleaned), req.params.id]
  );
  return res.json({ success: true, count: cleaned.length });
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
