/**
 * Approved-creator group helper. An "approved creator" (users.is_creator = true,
 * or any owner) may HOST a creator league. Membership is managed from the
 * database, same as the owner group:
 *   UPDATE users SET is_creator = true  WHERE LOWER(username) = 'someone';
 *   UPDATE users SET is_creator = false WHERE LOWER(username) = 'someone';
 *
 * Never throws — a lookup failure resolves to "not a creator" so a DB hiccup
 * can't accidentally let just anyone spin up a branded league.
 */
import pool from '../db/pool';

export async function isApprovedCreator(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT (is_owner OR is_creator) AS ok FROM users WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}
