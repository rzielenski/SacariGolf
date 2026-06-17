"use strict";
/**
 * FOMO push notifications — the re-engagement nudges that pull players back:
 *
 *   • notifyMatchResolved(matchId) — fired right after a match resolves. Tells
 *     each human player they won/lost, the ELO swing, and (the hook) any tier
 *     promotion or demotion: "You climbed to Gold!" / "You dropped to Silver."
 *     Most valuable for async + bot matches where the player has left the app.
 *
 *   • notifyCupEndingSoon() — once per week, a few hours before the Sacari Cup
 *     closes, pokes recently-active players: "last chance to top the board."
 *
 * Everything here is best-effort and fire-and-forget: a push failure never
 * blocks or rolls back the resolution that triggered it.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyMatchResolved = notifyMatchResolved;
exports.notifyCupEndingSoon = notifyCupEndingSoon;
const pool_1 = __importDefault(require("../db/pool"));
const notify_1 = require("./notify");
const seasons_1 = require("../routes/seasons");
/** Push each human player their result + ELO swing + any tier change. Reads
 *  the stored result (incl. per-player deltas) so it works for every resolver
 *  path (human, bot, linked) without them passing anything but the match id. */
async function notifyMatchResolved(matchId) {
    try {
        const { rows: resRows } = await pool_1.default.query(`SELECT winner_side, details FROM match_results WHERE match_id = $1`, [matchId]);
        if (!resRows.length)
            return;
        const winnerSide = resRows[0].winner_side;
        const details = resRows[0].details ?? {};
        const playerDeltas = details.playerDeltas ?? {};
        const { rows: players } = await pool_1.default.query(`SELECT mp.user_id, mp.side, u.username, u.push_token, u.elo, u.is_bot
         FROM match_players mp
         JOIN users u ON u.user_id = mp.user_id
        WHERE mp.match_id = $1`, [matchId]);
        for (const p of players) {
            if (p.is_bot || !p.push_token)
                continue;
            const delta = Math.round(Number(playerDeltas[p.user_id] ?? 0));
            const afterElo = Number(p.elo);
            const beforeElo = afterElo - delta;
            const tied = winnerSide == null;
            const won = !tied && Number(p.side) === Number(winnerSide);
            // Opponent label = a player on the other side (the bot's "CPU …" name is
            // fine to show — they did play someone).
            const opp = players.find((o) => Number(o.side) !== Number(p.side));
            const oppName = opp?.username ?? 'your opponent';
            const sign = delta > 0 ? `+${delta}` : `${delta}`;
            let title;
            let body;
            if (tied) {
                title = 'Match tied';
                body = `You tied ${oppName}. ${sign} ELO.`;
            }
            else if (won) {
                title = 'You won! 🏌️';
                body = `You beat ${oppName}. ${sign} ELO.`;
            }
            else {
                title = 'Match resolved';
                body = `${oppName} took that one. ${sign} ELO.`;
            }
            // The FOMO hook: a tier crossing.
            const before = (0, seasons_1.divisionForElo)(beforeElo);
            const after = (0, seasons_1.divisionForElo)(afterElo);
            if (after.key !== before.key) {
                body += afterElo > beforeElo
                    ? `  You climbed to ${after.name}! 📈`
                    : `  You dropped to ${after.name}.`;
            }
            await (0, notify_1.sendPush)([p.push_token], title, body, { type: 'match_resolved', matchId });
        }
    }
    catch (err) {
        console.error('[fomo] notifyMatchResolved failed:', err);
    }
}
/**
 * Once per week, ~6 hours before the cup closes (Monday 00:00 UTC), nudge
 * recently-active players. Guarded by app_config so it fires once per cup even
 * across restarts / multiple instances.
 */
async function notifyCupEndingSoon() {
    try {
        // This week's Monday boundary + the next one (when the cup closes).
        const { rows: wk } = await pool_1.default.query(`SELECT date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS week_start,
              (date_trunc('week', NOW() AT TIME ZONE 'UTC') + INTERVAL '7 days') AT TIME ZONE 'UTC' AS week_end,
              NOW() AS now`);
        const weekStart = wk[0].week_start;
        const weekEnd = wk[0].week_end;
        const now = wk[0].now;
        const hoursLeft = (weekEnd.getTime() - now.getTime()) / 3600000;
        if (hoursLeft > 6 || hoursLeft <= 0)
            return; // only in the final 6-hour window
        const weekKey = weekStart.toISOString();
        const { rows: cfg } = await pool_1.default.query(`SELECT value FROM app_config WHERE key = 'cup_reminder_week'`);
        if (typeof cfg[0]?.value === 'string' && cfg[0].value === weekKey)
            return; // already sent
        // Recently-active players (played a solo round in the last 14 days) with a
        // push token — the people for whom "last chance" actually lands.
        const { rows: targets } = await pool_1.default.query(`SELECT DISTINCT u.push_token
         FROM users u
         JOIN rounds r ON r.user_id = u.user_id
         JOIN matches m ON m.match_id = r.match_id AND m.match_type = 'solo' AND m.is_practice = false
        WHERE u.is_bot = false
          AND u.push_token IS NOT NULL
          AND r.created_at > NOW() - INTERVAL '14 days'`);
        const tokens = targets.map((t) => t.push_token).filter(Boolean);
        // Record that we've sent for this week BEFORE pushing, so a crash mid-send
        // doesn't double-blast on the next tick.
        await pool_1.default.query(`INSERT INTO app_config (key, value, updated_at)
       VALUES ('cup_reminder_week', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`, [JSON.stringify(weekKey)]);
        if (tokens.length) {
            await (0, notify_1.sendPush)(tokens, '⛳ Sacari Cup ends tonight', 'Last chance to top this week’s board. One good round could do it.', { type: 'cup_ending' });
        }
    }
    catch (err) {
        console.error('[fomo] notifyCupEndingSoon failed:', err);
    }
}
