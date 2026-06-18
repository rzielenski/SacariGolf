/**
 * App skins — full-app colour themes the player can switch between, the same
 * way they switch a profile background. Each skin is a complete palette with
 * the SAME keys as `C` in colors.ts, so swapping a skin re-tints every screen
 * at once (cards, borders, the gold accent, status colours, silver chrome).
 *
 * How the swap actually lands:
 *   `StyleSheet.create(...)` captures colour values ONCE, at module-eval time.
 *   So a live in-place repaint isn't possible without rewriting every stylesheet
 *   to be dynamic. Instead we persist the choice to a synchronous store (iOS
 *   `Settings` = NSUserDefaults) and reload the JS bundle: on the next eval,
 *   colors.ts reads the stored skin and every `StyleSheet.create` captures the
 *   new palette. One reload, whole app re-themed, zero per-screen plumbing.
 *
 *   The read MUST be synchronous (AsyncStorage is async and would resolve after
 *   the first stylesheet already captured the default), which is why this uses
 *   `Settings` rather than AsyncStorage. `Settings` is iOS-only, so skins are an
 *   iOS feature for now; Android always gets the default palette.
 *
 *   The `default` skin is the shipped Sacari palette byte-for-byte, so anyone
 *   who never opens the picker sees exactly what they saw before.
 */
import { Platform, Settings } from 'react-native';

export type SkinPalette = {
  bg: string; surface: string; card: string; cardAlt: string; border: string;
  gold: string; goldLight: string;
  text: string; textMuted: string; textDim: string;
  green: string; red: string; blue: string;
  silver: string; silverDim: string;
};

export type Skin = {
  id: string;
  name: string;
  blurb: string;
  /** [surface, accent, text] preview swatch shown in the picker. */
  swatch: [string, string, string];
  palette: SkinPalette;
};

// Shipped palette, identical to the original colors.ts values. Selecting this
// skin is a no-op repaint — important so the feature is non-breaking by default.
const DEFAULT_PALETTE: SkinPalette = {
  bg: '#000000', surface: '#050507', card: '#0a0a0d', cardAlt: '#121216', border: '#1d1c18',
  gold: '#d4a93f', goldLight: '#f0c95a',
  text: '#ebe9df', textMuted: '#9a978a', textDim: '#4a4740',
  green: '#7aab78', red: '#b03434', blue: '#7a96b8',
  silver: '#c8c5b8', silverDim: '#7a786d',
};

/**
 * The catalog. Each non-default skin keeps the SAME semantic slots — `gold` is
 * always "the primary accent", `red` is always "danger/loss", etc. — so every
 * existing `C.gold` / `C.red` usage stays meaningful, just re-tinted. The themes
 * intentionally mirror the new animated backgrounds (Nebula, Aurora, Ember,
 * Frost) so a player can run a matching background + skin.
 */
export const SKINS: Skin[] = [
  {
    id: 'default', name: 'Sacari Classic',
    blurb: 'True black, antique gold, polished silver.',
    swatch: ['#000000', '#d4a93f', '#ebe9df'],
    palette: DEFAULT_PALETTE,
  },
  {
    id: 'crimson', name: 'Crimson',
    blurb: 'Blood-red over black. For the relentless.',
    swatch: ['#150709', '#e5484d', '#f2e6e2'],
    palette: {
      bg: '#080304', surface: '#0e0506', card: '#150709', cardAlt: '#1d0a0d', border: '#2c1216',
      gold: '#e5484d', goldLight: '#ff7a6a',
      text: '#f2e6e2', textMuted: '#b08e8a', textDim: '#5a3d3c',
      green: '#6fae73', red: '#ff5a4a', blue: '#9a7fb8',
      silver: '#d8c5c2', silverDim: '#8a6e6c',
    },
  },
  {
    id: 'aurora', name: 'Aurora',
    blurb: 'Polar-night greens over deep teal.',
    swatch: ['#0a1f28', '#3ddc97', '#e4f5ee'],
    palette: {
      bg: '#03141b', surface: '#06181f', card: '#0a1f28', cardAlt: '#0f2a34', border: '#16313a',
      gold: '#3ddc97', goldLight: '#7af0c0',
      text: '#e4f5ee', textMuted: '#86ab9f', textDim: '#3c5a52',
      green: '#5fd6a0', red: '#e2685c', blue: '#5ac8e0',
      silver: '#bfe0d6', silverDim: '#6d8a82',
    },
  },
  {
    id: 'nebula', name: 'Nebula',
    blurb: 'Cosmic violet and deep indigo.',
    swatch: ['#140b2a', '#b06bff', '#ece4f7'],
    palette: {
      bg: '#080414', surface: '#0d0720', card: '#140b2a', cardAlt: '#1c1138', border: '#291a48',
      gold: '#b06bff', goldLight: '#d9a8ff',
      text: '#ece4f7', textMuted: '#9d92b8', textDim: '#4f4470',
      green: '#74d9b0', red: '#e2688a', blue: '#74a8ff',
      silver: '#cfc5e0', silverDim: '#776e8a',
    },
  },
  {
    id: 'frost', name: 'Frost',
    blurb: 'Glacier blue and clean ice white.',
    swatch: ['#101f32', '#7cc4ff', '#eaf3fb'],
    palette: {
      bg: '#08111c', surface: '#0b1726', card: '#101f32', cardAlt: '#16293f', border: '#1e3550',
      gold: '#7cc4ff', goldLight: '#bfe4ff',
      text: '#eaf3fb', textMuted: '#8ea6bf', textDim: '#3f566e',
      green: '#6fc9a8', red: '#e2756c', blue: '#74b8e6',
      silver: '#cad9e6', silverDim: '#71889c',
    },
  },
  {
    id: 'ember', name: 'Ember',
    blurb: 'Smouldering charcoal and molten orange.',
    swatch: ['#1d0f07', '#ff8a3a', '#f4e7da'],
    palette: {
      bg: '#0f0703', surface: '#160a05', card: '#1d0f07', cardAlt: '#26160b', border: '#3a2213',
      gold: '#ff8a3a', goldLight: '#ffb36a',
      text: '#f4e7da', textMuted: '#b39a86', textDim: '#5e4634',
      green: '#84ab6f', red: '#ff5a3a', blue: '#c79a6a',
      silver: '#ddccba', silverDim: '#8a7560',
    },
  },
];

export const DEFAULT_SKIN_ID = 'default';
const SKIN_KEY = 'coc_skin';

export function skinById(id: string | null | undefined): Skin {
  return SKINS.find((sk) => sk.id === id) ?? SKINS[0];
}

/**
 * Read the active skin id SYNCHRONOUSLY so colors.ts can resolve the palette
 * before any stylesheet captures it. iOS `Settings.get` hits NSUserDefaults with
 * no await. Android has no synchronous store, so it always returns the default
 * (skins are iOS-only for now). Falls back to default on any unknown/garbage id.
 */
export function readActiveSkinId(): string {
  if (Platform.OS !== 'ios') return DEFAULT_SKIN_ID;
  try {
    const v = Settings.get(SKIN_KEY);
    return typeof v === 'string' && SKINS.some((sk) => sk.id === v) ? v : DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

/** Persist the choice (no repaint — see module header). */
export function writeActiveSkinId(id: string): void {
  if (Platform.OS !== 'ios') return;
  try { Settings.set({ [SKIN_KEY]: id }); } catch { /* best-effort */ }
}

/**
 * Persist + reload so the new palette takes effect everywhere. Resolves to
 * `false` (and the caller stays on screen) only when reloadAsync isn't available
 * — e.g. Expo Go / dev — in which case the skin is saved and applies on the next
 * cold launch. On success the JS bundle tears down before this resolves.
 */
export async function applySkin(id: string): Promise<boolean> {
  writeActiveSkinId(id);
  try {
    const Updates = await import('expo-updates');
    await Updates.reloadAsync();
    return true; // not reached — reload kills the JS context
  } catch {
    return false;
  }
}
