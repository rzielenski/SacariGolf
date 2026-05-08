import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const CLAN_AVATARS_DIR = path.join(UPLOADS_DIR, 'clan-avatars');
if (!fs.existsSync(CLAN_AVATARS_DIR)) fs.mkdirSync(CLAN_AVATARS_DIR, { recursive: true });

const router = Router();

router.get('/', requireAuth, wrap(async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.clan_id, c.name, c.clan_mode, c.elo, c.total_matches, c.total_wins, c.is_public,
            COUNT(cm.user_id)::int AS member_count, c.max_players
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.is_public = true GROUP BY c.clan_id ORDER BY c.elo DESC LIMIT 50`
  );
  return res.json(rows);
}));

router.get('/mine', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.clan_id, c.name, c.clan_mode, c.elo, c.total_matches, c.total_wins,
            cm.role, c.max_players, COUNT(cm2.user_id)::int AS member_count
     FROM clans c
     JOIN clan_members cm ON cm.clan_id = c.clan_id AND cm.user_id = $1
     LEFT JOIN clan_members cm2 ON cm2.clan_id = c.clan_id
     WHERE cm.user_id = $1
     GROUP BY c.clan_id, cm.role`,
    [req.userId]
  );
  return res.json(rows);
}));

// GET /clans/invites — my pending clan invites (must be before /:id)
router.get('/invites', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT ci.invite_id, ci.clan_id, ci.created_at,
            u.username AS from_username,
            c.name AS clan_name, c.clan_mode, c.elo AS clan_elo, c.max_players,
            COUNT(cm.user_id)::int AS member_count
     FROM clan_invites ci
     JOIN users u ON u.user_id = ci.from_user_id
     JOIN clans c ON c.clan_id = ci.clan_id
     LEFT JOIN clan_members cm ON cm.clan_id = ci.clan_id
     WHERE ci.to_user_id = $1
       AND ci.status = 'pending'
       AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
     GROUP BY ci.invite_id, u.username, c.clan_id
     ORDER BY ci.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

// POST /clans/invites/:inviteId/accept (must be before /:id)
router.post('/invites/:inviteId/accept', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Atomic accept: only one caller flips the status. If 0 rows, invite gone/expired/already used.
    const { rows } = await client.query(
      `UPDATE clan_invites SET status = 'accepted'
       WHERE invite_id = $1 AND to_user_id = $2 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING clan_id`,
      [req.params.inviteId, req.userId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or expired' });
    }
    const { clan_id: clanId } = rows[0];

    // Lock the clan row + count members so concurrent joins/accepts can't oversize it.
    const { rows: clanRows } = await client.query(
      `SELECT c.max_players,
              (SELECT COUNT(*)::int FROM clan_members WHERE clan_id = c.clan_id) AS member_count
       FROM clans c
       WHERE c.clan_id = $1
       FOR UPDATE`,
      [clanId]
    );
    if (!clanRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Team not found' });
    }
    if (clanRows[0].member_count >= clanRows[0].max_players) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Team is now full' });
    }
    await client.query(
      `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [clanId, req.userId]
    );
    await client.query('COMMIT');
    return res.json({ clanId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// POST /clans/invites/:inviteId/decline (must be before /:id)
router.post('/invites/:inviteId/decline', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE clan_invites SET status = 'declined' WHERE invite_id = $1 AND to_user_id = $2`,
    [req.params.inviteId, req.userId]
  );
  return res.json({ success: true });
}));

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { name, clanMode } = req.body ?? {};
  if (!name || !clanMode) return res.status(400).json({ error: 'name and clanMode required' });
  const trimmedName = String(name).trim().slice(0, 60);
  if (trimmedName.length < 2) {
    return res.status(400).json({ error: 'Team name must be 2–60 characters' });
  }
  if (clanMode !== 'duo' && clanMode !== 'squad') {
    return res.status(400).json({ error: 'clanMode must be duo or squad' });
  }
  const maxPlayers = clanMode === 'duo' ? 2 : 4;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clans (name, clan_mode, max_players) VALUES ($1, $2, $3) RETURNING *`,
      [trimmedName, clanMode, maxPlayers]
    );
    const clan = rows[0];
    await client.query(
      `INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'leader')`,
      [clan.clan_id, req.userId]
    );
    await client.query('COMMIT');
    return res.status(201).json(clan);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: clanRows } = await pool.query(
    `SELECT c.*, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [req.params.id]
  );
  if (!clanRows.length) return res.status(404).json({ error: 'Team not found' });

  const { rows: members } = await pool.query(
    `SELECT cm.user_id, cm.role, cm.joined_at,
            u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url
     FROM clan_members cm JOIN users u ON u.user_id = cm.user_id
     WHERE cm.clan_id = $1 ORDER BY cm.role = 'leader' DESC, u.elo DESC`,
    [req.params.id]
  );

  return res.json({ ...clanRows[0], members });
}));

router.patch('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { name, isPublic, theme } = req.body ?? {};
  const { rows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length || rows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the team leader can do this' });
  }
  const updates: string[] = [];
  const vals: any[] = [];
  if (name !== undefined) {
    const t = String(name).trim().slice(0, 60);
    if (t.length < 2) return res.status(400).json({ error: 'Team name must be 2–60 characters' });
    vals.push(t); updates.push(`name = $${vals.length}`);
  }
  if (isPublic !== undefined) { vals.push(!!isPublic); updates.push(`is_public = $${vals.length}`); }

  // Theme song update — accepts an iTunes track payload from the mobile
  // search modal, or `null` to clear. URLs are validated for https + Apple
  // CDN host so a hostile client can't make us proxy arbitrary audio.
  if (theme !== undefined) {
    if (theme === null) {
      updates.push(`theme_track_id = NULL`);
      updates.push(`theme_track_title = NULL`);
      updates.push(`theme_track_artist = NULL`);
      updates.push(`theme_track_artwork = NULL`);
      updates.push(`theme_track_preview = NULL`);
    } else if (typeof theme === 'object') {
      const { trackId, title, artist, artworkUrl, previewUrl } = theme;
      if (typeof trackId !== 'string' || typeof title !== 'string'
       || typeof artist !== 'string' || typeof previewUrl !== 'string') {
        return res.status(400).json({ error: 'Invalid theme payload' });
      }
      // Sanity-check the URLs come from Apple's CDN domain.
      const okHost = (u: string) =>
        /^https:\/\/[^\/]*\.mzstatic\.com\//.test(u)
        || /^https:\/\/[^\/]*\.itunes\.apple\.com\//.test(u);
      if (!okHost(previewUrl) || (artworkUrl && !okHost(artworkUrl))) {
        return res.status(400).json({ error: 'Theme URLs must come from Apple\'s CDN' });
      }
      vals.push(trackId.slice(0, 64));     updates.push(`theme_track_id = $${vals.length}`);
      vals.push(title.slice(0, 200));      updates.push(`theme_track_title = $${vals.length}`);
      vals.push(artist.slice(0, 200));     updates.push(`theme_track_artist = $${vals.length}`);
      vals.push((artworkUrl ?? '').slice(0, 500) || null);
      updates.push(`theme_track_artwork = $${vals.length}`);
      vals.push(previewUrl.slice(0, 500)); updates.push(`theme_track_preview = $${vals.length}`);
    } else {
      return res.status(400).json({ error: 'theme must be an object or null' });
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const { rows: updated } = await pool.query(
    `UPDATE clans SET ${updates.join(', ')} WHERE clan_id = $${vals.length} RETURNING *`,
    vals
  );
  return res.json(updated[0]);
}));

/** Leader-only avatar upload. Mirrors the user-avatar upload pattern. */
router.post('/:id/avatar', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: roleRows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!roleRows.length || roleRows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the team leader can change the team avatar' });
  }
  const { imageBase64, mimeType } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg'
    : null;
  if (!ext) return res.status(400).json({ error: 'Only PNG and JPEG avatars are allowed' });
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'Invalid image data' });
  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Avatar must be 2 MB or smaller' });
  }
  const filename = `clan_${req.params.id}.${ext}`;
  const filepath = path.join(CLAN_AVATARS_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  const avatarUrl = `/uploads/clan-avatars/${filename}`;
  await pool.query(`UPDATE clans SET avatar_url = $1 WHERE clan_id = $2`, [avatarUrl, req.params.id]);
  return res.json({ avatar_url: avatarUrl });
}));

router.delete('/:id/members/:userId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const isSelf = req.params.userId === req.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Permissions: leader can kick anyone (except themselves via this path);
    // a member can leave themselves.
    if (!isSelf) {
      const { rows } = await client.query(
        `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [req.params.id, req.userId]
      );
      if (!rows.length || rows[0].role !== 'leader') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the team leader can kick members' });
      }
      const { rows: target } = await client.query(
        `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [req.params.id, req.params.userId]
      );
      if (target[0]?.role === 'leader') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot kick the leader' });
      }
    }

    // Was the departing user the leader? If so, auto-promote the longest-
    // tenured remaining member (oldest joined_at). If they're the last
    // member, delete the empty clan to keep things tidy.
    const { rows: leavingRoleRows } = await client.query(
      `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.params.userId]
    );
    const wasLeader = leavingRoleRows[0]?.role === 'leader';

    await client.query(
      `DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );

    if (wasLeader) {
      const { rows: heir } = await client.query(
        `SELECT user_id FROM clan_members
         WHERE clan_id = $1
         ORDER BY joined_at ASC
         LIMIT 1`,
        [req.params.id]
      );
      if (heir.length) {
        await client.query(
          `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2`,
          [req.params.id, heir[0].user_id]
        );
      } else {
        // No members left — delete the orphan clan rather than leaving a
        // zombie row. clan_members rows already gone via CASCADE.
        await client.query(`DELETE FROM clans WHERE clan_id = $1`, [req.params.id]);
      }
    }

    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/transfer', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { toUserId } = req.body ?? {};
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (toUserId === req.userId) return res.status(400).json({ error: 'You are already the leader' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock both rows so a concurrent kick/leave can't sneak in between checks
    const { rows: meRows } = await client.query(
      `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId]
    );
    if (!meRows.length || meRows[0].role !== 'leader') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the team leader can transfer leadership' });
    }
    // The target must already be a member of this clan
    const { rows: targetRows } = await client.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, toUserId]
    );
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'New leader must be a team member' });
    }
    await client.query(
      `UPDATE clan_members SET role = 'member' WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    await client.query(
      `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2`,
      [req.params.id, toUserId]
    );
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/join', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the clan row so concurrent joins can't both bypass the cap.
    const { rows: clanRows } = await client.query(
      `SELECT c.clan_id, c.max_players, c.is_public,
              (SELECT COUNT(*)::int FROM clan_members WHERE clan_id = c.clan_id) AS member_count
       FROM clans c
       WHERE c.clan_id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    if (!clanRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Team not found' }); }
    if (!clanRows[0].is_public) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This team is invite-only' });
    }
    if (clanRows[0].member_count >= clanRows[0].max_players) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Team is full' });
    }
    await client.query(
      `INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.userId]
    );
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/invite', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { toUserId } = req.body ?? {};
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (toUserId === req.userId) return res.status(400).json({ error: 'Cannot invite yourself' });

  const { rows: roleRows } = await pool.query(
    `SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!roleRows.length || roleRows[0].role !== 'leader') {
    return res.status(403).json({ error: 'Only the team leader can invite members' });
  }
  // Confirm the target exists (avoids silent failures + UX surprise)
  const { rows: targetRows } = await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [toUserId]);
  if (!targetRows.length) return res.status(404).json({ error: 'User not found' });
  // Don't invite someone who is already in the clan
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [req.params.id, toUserId]
  );
  if (existing.length) return res.status(409).json({ error: 'User is already in this team' });

  const { rows: clanRows } = await pool.query(
    `SELECT c.max_players, COUNT(cm.user_id)::int AS member_count
     FROM clans c LEFT JOIN clan_members cm ON cm.clan_id = c.clan_id
     WHERE c.clan_id = $1 GROUP BY c.clan_id`,
    [req.params.id]
  );
  if (!clanRows.length) return res.status(404).json({ error: 'Team not found' });
  if (clanRows[0].member_count >= clanRows[0].max_players) {
    return res.status(409).json({ error: 'Team is full' });
  }

  await pool.query(
    `INSERT INTO clan_invites (clan_id, from_user_id, to_user_id)
     VALUES ($1, $2, $3) ON CONFLICT (clan_id, to_user_id) DO NOTHING`,
    [req.params.id, req.userId, toUserId]
  );

  const { rows } = await pool.query(
    `SELECT u.push_token, u2.username AS from_name, c.name AS clan_name
     FROM users u, users u2, clans c
     WHERE u.user_id = $1 AND u2.user_id = $2 AND c.clan_id = $3`,
    [toUserId, req.userId, req.params.id]
  );
  if (rows[0]?.push_token) {
    await sendPush(
      [rows[0].push_token],
      'Team Invite',
      `${rows[0].from_name} invited you to join ${rows[0].clan_name}!`,
      { type: 'clanInvite', clanId: req.params.id }
    );
  }
  return res.status(201).json({ success: true });
}));

export default router;
