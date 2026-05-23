/**
 * Competitive Seasons + Divisions ladder.
 *
 * Model (v1):
 *   • DIVISION = a persistent skill tier derived from the player's lifetime
 *     ELO (Bronze → Diamond). It's where they sit on the ladder; climbing ELO
 *     promotes them. No reset — ELO is the durable skill signal.
 *   • SEASON   = a recurring 6-month window aligned to the golf calendar:
 *     Summer (May–Oct, the playing season) and Winter (Nov–Apr, off-season).
 *     Within it, players compete for STANDINGS in their division, scored by
 *     ranked-match results during the season (win = 3, tie = 1, loss = 0).
 *     The standings reset each season; the top of each division earns
 *     end-of-season rewards (distributed by a future cron).
 *
 * Endpoints:
 *   GET /seasons/current             → the active season + the caller's
 *                                       division, progress to the next tier,
 *                                       and their season record.
 *   GET /seasons/current/standings   → the season leaderboard, filterable by
 *                                       division and global/friends scope.
 *
 * The season window is computed from the date (UTC), so no rollover cron is
 * needed for the ladder itself — only the eventual reward payout.
 */

import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

export interface Division {
  key: string;
  name: string;
  color: string;
  /** Inclusive lower ELO bound. */
  min: number;
  /** Exclusive upper ELO bound (Infinity for the top tier). */
  max: number;
}

// Bands tuned around the 1200 starting ELO: new players land in Bronze and
// climb a tier roughly every ~200 ELO. Diamond is the elite ceiling.
const DIVISIONS: Division[] = [
  { key: 'bronze',   name: 'Bronze',   color: '#cd7f32', min: 0,        max: 1300 },
  { key: 'silver',   name: 'Silver',   color: '#c0c0c0', min: 1300,     max: 1500 },
  { key: 'gold',     name: 'Gold',     color: '#e8b923', min: 1500,     max: 1700 },
  { key: 'platinum', name: 'Platinum', color: '#9fb8c8', min: 1700,     max: 1900 },
  { key: 'diamond',  name: 'Diamond',  color: '#a8d8f0', min: 1900,     max: Infinity },
];

function divisionForElo(elo: number): Division {
  return DIVISIONS.find((d) => elo >= d.min && elo < d.max) ?? DIVISIONS[0];
}

function nextDivision(d: Division): Division | null {
  const i = DIVISIONS.findIndex((x) => x.key === d.key);
  return i >= 0 && i < DIVISIONS.length - 1 ? DIVISIONS[i + 1] : null;
}

/** Current season window (UTC), aligned to the golf calendar (deterministic
 *  from the date):
 *   • SUMMER — May 1 → Nov 1 (the May-through-October playing season).
 *   • WINTER — Nov 1 → May 1 (the off-season; spans the year boundary).
 *  Six months each, so the division climb carries real weight before reset. */
function currentSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0 = Jan

  let id: string, name: string, start: Date, end: Date;
  if (m >= 4 && m <= 9) {
    // Main golf season: May 1 → Nov 1 (May through October).
    start = new Date(Date.UTC(y, 4, 1));
    end = new Date(Date.UTC(y, 10, 1));
    id = `${y}-summer`;
    name = `Summer ${y}`;
  } else {
    // Off-season: Nov 1 → May 1, anchored to the November it began in
    // (Nov/Dec use this year's November; Jan–Apr use last year's).
    const sy = m >= 10 ? y : y - 1;
    start = new Date(Date.UTC(sy, 10, 1));
    end = new Date(Date.UTC(sy + 1, 4, 1));
    id = `${sy}-winter`;
    name = `Winter ${sy}–${String((sy + 1) % 100).padStart(2, '0')}`;
  }
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  return { id, name, starts_at: start.toISOString(), ends_at: end.toISOString(), days_left: daysLeft };
}

/** Per-user season record aggregation, shared by both endpoints. */
const RECORD_SELECT = `
  COUNT(*)::int AS matches,
  COALESCE(SUM(CASE WHEN mr.winner_side = mp.side THEN 1 ELSE 0 END), 0)::int AS wins,
  COALESCE(SUM(CASE WHEN mr.winner_side IS NULL THEN 1 ELSE 0 END), 0)::int AS ties,
  COALESCE(SUM(CASE WHEN mr.winner_side IS NOT NULL AND mr.winner_side <> mp.side THEN 1 ELSE 0 END), 0)::int AS losses,
  COALESCE(SUM(CASE WHEN mr.winner_side = mp.side THEN 3 WHEN mr.winner_side IS NULL THEN 1 ELSE 0 END), 0)::int AS points
`;

router.get('/current', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const season = currentSeason();

  const { rows: uRows } = await pool.query(
    `SELECT elo FROM users WHERE user_id = $1`,
    [req.userId]
  );
  const elo = uRows[0]?.elo ?? 1200;
  const division = divisionForElo(elo);
  const next = nextDivision(division);

  const { rows: recRows } = await pool.query(
    `SELECT ${RECORD_SELECT}
       FROM match_results mr
       JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
       JOIN match_players mp ON mp.match_id = mr.match_id AND mp.user_id = $1
      WHERE mr.created_at >= $2 AND mr.created_at < $3`,
    [req.userId, season.starts_at, season.ends_at]
  );
  const record = recRows[0] ?? { matches: 0, wins: 0, ties: 0, losses: 0, points: 0 };

  return res.json({
    season,
    divisions: DIVISIONS.map((d) => ({ key: d.key, name: d.name, color: d.color })),
    me: {
      elo,
      division: {
        key: division.key, name: division.name, color: division.color,
        min: division.min,
        // JSON can't carry Infinity — the top tier reports null (no ceiling).
        max: division.max === Infinity ? null : division.max,
      },
      next_division: next ? { key: next.key, name: next.name, color: next.color, min: next.min } : null,
      elo_to_next: next ? Math.max(0, next.min - elo) : null,
      record,
    },
  });
}));

router.get('/current/standings', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const season = currentSeason();

  // Division filter — default to the caller's own division so they land on the
  // most relevant board. 'all' shows every player who competed this season.
  const divKey = typeof req.query.division === 'string' ? req.query.division : null;
  let band: { min: number; max: number };
  if (divKey === 'all') {
    band = { min: 0, max: Number.MAX_SAFE_INTEGER };
  } else if (divKey && DIVISIONS.some((d) => d.key === divKey)) {
    const d = DIVISIONS.find((x) => x.key === divKey)!;
    band = { min: d.min, max: d.max === Infinity ? Number.MAX_SAFE_INTEGER : d.max };
  } else {
    const { rows } = await pool.query(`SELECT elo FROM users WHERE user_id = $1`, [req.userId]);
    const d = divisionForElo(rows[0]?.elo ?? 1200);
    band = { min: d.min, max: d.max === Infinity ? Number.MAX_SAFE_INTEGER : d.max };
  }

  const friendsOnly = req.query.scope === 'friends';
  const params: any[] = [season.starts_at, season.ends_at, band.min, band.max];
  let friendClause = '';
  if (friendsOnly) {
    params.push(req.userId);
    friendClause = `AND (u.user_id = $5 OR u.user_id IN (
      SELECT friend_id FROM friends WHERE user_id = $5 AND status = 'accepted'
      UNION
      SELECT user_id FROM friends WHERE friend_id = $5 AND status = 'accepted'
    ))`;
  }

  const { rows } = await pool.query(
    `WITH season AS (
       SELECT mp.user_id, ${RECORD_SELECT}
         FROM match_results mr
         JOIN matches m ON m.match_id = mr.match_id AND m.is_practice = false
         JOIN match_players mp ON mp.match_id = mr.match_id
        WHERE mr.created_at >= $1 AND mr.created_at < $2
        GROUP BY mp.user_id
     )
     SELECT u.user_id, u.username, u.avatar_url, u.elo,
            s.matches, s.wins, s.ties, s.losses, s.points
       FROM season s
       JOIN users u ON u.user_id = s.user_id
      WHERE u.elo >= $3 AND u.elo < $4
        ${friendClause}
      ORDER BY s.points DESC, s.wins DESC, s.matches ASC, u.elo DESC
      LIMIT 100`,
    params
  );

  // Tag each row with its division key so the client can badge mixed lists.
  const standings = rows.map((r: any, i: number) => ({
    ...r,
    rank: i + 1,
    division_key: divisionForElo(r.elo).key,
  }));
  return res.json({ season, division: divKey ?? null, standings });
}));

export default router;
