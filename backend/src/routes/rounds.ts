import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';
import { sendPush } from '../utils/notify';

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
  const { rows: cmRows } = await pool.query(
    `SELECT c.comment_id, c.user_id, u.username, c.body, c.created_at, c.client_id,
            (c.user_id = $2) AS mine
     FROM round_comments c
     JOIN users u ON u.user_id = c.user_id
     WHERE c.round_id = $1
     ORDER BY c.created_at ASC`,
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
router.post('/:roundId/comments', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const body = (req.body?.body ?? '').toString().trim().slice(0, 280);
  if (!body) return res.status(400).json({ error: 'body required' });
  // Client-generated idempotency key — same contract as chat sends. A retry
  // after an ambiguous network failure (request landed, response lost)
  // carries the same clientId; the partial unique index collapses it onto
  // the original row and we return that row instead of double-posting.
  const clientId = typeof req.body?.clientId === 'string' && req.body.clientId.length > 0
    ? req.body.clientId.slice(0, 64)
    : null;

  const { rows: rd } = await pool.query(`SELECT 1 FROM rounds WHERE round_id = $1`, [req.params.roundId]);
  if (!rd.length) return res.status(404).json({ error: 'round not found' });

  const { rows } = await pool.query(
    `INSERT INTO round_comments (user_id, round_id, body, client_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING comment_id, created_at, client_id`,
    [req.userId, req.params.roundId, body, clientId]
  );
  if (!rows.length && clientId) {
    // Duplicate retry — the original comment already landed. Return it and
    // skip the push (the round owner was already notified).
    const { rows: existing } = await pool.query(
      `SELECT comment_id, created_at, client_id FROM round_comments
       WHERE user_id = $1 AND client_id = $2`,
      [req.userId, clientId]
    );
    if (existing.length) {
      return res.json({
        success: true,
        comment_id: existing[0].comment_id,
        created_at: existing[0].created_at,
        client_id: existing[0].client_id,
      });
    }
    return res.status(409).json({ error: 'Duplicate send' });
  }

  // Push to round owner (fire-and-forget). Truncate body in the push so a
  // long comment doesn't make the notification overflow on lock screens.
  pushTargetFor(req.params.roundId, req.userId!).then((tgt) => {
    if (!tgt) return;
    const preview = body.length > 100 ? body.slice(0, 97) + '…' : body;
    return sendPush(
      [tgt.push_token],
      `${tgt.actor_name} commented on your round`,
      preview,
      { type: 'round_comment', roundId: req.params.roundId, commentId: rows[0].comment_id, fromUserId: req.userId }
    );
  }).catch(() => { /* swallow */ });

  return res.json({
    success: true,
    comment_id: rows[0].comment_id,
    created_at: rows[0].created_at,
    client_id: rows[0].client_id,
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

export default router;
