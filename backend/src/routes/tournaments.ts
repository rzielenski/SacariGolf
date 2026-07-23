import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';
import { isApprovedCreator } from '../utils/creator';
import { postLeagueEvent } from '../utils/leagues';

/**
 * Tournaments / leagues. A tournament is a named container that gathers a
 * set of players + matches + a scoring rule, and produces a leaderboard.
 *
 * Two main shapes:
 *  • A fixed-window weekly league at one course (course_id set, ends_at set)
 *  • An open-ended season across whatever course people pick (course_id null)
 *
 * Matches are linked to a tournament via matches.tournament_id (set when
 * the host creates the match from the tournament screen). This lets the
 * leaderboard aggregate scores without forcing all players to play together.
 */
const router = Router();

const SCORING_RULES = new Set(['best_round', 'total_strokes', 'wins', 'points']);
const FORMATS = new Set(['stroke', 'match_play', 'stableford', 'skins', 'scramble']);

async function isLeagueMember(leagueId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`, [leagueId, userId],
  );
  return rows.length > 0;
}

// 6-character invite codes — capital alphanumerics, no ambiguous I/O/0/1.
function genJoinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// List the tournaments the caller is in (owned or joined). Doubles as the
// home dashboard for the Tournaments tab.
router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id) AS player_count,
            (SELECT COUNT(*)::int FROM matches m WHERE m.tournament_id = t.tournament_id AND m.completed = true) AS match_count,
            EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1) AS joined,
            (t.owner_id = $1) AS owned
     FROM tournaments t
     WHERE t.owner_id = $1
        OR EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1)
     ORDER BY t.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

// Discover open tournaments — anything is_open + active that the caller
// isn't already in. Useful for the "Join a tournament" flow.
router.get('/discover', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id) AS player_count,
            u.username AS owner_username
     FROM tournaments t
     JOIN users u ON u.user_id = t.owner_id
     WHERE t.is_open = true
       AND t.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM tournament_players tp
         WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1
       )
       AND t.owner_id != $1
     ORDER BY t.created_at DESC
     LIMIT 50`,
    [req.userId]
  );
  return res.json(rows);
}));

// Browse public CREATOR LEAGUES — branded, open, active leagues anyone can
// join. This is the fan discovery surface. Defined before '/:id' so the path
// isn't swallowed by the id param. Ordered by liveliness then newest.
router.get('/creator-leagues', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.tournament_id, t.name, t.tagline, t.accent_color, t.description,
            t.join_code, t.scoring, t.target_to_par, t.target_label, t.created_at,
            u.username AS owner_username, u.avatar_url AS owner_avatar_url, u.elo AS owner_elo,
            (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id) AS player_count,
            (SELECT COUNT(DISTINCT tp.user_id)::int FROM tournament_players tp
               JOIN matches m ON m.tournament_id = t.tournament_id AND (m.completed IS NULL OR m.completed = true)
               JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
              WHERE tp.tournament_id = t.tournament_id
                AND t.target_to_par IS NOT NULL
                AND r.normalized_to_par <= t.target_to_par
                AND (t.season_started_at IS NULL OR r.created_at >= t.season_started_at)) AS beaten_count,
            EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1) AS joined,
            (t.owner_id = $1) AS owned
     FROM tournaments t
     JOIN users u ON u.user_id = t.owner_id
     WHERE t.is_creator_league = TRUE
       AND t.status = 'active'
       AND t.is_open = TRUE
     ORDER BY player_count DESC, t.created_at DESC
     LIMIT 60`,
    [req.userId]
  );
  return res.json(rows);
}));

// Create a tournament. Owner is auto-joined as a player.
router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { name, description, scoring, format, courseId, clanId, endsAt, isOpen,
          isCreatorLeague, accentColor, tagline,
          leagueType, handicapAdjusted, resetPeriod } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const safeScoring = SCORING_RULES.has(scoring) ? scoring : 'best_round';
  const safeFormat = FORMATS.has(format) ? format : 'stroke';
  // Creator-league branding: a #hex accent + a short tagline. Sanitized so a
  // bad client can't store junk that the renderer trusts.
  const safeAccent = typeof accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : null;
  const safeTagline = typeof tagline === 'string' ? tagline.trim().slice(0, 120) || null : null;

  // League flavor:
  //   'buddies' — private, peer-hosted, net-scored; ANY user can create.
  //   'creator' — public branded league; approved creators / owners only.
  //   'none'    — a plain tournament.
  const isBuddies = leagueType === 'buddies';
  const isCreator = isCreatorLeague === true || leagueType === 'creator';
  if (isCreator && !(await isApprovedCreator(req.userId))) {
    return res.status(403).json({ error: 'Only approved creators can host a creator league.' });
  }
  const dbLeagueType = isBuddies ? 'buddies' : isCreator ? 'creator' : 'none';
  const isLeague = dbLeagueType !== 'none';
  // Buddies leagues are handicap-adjusted by default (the whole point is fair
  // cross-handicap play); creators opt in explicitly; plain tournaments never.
  const handicapAdj = isBuddies ? (handicapAdjusted !== false) : (handicapAdjusted === true);
  const safeReset = ['none', 'weekly', 'monthly'].includes(resetPeriod) ? resetPeriod : 'none';
  // Buddies leagues are private: never on the open-discover surface, joined by
  // invite code / link only. Creators + plain tournaments honor isOpen.
  const openFlag = isBuddies ? false : (isOpen !== false);
  // Leagues track a season from creation; plain tournaments don't.
  const seasonStart = isLeague ? new Date() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Generate a unique join code (collision is astronomically rare but loop just in case)
    let code = genJoinCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows: existing } = await client.query(
        `SELECT 1 FROM tournaments WHERE join_code = $1`, [code]
      );
      if (!existing.length) break;
      code = genJoinCode();
    }

    const { rows } = await client.query(
      `INSERT INTO tournaments
         (owner_id, clan_id, name, description, scoring, format, course_id, ends_at, is_open, join_code,
          is_creator_league, accent_color, tagline, season_started_at,
          league_type, handicap_adjusted, reset_period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        req.userId,
        typeof clanId === 'string' ? clanId : null,
        name.trim().slice(0, 80),
        typeof description === 'string' ? description.trim().slice(0, 500) : null,
        safeScoring,
        safeFormat,
        typeof courseId === 'string' ? courseId : null,
        endsAt ? new Date(endsAt) : null,
        openFlag,
        code,
        isCreator,
        safeAccent,
        safeTagline,
        seasonStart,
        dbLeagueType,
        handicapAdj,
        safeReset,
      ]
    );
    const tournament = rows[0];

    // Auto-add owner as a player.
    await client.query(
      `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2)`,
      [tournament.tournament_id, req.userId]
    );

    await client.query('COMMIT');
    return res.status(201).json(tournament);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /tournaments failed:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Tournament detail + leaderboard. Leaderboard query depends on the
// scoring rule so different formats render meaningfully.
router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT t.*, u.username AS owner_username,
            u.avatar_url AS owner_avatar_url, u.elo AS owner_elo,
            c.course_name AS course_name
     FROM tournaments t
     JOIN users u ON u.user_id = t.owner_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE t.tournament_id = $1`,
    [req.params.id]
  );
  if (!tRows.length) return res.status(404).json({ error: 'Tournament not found' });
  const t = tRows[0];

  const { rows: players } = await pool.query(
    `SELECT tp.user_id, tp.joined_at, u.username, u.elo, u.avatar_url
     FROM tournament_players tp
     JOIN users u ON u.user_id = tp.user_id
     WHERE tp.tournament_id = $1
     ORDER BY tp.joined_at ASC`,
    [req.params.id]
  );

  // Creator leagues scope the leaderboard to the current SEASON (rounds posted
  // since season_started_at) so a weekly/monthly reset starts everyone fresh.
  // Leagues (creator + buddies) scope the leaderboard to the current SEASON
  // (rounds since season_started_at) so a reset starts everyone fresh. Plain
  // tournaments count everything.
  const seasonStart: Date | null = (t.league_type && t.league_type !== 'none') || t.is_creator_league
    ? (t.season_started_at ?? null) : null;
  const seasonClause = seasonStart ? 'AND r.created_at >= $2' : '';
  const lbParams: any[] = seasonStart ? [req.params.id, seasonStart] : [req.params.id];

  // NET scoring: a handicap-adjusted league ranks on (18-eq to-par MINUS the
  // player's handicap index), so a 20-handicap playing to +16 (net -4) beats a
  // scratch playing +1 (net +1). This is what makes a mixed-skill friend group
  // fair. COALESCE(handicap,0) means a player without an established handicap
  // (< 3 rated rounds) is scored gross until they have one. The expression is
  // server-derived from a boolean, so it's safe to interpolate.
  const netExpr = t.handicap_adjusted
    ? '(r.normalized_to_par - COALESCE(u.handicap_index, 0))'
    : 'r.normalized_to_par';

  // Leaderboard: aggregate per-player scores from completed matches linked
  // to this tournament. The shape depends on the scoring rule.
  let leaderboard: any[] = [];
  if (t.scoring === 'best_round') {
    // Lowest single-round (net) score wins.
    const { rows: lb } = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_url,
              ROUND(u.handicap_index)::int AS handicap,
              ROUND(MIN(${netExpr}))::int AS best_to_par,
              COUNT(r.round_id)::int AS rounds_played
       FROM tournament_players tp
       JOIN users u ON u.user_id = tp.user_id
       LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
       LEFT JOIN rounds  r ON r.match_id = m.match_id AND r.user_id = tp.user_id ${seasonClause}
       WHERE tp.tournament_id = $1
         AND u.is_bot = false
         AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.username, u.avatar_url, u.handicap_index
       ORDER BY MIN(${netExpr}) ASC NULLS LAST, COUNT(r.round_id) DESC`,
      lbParams
    );
    leaderboard = lb;
  } else if (t.scoring === 'total_strokes') {
    const { rows: lb } = await pool.query(
      // Cumulative (net) score across the season.
      `SELECT u.user_id, u.username, u.avatar_url,
              ROUND(u.handicap_index)::int AS handicap,
              ROUND(SUM(${netExpr}))::int AS total_to_par,
              COUNT(r.round_id)::int AS rounds_played
       FROM tournament_players tp
       JOIN users u ON u.user_id = tp.user_id
       LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
       LEFT JOIN rounds  r ON r.match_id = m.match_id AND r.user_id = tp.user_id ${seasonClause}
       WHERE tp.tournament_id = $1
         AND u.is_bot = false
         AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.username, u.avatar_url, u.handicap_index
       ORDER BY SUM(${netExpr}) ASC NULLS LAST, COUNT(r.round_id) DESC`,
      lbParams
    );
    leaderboard = lb;
  } else if (t.scoring === 'wins') {
    // Tally match wins on the linked matches.
    const { rows: lb } = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_url,
              COUNT(*) FILTER (WHERE mr.winner_side = mp.side)::int AS wins,
              COUNT(mr.match_id)::int AS rounds_played
       FROM tournament_players tp
       JOIN users u ON u.user_id = tp.user_id
       LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
       LEFT JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = tp.user_id
       LEFT JOIN match_results mr ON mr.match_id = m.match_id
       WHERE tp.tournament_id = $1
         AND u.is_bot = false
         AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.username, u.avatar_url
       ORDER BY COUNT(*) FILTER (WHERE mr.winner_side = mp.side) DESC NULLS LAST, COUNT(mr.match_id) DESC`,
      [req.params.id]
    );
    leaderboard = lb;
  }

  // "Beat the creator": flag each leaderboard row whose best 18-hole-equivalent
  // to-par is at or under the creator's standing target. Meaningful for the
  // best_round mode (the natural beat-the-creator format).
  const target = t.target_to_par;
  if (target != null) {
    for (const row of leaderboard) {
      const v = row.best_to_par;
      row.beat_creator = v != null && Number(v) <= Number(target);
    }
  }
  const beatenCount = target != null ? leaderboard.filter((r) => r.beat_creator).length : 0;

  // Caller's per-league prefs + the last season champion's name.
  const { rows: meRows } = await pool.query(
    `SELECT auto_post FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`,
    [req.params.id, req.userId],
  );
  let lastChampionName: string | null = null;
  if (t.last_champion_id) {
    const { rows: lc } = await pool.query(`SELECT username FROM users WHERE user_id = $1`, [t.last_champion_id]);
    lastChampionName = lc[0]?.username ?? null;
  }

  return res.json({
    ...t, players, leaderboard, beaten_count: beatenCount,
    my_auto_post: meRows[0]?.auto_post === true,
    last_champion_name: lastChampionName,
  });
}));

// Join via tournament id (open tournaments) or join code.
//   POST /tournaments/:id/join         — caller must be eligible (open OR has code in body)
//   POST /tournaments/join              — by code in body (preferred for invite-only flow)
router.post('/:id/join', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT * FROM tournaments WHERE tournament_id = $1`, [req.params.id]
  );
  if (!tRows.length) return res.status(404).json({ error: 'Tournament not found' });
  const t = tRows[0];
  if (t.status !== 'active') return res.status(409).json({ error: 'Tournament not active' });

  // Closed tournaments need a matching code in the body OR an existing invite (out of scope MVP).
  if (!t.is_open) {
    const code = (req.body?.joinCode ?? '').toString().trim().toUpperCase();
    if (code !== t.join_code) return res.status(403).json({ error: 'Invalid join code' });
  }

  await pool.query(
    `INSERT INTO tournament_players (tournament_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.userId]
  );
  return res.json({ success: true });
}));

// Lookup-and-join by code (helps when the user only has the code).
router.post('/join-by-code', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const code = (req.body?.code ?? '').toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });
  const { rows: tRows } = await pool.query(
    `SELECT * FROM tournaments WHERE join_code = $1 AND status = 'active'`, [code]
  );
  if (!tRows.length) return res.status(404).json({ error: 'No active tournament with that code' });
  await pool.query(
    `INSERT INTO tournament_players (tournament_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [tRows[0].tournament_id, req.userId]
  );
  return res.json({ success: true, tournament_id: tRows[0].tournament_id });
}));

// Leave (anyone except the owner).
router.post('/:id/leave', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT owner_id FROM tournaments WHERE tournament_id = $1`, [req.params.id]
  );
  if (!tRows.length) return res.status(404).json({ error: 'Tournament not found' });
  if (tRows[0].owner_id === req.userId) {
    return res.status(409).json({ error: 'Owner cannot leave — delete the tournament instead' });
  }
  await pool.query(
    `DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  return res.json({ success: true });
}));

// Delete (owner only). Cascades drop tournament_players + null out match.tournament_id.
router.delete('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT owner_id FROM tournaments WHERE tournament_id = $1`, [req.params.id]
  );
  if (!tRows.length) return res.status(404).json({ error: 'Tournament not found' });
  if (tRows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete' });
  await pool.query(`DELETE FROM tournaments WHERE tournament_id = $1`, [req.params.id]);
  return res.json({ success: true });
}));

// Mark a NEW match as part of a tournament. Called by the client right
// after creating the match so leaderboards aggregate correctly.
router.post('/:id/link-match', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId } = req.body ?? {};
  if (typeof matchId !== 'string') return res.status(400).json({ error: 'matchId required' });

  // Caller must be both in the tournament AND the match.
  const { rows: gates } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = $1 AND tp.user_id = $2) AS in_tournament,
       EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = $3 AND mp.user_id = $2) AS in_match`,
    [req.params.id, req.userId, matchId]
  );
  if (!gates[0]?.in_tournament || !gates[0]?.in_match) {
    return res.status(403).json({ error: 'You must be in both the tournament and the match' });
  }

  await pool.query(
    `UPDATE matches SET tournament_id = $1 WHERE match_id = $2`,
    [req.params.id, matchId]
  );
  return res.json({ success: true });
}));

// Set the "beat the creator" target for a creator league: the creator's
// standing score (18-hole-equivalent to-par) the whole field tries to beat.
// Owner-only. Pass { toPar, label } directly, OR { roundId, label } to derive
// the score from one of the creator's own scored rounds. { toPar: null } clears.
router.post('/:id/target', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT owner_id FROM tournaments WHERE tournament_id = $1`, [req.params.id]
  );
  if (!tRows.length) return res.status(404).json({ error: 'League not found' });
  if (tRows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only the creator can set the target' });

  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 80) || null : null;
  let toPar: number | null;

  if (typeof req.body?.roundId === 'string') {
    const { rows: rr } = await pool.query(
      `SELECT normalized_to_par FROM rounds WHERE round_id = $1 AND user_id = $2`,
      [req.body.roundId, req.userId]
    );
    if (!rr.length || rr[0].normalized_to_par == null) {
      return res.status(400).json({ error: 'That round has no scored result yet' });
    }
    toPar = Number(rr[0].normalized_to_par);
  } else if (req.body?.toPar === null) {
    toPar = null; // explicit clear
  } else if (req.body?.toPar != null && Number.isFinite(Number(req.body.toPar))) {
    toPar = Number(req.body.toPar);
  } else {
    return res.status(400).json({ error: 'Provide toPar (number), toPar:null to clear, or roundId' });
  }

  await pool.query(
    `UPDATE tournaments SET target_to_par = $2, target_label = $3 WHERE tournament_id = $1`,
    [req.params.id, toPar, label]
  );
  if (toPar != null) {
    const n = Math.round(toPar);
    await postLeagueEvent(pool, req.params.id, req.userId!, `🎯 New target to beat: ${n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`}${label ? ` · ${label}` : ''}`);
  }
  return res.json({ success: true, target_to_par: toPar, target_label: label });
}));

// ── Creator-league feed ─────────────────────────────────────────────────────
// A dedicated feed per league: member text posts + system events (beat-the-
// creator, season champions). Members only.
router.get('/:id/feed', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  if (!(await isLeagueMember(req.params.id, req.userId!))) {
    return res.status(403).json({ error: 'Join the league to see its feed' });
  }
  const { rows } = await pool.query(
    `SELECT lp.post_id, lp.kind, lp.body, lp.created_at, lp.user_id,
            u.username, u.avatar_url
       FROM league_posts lp
       LEFT JOIN users u ON u.user_id = lp.user_id
      WHERE lp.league_id = $1
      ORDER BY lp.created_at DESC
      LIMIT 100`,
    [req.params.id],
  );
  return res.json(rows);
}));

router.post('/:id/feed', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 1000) : '';
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!(await isLeagueMember(req.params.id, req.userId!))) {
    return res.status(403).json({ error: 'Join the league to post' });
  }
  const { rows } = await pool.query(
    `INSERT INTO league_posts (league_id, user_id, kind, body) VALUES ($1, $2, 'text', $3)
     RETURNING post_id, kind, body, created_at, user_id`,
    [req.params.id, req.userId, body],
  );
  const { rows: u } = await pool.query(`SELECT username, avatar_url FROM users WHERE user_id = $1`, [req.userId]);
  return res.status(201).json({ ...rows[0], username: u[0]?.username, avatar_url: u[0]?.avatar_url });
}));

// ── Member: auto-post solo rounds to THIS league ────────────────────────────
// A round can only land on one leaderboard, so enabling here is EXCLUSIVE: it
// turns auto-post off on the member's other leagues.
router.post('/:id/auto-post', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const enabled = req.body?.enabled === true;
  if (!(await isLeagueMember(req.params.id, req.userId!))) {
    return res.status(403).json({ error: 'Join the league first' });
  }
  if (enabled) {
    await pool.query(
      `UPDATE tournament_players SET auto_post = (tournament_id = $1) WHERE user_id = $2`,
      [req.params.id, req.userId],
    );
  } else {
    await pool.query(
      `UPDATE tournament_players SET auto_post = FALSE WHERE tournament_id = $1 AND user_id = $2`,
      [req.params.id, req.userId],
    );
  }
  return res.json({ success: true, auto_post: enabled });
}));

// ── Creator: recurring-season settings (auto-crown + reset cadence) ──────────
router.post('/:id/settings', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: tRows } = await pool.query(
    `SELECT owner_id, reset_period FROM tournaments WHERE tournament_id = $1`, [req.params.id],
  );
  if (!tRows.length) return res.status(404).json({ error: 'League not found' });
  if (tRows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only the creator can change settings' });

  const rp = req.body?.resetPeriod;
  if (rp !== undefined) {
    if (!['none', 'weekly', 'monthly'].includes(rp)) {
      return res.status(400).json({ error: 'resetPeriod must be none | weekly | monthly' });
    }
    // Switching ON a cadence re-anchors the season to now, so the first window
    // is a full week/month from the change rather than from league creation.
    if (rp !== 'none' && tRows[0].reset_period === 'none') {
      await pool.query(`UPDATE tournaments SET reset_period = $2, season_started_at = NOW() WHERE tournament_id = $1`, [req.params.id, rp]);
    } else {
      await pool.query(`UPDATE tournaments SET reset_period = $2 WHERE tournament_id = $1`, [req.params.id, rp]);
    }
  }
  return res.json({ success: true, reset_period: rp });
}));

// Finalize a tournament: lock it, crown the leaderboard winner, and award the
// Tournament Champion cosmetic. Owner-only. Idempotent-ish (409 once finished).
router.post('/:id/finalize', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const id = req.params.id;
  const { rows: tRows } = await pool.query(`SELECT * FROM tournaments WHERE tournament_id = $1`, [id]);
  if (!tRows.length) return res.status(404).json({ error: 'Tournament not found' });
  const t = tRows[0];
  if (t.owner_id !== req.userId) return res.status(403).json({ error: 'Only the organizer can finalize' });
  if (t.status !== 'active') return res.status(409).json({ error: 'Tournament already finalized' });

  // Winner = top of the leaderboard for this scoring rule, among players who
  // actually posted a round. Same ordering (incl. the NET handicap adjustment)
  // as the GET /:id leaderboard. Server-derived expr, safe to interpolate.
  const netExpr = t.handicap_adjusted
    ? '(r.normalized_to_par - COALESCE(u.handicap_index, 0))'
    : 'r.normalized_to_par';
  let winnerSql: string;
  if (t.scoring === 'total_strokes') {
    winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.handicap_index HAVING COUNT(r.round_id) > 0
       ORDER BY SUM(${netExpr}) ASC LIMIT 1`;
  } else if (t.scoring === 'wins') {
    winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = tp.user_id
        LEFT JOIN match_results mr ON mr.match_id = m.match_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id HAVING COUNT(mr.match_id) > 0
       ORDER BY COUNT(*) FILTER (WHERE mr.winner_side = mp.side) DESC LIMIT 1`;
  } else {
    // best_round (default; also the fallback for the unimplemented 'points').
    winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.handicap_index HAVING COUNT(r.round_id) > 0
       ORDER BY MIN(${netExpr}) ASC LIMIT 1`;
  }
  const { rows: top } = await pool.query(winnerSql, [id]);
  const winnerId: string | null = top[0]?.user_id ?? null;

  await pool.query(
    `UPDATE tournaments SET status = 'finished', winner_id = $2 WHERE tournament_id = $1`,
    [id, winnerId],
  );

  if (winnerId) {
    // Exclusive prize cosmetics are NOT minted by private buddies leagues
    // (anyone could spin up a tiny league to farm them). They still get a
    // champion + the feed brag below.
    if (t.league_type !== 'buddies') {
      await pool.query(
        `INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
           SELECT $1, c.cosmetic_id, $2 FROM cosmetics c
            WHERE c.unlock_kind = 'tournament_winner' AND (c.unlock_data ->> 'place')::int = 1
         ON CONFLICT (user_id, cosmetic_id) DO NOTHING`,
        [winnerId, `tournament_${id}_winner`],
      );
    }
    // Champion feed post — best-effort, never blocks the finalize.
    try {
      await pool.query(
        `INSERT INTO posts (user_id, kind, body) SELECT $1, 'text', '🏆 Won ' || $2 || ' on Sacari Golf'`,
        [winnerId, t.name],
      );
    } catch { /* non-fatal */ }
  }

  return res.json({ success: true, winner_id: winnerId });
}));

export default router;
