"use strict";
/**
 * Pure live-leaderboard math, shared by the in-app live scoreboard, the web
 * spectator view, and (later) tournament/event standings. No DB access — the
 * caller loads each player's hole_scores + per-hole pars and hands them in, so
 * this stays trivially unit-testable (see backend/tests/leaderboard.test.js).
 *
 * For each player we derive, from however many holes they've posted so far:
 *   • thru  — holes with a real score (0 … N)
 *   • total — gross strokes so far
 *   • toPar — total minus the par of just those holes (so a 9-thru player at
 *             even par reads 0, not "-par-of-back-9")
 *   • points — modified-Stableford points (stableford format only; else null)
 *
 * Ranking: stableford by points (high = good), everything else by toPar
 * (low = good), tie-broken by who's further along. Players who haven't teed
 * off sort to the bottom. Ties SHARE a position, golf-style ("T2"), so two
 * players at -1 are both 2nd and the next is 4th.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeLeaderboard = computeLeaderboard;
/** Modified Stableford: eagle+ 5, birdie 2, par 0, bogey -1, double+ -3.
 *  Matches computeFormatPerf in routes/matches so live + final agree. */
function modStableford(score, par) {
    const d = score - par;
    if (d <= -2)
        return 5;
    if (d === -1)
        return 2;
    if (d === 0)
        return 0;
    if (d === 1)
        return -1;
    return -3;
}
function computeLeaderboard(entries, format) {
    const isStableford = format === 'stableford';
    const rows = entries.map((e) => {
        const scores = e.hole_scores ?? [];
        let thru = 0, total = 0, parThru = 0, points = 0;
        for (let i = 0; i < scores.length; i++) {
            const s = scores[i];
            if (typeof s !== 'number' || s <= 0)
                continue; // unplayed hole
            thru += 1;
            total += s;
            const par = e.parByHole[i];
            if (typeof par === 'number' && par > 0) {
                parThru += par;
                if (isStableford)
                    points += modStableford(s, par);
            }
        }
        return {
            user_id: e.user_id, username: e.username, side: e.side,
            thru, total, toPar: total - parThru,
            points: isStableford ? points : null,
            completed: e.completed, position: 0, meta: e.meta,
        };
    });
    const started = (r) => r.thru > 0;
    rows.sort((a, b) => {
        if (started(a) !== started(b))
            return started(a) ? -1 : 1; // unplayed → bottom
        if (isStableford) {
            if ((b.points ?? 0) !== (a.points ?? 0))
                return (b.points ?? 0) - (a.points ?? 0);
        }
        else if (a.toPar !== b.toPar) {
            return a.toPar - b.toPar;
        }
        if (b.thru !== a.thru)
            return b.thru - a.thru; // further along wins ties
        return a.username.localeCompare(b.username); // stable, deterministic
    });
    // Positions: ties (same score key, among players who've started) share the
    // lower position. Players who haven't started get their raw ordinal.
    let pos = 0, lastKey = null, ordinal = 0;
    for (const r of rows) {
        ordinal += 1;
        if (!started(r)) {
            r.position = ordinal;
            continue;
        }
        const key = isStableford ? `p${r.points}` : `t${r.toPar}`;
        if (key !== lastKey) {
            pos = ordinal;
            lastKey = key;
        }
        r.position = pos;
    }
    return rows;
}
