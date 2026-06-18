/**
 * Single source of truth for the club catalog, default yardages, and the
 * partial-swing presets. The bag editor, the in-round club picker, and the
 * club-stats screen all import from here so adding/renaming a club is a
 * one-place change (it used to be copy-pasted in bag.tsx AND the scoring
 * screen, which could drift).
 */
export type ClubGroup = 'Woods' | 'Irons' | 'Wedges' | 'Putter';
export interface ClubDef { code: string; defaultLabel: string; group: ClubGroup }

export const CLUBS_CATALOG: ClubDef[] = [
  { code: 'driver', defaultLabel: 'Driver',         group: 'Woods' },
  { code: '3w',     defaultLabel: '3 Wood',         group: 'Woods' },
  { code: '5w',     defaultLabel: '5 Wood',         group: 'Woods' },
  { code: '7w',     defaultLabel: '7 Wood',         group: 'Woods' },
  { code: 'hybrid', defaultLabel: 'Hybrid',         group: 'Woods' },
  { code: '2i',     defaultLabel: '2 Iron',         group: 'Irons' },
  { code: '3i',     defaultLabel: '3 Iron',         group: 'Irons' },
  { code: '4i',     defaultLabel: '4 Iron',         group: 'Irons' },
  { code: '5i',     defaultLabel: '5 Iron',         group: 'Irons' },
  { code: '6i',     defaultLabel: '6 Iron',         group: 'Irons' },
  { code: '7i',     defaultLabel: '7 Iron',         group: 'Irons' },
  { code: '8i',     defaultLabel: '8 Iron',         group: 'Irons' },
  { code: '9i',     defaultLabel: '9 Iron',         group: 'Irons' },
  { code: 'pw',     defaultLabel: 'Pitching Wedge', group: 'Wedges' },
  { code: 'gw',     defaultLabel: 'Gap Wedge',      group: 'Wedges' },
  { code: 'sw',     defaultLabel: 'Sand Wedge',     group: 'Wedges' },
  { code: 'lw',     defaultLabel: 'Lob Wedge',      group: 'Wedges' },
  { code: 'putter', defaultLabel: 'Putter',         group: 'Putter' },
];

export const CLUB_CODES: string[] = CLUBS_CATALOG.map((c) => c.code);
export const CLUBS_BY_CODE: Record<string, ClubDef> =
  Object.fromEntries(CLUBS_CATALOG.map((c) => [c.code, c]));

/** Display label for a club code, preferring the player's custom label. */
export function clubLabel(code: string, custom?: string | null): string {
  const t = custom?.trim();
  if (t) return t;
  return CLUBS_BY_CODE[code]?.defaultLabel ?? code.toUpperCase();
}

/** Fallback per-club yardages used only until the player has tracked shots;
 *  personal medians from /club-stats override these the moment one lands. */
export const DEFAULT_CLUB_YDS: Record<string, number> = {
  driver: 220, '3w': 200, '5w': 185, '7w': 170, hybrid: 175,
  '2i': 195, '3i': 185, '4i': 170, '5i': 160, '6i': 150,
  '7i': 140, '8i': 130, '9i': 120,
  pw: 110, gw: 90, sw: 70, lw: 55,
};

/**
 * Partial-swing entry modes and their preset chips. Kept SHORT (3 each) so the
 * in-round picker stays one tidy row — "Full" is implicit (no value stored).
 * A user toggles between these modes in Settings (users.partial_swing_mode).
 */
export type PartialMode = 'percentage' | 'clock';
export const PARTIAL_PRESETS: Record<PartialMode, string[]> = {
  percentage: ['90%', '80%', '70%'],
  clock:      ['10:30', '9:00', '7:30'],
};
export function partialPresetsFor(mode: string | null | undefined): string[] {
  return mode === 'clock' ? PARTIAL_PRESETS.clock : PARTIAL_PRESETS.percentage;
}

/** Slugify a custom club name into a safe code (mirror of the backend's
 *  sanitizeClubCode), so a player can carry any club as its own category and
 *  track stats under it. */
export function slugClubCode(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
}
