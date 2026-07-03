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
  {
    id: 'synthwave', name: 'Synthwave',
    blurb: 'Neon magenta over a retro purple night.',
    swatch: ['#1c0a30', '#ff2d95', '#f5e6f5'],
    palette: {
      bg: '#0d0418', surface: '#140622', card: '#1c0a30', cardAlt: '#260f40', border: '#3a1a55',
      gold: '#ff2d95', goldLight: '#ff7ac0',
      text: '#f5e6f5', textMuted: '#b48ab8', textDim: '#5e4068',
      green: '#5fd6a0', red: '#ff5a7a', blue: '#74a8ff',
      silver: '#d9c5dd', silverDim: '#8a6e90',
    },
  },
  {
    id: 'matrix', name: 'Matrix',
    blurb: 'Phosphor green on terminal black.',
    swatch: ['#07180e', '#2bd96a', '#d8ffe0'],
    palette: {
      bg: '#020a05', surface: '#04110a', card: '#07180e', cardAlt: '#0b2213', border: '#14361f',
      gold: '#2bd96a', goldLight: '#6effa0',
      text: '#d8ffe0', textMuted: '#7aae8a', textDim: '#355a40',
      green: '#3ddc7a', red: '#e2685c', blue: '#5ac8a0',
      silver: '#b8e0c4', silverDim: '#6d8a76',
    },
  },
  {
    id: 'sakura', name: 'Sakura',
    blurb: 'Soft cherry blossom over dark plum.',
    swatch: ['#2c1320', '#ff8fb0', '#f7e6ee'],
    palette: {
      bg: '#1a0a12', surface: '#220e18', card: '#2c1320', cardAlt: '#391829', border: '#4e2238',
      gold: '#ff8fb0', goldLight: '#ffb6cf',
      text: '#f7e6ee', textMuted: '#c099a8', textDim: '#6e4658',
      green: '#84c79f', red: '#ff6a86', blue: '#b692d9',
      silver: '#e0c8d2', silverDim: '#946e7e',
    },
  },
  {
    id: 'tide', name: 'Deep Tide',
    blurb: 'Sunlit cyan over an ocean trench.',
    swatch: ['#0a2336', '#2aa8d9', '#e2f1fb'],
    palette: {
      bg: '#04121f', surface: '#06192a', card: '#0a2336', cardAlt: '#102f45', border: '#1a3f5a',
      gold: '#2aa8d9', goldLight: '#6fd0f0',
      text: '#e2f1fb', textMuted: '#88a8bf', textDim: '#3c5a70',
      green: '#4fd6b0', red: '#e2756c', blue: '#5ac8e0',
      silver: '#c5dbe8', silverDim: '#71889c',
    },
  },
  {
    id: 'sunset', name: 'Sunset',
    blurb: 'Coral and dusk over deep indigo.',
    swatch: ['#261334', '#ff7a5c', '#f7e8e2'],
    palette: {
      bg: '#140a1e', surface: '#1c0e26', card: '#261334', cardAlt: '#341a40', border: '#4a2450',
      gold: '#ff7a5c', goldLight: '#ffae8a',
      text: '#f7e8e2', textMuted: '#c099a0', textDim: '#6e4858',
      green: '#84c79f', red: '#ff5a4a', blue: '#a07ad9',
      silver: '#e0c8c5', silverDim: '#94707a',
    },
  },
  {
    id: 'cyber', name: 'Cyber',
    blurb: 'Electric teal on a circuit-board night.',
    swatch: ['#07211d', '#00d9c4', '#dffaf5'],
    palette: {
      bg: '#02100e', surface: '#041815', card: '#07211d', cardAlt: '#0b2e28', border: '#144039',
      gold: '#00d9c4', goldLight: '#5ff0e0',
      text: '#dffaf5', textMuted: '#7aaea6', textDim: '#355a54',
      green: '#3ddc9a', red: '#e2685c', blue: '#5ad0e0',
      silver: '#b8e0d8', silverDim: '#6d8a84',
    },
  },
  {
    // The ONE light skin. Styled after a matte-white energy can: cool pearl
    // panels, a brushed-gunmetal accent where every other skin runs a bright
    // hue, jet-black type. Every slot is re-derived for a light ground —
    // "dim" means LIGHTER here (fades toward the paper), status colours are
    // darkened to hold contrast on white, and chrome silver goes dark slate
    // so it still reads as metal against pearl. The root layout flips the
    // iOS status bar to dark text when this skin is active (IS_LIGHT_SKIN).
    id: 'ultra', name: 'Ultra White',
    blurb: 'Matte pearl, brushed gunmetal, jet black. Zero sugar.',
    swatch: ['#f7f8fa', '#6e7681', '#16181c'],
    palette: {
      bg: '#eef0f3', surface: '#e7eaee', card: '#f7f8fa', cardAlt: '#ffffff', border: '#d3d8de',
      gold: '#6e7681', goldLight: '#98a1ab',
      text: '#16181c', textMuted: '#5d6570', textDim: '#a6adb6',
      green: '#2e8b57', red: '#c03038', blue: '#3a6ea8',
      silver: '#4c545e', silverDim: '#9aa2ac',
    },
  },
  {
    // July 4th. Pairs with the Stars & Stripes profile background: deep navy
    // night, firework-red accent, star-white type and silver. Danger red stays
    // hotter than the accent red (same precedent as Crimson).
    id: 'glory', name: 'Old Glory',
    blurb: 'Navy night, firework red, fifty stars of white.',
    swatch: ['#101c38', '#e8434a', '#eff3fb'],
    palette: {
      bg: '#060c1d', surface: '#0a1226', card: '#101c38', cardAlt: '#172548', border: '#243560',
      gold: '#e8434a', goldLight: '#ff7d75',
      text: '#eff3fb', textMuted: '#97a3c2', textDim: '#46527c',
      green: '#5fae78', red: '#ff5a52', blue: '#6f9fe8',
      silver: '#ccd7ec', silverDim: '#7985a3',
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
