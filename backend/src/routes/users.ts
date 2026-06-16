import { Router, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db/pool';
import { requireAuth, requirePremium, AuthRequest } from '../middleware/auth';
import { sendPush } from '../utils/notify';
import { wrap } from '../utils/asyncHandler';
import { aggregateSG, Shot, Lie } from '../utils/sg';
import { OPEN_BETA_PREMIUM } from '../utils/openBeta';
import { equippedVisualSql } from '../utils/cosmeticSql';
import { roundDifferential, whsHandicapIndex } from '../utils/handicap';
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
            u.clubs_in_bag, u.censor_offensive_language, u.share_to_twitter,
            u.equipped_border, u.equipped_background, u.equipped_username,
            u.equipped_ball_trail, u.equipped_fx,
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
  }
  return res.json(row);
}));

router.patch('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { pushToken, handicapIndex, username, bio, homeCourseId, theme, clubsInBag, censorOffensiveLanguage, shareToTwitter, themeSongMaxVolume } = req.body;
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

  // Clubs-in-bag — array of `{ code, label? }` entries. Each `code` must
  // be in the ALLOWED_CLUBS whitelist (so analytics never sees a phantom
  // category); `label` is optional free-form display text (e.g. "TaylorMade
  // Stealth" or "Vokey 56°") up to 30 chars. Null clears the override
  // (back to "all clubs eligible").
  //
  // Backwards-compatible: also accepts the legacy `string[]` form (just
  // codes) from older clients — auto-converted to `{code}` entries server-side.
  if (clubsInBag !== undefined) {
    if (clubsInBag === null) {
      updates.push(`clubs_in_bag = NULL`);
    } else if (Array.isArray(clubsInBag)) {
      const ALLOWED = new Set([
        'driver', '3w', '5w', '7w', 'hybrid',
        '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i',
        'pw', 'gw', 'sw', 'lw', 'putter',
      ]);
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
        if (!code || !ALLOWED.has(code)) continue;
        cleaned.push(label ? { code, label } : { code });
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

// Aggregated stats from a player's completed rounds. Computes a simplified
// 4-category strokes-gained model relative to a "scratch baseline" where a
// hole = (par − 2) full swings to the green + 2 putts. Each component is
// designed so the four categories sum to (par − strokes), matching score-vs-par.
//
//   SG: Putting       = 2 − putts
//   SG: Around-Green  = chips > 0 ? (1 − chips) : 0
//                       (1 chip baseline when off-green; 0 contribution when GIR.
//                        Driving a par-4 green and chipping → GIR + 1 chip is fine,
//                        the chip is the "around-green" stroke and SG_ATG = 0)
//   SG: Approach      = gir ? 0 : −1
//                       (missing the green = a forced extra stroke, attributed here)
//   SG: Off-the-Tee   = (par − strokes) − SG_putting − SG_around_green − SG_approach
//                       (the residual: any strokes saved/lost beyond what the other
//                        three categories account for. Captures eagle-able drives,
//                        first-shot disasters, and par-5 reach-in-2 bonuses.)
//
// Holes without putts AND chips AND gir tracked are excluded from SG averaging
// so old untracked rounds don't dilute new data.
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

  // Skill baseline: instead of measuring SG vs. scratch (par), we measure
  // vs. the player's own handicap-adjusted expectation. A 20-cap shooting
  // 92 on par 72 should see "+0 SG" — they played to their level — not
  // "−20 SG". Course-specific scoring averages would be better but we
  // don't have enough rounds per course to estimate one, so handicap is
  // the cleanest skill-level generalization.
  //
  // Per-hole expected strokes = par + (handicap_index / 18). Players with
  // no stored handicap (brand new accounts) fall back to scratch baseline.
  const { rows: userRows } = await pool.query(
    `SELECT handicap_index FROM users WHERE user_id = $1`,
    [req.params.id]
  );
  const handicapIndex: number = typeof userRows[0]?.handicap_index === 'number'
    ? userRows[0].handicap_index
    : 0;
  const expectedExtraPerHole = handicapIndex / 18;

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

  // SG aggregators — 4 categories. Only over holes with full stat tracking.
  let sgHoles = 0;
  let sgPutting = 0;
  let sgAroundGreen = 0;
  let sgApproach = 0;
  let sgOffTee = 0;
  let sgTotal = 0;

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

      // 4-category basic SG — needs putts, chips AND gir tracked.
      // Baselines (Shotscope-style simplified) measured against the
      // player's HANDICAP-ADJUSTED expectation, not raw par. This means a
      // 20-cap who plays to their handicap sees ~0 SG total, and a tour-
      // pro-level player would see +20 SG on the same scorecard.
      //
      //   • Putting baseline = 2 if the player reached the green (GIR), else 1.
      //     If the player chipped on, they're effectively in 1-putt territory, so
      //     2-putting a chip = 0 SG (par for that recovery), 1-putt = +1, 3-putt = −1.
      //   • Around-Green baseline = 1 chip (when chips > 0).
      //   • Approach baseline = GIR (gir = 0 SG, missed green = −1).
      //   • Off-the-Tee = residual so the four sum to (expected − strokes),
      //     where expected = par + (handicap_index / 18).
      //
      // We keep the putting / around / approach baselines unchanged — they
      // measure short-game skill in absolute terms (a 1-putt is a 1-putt
      // regardless of handicap). The handicap shift is absorbed entirely
      // by the Off-the-Tee residual, which is by far the noisiest signal
      // anyway. That keeps the short-game categories interpretable.
      if (putts !== null && chips !== null && gir !== null) {
        sgHoles += 1;
        const expectedStrokes = par + expectedExtraPerHole;
        const puttBaseline = chips > 0 ? 1 : 2;
        const putt = puttBaseline - putts;
        const around = chips > 0 ? (1 - chips) : 0;
        const approach = gir ? 0 : -1;
        const tee = (expectedStrokes - strokes) - putt - around - approach;
        sgPutting += putt;
        sgAroundGreen += around;
        sgApproach += approach;
        sgOffTee += tee;
        sgTotal += (expectedStrokes - strokes);
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
    sg_holes: sgHoles,
    sg_per_round: sgHoles && roundsCount
      ? {
          off_tee:      round((sgOffTee      / sgHoles) * (holesPlayed / roundsCount)),
          approach:     round((sgApproach    / sgHoles) * (holesPlayed / roundsCount)),
          around_green: round((sgAroundGreen / sgHoles) * (holesPlayed / roundsCount)),
          putting:      round((sgPutting     / sgHoles) * (holesPlayed / roundsCount)),
          total:        round((sgTotal       / sgHoles) * (holesPlayed / roundsCount)),
        }
      : null,
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
    // Club distances/dispersion reflect SOLO play only — a scramble shot
    // isn't necessarily the player's own ball, and team/arena play
    // shouldn't skew an individual's club profile. Shots from deleted
    // matches (match_id NULL) drop out of the inner join, which is fine:
    // we can't confirm they were solo.
    `SELECT s.shot_id, s.club, s.start_lat, s.start_lng, s.end_lat, s.end_lng,
            s.plays_like_yds, s.recorded_at, s.total_yds, s.lateral_yds
       FROM shots s
       JOIN matches m ON m.match_id = s.match_id
      WHERE s.user_id = $1
        AND m.match_type = 'solo'
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

    clubs.push({
      club,
      shots: vecs.length,
      avg_yds:    Math.round(statYds.reduce((a, b) => a + b, 0) / statYds.length),
      median_yds: Math.round(medYds),
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
 * Premium-gated — this is the kind of detailed analysis that drives
 * subscription conversion for serious-improvement-oriented players.
 */
router.get('/:id/shot-stats', requireAuth, requirePremium, wrap(async (req: AuthRequest, res: Response) => {
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
       JOIN rounds r ON r.match_id = s.match_id AND r.user_id = s.user_id
       JOIN holes  h ON h.teebox_id = r.teebox_id AND h.hole_num = s.hole_num
      WHERE s.user_id = $1
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
  // Scratch make% baseline from Mark Broadie's PGA Tour data. Numbers are
  // approximate but widely cited. Used by the client to render "you vs
  // scratch" comparison bars.
  const SCRATCH_MAKE_PCT: Record<string, number> = {
    '0-3 ft':   99,
    '4-6 ft':   73,
    '7-10 ft':  41,
    '11-15 ft': 22,
    '16-25 ft': 11,
    '26+ ft':   4,
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
  // Scratch proximity baseline, also from Broadie. Reported in FEET because
  // the typical golfer thinks of "proximity" in feet, not yards.
  const SCRATCH_PROXIMITY_FT: Record<string, number> = {
    '<50 yd (chip)': 18,
    '50-100 yd':     22,
    '100-150 yd':    32,
    '150-200 yd':    49,
    '200+ yd':       72,
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
  // Group rows from the new shots table by (match_id, hole_num) and join
  // each group with its round + teebox holes for pin coordinates.
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
    [req.params.id]
  );

  if (!rows.length) return res.json({ shots_used: 0, sg_per_round: null, holes_used: 0, rounds_used: 0 });

  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const haversineYds = (a: any, b: any) => {
    if (a?.lat == null || b?.lat == null) return null;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return (2 * R * Math.asin(Math.sqrt(h))) * 1.0936;
  };

  const allShots: Shot[] = [];
  const holeIdsSeen = new Set<string>();
  const matchIdsSeen = new Set<string>();

  // Normalize either format into a flat list of {start, end, club, lie} tuples
  // per hole. The new segment format is canonical; legacy points get paired.
  const toSegments = (raw: any[]): { start: any; end: any; club?: string; lie?: string }[] => {
    if (!raw.length) return [];
    if (raw[0]?.start && raw[0]?.end) {
      return raw
        .filter((s: any) => s?.start && s?.end)
        .map((s: any) => ({ start: s.start, end: s.end, club: s.club, lie: s.lie }));
    }
    const out: { start: any; end: any; club?: string; lie?: string }[] = [];
    for (let i = 0; i < raw.length - 1; i++) {
      out.push({ start: raw[i], end: raw[i + 1], club: raw[i]?.club, lie: raw[i]?.lie });
    }
    return out;
  };

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

      // Start lie: prefer player tag, else infer.
      const startLie: Lie = (seg.lie as Lie) ?? (i === 0 ? 'tee' : 'fairway');

      // End lie/distance: holed out on the last shot if scorecard total matches.
      let endLie: Lie;
      let endDist: number;
      if (isLast && typeof holed === 'number' && segments.length === holed) {
        endLie = 'green';
        endDist = 0;
      } else if (endDist0 != null) {
        endLie = endDist0 < 30 ? 'green' : 'fairway';
        endDist = endDist0 < 3 ? 0 : endDist0;
      } else {
        // No usable end distance — skip this shot entirely.
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

    holeIdsSeen.add(`${row.match_id}:${row.hole_num}`);
    matchIdsSeen.add(row.match_id);
  }

  if (!allShots.length) {
    return res.json({ shots_used: 0, sg_per_round: null, holes_used: 0, rounds_used: 0 });
  }

  const totals = aggregateSG(allShots);
  const holesUsed = holeIdsSeen.size;
  const roundsUsed = matchIdsSeen.size;
  const round = (n: number) => Math.round(n * 100) / 100;

  // Per-round = total SG × (18 / holes_used). Crude but interpretable.
  const norm = holesUsed > 0 ? 18 / holesUsed : 0;
  return res.json({
    shots_used: totals.shots_used,
    holes_used: holesUsed,
    rounds_used: roundsUsed,
    sg_per_round: {
      off_tee:      round(totals.off_tee      * norm),
      approach:     round(totals.approach     * norm),
      around_green: round(totals.around_green * norm),
      putting:      round(totals.putting      * norm),
      total:        round(totals.total        * norm),
    },
  });
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
    return res.json(rows);
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
    return res.json(rows);
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
  return res.json(rows);
}));

router.get('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.elo, u.total_matches, u.total_wins, u.total_ties,
            u.avatar_url, u.created_at,
            u.bio, u.home_course_id, u.drinks,
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
  // so they don't represent an individual's round. Par is pro-rated to the
  // holes the player actually completed — without this, a 9-hole 41 on a par-72
  // teebox looks like a -31 round and beats every legitimate 18-hole entry. The
  // same expression is used in SELECT and ORDER BY so the lowest-differential
  // round actually wins.
  const { rows: bestRows } = await pool.query(
    `SELECT r.round_id, r.match_id, r.total_score, r.created_at, r.hole_scores, r.hole_stats,
            t.teebox_id, t.name AS teebox_name, t.par AS teebox_par, t.num_holes,
            c.course_id, c.course_name,
            (r.total_score
              - ROUND(t.par::numeric
                      * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                      / NULLIF(t.num_holes, 0)::numeric)::int) AS to_par
     FROM rounds r
     JOIN matches m ON m.match_id = r.match_id
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.user_id = $1 AND r.total_score IS NOT NULL AND m.completed = true AND t.par IS NOT NULL
       AND m.is_practice = false AND m.match_type = 'solo'
     ORDER BY (r.total_score
                - ROUND(t.par::numeric
                        * COALESCE(array_length(r.hole_scores, 1), t.num_holes)::numeric
                        / NULLIF(t.num_holes, 0)::numeric)::int) ASC
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

  return res.json({
    ...userInfo,
    recent_rounds: recentRounds,
    best_round: bestRows[0] ?? null,
    following_count: followCounts[0]?.following_count ?? 0,
    followers_count: followCounts[0]?.followers_count ?? 0,
    friendship_status: friendshipStatus,
    drinks,
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
      return res.json(null);
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

  const ALLOWED_CLUBS = new Set([
    'driver', '3w', '5w', '7w', 'hybrid',
    '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i',
    'pw', 'gw', 'sw', 'lw', 'putter',
  ]);

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
    const club = typeof s?.club === 'string' ? s.club.toLowerCase() : null;
    if (!club || !ALLOWED_CLUBS.has(club)) continue;
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
router.post('/me/avatar', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
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
