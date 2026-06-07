"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPEN_BETA_PREMIUM = void 0;
/**
 * Open-beta override flag for premium access.
 *
 * While `OPEN_BETA_PREMIUM` is `true`, two things happen across the API:
 *   1. `requirePremium` middleware passes everyone through (no 402).
 *   2. `/users/me` and `/users/:id` responses ALWAYS report `is_premium: true`
 *      (even though the DB column may still say false), so the mobile client's
 *      `isPremium()` helper naturally returns true without any client change.
 *
 * Why a single flag, not per-feature?
 *   The point of the beta is to collect course data — pins, elevation samples,
 *   shot tracks — before charging. Gating any premium feature would discourage
 *   contribution. Either everything's free or nothing is.
 *
 * To revert: flip this to `false` and redeploy. The DB still holds whatever
 * promo-code redemptions / future IAP purchases granted, so genuine premium
 * users keep access untouched.
 *
 * The env-var hatch (`PREMIUM_OPEN_BETA=false`) lets staging / local dev opt
 * out without touching the source.
 */
exports.OPEN_BETA_PREMIUM = (() => {
    // Explicit env override takes precedence
    const v = (process.env.PREMIUM_OPEN_BETA ?? '').toLowerCase().trim();
    if (v === 'false' || v === '0' || v === 'off')
        return false;
    if (v === 'true' || v === '1' || v === 'on')
        return true;
    // Default: open beta is ON
    return true;
})();
