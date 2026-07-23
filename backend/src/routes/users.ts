import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';
import { perUserRateLimit } from '../utils/rateLimit';
import {
  Shot, Lie, SGCategory, sgForShot, categorize, expectedPutts,
  GREEN_RADIUS_YDS, TYPICAL_AMATEUR_LOSS_SPLIT,
} from '../utils/sg';
import { OPEN_BETA_PREMIUM } from '../utils/openBeta';
import { equippedVisualSql } from '../utils/cosmeticSql';
import { roundDifferential, whsHandicapIndex } from '../utils/handicap';
import { sanitizeClubCode } from '../utils/clubs';
import { computeWinStreaks, BOUNTY_THRESHOLD, attachBounties } from '../utils/streaks';
import { persistVoiceClip } from './messages';

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const router = Router();

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.email, u.elo, u.total_matches, u.total_wins, u.total_ties,
            u.avatar_url, u.created_at,
            u.handicap_index, u.bio, u.home_course_id, u.email_verified,
            u.is_premium, u.premium_since, u.premium_until, u.premium_plan, u.is_owner,
            u.theme_track_id, u.theme_track_title, u.theme_track_artist,
            u.theme_track_artwork, u.theme_track_preview, u.theme_song_max_volume,
            u.clubs_in_bag, u.censor_offensive_language, u.share_to_twitter, u.partial_swing_mode,
            u.equipped_border, u.equipped_background, u.equipped_username,
            u.equipped_ball_trail, u.equipped_fx, u.equipped_title,
            (SELECT name FROM titles WHERE title_id = u.equipped_title) AS equipped_title_name,
            (SELECT jsonb_build_object(
              'border',     (SELECT visual_data FROM cosmetics WHERE cosmetic_id = u.equipped_border),
              'background', (SELECT visual_data FROM cosmetics WHERE cosmetic_id = u.equipped_background),
              'username',   (SELECT visual_data FROM cosmetics WHERE cosmetic_id = u.equipped_username),
              'ball_trail', (SELECT visual_data FROM cosmetics WHERE cosmetic_id = u.equipped_ball_trail),
              'fx',         (SELECT visual_data FROM cosmetics WHERE cosmetic_id = u.equipped_fx)
            )) AS equipped_visual,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state,
            c.latitude AS home_course_lat, c.longitude AS home_course_lng
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const row = rows[0];
  // is_creator is a newer, feature-gated column (creator leagues). Read it in
  // its OWN guarded query rather than the main SELECT above: if a deploy ever
  // races ahead of the column's migration, the AUTH endpoint must still return
  // 200, not 500 every user out of the app (which blanks the home/profile/finds
  // tabs that gate on a loaded user). Defaults to false; owners are forced true
  // just below regardless.
  row.is_creator = false;
  try {
    const cr = await pool.query('SELECT is_creator FROM users WHERE user_id = $1', [req.userId]);
    row.is_creator = cr.rows[0]?.is_creator === true;
  } catch { /* column not present on this deploy yet — leave false (owner check still applies) */ }
  // Open-beta override — see backend/src/utils/openBeta.ts. The DB column is
  // left untouched (so a real future purchase / lifetime code is preserved),
  // but the API response reports premium = true so the client gates open.
  if (OPEN_BETA_PREMIUM) {
    row.is_premium = true;
    row.premium_plan = row.premium_plan ?? 'open_beta';
    row.premium_until = null; // null = lifetime / no expiry for client purposes
  }
  // Owners are always premium (it's one of the unlockables the owner group
  // gets) and the app reads is_owner to surface the @everyone broadcast UI.
  if (row.is_owner) {
    row.is_premium = true;
    row.premium_until = null;
    row.is_creator = true; // owners can host creator leagues without a separate flag
  }
  return res.json(row);
}));

router.patch('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex, username, bio, homeCourseId, theme, clubsInBag, censorOffensiveLanguage, shareToTwitter, themeSongMaxVolume, partialSwingMode } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  // Opt-in for the automated @Sacari Twitter/X daily digest. Booleanish; the
  // DB defaults to FALSE so the only way a player's name/score gets tweeted is
  // by explicitly turning this on.
  if (shareToTwitter !== undefined) {
    values.push(!!shareToTwitter);
    updates.push(`share_to_twitter = $${values.length}`);
  }

  // "Force theme songs to play loud" toggle. When TRUE the mobile theme
  // player sets playsInSilentModeIOS + max output volume; when FALSE it
  // respects the silent switch. iOS doesn't expose programmatic system
  // volume control to third-party apps, so this is the most we can do.
  if (themeSongMaxVolume !== undefined) {
    values.push(!!themeSongMaxVolume);
    updates.push(`theme_song_max_volume = $${values.length}`);
  }

  // Content-safety toggle. Booleanish — accepts true/false, also 0/1 from
  // older clients. Defaults to TRUE in the DB so an explicit `false` is
  // the only way the censor turns off.
  if (censorOffensiveLanguage !== undefined) {
    const flag = !!censorOffensiveLanguage;
    values.push(flag);
    updates.push(`censor_offensive_language = $${values.length}`);
  }

  // Partial-swing entry mode: how the user dials a less-than-full swing —
  // 'percentage' (75%, 80%) or 'clock' (9:00, 10:30). Anything else → percentage.
  if (partialSwingMode !== undefined) {
    const mode = partialSwingMode === 'clock' ? 'clock' : 'percentage';
    values.push(mode);
    updates.push(`partial_swing_mode = $${values.length}`);
  }

  if (pushToken !== undefined) { values.push(pushToken); updates.push(`push_token = $${values.length}`); }
  if (handicapIndex !== undefined) {
    const hi = parseFloat(handicapIndex);
    // USGA WHS allows "plus handicaps" — negative values for players who
    // average below par (e.g. -2.4 is read as "plus 2.4"). The UI formats
    // negatives with a leading `+` on the way out; here we just need to
    // accept them. Cap at -10 / 54 — beyond that is almost certainly a typo.
    if (isNaN(hi) || hi < -10 || hi > 54) return res.status(400).json({ error: 'handicapIndex must be between -10 and 54' });
    values.push(hi); updates.push(`handicap_index = $${values.length}`);
  }
  if (bio !== undefined) {
    const trimmed = (bio ?? '').toString().slice(0, 280);
    values.push(trimmed || null); updates.push(`bio = $${values.length}`);
  }
  if (homeCourseId !== undefined) {
    values.push(homeCourseId || null); updates.push(`home_course_id = $${values.length}`);
  }
  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, or underscores' });
    }
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM users WHERE username = $1 AND user_id != $2`,
      [username, req.userId]
    );
    if (existing.length) return res.status(409).json({ error: 'Username already taken' });
    values.push(username); updates.push(`username = $${values.length}`);
  }

  // Theme song (iTunes preview). Same payload shape as the team theme PATCH;
  // null clears it. Apple-CDN host check matches the team route.
  if (theme !== undefined) {
    if (theme === null) {
      updates.push(`theme_track_id = NULL`);
      updates.push(`theme_track_title = NULL`);
      updates.push(`theme_track_artist = NULL`);
      updates.push(`theme_track_artwork = NULL`);
      updates.push(`theme_track_preview = NULL`);
    } else if (typeof theme === 'object') {
      const { trackId, title, artist, artworkUrl, previewUrl } = theme as any;
      if (typeof trackId !== 'string' || typeof title !== 'string'
       || typeof artist !== 'string' || typeof previewUrl !== 'string') {
        return res.status(400).json({ error: 'Invalid theme payload' });
      }
      const okHost = (u: string) =>
        /^https:\/\/[^\/]*\.mzstatic\.com\//.test(u)
        || /^https:\/\/[^\/]*\.itunes\.apple\.com\//.test(u);
      if (!okHost(previewUrl) || (artworkUrl && !okHost(artworkUrl))) {
        return res.status(400).json({ error: "Theme URLs must come from Apple's CDN" });
      }
      values.push(trackId.slice(0, 64));     updates.push(`theme_track_id = $${values.length}`);
      values.push(title.slice(0, 200));      updates.push(`theme_track_title = $${values.length}`);
      values.push(artist.slice(0, 200));     updates.push(`theme_track_artist = $${values.length}`);
      values.push((artworkUrl ?? '').slice(0, 500) || null);
      updates.push(`theme_track_artwork = $${values.length}`);
      values.push(previewUrl.slice(0, 500)); updates.push(`theme_track_preview = $${values.length}`);
    } else {
      return res.status(400).json({ error: 'theme must be an object or null' });
    }
  }

  // Clubs-in-bag — ordered array of `{ code, label? }` entries. Each `code` is
  // sanitized to a safe slug so players can carry ANY club, not just the preset
  // catalog (a custom club gets its own stats category); `label` is optional
  // free-form display text (e.g. "TaylorMade Stealth" or "Vokey 56°") up to 30
  // chars. Order is preserved. Null clears the override (all clubs eligible).
  //
  // Backwards-compatible: also accepts the legacy `string[]` form (just
  // codes) from older clients — auto-converted to `{code}` entries server-side.
  if (clubsInBag !== undefined) {
    if (clubsInBag === null) {
      updates.push(`clubs_in_bag = NULL`);
    } else if (Array.isArray(clubsInBag)) {
      const cleaned: { code: string; label?: string }[] = [];
      for (const raw of clubsInBag) {
        let code: string | null = null;
        let label: string | undefined;
        if (typeof raw === 'string') {
          code = raw.toLowerCase();
        } else if (raw && typeof raw === 'object' && typeof raw.code === 'string') {
          code = raw.code.toLowerCase();
          if (typeof raw.label === 'string') {
            const trimmed = raw.label.trim().slice(0, 30);
            if (trimmed) label = trimmed;
          }
        }
        const safe = sanitizeClubCode(code);
        if (!safe) continue;
        cleaned.push(label ? { code: safe, label } : { code: safe });
      }
      // USGA cap is 14 clubs — enforce so a malicious client can't store
      // a 1000-element array. Saving fewer than 14 is fine.
      if (cleaned.length > 14) {
        return res.status(400).json({ error: 'Max 14 clubs in the bag (USGA limit)' });
      }
      values.push(JSON.stringify(cleaned));
      updates.push(`clubs_in_bag = $${values.length}::jsonb`);
    } else {
      return res.status(400).json({ error: 'clubsInBag must be an array of {code,label?} entries or null' });
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  await pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${values.length}`,
    values
  );
  return res.json({ success: true });
}));

router.get('/search', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const raw = String(req.query.q ?? '').trim();
  if (!raw) return res.json([]);
  // Cap query length and strip pattern wildcards so a long/% input can't
  // trigger an expensive scan.
  const q = raw.slice(0, 50).replace(/[%_]/g, '');
  if (!q) return res.json([]);
  // Apple Guideline 1.2: blocked users must be invisible to the blocker
  // across all UGC surfaces. Search is the primary discovery path so this
  // filter matters most here.
  const { rows } = await pool.query(
    `SELECT user_id, username, elo, avatar_url FROM users
     WHERE username ILIKE $1
       AND user_id != $2
       AND user_id NOT IN (
         SELECT blocked_id FROM blocked_users WHERE blocker_id = $2
       )
     LIMIT 20`,
    [`${q}%`, req.userId]
  );
  return res.json(rows);
}));

/**
 * Theme song voice upload. Records a personal voice memo (recorded
 * client-side via the existing useVoiceRecorder hook) and points the
 * caller's theme song at the uploaded clip. Same file storage as DM voice
 * messages — reuses persistVoiceClip from routes/messages.ts so the size
 * cap (2 MB) + mime whitelist stay in one place.
 *
 *   body: { voiceBase64, voiceMime, voiceDurationMs }
 *   → { success: true, previewUrl }
 *
 * The voice-as-theme is encoded with theme_track_id = '__voice__' so the
 * mobile player can branch on it (e.g. label "Your voice memo" instead of
 * an artist line). Title falls back to the caller's username; artwork
 * stays null since there's nothing meaningful to render.
 */
router.post('/me/theme-voice', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { voiceBase64, voiceMime, voiceDurationMs } = req.body ?? {};
  const result = persistVoiceClip(
    String(voiceBase64 ?? ''),
    String(voiceMime ?? 'audio/m4a'),
    Number(voiceDurationMs) || 0,
  );
  if ('error' in result) return res.status(400).json({ error: result.error });

  const { rows: nameRows } = await pool.query(
    `SELECT username FROM users WHERE user_id = $1`, [req.userId]
  );
  const username = nameRows[0]?.username ?? 'You';

  await pool.query(
    `UPDATE users
        SET theme_track_id      = '__voice__',
            theme_track_title   = 'Your voice memo',
            theme_track_artist  = $2,
            theme_track_artwork = NULL,
            theme_track_preview = $3
      WHERE user_id = $1`,
    [req.userId, username, result.url]
  );
  return res.json({ success: true, previewUrl: result.url, durationMs: result.durationMs });
}));

// Friends — must be before /:id
router.get('/me/friends', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.user_id) u.user_id, u.username, u.elo, u.avatar_url, f.status,
            ${equippedVisualSql('u')} AS equipped_visual
     FROM friends f
     JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
     ORDER BY u.user_id`,
    [req.userId]
  );
  return res.json(rows);
}));

router.get('/me/friend-requests', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.avatar_url, f.created_at
     FROM friends f JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'`,
    [req.userId]
  );
  return res.json(rows);
}));

router.post('/me/friends/request', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body ?? {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  if (friendId === req.userId) return res.status(400).json({ error: 'Cannot friend yourself' });
  // Verify target user exists (returns a friendlier error than a silent INSERT)
  const { rows: targetRows } = await pool.query(
    `SELECT 1 FROM users WHERE user_id = $1`, [friendId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'User not found' });

  // Check existing friendship/request rows in EITHER direction.
  // Friendship is stored as a single directional row (sender, recipient,
  // status). After accept, the row's status flips to 'accepted'. So we
  // need to look for any row between this pair regardless of who sent it.
  const { rows: existing } = await pool.query(
    `SELECT user_id, friend_id, status FROM friends
      WHERE (user_id = $1 AND friend_id = $2)
         OR (user_id = $2 AND friend_id = $1)`,
    [req.userId, friendId]
  );
  if (existing.length > 0) {
    const accepted = existing.find((r) => r.status === 'accepted');
    if (accepted) {
      return res.status(409).json({ error: 'You are already friends with this user' });
    }
    const incoming = existing.find((r) =>
      r.status === 'pending' && r.user_id === friendId && r.friend_id === req.userId
    );
    if (incoming) {
      // The OTHER person already sent ME a request — point the user at
      // accepting that instead of creating a new one in the opposite direction.
      return res.status(409).json({
        error: 'This user has already sent you a friend request — accept theirs instead.',
        pendingFromThem: true,
      });
    }
    const outgoing = existing.find((r) =>
      r.status === 'pending' && r.user_id === req.userId && r.friend_id === friendId
    );
    if (outgoing) {
      // I already have a pending request to them. Don't insert (it's a
      // no-op via the unique constraint) AND don't re-send the push so
      // the recipient isn't spammed every time the sender taps "+ Add".
      return res.json({ success: true, alreadyRequested: true });
    }
  }

  // Fresh request — insert + send the push notification once.
  await pool.query(
    `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')
     ON CONFLICT DO NOTHING`,
    [req.userId, friendId]
  );

  const { rows } = await pool.query(
    `SELECT u.push_token, u2.username AS from_name
     FROM users u, users u2
     WHERE u.user_id = $1 AND u2.user_id = $2`,
    [friendId, req.userId]
  );
  if (rows[0]?.push_token) {
    await sendPush(
      [rows[0].push_token],
      'Friend Request',
      `${rows[0].from_name} sent you a friend request!`,
      { type: 'friendRequest' }
    );
  }

  return res.json({ success: true });
}));

router.post('/me/friends/accept', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { friendId } = req.body ?? {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  // Use RETURNING + rowCount so we surface a real 404 instead of silently
  // succeeding on a non-existent / already-accepted / declined request.
  const { rows } = await pool.query(
    `UPDATE friends SET status = 'accepted'
     WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'
     RETURNING user_id`,
    [friendId, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No pending request from that user' });
  return res.json({ success: true });
}));

/** Expected strokes to get down from a greenside chip. Calibrated to the book's
 *  tables: a typical greenside lie mix at 20-30 yds sits between fairway
 *  (2.40-2.52) and rough (2.59-2.70), so 2.5 is the neutral prior when all we
 *  know is "the player chipped" (typed chips carry no lie or distance).
 *  Around-green SG = this − how-close-the-chip-left-it − chips. */
const AROUND_GREEN_BASELINE = 2.5;

/**
 * Strokes-gained — the single source of truth for SG across the app. HYBRID:
 *   • Off-the-tee + Approach come from GPS-tracked shots (Mark Broadie model in
 *     utils/sg.ts) — these need shot locations + pin coords.
 *   • Putting + Around-green (chipping) come from the player's TYPED PUTT
 *     DISTANCES in hole_stats, no GPS needed. Putting telescopes to
 *     expectedPutts(firstPutt) − putt count (last typed distance is the make).
 *     Chipping is judged by how close the chip left it (the first putt); a chip
 *     with NO putt is assumed holed (chip-in).
 * Each category is a per-round figure and is null when there's no data for it
 * (so the long game stays empty until shots are tracked, while the short game
 * shows as soon as putt distances are entered). Returns null only when NOTHING
 * is available. rounds_used drives the low-sample warning.
 */
async function computeStrokesGained(userId: string): Promise<{
  sg_per_round: {
    off_tee: number | null; approach: number | null;
    around_green: number | null; putting: number | null; total: number;
  };
  shots_used: number;
  holes_used: number;
  rounds_used: number;
  /** Share of the player's total per-round LOSS by category (0-100, only
   *  categories losing strokes). The book's "where does the gap come from"
   *  decomposition — compare against TYPICAL_AMATEUR_LOSS_SPLIT. */
  sg_decomposition: Partial<Record<SGCategory, number>> | null;
  sg_biggest_leak: SGCategory | null;
  /** Broadie-style what-ifs: play category X at the tour baseline and you
   *  save `gain_per_round` strokes. Sorted biggest first. */
  sg_what_if: Array<{ category: SGCategory; gain_per_round: number }>;
  sg_three_putt: { per_round: number; sg_lost_per_round: number } | null;
  /** Per-distance-bucket SG, per round — the book's sharpest practice lens:
   *  not "approach is weak" but "approach from 150-200 is where it leaks."
   *  Approach buckets come from GPS shots (start distance), putting buckets
   *  from typed first-putt distances. Null until the source data exists. */
  sg_approach_buckets: Array<{ bucket: string; sg_per_round: number; shots: number }> | null;
  sg_putting_buckets: Array<{ bucket: string; sg_per_round: number; holes: number }> | null;
  /** Single worst bucket across both (min 5 samples so one blow-up shot
   *  can't own the headline). */
  sg_worst_bucket: { kind: 'approach' | 'putting'; bucket: string; sg_per_round: number } | null;
} | null> {
  // ── Long game (off-the-tee + approach) from GPS-tracked shots ─────────────
  const { rows } = await pool.query(
    `SELECT s.match_id, s.hole_num,
            json_agg(
              json_build_object(
                'club',  s.club,
                'lie',   s.lie,
                'start', json_build_object('lat', s.start_lat, 'lng', s.start_lng),
                'end',   json_build_object('lat', s.end_lat,   'lng', s.end_lng)
              ) ORDER BY s.shot_index
            ) AS shots,
            r.hole_scores, r.teebox_id,
            (SELECT json_agg(json_build_object('hole_num', h.hole_num, 'par', h.par,
                                                'pin_lat', h.pin_lat, 'pin_lng', h.pin_lng))
               FROM holes h WHERE h.teebox_id = r.teebox_id) AS holes
       FROM shots s
       JOIN rounds r ON r.match_id = s.match_id AND r.user_id = s.user_id
      WHERE s.user_id = $1
        AND s.match_id IS NOT NULL
      GROUP BY s.match_id, s.hole_num, r.hole_scores, r.teebox_id
      ORDER BY MAX(s.recorded_at) DESC
      LIMIT 200`,
    [userId]
  );

  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const haversineYds = (a: any, b: any): number | null => {
    if (a?.lat == null || b?.lat == null) return null;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return (2 * R * Math.asin(Math.sqrt(h))) * 1.0936;
  };
  const toSegments = (raw: any[]): { start: any; end: any; club?: string; lie?: string }[] => {
    if (!raw.length) return [];
    if (raw[0]?.start && raw[0]?.end) {
      return raw.filter((s: any) => s?.start && s?.end)
        .map((s: any) => ({ start: s.start, end: s.end, club: s.club, lie: s.lie }));
    }
    const out: { start: any; end: any; club?: string; lie?: string }[] = [];
    for (let i = 0; i < raw.length - 1; i++) {
      out.push({ start: raw[i], end: raw[i + 1], club: raw[i]?.club, lie: raw[i]?.lie });
    }
    return out;
  };

  const allShots: Shot[] = [];
  const gpsHoles = new Set<string>();
  const gpsRounds = new Set<string>();
  for (const row of rows) {
    const segments = toSegments(Array.isArray(row.shots) ? row.shots : []);
    const holes: any[] = Array.isArray(row.holes) ? row.holes : [];
    const holeMeta = holes.find((h: any) => h.hole_num === row.hole_num);
    if (!holeMeta || holeMeta.pin_lat == null || holeMeta.pin_lng == null) continue;
    if (segments.length === 0) continue;

    const par = holeMeta.par ?? 4;
    const pin = { lat: holeMeta.pin_lat, lng: holeMeta.pin_lng };
    const holed = (Array.isArray(row.hole_scores) ? row.hole_scores[row.hole_num - 1] : null) ?? null;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const startDist = haversineYds(seg.start, pin);
      const endDist0  = haversineYds(seg.end, pin);
      if (startDist == null) continue;
      const startLie: Lie = (seg.lie as Lie) ?? (i === 0 ? 'tee' : 'fairway');
      let endLie: Lie;
      let endDist: number;
      if (isLast && typeof holed === 'number' && segments.length === holed) {
        // Scorecard says the tracked shot count IS the hole score → the last
        // tracked shot went in.
        endLie = 'green'; endDist = 0;
      } else if (endDist0 != null) {
        // Where did this shot finish? The NEXT shot's tagged lie is ground
        // truth (the player told us when they tracked it) — use it before any
        // distance heuristic. Fallback: on the green iff within the app-wide
        // 12-yd green radius (the old 30-yd cutoff scored balls 25 yds out
        // "on the green", which reads the putting table at 75+ ft and skews
        // approach SG). NEVER assume holed mid-hole: a shot finishing 2 yds
        // out is a 6 ft putt (ES 1.34), not a make — the old <3yd → holed
        // shortcut overpaid every near-miss approach by a third of a stroke.
        const nextLie = (segments[i + 1]?.lie as Lie | undefined) ?? null;
        endLie = nextLie ?? (endDist0 <= GREEN_RADIUS_YDS ? 'green' : 'fairway');
        endDist = endDist0;
      } else {
        continue;
      }
      allShots.push({
        start_lie: startLie,
        start_dist_yds: Math.round(startDist),
        end_lie: endLie,
        end_dist_yds: Math.round(endDist),
        par,
        is_tee_shot: i === 0,
      });
    }
    gpsHoles.add(`${row.match_id}:${row.hole_num}`);
    gpsRounds.add(row.match_id);
  }

  // Aggregate ONLY off-tee + approach from the GPS shots. Putting / around-green
  // categorised from GPS are intentionally ignored — they come from the typed
  // putt distances below.
  // Approach SG bucketed by START distance — the book's practice lens. Buckets
  // mirror the shot-breakdown proximity card so the two read side by side.
  // (<100 covers 31-99: inside 30 is around-green by definition. Par-3 tee
  // shots land in the bucket of the hole's length, which is correct — they ARE
  // approaches in the tour model.)
  const approachBucketAgg = [
    { bucket: '<100 yd',    min: 0,   max: 100,      sum: 0, shots: 0 },
    { bucket: '100-150 yd', min: 100, max: 150,      sum: 0, shots: 0 },
    { bucket: '150-200 yd', min: 150, max: 200,      sum: 0, shots: 0 },
    { bucket: '200+ yd',    min: 200, max: Infinity, sum: 0, shots: 0 },
  ];
  let offTeeSum = 0, approachSum = 0, offTeeShots = 0, approachShots = 0;
  for (const shot of allShots) {
    const sg = sgForShot(shot);
    if (!Number.isFinite(sg)) continue;
    const cat = categorize(shot);
    if (cat === 'off_tee') { offTeeSum += sg; offTeeShots += 1; }
    else if (cat === 'approach') {
      approachSum += sg; approachShots += 1;
      const b = approachBucketAgg.find((x) => shot.start_dist_yds >= x.min && shot.start_dist_yds < x.max);
      if (b) { b.sum += sg; b.shots += 1; }
    }
  }

  // ── Short game (putting + around-green) from typed putt distances ─────────
  const { rows: statRows } = await pool.query(
    `SELECT r.match_id, r.hole_stats
       FROM rounds r JOIN matches m ON m.match_id = r.match_id
      WHERE r.user_id = $1 AND m.is_practice = false
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [userId]
  );
  let puttSG = 0, chipSG = 0;
  // Book ch. 5: for most amateurs the single biggest PUTTING leak is the
  // three-putt (lag speed from 20+ ft), not missed short ones. Count them and
  // price them so the app can say "3-putts cost you N strokes a round."
  let threePuttHoles = 0, threePuttLost = 0;
  // Putting SG bucketed by FIRST-putt distance: makeable range vs mid vs lag.
  // The book's split — most amateur putting loss lives in the lag bucket.
  const puttBucketAgg = [
    { bucket: 'inside 10 ft', min: 0,  max: 10,       sum: 0, holes: 0 },
    { bucket: '10-25 ft',     min: 10, max: 25,       sum: 0, holes: 0 },
    { bucket: '25+ ft',       min: 25, max: Infinity, sum: 0, holes: 0 },
  ];
  const puttRounds = new Set<string>();
  const chipRounds = new Set<string>();
  for (const r of statRows) {
    const stats: any[] = Array.isArray(r.hole_stats) ? r.hole_stats : [];
    for (const h of stats) {
      if (!h) continue;
      const puttD: number[] = Array.isArray(h.puttDistances)
        ? h.puttDistances.filter((d: any) => typeof d === 'number' && d >= 0)
        : [];
      const chips = typeof h.chips === 'number' ? h.chips : 0;
      const puttCount = puttD.length;
      // The Hole Detail sheet pads undialed putt slots with a literal 0, so a 0
      // means "distance not entered", not a 0-ft putt. The first NON-zero entry
      // is the real starting distance; 0 here means nothing was dialed.
      const firstPuttFt = puttD.find((d) => d > 0) ?? 0;
      const hasDialedPutt = firstPuttFt > 0;
      // Putting SG telescopes to expectedPutts(firstPutt) − putt count (the last
      // typed distance is the made putt, so the count IS puttD.length). Skip a
      // hole where putts were recorded but no distance was dialed — undefined.
      if (puttCount > 0 && hasDialedPutt) {
        const holeSG = expectedPutts(firstPuttFt) - puttCount;
        puttSG += holeSG;
        puttRounds.add(r.match_id);
        const pb = puttBucketAgg.find((x) => firstPuttFt >= x.min && firstPuttFt < x.max);
        if (pb) { pb.sum += holeSG; pb.holes += 1; }
        if (puttCount >= 3) {
          threePuttHoles += 1;
          // Strokes lost vs the tour baseline ON the 3-putt holes specifically.
          threePuttLost += puttCount - expectedPutts(firstPuttFt);
        }
      }
      // Around-green: judged by how close the chip left it (the first putt's
      // distance). A chip with NO putt is assumed holed (chip-in → leave = 0).
      // A chip whose putts have no dialed distance is left out (can't gauge it).
      if (chips >= 1) {
        if (puttCount === 0) {
          chipSG += AROUND_GREEN_BASELINE - 0 - chips;       // chip-in (assumed made)
          chipRounds.add(r.match_id);
        } else if (hasDialedPutt) {
          chipSG += AROUND_GREEN_BASELINE - expectedPutts(firstPuttFt) - chips;
          chipRounds.add(r.match_id);
        }
      }
    }
  }

  // ── Combine — per-round figures; a category is null when it has no data. ──
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const gpsRoundCount = gpsRounds.size;
  const off_tee      = offTeeShots   > 0 && gpsRoundCount > 0 ? r2(offTeeSum   / gpsRoundCount) : null;
  const approach     = approachShots > 0 && gpsRoundCount > 0 ? r2(approachSum / gpsRoundCount) : null;
  const putting      = puttRounds.size > 0 ? r2(puttSG / puttRounds.size) : null;
  const around_green = chipRounds.size > 0 ? r2(chipSG / chipRounds.size) : null;

  if (off_tee == null && approach == null && putting == null && around_green == null) return null;

  const total = r2((off_tee ?? 0) + (approach ?? 0) + (around_green ?? 0) + (putting ?? 0));
  const roundsUsed = new Set<string>([...gpsRounds, ...puttRounds, ...chipRounds]).size;

  // ── "Where the strokes go" — the book's decomposition ────────────────────
  // Split the total per-round LOSS across the categories that are losing
  // strokes. This is the number the book says to practice from: not "am I a
  // bad putter" but "what fraction of my gap is putting vs long game."
  const perCat: Array<[SGCategory, number | null]> = [
    ['off_tee', off_tee], ['approach', approach],
    ['around_green', around_green], ['putting', putting],
  ];
  const losses = perCat
    .filter((c): c is [SGCategory, number] => typeof c[1] === 'number' && c[1] < 0)
    .map(([cat, v]) => [cat, -v] as [SGCategory, number]);
  const lossTotal = losses.reduce((a, [, v]) => a + v, 0);
  const sg_decomposition = lossTotal > 0
    ? Object.fromEntries(losses.map(([cat, v]) => [cat, Math.round((v / lossTotal) * 100)]))
    : null;
  const sg_biggest_leak = losses.length
    ? losses.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    : null;
  // What-if: erase one category's loss (play it at the tour baseline) and you
  // save this many strokes per round. Sorted biggest first.
  const sg_what_if = losses
    .map(([category, v]) => ({ category, gain_per_round: r2(v) }))
    .sort((a, b) => b.gain_per_round - a.gain_per_round);
  const sg_three_putt = puttRounds.size > 0
    ? {
        per_round: r2(threePuttHoles / puttRounds.size),
        sg_lost_per_round: r2(threePuttLost / puttRounds.size),
      }
    : null;

  // ── Per-distance buckets (per round, so they sum to the category value) ──
  const sg_approach_buckets = approachShots > 0 && gpsRoundCount > 0
    ? approachBucketAgg.map((b) => ({
        bucket: b.bucket, sg_per_round: r2(b.sum / gpsRoundCount), shots: b.shots,
      }))
    : null;
  const sg_putting_buckets = puttRounds.size > 0
    ? puttBucketAgg.map((b) => ({
        bucket: b.bucket, sg_per_round: r2(b.sum / puttRounds.size), holes: b.holes,
      }))
    : null;
  // Worst single bucket across both. Min 5 samples: a one-shot disaster in a
  // thin bucket shouldn't headline the profile.
  const bucketCandidates = [
    ...(sg_approach_buckets ?? []).map((b) => ({
      kind: 'approach' as const, bucket: b.bucket, sg_per_round: b.sg_per_round, n: b.shots,
    })),
    ...(sg_putting_buckets ?? []).map((b) => ({
      kind: 'putting' as const, bucket: b.bucket, sg_per_round: b.sg_per_round, n: b.holes,
    })),
  ].filter((c) => c.n >= 5 && c.sg_per_round < 0);
  const worstB = bucketCandidates.sort((a, b) => a.sg_per_round - b.sg_per_round)[0] ?? null;
  const sg_worst_bucket = worstB
    ? { kind: worstB.kind, bucket: worstB.bucket, sg_per_round: worstB.sg_per_round }
    : null;

  return {
    sg_per_round: { off_tee, approach, around_green, putting, total },
    shots_used: offTeeShots + approachShots,
    holes_used: gpsHoles.size,
    rounds_used: roundsUsed,
    sg_decomposition,
    sg_biggest_leak,
    sg_what_if,
    sg_three_putt,
    sg_approach_buckets,
    sg_putting_buckets,
    sg_worst_bucket,
  };
}

// Aggregated stats from a player's completed rounds (GIR / fairways / putts /
// up-and-downs from tracked hole_stats), plus strokes-gained — which now comes
// ONLY from GPS-tracked shots via computeShotBasedSG (the old putt/chip/GIR
// heuristic was removed). sg_per_round is null when the player hasn't tracked
// shots; sg_rounds_used lets the client warn on a thin sample.
router.get('/:id/stats', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT r.round_id, r.created_at, r.hole_scores, r.hole_stats, r.total_score,
            t.par AS teebox_par, t.num_holes AS teebox_holes,
            ARRAY(
              SELECT h.par FROM holes h
              WHERE h.teebox_id = r.teebox_id
              ORDER BY h.hole_num ASC
            ) AS hole_pars
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.is_practice = false
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [req.params.id]
  );

  // Strokes-gained: long game from GPS shots, short game from typed putt
  // distances (see computeStrokesGained). Each category can be null.
  const shotSG = await computeStrokesGained(req.params.id);

  // Aggregators
  let roundsCount = 0;
  let holesPlayed = 0;
  let totalStrokes = 0;
  let totalPutts = 0;
  let totalChips = 0;
  let girCount = 0;
  let girEligible = 0;       // holes where chips/putts were tracked
  let fwHits = 0;
  let fwEligible = 0;        // par-4-and-up holes where the player tracked fairwayHit
  let threePuttCount = 0;
  let upAndDownCount = 0;    // chips ≥ 1 and putts == 1 → saved par from off green
  let upAndDownChances = 0;  // any hole with chips ≥ 1 and putts tracked

  for (const r of rows) {
    if (!Array.isArray(r.hole_scores) || r.hole_scores.length === 0) continue;
    roundsCount += 1;
    const stats: any[] = Array.isArray(r.hole_stats) ? r.hole_stats : [];
    const pars: number[] = Array.isArray(r.hole_pars) ? r.hole_pars : [];

    for (let i = 0; i < r.hole_scores.length; i++) {
      const strokes = r.hole_scores[i];
      const par = pars[i] ?? 4;
      holesPlayed += 1;
      totalStrokes += strokes;

      const s = stats[i] ?? {};
      const putts = typeof s.putts === 'number' ? s.putts : null;
      const chips = typeof s.chips === 'number' ? s.chips : null;
      const gir = typeof s.gir === 'boolean' ? s.gir : null;
      const fwHit = typeof s.fairwayHit === 'boolean' ? s.fairwayHit : null;

      if (putts !== null) {
        totalPutts += putts;
        if (putts >= 3) threePuttCount += 1;
      }
      if (chips !== null) totalChips += chips;

      // GIR is now its own input — no longer derived from chips. (You can drive
      // a par-4 green and still chip onto it, which is GIR with chips ≥ 1.)
      if (gir !== null) {
        girEligible += 1;
        if (gir) girCount += 1;
      }

      // Up-and-downs: chip(s) used AND saved par with a single putt
      if (chips !== null && putts !== null && chips >= 1) {
        upAndDownChances += 1;
        if (putts === 1) upAndDownCount += 1;
      }

      // Fairway hits — par ≥ 4 only and only if user tracked it
      if (par >= 4 && fwHit !== null) {
        fwEligible += 1;
        if (fwHit) fwHits += 1;
      }

    }
  }

  const round = (n: number, places = 2) => Math.round(n * Math.pow(10, places)) / Math.pow(10, places);

  return res.json({
    rounds_count: roundsCount,
    holes_played: holesPlayed,
    avg_strokes_per_hole: holesPlayed ? round(totalStrokes / holesPlayed) : null,
    fw_hit_pct: fwEligible ? round((fwHits / fwEligible) * 100, 1) : null,
    fw_hits: fwHits,
    fw_eligible: fwEligible,
    gir_pct: girEligible ? round((girCount / girEligible) * 100, 1) : null,
    gir_count: girCount,
    gir_eligible: girEligible,
    avg_putts_per_hole: girEligible ? round(totalPutts / girEligible) : null,
    avg_putts_per_round: roundsCount && girEligible ? round((totalPutts / girEligible) * (holesPlayed / roundsCount), 1) : null,
    avg_chips_per_round: roundsCount && girEligible ? round((totalChips / girEligible) * (holesPlayed / roundsCount), 1) : null,
    three_putt_count: threePuttCount,
    up_and_down_pct: upAndDownChances ? round((upAndDownCount / upAndDownChances) * 100, 1) : null,
    up_and_downs: upAndDownCount,
    up_and_down_chances: upAndDownChances,
    // Strokes-gained from tracked shots only (null until the player tracks shots).
    sg_per_round: shotSG?.sg_per_round ?? null,
    sg_shots_used: shotSG?.shots_used ?? 0,
    sg_holes_used: shotSG?.holes_used ?? 0,
    sg_rounds_used: shotSG?.rounds_used ?? 0,
    // Book-style improvement analytics (Every Shot Counts): where the strokes
    // go, the single biggest leak, tour-baseline what-ifs, and 3-putt cost.
    sg_decomposition: shotSG?.sg_decomposition ?? null,
    sg_biggest_leak: shotSG?.sg_biggest_leak ?? null,
    sg_what_if: shotSG?.sg_what_if ?? [],
    sg_three_putt: shotSG?.sg_three_putt ?? null,
    sg_approach_buckets: shotSG?.sg_approach_buckets ?? null,
    sg_putting_buckets: shotSG?.sg_putting_buckets ?? null,
    sg_worst_bucket: shotSG?.sg_worst_bucket ?? null,
    // Broadie's typical-amateur split, so the client can render "you vs the
    // typical amateur" (long game ≈ 65% of the gap for most players).
    sg_typical_split: TYPICAL_AMATEUR_LOSS_SPLIT,
  });
}));

/**
 * Past shots this user has tracked at a specific course+hole, across every
 * round they've ever played. Used by the in-round "ghost shots" overlay so
 * the player can see where they've landed shots on this hole in the past.
 *
 * Excludes the current match so the overlay doesn't duplicate the in-progress
 * round's shots, which are already drawn separately. Hole_num is matched
 * across all teeboxes for the course (a par 4 from white tees is the same
 * physical hole as the par 4 from blue tees).
 *
 * Query: ?courseId=<uuid>&holeNum=<int>[&excludeMatchId=<uuid>]
 */
router.get('/:id/hole-shots', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const courseId = String(req.query.courseId ?? '');
  const holeNum = parseInt(String(req.query.holeNum ?? ''), 10);
  const excludeMatchId = String(req.query.excludeMatchId ?? '');
  if (!courseId || !Number.isFinite(holeNum) || holeNum < 1 || holeNum > 36) {
    return res.status(400).json({ error: 'courseId and holeNum required' });
  }
  // Authorisation: only the user themselves (or in future, a friend with
  // explicit consent) can fetch their own historical shots. For now we lock
  // to self so this endpoint can't be used to surveil random players.
  if (req.params.id !== req.userId) {
    return res.status(403).json({ error: 'Can only fetch your own past shots' });
  }

  const params: any[] = [req.params.id, courseId, holeNum];
  let where = `WHERE st.user_id = $1
               AND t.course_id = $2
               AND st.hole_num = $3`;
  if (excludeMatchId) {
    params.push(excludeMatchId);
    where += ` AND st.match_id != $${params.length}`;
  }

  // Group the user's shots by (match_id, hole_num) using the new shots
  // table. Returns one row per round per hole.
  const { rows } = await pool.query(
    `SELECT s.match_id, m.created_at,
            json_agg(
              json_build_object(
                'club', s.club,
                'lie',  s.lie,
                'start', json_build_object('lat', s.start_lat, 'lng', s.start_lng, 'elevation_m', s.start_elevation_m),
                'end',   json_build_object('lat', s.end_lat,   'lng', s.end_lng,   'elevation_m', s.end_elevation_m),
                'recorded_at', s.recorded_at
              ) ORDER BY s.shot_index
            ) AS shots
       FROM shots s
       JOIN matches m       ON m.match_id    = s.match_id
       JOIN match_players mp ON mp.match_id  = s.match_id AND mp.user_id = s.user_id
       JOIN teeboxes t       ON t.teebox_id  = mp.teebox_id
      ${where.replace(/st\./g, 's.')}
      GROUP BY s.match_id, s.hole_num, m.created_at
      ORDER BY m.created_at DESC
      LIMIT 50`,
    params
  );
  return res.json({
    rounds: rows.map((r: any) => ({
      match_id: r.match_id,
      created_at: r.created_at,
      shots: r.shots,
    })),
  });
}));

/**
 * Per-club stats — aggregates every tracked shot the user has tagged with a
 * `club` field across all of their matches. Returns:
 *   • Per-club counts and median/avg distance (in yards)
 *   • Per-club dispersion points: shots in a normalised 2D frame where the
 *     median shot points "up". The (lateral, longitudinal) deltas show miss
 *     pattern. The mobile heatmap screen renders these directly.
 *
 * Distance comes from haversine between consecutive shots within a hole.
 * Tee shots → next-shot location; final shot before holing out is dropped
 * (no end-point to measure to without the pin coordinates).
 */
router.get('/:id/club-stats', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Pull every shot the user has — GPS + launch monitor — directly. With
  // the new shots table this is O(rows), no JSONB iteration needed. Limit
  // to a generous cap so a power user with thousands of shots doesn't
  // blow up memory; the most recent 5000 are plenty for stats.
  const { rows: shotRows } = await pool.query(
    // Club distances/dispersion default to SOLO play — a scramble shot isn't
    // necessarily the player's own ball. EXCEPTION: a shot the player was
    // explicitly tagged as the owner of (owner_user_id = them, e.g. a scramble
    // drive they hit that the team used) IS their ball, so it counts too.
    // Untagged team shots are still excluded so they can't skew the profile.
    `SELECT s.shot_id, s.club, s.start_lat, s.start_lng, s.end_lat, s.end_lng,
            s.plays_like_yds, s.recorded_at, s.total_yds, s.lateral_yds, s.partial_value
       FROM shots s
       JOIN matches m ON m.match_id = s.match_id
      WHERE COALESCE(s.owner_user_id, s.user_id) = $1
        AND (m.match_type = 'solo' OR s.owner_user_id IS NOT NULL)
        AND m.is_practice = false
        AND s.club IS NOT NULL
        AND s.club <> 'unknown'
      ORDER BY s.recorded_at DESC
      LIMIT 5000`,
    [req.params.id]
  );
  // Wrap in the shape the existing aggregator expects.
  const rows: { shots: any[] }[] = [{
    shots: shotRows.map((s: any) => ({
      shot_id: s.shot_id,
      club: s.club,
      start: { lat: s.start_lat, lng: s.start_lng },
      end:   { lat: s.end_lat,   lng: s.end_lng },
      plays_like_yds: s.plays_like_yds,
      recorded_at: s.recorded_at,
      // Client-computed at record time: signed perpendicular offset from the
      // aim/pin line, and the raw start→end distance it was derived from.
      total_yds: s.total_yds,
      lateral_yds: s.lateral_yds,
    })),
  }];

  // Per-club bucket: collect every shot's (distance_m, bearing_rad) pair,
  // plus the raw start/end so we can normalise. shot_id + recorded_at are
  // carried through so the client can offer per-shot delete + show dates.
  // plays_like_yds (client-computed plays-like distance using weather + slope
  // at recording time) is preferred for distance metrics when present.
  type ShotVec = {
    dist_m: number;
    bearing: number;
    plays_like_yds: number | null;
    shot_id: string | null;
    recorded_at: string | null;
    total_yds: number | null;
    lateral_yds: number | null;
  };
  const byClub = new Map<string, ShotVec[]>();

  // Haversine — meters between two lat/lng points
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Initial bearing in radians, 0 = north, clockwise
  function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x);
  }

  /** Walk the per-hole shot list, normalising both the new segment format
   *  and the legacy point format into (start, end, club, shot_id?, ...) tuples. */
  type Segment = {
    start: any; end: any; club: string;
    shot_id: string | null;
    plays_like_yds: number | null;
    recorded_at: string | null;
    total_yds: number | null;
    lateral_yds: number | null;
  };
  const eachShotSegment = (rawShots: any[]): Segment[] => {
    if (!rawShots.length) return [];
    if (rawShots[0]?.start && rawShots[0]?.end) {
      return rawShots
        .filter((s: any) => s?.start && s?.end && typeof s.club === 'string')
        .map((s: any) => ({
          start: s.start, end: s.end, club: s.club,
          shot_id: s.shot_id ?? null,
          plays_like_yds: typeof s.plays_like_yds === 'number' ? s.plays_like_yds : null,
          recorded_at: s.recorded_at ?? null,
          total_yds: typeof s.total_yds === 'number' ? s.total_yds : null,
          lateral_yds: typeof s.lateral_yds === 'number' ? s.lateral_yds : null,
        }));
    }
    // Legacy: points where shots[i] = "where shot i+1 was hit FROM"
    const out: Segment[] = [];
    for (let i = 0; i < rawShots.length - 1; i++) {
      const cur = rawShots[i];
      const nxt = rawShots[i + 1];
      if (typeof cur?.lat !== 'number' || typeof nxt?.lat !== 'number') continue;
      if (typeof cur.club !== 'string') continue;
      out.push({
        start: cur, end: nxt, club: cur.club,
        shot_id: null, plays_like_yds: null, recorded_at: null,
        total_yds: null, lateral_yds: null,
      });
    }
    return out;
  };

  for (const row of rows) {
    const segments = eachShotSegment(Array.isArray(row.shots) ? row.shots : []);
    for (const seg of segments) {
      // 'chip' is a non-attributing club tag — the shot was tracked but
      // the player explicitly didn't assign it to any specific physical
      // club. Skip from per-club aggregation entirely so it doesn't
      // pollute distance medians or dispersion ellipses.
      if (seg.club === 'chip') continue;
      const dist_m = haversine(seg.start, seg.end);
      if (dist_m < 1 || dist_m > 500) continue; // sanity: drop GPS noise / impossibly long
      const b = bearing(seg.start, seg.end);
      const arr = byClub.get(seg.club) ?? [];
      arr.push({
        dist_m, bearing: b,
        plays_like_yds: seg.plays_like_yds,
        shot_id: seg.shot_id,
        recorded_at: seg.recorded_at,
        total_yds: seg.total_yds,
        lateral_yds: seg.lateral_yds,
      });
      byClub.set(seg.club, arr);
    }
  }

  // Build per-club summary + dispersion points
  const M_TO_YDS = 1.0936;
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  };

  /** Distance for stat aggregation: plays-like if the client computed it
   *  at recording time, else raw GPS distance. */
  const ydsFor = (v: ShotVec) =>
    v.plays_like_yds != null ? v.plays_like_yds : v.dist_m * M_TO_YDS;

  // Per-club partial-swing distances (e.g. a 75% or 9:00 7-iron). Computed
  // straight from the raw rows, independent of the full-swing dispersion math
  // below so it can never perturb it. Distance is plays-like or frozen total.
  const partialByClub = new Map<string, Map<string, number[]>>();
  for (const r of shotRows as any[]) {
    if (!r.partial_value) continue;
    const yds = r.plays_like_yds != null ? Number(r.plays_like_yds)
              : r.total_yds != null ? Number(r.total_yds) : null;
    if (yds == null || !Number.isFinite(yds)) continue;
    if (!partialByClub.has(r.club)) partialByClub.set(r.club, new Map());
    const pmap = partialByClub.get(r.club)!;
    if (!pmap.has(r.partial_value)) pmap.set(r.partial_value, []);
    pmap.get(r.partial_value)!.push(yds);
  }

  const clubs: any[] = [];
  for (const [club, vecs] of byClub.entries()) {
    const statYds = vecs.map(ydsFor);
    const medYds = median(statYds);

    // LATERAL is the signed perpendicular distance from the ball to the line
    // the player was aiming along — start→aim (the tapped "measure" point)
    // when they set one, else start→pin. The client computes it at record
    // time against that exact line and stores it on the shot, so we use it
    // directly here.
    //
    // We deliberately do NOT re-derive a reference from the club's median
    // bearing anymore — that was the old behaviour and produced absurd values
    // (e.g. "274 yds left" for a wedge), because shots aimed at DIFFERENT
    // targets across holes got measured against a meaningless average
    // direction. Worse, it used raw GPS distance for lateral while showing
    // plays-like for distance, so a GPS-drifted shot read as a sane distance
    // but a wild miss.
    //
    // FORWARD (along-track) distance falls straight out of the right triangle
    // formed by the shot and the aim line:
    //     total² = lateral² + forward²  →  forward = √(total² − lateral²)
    // so we never need the aim bearing again. long_yds is each shot's forward
    // offset from the club's median forward landing. Shots tracked without any
    // aim/pin reference have no stored lateral → treated as on-line (0).
    const geom = vecs.map((v) => {
      const total = v.total_yds != null ? v.total_yds : v.dist_m * M_TO_YDS;
      const lateral = v.lateral_yds != null ? v.lateral_yds : 0;
      const forward = Math.sqrt(Math.max(0, total * total - lateral * lateral));
      const distAbs = v.plays_like_yds != null ? v.plays_like_yds : total;
      return { lateral, forward, distAbs };
    });
    const medForward = median(geom.map((g) => g.forward));

    const dispersion = vecs.map((v, i) => ({
      shot_id: v.shot_id,
      recorded_at: v.recorded_at,
      lateral_yds: Math.round(geom[i].lateral),
      long_yds:    Math.round(geom[i].forward - medForward),
      dist_yds:    Math.round(geom[i].distAbs),
    }));

    const pm = partialByClub.get(club);
    const partials = pm
      ? [...pm.entries()]
          .map(([label, arr]) => ({ label, shots: arr.length, median_yds: Math.round(median(arr)) }))
          .sort((a, b) => b.median_yds - a.median_yds)
      : [];

    clubs.push({
      club,
      shots: vecs.length,
      avg_yds:    Math.round(statYds.reduce((a, b) => a + b, 0) / statYds.length),
      median_yds: Math.round(medYds),
      partials,
      dispersion,
    });
  }

  // Stable order: longest median distance first (driver → wedges → putter)
  clubs.sort((a, b) => (b.median_yds || 0) - (a.median_yds || 0));
  return res.json({ clubs });
}));

/**
 * Putting + approach proximity analytics — premium-only insight screen.
 *
 * Buckets every tracked shot in the user's history into one of two analyses:
 *
 *   PUTTING  — shots whose `start` is within PUTT_RADIUS_YDS of the pin.
 *              Bucketed by start-distance-to-pin in feet (3, 6, 10, 15, 25,
 *              26+ ft). A putt is counted as MADE iff it's the final tracked
 *              shot on its hole AND its end position is within ~3 ft of pin.
 *              All other putts count as missed attempts.
 *
 *              Heuristic gap: if the player picks up a gimme without tracking
 *              the final stroke, we under-count makes from 0-3 ft (the stroke
 *              they didn't tag). Acceptable — the alternative (assume any
 *              short-distance non-tracked putt was made) over-counts make %
 *              and is dishonest in the other direction.
 *
 *   APPROACH — shots whose `start` is OFF the green (>PUTT_RADIUS_YDS from
 *              pin) AND whose `end` lands within 30 yds of pin. Bucketed by
 *              start-to-pin distance (chip < 50 yd, then 50-100, 100-150,
 *              150-200, 200+). Reported value is mean proximity to pin in
 *              feet. Excludes tee shots on long holes (because they don't
 *              "approach" the green directly) and recovery shots that miss
 *              wildly — both signal-degraders if included.
 *
 * Scratch baselines come from Mark Broadie's "Every Shot Counts" research,
 * widely cited as the canonical reference for PGA-tour scratch-amateur gaps.
 * Returned alongside each bucket so the client can render side-by-side
 * comparisons without hard-coding the numbers in the UI layer.
 *
 * Free for everyone — analysis / gameplay features are no longer premium-gated
 * (only cosmetics are). Left the rich breakdown in place; just dropped the gate.
 */
router.get('/:id/shot-stats', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Pull every tracked shot for this user that has a pin location to compare
  // against. INNER JOIN on holes filters out shots from holes that don't have
  // a known pin (a course with no contributions yet) — those shots are
  // valuable for club-stats but useless here because we can't measure
  // proximity. Limit to a generous cap to keep memory bounded.
  const { rows } = await pool.query(
    `SELECT s.match_id, s.hole_num, s.shot_index,
            s.start_lat, s.start_lng, s.end_lat, s.end_lng,
            h.pin_lat, h.pin_lng
       FROM shots s
       -- Attribute by owner: a scramble approach the player was tagged for
       -- counts as theirs. Their round is mirrored in a scramble, so the teebox
       -- (and thus the pin) still resolves. COALESCE → tracker for solo shots.
       JOIN rounds r ON r.match_id = s.match_id AND r.user_id = COALESCE(s.owner_user_id, s.user_id)
       JOIN holes  h ON h.teebox_id = r.teebox_id AND h.hole_num = s.hole_num
      WHERE COALESCE(s.owner_user_id, s.user_id) = $1
        AND s.match_id IS NOT NULL
        AND h.pin_lat IS NOT NULL
        AND h.pin_lng IS NOT NULL
      ORDER BY s.match_id, s.hole_num, s.shot_index
      LIMIT 10000`,
    [req.params.id]
  );

  // Distance helper — meters between two lat/lng points via haversine, then
  // a single multiplication to yards.
  const R_M = 6371000;
  const M_TO_YDS = 1.0936132983;
  const toRad = (d: number) => d * Math.PI / 180;
  const distYds = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_M * Math.asin(Math.sqrt(a)) * M_TO_YDS;
  };

  // 12 yds = ~36 ft. Standard "green effective radius" — used elsewhere in
  // the codebase (inferHoleStatsFromShots) so analytics stay consistent.
  const PUTT_RADIUS_YDS = 12;

  // ── Putting buckets ────────────────────────────────────────────────
  // Distance from pin in FEET. "0-3 ft" includes anything closer than the
  // typical gimme line — useful for "tap-in conversion" analysis.
  type PuttBucket = { label: string; minFt: number; maxFt: number; attempts: number; made: number };
  const putting: PuttBucket[] = [
    { label: '0-3 ft',   minFt: 0,   maxFt: 3,        attempts: 0, made: 0 },
    { label: '4-6 ft',   minFt: 3,   maxFt: 6,        attempts: 0, made: 0 },
    { label: '7-10 ft',  minFt: 6,   maxFt: 10,       attempts: 0, made: 0 },
    { label: '11-15 ft', minFt: 10,  maxFt: 15,       attempts: 0, made: 0 },
    { label: '16-25 ft', minFt: 15,  maxFt: 25,       attempts: 0, made: 0 },
    { label: '26+ ft',   minFt: 25,  maxFt: Infinity, attempts: 0, made: 0 },
  ];
  // PGA Tour make% baseline from Broadie's "Every Shot Counts" putting table
  // (make% ≈ 2 − expected putts while 3-putts are rare: 8 ft = 1.50 exp putts
  // = 50% make; 15 ft = 1.78 = 22%). Bucket values are the tour average across
  // each range. Used by the client to render the "you vs tour" comparison bars.
  const SCRATCH_MAKE_PCT: Record<string, number> = {
    '0-3 ft':   99,
    '4-6 ft':   77,
    '7-10 ft':  49,
    '11-15 ft': 28,
    '16-25 ft': 12,
    '26+ ft':   5,
  };

  // ── Approach buckets ───────────────────────────────────────────────
  // Distance from pin at the SHOT'S START, in yards. The shot must land
  // close to the green to count as an approach (filters out OB recoveries
  // and wild misses that didn't get there).
  type ApproachBucket = { label: string; minYd: number; maxYd: number; shots: number; sumProxFt: number };
  const approach: ApproachBucket[] = [
    { label: '<50 yd (chip)', minYd: 0,   maxYd: 50,       shots: 0, sumProxFt: 0 },
    { label: '50-100 yd',     minYd: 50,  maxYd: 100,      shots: 0, sumProxFt: 0 },
    { label: '100-150 yd',    minYd: 100, maxYd: 150,      shots: 0, sumProxFt: 0 },
    { label: '150-200 yd',    minYd: 150, maxYd: 200,      shots: 0, sumProxFt: 0 },
    { label: '200+ yd',       minYd: 200, maxYd: Infinity, shots: 0, sumProxFt: 0 },
  ];
  // Tour proximity baseline, from the book's expected-strokes identity:
  // proximity from D ≈ the putt distance whose expected-putts equals
  // ES_fairway(D) − 1. e.g. 125 yds: ES 2.87, minus the shot = 1.87 expected
  // putts = the 20 ft row of the putting table. Reported in FEET because the
  // typical golfer thinks of "proximity" in feet, not yards.
  const SCRATCH_PROXIMITY_FT: Record<string, number> = {
    '<50 yd (chip)': 10,
    '50-100 yd':     15,
    '100-150 yd':    22,
    '150-200 yd':    34,
    '200+ yd':       55,
  };

  // 30 yd lands-near-green threshold. Wider than the 12yd putt radius
  // because we want to count approaches that ended in greenside rough /
  // bunkers — those are still "approach shots" for proximity purposes.
  const APPROACH_END_RADIUS_YDS = 30;

  // Group by (match_id, hole_num) so we know which shot is the last on
  // each hole — used for the approach-proximity bucket logic below.
  const holes = new Map<string, typeof rows>();
  for (const row of rows) {
    const k = `${row.match_id}:${row.hole_num}`;
    if (!holes.has(k)) holes.set(k, []);
    holes.get(k)!.push(row);
  }

  // ── Approach pass (GPS-based, unchanged) ───────────────────────────
  // Putts no longer come from this loop — see the hole-stats pass below.
  for (const holeShots of holes.values()) {
    for (let i = 0; i < holeShots.length; i++) {
      const s = holeShots[i];
      const startToPinYd = distYds(s.start_lat, s.start_lng, s.pin_lat, s.pin_lng);
      const endToPinYd   = distYds(s.end_lat,   s.end_lng,   s.pin_lat, s.pin_lng);
      const endToPinFt   = endToPinYd * 3;

      // Skip shots that started ON the green — those are putts and now
      // belong to the manual-entry pass below.
      if (startToPinYd <= PUTT_RADIUS_YDS) continue;

      if (endToPinYd <= APPROACH_END_RADIUS_YDS) {
        // It's an approach that landed near the green — bucket by start-
        // distance-to-pin in yards, accumulate proximity in feet.
        const bucket = approach.find((b) => startToPinYd >= b.minYd && startToPinYd < b.maxYd);
        if (!bucket) continue;
        bucket.shots += 1;
        bucket.sumProxFt += endToPinFt;
      }
    }
  }

  // ── Putting pass (manual-entry-based) ──────────────────────────────
  // Pulls putt distances from rounds.hole_stats[].puttDistances, which the
  // player types into the per-hole "Hole Detail" sheet. The LAST entry in
  // each hole's puttDistances array is the made putt (it went in to
  // finish the hole); every earlier entry is a missed putt.
  //
  // This decouples putting analytics from on-green shot tracking — a
  // player who never taps TRACK on the green still gets a complete
  // putting profile as long as they enter their putt distances.
  const { rows: roundRows } = await pool.query(
    `SELECT hole_stats FROM rounds
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 2000`,
    [req.params.id]
  );
  for (const r of roundRows) {
    const holeStats = Array.isArray(r.hole_stats) ? r.hole_stats : [];
    for (const hs of holeStats) {
      const dists: number[] = Array.isArray(hs?.puttDistances)
        ? hs.puttDistances.filter((d: any) => typeof d === 'number' && d > 0)
        : [];
      if (!dists.length) continue;
      for (let i = 0; i < dists.length; i++) {
        const ft = dists[i];
        const bucket = putting.find((b) => ft >= b.minFt && ft < b.maxFt);
        if (!bucket) continue;
        bucket.attempts += 1;
        // Only the LAST putt in the array was made — the hole was
        // finished on that stroke. All earlier putts are misses.
        if (i === dists.length - 1) {
          bucket.made += 1;
        }
      }
    }
  }

  return res.json({
    putting: putting.map((b) => ({
      bucket: b.label,
      attempts: b.attempts,
      made: b.made,
      make_pct: b.attempts ? Math.round((b.made / b.attempts) * 1000) / 10 : null,
      scratch_make_pct: SCRATCH_MAKE_PCT[b.label],
    })),
    approach: approach.map((b) => ({
      bucket: b.label,
      shots: b.shots,
      avg_proximity_ft: b.shots ? Math.round((b.sumProxFt / b.shots) * 10) / 10 : null,
      scratch_proximity_ft: SCRATCH_PROXIMITY_FT[b.label],
    })),
  });
}));

/**
 * Full performance data export — a stable, VERSIONED JSON another app can
 * ingest and re-pull anytime. Self-only (this is the caller's own personal
 * data). Four datasets, matching what it was built for:
 *   • clubs              — per-club distance + lateral DISPERSION as a
 *                          distribution (mean / stddev / percentiles) AND raw
 *                          samples, so the consumer can use the fitted curve or
 *                          the points (the "heatmap of every club").
 *   • strokes_gained     — SG per round by the four Broadie categories + by
 *                          distance bucket, with an explicit INSIDE-100 figure.
 *   • approach_proximity — avg proximity to the pin by start-distance bucket,
 *                          fine-grained INSIDE 100 yds so the consuming app
 *                          needs no separately-collected partial-wedge data.
 *   • putting            — make% + attempts by distance bucket, vs the tour.
 * Units: distances in yards, proximity + putt distance in feet, SG in
 * strokes/round relative to the PGA Tour baseline.
 */
router.get('/:id/data-export', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Personal bulk data — only the owner can pull their own export.
  if (req.userId !== req.params.id) {
    return res.status(403).json({ error: 'You can only export your own data.' });
  }
  const userId = req.params.id;

  const { rows: uRows } = await pool.query(
    `SELECT username, handicap_index FROM users WHERE user_id = $1`, [userId],
  );
  if (!uRows.length) return res.status(404).json({ error: 'User not found' });

  // ── Clubs: distance + lateral dispersion ─────────────────────────────────
  // Solo shots (or scramble shots the player was tagged as owning) so the
  // distribution is genuinely THEIR ball.
  const { rows: clubShots } = await pool.query(
    `SELECT s.club, s.total_yds, s.lateral_yds
       FROM shots s JOIN matches m ON m.match_id = s.match_id
      WHERE COALESCE(s.owner_user_id, s.user_id) = $1
        AND (m.match_type = 'solo' OR s.owner_user_id IS NOT NULL)
        AND m.is_practice = false
        AND s.club IS NOT NULL AND s.club <> 'unknown'
        AND s.total_yds IS NOT NULL
      ORDER BY s.recorded_at DESC
      LIMIT 8000`,
    [userId],
  );
  const clubMap = new Map<string, { d: number; lat: number | null }[]>();
  for (const s of clubShots) {
    const d = Number(s.total_yds);
    if (!Number.isFinite(d) || d <= 0) continue;
    const lat = (s.lateral_yds != null && Number.isFinite(Number(s.lateral_yds))) ? Number(s.lateral_yds) : null;
    const arr = clubMap.get(s.club) ?? [];
    arr.push({ d, lat });
    clubMap.set(s.club, arr);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const stddev = (a: number[]) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  };
  const pctile = (sorted: number[], p: number): number | null => {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  };
  const r1 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10);
  const clubs = [...clubMap.entries()]
    .map(([club, arr]) => {
      const ds = arr.map((x) => x.d).sort((a, b) => a - b);
      const lats = arr.map((x) => x.lat).filter((x): x is number => x != null);
      return {
        club,
        shot_count: arr.length,
        distance_yds: {
          mean: r1(mean(ds)), stddev: r1(stddev(ds)),
          min: r1(ds[0]), max: r1(ds[ds.length - 1]),
          p10: r1(pctile(ds, 10)), p50: r1(pctile(ds, 50)), p90: r1(pctile(ds, 90)),
        },
        // Signed lateral: + = right of target, − = left. stddev = spread width.
        lateral_yds: lats.length
          ? { mean: r1(mean(lats)), stddev: r1(stddev(lats)), samples: lats.length }
          : null,
        // Raw points (capped) so the consumer can plot the real heatmap or fit
        // its own distribution rather than trusting our summary.
        samples: arr.slice(0, 300).map((x) => ({ distance_yds: r1(x.d), lateral_yds: r1(x.lat) })),
      };
    })
    .sort((a, b) => (b.distance_yds.mean ?? 0) - (a.distance_yds.mean ?? 0));

  // ── Strokes gained (canonical Broadie engine) ────────────────────────────
  const sg = await computeStrokesGained(userId);
  const approachUnder100 = sg?.sg_approach_buckets?.find((b) => b.bucket === '<100 yd')?.sg_per_round ?? null;
  const aroundGreen = sg?.sg_per_round?.around_green ?? null;
  const inside100Sg = (approachUnder100 != null || aroundGreen != null)
    ? Math.round(((approachUnder100 ?? 0) + (aroundGreen ?? 0)) * 100) / 100
    : null;
  const strokes_gained = {
    rounds_used: sg?.rounds_used ?? 0,
    shots_used: sg?.shots_used ?? 0,
    per_round: sg?.sg_per_round ?? { off_tee: null, approach: null, around_green: null, putting: null, total: 0 },
    by_distance: {
      approach: sg?.sg_approach_buckets ?? [],
      putting: sg?.sg_putting_buckets ?? [],
    },
    inside_100: {
      sg_per_round: inside100Sg,
      components: { around_green: aroundGreen, approach_under_100_yd: approachUnder100 },
      note: 'Strokes gained inside 100 yards (greenside + wedge approaches), so a consuming app needs no separately-collected partial-shot data.',
    },
  };

  // ── Approach proximity, fine-grained inside 100 (GPS-tracked shots) ───────
  const { rows: shotRows } = await pool.query(
    `SELECT s.start_lat, s.start_lng, s.end_lat, s.end_lng, h.pin_lat, h.pin_lng
       FROM shots s
       JOIN rounds r ON r.match_id = s.match_id AND r.user_id = COALESCE(s.owner_user_id, s.user_id)
       JOIN holes  h ON h.teebox_id = r.teebox_id AND h.hole_num = s.hole_num
      WHERE COALESCE(s.owner_user_id, s.user_id) = $1
        AND s.match_id IS NOT NULL AND h.pin_lat IS NOT NULL AND h.pin_lng IS NOT NULL
      LIMIT 10000`,
    [userId],
  );
  const R_M = 6371000, M_TO_YDS = 1.0936132983;
  const toRad = (d: number) => d * Math.PI / 180;
  const distYds = (la1: number, lo1: number, la2: number, lo2: number): number => {
    const dLat = toRad(la2 - la1), dLng = toRad(lo2 - lo1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_M * Math.asin(Math.sqrt(a)) * M_TO_YDS;
  };
  const PUTT_RADIUS_YDS = 12, APPROACH_END_RADIUS_YDS = 30;
  const apBuckets = [
    { label: '0-30 yd', min: 0, max: 30 }, { label: '30-50 yd', min: 30, max: 50 },
    { label: '50-75 yd', min: 50, max: 75 }, { label: '75-100 yd', min: 75, max: 100 },
    { label: '100-125 yd', min: 100, max: 125 }, { label: '125-150 yd', min: 125, max: 150 },
    { label: '150-175 yd', min: 150, max: 175 }, { label: '175-200 yd', min: 175, max: 200 },
    { label: '200+ yd', min: 200, max: Infinity },
  ].map((b) => ({ ...b, shots: 0, sumProxFt: 0 }));
  for (const s of shotRows) {
    const startToPin = distYds(s.start_lat, s.start_lng, s.pin_lat, s.pin_lng);
    const endToPin = distYds(s.end_lat, s.end_lng, s.pin_lat, s.pin_lng);
    if (startToPin <= PUTT_RADIUS_YDS) continue;         // that's a putt
    if (endToPin > APPROACH_END_RADIUS_YDS) continue;    // didn't reach the green area
    const b = apBuckets.find((x) => startToPin >= x.min && startToPin < x.max);
    if (b) { b.shots += 1; b.sumProxFt += endToPin * 3; }
  }
  const approach_proximity = apBuckets.map((b) => ({
    bucket: b.label, shots: b.shots,
    avg_proximity_ft: b.shots ? Math.round((b.sumProxFt / b.shots) * 10) / 10 : null,
  }));

  // ── Putting make% by distance (typed putt distances) ─────────────────────
  const puttBuckets = [
    { label: '0-3 ft', min: 0, max: 3 }, { label: '4-6 ft', min: 3, max: 6 },
    { label: '7-10 ft', min: 6, max: 10 }, { label: '11-15 ft', min: 10, max: 15 },
    { label: '16-25 ft', min: 15, max: 25 }, { label: '26+ ft', min: 25, max: Infinity },
  ].map((b) => ({ ...b, attempts: 0, made: 0 }));
  const TOUR_MAKE_PCT: Record<string, number> = {
    '0-3 ft': 99, '4-6 ft': 77, '7-10 ft': 49, '11-15 ft': 28, '16-25 ft': 12, '26+ ft': 5,
  };
  const { rows: prRows } = await pool.query(
    `SELECT hole_stats FROM rounds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000`,
    [userId],
  );
  for (const r of prRows) {
    const hsArr: any[] = Array.isArray(r.hole_stats) ? r.hole_stats : [];
    for (const h of hsArr) {
      const dists: number[] = Array.isArray(h?.puttDistances)
        ? h.puttDistances.filter((d: any) => typeof d === 'number' && d > 0) : [];
      for (let i = 0; i < dists.length; i++) {
        const b = puttBuckets.find((x) => dists[i] >= x.min && dists[i] < x.max);
        if (!b) continue;
        b.attempts += 1;
        if (i === dists.length - 1) b.made += 1;   // last putt in the array = the make
      }
    }
  }
  const putting = puttBuckets.map((b) => ({
    bucket: b.label, attempts: b.attempts, made: b.made,
    make_pct: b.attempts ? Math.round((b.made / b.attempts) * 1000) / 10 : null,
    tour_make_pct: TOUR_MAKE_PCT[b.label],
  }));

  return res.json({
    schema: 'sacari.performance-export',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    player: { user_id: userId, username: uRows[0].username, handicap_index: uRows[0].handicap_index },
    units: {
      distance: 'yards',
      lateral: 'yards (+ right / − left of target line)',
      proximity: 'feet',
      putt_distance: 'feet',
      strokes_gained: 'strokes per round vs PGA Tour baseline (positive = gaining)',
    },
    clubs,
    strokes_gained,
    approach_proximity,
    putting,
  });
}));

/**
 * Delete a single shot owned by the authenticated user. Used from the club
 * heatmap / advanced stats screen when the player wants to drop a mistracked
 * shot from their stats. Restricted to the shot's owner — no admin override.
 */
router.delete('/me/shots/:shotId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { shotId } = req.params;
  if (!shotId) return res.status(400).json({ error: 'shotId required' });
  const { rowCount } = await pool.query(
    `DELETE FROM shots WHERE shot_id = $1 AND user_id = $2`,
    [shotId, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Shot not found' });
  return res.json({ success: true });
}));

/**
 * Advanced strokes-gained — the real Mark Broadie / Shotscope model.
 * Requires shot-tracking data with at least lie tags + pin coordinates.
 *
 * For each tracked hole we walk the shot list. Each shot's start lie/distance
 * comes from the player's tag (or sane defaults: shot 0 = 'tee', else
 * 'fairway'). End lie/distance comes from the next shot's tag and position.
 * Final shot ends at the pin (end_dist = 0 if the player holed out per the
 * scorecard).
 *
 * Returns null if too little data is available; clients should fall back to
 * the basic /stats endpoint in that case.
 */
router.get('/:id/sg-advanced', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Same strokes-gained engine the /stats endpoint uses (kept for back-compat).
  const sg = await computeStrokesGained(req.params.id);
  if (!sg) return res.json({ shots_used: 0, sg_per_round: null, holes_used: 0, rounds_used: 0 });
  return res.json(sg);
}));

// Course records — the courses where this user holds the lowest score on
// any teebox. Returns one row per course where they're rank #1.
router.get('/:id/course-records', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT t.course_id, c.course_name, t.name AS teebox_name, r.user_id,
              r.total_score, r.created_at,
              ROW_NUMBER() OVER (PARTITION BY t.course_id ORDER BY r.total_score ASC, r.created_at ASC) AS rk
       FROM rounds r
       JOIN matches m ON m.match_id = r.match_id
       JOIN teeboxes t ON t.teebox_id = r.teebox_id
       JOIN courses c ON c.course_id = t.course_id
       WHERE r.total_score IS NOT NULL
         AND m.completed = true
         AND m.is_practice = false
     )
     SELECT course_id, course_name, teebox_name, total_score, created_at
     FROM ranked
     WHERE rk = 1 AND user_id = $1
     ORDER BY total_score ASC`,
    [req.params.id]
  );
  return res.json(rows);
}));

// Active (unused) perks for the requesting user
// Player insights — narrative stats derived from rounds + hole_scores.
// Cheap aggregations meant to feel like coaching observations: scoring
// average per par-N, trend across recent rounds, hardest hole on home
// course, total eagles/birdies, and most-played course.
//
// Filtered to completed, non-practice rounds with hole_scores populated.
router.get('/:id/insights', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const userId = req.params.id;

  // Pull every completed round with its hole-score array + per-hole pars.
  // We unnest with WITH ORDINALITY so we get parallel scores + pars without
  // shipping the holes table over the wire per row.
  const { rows: holeRows } = await pool.query(
    `WITH src AS (
       SELECT r.round_id, r.created_at, r.total_score, r.hole_scores,
              t.teebox_id, t.par AS teebox_par, t.num_holes,
              c.course_id, c.course_name
       FROM rounds r
       JOIN matches m ON m.match_id = r.match_id
       LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
       LEFT JOIN courses c ON c.course_id = t.course_id
       WHERE r.user_id = $1
         AND r.total_score IS NOT NULL
         AND m.completed = true
         AND m.is_practice = false
         AND array_length(r.hole_scores, 1) > 0
       ORDER BY r.created_at DESC
       LIMIT 100
     )
     SELECT s.round_id, s.created_at, s.total_score, s.teebox_par, s.num_holes,
            s.course_id, s.course_name,
            scored.hole_num, scored.score, h.par AS hole_par
     FROM src s,
          LATERAL unnest(s.hole_scores) WITH ORDINALITY AS scored(score, hole_num)
          LEFT JOIN holes h ON h.teebox_id = s.teebox_id AND h.hole_num = scored.hole_num`,
    [userId]
  );

  // Aggregate in JS — cheap, the LIMIT keeps row count bounded.
  const parBuckets: Record<3 | 4 | 5, { total: number; n: number }> = {
    3: { total: 0, n: 0 }, 4: { total: 0, n: 0 }, 5: { total: 0, n: 0 },
  };
  // Hardest hole at each course = highest avg score-to-par over the player's rounds there.
  const holeAgg: Record<string, { course_id: string; course_name: string; hole_num: number; total: number; n: number; par: number }> = {};
  const courseRoundCount: Record<string, { course_id: string; course_name: string; n: number }> = {};
  const seenRounds = new Set<string>();
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0;

  for (const row of holeRows) {
    if (!row.hole_par || !row.score) continue;
    const par = row.hole_par as 3 | 4 | 5;
    if (parBuckets[par]) {
      parBuckets[par].total += row.score;
      parBuckets[par].n += 1;
    }
    const diff = row.score - par;
    if (diff <= -2) eagles++;
    else if (diff === -1) birdies++;
    else if (diff === 0) pars++;
    else if (diff === 1) bogeys++;
    else doubles++;

    // Hole-level aggregation per course
    if (row.course_id) {
      const key = `${row.course_id}|${row.hole_num}`;
      if (!holeAgg[key]) {
        holeAgg[key] = {
          course_id: row.course_id,
          course_name: row.course_name ?? 'Unknown',
          hole_num: row.hole_num,
          total: 0, n: 0, par,
        };
      }
      holeAgg[key].total += row.score;
      holeAgg[key].n += 1;

      if (!seenRounds.has(row.round_id)) {
        seenRounds.add(row.round_id);
        if (!courseRoundCount[row.course_id]) {
          courseRoundCount[row.course_id] = {
            course_id: row.course_id, course_name: row.course_name ?? 'Unknown', n: 0,
          };
        }
        courseRoundCount[row.course_id].n += 1;
      }
    }
  }

  const avgPerPar = (Object.entries(parBuckets) as [string, { total: number; n: number }][]).reduce<Record<string, number | null>>((acc, [par, b]) => {
    acc[par] = b.n ? Math.round((b.total / b.n) * 100) / 100 : null;
    return acc;
  }, {});

  // Hardest hole = max avg-to-par with at least 2 plays
  const eligible = Object.values(holeAgg).filter((h) => h.n >= 2);
  eligible.sort((a, b) => (b.total / b.n - b.par) - (a.total / a.n - a.par));
  const hardest = eligible[0] ?? null;
  const easiest = eligible[eligible.length - 1] ?? null;

  // Most-played course
  const mostPlayed = Object.values(courseRoundCount).sort((a, b) => b.n - a.n)[0] ?? null;

  // Recent trend: avg score-to-par for the last 5 vs the previous 5 rounds.
  // Par is pro-rated to the holes actually played — a 9-hole round of an
  // 18-hole teebox compares against ~36, not 72. Without this a single
  // partial round drags the average wildly negative and flips the
  // "improving" flag the wrong way.
  const { rows: trendRows } = await pool.query(
    `SELECT r.round_id,
            r.total_score
              - ROUND(t.par::numeric
                      * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                      / NULLIF(t.num_holes, 0)::numeric)::int AS to_par,
            r.created_at
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     JOIN teeboxes t ON t.teebox_id = r.teebox_id
     WHERE r.user_id = $1
       AND r.total_score IS NOT NULL
       AND m.completed = true
       AND m.is_practice = false
       AND t.par IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [userId]
  );
  const last5 = trendRows.slice(0, 5).map((r) => r.to_par);
  const prev5 = trendRows.slice(5, 10).map((r) => r.to_par);
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const last5Avg = avg(last5);
  const prev5Avg = avg(prev5);
  const trendDelta = (last5Avg != null && prev5Avg != null)
    ? Math.round((last5Avg - prev5Avg) * 100) / 100
    : null;

  return res.json({
    rounds_analyzed: seenRounds.size,
    avg_score_per_par: avgPerPar,             // { '3': 3.4, '4': 4.6, '5': 5.2 }
    score_distribution: { eagles, birdies, pars, bogeys, doubles_or_worse: doubles },
    hardest_hole: hardest ? {
      course_id: hardest.course_id,
      course_name: hardest.course_name,
      hole_num: hardest.hole_num,
      par: hardest.par,
      avg_score: Math.round((hardest.total / hardest.n) * 100) / 100,
      plays: hardest.n,
    } : null,
    easiest_hole: easiest ? {
      course_id: easiest.course_id,
      course_name: easiest.course_name,
      hole_num: easiest.hole_num,
      par: easiest.par,
      avg_score: Math.round((easiest.total / easiest.n) * 100) / 100,
      plays: easiest.n,
    } : null,
    most_played_course: mostPlayed,
    recent_trend: {
      last5_avg_to_par: last5Avg != null ? Math.round(last5Avg * 100) / 100 : null,
      prev5_avg_to_par: prev5Avg != null ? Math.round(prev5Avg * 100) / 100 : null,
      delta: trendDelta,                    // negative = improving (lower scores)
      improving: trendDelta != null && trendDelta < 0,
    },
  });
}));

// ─── User blocking ──────────────────────────────────────────────────────────
// Apple Guideline 1.2 (and Play Console's UGC rules) require any app with
// user-generated content to let users block other users. Block is one-way and
// silent — the blocked user is never notified.
//
// `getBlockedIds(userId)` returns the list of user_ids the caller has blocked,
// so other routes (search, leaderboard, finds pair, DMs, etc.) can filter.

export async function getBlockedIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1`,
    [userId]
  );
  return rows.map((r: any) => r.blocked_id);
}

// List my blocks — used by a "Blocked users" settings screen.
router.get('/me/blocks', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT b.blocked_id, b.created_at, b.reason,
            u.username, u.elo, u.avatar_url
     FROM blocked_users b
     JOIN users u ON u.user_id = b.blocked_id
     WHERE b.blocker_id = $1
     ORDER BY b.created_at DESC`,
    [req.userId]
  );
  return res.json(rows);
}));

// Block a user. Idempotent — re-blocking is a no-op. Also auto-removes any
// pending or accepted friendship so they can't slide back in via friends.
router.post('/me/blocks/:userId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  if (req.params.userId === req.userId) {
    return res.status(400).json({ error: "Can't block yourself" });
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
  await pool.query(
    `INSERT INTO blocked_users (blocker_id, blocked_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET reason = EXCLUDED.reason`,
    [req.userId, req.params.userId, reason]
  );
  // Tear down any existing friendship (either direction) so the blocked user
  // can't continue to see the blocker as a friend.
  await pool.query(
    `DELETE FROM friends
     WHERE (user_id = $1 AND friend_id = $2)
        OR (user_id = $2 AND friend_id = $1)`,
    [req.userId, req.params.userId]
  );
  return res.json({ success: true });
}));

// Unblock — also idempotent.
router.delete('/me/blocks/:userId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(
    `DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`,
    [req.userId, req.params.userId]
  );
  return res.json({ success: true });
}));

router.get('/me/perks', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT perk_id, perk_type, earned_at, earned_match_id
     FROM user_perks
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY earned_at ASC`,
    [req.userId]
  );
  return res.json(rows);
}));

/**
 * Referral dashboard: the caller's share code, the share URL the Invite
 * screen displays / copies, and the running tally of who they've referred
 * and how many Lucky Rounds they've earned for it.
 *
 *   GET /users/me/referral
 *   → { code, share_url, referred_count, perks_earned }
 *
 * `referral_code` is populated on every row (signup-time generator for
 * new accounts, migration backfill for old ones), so this endpoint never
 * returns a missing code. The share URL points at the web landing page —
 * see web/server.js for /invite/<code>.
 */
router.get('/me/referral', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: codeRows } = await pool.query(
    `SELECT referral_code FROM users WHERE user_id = $1`,
    [req.userId]
  );
  const code = codeRows[0]?.referral_code as string | null | undefined;
  if (!code) {
    // Backfill missed this row somehow — generate one now so the screen
    // still works. Idempotent: UPDATE only if still null.
    const { rows: gen } = await pool.query(
      `UPDATE users
          SET referral_code = upper(substring(
                translate(encode(gen_random_bytes(8), 'base64'),
                          '+/=abcdefghijklmnopqrstuvwxyz', ''),
                1, 7))
        WHERE user_id = $1 AND referral_code IS NULL
       RETURNING referral_code`,
      [req.userId]
    );
    if (gen[0]?.referral_code) (codeRows[0] ??= {}).referral_code = gen[0].referral_code;
  }
  const finalCode = codeRows[0]?.referral_code as string;

  const { rows: stats } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM users
         WHERE referred_by_user_id = $1) AS referred_count,
       (SELECT COUNT(*)::int FROM user_perks
         WHERE user_id = $1 AND earned_reason = 'referral') AS perks_earned`,
    [req.userId]
  );

  const siteUrl = process.env.SITE_URL || 'https://sacarigolf.com';
  return res.json({
    code: finalCode,
    share_url: `${siteUrl}/invite/${finalCode}`,
    referred_count: stats[0]?.referred_count ?? 0,
    perks_earned:   stats[0]?.perks_earned   ?? 0,
  });
}));

router.get('/leaderboard', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const friendsOnly = req.query.friends === '1' || req.query.friends === 'true';
  // mode: 'all' (overall ELO, default) or a match type (solo|duo|squad|ffa).
  // The app tracks a single global ELO, so mode-specific boards instead
  // rank by WINS in that mode (matches played as tiebreak) — the most
  // meaningful per-mode ranking without per-mode ELO.
  const rawMode = (req.query.mode as string) || 'all';
  const VALID_MODES = new Set(['solo', 'duo', 'squad', 'ffa']);
  const mode = VALID_MODES.has(rawMode) ? rawMode : 'all';

  // Friends scope id-set, reused by both ELO and mode queries.
  const friendScopeCte = `
    WITH scope AS (
      SELECT $1::uuid AS user_id
      UNION
      SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
        FROM friends f
       WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
    )`;

  // ── Duo / Squad: TEAM leaderboard, ranked by ELO ────────────────────
  // Teams are clans (clan_mode = duo | squad). clans.elo is never updated
  // by match resolution (only users.elo is), so ranking by it would put
  // every team at the 1200 default. Instead a team's rating is the average
  // of its current members' individual ELO — meaningful from day one with
  // no change to the resolution path. `is_mine` flags teams the caller is
  // in so the app can highlight them. The friends toggle doesn't map onto
  // teams, so it's ignored here; private teams still appear if the caller
  // is a member.
  if (mode === 'duo' || mode === 'squad') {
    const { rows } = await pool.query(
      `SELECT c.clan_id, c.name, c.clan_mode, c.avatar_url,
              ROUND(AVG(u.elo))::int AS team_elo,
              COUNT(cm.user_id)::int AS member_count,
              c.total_matches, c.total_wins,
              bool_or(cm.user_id = $1) AS is_mine
         FROM clans c
         JOIN clan_members cm ON cm.clan_id = c.clan_id
         JOIN users u ON u.user_id = cm.user_id
        WHERE c.clan_mode = $2
          AND (c.is_public = true OR EXISTS (
            SELECT 1 FROM clan_members me
            WHERE me.clan_id = c.clan_id AND me.user_id = $1
          ))
        GROUP BY c.clan_id
        ORDER BY team_elo DESC, c.total_wins DESC, c.name ASC
        LIMIT 100`,
      [req.userId, mode]
    );
    return res.json(rows);
  }

  // ── Solo / FFA: individuals ranked by ELO ───────────────────────────
  // All boards rank by ELO now (the old per-mode WINS ranking is gone).
  // Restricted to players who've actually played that mode so the tab
  // stays distinct from Overall, but ordered purely by global ELO.
  if (mode === 'solo' || mode === 'ffa') {
    const scopeFilter = friendsOnly
      ? 'u.user_id IN (SELECT user_id FROM scope)'
      : 'u.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $1)';
    const sql = `
      ${friendsOnly ? friendScopeCte : ''}
      SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url,
             ${equippedVisualSql('u')} AS equipped_visual
        FROM users u
       WHERE ${scopeFilter}
         AND EXISTS (
           SELECT 1 FROM match_players mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.user_id = u.user_id
            AND m.match_type = $2
            AND m.completed = true
            AND m.is_practice = false
         )
       ORDER BY u.elo DESC
       LIMIT 100`;
    const { rows } = await pool.query(sql, [req.userId, mode]);
    return res.json(await attachBounties(rows));
  }

  // ── Overall ELO leaderboard (default) ───────────────────────────────
  if (friendsOnly) {
    const { rows } = await pool.query(
      `${friendScopeCte}
       SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url,
              ${equippedVisualSql('u')} AS equipped_visual
       FROM users u
       WHERE u.user_id IN (SELECT user_id FROM scope)
       ORDER BY u.elo DESC
       LIMIT 100`,
      [req.userId]
    );
    return res.json(await attachBounties(rows));
  }
  // Apple Guideline 1.2: hide blocked users everywhere, including the
  // global leaderboard. Blocker only — blocked users still see the blocker.
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.avatar_url,
            ${equippedVisualSql('u')} AS equipped_visual
     FROM users u
     WHERE u.user_id NOT IN (
       SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
     )
     ORDER BY u.elo DESC LIMIT 100`,
    [req.userId]
  );
  return res.json(await attachBounties(rows));
}));

router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.total_ties,
            u.avatar_url, u.created_at,
            u.bio, u.home_course_id, u.drinks, u.equipped_title,
            (SELECT name FROM titles WHERE title_id = u.equipped_title) AS equipped_title_name,
            ${equippedVisualSql('u')} AS equipped_visual,
            c.course_name AS home_course_name, c.city AS home_course_city, c.state AS home_course_state
     FROM users u
     LEFT JOIN courses c ON c.course_id = u.home_course_id
     WHERE u.user_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const userInfo = rows[0];
  // Open-beta override — public profile reports premium too so the badge
  // shows on the user/[id] screen. See backend/src/utils/openBeta.ts.
  if (OPEN_BETA_PREMIUM) userInfo.is_premium = true;

  // Recent completed rounds (last 5)
  const { rows: recentRounds } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores, r.hole_stats,
            t.teebox_id, t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            m.format, m.match_type
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true
     ORDER BY r.created_at DESC
     LIMIT 5`,
    [req.params.id]
  );

  // Best round (lowest score-to-par across completed SOLO rounds). Scoped to
  // solo — same as the handicap, Sacari Cup, and cup-standings queries —
  // because team (duo/squad/scramble) scores are shared and Arena is multi-way,
  // so they don't represent an individual's round. to_par is the 18-hole-
  // equivalent differential (shared helper, same basis as the Sacari Cup and
  // every other cross-player board): par is pro-rated to the holes played,
  // then scaled to a full 18 — so a 9-hole 41 doesn't look like a course
  // record. The same expression is used in SELECT and ORDER BY so the best
  // round actually wins.
  const { rows: bestRows } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores, r.hole_stats,
            t.teebox_id, t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            r.normalized_to_par AS to_par
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.normalized_to_par IS NOT NULL AND m.completed = true
       AND m.is_practice = false AND m.match_type = 'solo'
     ORDER BY r.normalized_to_par ASC
     LIMIT 1`,
    [req.params.id]
  );

  // Follow counts. The "friends" table is directional with a single row per
  // pair (status flips 'pending' → 'accepted' after the recipient accepts).
  // We expose it as a follow graph where SENDING a request = following that
  // person immediately, and ACCEPTING one = following them back:
  //   • following = people this user sent a request to (pending OR accepted)
  //                 + people whose request this user accepted (follow-back)
  //   • followers = people who sent this user a request (pending OR accepted)
  //                 + people this user sent to who accepted (they followed back)
  const { rows: followCounts } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM (
          SELECT friend_id AS oid FROM friends WHERE user_id = $1
          UNION
          SELECT user_id AS oid FROM friends WHERE friend_id = $1 AND status = 'accepted'
        ) t) AS following_count,
       (SELECT COUNT(*)::int FROM (
          SELECT user_id AS oid FROM friends WHERE friend_id = $1
          UNION
          SELECT friend_id AS oid FROM friends WHERE user_id = $1 AND status = 'accepted'
        ) t) AS followers_count`,
    [req.params.id]
  );

  // Friendship status with the viewer — drives the "Add Friend" button on
  // the profile screen. Returns one of:
  //   'self' | 'friends' | 'request_sent' | 'request_received' | 'none'
  let friendshipStatus: 'self' | 'friends' | 'request_sent' | 'request_received' | 'none' = 'none';
  if (req.params.id === req.userId) {
    friendshipStatus = 'self';
  } else {
    const { rows: fs } = await pool.query(
      `SELECT user_id, friend_id, status FROM friends
        WHERE (user_id = $1 AND friend_id = $2)
           OR (user_id = $2 AND friend_id = $1)`,
      [req.userId, req.params.id]
    );
    if (fs.length > 0) {
      const accepted = fs.find((r) => r.status === 'accepted');
      if (accepted) friendshipStatus = 'friends';
      else if (fs.find((r) => r.user_id === req.userId)) friendshipStatus = 'request_sent';
      else friendshipStatus = 'request_received';
    }
  }

  // Drinks-drunk stat — a lifetime tally the user adjusts by hand from their
  // profile (users.drinks). PRIVACY: surfaced to the user themselves and anyone
  // in their friend/follow graph — accepted friends AND pending follow
  // connections in either direction (i.e. any friendship_status other than
  // 'none'). Still hidden from total strangers. Returned as null when hidden so
  // the client simply doesn't render it.
  let drinks: number | null = null;
  if (friendshipStatus !== 'none') {
    drinks = (userInfo as any).drinks ?? 0;
  }

  // Lifetime practice reps from The Grind (range + putting combined). Public —
  // it's an effort/dedication stat shown on every profile, not sensitive.
  const { rows: practiceRows } = await pool.query(
    `SELECT COALESCE(SUM(shots), 0)::int AS practice_shots
       FROM practice_sessions WHERE user_id = $1`,
    [req.params.id]
  );

  // Current ranked win streak → drives the "bounty" flag on the profile.
  const streak = (await computeWinStreaks([req.params.id])).get(req.params.id) ?? 0;

  return res.json({
    ...userInfo,
    recent_rounds: recentRounds,
    best_round: bestRows[0] ?? null,
    following_count: followCounts[0]?.following_count ?? 0,
    followers_count: followCounts[0]?.followers_count ?? 0,
    friendship_status: friendshipStatus,
    drinks,
    practice_shots: practiceRows[0]?.practice_shots ?? 0,
    win_streak: streak,
    bounty: streak >= BOUNTY_THRESHOLD,
  });
}));

/**
 * Following list — everyone this user follows. In our follow model, sending a
 * friend request IS following that person (immediately, while still pending),
 * and accepting someone's request follows them back. So following =
 *   (a) anyone this user sent a request to (pending or accepted), plus
 *   (b) anyone whose request this user accepted (the follow-back).
 * DISTINCT ON collapses any stray bidirectional duplicate so nobody lists twice.
 */
router.get('/:id/following', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.user_id)
            u.user_id, u.username, u.elo, u.avatar_url, x.created_at,
            ${equippedVisualSql('u')} AS equipped_visual
       FROM (
         SELECT friend_id AS other_id, created_at FROM friends WHERE user_id = $1
         UNION
         SELECT user_id  AS other_id, created_at FROM friends WHERE friend_id = $1 AND status = 'accepted'
       ) x
       JOIN users u ON u.user_id = x.other_id
      ORDER BY u.user_id, x.created_at DESC`,
    [req.params.id]
  );
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return res.json(rows);
}));

/**
 * Followers list — everyone who follows THIS user: (a) anyone who sent this
 * user a request (pending or accepted) — sending is following — plus (b) anyone
 * this user sent a request to who accepted it (they followed back). Mirror of
 * /following.
 */
router.get('/:id/followers', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.user_id)
            u.user_id, u.username, u.elo, u.avatar_url, x.created_at,
            ${equippedVisualSql('u')} AS equipped_visual
       FROM (
         SELECT user_id  AS other_id, created_at FROM friends WHERE friend_id = $1
         UNION
         SELECT friend_id AS other_id, created_at FROM friends WHERE user_id = $1 AND status = 'accepted'
       ) x
       JOIN users u ON u.user_id = x.other_id
      ORDER BY u.user_id, x.created_at DESC`,
    [req.params.id]
  );
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return res.json(rows);
}));

router.delete('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Hand off clan leadership BEFORE deleting the user. Otherwise the
  // CASCADE wipes their clan_members row but leaves the clan leaderless.
  // For each clan they currently lead, promote the longest-tenured remaining
  // member; if none, delete the orphaned clan.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ledClans } = await client.query(
      `SELECT clan_id FROM clan_members WHERE user_id = $1 AND role = 'leader' FOR UPDATE`,
      [req.userId]
    );
    for (const c of ledClans) {
      const { rows: heir } = await client.query(
        `SELECT user_id FROM clan_members
         WHERE clan_id = $1 AND user_id != $2
         ORDER BY joined_at ASC
         LIMIT 1`,
        [c.clan_id, req.userId]
      );
      if (heir.length) {
        await client.query(
          `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND user_id = $2`,
          [c.clan_id, heir[0].user_id]
        );
      } else {
        // Last member — clan dies with them.
        await client.query(`DELETE FROM clans WHERE clan_id = $1`, [c.clan_id]);
      }
    }
    await client.query(`DELETE FROM users WHERE user_id = $1`, [req.userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return res.json({ success: true });
}));

// Live in-progress round (if any). Returns null when:
//   - the user has no in-progress match with a teebox set
//   - the requesting viewer is in the same match (anti-cheat)
//   - the round has been idle for more than 4 hours (treat as paused —
//     keeps zombie tabs from showing as "playing now" indefinitely)
//   - the round was cancelled (auto-set by the cleanup cron after 24h idle)
// Returns the round info even if no hole_scores yet, so the friend's profile
// can show "PLAYING NOW" right when they pick a teebox.
router.get('/:id/active-round', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT mp.match_id, mp.user_id, mp.teebox_id, mp.side,
            r.round_id, r.hole_scores, r.hole_stats, r.created_at AS round_started_at,
            t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            t.course_id AS teebox_course_id,
            c.course_id, c.course_name,
            m.holes_subset,
            ARRAY(
              SELECT h.par FROM holes h
              WHERE h.teebox_id = mp.teebox_id
              ORDER BY h.hole_num ASC
            ) AS hole_pars,
            -- Last meaningful activity for this user on this match — pick
            -- the most recent of: round start, score updates (rounds.created_at),
            -- and shot tracking saves. Powers the 4h staleness gate.
            GREATEST(
              m.created_at,
              COALESCE(r.created_at, m.created_at),
              COALESCE((SELECT MAX(recorded_at)
                          FROM shots
                         WHERE match_id = mp.match_id AND user_id = mp.user_id),
                       m.created_at)
            ) AS last_activity_at
     FROM match_players mp
     JOIN matches m ON m.match_id = mp.match_id
     LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
     LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE mp.user_id = $1
       AND m.completed = false
       AND m.cancelled = false
       AND mp.completed = false
       AND m.is_practice = false
       AND mp.teebox_id IS NOT NULL
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [req.params.id]
  );

  // Pause the live status if no activity in the last 4 hours. The match
  // itself stays in-progress (player can resume by tracking another shot or
  // saving a score), but spectators stop seeing it as "live."
  if (rows.length) {
    const last = new Date(rows[0].last_activity_at);
    const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
    if (ageHours >= 4) return res.json(null);
  }
  if (!rows.length) return res.json(null);

  const active = rows[0];

  // Anti-cheat: hide the live scorecard from OPPONENTS in the same match
  // (different side). Same-side teammates pass through — they already
  // collaborate, and the match-lobby scorecard view already shows them
  // each other's progress, so spectator parity makes sense. Solo matches
  // (sides 1 and 2) and Arena (every player on their own side) both block
  // cleanly via the same-side check.
  if (req.userId !== req.params.id) {
    const { rows: shareRows } = await pool.query(
      `SELECT side FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [active.match_id, req.userId]
    );
    if (shareRows.length && shareRows[0].side !== active.side) {
      // Opponent in the SAME match. Normally hidden so nobody can scout a
      // live opponent before their own round is in. Friends are the trusted
      // exception: they've mutually agreed to be friends and can be relied on
      // not to game it, so an accepted friend always follows the round — even
      // one they're currently matched against. Non-friend opponents stay hidden.
      const { rows: fr } = await pool.query(
        `SELECT 1 FROM friends
          WHERE status = 'accepted'
            AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
          LIMIT 1`,
        [req.userId, req.params.id]
      );
      if (!fr.length) return res.json(null);
    }
  }

  // Normalise empty arrays so the frontend can safely call .length on them.
  if (!active.hole_scores) active.hole_scores = [];
  if (!active.hole_stats)  active.hole_stats = [];
  if (!active.hole_pars)   active.hole_pars  = [];

  // Lazy-create a `rounds` row so live spectators get a stable round_id to
  // attach reactions + comments to mid-round. Existing submitScores logic
  // upserts the same row on completion (UNIQUE on match_id+user_id), so the
  // placeholder graduates to a real round on submit without duplication.
  // Skip if we already have a row (round_id present) or if the viewer is the
  // owner themselves — the spectator path is what needs the id; the owner's
  // own client is happy reading hole_scores from the rounds table directly.
  if (!active.round_id && active.match_id && active.user_id && active.teebox_course_id) {
    try {
      const { rows: created } = await pool.query(
        `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, round_type)
         VALUES ($1, $2, $3, $4, '{}', 'live')
         ON CONFLICT (match_id, user_id) DO UPDATE SET match_id = EXCLUDED.match_id
         RETURNING round_id, created_at`,
        [active.match_id, active.user_id, active.teebox_course_id, active.teebox_id]
      );
      if (created.length) {
        active.round_id = created[0].round_id;
        // If we just created it, populate round_started_at from the new row.
        if (!active.round_started_at) active.round_started_at = created[0].created_at;
      }
    } catch { /* placeholder-create is best-effort — reactions/comments
                   simply stay disabled if it fails */ }
  }

  // teebox_course_id was an internal helper; don't surface it in the
  // response shape clients consume.
  delete active.teebox_course_id;

  return res.json(active);
}));

// WHS-style handicap index calculator from a player's last 20 rated rounds.
// Returns { handicap_index, num_rounds_used, total_rounds, differentials }
router.get('/:id/handicap', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: rounds } = await pool.query(
    `SELECT r.round_id, r.total_score, r.created_at, r.hole_scores,
            -- Holes actually played: the per-hole array length if present, else
            -- the MATCH's recorded hole count, and only then the teebox's. A
            -- 9-hole round entered as a total-only (no array) on an 18-hole
            -- teebox must NOT fall through to 18 — that was treating 9-hole
            -- rounds as 18 and wrecking the differential.
            COALESCE(array_length(r.hole_scores, 1), m.num_holes, t.num_holes) AS holes_played,
            t.course_rating, t.slope_rating, t.num_holes AS teebox_holes,
            t.front_course_rating, t.front_slope_rating,
            t.back_course_rating, t.back_slope_rating,
            m.holes_subset,
            t.name AS teebox_name, c.course_name
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL
       AND m.completed = true AND m.is_practice = false
       -- Handicap reflects SOLO play only. Team (duo/squad) scores are
       -- shared/scramble and Arena is multi-way, so they don't represent
       -- an individual's score-to-rating.
       AND m.match_type = 'solo'
       AND t.course_rating IS NOT NULL AND t.slope_rating IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT 20`,
    [req.params.id]
  );

  // Per-round score differential, via the shared (slope-guarded) helper so
  // the live view and the backfill always agree. See utils/handicap.ts.
  const differentials = rounds.map((r) => {
    const d = roundDifferential(r);
    return {
      round_id: r.round_id,
      created_at: r.created_at,
      total_score: r.total_score,
      course_name: r.course_name,
      teebox_name: r.teebox_name,
      holes_played: r.holes_played,
      course_rating_used: Math.round(d.rating * 10) / 10,
      slope_used: d.slope,
      differential: Math.round(d.diff * 10) / 10,
      is_nine_hole: r.holes_played === 9,
    };
  });

  // 9-hole rounds are scaled to their 18-hole EQUIVALENT (×2) for the index so
  // they pool fairly with 18-hole rounds. Without this, a 9-hole differential is
  // half-scale, so a bad 9 (e.g. 49 on a front nine) lands among a player's
  // *best* rounds and lowers the handicap instead of raising it. The per-round
  // `differential` shown in the list above stays the intuitive 9-hole figure.
  const { handicapIndex, useCount } = whsHandicapIndex(
    differentials.map((d) => (d.is_nine_hole ? d.differential * 2 : d.differential)),
  );

  return res.json({
    handicap_index: handicapIndex,
    num_rounds_used: useCount,
    total_rated_rounds: differentials.length,
    differentials,
  });
}));

/**
 * Import shots from a launch monitor (Flightscope, Trackman, etc.) into the
 * user's stats. Each entry needs at minimum a club + distance; lateral
 * dispersion is optional. We synthesize GPS coordinates from origin (an
 * arbitrary point) so the existing club-stats aggregator (which works in
 * GPS-space) treats them identically to on-course tracked shots.
 *
 * Body:  { name?: string, shots: [{ club, distance_yds, lateral_yds?, recorded_at? }, ...] }
 * Stores everything as a single is_practice match with hole_num=1.
 */
router.post('/me/import-shots', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { name, shots } = req.body ?? {};
  if (!Array.isArray(shots) || !shots.length) {
    return res.status(400).json({ error: 'shots array required' });
  }
  if (shots.length > 2000) {
    return res.status(413).json({ error: 'Too many shots (max 2000 per import)' });
  }

  // Synthesize GPS pair for a shot. Origin is fixed; each shot heads
  // "north" by its carry distance, with `lateral` yards of perpendicular
  // offset (positive = right). The aggregator computes haversine + bearing
  // in shot-local frame, so this matches on-course shot dispersion.
  const ORIGIN = { lat: 40.0, lng: -74.0 };
  const R = 6371000;
  const YDS_TO_M = 0.9144;
  const project = (start: { lat: number; lng: number }, bearingRad: number, distYds: number) => {
    const distM = distYds * YDS_TO_M;
    const sLat = start.lat * Math.PI / 180;
    const sLng = start.lng * Math.PI / 180;
    const eLat = Math.asin(
      Math.sin(sLat) * Math.cos(distM / R) +
      Math.cos(sLat) * Math.sin(distM / R) * Math.cos(bearingRad)
    );
    const eLng = sLng + Math.atan2(
      Math.sin(bearingRad) * Math.sin(distM / R) * Math.cos(sLat),
      Math.cos(distM / R) - Math.sin(sLat) * Math.sin(eLat)
    );
    return { lat: eLat * 180 / Math.PI, lng: eLng * 180 / Math.PI };
  };

  const cleaned: any[] = [];
  for (const s of shots) {
    const club = sanitizeClubCode(s?.club);
    if (!club) continue;
    const dist = Number(s?.distance_yds);
    if (!Number.isFinite(dist) || dist < 5 || dist > 500) continue;
    const lat = Number(s?.lateral_yds ?? 0);
    const lateral = Number.isFinite(lat) ? Math.max(-200, Math.min(200, lat)) : 0;
    // Tiny per-shot start jitter so identical-distance shots don't all collide.
    const startJitterBearing = Math.random() * 2 * Math.PI;
    const start = project(ORIGIN, startJitterBearing, 0.5);
    // Forward by distance (north), then perpendicular by lateral.
    const forward = project(start, 0, dist);
    const end = project(forward, Math.PI / 2, lateral);
    // Defensively validate recorded_at — clients can pass arbitrary CSV
    // cell values, and Postgres rejects anything that doesn't parse as a
    // timestamp. Fall back to "now" if it's missing or unparseable.
    let recorded_at = new Date().toISOString();
    if (typeof s?.recorded_at === 'string') {
      const t = Date.parse(s.recorded_at);
      if (Number.isFinite(t)) recorded_at = new Date(t).toISOString();
    }
    cleaned.push({
      club,
      start: { lat: start.lat, lng: start.lng },
      end:   { lat: end.lat,   lng: end.lng },
      recorded_at,
      // Persist the geometry directly so dispersion reads the real side-miss
      // (+ = right) instead of treating every imported shot as on-line.
      // total is the start→end hypotenuse: total² = carry² + lateral².
      lateral_yds: Math.round(lateral),
      total_yds: Math.round(Math.sqrt(dist * dist + lateral * lateral)),
    });
  }

  if (!cleaned.length) {
    return res.status(400).json({ error: 'No valid shots found in payload' });
  }

  // No match record needed any more — imported shots go directly into the
  // shots table with match_id = NULL and source = 'launch_monitor'. This
  // keeps them safe across match wipes and clearly distinguished from
  // GPS-tracked shots.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < cleaned.length; i++) {
      const s = cleaned[i];
      await client.query(
        `INSERT INTO shots (
           user_id, match_id, hole_num, shot_index,
           club, start_lat, start_lng, end_lat, end_lng, recorded_at, source,
           total_yds, lateral_yds, lateral_ref
         ) VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, 'launch_monitor', $9, $10, 'aim')`,
        [
          req.userId, i, s.club,
          s.start.lat, s.start.lng,
          s.end.lat,   s.end.lng,
          s.recorded_at,
          s.total_yds, s.lateral_yds,
        ]
      );
    }
    await client.query('COMMIT');
    return res.json({
      success: true,
      total_shots: cleaned.length,
      skipped: shots.length - cleaned.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /users/me/import-shots failed:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}));

// Avatar upload
router.post('/me/avatar', requireAuth, perUserRateLimit({ max: 10, windowMs: 60_000 }), wrap(async (req: AuthRequest, res: Response) => {
  const { imageBase64, mimeType } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // Whitelist MIME types — fall back is jpg
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg'
    : null;
  if (!ext) return res.status(400).json({ error: 'Only PNG and JPEG avatars are allowed' });
  // Decode and size-cap before touching disk (2 MB)
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'Invalid image data' });
  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Avatar must be 2 MB or smaller' });
  }
  const filename = `avatar_${req.userId}.${ext}`;
  const filepath = path.join(AVATARS_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  const avatarUrl = `/uploads/avatars/${filename}`;
  await pool.query(`UPDATE users SET avatar_url = $1 WHERE user_id = $2`, [avatarUrl, req.userId]);
  return res.json({ avatar_url: avatarUrl });
}));

// Notifications feed — all sources are filtered to the last 3 days; an unread_count
// is computed against the user's notifications_seen_at timestamp.
router.get('/me/notifications', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const notes: any[] = [];

  // Get user's seen-at timestamp for unread calculation
  const { rows: seenRows } = await pool.query(
    `SELECT notifications_seen_at FROM users WHERE user_id = $1`,
    [req.userId]
  );
  const seenAt = seenRows[0]?.notifications_seen_at ?? new Date(0);

  // Pending friend requests (3-day window)
  const { rows: frs } = await pool.query(
    `SELECT u.user_id, u.username, f.created_at FROM friends f
     JOIN users u ON u.user_id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'
       AND f.created_at > NOW() - INTERVAL '3 days'
     ORDER BY f.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of frs) notes.push({ type: 'friend_request', title: 'Friend Request', body: `${r.username} sent you a friend request`, data: { userId: r.user_id }, created_at: r.created_at });

  // Pending match invites (3-day window)
  const { rows: mis } = await pool.query(
    `SELECT mi.invite_id, mi.match_id, mi.created_at, u.username AS from_name, m.match_type
     FROM match_invites mi JOIN users u ON u.user_id = mi.from_user_id JOIN matches m ON m.match_id = mi.match_id
     WHERE mi.to_user_id = $1 AND mi.status = 'pending'
       AND mi.created_at > NOW() - INTERVAL '3 days'
       AND (mi.expires_at IS NULL OR mi.expires_at > NOW())
     ORDER BY mi.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mis) notes.push({ type: 'match_invite', title: 'Match Invite', body: `${r.from_name} invited you to a ${r.match_type} match`, data: { matchId: r.match_id, inviteId: r.invite_id }, created_at: r.created_at });

  // Pending clan invites (3-day window)
  try {
    const { rows: cis } = await pool.query(
      `SELECT ci.invite_id, ci.clan_id, ci.created_at, u.username AS from_name, c.name AS clan_name
       FROM clan_invites ci JOIN users u ON u.user_id = ci.from_user_id JOIN clans c ON c.clan_id = ci.clan_id
       WHERE ci.to_user_id = $1 AND ci.status = 'pending'
         AND ci.created_at > NOW() - INTERVAL '3 days'
       ORDER BY ci.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of cis) notes.push({ type: 'clan_invite', title: 'Team Invite', body: `${r.from_name} invited you to join ${r.clan_name}`, data: { clanId: r.clan_id, inviteId: r.invite_id }, created_at: r.created_at });
  } catch { /* table may not exist yet */ }

  // Recent match results (3-day window)
  const { rows: mrs } = await pool.query(
    `SELECT mr.match_id, mr.winner_side, mr.delta_elo, mr.created_at, m.match_type, mp.side AS my_side
     FROM match_results mr JOIN matches m ON m.match_id = mr.match_id
     JOIN match_players mp ON mp.match_id = m.match_id AND mp.user_id = $1
     WHERE mr.created_at > NOW() - INTERVAL '3 days' AND m.is_practice = false
     ORDER BY mr.created_at DESC LIMIT 10`,
    [req.userId]
  );
  for (const r of mrs) {
    const won = r.winner_side === r.my_side;
    notes.push({ type: 'match_result', title: won ? 'Victory!' : 'Defeat', body: won ? `You won your ${r.match_type} match (+${r.delta_elo} ELO)` : `You lost your ${r.match_type} match (-${r.delta_elo} ELO)`, data: { matchId: r.match_id }, created_at: r.created_at, won });
  }

  // Post @mentions — someone tagged this user in a feed post (3-day window).
  try {
    const { rows: mentions } = await pool.query(
      `SELECT pm.post_id, pm.created_at, au.username AS from_name
         FROM post_mentions pm
         JOIN posts p  ON p.post_id = pm.post_id
         JOIN users au ON au.user_id = pm.author_user_id
        WHERE pm.mentioned_user_id = $1
          AND pm.created_at > NOW() - INTERVAL '3 days'
        ORDER BY pm.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of mentions) notes.push({ type: 'mention', title: 'You were tagged', body: `${r.from_name} tagged you in a post`, data: { postId: r.post_id }, created_at: r.created_at });
  } catch { /* table may not exist on older deployments */ }

  // Post likes (3-day window). AGGREGATED per post so a popular post is ONE
  // bell row ("X and N others liked your post") instead of a flood — the bell
  // equivalent of the throttled push.
  try {
    const { rows: likes } = await pool.query(
      `SELECT p.post_id,
              COUNT(*)::int AS like_count,
              MAX(pl.created_at) AS created_at,
              (ARRAY_AGG(lu.username ORDER BY pl.created_at DESC))[1] AS last_liker
         FROM post_likes pl
         JOIN posts p  ON p.post_id = pl.post_id
         JOIN users lu ON lu.user_id = pl.user_id
        WHERE p.user_id = $1 AND pl.user_id != $1
          AND pl.created_at > NOW() - INTERVAL '3 days'
        GROUP BY p.post_id
        ORDER BY MAX(pl.created_at) DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of likes) {
      const others = r.like_count - 1;
      const body = others > 0
        ? `${r.last_liker} and ${others} other${others === 1 ? '' : 's'} liked your post`
        : `${r.last_liker} liked your post`;
      notes.push({ type: 'post_like', title: 'New like', body, data: { postId: r.post_id }, created_at: r.created_at });
    }
  } catch { /* post_likes may not exist on older deployments */ }

  // Replies to your comments — on a feed post (3-day window).
  try {
    const { rows: replies } = await pool.query(
      `SELECT child.post_id, child.created_at, au.username AS from_name
         FROM post_comments child
         JOIN post_comments parent ON parent.comment_id = child.parent_comment_id
         JOIN users au ON au.user_id = child.user_id
        WHERE parent.user_id = $1 AND child.user_id != $1
          AND child.created_at > NOW() - INTERVAL '3 days'
        ORDER BY child.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of replies) notes.push({ type: 'post_comment_reply', title: 'New reply', body: `${r.from_name} replied to your comment`, data: { postId: r.post_id }, created_at: r.created_at });
  } catch { /* parent_comment_id may not exist on older deployments */ }

  // Replies to your comments — on a round recap (3-day window).
  try {
    const { rows: rReplies } = await pool.query(
      `SELECT child.round_id, child.created_at, au.username AS from_name
         FROM round_comments child
         JOIN round_comments parent ON parent.comment_id = child.parent_comment_id
         JOIN users au ON au.user_id = child.user_id
        WHERE parent.user_id = $1 AND child.user_id != $1
          AND child.created_at > NOW() - INTERVAL '3 days'
        ORDER BY child.created_at DESC LIMIT 10`,
      [req.userId]
    );
    for (const r of rReplies) notes.push({ type: 'round_comment_reply', title: 'New reply', body: `${r.from_name} replied to your comment`, data: { roundId: r.round_id }, created_at: r.created_at });
  } catch { /* round_comments.parent_comment_id may not exist on older deployments */ }

  notes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Chat unreads — fold into the bell badge so the user sees an alert when a
  // chat push notification arrived for a conversation they haven't opened.
  // These are NOT cleared by the "mark notifications seen" action (the bell
  // tap) — only by actually opening the chat. Hence the separate count.
  let chatUnreadCount = 0;
  try {
    const { rows: chatRows } = await pool.query(
      `WITH dm_unread AS (
         SELECT 1 AS n
         FROM direct_messages dm
         LEFT JOIN chat_reads cr
                ON cr.user_id = $1 AND cr.kind = 'dm' AND cr.chat_key = dm.from_user_id
         WHERE dm.to_user_id = $1
           AND (cr.last_read_at IS NULL OR dm.created_at > cr.last_read_at)
         GROUP BY dm.from_user_id
       ),
       match_unread AS (
         SELECT 1 AS n
         FROM match_players mp
         JOIN messages m ON m.match_id = mp.match_id AND m.user_id != $1
         LEFT JOIN chat_reads cr
                ON cr.user_id = $1 AND cr.kind = 'match' AND cr.chat_key = mp.match_id
         WHERE mp.user_id = $1
         GROUP BY mp.match_id, cr.last_read_at
         HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')
       ),
       clan_unread AS (
         SELECT 1 AS n
         FROM clan_members cm
         JOIN messages m ON m.clan_id = cm.clan_id AND m.user_id != $1
         LEFT JOIN chat_reads cr
                ON cr.user_id = $1 AND cr.kind = 'clan' AND cr.chat_key = cm.clan_id
         WHERE cm.user_id = $1
         GROUP BY cm.clan_id, cr.last_read_at
         HAVING MAX(m.created_at) > COALESCE(MAX(cr.last_read_at), 'epoch')
       )
       SELECT
         (SELECT COUNT(*) FROM dm_unread)::int +
         (SELECT COUNT(*) FROM match_unread)::int +
         (SELECT COUNT(*) FROM clan_unread)::int
         AS total`,
      [req.userId]
    );
    chatUnreadCount = chatRows[0]?.total ?? 0;
  } catch { /* chat_reads table may not exist yet on older deployments */ }

  const baseUnread = notes.filter((n) => new Date(n.created_at) > new Date(seenAt)).length;
  // Bell badge counts ONLY actionable notifications (friend requests, match
  // invites, clan invites, match results). Chat unreads have their own
  // surface — the pulsing unread dots in the Social tab — and are NOT
  // cleared by tapping the bell. Folding them into `unread_count` made
  // the bell stick at 1+ whenever the user had any unread message in any
  // chat, with no way to clear it short of opening every chat. Now the
  // bell clears cleanly on tap; chat unreads continue to surface only in
  // their proper place. `chat_unread_count` is still returned for any
  // consumer that wants the combined view (e.g. an app-icon badge).
  return res.json({
    notifications: notes,
    unread_count: baseUnread,
    chat_unread_count: chatUnreadCount,
  });
}));

// Mark notifications as seen (resets the unread badge)
router.post('/me/notifications/seen', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  await pool.query(
    `UPDATE users SET notifications_seen_at = NOW() WHERE user_id = $1`,
    [req.userId]
  );
  return res.json({ success: true });
}));

/**
 * Adjust the lifetime "drinks drunk" tally by +/- delta. The user bumps this
 * by hand from their profile (the map-screen counter was retired). The count
 * is clamped to [0, 100000] so a runaway long-press can't drive it negative
 * or absurd. Returns the new total.
 */
router.post('/me/drinks', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const raw = Number((req.body ?? {}).delta);
  if (!Number.isFinite(raw) || raw === 0) {
    return res.status(400).json({ error: 'delta must be a non-zero number' });
  }
  // One tap = ±1; ignore any larger client-supplied magnitude to keep this
  // honest (no scripted bulk inflation).
  const delta = raw > 0 ? 1 : -1;
  const { rows } = await pool.query(
    `UPDATE users
        SET drinks = LEAST(100000, GREATEST(0, drinks + $2))
      WHERE user_id = $1
      RETURNING drinks`,
    [req.userId, delta]
  );
  return res.json({ drinks: rows[0]?.drinks ?? 0 });
}));

export default router;
