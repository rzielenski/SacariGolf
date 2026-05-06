import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';

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

const router = Router();

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
  { id: 'monthly',  name: 'Monthly',  price_cents: 499,  period: 'month' },
  { id: 'yearly',   name: 'Yearly',   price_cents: 3999, period: 'year', savings_pct: 33 },
  { id: 'lifetime', name: 'Lifetime', price_cents: 9999, period: 'forever' },
];

/** Public catalog — used by the mobile upgrade screen. */
router.get('/catalog', (_req, res) => {
  res.json({ features: FEATURES, plans: PLANS });
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
const PROMO_CODES: Record<string, { plan: string; days: number | null; label: string }> = {
  // Lifetime founder code. Hand out to friends/early testers. Lifetime = no expiry.
  F32DK4: { plan: 'lifetime', days: null, label: 'Founder' },
};

router.post('/redeem', requireAuth, async (req: AuthRequest, res: Response) => {
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
    const { rowCount } = await pool.query(
      `UPDATE users
          SET is_premium    = TRUE,
              premium_since = COALESCE(premium_since, NOW()),
              premium_until = $2,
              premium_plan  = $3
        WHERE user_id = $1`,
      [req.userId, until, promo.plan]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({
      success: true,
      plan: promo.plan,
      premium_until: until,
      label: promo.label,
    });
  } catch (err) {
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
  const expected = process.env.PREMIUM_ADMIN_TOKEN;
  const provided = req.header('x-admin-token');
  if (!expected || !provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { userId, plan, days } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  const planVal = typeof plan === 'string' ? plan : 'lifetime';
  const until = typeof days === 'number' && days > 0
    ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    : null;
  try {
    const { rowCount } = await pool.query(
      `UPDATE users
          SET is_premium    = TRUE,
              premium_since = COALESCE(premium_since, NOW()),
              premium_until = $2,
              premium_plan  = $3
        WHERE user_id = $1`,
      [userId, until, planVal]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, premium_until: until, plan: planVal });
  } catch (err) {
    console.error('POST /premium/admin/grant failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** Dev-only manual revoke — same auth model as grant. */
router.post('/admin/revoke', async (req, res) => {
  const expected = process.env.PREMIUM_ADMIN_TOKEN;
  const provided = req.header('x-admin-token');
  if (!expected || !provided || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(
      `UPDATE users SET is_premium = FALSE, premium_until = NULL, premium_plan = NULL WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /premium/admin/revoke failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
