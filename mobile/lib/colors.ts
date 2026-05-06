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

// Sacari Golf — pure black, warm gothic gold, polished silver.
// Pulled from the SacariSquare crest: black background, gold gothic lettering
// + sword pommel, silver blade. `gold` and `goldLight` are the warm-gold accent
// pair; `text` and `textMuted` are silver tones used for body copy.
export const C = {
  bg:        '#000000',  // pure black — matches the icon background
  surface:   '#080808',  // near-black surface
  card:      '#0e0e10',  // raised card on black
  cardAlt:   '#16161a',  // lifted card
  border:    '#2a241a',  // warm dark gold-bronze edge
  gold:      '#d4a93f',  // rich antique gold (matches SACARI lettering)
  goldLight: '#f0c95a',  // brighter gold highlight
  text:      '#e8e6dc',  // bright polished silver — body text
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
