/**
 * Social feed — friend posts (+ a sprinkle of friends-of-friends) and the
 * compose endpoint that backs the in-app "share" surface. Three post kinds:
 *
 *   • 'round' — auto-inserted when a match completes; carries match_id so
 *               the card can render the score / opponent / course from the
 *               joined row instead of bloating the post itself
 *   • 'text'  — user-typed body (≤ 1 KB)
 *   • 'photo' — image upload (base64 → /uploads/feed/) with optional caption
 *
 * Feed visibility is friends-only by default. Each request mixes in up to
 * 20% friends-of-friends so the network gradually expands without exposing
 * randos. No reactions / comments in v1 — extending the existing
 * round_reactions pattern is the natural follow-up.
 */

import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';
import { sendPush } from '../utils/notify';
import { processMentions, hasEveryoneTag, broadcastToEveryone } from '../utils/mentions';
import { equippedVisualSql } from '../utils/cosmeticSql';
import { isOwner } from '../utils/owner';
import { persistCommentImage, unlinkCommentImage } from '../utils/commentImage';

const router = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const FEED_DIR = path.join(UPLOADS_DIR, 'feed');
if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;      // 4 MB raw — generous for phone photos
const MAX_BODY_LEN = 1000;                     // matches a tweet-and-a-half
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

// "Local" feed radius — an author counts as local if their home course sits
// within this many km of the viewer's center point (the viewer's own home
// course, or client-supplied GPS when provided). ~50 miles is a comfortable
// "courses near me" range without the feed going empty in rural areas.
const LOCAL_RADIUS_KM = 80;

/** POST /posts — create a text or photo post. Round posts are inserted
 *  server-side by the match-resolve path; clients can't manually mint them
 *  (kind='round' is rejected here so a malicious client can't fake a win). */
/** Best-effort unlink of a persisted feed image. Used to clean up after
 *  an INSERT failure so we don't leak files on disk for posts that never
 *  reached the database. */
function unlinkFeedImage(url: string | null | undefined) {
  if (!url?.startsWith('/uploads/feed/')) return;
  const fname = url.replace('/uploads/feed/', '');
  try { fs.unlinkSync(path.join(FEED_DIR, fname)); } catch { /* already gone, fine */ }
}

router.post('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { body, imageBase64, imageMime } = req.body ?? {};

  const text = typeof body === 'string' ? body.trim().slice(0, MAX_BODY_LEN) : '';

  // Image branch — decode + persist before INSERT so we have a URL to store.
  // We unlink on any failure below so a failed post doesn't leak the photo.
  let imageUrl: string | null = null;
  if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
    const ext = IMAGE_MIME_EXT[imageMime ?? ''];
    if (!ext) return res.status(400).json({ error: 'Unsupported image format' });
    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length === 0)       return res.status(400).json({ error: 'Invalid image data' });
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Image must be 4 MB or smaller' });
    }
    const filename = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(FEED_DIR, filename), buffer);
    imageUrl = `/uploads/feed/${filename}`;
  }

  // Either text OR image must be present — empty posts are useless.
  if (!text && !imageUrl) {
    // No image to clean up here (text-only path), but the guard is mirrored
    // for symmetry with the voice-message handler.
    if (imageUrl) unlinkFeedImage(imageUrl);
    return res.status(400).json({ error: 'body or image required' });
  }

  // @everyone broadcast — OWNERS ONLY. A normal user typing @everyone just
  // posts it as text (it resolves to no one). For an owner it flags the post
  // as an announcement (shown in every user's feed) and pushes all users.
  const wantsBroadcast = hasEveryoneTag(text) && await isOwner(req.userId);

  const kind = imageUrl ? 'photo' : 'text';
  let rows: any[];
  try {
    ({ rows } = await pool.query(
      `INSERT INTO posts (user_id, kind, body, image_url, is_announcement)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING post_id, user_id, kind, body, image_url, match_id, created_at, is_announcement`,
      [req.userId, kind, text || null, imageUrl, wantsBroadcast]
    ));
  } catch (err) {
    // INSERT failed — unlink the orphan image (if any) before re-throwing
    // to express's error handler so a failed post doesn't leak on disk.
    unlinkFeedImage(imageUrl);
    throw err;
  }
  // Tag anyone @mentioned in the body — records the mention + pushes them a
  // "tagged you" notification. Fire-and-forget; never blocks the response.
  if (text) processMentions(rows[0].post_id, req.userId!, text);
  // Owner @everyone → push every user. Fire-and-forget; never blocks.
  if (wantsBroadcast) broadcastToEveryone(rows[0].post_id, req.userId!, text);
  return res.status(201).json(rows[0]);
}));

/**
 * POST /posts/:id/report — flag a feed post for moderation. Mirrors the
 * find / message report flow: lightweight queue, no auto-action, dedup'd
 * per reporter via the UNIQUE constraint on post_reports.
 *
 * Required for App Store review (Apple UGC guideline 1.2) — every
 * user-content surface needs a report path. You can't report your own
 * post (nothing to moderate there) and the post must exist.
 */
router.post('/:id/report', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 500)
    : null;

  // Confirm the post exists + isn't the reporter's own. A 404 here also
  // covers "post was already deleted" — fine, nothing to report.
  const { rows } = await pool.query(
    `SELECT user_id FROM posts WHERE post_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Post not found' });
  if (rows[0].user_id === req.userId) {
    return res.status(400).json({ error: 'You cannot report your own post' });
  }

  await pool.query(
    `INSERT INTO post_reports (post_id, reporter_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, reporter_id) DO NOTHING`,
    [req.params.id, req.userId, reason]
  );
  return res.status(201).json({ success: true });
}));

/** DELETE /posts/:id — owner-only. Also unlinks the on-disk image. */
router.delete('/:id', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT image_url FROM posts WHERE post_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Post not found' });

  // Best-effort image cleanup before the row vanishes. Failing to unlink
  // doesn't block the delete — leaked file is preferable to a stuck post.
  const url = rows[0].image_url as string | null;
  if (url?.startsWith('/uploads/feed/')) {
    const fname = url.replace('/uploads/feed/', '');
    try { fs.unlinkSync(path.join(FEED_DIR, fname)); } catch { /* ignore */ }
  }
  await pool.query(`DELETE FROM posts WHERE post_id = $1`, [req.params.id]);
  return res.json({ success: true });
}));

/**
 * GET /feed — public feed of every player's recent posts, sorted newest
 * first. Tags each row with `relation` ('friend' | 'fof' | 'public') so
 * the client can attribute "via a friend" or similar, but does NOT filter
 * the result set by friendship — early-network users get a populated feed
 * full of example rounds from anyone on the platform.
 *
 *   ?limit=20         — default 20, max 50
 *   ?before=ISO       — for "older posts" pagination (created_at strictly less)
 *   ?scope=global     — everyone (default; unrecognised values fall back here)
 *   ?scope=friends    — self + accepted friends only
 *   ?scope=local      — self + authors whose home course is within
 *                       LOCAL_RADIUS_KM of the viewer; needs a center point
 *                       from ?lat=&lng= or the viewer's home course
 *   ?lat=&lng=        — optional GPS center for scope=local (overrides home
 *                       course; lets a travelling player see who's nearby)
 *
 * (The previous version capped non-friend content at 20% to keep the feed
 * intimate. We unlocked it because in practice users were landing on an
 * empty feed before they had a network to populate it — and now the scope
 * toggle lets a user opt back into a friends-only view explicitly.)
 */
router.get('/feed', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  // Cursor accepts either a plain ISO timestamp (legacy clients) or a
  // composite "ISO|post_id" form (current clients). The composite form is
  // stable across rows that share a created_at — without the tiebreak on
  // post_id, posts created in the same millisecond could be skipped or
  // duplicated across page boundaries.
  const beforeRaw = typeof req.query.before === 'string' ? req.query.before : null;
  let beforeIso: string | null = null;
  let beforeId: string | null = null;
  if (beforeRaw) {
    const [iso, id] = beforeRaw.split('|');
    if (iso) beforeIso = iso;
    if (id) beforeId = id;
  }

  // Scope filter — 'global' (default, everyone), 'friends' (self + accepted
  // friends only), or 'local' (self + authors whose home course is near the
  // viewer). Anything unrecognised falls back to 'global' so older clients
  // that don't send a scope keep working unchanged.
  const scopeRaw = typeof req.query.scope === 'string' ? req.query.scope : 'global';
  const scope: 'global' | 'local' | 'friends' =
    scopeRaw === 'friends' || scopeRaw === 'local' ? scopeRaw : 'global';

  // For 'local' we need a center point. Prefer client-supplied GPS (lets a
  // travelling player see who's around them right now); otherwise fall back
  // to the viewer's home course. If we end up with neither, 'local' returns
  // an empty set + a `localUnavailable` flag so the client can prompt the
  // user to set a home course instead of showing a bare "no posts" state.
  let centerLat: number | null = null;
  let centerLng: number | null = null;
  if (scope === 'local') {
    const latRaw = req.query.lat;
    const lngRaw = req.query.lng;
    if (typeof latRaw === 'string' && typeof lngRaw === 'string') {
      const la = Number(latRaw);
      const ln = Number(lngRaw);
      if (Number.isFinite(la) && Number.isFinite(ln)) { centerLat = la; centerLng = ln; }
    }
    if (centerLat == null) {
      const { rows: hc } = await pool.query(
        `SELECT c.latitude, c.longitude
           FROM users u
           JOIN courses c ON c.course_id = u.home_course_id
          WHERE u.user_id = $1`,
        [req.userId]
      );
      if (hc.length && hc[0].latitude != null && hc[0].longitude != null) {
        centerLat = Number(hc[0].latitude);
        centerLng = Number(hc[0].longitude);
      }
    }
  }

  // Build the WHERE clause and parameters. Composite cursor: "created_at
  // strictly older OR (same created_at AND post_id strictly less)" so the
  // ordering is total even on duplicate timestamps.
  let beforeClause = '';
  const params: any[] = [req.userId];
  if (beforeIso && beforeId) {
    params.push(beforeIso, beforeId);
    beforeClause = ` AND (p.created_at < $2 OR (p.created_at = $2 AND p.post_id < $3))`;
  } else if (beforeIso) {
    params.push(beforeIso);
    beforeClause = ` AND p.created_at < $2`;
  }

  // Scope clause (+ for 'local', the radius CTE). Param indexes are derived
  // from the live params array length so they stay correct whether or not
  // the before-cursor already consumed $2/$3.
  let scopeClause = '';
  let localCte = '';
  if (scope === 'friends') {
    scopeClause = ` AND (p.user_id = $1 OR p.user_id IN (SELECT uid FROM my_friends))`;
  } else if (scope === 'local' && centerLat != null && centerLng != null) {
    params.push(centerLat, centerLng, LOCAL_RADIUS_KM);
    const latIdx = params.length - 2;
    const lngIdx = params.length - 1;
    const radIdx = params.length;
    // Great-circle (haversine) distance from the center to each author's
    // home course. LEAST/GREATEST clamp the dot product into [-1, 1] so a
    // tiny floating-point overshoot can't make acos() return NaN.
    localCte = `,
     local_authors AS (
       SELECT u.user_id AS uid
         FROM users u
         JOIN courses hc ON hc.course_id = u.home_course_id
        WHERE hc.latitude IS NOT NULL AND hc.longitude IS NOT NULL
          AND 6371 * acos(LEAST(1, GREATEST(-1,
                cos(radians($${latIdx})) * cos(radians(hc.latitude)) *
                cos(radians(hc.longitude) - radians($${lngIdx})) +
                sin(radians($${latIdx})) * sin(radians(hc.latitude))
              ))) <= $${radIdx}
     )`;
    scopeClause = ` AND (p.user_id = $1 OR p.user_id IN (SELECT uid FROM local_authors))`;
  } else if (scope === 'local') {
    // Local requested but no center point available — return nothing rather
    // than silently falling back to a global feed.
    scopeClause = ` AND FALSE`;
  }

  params.push(limit);

  // One pass over the public timeline, with per-row friendship attribution
  // computed in-SQL so the client can render a small "via a friend" tag
  // on FoF posts without us having to do post-processing in JS. Bidirectional
  // friendship: a row in `friends` can live with the requester as either
  // user_id or friend_id depending on who sent the request.
  const { rows } = await pool.query(
    `WITH my_friends AS (
       SELECT friend_id AS uid FROM friends WHERE user_id = $1 AND status = 'accepted'
       UNION
       SELECT user_id   AS uid FROM friends WHERE friend_id = $1 AND status = 'accepted'
     ),
     fof AS (
       -- 2-hop reach, excluding self and direct friends. The DISTINCT keeps
       -- the IN-list bounded even when a popular player connects many of
       -- the requester's friends.
       SELECT DISTINCT f2.friend_id AS uid
         FROM friends f1
         JOIN friends f2 ON f2.user_id = f1.friend_id
        WHERE f1.user_id = $1 AND f1.status = 'accepted' AND f2.status = 'accepted'
       UNION
       SELECT DISTINCT f2.user_id AS uid
         FROM friends f1
         JOIN friends f2 ON f2.friend_id = f1.friend_id
        WHERE f1.user_id = $1 AND f1.status = 'accepted' AND f2.status = 'accepted'
     )${localCte}
     SELECT
       p.post_id, p.user_id, p.kind, p.body, p.image_url, p.match_id, p.created_at,
       p.is_announcement,
       u.username AS author_username, u.avatar_url AS author_avatar,
       ${equippedVisualSql('u')} AS author_equipped,
       m.match_type, m.format, m.completed AS match_completed,
       -- num_holes + holes_subset on the MATCH (what was actually played)
       -- so a 9-hole round of an 18-hole teebox is shown against the right
       -- par on the feed card. Without these, RoundCardBody computed
       -- strokes minus teebox_par directly and a real 9-hole score read
       -- as wildly under par (e.g. 41 strokes vs 72 teebox par → "-31").
       -- Always include them even when the values match the teebox so
       -- the frontend can pro-rate par confidently.
       m.num_holes AS match_num_holes,
       m.holes_subset AS match_holes_subset,
       mr.winner_side, mr.delta_elo,
       -- The post AUTHOR's own signed ELO change for this match. Drives the
       -- win/loss label per person — essential for Arena (FFA), where everyone
       -- shares a side so winner_side would mark the whole field a winner.
       -- Gained ELO → win, lost → loss. Null for legacy rows (card falls back
       -- to winner_side vs author_side).
       -- p.user_id is a uuid; the jsonb ->>/-> operators only accept a text
       -- (or int) key, and Postgres won't implicitly cast uuid->text, so the
       -- key MUST be ::text or the whole query fails to compile with
       -- "operator does not exist: jsonb ->> uuid" (a 500 on every feed load).
       -- The jsonb_typeof guard then makes the ::float cast bulletproof: a
       -- missing or non-numeric playerDeltas entry yields NULL instead of
       -- "invalid input syntax for type double precision".
       CASE WHEN jsonb_typeof(mr.details -> 'playerDeltas' -> p.user_id::text) = 'number'
            THEN (mr.details -> 'playerDeltas' ->> p.user_id::text)::float
       END AS author_elo_delta,
       mp_me.side  AS author_side,
       mp_me.strokes AS author_strokes,
       t.name AS teebox_name, t.par AS teebox_par, t.num_holes AS teebox_num_holes,
       -- Holes the author ACTUALLY played (their hole_scores length). The card
       -- pro-rates par by this, not match.num_holes, since the two can disagree
       -- (e.g. an 18-hole round on a match record that says 9 holes).
       array_length(r_me.hole_scores, 1) AS author_holes_played,
       -- Sum of the par of the actual holes the author played, computed
       -- identically to how the scorecard / round-recap modal does it
       -- (see components/Scorecard.tsx buildGridData). Sums teebox holes
       -- across the played slice:
       --     full / front 9 → hole_num 1 .. N
       --     back 9         → hole_num 10 .. 9 + N
       -- where N = array_length(hole_scores, 1).
       -- Using the per-hole pars (not pro-rating teebox.par by hole count)
       -- removes a whole class of feed-vs-recap mismatches — every previous
       -- "post shows +23 when the recap says +3" bug came from the pro-rate
       -- shortcut disagreeing with the recap's hole-by-hole sum on edge
       -- data (asymmetric nines, partial hole_scores, stale match.num_holes).
       (SELECT SUM(h.par)::int
          FROM holes h
         WHERE h.teebox_id = mp_me.teebox_id
           AND h.hole_num >= CASE WHEN m.holes_subset = 'back' THEN 10 ELSE 1 END
           AND h.hole_num <  CASE WHEN m.holes_subset = 'back' THEN 10 ELSE 1 END
                           + COALESCE(array_length(r_me.hole_scores, 1),
                                      t.num_holes, m.num_holes, 18)
       ) AS author_played_par,
       c.course_name,
       -- Comment count so the card can show "💬 N" without an extra
       -- round-trip per post. Cheap correlated subquery; the
       -- (post_id, created_at) index covers it.
       (SELECT COUNT(*)::int FROM post_comments pc WHERE pc.post_id = p.post_id) AS comment_count,
       CASE
         WHEN p.user_id = $1                       THEN 'self'
         WHEN p.user_id IN (SELECT uid FROM my_friends) THEN 'friend'
         WHEN p.user_id IN (SELECT uid FROM fof)        THEN 'fof'
         ELSE 'public'
       END AS relation,
       -- Kept for backward compat with mobile clients that still read
       -- is_fof directly. Drop after the next mobile release.
       (p.user_id IN (SELECT uid FROM fof)
        AND p.user_id NOT IN (SELECT uid FROM my_friends)
        AND p.user_id != $1) AS is_fof
     FROM posts p
     JOIN users u ON u.user_id = p.user_id
     LEFT JOIN matches m         ON m.match_id = p.match_id
     LEFT JOIN match_results mr  ON mr.match_id = p.match_id
     LEFT JOIN match_players mp_me ON mp_me.match_id = p.match_id AND mp_me.user_id = p.user_id
     LEFT JOIN rounds r_me         ON r_me.match_id = p.match_id AND r_me.user_id = p.user_id
     LEFT JOIN teeboxes t        ON t.teebox_id = mp_me.teebox_id
     LEFT JOIN courses c         ON c.course_id = t.course_id
     -- Bots never appear in the feed. They play and rank like real players but
     -- don't author posts; this read-layer filter is the hard guarantee, so a
     -- stray bot post from ANY code path can never surface here (no more
     -- deleting them by hand after every deploy).
     -- Owner @everyone announcements bypass the scope filter so they reach
     -- every user's feed; everything else honors friends / local scope.
     WHERE u.is_bot = false
       AND (TRUE${scopeClause} OR p.is_announcement = TRUE)${beforeClause}
     ORDER BY p.created_at DESC, p.post_id DESC
     LIMIT $${params.length}`,
    params
  );

  return res.json({
    posts: rows,
    scope,
    // True when 'local' was requested but we had no center point to anchor
    // it — the client shows "set a home course" guidance instead of a
    // generic empty state.
    localUnavailable: scope === 'local' && centerLat == null,
  });
}));

// ─── Post comments ───────────────────────────────────────────────────────
// Mirrors the round_comments endpoints in rounds.ts. Anyone who can see the
// post (i.e. it's in their feed) can comment — we don't re-run the feed
// audience query here; the post being fetchable is enough, and the feed
// already gates who sees what. Comments themselves are public to anyone
// viewing the post.

// GET /posts/:id/comments → list, oldest first, each flagged `mine`.
router.get('/:id/comments', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.comment_id, c.user_id, u.username, u.avatar_url, c.body, c.created_at, c.client_id,
            c.parent_comment_id, c.image_url,
            (c.user_id = $2) AS mine,
            ${equippedVisualSql('u')} AS equipped_visual
       FROM post_comments c
       JOIN users u ON u.user_id = c.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC`,
    [req.params.id, req.userId]
  );
  return res.json(rows);
}));

// POST /posts/:id/comments  body: { body, clientId? }
router.post('/:id/comments', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const body = (req.body?.body ?? '').toString().trim().slice(0, 280);
  // Optional image attachment (camera roll). A comment needs text OR an image.
  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const imageMime = typeof req.body?.imageMime === 'string' ? req.body.imageMime : 'image/jpeg';
  if (!body && !imageBase64) return res.status(400).json({ error: 'body or image required' });
  // Client-generated idempotency key — same contract as chat sends. A retry
  // after an ambiguous network failure (request landed, response lost)
  // carries the same clientId; the partial unique index collapses it onto
  // the original row and we return that row instead of double-posting.
  const clientId = typeof req.body?.clientId === 'string' && req.body.clientId.length > 0
    ? req.body.clientId.slice(0, 64)
    : null;
  // One-level threading: a reply targets a top-level comment. Resolved below.
  const rawParentId = typeof req.body?.parentCommentId === 'string' && req.body.parentCommentId.length > 0
    ? req.body.parentCommentId
    : null;

  // Verify the post exists + grab the owner for the push.
  const { rows: postRows } = await pool.query(
    `SELECT p.user_id AS owner_id, owner.push_token, owner.username AS owner_name,
            actor.username AS actor_name
       FROM posts p
       JOIN users owner ON owner.user_id = p.user_id
       JOIN users actor ON actor.user_id = $2
      WHERE p.post_id = $1`,
    [req.params.id, req.userId]
  );
  if (!postRows.length) return res.status(404).json({ error: 'post not found' });
  const post = postRows[0];

  // Normalize the reply target to a TOP-LEVEL comment on this post so threads
  // never nest past one level: replying to a reply attaches to that reply's
  // parent. An unknown/foreign parent silently degrades to a top-level comment.
  let parentId: string | null = null;
  if (rawParentId) {
    const { rows: pc } = await pool.query(
      `SELECT comment_id, parent_comment_id FROM post_comments WHERE comment_id = $1 AND post_id = $2`,
      [rawParentId, req.params.id]
    );
    if (pc.length) parentId = pc[0].parent_comment_id ?? pc[0].comment_id;
  }

  // Persist the image before the INSERT; unlink it if the row never lands.
  let image: { url: string } | null = null;
  if (imageBase64) {
    const result = persistCommentImage(imageBase64, imageMime);
    if ('error' in result) return res.status(400).json({ error: result.error });
    image = result;
  }

  let rows: any[];
  try {
    ({ rows } = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, body, client_id, parent_comment_id, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING comment_id, created_at, client_id, parent_comment_id, image_url`,
      [req.params.id, req.userId, body, clientId, parentId, image?.url ?? null]
    ));
  } catch (err) {
    if (image) unlinkCommentImage(image.url);
    throw err;
  }
  if (!rows.length && clientId) {
    // Duplicate retry — the original comment already landed. Drop the freshly
    // written (now-orphan) image, return the original, skip push + mentions.
    if (image) unlinkCommentImage(image.url);
    const { rows: existing } = await pool.query(
      `SELECT comment_id, created_at, client_id, parent_comment_id, image_url FROM post_comments
       WHERE user_id = $1 AND client_id = $2`,
      [req.userId, clientId]
    );
    if (existing.length) {
      return res.json({
        success: true,
        comment_id: existing[0].comment_id,
        created_at: existing[0].created_at,
        client_id: existing[0].client_id,
        parent_comment_id: existing[0].parent_comment_id,
        image_url: existing[0].image_url,
      });
    }
    return res.status(409).json({ error: 'Duplicate send' });
  }

  // Notify the post owner (fire-and-forget). Skip if commenting on your
  // own post or the owner has no push token.
  if (post.owner_id !== req.userId && post.push_token) {
    const preview = body
      ? (body.length > 100 ? body.slice(0, 97) + '…' : body)
      : 'Sent a photo';
    sendPush(
      [post.push_token],
      `${post.actor_name} commented on your post`,
      preview,
      { type: 'post_comment', postId: req.params.id, commentId: rows[0].comment_id, fromUserId: req.userId },
    ).catch(() => { /* swallow — push is best-effort */ });
  }

  // Tag anyone @mentioned in the comment. Records the mention + pushes them a
  // "tagged you" notification that routes to the feed (the post is publicly
  // viewable, so anyone can be mentioned). Fire-and-forget. Image-only comments
  // have no text to scan.
  if (body) processMentions(req.params.id, req.userId!, body);

  return res.json({
    success: true,
    comment_id: rows[0].comment_id,
    created_at: rows[0].created_at,
    client_id: rows[0].client_id,
    parent_comment_id: rows[0].parent_comment_id,
    image_url: rows[0].image_url,
  });
}));

// DELETE /posts/:id/comments/:commentId — your own comment, OR the post
// owner can remove any comment on their post (basic moderation).
router.delete('/:id/comments/:commentId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rowCount } = await pool.query(
    `DELETE FROM post_comments c
      USING posts p
      WHERE c.comment_id = $1
        AND c.post_id = $2
        AND p.post_id = c.post_id
        AND (c.user_id = $3 OR p.user_id = $3)`,
    [req.params.commentId, req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found or not yours' });
  return res.json({ success: true });
}));

export default router;
