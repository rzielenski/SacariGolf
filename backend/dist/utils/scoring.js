"use strict";
/**
 * Cross-player score normalization + the USGA score differential — computed
 * ONLY here, in app code, so the whole app shares one definition.
 *
 * `normalizedScore` is the single function every score-vs-score board ranks on.
 * It is computed when a round is written and stored on `rounds.normalized_to_par`
 * (see utils/roundScore.ts), so the boards just `ORDER BY` that column — no
 * scoring formula in SQL. It accounts for BOTH hole count and COURSE DIFFICULTY:
 *
 *   • When the teebox has a course rating + slope, the value is the USGA score
 *     differential (rating/slope adjusted), scaled to an 18-hole equivalent —
 *     the same `roundDifferential` the handicap system uses. So a +5 on a hard
 *     course can rank ahead of a +5 on an easy one, not just 9 vs 18 holes.
 *   • Without rating/slope it falls back to a par-based 18-hole-equivalent
 *     to-par, so a round on a course with no difficulty data still ranks.
 *
 * Lower is always better. This file is the ONE home for round-scoring math:
 *   • roundDifferential — the USGA score differential (re-exported by
 *     utils/handicap.ts for the handicap index).
 *   • diff18 — the same differential as a positional float, scaled to 18,
 *     applied by resolveElo / the bots in routes/matches.ts + utils/bots.ts.
 *   • normalizedScore — what every leaderboard ranks on (stored on the column).
 *   • rankByScore — the winner rule over normalizedScore.
 * The live, in-progress match board (partial holes, stableford) is a different
 * job and lives in utils/leaderboard.ts.
 *
 * --- The 9-vs-18 rating logic in roundDifferential ---
 * A score differential is (113 / slope) x (gross - course rating). The trick is
 * the RIGHT rating + slope for how many holes were played vs the course size:
 *   9-hole course,  played 9   → stored 9-hole rating + slope as-is.
 *   9-hole course,  played 18  → two loops: DOUBLE the rating; slope is a ratio.
 *   18-hole course, played 9   → the dedicated front/back-9 rating + slope if
 *                                published, else HALVE the 18-hole rating.
 *   18-hole course, played 18  → stored rating + slope as-is.
 * A teebox is 9 or 18 purely by num_holes; a 9-hole teebox stores HALF-SCALE
 * rating (~35) + slope (~40-55), so the 113 reference is halved to 56.5 to match.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundDifferential = roundDifferential;
exports.diff18 = diff18;
exports.normalizedScore = normalizedScore;
exports.rankByScore = rankByScore;
const NEUTRAL_SLOPE = 113;
/** Resolve the effective rating + slope for a round (handling 9 vs 18 holes on
 *  9 vs 18-hole courses) and return the resulting score differential for the
 *  holes played. 9-hole rounds keep the per-round value here (NOT doubled to an
 *  18-hole equivalent); callers that need an 18-hole basis double it. */
function roundDifferential(r) {
    const CR = r.course_rating ?? 0;
    const S = r.slope_rating ?? NEUTRAL_SLOPE;
    // Authoritative 9-vs-18 discriminator: the teebox's own hole count. Never
    // inferred from rating/slope magnitude (a 9-hole tee can legitimately have a
    // slope in the 40-55 band, which a magnitude check would mishandle).
    const teeNine = (r.teebox_holes ?? 18) === 9;
    const playedNine = r.holes_played === 9;
    let rating;
    let slope;
    if (teeNine) {
        // 9-hole course — stored rating/slope ARE the 9-hole values.
        if (playedNine) {
            rating = CR; // played the 9 → use as-is
            slope = S;
        }
        else {
            rating = CR * 2; // played 18 (two loops) → double the rating
            slope = S;
        }
    }
    else {
        // 18-hole course.
        if (playedNine) {
            const useBack = r.holes_subset === 'back';
            const sideRating = useBack ? r.back_course_rating : r.front_course_rating;
            const sideSlope = useBack ? r.back_slope_rating : r.front_slope_rating;
            if (typeof sideRating === 'number' && sideRating > 0) {
                // Course publishes a dedicated 9-hole rating/slope for this nine.
                rating = sideRating;
                slope = typeof sideSlope === 'number' && sideSlope > 0 ? sideSlope : S;
            }
            else {
                rating = CR / 2; // only an 18-hole rating exists → halve it
                slope = S;
            }
        }
        else {
            rating = CR; // played 18 → use as-is
            slope = S;
        }
    }
    // Match the 113 reference to the slope's scale: a 9-hole teebox's slope is
    // half-scale → 56.5; an 18-hole teebox's slope (incl. front/back-9 on an
    // 18-hole tee) is full-scale → 113. Keyed on the teebox, not the value.
    const reference = teeNine ? 113 / 2 : 113;
    const safeSlope = slope > 0 ? slope : (teeNine ? NEUTRAL_SLOPE / 2 : NEUTRAL_SLOPE);
    const diff = (reference / safeSlope) * (r.total_score - rating);
    return { rating, slope: safeSlope, diff };
}
/**
 * ELO-facing form of the SAME differential: the 18-hole-equivalent score
 * differential as a positional-arg float, used by match resolution and the
 * bots (routes/matches.ts resolveElo, utils/bots.ts). A thin adapter over
 * `roundDifferential` so there is exactly ONE differential in the app — it
 * resolves the played nine's rating from the override args, then doubles a
 * 9-hole round to the 18-hole scale. Assumes holesPlayed is 9 or 18 (every
 * completed match round is); at those counts it is mathematically identical to
 * the previous standalone implementation.
 */
function diff18(gross, courseRating, slopeRating, holesPlayed = 18, teeboxHoles = 18, overrideRating, overrideSlope) {
    const teeNine = teeboxHoles === 9;
    // Same guard the old standalone diff18 used: a missing/garbage hole count
    // falls back to the teebox's own size so nothing divides by zero.
    const hp = holesPlayed && holesPlayed > 0 ? holesPlayed : (teeNine ? 9 : 18);
    const { diff } = roundDifferential({
        total_score: gross,
        holes_played: hp,
        teebox_holes: teeboxHoles,
        // diff18 callers pre-resolve which nine was played and pass its rating via
        // the override; map that to the front slot (front vs back only selects
        // which value is used, and the value is already resolved).
        holes_subset: 'front',
        course_rating: courseRating,
        slope_rating: slopeRating,
        front_course_rating: overrideRating ?? null,
        front_slope_rating: overrideSlope ?? null,
        back_course_rating: null,
        back_slope_rating: null,
    });
    // roundDifferential is per-round; a 9-hole round is half-scale → double to 18.
    return hp === 9 ? diff * 2 : diff;
}
/** Round half away from zero (Postgres ROUND(numeric) style) — deterministic on
 *  .5 values, so this and any SQL stay in agreement. */
function roundHalfAwayFromZero(x) {
    return Math.sign(x) * Math.round(Math.abs(x));
}
/**
 * THE definition of "how good was this round, on a common basis" — an 18-hole-
 * equivalent score that is also adjusted for course difficulty when we have the
 * data. Difficulty-adjusted (rating/slope) differential when courseRating +
 * slopeRating are present; otherwise par-based 18-hole-equivalent to-par. Lower
 * is better. Called at round-write time; the result is stored on
 * rounds.normalized_to_par. tests/scoring.test.js pins it to worked examples.
 */
function normalizedScore(round) {
    const hp = round.holesPlayed ?? round.numHoles;
    // Course-adjusted differential when we know the rating + slope.
    if (round.courseRating != null && round.slopeRating != null) {
        const { diff } = roundDifferential({
            total_score: round.totalScore,
            holes_played: hp,
            teebox_holes: round.numHoles,
            holes_subset: round.holesSubset ?? null,
            course_rating: round.courseRating,
            slope_rating: round.slopeRating,
            front_course_rating: round.frontCourseRating ?? null,
            front_slope_rating: round.frontSlopeRating ?? null,
            back_course_rating: round.backCourseRating ?? null,
            back_slope_rating: round.backSlopeRating ?? null,
        });
        // roundDifferential is per-round; double a 9-hole round to an 18-hole
        // equivalent so every round compares on one scale.
        return roundHalfAwayFromZero(hp === 9 ? diff * 2 : diff);
    }
    // Fallback: par-based 18-hole-equivalent to-par (no course difficulty data).
    if (!round.numHoles || !hp)
        return round.totalScore - round.par;
    const proRatedPar = (round.par * hp) / round.numHoles;
    return roundHalfAwayFromZero(((round.totalScore - proRatedPar) * 18) / hp);
}
/**
 * Determine the winner / full ranking of stroke-play entries: rank by
 * normalizedScore, lowest first. `result[0]` is the winner. Equal scores keep
 * input order, so pass entries pre-sorted by your tiebreak when ties must be
 * deterministic.
 *
 * This is the single canonical winner rule for every score-vs-score board — the
 * Sacari Cup, a tournament's best-round rule, the course leaderboard, and the
 * profile best-round. Those boards rank on the stored `normalized_to_par`
 * column, which roundScore.ts fills with exactly this function, so they stay in
 * lockstep. Tournament "total strokes" sums the column per round; "wins" /
 * "points" and head-to-head match results are different axes (diff18 above,
 * applied by resolveElo in routes/matches.ts).
 */
function rankByScore(entries) {
    return entries
        .map((e, i) => ({ e, i, score: normalizedScore(e) }))
        .sort((a, b) => (a.score - b.score) || (a.i - b.i))
        .map((x) => x.e);
}
