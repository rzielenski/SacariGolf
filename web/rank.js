/**
 * Rank ladder for the public website. Kept in sync with mobile/lib/rank.ts and
 * backend/src/routes/seasons.ts. Standalone copy so the site has no dependency
 * on the app code.
 *
 * 7 graded tiers (Wood..Diamond), each 200 ELO split into 4 divisions of 50 LP,
 * counting down 4 -> 1. Obsidian (1500+) is open-ended and shows raw ELO.
 */
'use strict';

const FLOOR_ELO = 100;
const DIVISION_LP = 50;
const OBSIDIAN_FLOOR = 1500;

const TIERS = [
  { key: 'wood',     name: 'Wood',     color: '#9c7b4f', floor: 100 },
  { key: 'bronze',   name: 'Bronze',   color: '#c8863f', floor: 300 },
  { key: 'silver',   name: 'Silver',   color: '#aeb6c2', floor: 500 },
  { key: 'gold',     name: 'Gold',     color: '#d4a93f', floor: 700 },
  { key: 'platinum', name: 'Platinum', color: '#74bd9a', floor: 900 },
  { key: 'ruby',     name: 'Ruby',     color: '#d83a5e', floor: 1100 },
  { key: 'diamond',  name: 'Diamond',  color: '#a89cf0', floor: 1300 },
  { key: 'obsidian', name: 'Obsidian', color: '#e8623a', floor: OBSIDIAN_FLOOR },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

const MEDALLION_DEFAULT = { cx: 0.5, cy: 0.49, diameter: 0.46 };
const MEDALLION_OVERRIDES = {
  diamond: { cx: 0.5, cy: 0.40, diameter: 0.42 },
  gold: { cx: 0.5, cy: 0.47, diameter: 0.45 },
};

function medallionFor(tierKey) {
  return MEDALLION_OVERRIDES[tierKey] || MEDALLION_DEFAULT;
}

function labelForElo(elo) {
  if (elo >= OBSIDIAN_FLOOR) return { label: 'Obsidian', color: '#e8623a' };
  let ti = 0;
  for (let i = 0; i < 7; i++) if (elo >= TIERS[i].floor) ti = i;
  const t = TIERS[ti];
  const divIndex = Math.floor((elo - t.floor) / DIVISION_LP);
  return { label: t.name + ' ' + (4 - divIndex), color: t.color };
}

function rankForElo(eloRaw) {
  const elo = Math.max(FLOOR_ELO, Math.round(Number(eloRaw) || FLOOR_ELO));

  if (elo >= OBSIDIAN_FLOOR) {
    const tier = TIERS[7];
    return {
      tier, isObsidian: true, division: null,
      lp: elo - OBSIDIAN_FLOOR, lpNeeded: null, progress: 1,
      label: 'Obsidian', color: tier.color, displayElo: elo,
      next: null, lpToNext: null,
    };
  }

  let ti = 0;
  for (let i = 0; i < 7; i++) if (elo >= TIERS[i].floor) ti = i;
  const tier = TIERS[ti];
  const offset = elo - tier.floor;
  const divIndex = Math.floor(offset / DIVISION_LP);
  const division = 4 - divIndex;
  const lp = offset - divIndex * DIVISION_LP;
  const nextEdgeElo = tier.floor + (divIndex + 1) * DIVISION_LP;

  return {
    tier, isObsidian: false, division,
    lp, lpNeeded: DIVISION_LP, progress: lp / DIVISION_LP,
    label: tier.name + ' ' + division,
    color: tier.color, displayElo: null,
    next: labelForElo(nextEdgeElo),
    lpToNext: nextEdgeElo - elo,
  };
}

module.exports = { rankForElo, medallionFor, TIERS, ROMAN };
