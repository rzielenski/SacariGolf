"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const notify_1 = require("../utils/notify");
const asyncHandler_1 = require("../utils/asyncHandler");
const router = (0, express_1.Router)();
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const VOICE_DIR = path_1.default.join(UPLOADS_DIR, 'voice');
if (!fs_1.default.existsSync(VOICE_DIR))
    fs_1.default.mkdirSync(VOICE_DIR, { recursive: true });
const CHAT_IMG_DIR = path_1.default.join(UPLOADS_DIR, 'chat');
if (!fs_1.default.existsSync(CHAT_IMG_DIR))
    fs_1.default.mkdirSync(CHAT_IMG_DIR, { recursive: true });
/** Max raw image size after base64 decode. Mirrors the 4 MB feed-photo cap
 *  in posts.ts — generous for a phone photo at quality 0.6-0.75. */
const MAX_CHAT_IMG_BYTES = 4 * 1024 * 1024;
const CHAT_IMG_MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};
/** Max raw audio size in bytes after base64 decoding. 60s of AAC at 64kbps
 *  is ~480 KB; 2 MB gives generous headroom for higher bitrates without
 *  letting the upload become an abuse vector. */
const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 60 * 1000;
/** Whitelist of audio MIME types the recorder might send. iOS expo-av emits
 *  AAC inside an MP4 container (`.m4a`); Android emits MPEG-4 AAC too. */
const VOICE_MIME_EXT = {
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
};
/** Decode + persist a base64 voice clip. Returns the public URL or null if
 *  validation failed (size cap, mime, duration). Caller decides whether to
 *  surface a 400 or just drop the field. */
function persistVoiceClip(base64, mimeType, durationMs) {
    const ext = VOICE_MIME_EXT[mimeType];
    if (!ext)
        return { error: 'Unsupported audio format' };
    if (!base64 || typeof base64 !== 'string')
        return { error: 'voiceBase64 required' };
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0)
        return { error: 'Invalid audio data' };
    if (buffer.length > MAX_VOICE_BYTES)
        return { error: 'Voice clip too large (max 2 MB)' };
    const dur = Number.isFinite(durationMs) ? Math.min(Math.max(0, durationMs), MAX_VOICE_DURATION_MS) : 0;
    // Random filename — message_id would tie the file to the row, but we
    // write the file BEFORE the INSERT so we can rollback the disk write
    // if the INSERT fails. Random UUID avoids overwrite races.
    const filename = `${(0, crypto_1.randomUUID)()}.${ext}`;
    const filepath = path_1.default.join(VOICE_DIR, filename);
    fs_1.default.writeFileSync(filepath, buffer);
    return { url: `/uploads/voice/${filename}`, durationMs: dur };
}
/** Best-effort unlink of a persisted voice clip. Used to clean up after an
 *  INSERT failure so we don't leak files on disk for messages that never
 *  reached the database. */
function unlinkVoiceClip(url) {
    if (!url?.startsWith('/uploads/voice/'))
        return;
    const fname = url.replace('/uploads/voice/', '');
    try {
        fs_1.default.unlinkSync(path_1.default.join(VOICE_DIR, fname));
    }
    catch { /* already gone, fine */ }
}
/** Decode + persist a base64 chat image. Same write-before-INSERT pattern
 *  as the voice clip so a failed message doesn't leak a file. */
function persistChatImage(base64, mimeType) {
    const ext = CHAT_IMG_MIME_EXT[mimeType];
    if (!ext)
        return { error: 'Unsupported image format (use JPEG, PNG, or WebP)' };
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0)
        return { error: 'Invalid image data' };
    if (buffer.length > MAX_CHAT_IMG_BYTES)
        return { error: 'Image too large (max 4 MB)' };
    const filename = `${(0, crypto_1.randomUUID)()}.${ext}`;
    fs_1.default.writeFileSync(path_1.default.join(CHAT_IMG_DIR, filename), buffer);
    return { url: `/uploads/chat/${filename}` };
}
function unlinkChatImage(url) {
    if (!url?.startsWith('/uploads/chat/'))
        return;
    const fname = url.replace('/uploads/chat/', '');
    try {
        fs_1.default.unlinkSync(path_1.default.join(CHAT_IMG_DIR, fname));
    }
    catch { /* already gone, fine */ }
}
router.get('/conversations', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    // DM conversation list. The LEFT JOIN to chat_reads gives each row a
    // `last_read_at` (NULL if the user has never opened the chat), and
    // `unread` flips true when the newest message is newer than that — or
    // when no read record exists at all AND the newest message wasn't sent
    // by the current user (no point flagging your own send as unread).
    const { rows } = await pool_1.default.query(`SELECT DISTINCT ON (other_id)
       other_id,
       u.username AS other_username,
       u.elo AS other_elo,
       u.avatar_url AS other_avatar_url,
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
     ORDER BY other_id, last_msg.created_at DESC`, [req.userId]);
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
router.get('/unread-summary', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    // Match chats — newest message per match this user is in vs. their read mark.
    const { rows: matchRows } = await pool_1.default.query(`SELECT mp.match_id
     FROM match_players mp
     JOIN messages m ON m.match_id = mp.match_id
     LEFT JOIN chat_reads cr
            ON cr.user_id = $1
           AND cr.kind = 'match'
           AND cr.chat_key = mp.match_id
     WHERE mp.user_id = $1
       AND m.user_id != $1
     GROUP BY mp.match_id, cr.last_read_at
     HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')`, [req.userId]);
    // Clan chats — same shape on the clan side.
    const { rows: clanRows } = await pool_1.default.query(`SELECT cm.clan_id
     FROM clan_members cm
     JOIN messages m ON m.clan_id = cm.clan_id
     LEFT JOIN chat_reads cr
            ON cr.user_id = $1
           AND cr.kind = 'clan'
           AND cr.chat_key = cm.clan_id
     WHERE cm.user_id = $1
       AND m.user_id != $1
     GROUP BY cm.clan_id, cr.last_read_at
     HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')`, [req.userId]);
    return res.json({
        matches: matchRows.map((r) => r.match_id),
        clans: clanRows.map((r) => r.clan_id),
    });
}));
/**
 * Mark a chat read. Called whenever the user opens a chat screen so the next
 * unread-summary tick on the social tab drops the badge.
 *   body: { kind: 'dm' | 'match' | 'clan', key: <uuid> }
 */
router.post('/read', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { kind, key } = req.body ?? {};
    if (kind !== 'dm' && kind !== 'match' && kind !== 'clan') {
        return res.status(400).json({ error: 'kind must be dm | match | clan' });
    }
    if (typeof key !== 'string' || !key) {
        return res.status(400).json({ error: 'key required' });
    }
    await pool_1.default.query(`INSERT INTO chat_reads (user_id, kind, chat_key, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, kind, chat_key)
     DO UPDATE SET last_read_at = NOW()`, [req.userId, kind, key]);
    return res.json({ success: true });
}));
// Helper: confirm caller is allowed to read/post in this match or clan.
async function memberOfChat(userId, matchId, clanId) {
    if (matchId) {
        const { rows } = await pool_1.default.query(`SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2`, [matchId, userId]);
        return rows.length > 0;
    }
    if (clanId) {
        const { rows } = await pool_1.default.query(`SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`, [clanId, userId]);
        return rows.length > 0;
    }
    return false;
}
// Helper: confirm two users are friends (for DM gating)
async function areFriends(a, b) {
    const { rows } = await pool_1.default.query(`SELECT 1 FROM friends
     WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
       AND status = 'accepted'`, [a, b]);
    return rows.length > 0;
}
router.get('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { matchId, clanId, toUserId } = req.query;
    if (toUserId) {
        const { rows } = await pool_1.default.query(`SELECT dm.dm_id AS message_id, dm.created_at, dm.body, dm.from_user_id AS user_id,
              u.username, u.avatar_url,
              dm.voice_url, dm.voice_duration_ms, dm.image_url
       FROM direct_messages dm JOIN users u ON u.user_id = dm.from_user_id
       WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
          OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
       ORDER BY dm.created_at ASC LIMIT 100`, [req.userId, toUserId]);
        return res.json(rows);
    }
    if (!matchId && !clanId)
        return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });
    // Anyone can read a match's chat once they're in it; same for clan chats.
    if (!(await memberOfChat(req.userId, matchId, clanId))) {
        return res.status(403).json({ error: 'Not a member of this chat' });
    }
    const col = matchId ? 'match_id' : 'clan_id';
    const val = matchId ?? clanId;
    const { rows } = await pool_1.default.query(`SELECT m.message_id, m.created_at, m.body, m.user_id,
            u.username, u.avatar_url,
            m.voice_url, m.voice_duration_ms, m.image_url
     FROM messages m JOIN users u ON u.user_id = m.user_id
     WHERE m.${col} = $1
     ORDER BY m.created_at ASC
     LIMIT 100`, [val]);
    return res.json(rows);
}));
router.post('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const { matchId, clanId, toUserId, body, voiceBase64, voiceMime, voiceDurationMs, imageBase64, imageMime } = req.body ?? {};
    // Trim text; cap at 2000 chars. For voice/image messages the body becomes
    // the push-notification preview; text-only messages must have non-empty body.
    const text = typeof body === 'string' ? body.trim().slice(0, 2000) : '';
    // Voice clip — optional. When present, decode to disk before the INSERT
    // so we have a URL to store. We unlink the file on any failure below so
    // a failed message doesn't leak audio on disk.
    let voice = null;
    if (typeof voiceBase64 === 'string' && voiceBase64.length > 0) {
        const result = persistVoiceClip(voiceBase64, voiceMime ?? 'audio/m4a', Number(voiceDurationMs) || 0);
        if ('error' in result)
            return res.status(400).json({ error: result.error });
        voice = result;
    }
    // Image attachment — optional, same write-before-INSERT discipline.
    let image = null;
    if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
        const result = persistChatImage(imageBase64, imageMime ?? 'image/jpeg');
        if ('error' in result) {
            if (voice)
                unlinkVoiceClip(voice.url);
            return res.status(400).json({ error: result.error });
        }
        image = result;
    }
    // Helper closures so the orphan-cleanup is centralised — both the early
    // 4xx returns AND a thrown error in the INSERT block unlink the files.
    const onFail = () => {
        if (voice)
            unlinkVoiceClip(voice.url);
        if (image)
            unlinkChatImage(image.url);
    };
    // Text, voice, OR image must be present.
    if (!text && !voice && !image) {
        onFail();
        return res.status(400).json({ error: 'body, voice, or image required' });
    }
    // Default body — drives push-notification preview + the conversations
    // list "last_message". Voice wins the icon if both somehow present.
    const effectiveBody = text || (voice ? '🎤 Voice message' : '📷 Photo');
    if (toUserId) {
        if (toUserId === req.userId) {
            onFail();
            return res.status(400).json({ error: 'Cannot DM yourself' });
        }
        // Gate DMs to friends only — keeps random users from spamming.
        if (!(await areFriends(req.userId, toUserId))) {
            onFail();
            return res.status(403).json({ error: 'You can only DM friends' });
        }
        let rows;
        try {
            ({ rows } = await pool_1.default.query(`INSERT INTO direct_messages (from_user_id, to_user_id, body, voice_url, voice_duration_ms, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id,
                   voice_url, voice_duration_ms, image_url`, [req.userId, toUserId, effectiveBody, voice?.url ?? null, voice?.durationMs ?? null, image?.url ?? null]));
        }
        catch (err) {
            onFail();
            throw err;
        }
        const msg = rows[0];
        const { rows: senderRows } = await pool_1.default.query('SELECT username FROM users WHERE user_id = $1', [req.userId]);
        const senderName = senderRows[0]?.username ?? 'Someone';
        const { rows: recipRows } = await pool_1.default.query('SELECT push_token FROM users WHERE user_id = $1', [toUserId]);
        if (recipRows[0]?.push_token) {
            await (0, notify_1.sendPush)([recipRows[0].push_token], senderName, effectiveBody, 
            // fromName lets the tap handler open the DM thread with the
            // correct header title immediately (instead of "Direct Message").
            { type: 'dm', fromUserId: req.userId, fromName: senderName });
        }
        return res.status(201).json({ ...msg, username: senderName });
    }
    if (!matchId && !clanId) {
        onFail();
        return res.status(400).json({ error: 'matchId, clanId, or toUserId required' });
    }
    // Sender must actually be a participant of the match / clan
    if (!(await memberOfChat(req.userId, matchId, clanId))) {
        onFail();
        return res.status(403).json({ error: 'Not a member of this chat' });
    }
    const col = matchId ? 'match_id' : 'clan_id';
    const val = matchId ?? clanId;
    let rows;
    try {
        ({ rows } = await pool_1.default.query(`INSERT INTO messages (${col}, user_id, body, voice_url, voice_duration_ms, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING message_id, created_at, body, user_id, voice_url, voice_duration_ms, image_url`, [val, req.userId, effectiveBody, voice?.url ?? null, voice?.durationMs ?? null, image?.url ?? null]));
    }
    catch (err) {
        onFail();
        throw err;
    }
    const msg = rows[0];
    const { rows: senderRows } = await pool_1.default.query(`SELECT username FROM users WHERE user_id = $1`, [req.userId]);
    const senderName = senderRows[0]?.username ?? 'Someone';
    let tokenRows = [];
    // Room name for the push title — gives the recipient context ("which
    // team is this?") instead of a bare sender name. Falls back to a
    // generic label if the lookup misses.
    let roomName = '';
    if (matchId) {
        const r = await pool_1.default.query(`SELECT u.push_token FROM match_players mp
       JOIN users u ON u.user_id = mp.user_id
       WHERE mp.match_id = $1 AND mp.user_id != $2 AND u.push_token IS NOT NULL`, [matchId, req.userId]);
        tokenRows = r.rows;
        const { rows: mr } = await pool_1.default.query(`SELECT name, match_type FROM matches WHERE match_id = $1`, [matchId]);
        roomName = mr[0]?.name || `${mr[0]?.match_type ?? 'Match'} chat`;
    }
    else {
        const r = await pool_1.default.query(`SELECT u.push_token FROM clan_members cm
       JOIN users u ON u.user_id = cm.user_id
       WHERE cm.clan_id = $1 AND cm.user_id != $2 AND u.push_token IS NOT NULL`, [clanId, req.userId]);
        tokenRows = r.rows;
        const { rows: cr } = await pool_1.default.query(`SELECT name FROM clans WHERE clan_id = $1`, [clanId]);
        roomName = cr[0]?.name || 'Team chat';
    }
    // Title shows the room ("Thunder Cats"), body shows "Alice: <message>"
    // so the recipient sees who said what AND where, the standard
    // group-chat notification shape.
    await (0, notify_1.sendPush)(tokenRows.map((r) => r.push_token), roomName, `${senderName}: ${effectiveBody}`, matchId
        ? { type: 'chat', matchId, fromName: senderName }
        : { type: 'clan_chat', clanId, fromName: senderName, roomName });
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
router.post('/report', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
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
        const { rows } = await pool_1.default.query(`SELECT m.match_id, m.clan_id FROM messages m WHERE m.message_id = $1`, [messageId]);
        if (!rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const ok = await memberOfChat(req.userId, rows[0].match_id ?? undefined, rows[0].clan_id ?? undefined);
        if (!ok)
            return res.status(403).json({ error: 'Not a member of this chat' });
    }
    else {
        const { rows } = await pool_1.default.query(`SELECT from_user_id, to_user_id FROM direct_messages WHERE dm_id = $1`, [messageId]);
        if (!rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const p = rows[0];
        if (p.from_user_id !== req.userId && p.to_user_id !== req.userId) {
            return res.status(403).json({ error: 'Not a participant of this DM' });
        }
    }
    await pool_1.default.query(`INSERT INTO message_reports (kind, message_id, reporter_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, message_id, reporter_id) DO NOTHING`, [kind, messageId, req.userId, safeReason]);
    return res.status(201).json({ success: true });
}));
exports.default = router;
