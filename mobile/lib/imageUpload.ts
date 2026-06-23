import type { ImagePickerAsset } from 'expo-image-picker';

/**
 * Shrink a picked photo before upload. A modern phone photo (12-48 MP) is far
 * larger than anything a comment or chat needs, so we downscale to a 2048px
 * long edge and re-compress to JPEG — typically turning a multi-MB original into
 * a few hundred KB. Faster uploads, less storage, and the server size cap stops
 * mattering.
 *
 * Uses expo-image-manipulator's native module when the running build includes it
 * (it's a native dep, so it only activates after a new build). Before that build
 * ships, it falls back to the picker's own asset unchanged — so this is safe to
 * release over-the-air immediately; it just doesn't shrink until the build lands.
 */
const MAX_DIM = 2048;   // longest-edge cap, in px
const COMPRESS = 0.8;   // JPEG quality applied after the downscale

export type UploadImage = { base64: string; mime: string; uri: string };

export async function compressForUpload(asset: ImagePickerAsset): Promise<UploadImage> {
  const fallback: UploadImage = {
    base64: asset.base64 ?? '',
    mime: asset.mimeType ?? 'image/jpeg',
    uri: asset.uri,
  };
  if (!asset.uri) return fallback;
  try {
    // Lazy require: a build without the native module won't crash on import; the
    // calls below throw there and we drop to the fallback (the raw picker asset).
    const M = require('expo-image-manipulator');
    const w = asset.width ?? 0;
    const h = asset.height ?? 0;
    const ctx = M.ImageManipulator.manipulate(asset.uri);
    if (Math.max(w, h) > MAX_DIM) {
      ctx.resize(w >= h ? { width: MAX_DIM } : { height: MAX_DIM });
    }
    const ref = await ctx.renderAsync();
    const out = await ref.saveAsync({ compress: COMPRESS, format: M.SaveFormat.JPEG, base64: true });
    return out?.base64 ? { base64: out.base64, mime: 'image/jpeg', uri: out.uri } : fallback;
  } catch {
    return fallback;
  }
}
