/**
 * Owner group helper. An "owner" (users.is_owner = true) is a staff/owner
 * account that dynamically owns every cosmetic, counts as premium, and can
 * broadcast an @everyone announcement post. Membership is managed straight
 * from the database:
 *   UPDATE users SET is_owner = true  WHERE LOWER(username) = 'someone';
 *   UPDATE users SET is_owner = false WHERE LOWER(username) = 'someone';
 *
 * Never throws — a lookup failure resolves to "not an owner" so a DB hiccup
 * can't accidentally hand out owner powers.
 */

import pool from '../db/pool';
import { OPEN_BETA_PREMIUM } from './openBeta';

export async function isOwner(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT is_owner FROM users WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.is_owner === true;
  } catch {
    return false;
  }
}

/**
 * Effective premium status for COSMETIC unlocking. True when the open beta is
 * on (premium on the house) OR the user holds a valid paid subscription. Used
 * to grant all non-rank cosmetics to premium users. Never throws.
 */
export async function isPremiumEffective(userId: string | undefined | null): Promise<boolean> {
  if (OPEN_BETA_PREMIUM) return true;
  if (!userId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT is_premium, premium_until FROM users WHERE user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return !!r?.is_premium
      && (r.premium_until == null || new Date(r.premium_until) > new Date());
  } catch {
    return false;
  }
}
