import { Platform } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// Earlier "earthy vintage" palette — keep here for one-line revert if needed.
// export const C = {
//   bg: '#0a0906', surface: '#13100b', card: '#1a1610', cardAlt: '#201c13',
//   border: '#332b1a', gold: '#b5902b', goldLight: '#cca83c',
//   text: '#e6dcc8', textMuted: '#8a7a58', textDim: '#574c36',
//   green: '#4a7842', red: '#9e3030', blue: '#3d6880',
// };
// ─────────────────────────────────────────────────────────────────────────────

// Sacari Golf — true black, warm gothic gold, polished silver.
// Pulled from the SacariSquare crest: black background, gold gothic lettering
// + sword pommel, silver blade. `gold` and `goldLight` are the warm-gold accent
// pair; `text` and `textMuted` are silver tones used for body copy.
//
// PALETTE NOTES (2026 refresh):
//   The dark surfaces used to lean warm (#0e0e10, #16161a, brown-tinged border)
//   which muddied the contrast against the gold. Switched the surface stack
//   to a slightly cooler near-black so the warm gold pops harder by complement,
//   and dropped the border to a steel-grey-with-faint-gold instead of brown.
//   Net effect: gold reads ~10% brighter against the same backgrounds, and
//   text contrast against card/cardAlt surfaces measures cleaner.
export const C = {
  bg:        '#000000',  // pure black — matches the icon background exactly
  surface:   '#050507',  // truer near-black, slight cool cast for depth
  card:      '#0a0a0d',  // raised card — cooler than prev #0e0e10
  cardAlt:   '#121216',  // lifted card — cooler than prev #16161a
  border:    '#1d1c18',  // steel-with-faint-gold (was warm brown)
  gold:      '#d4a93f',  // rich antique gold (matches SACARI lettering)
  goldLight: '#f0c95a',  // brighter gold highlight
  text:      '#ebe9df',  // bright polished silver — body text (touch brighter)
  textMuted: '#9a978a',  // tarnished silver-grey
  textDim:   '#4a4740',  // deep silver shadow
  green:     '#7aab78',  // sage — WIN / JOIN / Playing Now
  red:       '#b03434',  // crimson — LOSS / danger
  blue:      '#7a96b8',  // steel blue — IN PROGRESS / info
};

// Silver accent — exposed alongside `gold` for places that want the cool
// counterpoint to gold (sword-blade highlights, secondary chrome). Most of the
// app already uses `text` (which is silver) so this is mainly for borders
// and rule lines that want explicit silver vs gold contrast.
export const SILVER = '#c8c5b8';
export const SILVER_DIM = '#7a786d';

// Old-book serif for headings; keep mono for code/IDs.
export const F = {
  serif: Platform.OS === 'ios' ? 'Times New Roman' : 'serif',
  mono:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
};
