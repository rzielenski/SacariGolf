/**
 * @mention handling for feed posts.
 *
 * A post body (a text/photo post, or a round caption) can tag other players
 * with `@username`. `processMentions` parses those handles, resolves them to
 * real users (case-insensitively — usernames are case-insensitively unique),
 * records each tag in `post_mentions`, and fires a push notification to each
 * tagged user. The in-app bell surfaces them via GET /users/me/notifications,
 * which reads `post_mentions`.
 *
 * Best-effort by design: it never throws. Tagging is a nicety layered on top
 * of the post, so a failure here must never break post creation or match
 * resolution.
 */

import pool from '../db/pool';
import { sendPush } from './notify';

// 3–20 chars matches the username validation in auth/register. The handle is
// captured without the leading '@'. We don't require a word boundary before
// '@' so "hey@rich" still tags — usernames can't contain '@' so it's safe.
const MENTION_RE = /@([a-zA-Z0-9_]{3,20})/g;

/** Extract the unique, lower-cased usernames mentioned in a body. */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Resolve @mentions in `text`, record them against `postId`, and push a
 * "tagged you" notification to each mentioned user (excluding the author).
 * Idempotent per (post, user) via the post_mentions PK, so re-running is safe.
 */
export async function processMentions(
  postId: string,
  authorId: string,
  text: string | null | undefined,
): Promise<void> {
  try {
    const handles = parseMentions(text);
    if (!handles.length) return;

    const { rows: users } = await pool.query(
      `SELECT user_id, username, push_token
         FROM users
        WHERE lower(username) = ANY($1::text[])
          AND user_id <> $2`,
      [handles, authorId],
    );
    if (!users.length) return;

    const { rows: a } = await pool.query(
      `SELECT username FROM users WHERE user_id = $1`,
      [authorId],
    );
    const authorName: string = a[0]?.username ?? 'Someone';
    const preview = (text ?? '').trim().slice(0, 140);

    for (const u of users) {
      await pool.query(
        `INSERT INTO post_mentions (post_id, mentioned_user_id, author_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id, mentioned_user_id) DO NOTHING`,
        [postId, u.user_id, authorId],
      );
      if (u.push_token) {
        // Fire-and-forget; sendPush swallows its own network errors.
        sendPush(
          [u.push_token],
          `${authorName} tagged you`,
          preview || `${authorName} mentioned you in a post`,
          { type: 'post', postId },
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('processMentions failed:', err);
  }
}

/** True if the body contains an "@everyone" broadcast tag (case-insensitive,
 *  word-bounded so "@everyonething" doesn't match). */
export function hasEveryoneTag(text: string | null | undefined): boolean {
  if (!text) return false;
  return /@everyone\b/i.test(text);
}

/**
 * Broadcast an owner's @everyone announcement: push to EVERY user with a
 * registered device (except the author). sendPush chunks to Expo's 100/req
 * limit internally, so one call covers the whole user base. Best-effort —
 * never throws, so a push failure can't break post creation.
 *
 * Caller is responsible for verifying the author is an owner BEFORE calling
 * this — there's no permission check here.
 */
export async function broadcastToEveryone(
  postId: string,
  authorId: string,
  text: string | null | undefined,
): Promise<void> {
  try {
    const { rows: a } = await pool.query(
      `SELECT username FROM users WHERE user_id = $1`,
      [authorId],
    );
    const authorName: string = a[0]?.username ?? 'Sacari';
    // Strip the @everyone tag from the preview so the notification reads
    // cleanly ("Big news!" not "@everyone Big news!").
    const preview = (text ?? '').replace(/@everyone\b/ig, '').trim().slice(0, 140);

    const { rows: recipients } = await pool.query(
      `SELECT push_token FROM users
        WHERE push_token IS NOT NULL AND user_id <> $1`,
      [authorId],
    );
    const tokens = recipients.map((r) => r.push_token);
    if (!tokens.length) return;

    await sendPush(
      tokens,
      `📣 ${authorName}`,
      preview || `${authorName} posted an announcement`,
      { type: 'announcement', postId },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('broadcastToEveryone failed:', err);
  }
}
