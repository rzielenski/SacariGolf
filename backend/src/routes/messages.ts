import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const router = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const VOICE_DIR = path.join(UPLOADS_DIR, 'voice');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

/** Max raw audio size in bytes after base64 decoding. 60s of AAC at 64kbps
 *  is ~480 KB; 2 MB gives generous headroom for higher bitrates without
 *  letting the upload become an abuse vector. */
const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 60 * 1000;

/** Whitelist of audio MIME types the recorder might send. iOS expo-av emits
 *  AAC inside an MP4 container (`.m4a`); Android emits MPEG-4 AAC too. */
const VOICE_MIME_EXT: Record<string, string> = {
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

/** Decode + persist a base64 voice clip. Returns the public URL or null if
 *  validation failed (size cap, mime, duration). Caller decides whether to
 *  surface a 400 or just drop the field. */
function persistVoiceClip(
  base64: string,
  mimeType: string,
  durationMs: number,
): { url: string; durationMs: number } | { error: string } {
  const ext = VOICE_MIME_EXT[mimeType];
  if (!ext) return { error: 'Unsupported audio format' };
  if (!base64 || typeof base64 !== 'string') return { error: 'voiceBase64 required' };
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { error: 'Invalid audio data' };
  if (buffer.length > MAX_VOICE_BYTES) return { error: 'Voice clip too large (max 2 MB)' };
  const dur = Number.isFinite(durationMs) ? Math.min(Math.max(0, durationMs), MAX_VOICE_DURATION_MS) : 0;
  // Random filename — message_id would tie the file to the row, but we
  // write the file BEFORE the INSERT so we can rollback the disk write
  // if the INSERT fails. Random UUID avoids overwrite races.
  const filename = `${randomUUID()}.${ext}`;
  const filepath = path.join(VOICE_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return { url: `/uploads/voice/${filename}`, durationMs: dur };
}

router.get('/conversations', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // DM conversation list. The LEFT JOIN to chat_reads gives each row a
  // `last_read_at` (NULL if the user has never opened the chat), and
  // `unread` flips true when the newest message is newer than that — or
  // when no read record exists at all AND the newest message wasn't sent
  // by the current user (no point flagging your own send as unread).
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (other_id)
       other_id,
       u.username AS other_username,
       u.elo AS other_elo,
       last_msg.body AS last_message,
       last_msg.created_at AS last_at,
       last_msg.from_user_id AS last_from_user_id,
       cr.last_read_at AS last_read_at,
       (last_msg.from_user_id != $1
         AND (cr.last_read_at IS NULL OR last_msg.created_at > cr.last_read_at)) AS unread
     FROM (
       SELECT
         CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_id,
         body,
         from_user_id,
         created_at,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END
           ORDER BY created_at DESC
         ) AS rn
       FROM direct_messages
       WHERE from_user_id = $1 OR to_user_id = $1
     ) last_msg
     JOIN users u ON u.user_id = last_msg.other_id
     LEFT JOIN chat_reads cr
            ON cr.user_id = $1
           AND cr.kind = 'dm'
           AND cr.chat_key = last_msg.other_id
     WHERE last_msg.rn = 1
     ORDER BY other_id, last_msg.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

/**
 * Per-user unread summary for match + clan chats. Returns the ids of every
 * match / clan where the newest message is newer than the user's read mark
 * (or where a message exists and no read mark does). The social tab uses
 * this to badge unread chats and sort them to the top without having to
 * fetch every chat's full message list.
 *
 * Returns: { matches: string[], clans: string[] }
 */
router.get('/unread-summary', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Match chats — newest message per match this user is in vs. their read mark.
  const { rows: matchRows } = await pool.query(
    `SELECT mp.match_id
     FROM match_players mp
     JOIN messages m ON m.match_id = mp.match_id
     LEFT JOIN chat_reads cr
            ON cr.user_id = $1
           AND cr.kind = 'match'
           AND cr.chat_key = mp.match_id
     WHERE mp.user_id = $1
       AND m.user_id != $1
     GROUP BY mp.match_id, cr.last_read_at
     HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')`,
    [req.userId]
  );
  // Clan chats — same shape on the clan side.
  const { rows: clanRows } = await pool.query(
    `SELECT cm.clan_id
     FROM clan_members cm
     JOIN messages m ON m.clan_id = cm.clan_id
     LEFT JOIN chat_reads cr
            ON cr.user_id = $1
           AND cr.kind = 'clan'
           AND cr.chat_key = cm.clan_id
     WHERE cm.user_id = $1
       AND m.user_id != $1
     GROUP BY cm.clan_id, cr.last_read_at
     HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')`,
    [req.userId]
  );
  return res.json({
    matches: matchRows.map((r) => r.match_id),
    clans:   clanRows.map((r) => r.clan_id),
  });
}));

/**
 * Mark a chat read. Called whenever the user opens a chat screen so the next
 * unread-summary tick on the social tab drops the badge.
 *   body: { kind: 'dm' | 'match' | 'clan', key: <uuid> }
 */
router.post('/read', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { kind, key } = req.body ?? {};
  if (kind !== 'dm' && kind !== 'match' && kind !== 'clan') {
    return res.status(400).json({ error: 'kind must be dm | match | clan' });
  }
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: 'key required' });
  }
  await pool.query(
    `INSERT INTO chat_reads (user_id, kind, chat_key, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, kind, chat_key)
     DO UPDATE SET last_read_at = NOW()`,
    [req.userId, kind, key]
  );
  return res.json({ success: true });
}));

// Helper: confirm caller is allowed to read/post in this match or clan.
async function memberOfChat(userId: string, matchId?: any, clanId?: any) {
  if (matchId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [matchId, userId]
    );
    return rows.length > 0;
  }
  if (clanId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, userId]
    );
    return rows.length > 0;
  }
  return false;
}

// Helper: confirm two users are friends (for DM gating)
async function areFriends(a: string, b: string) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friends
     WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
       AND status = 'accepted'`,
    [a, b]
  );
  return rows.length > 0;
}

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId, clanId, toUserId } = req.query;

  if (toUserId) {
    const { rows } = await pool.query(
      `SELECT dm.dm_id AS message_id, dm.created_at, dm.body, dm.from_user_id AS user_id, u.username,
              dm.voice_url, dm.voice_duration_ms
       FROM direct_messages dm JOIN users u ON u.user_id = dm.from_user_id
       WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
          OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
       ORDER BY dm.created_at ASC LIMIT 100`,
      [req.userId, toUserId]
    );
    return res.json(rows);
  }

  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });
  // Anyone can read a match's chat once they're in it; same for clan chats.
  if (!(await memberOfChat(req.userId!, matchId, clanId))) {
    return res.status(403).json({ error: 'Not a member of this chat' });
  }
  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  const { rows } = await pool.query(
    `SELECT m.message_id, m.created_at, m.body, m.user_id, u.username,
            m.voice_url, m.voice_duration_ms
     FROM messages m JOIN users u ON u.user_id = m.user_id
     WHERE m.${col} = $1
     ORDER BY m.created_at ASC
     LIMIT 100`,
    [val]
  );
  return res.json(rows);
}));

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { matchId, clanId, toUserId, body, voiceBase64, voiceMime, voiceDurationMs } = req.body ?? {};
  // Trim text; cap at 2000 chars. For voice messages the body becomes the
  // push-notification preview (default "🎤 Voice message"); text-only
  // messages must have non-empty body.
  const text = typeof body === 'string' ? body.trim().slice(0, 2000) : '';

  // Voice clip — optional. When present, decode to disk before the INSERT
  // so we have a URL to store. On INSERT failure we'd leak a clip file;
  // acceptable for now (no PII in the filename, low volume).
  let voice: { url: string; durationMs: number } | null = null;
  if (typeof voiceBase64 === 'string' && voiceBase64.length > 0) {
    const result = persistVoiceClip(voiceBase64, voiceMime ?? 'audio/m4a', Number(voiceDurationMs) || 0);
    if ('error' in result) return res.status(400).json({ error: result.error });
    voice = result;
  }

  // Either text OR voice must be present.
  if (!text && !voice) return res.status(400).json({ error: 'body or voice required' });

  // Default body when only voice is sent — used for push-notification
  // preview and the conversations list's "last_message" preview.
  const effectiveBody = text || '🎤 Voice message';

  if (toUserId) {
    if (toUserId === req.userId) return res.status(400).json({ error: 'Cannot DM yourself' });
    // Gate DMs to friends only — keeps random users from spamming.
    if (!(await areFriends(req.userId!, toUserId))) {
      return res.status(403).json({ error: 'You can only DM friends' });
    }
    const { rows } = await pool.query(
      `INSERT INTO direct_messages (from_user_id, to_user_id, body, voice_url, voice_duration_ms)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id,
                 voice_url, voice_duration_ms`,
      [req.userId, toUserId, effectiveBody, voice?.url ?? null, voice?.durationMs ?? null]
    );
    const msg = rows[0];
    const { rows: senderRows } = await pool.query('SELECT username FROM users WHERE user_id = $1', [req.userId]);
    const senderName = senderRows[0]?.username ?? 'Someone';
    const { rows: recipRows } = await pool.query('SELECT push_token FROM users WHERE user_id = $1', [toUserId]);
    if (recipRows[0]?.push_token) {
      await sendPush([recipRows[0].push_token], senderName, effectiveBody, { type: 'dm', fromUserId: req.userId });
    }
    return res.status(201).json({ ...msg, username: senderName });
  }

  if (!matchId && !clanId) return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });

  // Sender must actually be a participant of the match / clan
  if (!(await memberOfChat(req.userId!, matchId, clanId))) {
    return res.status(403).json({ error: 'Not a member of this chat' });
  }

  const col = matchId ? 'match_id' : 'clan_id';
  const val = matchId ?? clanId;

  const { rows } = await pool.query(
    `INSERT INTO messages (${col}, user_id, body, voice_url, voice_duration_ms)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING message_id, created_at, body, user_id, voice_url, voice_duration_ms`,
    [val, req.userId, effectiveBody, voice?.url ?? null, voice?.durationMs ?? null]
  );
  const msg = rows[0];

  const { rows: senderRows } = await pool.query(
    `SELECT username FROM users WHERE user_id = $1`, [req.userId]
  );
  const senderName = senderRows[0]?.username ?? 'Someone';

  let tokenRows: { push_token: string }[] = [];
  if (matchId) {
    const r = await pool.query(
      `SELECT u.push_token FROM match_players mp
       JOIN users u ON u.user_id = mp.user_id
       WHERE mp.match_id = $1 AND mp.user_id != $2 AND u.push_token IS NOT NULL`,
      [matchId, req.userId]
    );
    tokenRows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT u.push_token FROM clan_members cm
       JOIN users u ON u.user_id = cm.user_id
       WHERE cm.clan_id = $1 AND cm.user_id != $2 AND u.push_token IS NOT NULL`,
      [clanId, req.userId]
    );
    tokenRows = r.rows;
  }

  await sendPush(
    tokenRows.map((r) => r.push_token),
    senderName,
    effectiveBody,
    matchId ? { type: 'chat', matchId } : { type: 'clan_chat', clanId }
  );

  return res.status(201).json({ ...msg, username: senderName });
}));

/**
 * Report a message for abuse. Works for both channel (match/clan) and DM
 * messages — the `kind` discriminator + `messageId` route to the right table.
 * Reporter only needs to be a participant in the chat for membership
 * checks; we don't gate further so blocked-user spam doesn't survive in
 * the reports list.
 *
 *   body: { kind: 'channel' | 'dm', messageId: UUID, reason?: string }
 */
router.post('/report', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { kind, messageId, reason } = req.body ?? {};
  if (kind !== 'channel' && kind !== 'dm') {
    return res.status(400).json({ error: 'kind must be channel | dm' });
  }
  if (typeof messageId !== 'string' || !messageId) {
    return res.status(400).json({ error: 'messageId required' });
  }
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : null;

  // Verify the message exists AND the reporter has access to its chat.
  // Stops random user_ids from reporting messages they can't see.
  if (kind === 'channel') {
    const { rows } = await pool.query(
      `SELECT m.match_id, m.clan_id FROM messages m WHERE m.message_id = $1`,
      [messageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const ok = await memberOfChat(req.userId!, rows[0].match_id ?? undefined, rows[0].clan_id ?? undefined);
    if (!ok) return res.status(403).json({ error: 'Not a member of this chat' });
  } else {
    const { rows } = await pool.query(
      `SELECT from_user_id, to_user_id FROM direct_messages WHERE dm_id = $1`,
      [messageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const p = rows[0];
    if (p.from_user_id !== req.userId && p.to_user_id !== req.userId) {
      return res.status(403).json({ error: 'Not a participant of this DM' });
    }
  }

  await pool.query(
    `INSERT INTO message_reports (kind, message_id, reporter_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, message_id, reporter_id) DO NOTHING`,
    [kind, messageId, req.userId, safeReason]
  );
  return res.status(201).json({ success: true });
}));

export default router;
