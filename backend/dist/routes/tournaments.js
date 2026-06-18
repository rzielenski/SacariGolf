"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const asyncHandler_1 = require("../utils/asyncHandler");
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
const router = (0, express_1.Router)();
const SCORING_RULES = new Set(['best_round', 'total_strokes', 'wins', 'points']);
const FORMATS = new Set(['stroke', 'match_play', 'stableford', 'skins', 'scramble']);
// 6-character invite codes — capital alphanumerics, no ambiguous I/O/0/1.
function genJoinCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++)
        s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
}
// List the tournaments the caller is in (owned or joined). Doubles as the
// home dashboard for the Tournaments tab.
router.get('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows } = await pool_1.default.query(`SELECT t.*,
            (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id) AS player_count,
            (SELECT COUNT(*)::int FROM matches m WHERE m.tournament_id = t.tournament_id AND m.completed = true) AS match_count,
            EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1) AS joined,
            (t.owner_id = $1) AS owned
     FROM tournaments t
     WHERE t.owner_id = $1
        OR EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.tournament_id AND tp.user_id = $1)
     ORDER BY t.created_at DESC`, [req.userId]);
    return res.json(rows);
}));
// Discover open tournaments — anything is_open + active that the caller
// isn't already in. Useful for the "Join a tournament" flow.
router.get('/discover', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows } = await pool_1.default.query(`SELECT t.*,
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
     LIMIT 50`, [req.userId]);
    return res.json(rows);
}));
// Create a tournament. Owner is auto-joined as a player.
router.post('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { name, description, scoring, format, courseId, clanId, endsAt, isOpen } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const safeScoring = SCORING_RULES.has(scoring) ? scoring : 'best_round';
    const safeFormat = FORMATS.has(format) ? format : 'stroke';
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        // Generate a unique join code (collision is astronomically rare but loop just in case)
        let code = genJoinCode();
        for (let attempt = 0; attempt < 5; attempt++) {
            const { rows: existing } = await client.query(`SELECT 1 FROM tournaments WHERE join_code = $1`, [code]);
            if (!existing.length)
                break;
            code = genJoinCode();
        }
        const { rows } = await client.query(`INSERT INTO tournaments
         (owner_id, clan_id, name, description, scoring, format, course_id, ends_at, is_open, join_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`, [
            req.userId,
            typeof clanId === 'string' ? clanId : null,
            name.trim().slice(0, 80),
            typeof description === 'string' ? description.trim().slice(0, 500) : null,
            safeScoring,
            safeFormat,
            typeof courseId === 'string' ? courseId : null,
            endsAt ? new Date(endsAt) : null,
            isOpen !== false, // default open
            code,
        ]);
        const tournament = rows[0];
        // Auto-add owner as a player.
        await client.query(`INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2)`, [tournament.tournament_id, req.userId]);
        await client.query('COMMIT');
        return res.status(201).json(tournament);
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /tournaments failed:', err);
        return res.status(500).json({ error: 'Server error' });
    }
    finally {
        client.release();
    }
}));
// Tournament detail + leaderboard. Leaderboard query depends on the
// scoring rule so different formats render meaningfully.
router.get('/:id', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: tRows } = await pool_1.default.query(`SELECT t.*, u.username AS owner_username,
            c.course_name AS course_name
     FROM tournaments t
     JOIN users u ON u.user_id = t.owner_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE t.tournament_id = $1`, [req.params.id]);
    if (!tRows.length)
        return res.status(404).json({ error: 'Tournament not found' });
    const t = tRows[0];
    const { rows: players } = await pool_1.default.query(`SELECT tp.user_id, tp.joined_at, u.username, u.elo, u.avatar_url
     FROM tournament_players tp
     JOIN users u ON u.user_id = tp.user_id
     WHERE tp.tournament_id = $1
     ORDER BY tp.joined_at ASC`, [req.params.id]);
    // Leaderboard: aggregate per-player scores from completed matches linked
    // to this tournament. The shape depends on the scoring rule.
    let leaderboard = [];
    if (t.scoring === 'best_round') {
        // Lowest single-round score wins. Show that round's score per player.
        const { rows: lb } = await pool_1.default.query(
        // Best single round as the stored 18-hole-equivalent to-par, so a 9-hole
        // round can't beat a full 18 just by having fewer strokes.
        `SELECT u.user_id, u.username, u.avatar_url,
              MIN(r.normalized_to_par) AS best_to_par,
              COUNT(r.round_id)::int AS rounds_played
       FROM tournament_players tp
       JOIN users u ON u.user_id = tp.user_id
       LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
       LEFT JOIN rounds  r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1
         AND u.is_bot = false
         AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.username, u.avatar_url
       ORDER BY MIN(r.normalized_to_par) ASC NULLS LAST, COUNT(r.round_id) DESC`, [req.params.id]);
        leaderboard = lb;
    }
    else if (t.scoring === 'total_strokes') {
        const { rows: lb } = await pool_1.default.query(
        // Cumulative score as summed stored 18-hole-equivalent to-par, so rounds
        // of different hole counts add up on one fair basis.
        `SELECT u.user_id, u.username, u.avatar_url,
              SUM(r.normalized_to_par)::int AS total_to_par,
              COUNT(r.round_id)::int AS rounds_played
       FROM tournament_players tp
       JOIN users u ON u.user_id = tp.user_id
       LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
       LEFT JOIN rounds  r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1
         AND u.is_bot = false
         AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id, u.username, u.avatar_url
       ORDER BY SUM(r.normalized_to_par) ASC NULLS LAST, COUNT(r.round_id) DESC`, [req.params.id]);
        leaderboard = lb;
    }
    else if (t.scoring === 'wins') {
        // Tally match wins on the linked matches.
        const { rows: lb } = await pool_1.default.query(`SELECT u.user_id, u.username, u.avatar_url,
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
       ORDER BY COUNT(*) FILTER (WHERE mr.winner_side = mp.side) DESC NULLS LAST, COUNT(mr.match_id) DESC`, [req.params.id]);
        leaderboard = lb;
    }
    return res.json({ ...t, players, leaderboard });
}));
// Join via tournament id (open tournaments) or join code.
//   POST /tournaments/:id/join         — caller must be eligible (open OR has code in body)
//   POST /tournaments/join              — by code in body (preferred for invite-only flow)
router.post('/:id/join', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: tRows } = await pool_1.default.query(`SELECT * FROM tournaments WHERE tournament_id = $1`, [req.params.id]);
    if (!tRows.length)
        return res.status(404).json({ error: 'Tournament not found' });
    const t = tRows[0];
    if (t.status !== 'active')
        return res.status(409).json({ error: 'Tournament not active' });
    // Closed tournaments need a matching code in the body OR an existing invite (out of scope MVP).
    if (!t.is_open) {
        const code = (req.body?.joinCode ?? '').toString().trim().toUpperCase();
        if (code !== t.join_code)
            return res.status(403).json({ error: 'Invalid join code' });
    }
    await pool_1.default.query(`INSERT INTO tournament_players (tournament_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.params.id, req.userId]);
    return res.json({ success: true });
}));
// Lookup-and-join by code (helps when the user only has the code).
router.post('/join-by-code', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const code = (req.body?.code ?? '').toString().trim().toUpperCase();
    if (!code)
        return res.status(400).json({ error: 'code required' });
    const { rows: tRows } = await pool_1.default.query(`SELECT * FROM tournaments WHERE join_code = $1 AND status = 'active'`, [code]);
    if (!tRows.length)
        return res.status(404).json({ error: 'No active tournament with that code' });
    await pool_1.default.query(`INSERT INTO tournament_players (tournament_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tRows[0].tournament_id, req.userId]);
    return res.json({ success: true, tournament_id: tRows[0].tournament_id });
}));
// Leave (anyone except the owner).
router.post('/:id/leave', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: tRows } = await pool_1.default.query(`SELECT owner_id FROM tournaments WHERE tournament_id = $1`, [req.params.id]);
    if (!tRows.length)
        return res.status(404).json({ error: 'Tournament not found' });
    if (tRows[0].owner_id === req.userId) {
        return res.status(409).json({ error: 'Owner cannot leave — delete the tournament instead' });
    }
    await pool_1.default.query(`DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    return res.json({ success: true });
}));
// Delete (owner only). Cascades drop tournament_players + null out match.tournament_id.
router.delete('/:id', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { rows: tRows } = await pool_1.default.query(`SELECT owner_id FROM tournaments WHERE tournament_id = $1`, [req.params.id]);
    if (!tRows.length)
        return res.status(404).json({ error: 'Tournament not found' });
    if (tRows[0].owner_id !== req.userId)
        return res.status(403).json({ error: 'Only the owner can delete' });
    await pool_1.default.query(`DELETE FROM tournaments WHERE tournament_id = $1`, [req.params.id]);
    return res.json({ success: true });
}));
// Mark a NEW match as part of a tournament. Called by the client right
// after creating the match so leaderboards aggregate correctly.
router.post('/:id/link-match', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { matchId } = req.body ?? {};
    if (typeof matchId !== 'string')
        return res.status(400).json({ error: 'matchId required' });
    // Caller must be both in the tournament AND the match.
    const { rows: gates } = await pool_1.default.query(`SELECT
       EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = $1 AND tp.user_id = $2) AS in_tournament,
       EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = $3 AND mp.user_id = $2) AS in_match`, [req.params.id, req.userId, matchId]);
    if (!gates[0]?.in_tournament || !gates[0]?.in_match) {
        return res.status(403).json({ error: 'You must be in both the tournament and the match' });
    }
    await pool_1.default.query(`UPDATE matches SET tournament_id = $1 WHERE match_id = $2`, [req.params.id, matchId]);
    return res.json({ success: true });
}));
// Finalize a tournament: lock it, crown the leaderboard winner, and award the
// Tournament Champion cosmetic. Owner-only. Idempotent-ish (409 once finished).
router.post('/:id/finalize', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const id = req.params.id;
    const { rows: tRows } = await pool_1.default.query(`SELECT * FROM tournaments WHERE tournament_id = $1`, [id]);
    if (!tRows.length)
        return res.status(404).json({ error: 'Tournament not found' });
    const t = tRows[0];
    if (t.owner_id !== req.userId)
        return res.status(403).json({ error: 'Only the organizer can finalize' });
    if (t.status !== 'active')
        return res.status(409).json({ error: 'Tournament already finalized' });
    // Winner = top of the leaderboard for this scoring rule, among players who
    // actually posted a round. Same ordering as the GET /:id leaderboard.
    let winnerSql;
    if (t.scoring === 'total_strokes') {
        winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id HAVING COUNT(r.round_id) > 0
       ORDER BY SUM(r.normalized_to_par) ASC LIMIT 1`;
    }
    else if (t.scoring === 'wins') {
        winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = tp.user_id
        LEFT JOIN match_results mr ON mr.match_id = m.match_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id HAVING COUNT(mr.match_id) > 0
       ORDER BY COUNT(*) FILTER (WHERE mr.winner_side = mp.side) DESC LIMIT 1`;
    }
    else {
        // best_round (default; also the fallback for the unimplemented 'points').
        winnerSql = `
      SELECT u.user_id FROM tournament_players tp
        JOIN users u ON u.user_id = tp.user_id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        LEFT JOIN rounds r ON r.match_id = m.match_id AND r.user_id = tp.user_id
       WHERE tp.tournament_id = $1 AND u.is_bot = false AND (m.completed IS NULL OR m.completed = true)
       GROUP BY u.user_id HAVING COUNT(r.round_id) > 0
       ORDER BY MIN(r.normalized_to_par) ASC LIMIT 1`;
    }
    const { rows: top } = await pool_1.default.query(winnerSql, [id]);
    const winnerId = top[0]?.user_id ?? null;
    await pool_1.default.query(`UPDATE tournaments SET status = 'finished', winner_id = $2 WHERE tournament_id = $1`, [id, winnerId]);
    if (winnerId) {
        await pool_1.default.query(`INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
         SELECT $1, c.cosmetic_id, $2 FROM cosmetics c
          WHERE c.unlock_kind = 'tournament_winner' AND (c.unlock_data ->> 'place')::int = 1
       ON CONFLICT (user_id, cosmetic_id) DO NOTHING`, [winnerId, `tournament_${id}_winner`]);
        // Champion feed post — best-effort, never blocks the finalize.
        try {
            await pool_1.default.query(`INSERT INTO posts (user_id, kind, body) SELECT $1, 'text', '🏆 Won ' || $2 || ' on Sacari Golf'`, [winnerId, t.name]);
        }
        catch { /* non-fatal */ }
    }
    return res.json({ success: true, winner_id: winnerId });
}));
exports.default = router;
