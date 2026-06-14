/**
 * Canonical rank ladder — the single source of truth for turning a raw ELO
 * number into a tier + division + LP for display. Every screen should use
 * `rankForElo` instead of formatting ELO itself, so the ladder stays in sync.
 *
 * Ladder (matches backend seasons.ts):
 *   • 7 graded tiers — Wood, Bronze, Silver, Gold, Platinum, Ruby, Diamond —
 *     each spanning 200 ELO, split into 4 divisions of 50 LP. Divisions count
 *     DOWN: division 4 is the bottom of a tier, division 1 the top
 *     (Wood 4 → Wood 1 → Bronze 4 → …), mirroring League's IV→I.
 *   • Wood 4 starts at the 100-ELO floor (0 LP). Every +50 ELO = one division.
 *   • OBSIDIAN (1500+) has no divisions — like League Master+, it just shows
 *     the raw ELO number, climbing without a ceiling.
 *
 * The raw ELO is deliberately hidden everywhere EXCEPT Obsidian.
 */

import type { ImageSourcePropType } from 'react-native';

export type TierKey =
  | 'wood' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'ruby' | 'diamond' | 'obsidian';

export interface Tier {
  key: TierKey;
  name: string;
  /** Badge / label color (a readable-on-dark version of the crest metal). */
  color: string;
  /** Inclusive lower ELO bound of the tier. */
  floor: number;
}

export const FLOOR_ELO = 100;
export const DIVISION_LP = 50;
export const OBSIDIAN_FLOOR = 1500;

export const TIERS: Tier[] = [
  { key: 'wood',     name: 'Wood',     color: '#9c7b4f', floor: 100 },
  { key: 'bronze',   name: 'Bronze',   color: '#c8863f', floor: 300 },
  { key: 'silver',   name: 'Silver',   color: '#aeb6c2', floor: 500 },
  { key: 'gold',     name: 'Gold',     color: '#d4a93f', floor: 700 },
  { key: 'platinum', name: 'Platinum', color: '#74bd9a', floor: 900 },
  { key: 'ruby',     name: 'Ruby',     color: '#d83a5e', floor: 1100 },
  { key: 'diamond',  name: 'Diamond',  color: '#a89cf0', floor: 1300 },
  { key: 'obsidian', name: 'Obsidian', color: '#e8623a', floor: OBSIDIAN_FLOOR },
];

export function tierByKey(key: TierKey): Tier {
  return TIERS.find((t) => t.key === key) ?? TIERS[0];
}

export interface Rank {
  tier: Tier;
  isObsidian: boolean;
  /** 1–4 within the tier; null for Obsidian. */
  division: number | null;
  /** LP within the current division (0–49); for Obsidian, ELO above 1500. */
  lp: number;
  /** LP span of a division (50); null for Obsidian. */
  lpNeeded: number | null;
  /** Fill ratio 0–1 of the current division (1 for Obsidian). */
  progress: number;
  /** "Gold 4", "Obsidian". */
  label: string;
  /** Compact form for tight spots: "G4", "OBS". */
  shortLabel: string;
  color: string;
  /** Raw ELO — ONLY surfaced for Obsidian; null otherwise (hidden). */
  displayElo: number | null;
  /** The next rung up, or null at the very top of Obsidian's open climb. */
  next: { label: string; color: string } | null;
  /** ELO/LP remaining to the next rung; null for Obsidian. */
  lpToNext: number | null;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

/** Tier + division label for an arbitrary ELO, used to name the *next* rung. */
function labelForElo(elo: number): { label: string; color: string } {
  if (elo >= OBSIDIAN_FLOOR) {
    const t = tierByKey('obsidian');
    return { label: 'Obsidian', color: t.color };
  }
  let ti = 0;
  for (let i = 0; i < 7; i++) if (elo >= TIERS[i].floor) ti = i;
  const t = TIERS[ti];
  const divIndex = Math.floor((elo - t.floor) / DIVISION_LP); // 0–3
  const division = 4 - divIndex; // 4–1
  return { label: `${t.name} ${division}`, color: t.color };
}

export function rankForElo(eloRaw: number): Rank {
  const elo = Math.max(FLOOR_ELO, Math.round(eloRaw || FLOOR_ELO));

  if (elo >= OBSIDIAN_FLOOR) {
    const tier = tierByKey('obsidian');
    return {
      tier, isObsidian: true, division: null,
      lp: elo - OBSIDIAN_FLOOR, lpNeeded: null, progress: 1,
      label: 'Obsidian', shortLabel: 'OBS', color: tier.color,
      displayElo: elo, next: null, lpToNext: null,
    };
  }

  let ti = 0;
  for (let i = 0; i < 7; i++) if (elo >= TIERS[i].floor) ti = i;
  const tier = TIERS[ti];
  const offset = elo - tier.floor;            // 0–199
  const divIndex = Math.floor(offset / DIVISION_LP); // 0–3
  const division = 4 - divIndex;              // 4–1
  const lp = offset - divIndex * DIVISION_LP; // 0–49
  const nextEdgeElo = tier.floor + (divIndex + 1) * DIVISION_LP; // floor of the next rung

  return {
    tier, isObsidian: false, division,
    lp, lpNeeded: DIVISION_LP, progress: lp / DIVISION_LP,
    label: `${tier.name} ${division}`,
    shortLabel: `${tier.name[0]}${division}`,
    color: tier.color,
    displayElo: null,
    next: labelForElo(nextEdgeElo),
    lpToNext: nextEdgeElo - elo,
  };
}

/** What to show as the headline stat for a player on lists/profiles: the rank
 *  label, with Obsidian's raw ELO appended (the one place ELO stays visible). */
export function rankHeadline(eloRaw: number): string {
  const r = rankForElo(eloRaw);
  return r.isObsidian ? `Obsidian ${r.displayElo}` : r.label;
}

/** Compact leaderboard badge: tier letter + roman division + LP within
 *  that division, e.g. "B III 23" (Bronze 3, 23 LP). Obsidian has no
 *  division, so it shows the raw ELO: "OBS 1620". */
export function rankBadge(eloRaw: number): string {
  const r = rankForElo(eloRaw);
  if (r.isObsidian) return `OBS ${r.displayElo}`;
  return `${r.tier.name[0]} ${ROMAN[r.division ?? 0]} ${r.lp}`;
}

/**
 * Per-tier crest artwork. Drop the generated PNGs into mobile/assets/crests/
 * and uncomment each line as the file lands — until then RankCrest falls back
 * to a clean tier-colored medallion frame, so the app builds with zero assets.
 *
 * Spec for the art (so all 8 stay a consistent set):
 *   • Square, transparent PNG, 512×512 (1024 for crisp retina is fine).
 *   • A circular medallion "well" centered horizontally, centered vertically
 *     at ~46% from the top, ~46% of the image wide — that's where the player's
 *     avatar is composited. Keep that disc empty/dark in the art.
 */
export const CREST_IMAGES: Partial<Record<TierKey, ImageSourcePropType>> = {
  wood:     require('../assets/crests/wood.png'),
  bronze:   require('../assets/crests/bronze.png'),
  silver:   require('../assets/crests/silver.png'),
  gold:     require('../assets/crests/gold.png'),
  platinum: require('../assets/crests/platinum.png'),
  ruby:     require('../assets/crests/ruby.png'),
  diamond:  require('../assets/crests/diamond.png'),
  obsidian: require('../assets/crests/obsidian.png'),
};

/** Where the avatar disc sits inside a crest image, as fractions of the square.
 *  Most emblems center the well; a few (diamond's sits high, gold slightly
 *  high) need an override so the avatar lands in the ring. Tune here if the
 *  art is regenerated. */
export interface Medallion { cx: number; cy: number; diameter: number }
const DEFAULT_MEDALLION: Medallion = { cx: 0.5, cy: 0.49, diameter: 0.46 };
const MEDALLION_OVERRIDES: Partial<Record<TierKey, Medallion>> = {
  diamond: { cx: 0.5, cy: 0.40, diameter: 0.42 },
  gold:    { cx: 0.5, cy: 0.47, diameter: 0.45 },
};
export function medallionFor(tier: TierKey): Medallion {
  return MEDALLION_OVERRIDES[tier] ?? DEFAULT_MEDALLION;
}
