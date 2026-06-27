import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';
import { perUserRateLimit } from '../utils/rateLimit';
import { sendPush } from '../utils/notify';
import { persistCommentImage, unlinkCommentImage } from '../utils/commentImage';

const router = Router();

// Resolve the recipient (round owner) + reactor name + course name for a push.
// Returns null when there's nothing actionable (round not found, you're
// reacting on your own round, or the owner has no push token).
async function pushTargetFor(roundId: string, actorUserId: string) {
  const { rows } = await pool.query(
    `SELECT r.user_id AS owner_id, u.push_token, u.username AS owner_name,
            actor.username AS actor_name,
            c.course_name
     FROM rounds r
     JOIN users u ON u.user_id = r.user_id
     JOIN users actor ON actor.user_id = $2
     LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
     LEFT JOIN courses c ON c.course_id = t.course_id
     WHERE r.round_id = $1`,
    [roundId, actorUserId]
  );
  const row = rows[0];
  if (!row || row.owner_id === actorUserId || !row.push_token) return null;
  return row;
}

// Reactions are now free-form emojis. Old token-style values ('fire',
// 'pure', etc.) remain valid for back-compat with previously stored rows.
// New reactions just need to be a short emoji-like string — see
// isValidReaction below.
const LEGACY_TOKENS = new Set(['fire', 'pure', 'respect', 'oof', 'goat', 'clutch']);

/** Accept any short string that's either a legacy token (back-compat) or
 *  contains at least one non-ASCII character (almost certainly an emoji).
 *  Cap length so an attacker can't fill a row with a megabyte of unicode.
 *  16 chars covers even multi-codepoint ZWJ family emojis with skin-tone
 *  modifiers (e.g. 👨‍👩‍👧‍👦 is 11 code units). */
function isValidReaction(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length < 1 || s.length > 16) return false;
  if (LEGACY_TOKENS.has(s)) return true;
  // At least one non-ASCII codepoint = treat as emoji. Plain "lol" rejects.
  return /[^\x00-\x7F]/.test(s);
}

// GET reactions + comments for a round
//   Returns { reactions: [{ reaction, count, mine }], comments: [{ comment_id, user_id, username, body, created_at, mine }] }
router.get('/:roundId/social', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows: rxRows } = await pool.query(
    `SELECT reaction, COUNT(*)::int AS count,
            BOOL_OR(user_id = $2) AS mine
     FROM round_reactions
     WHERE round_id = $1
     GROUP BY reaction
     ORDER BY count DESC, reaction`,
    [req.params.roundId, req.userId]
  );
  // Cap at the 200 most-recent comments (returned oldest-first) so a busy round
  // recap can't return an unbounded comment set on every fetch.
  const { rows: cmRows } = await pool.query(
    `SELECT * FROM (
       SELECT c.comment_id, c.user_id, u.username, c.body, c.created_at, c.client_id,
              c.parent_comment_id, c.image_url,
              (c.user_id = $2) AS mine,
              (SELECT COUNT(*)::int FROM round_comment_likes rcl WHERE rcl.comment_id = c.comment_id) AS like_count,
              EXISTS(SELECT 1 FROM round_comment_likes rcl WHERE rcl.comment_id = c.comment_id AND rcl.user_id = $2) AS liked
       FROM round_comments c
       JOIN users u ON u.user_id = c.user_id
       WHERE c.round_id = $1
       ORDER BY c.created_at DESC
       LIMIT 200
     ) t
     ORDER BY t.created_at ASC`,
    [req.params.roundId, req.userId]
  );
  return res.json({ reactions: rxRows, comments: cmRows });
}));

// Toggle a reaction on a round (add if absent, remove if present)
//   body: { reaction: 'fire' }
router.post('/:roundId/reactions', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  // Don't lowercase — emojis are case-irrelevant but lowercasing would
  // mangle multi-codepoint sequences in some edge cases. Just trim.
  const reaction = (req.body?.reaction ?? '').toString().trim();
  if (!isValidReaction(reaction)) {
    return res.status(400).json({ error: 'reaction must be an emoji (1–16 chars)' });
  }

  // Verify round exists
  const { rows } = await pool.query(`SELECT 1 FROM rounds WHERE round_id = $1`, [req.params.roundId]);
  if (!rows.length) return res.status(404).json({ error: 'round not found' });

  const { rows: existing } = await pool.query(
    `SELECT 1 FROM round_reactions WHERE user_id = $1 AND round_id = $2 AND reaction = $3`,
    [req.userId, req.params.roundId, reaction]
  );
  if (existing.length) {
    await pool.query(
      `DELETE FROM round_reactions WHERE user_id = $1 AND round_id = $2 AND reaction = $3`,
      [req.userId, req.params.roundId, reaction]
    );
    return res.json({ added: false });
  }
  await pool.query(
    `INSERT INTO round_reactions (user_id, round_id, reaction) VALUES ($1, $2, $3)`,
    [req.userId, req.params.roundId, reaction]
  );

  // Notify the round owner — fire-and-forget so a flaky push doesn't break
  // the API call. Skipped silently if you reacted on your own round or the
  // owner has no push token.
  pushTargetFor(req.params.roundId, req.userId!).then((tgt) => {
    if (!tgt) return;
    return sendPush(
      [tgt.push_token],
      // Push title: emoji reactions show the emoji directly; legacy
      // tokens get uppercased to match the historical phrasing.
      LEGACY_TOKENS.has(reaction)
        ? `${tgt.actor_name} said ${reaction.toUpperCase()}`
        : `${tgt.actor_name} ${reaction}`,
      tgt.course_name ? `On your round at ${tgt.course_name}` : 'On your round',
      { type: 'round_reaction', roundId: req.params.roundId, reaction, fromUserId: req.userId }
    );
  }).catch(() => { /* swallow */ });

  return res.json({ added: true });
}));

// Post a comment
//   body: { body: 'nice round', clientId?: '...' }
router.post('/:roundId/comments', requireAuth, perUserRateLimit({ max: 30, windowMs: 60_000 }), wrap(async (req: AuthRequest, res: Response) => {
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

  const { rows: rd } = await pool.query(`SELECT 1 FROM rounds WHERE round_id = $1`, [req.params.roundId]);
  if (!rd.length) return res.status(404).json({ error: 'round not found' });

  // Normalize the reply target to a TOP-LEVEL comment on this round so threads
  // never nest past one level. Unknown/foreign parent degrades to top-level.
  let parentId: string | null = null;
  if (rawParentId) {
    const { rows: pc } = await pool.query(
      `SELECT comment_id, parent_comment_id FROM round_comments WHERE comment_id = $1 AND round_id = $2`,
      [rawParentId, req.params.roundId]
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
      `INSERT INTO round_comments (user_id, round_id, body, client_id, parent_comment_id, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING comment_id, created_at, client_id, parent_comment_id, image_url`,
      [req.userId, req.params.roundId, body, clientId, parentId, image?.url ?? null]
    ));
  } catch (err) {
    if (image) unlinkCommentImage(image.url);
    throw err;
  }
  if (!rows.length && clientId) {
    // Duplicate retry — the original comment already landed. Drop the freshly
    // written (now-orphan) image, return the original, skip the push.
    if (image) unlinkCommentImage(image.url);
    const { rows: existing } = await pool.query(
      `SELECT comment_id, created_at, client_id, parent_comment_id, image_url FROM round_comments
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

  // Push (fire-and-forget). A reply pings the PARENT comment's author
  // ("replied to your comment"); a top-level comment pings the round owner
  // ("commented on your round"). Body is truncated so a long comment doesn't
  // overflow the lock screen.
  const preview = body
    ? (body.length > 100 ? body.slice(0, 97) + '…' : body)
    : 'Sent a photo';
  if (parentId) {
    pool.query(
      `SELECT c.user_id AS author_id, u.push_token, actor.username AS actor_name
         FROM round_comments c
         JOIN users u ON u.user_id = c.user_id
         JOIN users actor ON actor.user_id = $2
        WHERE c.comment_id = $1`,
      [parentId, req.userId]
    ).then(({ rows: pr }) => {
      const pa = pr[0];
      if (!pa || pa.author_id === req.userId || !pa.push_token) return;
      return sendPush(
        [pa.push_token],
        `${pa.actor_name} replied to your comment`,
        preview,
        { type: 'round_comment_reply', roundId: req.params.roundId, commentId: rows[0].comment_id, parentCommentId: parentId, fromUserId: req.userId }
      );
    }).catch(() => { /* swallow */ });
  } else {
    pushTargetFor(req.params.roundId, req.userId!).then((tgt) => {
      if (!tgt) return;
      return sendPush(
        [tgt.push_token],
        `${tgt.actor_name} commented on your round`,
        preview,
        { type: 'round_comment', roundId: req.params.roundId, commentId: rows[0].comment_id, fromUserId: req.userId }
      );
    }).catch(() => { /* swallow */ });
  }

  return res.json({
    success: true,
    comment_id: rows[0].comment_id,
    created_at: rows[0].created_at,
    client_id: rows[0].client_id,
    parent_comment_id: rows[0].parent_comment_id,
    image_url: rows[0].image_url,
  });
}));

// Delete a comment (only your own)
router.delete('/:roundId/comments/:commentId', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rowCount } = await pool.query(
    `DELETE FROM round_comments WHERE comment_id = $1 AND user_id = $2`,
    [req.params.commentId, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found or not yours' });
  return res.json({ success: true });
}));

// POST /rounds/:roundId/comments/:commentId/like — toggle the viewer's like.
// Returns the new liked state + fresh count for the client's optimistic flip.
router.post('/:roundId/comments/:commentId/like', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const del = await pool.query(
    `DELETE FROM round_comment_likes WHERE comment_id = $1 AND user_id = $2`,
    [req.params.commentId, req.userId]
  );
  let liked = false;
  if (del.rowCount === 0) {
    await pool.query(
      `INSERT INTO round_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.commentId, req.userId]
    );
    liked = true;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS like_count FROM round_comment_likes WHERE comment_id = $1`,
    [req.params.commentId]
  );
  return res.json({ liked, like_count: rows[0].like_count });
}));

export default router;
