"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requirePremium = requirePremium;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const pool_1 = __importDefault(require("../db/pool"));
const openBeta_1 = require("../utils/openBeta");
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token' });
    }
    const token = header.slice(7);
    try {
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.userId = payload.userId;
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
/**
 * Gate a route on the requesting user having an active premium subscription.
 * Active = `is_premium = true` AND (`premium_until` is null OR in the future).
 *
 * Use after `requireAuth`:
 *   router.get('/some-pro-feature', requireAuth, requirePremium, handler)
 *
 * Returns 402 Payment Required so clients can distinguish gated-feature
 * rejection from auth failure.
 */
async function requirePremium(req, res, next) {
    if (!req.userId)
        return res.status(401).json({ error: 'Not authenticated' });
    // Open-beta override — everyone passes through until we start charging.
    // See backend/src/utils/openBeta.ts for the rationale + how to revert.
    if (openBeta_1.OPEN_BETA_PREMIUM)
        return next();
    try {
        const { rows } = await pool_1.default.query(`SELECT is_premium, premium_until
         FROM users
        WHERE user_id = $1`, [req.userId]);
        const u = rows[0];
        const active = u?.is_premium && (!u.premium_until || new Date(u.premium_until) > new Date());
        if (!active) {
            return res.status(402).json({ error: 'Premium required', upgrade_required: true });
        }
        next();
    }
    catch (err) {
        console.error('requirePremium check failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
}
