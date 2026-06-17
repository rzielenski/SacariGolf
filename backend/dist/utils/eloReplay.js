"use strict";
/**
 * One-off ELO history replay.
 *
 * Recomputes every player's ELO from scratch under the CURRENT ranked
 * system (100 baseline, 3x placement swings for the first 5 ranked
 * matches of a season, a minimum gain on every win) by replaying all
 * completed matches in chronological order. The point: pull early wins
 * up so existing players land at their correct rank fast, the same way a
 * fresh player would under placements.
 *
 * Design choices that keep this tractable + low-risk:
 *   • It REUSES each match's stored outcome — winner_side and the score
 *     differentials already in match_results — and only recomputes the
 *     ELO *magnitude*. The new system never changed who won or the
 *     differentials, only how much ELO moves, so there's no need to
 *     re-derive strokes / teebox ratings / format scoring.
 *   • Chronological order (match_results.created_at) makes the
 *     path-dependency correct: each match's expected score uses the
 *     players' running rating at that moment.
 *   • Placement counts reset per season; the partial season reset
 *     (keep 50% toward 100) is applied when the timeline crosses a
 *     season boundary, mirroring the live cron.
 *   • BACKUP FIRST. The original users.elo/record and match_results
 *     deltas are copied to elo_backup_* tables (once, preserving the true
 *     original across re-runs). restoreElo() puts them back.
 *
 * Reversible, idempotent (resets to 100 and replays deterministically),
 * and wrapped in a single transaction.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayAllElo = replayAllElo;
exports.restoreElo = restoreElo;
const pool_1 = __importDefault(require("../db/pool"));
// Mirror of the live constants in routes/matches.ts. Duplicated on purpose
// so this one-off tool is self-contained and can't be silently changed by
// future tuning of the live values.
const FLOOR = 100;
const PLACEMENT_MATCHES = 5;
const PLACEMENT_MULTIPLIER = 3;
const PLACEMENT_MIN_WIN_DELTA = 50;
const MIN_WIN_DELTA = 12;
const SEASON_RESET_KEEP = 0.5;
function expectedScore(rA, rB) {
    return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}
function kFactor(totalMatches, elo) {
    if (totalMatches < 30)
        return 32;
    if (elo >= 2400)
        return 16;
    return 24;
}
function shapeDelta(base, won, isPlacement) {
    let d = isPlacement ? base * PLACEMENT_MULTIPLIER : base;
    d = Math.round(d);
    if (won) {
        const f = isPlacement ? PLACEMENT_MIN_WIN_DELTA : MIN_WIN_DELTA;
        if (d < f)
            d = f;
    }
    return d;
}
/** Season id for an arbitrary date — same May1-Nov1 (summer) / Nov1-May1
 *  (winter) boundaries as routes/seasons.ts currentSeason(). */
function seasonIdForDate(d) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth(); // 0 = Jan
    if (m >= 4 && m <= 9)
        return `${y}-summer`;
    const sy = m >= 10 ? y : y - 1;
    return `${sy}-winter`;
}
async function replayAllElo() {
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        // ── 1. Backup (once) ────────────────────────────────────────────
        await client.query(`
      CREATE TABLE IF NOT EXISTS elo_backup_users (
        user_id UUID PRIMARY KEY,
        elo INT, total_matches INT, total_wins INT, total_ties INT,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
        await client.query(`
      CREATE TABLE IF NOT EXISTS elo_backup_results (
        match_id UUID PRIMARY KEY,
        delta_elo INT, details JSONB,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
        const { rows: hasU } = await client.query(`SELECT 1 FROM elo_backup_users LIMIT 1`);
        const backupTaken = hasU.length === 0;
        if (backupTaken) {
            await client.query(`INSERT INTO elo_backup_users (user_id, elo, total_matches, total_wins, total_ties)
         SELECT user_id, elo, total_matches, total_wins, total_ties FROM users`);
            await client.query(`INSERT INTO elo_backup_results (match_id, delta_elo, details)
         SELECT match_id, delta_elo, details FROM match_results`);
        }
        // ── 2. Load every resolved, non-practice match in order ─────────
        const { rows: matches } = await client.query(`SELECT mr.match_id, mr.match_type, mr.winner_side,
              mr.details, mr.created_at, m.paired_match_id
         FROM match_results mr
         JOIN matches m ON m.match_id = mr.match_id
        WHERE m.is_practice = false
        ORDER BY mr.created_at ASC, mr.match_id ASC`);
        // Running state.
        const elo = new Map();
        const tm = new Map(); // total matches
        const tw = new Map(); // total wins
        const tt = new Map(); // total ties
        const place = new Map(); // placement count THIS season
        const E = (u) => elo.get(u) ?? FLOOR;
        const TM = (u) => tm.get(u) ?? 0;
        const isPlacement = (u) => (place.get(u) ?? 0) < PLACEMENT_MATCHES;
        const bump = (u, d, won, tie) => {
            elo.set(u, Math.max(FLOOR, E(u) + d));
            tm.set(u, TM(u) + 1);
            if (won)
                tw.set(u, (tw.get(u) ?? 0) + 1);
            if (tie)
                tt.set(u, (tt.get(u) ?? 0) + 1);
            place.set(u, (place.get(u) ?? 0) + 1);
        };
        // Per-match writeback (new delta_elo + details patch).
        const writeback = new Map();
        const processed = new Set();
        let curSeason = null;
        let matchesProcessed = 0, matchesSkipped = 0, seasonResets = 0;
        // Resolve a match's two sides as user-id arrays. Prefers the stored
        // details player lists; falls back to match_players for older rows
        // (e.g. forfeits that never wrote side lists).
        const sidesFor = async (matchId, details) => {
            if (Array.isArray(details?.side1Players) && Array.isArray(details?.side2Players)) {
                return { s1: details.side1Players, s2: details.side2Players };
            }
            const { rows } = await client.query(`SELECT user_id, side FROM match_players WHERE match_id = $1 ORDER BY side, joined_at`, [matchId]);
            return {
                s1: rows.filter((r) => r.side === 1).map((r) => r.user_id),
                s2: rows.filter((r) => r.side !== 1).map((r) => r.user_id),
            };
        };
        for (const mt of matches) {
            if (processed.has(mt.match_id))
                continue;
            const details = mt.details ?? {};
            // Season boundary → partial reset + placement reset.
            const season = seasonIdForDate(new Date(mt.created_at));
            if (curSeason === null)
                curSeason = season;
            else if (season !== curSeason) {
                for (const [u, e] of elo) {
                    elo.set(u, Math.max(FLOOR, Math.round(FLOOR + (e - FLOOR) * SEASON_RESET_KEEP)));
                }
                place.clear();
                curSeason = season;
                seasonResets++;
            }
            const isFFA = mt.match_type === 'ffa' || details.ffa === true;
            const isForfeit = details.forfeit === true;
            const isLinked = details.linked === true || mt.paired_match_id != null;
            try {
                if (isFFA) {
                    // Replay the N-way as virtual 1v1s using the stored per-player
                    // differentials, then divide by 2(N-1)/N (the live FFA divisor).
                    const placements = Array.isArray(details.placements) ? details.placements : [];
                    if (placements.length < 2) {
                        matchesSkipped++;
                        continue;
                    }
                    const ids = placements.map((p) => p.user_id);
                    const diff = new Map(placements.map((p) => [p.user_id, p.diff ?? 0]));
                    const N = ids.length;
                    const raw = new Map(ids.map((u) => [u, 0]));
                    const wins = new Map(ids.map((u) => [u, 0]));
                    const ties = new Map(ids.map((u) => [u, 0]));
                    for (let i = 0; i < N; i++)
                        for (let j = i + 1; j < N; j++) {
                            const a = ids[i], b = ids[j];
                            const tie = Math.abs((diff.get(a) ?? 0) - (diff.get(b) ?? 0)) < 0.05;
                            const aWins = !tie && (diff.get(a) ?? 0) < (diff.get(b) ?? 0);
                            const expA = expectedScore(E(a), E(b));
                            const kA = kFactor(TM(a), E(a)), kB = kFactor(TM(b), E(b));
                            const actA = tie ? 0.5 : (aWins ? 1 : 0);
                            raw.set(a, (raw.get(a) ?? 0) + kA * (actA - expA));
                            raw.set(b, (raw.get(b) ?? 0) + kB * ((1 - actA) - (1 - expA)));
                            if (tie) {
                                ties.set(a, ties.get(a) + 1);
                                ties.set(b, ties.get(b) + 1);
                            }
                            else if (aWins)
                                wins.set(a, wins.get(a) + 1);
                            else
                                wins.set(b, wins.get(b) + 1);
                        }
                    const divisor = Math.max(1, (2 * (N - 1)) / N);
                    const playerDeltas = {};
                    // Snapshot placement status before bumping (placements counted once).
                    const pl = new Map(ids.map((u) => [u, isPlacement(u)]));
                    for (const u of ids) {
                        const base = (raw.get(u) ?? 0) / divisor;
                        const d = shapeDelta(base, base > 0, pl.get(u));
                        playerDeltas[u] = d;
                    }
                    for (const u of ids) {
                        const place1 = placements.find((p) => p.user_id === u)?.place === 1;
                        bump(u, playerDeltas[u], place1, false);
                    }
                    const newPlacements = placements.map((p) => ({ ...p, delta_elo_signed: playerDeltas[p.user_id] ?? 0 }));
                    writeback.set(mt.match_id, {
                        delta_elo: Math.max(0, ...Object.values(playerDeltas).map((x) => Math.abs(x))),
                        patch: { placements: newPlacements, playerDeltas },
                    });
                    matchesProcessed++;
                    continue;
                }
                // Two-sided: 1v1 / team / forfeit / linked.
                const { s1, s2 } = await sidesFor(mt.match_id, details);
                if (!s1.length || !s2.length) {
                    matchesSkipped++;
                    continue;
                }
                const winnerSide = mt.winner_side ?? null;
                const isTie = winnerSide === null && !isForfeit;
                const side1Wins = isForfeit
                    ? winnerSide === 1
                    : (!isTie && winnerSide === 1);
                const p1 = s1[0], p2 = s2[0];
                const expA = expectedScore(E(p1), E(p2));
                const k = kFactor(TM(p1), E(p1));
                const actual = isTie ? 0.5 : (side1Wins ? 1 : 0);
                const side1Delta = Math.round(k * (actual - expA));
                const side2Delta = -side1Delta;
                // Snapshot placement status before bumping.
                const plMap = new Map([...s1, ...s2].map((u) => [u, isPlacement(u)]));
                const playerDeltas = {};
                for (const u of s1)
                    playerDeltas[u] = shapeDelta(side1Delta, !isTie && side1Wins, plMap.get(u));
                for (const u of s2)
                    playerDeltas[u] = shapeDelta(side2Delta, !isTie && !side1Wins, plMap.get(u));
                for (const u of s1)
                    bump(u, playerDeltas[u], !isTie && side1Wins, isTie);
                for (const u of s2)
                    bump(u, playerDeltas[u], !isTie && !side1Wins, isTie);
                const absMax = Math.max(0, ...Object.values(playerDeltas).map((x) => Math.abs(x)));
                writeback.set(mt.match_id, {
                    delta_elo: absMax,
                    patch: {
                        playerDeltas,
                        side1DeltaSignedElo: playerDeltas[p1] ?? side1Delta,
                        side2DeltaSignedElo: playerDeltas[p2] ?? side2Delta,
                    },
                });
                // Linked: the partner match's row needs the mirror writeback, and
                // must be skipped when the loop reaches it.
                if (isLinked && mt.paired_match_id) {
                    const flipped = {};
                    for (const u of [...s1, ...s2])
                        flipped[u] = playerDeltas[u];
                    writeback.set(mt.paired_match_id, {
                        delta_elo: absMax,
                        patch: {
                            playerDeltas: flipped,
                            // From the partner's perspective its players are side 1.
                            side1DeltaSignedElo: playerDeltas[p2] ?? side2Delta,
                            side2DeltaSignedElo: playerDeltas[p1] ?? side1Delta,
                        },
                    });
                    processed.add(mt.paired_match_id);
                }
                matchesProcessed++;
            }
            catch (err) {
                console.error(`[elo-replay] match ${mt.match_id} failed, skipping:`, err);
                matchesSkipped++;
            }
        }
        // ── 3. Write running ratings back to users ──────────────────────
        // Reset everyone first (covers players whose every match was skipped
        // or who have no matches → back to the floor).
        await client.query(`UPDATE users SET elo = $1, total_matches = 0, total_wins = 0, total_ties = 0`, [FLOOR]);
        let usersUpdated = 0;
        for (const [u, e] of elo) {
            await client.query(`UPDATE users SET elo = $1, total_matches = $2, total_wins = $3, total_ties = $4 WHERE user_id = $5`, [e, TM(u), tw.get(u) ?? 0, tt.get(u) ?? 0, u]);
            usersUpdated++;
        }
        // ── 4. Patch each match's recorded delta + details ──────────────
        for (const [matchId, wb] of writeback) {
            await client.query(`UPDATE match_results
            SET delta_elo = $2,
                details = COALESCE(details, '{}'::jsonb) || $3::jsonb
          WHERE match_id = $1`, [matchId, wb.delta_elo, JSON.stringify({ ...wb.patch, replayed: true })]);
        }
        await client.query('COMMIT');
        return { matchesProcessed, matchesSkipped, usersUpdated, seasonResets, backupTaken };
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
/** Undo a replay: restore users + match_results from the backup tables.
 *  Leaves the backup in place so it can be restored again if needed. */
async function restoreElo() {
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        const { rows: hasU } = await client.query(`SELECT to_regclass('elo_backup_users') IS NOT NULL AS ok`);
        if (!hasU[0]?.ok)
            throw new Error('No elo backup exists — nothing to restore');
        const u = await client.query(`UPDATE users SET elo = b.elo, total_matches = b.total_matches,
              total_wins = b.total_wins, total_ties = b.total_ties
         FROM elo_backup_users b WHERE users.user_id = b.user_id`);
        const r = await client.query(`UPDATE match_results SET delta_elo = b.delta_elo, details = b.details
         FROM elo_backup_results b WHERE match_results.match_id = b.match_id`);
        await client.query('COMMIT');
        return { usersRestored: u.rowCount ?? 0, resultsRestored: r.rowCount ?? 0 };
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
