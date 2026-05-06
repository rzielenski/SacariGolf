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

// Sacari Golf — dark forest green, antique silver, black.
// `gold` keeps its key name throughout the codebase but its value is now silver.
export const C = {
  bg:        '#06080a',  // black with a touch of green
  surface:   '#0b100d',  // very dark forest
  card:      '#11171a',  // dark slate-green
  cardAlt:   '#1a2127',  // lifted slate
  border:    '#2a3530',  // slate-silver border
  gold:      '#bdb9aa',  // antique silver (replaces tarnished brass)
  goldLight: '#dcd9c8',  // bright silver highlight
  text:      '#e6e3d8',  // off-white silver
  textMuted: '#8c8e85',  // ash silver-grey
  textDim:   '#4a4d48',  // crypt slate
  green:     '#7aab78',  // visible sage — used for WIN / JOIN / Playing Now
  red:       '#b03434',  // brighter crimson — used for LOSS / forfeit / danger
  blue:      '#7a96b8',  // muted steel blue — used for IN PROGRESS / info
};

// Old-book serif for headings; keep mono for code/IDs.
export const F = {
  serif: Platform.OS === 'ios' ? 'Times New Roman' : 'serif',
  mono:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
};
