import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Comment image attachments. Same write-before-INSERT discipline as the chat
 * image helper in routes/messages.ts: the file is written first, and the caller
 * unlinks it if the row INSERT fails, so a failed comment never leaks a file.
 * Stored under /uploads/comments/ and served as a static path.
 */
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const COMMENT_IMG_DIR = path.join(UPLOADS_DIR, 'comments');
if (!fs.existsSync(COMMENT_IMG_DIR)) fs.mkdirSync(COMMENT_IMG_DIR, { recursive: true });

/** 10 MB after base64 decode — matches the chat-image cap. The app downscales
 *  most uploads well under 1 MB before sending; this is just headroom. */
const MAX_COMMENT_IMG_BYTES = 10 * 1024 * 1024;
const COMMENT_IMG_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

/** Decode + persist a base64 comment image. Returns the public URL or an error. */
export function persistCommentImage(
  base64: string,
  mimeType: string,
): { url: string } | { error: string } {
  const ext = COMMENT_IMG_MIME_EXT[mimeType];
  if (!ext) return { error: 'Unsupported image format (use JPEG, PNG, or WebP)' };
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { error: 'Invalid image data' };
  if (buffer.length > MAX_COMMENT_IMG_BYTES) return { error: 'Image too large (max 10 MB)' };
  const filename = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(COMMENT_IMG_DIR, filename), buffer);
  return { url: `/uploads/comments/${filename}` };
}

/** Best-effort cleanup of a persisted comment image after an INSERT failure. */
export function unlinkCommentImage(url: string | null | undefined) {
  if (!url?.startsWith('/uploads/comments/')) return;
  const fname = url.replace('/uploads/comments/', '');
  try { fs.unlinkSync(path.join(COMMENT_IMG_DIR, fname)); } catch { /* already gone, fine */ }
}
