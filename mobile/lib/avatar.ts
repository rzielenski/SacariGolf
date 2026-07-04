/**
 * Custom golfer avatar — the data model + option catalog for a Bitmoji-style
 * character each player builds. The character is a layered react-native-svg
 * drawing (see components/GolfAvatar.tsx), so it ships over-the-air and lives
 * in the same vector world as the cosmetics/VFX — no image hosting, no build.
 *
 * The player's choices are stored as a small JSON blob (`avatar_config`) on the
 * user row. Every field is a KEY into one of the catalogs below; the renderer
 * looks the key up, so adding a new hairstyle / hat / colour later is just a
 * catalog entry + (for shapes) one draw branch — never a schema change.
 *
 * `avatar_type` ('photo' | 'character') lets a player use their golfer as their
 * avatar everywhere, or keep an uploaded photo. Default stays 'photo' so nothing
 * changes for existing users until they opt in.
 */

export type AvatarConfig = {
  skin: string;        // SKIN_TONES key
  build: string;       // BUILDS key
  hair: string;        // HAIR_STYLES key ('none' allowed)
  hairColor: string;   // HAIR_COLORS key
  facialHair: string;  // FACIAL_HAIR key ('none' allowed)
  shirt: string;       // SHIRT_STYLES key
  shirtColor: string;  // CLOTHING_COLORS key
  bottom: string;      // BOTTOMS key (pants | shorts)
  bottomColor: string; // CLOTHING_COLORS key
  shoeColor: string;   // CLOTHING_COLORS key
  hat: string;         // HATS key ('none' allowed)
  hatColor: string;    // CLOTHING_COLORS key
  accessory: string;   // ACCESSORIES key ('none' allowed)
};

export type ColorOption = { key: string; label: string; hex: string };
export type StyleOption = { key: string; label: string };

/** Skin tones carry a shadow shade too, for cheek/neck shading in the renderer. */
export type SkinTone = { key: string; label: string; hex: string; shadow: string; line: string };

export const SKIN_TONES: SkinTone[] = [
  { key: 'porcelain', label: 'Porcelain', hex: '#f3cda6', shadow: '#e0b184', line: '#c68f5f' },
  { key: 'fair',      label: 'Fair',      hex: '#eab588', shadow: '#d69c6b', line: '#bd8355' },
  { key: 'tan',       label: 'Tan',       hex: '#d69f70', shadow: '#c0895a', line: '#a06e44' },
  { key: 'olive',     label: 'Olive',     hex: '#b9895a', shadow: '#a2713f', line: '#835a32' },
  { key: 'brown',     label: 'Brown',     hex: '#8f5d37', shadow: '#784a29', line: '#5f3a20' },
  { key: 'deep',      label: 'Deep',      hex: '#66421f', shadow: '#523318', line: '#3d2612' },
  { key: 'ebony',     label: 'Ebony',     hex: '#472a15', shadow: '#37200f', line: '#26160a' },
];

export const HAIR_COLORS: ColorOption[] = [
  { key: 'black',     label: 'Black',     hex: '#201c1a' },
  { key: 'darkbrown', label: 'Dark Brown',hex: '#3b2417' },
  { key: 'brown',     label: 'Brown',     hex: '#6b4423' },
  { key: 'auburn',    label: 'Auburn',    hex: '#7c3a1e' },
  { key: 'ginger',    label: 'Ginger',    hex: '#b65a24' },
  { key: 'blonde',    label: 'Blonde',    hex: '#d8ad56' },
  { key: 'platinum',  label: 'Platinum',  hex: '#e7dcc2' },
  { key: 'gray',      label: 'Gray',      hex: '#9a9a9a' },
  { key: 'white',     label: 'White',     hex: '#eaeaea' },
  { key: 'blue',      label: 'Blue',      hex: '#3a6ea8' },
  { key: 'pink',      label: 'Pink',      hex: '#d86a9a' },
];

/** Shared clothing palette — used for shirt / bottoms / shoes / hat. */
export const CLOTHING_COLORS: ColorOption[] = [
  { key: 'white',   label: 'White',    hex: '#f4f4ee' },
  { key: 'black',   label: 'Black',    hex: '#26292e' },
  { key: 'gray',    label: 'Gray',     hex: '#8b909a' },
  { key: 'navy',    label: 'Navy',     hex: '#27374f' },
  { key: 'royal',   label: 'Royal',    hex: '#2f6fd0' },
  { key: 'sky',     label: 'Sky',      hex: '#6fb7e8' },
  { key: 'teal',    label: 'Teal',     hex: '#1f9d9d' },
  { key: 'green',   label: 'Green',    hex: '#3f8f5a' },
  { key: 'forest',  label: 'Forest',   hex: '#245b3a' },
  { key: 'red',     label: 'Red',      hex: '#c9403f' },
  { key: 'salmon',  label: 'Salmon',   hex: '#e87a5c' },
  { key: 'orange',  label: 'Orange',   hex: '#e2913a' },
  { key: 'yellow',  label: 'Yellow',   hex: '#e6c53f' },
  { key: 'pink',    label: 'Pink',     hex: '#e88bb0' },
  { key: 'purple',  label: 'Purple',   hex: '#7a5cc0' },
  { key: 'sand',    label: 'Sand',     hex: '#cbb487' },
];

export const BUILDS: StyleOption[] = [
  { key: 'slim',    label: 'Slim' },
  { key: 'average', label: 'Average' },
  { key: 'broad',   label: 'Broad' },
];

export const HAIR_STYLES: StyleOption[] = [
  { key: 'none',     label: 'Bald' },
  { key: 'buzz',     label: 'Buzz' },
  { key: 'short',    label: 'Short' },
  { key: 'swoop',    label: 'Swoop' },
  { key: 'curly',    label: 'Curly' },
  { key: 'long',     label: 'Long' },
  { key: 'ponytail', label: 'Ponytail' },
  { key: 'bun',      label: 'Man Bun' },
];

export const FACIAL_HAIR: StyleOption[] = [
  { key: 'none',     label: 'None' },
  { key: 'stubble',  label: 'Stubble' },
  { key: 'mustache', label: 'Mustache' },
  { key: 'goatee',   label: 'Goatee' },
  { key: 'beard',    label: 'Beard' },
];

export const SHIRT_STYLES: StyleOption[] = [
  { key: 'polo',      label: 'Polo' },
  { key: 'vneck',     label: 'V-Neck' },
  { key: 'quarterzip',label: 'Quarter-Zip' },
  { key: 'striped',   label: 'Striped Polo' },
];

export const BOTTOMS: StyleOption[] = [
  { key: 'pants',  label: 'Trousers' },
  { key: 'shorts', label: 'Shorts' },
];

export const HATS: StyleOption[] = [
  { key: 'none',   label: 'None' },
  { key: 'cap',    label: 'Cap' },
  { key: 'visor',  label: 'Visor' },
  { key: 'bucket', label: 'Bucket' },
  { key: 'beanie', label: 'Beanie' },
];

export const ACCESSORIES: StyleOption[] = [
  { key: 'none',       label: 'None' },
  { key: 'glasses',    label: 'Glasses' },
  { key: 'sunglasses', label: 'Shades' },
];

export const DEFAULT_AVATAR: AvatarConfig = {
  skin: 'fair',
  build: 'average',
  hair: 'short',
  hairColor: 'brown',
  facialHair: 'none',
  shirt: 'polo',
  shirtColor: 'royal',
  bottom: 'pants',
  bottomColor: 'navy',
  shoeColor: 'white',
  hat: 'cap',
  hatColor: 'red',
  accessory: 'none',
};

// ── Lookups ─────────────────────────────────────────────────────────────────
function keyed<T extends { key: string }>(list: T[]): Record<string, T> {
  const m: Record<string, T> = {};
  for (const o of list) m[o.key] = o;
  return m;
}
const SKIN_MAP = keyed(SKIN_TONES);
const HAIRC_MAP = keyed(HAIR_COLORS);
const CLOTH_MAP = keyed(CLOTHING_COLORS);

export function skinTone(key: string): SkinTone { return SKIN_MAP[key] ?? SKIN_TONES[1]; }
export function hairHex(key: string): string { return (HAIRC_MAP[key] ?? HAIR_COLORS[2]).hex; }
export function clothHex(key: string): string { return (CLOTH_MAP[key] ?? CLOTHING_COLORS[0]).hex; }

/** Coerce an arbitrary (possibly partial / stale) blob into a valid config.
 *  Unknown keys fall back to the default for that field, so a bad save or an
 *  option we later remove never renders a broken character. */
export function normalizeAvatar(raw: any): AvatarConfig {
  const c = { ...DEFAULT_AVATAR, ...(raw && typeof raw === 'object' ? raw : {}) };
  const inList = (v: string, list: { key: string }[], def: string) =>
    list.some((o) => o.key === v) ? v : def;
  return {
    skin: inList(c.skin, SKIN_TONES, DEFAULT_AVATAR.skin),
    build: inList(c.build, BUILDS, DEFAULT_AVATAR.build),
    hair: inList(c.hair, HAIR_STYLES, DEFAULT_AVATAR.hair),
    hairColor: inList(c.hairColor, HAIR_COLORS, DEFAULT_AVATAR.hairColor),
    facialHair: inList(c.facialHair, FACIAL_HAIR, DEFAULT_AVATAR.facialHair),
    shirt: inList(c.shirt, SHIRT_STYLES, DEFAULT_AVATAR.shirt),
    shirtColor: inList(c.shirtColor, CLOTHING_COLORS, DEFAULT_AVATAR.shirtColor),
    bottom: inList(c.bottom, BOTTOMS, DEFAULT_AVATAR.bottom),
    bottomColor: inList(c.bottomColor, CLOTHING_COLORS, DEFAULT_AVATAR.bottomColor),
    shoeColor: inList(c.shoeColor, CLOTHING_COLORS, DEFAULT_AVATAR.shoeColor),
    hat: inList(c.hat, HATS, DEFAULT_AVATAR.hat),
    hatColor: inList(c.hatColor, CLOTHING_COLORS, DEFAULT_AVATAR.hatColor),
    accessory: inList(c.accessory, ACCESSORIES, DEFAULT_AVATAR.accessory),
  };
}
