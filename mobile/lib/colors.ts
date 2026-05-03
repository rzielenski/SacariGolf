import { Platform } from 'react-native';

// Earthy, vintage golf-club palette
export const C = {
  bg:       '#0a0906',   // near-black, warm brown tint
  surface:  '#13100b',   // dark aged wood
  card:     '#1a1610',   // slightly lifted
  cardAlt:  '#201c13',
  border:   '#332b1a',   // warm brown border
  gold:     '#b5902b',   // antique brass
  goldLight:'#cca83c',
  text:     '#e6dcc8',   // parchment cream
  textMuted:'#8a7a58',   // worn tan
  textDim:  '#574c36',   // dark tan
  green:    '#4a7842',   // forest green, muted
  red:      '#9e3030',   // muted burgundy
  blue:     '#3d6880',   // muted steel blue
};

// Serif / mono helpers for retro headings
export const F = {
  serif: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  mono:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
};
