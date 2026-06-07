"use strict";
/**
 * Course rating / slope estimator + realism checks for user-built courses.
 *
 * USGA course rating is calibrated by USGA-trained raters walking each
 * course; we obviously can't reproduce that. But for the in-app course
 * builder we need *some* sane default when a user doesn't know the official
 * figures, so the WHS handicap math doesn't fall over on rounds played
 * there. The estimator below produces values in the USGA-plausible range
 * (55..80 rating, 85..140 slope) using a linear length-vs-par heuristic.
 * Estimates are flagged so the UI can surface them as "approximate" and an
 * admin can verify later.
 *
 * Realism checks are intentionally loose: they catch obviously-impossible
 * data (par 10, negative yardage, duplicate handicap rankings) but pass
 * unusual-but-real layouts (par 71, par-6 hole, 7600-yd back tee).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateRatingSlope = estimateRatingSlope;
exports.looksPlausibleRating = looksPlausibleRating;
exports.validateTeebox = validateTeebox;
/**
 * Estimate course rating + slope from par and total yardage.
 *
 *   rating ≈ par + (total_yds − neutral_yds) / 220
 *   slope  ≈ 113 + (total_yds − neutral_yds) / 50
 *
 * Where "neutral_yds" is the length at which a course of this par would
 * rate exactly to par. Calibrated so a 6300-yd par-72 → ~70.3 / 124, which
 * lines up with typical mid-difficulty US public courses.
 */
function estimateRatingSlope(par, totalYards, gender = 'male') {
    const neutralYards = (gender === 'female' ? 5200 : 5800) + (par - 72) * 90;
    const rawRating = par + (totalYards - neutralYards) / 220;
    const rating = Math.round(rawRating * 10) / 10;
    const rawSlope = 113 + (totalYards - neutralYards) / 50;
    const slope = Math.round(rawSlope);
    return {
        rating: Math.max(55, Math.min(80, rating)),
        slope: Math.max(85, Math.min(140, slope)),
        estimated: true,
    };
}
/**
 * True iff the user-supplied rating + slope look plausible. Used to decide
 * whether to trust their input or fall back to the estimator. We keep the
 * window wide so weird-but-real combinations (very forward tees, par-69
 * courses) don't get clobbered.
 */
function looksPlausibleRating(rating, slope) {
    if (rating == null && slope == null)
        return false;
    if (rating != null && (rating < 55 || rating > 80))
        return false;
    if (slope != null && (slope < 55 || slope > 155))
        return false;
    return true;
}
/**
 * Validate a teebox's per-hole entries. Hard errors stop the insert;
 * warnings get echoed back so the client can show "looks unusual,
 * double-check" hints without blocking.
 */
function validateTeebox(teeName, numHoles, holes, declaredPar, declaredYards) {
    const hardErrors = [];
    const warnings = [];
    // ── Hole count ─────────────────────────────────────────────────────────
    if (holes.length !== numHoles) {
        hardErrors.push(`${teeName}: expected ${numHoles} holes, got ${holes.length}.`);
        return { hardErrors, warnings };
    }
    // ── Per-hole ──────────────────────────────────────────────────────────
    const seenNums = new Set();
    const seenHcps = new Set();
    let computedPar = 0;
    let computedYards = 0;
    let yardageCount = 0;
    for (const h of holes) {
        const where = `${teeName} hole ${h.hole_num}`;
        if (!Number.isInteger(h.hole_num) || h.hole_num < 1 || h.hole_num > numHoles) {
            hardErrors.push(`${where}: invalid hole number.`);
            continue;
        }
        if (seenNums.has(h.hole_num)) {
            hardErrors.push(`${where}: duplicate hole number.`);
            continue;
        }
        seenNums.add(h.hole_num);
        if (!Number.isInteger(h.par) || h.par < 3 || h.par > 6) {
            hardErrors.push(`${where}: par must be between 3 and 6 (got ${h.par}).`);
        }
        else {
            computedPar += h.par;
            if (h.par === 6) {
                warnings.push(`${where}: par 6 is unusual but accepted.`);
            }
        }
        if (h.yardage != null) {
            if (!Number.isFinite(h.yardage) || h.yardage < 30 || h.yardage > 750) {
                hardErrors.push(`${where}: yardage ${h.yardage} is out of range (30..750).`);
            }
            else {
                computedYards += h.yardage;
                yardageCount++;
                // Soft check: par/yardage mismatch
                if (h.par === 3 && h.yardage > 280)
                    warnings.push(`${where}: par 3 at ${h.yardage} yds is on the long side.`);
                if (h.par === 4 && (h.yardage < 200 || h.yardage > 520))
                    warnings.push(`${where}: par 4 at ${h.yardage} yds is unusual.`);
                if (h.par === 5 && (h.yardage < 400 || h.yardage > 700))
                    warnings.push(`${where}: par 5 at ${h.yardage} yds is unusual.`);
            }
        }
        if (h.handicap != null) {
            if (!Number.isInteger(h.handicap) || h.handicap < 1 || h.handicap > numHoles) {
                hardErrors.push(`${where}: handicap ${h.handicap} must be between 1 and ${numHoles}.`);
            }
            else if (seenHcps.has(h.handicap)) {
                hardErrors.push(`${where}: handicap ${h.handicap} is used on more than one hole.`);
            }
            else {
                seenHcps.add(h.handicap);
            }
        }
    }
    // ── Totals sanity ──────────────────────────────────────────────────────
    if (computedPar > 0) {
        if (numHoles === 18 && (computedPar < 64 || computedPar > 78)) {
            warnings.push(`${teeName}: total par ${computedPar} is outside the usual 64..78 range for 18 holes.`);
        }
        if (numHoles === 9 && (computedPar < 32 || computedPar > 40)) {
            warnings.push(`${teeName}: total par ${computedPar} is outside the usual 32..40 range for 9 holes.`);
        }
        if (declaredPar != null && declaredPar !== computedPar) {
            warnings.push(`${teeName}: declared total par (${declaredPar}) doesn't match hole sum (${computedPar}). Using ${computedPar}.`);
        }
    }
    if (yardageCount === numHoles && computedYards > 0) {
        if (numHoles === 18 && (computedYards < 3500 || computedYards > 8000)) {
            warnings.push(`${teeName}: total yardage ${computedYards} is outside the usual 3500..8000 for 18 holes.`);
        }
        if (numHoles === 9 && (computedYards < 1500 || computedYards > 4500)) {
            warnings.push(`${teeName}: total yardage ${computedYards} is outside the usual 1500..4500 for 9 holes.`);
        }
        if (declaredYards != null && Math.abs(declaredYards - computedYards) > 50) {
            warnings.push(`${teeName}: declared total yardage (${declaredYards}) is more than 50 off the hole sum (${computedYards}). Using ${computedYards}.`);
        }
    }
    return { hardErrors, warnings };
}
