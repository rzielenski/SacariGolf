/**
 * Tiny client-side premium-status helper.
 *
 * Source of truth is the `is_premium` and `premium_until` fields on the user
 * object returned by /users/me. Client gating is a UX nicety only — every
 * sensitive endpoint MUST also gate on `requirePremium` server-side, since a
 * malicious client can lie about its own boolean.
 */

type PremiumLikeUser = {
  is_premium?: boolean | null;
  premium_until?: string | null;
} | null | undefined;

export function isPremium(user: PremiumLikeUser): boolean {
  if (!user || !user.is_premium) return false;
  if (!user.premium_until) return true; // lifetime / no expiry
  const until = new Date(user.premium_until);
  return Number.isFinite(until.getTime()) && until.getTime() > Date.now();
}

/** Days remaining on the subscription, or null for lifetime / non-premium. */
export function premiumDaysLeft(user: PremiumLikeUser): number | null {
  if (!isPremium(user) || !user?.premium_until) return null;
  const ms = new Date(user.premium_until).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
