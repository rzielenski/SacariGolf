/**
 * Single source of truth for valid club codes, shared by the bag editor
 * (PATCH /users/me, clubs_in_bag) and shot tracking (PUT /matches/:id/shots).
 * Previously this set was copy-pasted in both routes, so adding a club meant
 * editing two places (and they could drift). Import from here instead.
 */
export const ALLOWED_CLUBS = new Set([
  'driver', '3w', '5w', '7w', 'hybrid',
  '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i',
  'pw', 'gw', 'sw', 'lw', 'putter',
]);

/** Shot tracking additionally allows 'chip' — a tracked-but-not-attributed tag
 *  (a chip could be a 56°, 60°, or a hybrid bump, so /club-stats skips it). */
export const ALLOWED_CLUBS_SHOT = new Set<string>([...ALLOWED_CLUBS, 'chip']);

/** Normalize a club code for storage so players can carry ANY club, not just
 *  the preset catalog. Lowercases and keeps [a-z0-9] — every preset code
 *  (driver, 3w, 7i, pw, putter) and the 'chip' tag already match — capping the
 *  length so a custom club ("chipper", "2hybrid") becomes a safe slug. Returns
 *  null for empty/garbage input. */
export function sanitizeClubCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  return slug.length ? slug : null;
}
