"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const adminAuth_1 = require("../utils/adminAuth");
/**
 * Premium tier scaffolding.
 *
 * Today there is no payment processor wired up. Premium status is just a
 * boolean + optional expiry on the users table. When Stripe / Apple IAP /
 * Google Play Billing is integrated later, the corresponding webhook handler
 * should:
 *   1. Verify the signed payload from the provider.
 *   2. UPDATE users SET is_premium = TRUE, premium_since = NOW(),
 *      premium_until = <period end>, premium_plan = <plan id> WHERE user_id = ?.
 *   3. On cancellation/expiry, flip is_premium back to false.
 *
 * The mobile app reads `is_premium` from /users/me and gates UI accordingly.
 * Server-side, gate sensitive endpoints with the `requirePremium` middleware
 * (returns HTTP 402 with `upgrade_required: true`).
 */
const router = (0, express_1.Router)();
/**
 * Catalog of planned premium features, served to the mobile upgrade screen.
 * Centralised here so marketing copy can be updated without an app release.
 */
const FEATURES = [
    {
        id: 'advanced_stats',
        name: 'Deep Stats',
        blurb: 'Per-club strokes-gained, distance distributions, miss tendency heatmaps.',
    },
    {
        id: 'unlimited_shot_tracking',
        name: 'Unlimited Shot Tracking',
        blurb: 'Save every shot of every round. Free tier keeps the last 5 rounds.',
    },
    {
        id: 'rivalries',
        name: 'Rivalries',
        blurb: 'Head-to-head leaderboards, streaks, and trash-talk DMs vs. specific friends.',
    },
    {
        id: 'custom_clan_branding',
        name: 'Custom Clan Branding',
        blurb: 'Banner art, custom colors, and a vanity URL for your clan page.',
    },
    {
        id: 'ad_free',
        name: 'No Ads',
        blurb: 'When ads ship to free users, premium stays clean.',
    },
    {
        id: 'priority_matchmaking',
        name: 'Priority Matchmaking',
        blurb: 'Skip the queue when finding ranked opponents at peak times.',
    },
];
const PLANS = [
    { id: 'monthly', name: 'Monthly', price_cents: 499, period: 'month' },
    { id: 'yearly', name: 'Yearly', price_cents: 3999, period: 'year', savings_pct: 33 },
    { id: 'lifetime', name: 'Lifetime', price_cents: 9999, period: 'forever' },
];
/** Public catalog — used by the mobile upgrade screen. */
router.get('/catalog', (_req, res) => {
    res.json({ features: FEATURES, plans: PLANS });
});
/**
 * RevenueCat webhook receiver. Configure in the RevenueCat dashboard:
 *   URL:          https://YOUR_API/premium/revenuecat-webhook
 *   Auth header:  Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>
 *
 * RevenueCat sends one POST per relevant event (purchase, renewal, cancel,
 * expiration, refund...). We mirror their normalized event types:
 *   • INITIAL_PURCHASE / RENEWAL / NON_RENEWING_PURCHASE → grant / extend
 *   • CANCELLATION / EXPIRATION / REFUND                 → revoke
 *
 * The user's RevenueCat App User ID MUST match our user_id (the mobile
 * client passes it via Purchases.logIn() — see lib/purchases.ts).
 *
 * IMPORTANT: keep this idempotent. RC retries on non-2xx for 72h.
 */
router.post('/revenuecat-webhook', async (req, res) => {
    const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
    // Auth: shared bearer secret. Skip if not configured (lets devs run locally
    // without the env var). In production you MUST set REVENUECAT_WEBHOOK_SECRET.
    if (expected) {
        const auth = req.header('authorization') ?? '';
        if (auth !== `Bearer ${expected}`) {
            return res.status(401).json({ error: 'Bad webhook secret' });
        }
    }
    const event = req.body?.event ?? req.body;
    if (!event)
        return res.status(400).json({ error: 'No event payload' });
    const userId = event.app_user_id ?? event.original_app_user_id;
    if (!userId) {
        console.warn('RevenueCat webhook missing app_user_id', event);
        return res.json({ ok: true, ignored: 'no_user_id' });
    }
    // Map RC product / period to our plan column.
    const productId = event.product_id ?? null;
    const planFromProduct = productId?.includes('lifetime') ? 'lifetime'
        : productId?.includes('year') ? 'yearly'
            : productId?.includes('month') ? 'monthly'
                : 'monthly';
    // Expiration timestamp from RC ("expires_at" or "expiration_at_ms").
    const untilMs = event.expiration_at_ms ?? null;
    const until = typeof untilMs === 'number' ? new Date(untilMs)
        : event.expires_at ? new Date(event.expires_at)
            : null;
    const grantTypes = new Set([
        'INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE',
        'PRODUCT_CHANGE', 'UNCANCELLATION', 'TEMPORARY_ENTITLEMENT_GRANT',
    ]);
    const revokeTypes = new Set([
        'CANCELLATION', 'EXPIRATION', 'REFUND', 'BILLING_ISSUE',
        'SUBSCRIPTION_PAUSED', 'EXPIRED', 'REVOKE',
    ]);
    try {
        if (grantTypes.has(event.type)) {
            await pool_1.default.query(`UPDATE users
            SET is_premium    = TRUE,
                premium_since = COALESCE(premium_since, NOW()),
                premium_until = $2,
                premium_plan  = $3
          WHERE user_id = $1`, [userId, until, planFromProduct]);
        }
        else if (revokeTypes.has(event.type)) {
            // Don't immediately strip access on CANCELLATION — RC sends it on the
            // moment the user toggles auto-renew off. They keep access until the
            // current period ends. Set premium_until from the event so the next
            // /users/me check (which honors expiry) handles cutoff naturally.
            await pool_1.default.query(`UPDATE users
            SET premium_until = COALESCE($2, premium_until),
                is_premium    = CASE
                  WHEN $2::timestamptz IS NULL THEN FALSE                 -- no expiry sent → revoke now
                  WHEN $2::timestamptz <= NOW() THEN FALSE                -- already expired
                  ELSE is_premium                                          -- still in paid window
                END
          WHERE user_id = $1`, [userId, until]);
        }
        else {
            console.log('RevenueCat unhandled event type:', event.type);
        }
    }
    catch (err) {
        console.error('RevenueCat webhook DB write failed:', err);
        // Return 500 so RC retries — better than silently dropping a paid signal.
        return res.status(500).json({ error: 'DB error' });
    }
    res.json({ ok: true });
});
/**
 * Promo-code redemption — interim gate while real payments aren't wired up.
 * Each accepted code grants premium according to its config (currently all
 * lifetime). Codes are matched case-insensitively after stripping whitespace.
 *
 * Add codes by extending PROMO_CODES. For per-user, single-use codes you'd
 * back this with a `promo_codes` table tracking redemption counts; today the
 * list is small and shared, which is fine for closed beta.
 */
const PROMO_CODES = {
    // Lifetime founder code. Hand out to friends/early testers. Lifetime = no expiry.
    F32DK4: { plan: 'lifetime', days: null, label: 'Founder' },
};
router.post('/redeem', auth_1.requireAuth, async (req, res) => {
    const raw = req.body?.code;
    if (typeof raw !== 'string' || !raw.trim()) {
        return res.status(400).json({ error: 'Code required' });
    }
    const normalized = raw.trim().toUpperCase();
    const promo = PROMO_CODES[normalized];
    if (!promo) {
        return res.status(404).json({ error: 'Invalid code' });
    }
    const until = promo.days != null
        ? new Date(Date.now() + promo.days * 24 * 60 * 60 * 1000)
        : null;
    try {
        const { rowCount } = await pool_1.default.query(`UPDATE users
          SET is_premium    = TRUE,
              premium_since = COALESCE(premium_since, NOW()),
              premium_until = $2,
              premium_plan  = $3
        WHERE user_id = $1`, [req.userId, until, promo.plan]);
        if (!rowCount)
            return res.status(404).json({ error: 'User not found' });
        res.json({
            success: true,
            plan: promo.plan,
            premium_until: until,
            label: promo.label,
        });
    }
    catch (err) {
        console.error('POST /premium/redeem failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
/**
 * Dev-only manual grant. Useful for QA and beta testers. Disabled unless
 * `PREMIUM_ADMIN_TOKEN` is set on the server AND the request supplies a
 * matching `x-admin-token` header. Never leave the env var unset in prod
 * if you want this gated; never put the token in client code.
 *
 * POST /premium/admin/grant
 *   header:  x-admin-token: <PREMIUM_ADMIN_TOKEN>
 *   body:    { userId, plan?, days? }   // days = null/omit for lifetime
 */
router.post('/admin/grant', async (req, res) => {
    if (!(0, adminAuth_1.isAdminAuthed)(req, res))
        return;
    const { userId, plan, days } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId required' });
    }
    const planVal = typeof plan === 'string' ? plan : 'lifetime';
    const until = typeof days === 'number' && days > 0
        ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        : null;
    try {
        const { rowCount } = await pool_1.default.query(`UPDATE users
          SET is_premium    = TRUE,
              premium_since = COALESCE(premium_since, NOW()),
              premium_until = $2,
              premium_plan  = $3
        WHERE user_id = $1`, [userId, until, planVal]);
        if (!rowCount)
            return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, premium_until: until, plan: planVal });
    }
    catch (err) {
        console.error('POST /premium/admin/grant failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
/** Dev-only manual revoke — same auth model as grant. */
router.post('/admin/revoke', async (req, res) => {
    if (!(0, adminAuth_1.isAdminAuthed)(req, res))
        return;
    const { userId } = req.body ?? {};
    if (!userId)
        return res.status(400).json({ error: 'userId required' });
    try {
        await pool_1.default.query(`UPDATE users SET is_premium = FALSE, premium_until = NULL, premium_plan = NULL WHERE user_id = $1`, [userId]);
        res.json({ success: true });
    }
    catch (err) {
        console.error('POST /premium/admin/revoke failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
/**
 * Dev-only — seed a user's account with realistic dummy club-shot data so
 * the heatmap and auto-club-suggest features can be exercised before the
 * user has played enough live rounds. Same `x-admin-token` gate as the
 * other admin endpoints.
 *
 *   POST /premium/admin/seed-clubs
 *     header: x-admin-token
 *     body:   { email: string,
 *               clubMedians: { driver?: number, '7i'?: number, ... },
 *               shotsPerClub?: number   // default 25
 *             }
 *
 * Generates `shotsPerClub` segments per club with Gaussian-noised distance
 * (~10% of median) and bearing (~5° std). All shots originate from a single
 * fixed lat/lng so the dispersion stats compute cleanly. Inserts the rows
 * directly into the durable `shots` table (no fake match required) with
 * `source = 'manual'` so they're easy to identify / clean up later.
 */
router.post('/admin/seed-clubs', async (req, res) => {
    if (!(0, adminAuth_1.isAdminAuthed)(req, res))
        return;
    const { email, clubMedians, shotsPerClub = 25 } = req.body ?? {};
    if (typeof email !== 'string' || !clubMedians || typeof clubMedians !== 'object') {
        return res.status(400).json({ error: 'email and clubMedians required' });
    }
    // Lookup user
    const { rows: userRows } = await pool_1.default.query(`SELECT user_id FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
    if (!userRows.length)
        return res.status(404).json({ error: 'User not found' });
    const userId = userRows[0].user_id;
    // Box-Muller transform for Gaussian noise.
    const randNorm = () => {
        const u = 1 - Math.random(), v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    // Walk a fixed bearing + distance from a start coord.
    const R = 6371000;
    const YDS_TO_M = 0.9144;
    const project = (start, bearingRad, distYds) => {
        const distM = distYds * YDS_TO_M;
        const sLat = start.lat * Math.PI / 180;
        const sLng = start.lng * Math.PI / 180;
        const eLat = Math.asin(Math.sin(sLat) * Math.cos(distM / R) +
            Math.cos(sLat) * Math.sin(distM / R) * Math.cos(bearingRad));
        const eLng = sLng + Math.atan2(Math.sin(bearingRad) * Math.sin(distM / R) * Math.cos(sLat), Math.cos(distM / R) - Math.sin(sLat) * Math.sin(eLat));
        return { lat: eLat * 180 / Math.PI, lng: eLng * 180 / Math.PI };
    };
    // Anchor everything at one fictitious tee box. The actual location is
    // irrelevant — the club-stats aggregator only uses relative geometry.
    const ORIGIN = { lat: 40.0, lng: -74.0 };
    const allShots = [];
    for (const [club, raw] of Object.entries(clubMedians)) {
        const median = Number(raw);
        if (!Number.isFinite(median) || median <= 0)
            continue;
        // Distance noise: 10% std (realistic-ish for a 10-handicap).
        // Bearing noise: ~5° std → 9% lateral spread at a given distance.
        const distSigmaYds = median * 0.10;
        const bearingSigmaRad = 5 * Math.PI / 180;
        for (let i = 0; i < shotsPerClub; i++) {
            const dist = Math.max(10, median + randNorm() * distSigmaYds);
            const bearing = randNorm() * bearingSigmaRad;
            // Tiny per-shot start jitter so the points don't land literally on top
            // of each other (helps haversine stay non-zero on edge cases).
            const start = project(ORIGIN, Math.random() * 2 * Math.PI, 1);
            const end = project(start, bearing, dist);
            allShots.push({
                club: club.toLowerCase(),
                start: { lat: start.lat, lng: start.lng },
                end: { lat: end.lat, lng: end.lng },
                recorded_at: new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000).toISOString(),
            });
        }
    }
    if (!allShots.length)
        return res.status(400).json({ error: 'No valid clubs in clubMedians' });
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        // Insert each shot as its own row in the durable `shots` table. No
        // match association — these are seeded for club-stats / heatmap
        // purposes only, and aggregators read from `shots` directly now.
        for (let i = 0; i < allShots.length; i++) {
            const s = allShots[i];
            await client.query(`INSERT INTO shots (
           user_id, match_id, hole_num, shot_index,
           club, start_lat, start_lng, end_lat, end_lng,
           recorded_at, source
         ) VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, 'manual')`, [userId, i, s.club, s.start.lat, s.start.lng, s.end.lat, s.end.lng, s.recorded_at]);
        }
        await client.query('COMMIT');
        res.json({
            success: true,
            total_shots: allShots.length,
            clubs: Object.fromEntries(Object.entries(clubMedians).map(([k, v]) => [k.toLowerCase(), v])),
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /premium/admin/seed-clubs failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
    finally {
        client.release();
    }
});
/**
 * Dev-only nuclear option — deletes ALL matches and everything that
 * cascades from them (match_players, match_invites, match_results,
 * rounds, pin_contributions, round_reactions, round_comments).
 *
 * Note: rows in the `shots` table SURVIVE this wipe — match_id and hole_id
 * are ON DELETE SET NULL, so per-club stats and the heatmap remain intact
 * after a match wipe. That was the whole point of moving shots out of the
 * cascade-deleted JSONB blob.
 *
 * Optional `?resetStats=1` also zeroes out user ELO/win/match counters back
 * to defaults, so the leaderboard goes blank too. Without that flag, user
 * stats stay even though their underlying matches are gone (will look
 * inconsistent until reset or replayed).
 *
 * Same admin-token gate as the other admin endpoints. Use sparingly.
 *
 *   curl -X DELETE 'https://YOUR_API/premium/admin/wipe-matches?resetStats=1' \
 *        -H "x-admin-token: YOUR_PREMIUM_ADMIN_TOKEN"
 */
router.delete('/admin/wipe-matches', async (req, res) => {
    if (!(0, adminAuth_1.isAdminAuthed)(req, res))
        return;
    const resetStats = req.query.resetStats === '1' || req.query.resetStats === 'true';
    const client = await pool_1.default.connect();
    try {
        await client.query('BEGIN');
        // The matches table has ON DELETE CASCADE on most dependent tables, so
        // a single DELETE handles match_players, match_invites, match_results,
        // rounds, pin_contributions, round_reactions, etc. The `shots` table
        // is intentionally ON DELETE SET NULL, so its rows persist (match_id
        // becomes NULL) — per-club stats and the heatmap stay intact.
        const { rowCount: matchesDeleted } = await client.query(`DELETE FROM matches`);
        let usersReset = 0;
        if (resetStats) {
            const { rowCount } = await client.query(`UPDATE users
            SET elo = 100,
                total_matches = 0,
                total_wins = 0,
                total_ties = 0`);
            usersReset = rowCount ?? 0;
        }
        await client.query('COMMIT');
        res.json({
            success: true,
            matches_deleted: matchesDeleted,
            users_stats_reset: usersReset,
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE /premium/admin/wipe-matches failed:', err);
        res.status(500).json({ error: 'Server error' });
    }
    finally {
        client.release();
    }
});
exports.default = router;
