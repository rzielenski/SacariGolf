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

// Sacari Golf — palette pulled directly from the cover art:
//   • deep teal-black backdrop (cloak / outer frame)
//   • bone parchment for text (cream center of the poster)
//   • tarnished brass for primary accent (corner ornaments)
//   • blood crimson for danger / loss (splatter)
export const C = {
  bg:        '#08120f',  // near-black with teal undertone
  surface:   '#0e1f1c',  // crypt teal
  card:      '#142b27',  // cloak shadow
  cardAlt:   '#1c3833',  // lifted cloak
  border:    '#2c4f47',  // muted teal patina
  gold:      '#a07a2a',  // tarnished brass (matches corner ornaments)
  goldLight: '#c89a45',  // warm brass highlight
  text:      '#ece1c4',  // bone parchment (logo's cream center)
  textMuted: '#9aa39a',  // ash sage
  textDim:   '#4f6058',  // deep teal grey
  green:     '#2e5046',  // hooded cloak teal-green
  red:       '#9c2128',  // blood crimson (poster splatter)
  blue:      '#2e4960',  // deep ink (used sparingly)
};

// Old-book serif — Times reads more medieval than Georgia at small sizes.
export const F = {
  serif: Platform.OS === 'ios' ? 'Times New Roman' : 'serif',
  mono:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
};
