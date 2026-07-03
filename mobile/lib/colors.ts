import { Platform } from 'react-native';
import { skinById, readActiveSkinId } from './skins';

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
// SKINS (2026):
//   `C` is no longer hard-coded — it's built from the player's active skin,
//   resolved SYNCHRONOUSLY at module-eval (see lib/skins.ts) so it's in place
//   before any StyleSheet.create captures it. The `default` skin is the exact
//   palette below, so this is non-breaking: anyone who never picks a skin sees
//   the original Sacari Classic. Switching a skin persists + reloads the bundle,
//   re-evaluating this module against the new palette.
//
//   The shipped palette lives in skins.ts (DEFAULT_PALETTE). The annotated
//   reference for it (kept for readability / one-line revert):
//     bg #000000  surface #050507  card #0a0a0d  cardAlt #121216  border #1d1c18
//     gold #d4a93f (antique gold)  goldLight #f0c95a
//     text #ebe9df (polished silver)  textMuted #9a978a  textDim #4a4740
//     green #7aab78 (WIN)  red #b03434 (LOSS/danger)  blue #7a96b8 (in-progress)
const _skin = skinById(readActiveSkinId());
const _p = _skin.palette;

/** The id of the skin this module evaluated against. */
export const ACTIVE_SKIN_ID = _skin.id;

/** True when the active skin has a light background (e.g. Ultra White).
 *  Consumers that hard-assume dark chrome key off this — most importantly the
 *  root layout's StatusBar, which must flip to dark text or the clock/battery
 *  would be white-on-white. Computed from the bg's relative luminance so any
 *  future light skin gets the right treatment without a registry. */
export const IS_LIGHT_SKIN = (() => {
  const m = _p.bg.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
})();

export const C = {
  bg:        _p.bg,
  surface:   _p.surface,
  card:      _p.card,
  cardAlt:   _p.cardAlt,
  border:    _p.border,
  gold:      _p.gold,
  goldLight: _p.goldLight,
  text:      _p.text,
  textMuted: _p.textMuted,
  textDim:   _p.textDim,
  green:     _p.green,
  red:       _p.red,
  blue:      _p.blue,
};

// Silver accent — exposed alongside `gold` for places that want the cool
// counterpoint to gold (sword-blade highlights, secondary chrome). Most of the
// app already uses `text` (which is silver) so this is mainly for borders
// and rule lines that want explicit silver vs gold contrast.
export const SILVER = _p.silver;
export const SILVER_DIM = _p.silverDim;

// Old-book serif for headings; keep mono for code/IDs.
export const F = {
  serif: Platform.OS === 'ios' ? 'Times New Roman' : 'serif',
  mono:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
};
