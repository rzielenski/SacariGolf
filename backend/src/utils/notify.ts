/**
 * Expo push sender.
 *
 * Guarantees:
 *   • NEVER throws — message sends must not fail because a push didn't.
 *   • Chunks to Expo's 100-message-per-request limit (big clans).
 *   • Reads the per-message tickets in the response and prunes tokens that
 *     Expo reports as DeviceNotRegistered (user uninstalled / token rotated),
 *     so dead tokens stop slowing down every later send.
 */

import pool from '../db/pool';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;

/**
 * Social-media-style like-notification throttle. The owner is pinged on each of
 * the first few likes, then progressively less often as the count climbs, so a
 * post that takes off doesn't bury them in pings. Returns true only on
 * "milestone" counts (pass the NEW total after the like):
 *
 *   1,2,3,4,5            every one of the first five
 *   10,20,30,…,100       then every ten
 *   200,300,…,1000       then every hundred
 *   2000,3000,…          then every thousand
 *
 * So 100 likes ⇒ 15 pings, 1000 likes ⇒ 24 pings — not 100 or 1000.
 */
export function isLikeNotifyMilestone(count: number): boolean {
  if (count <= 0) return false;
  if (count <= 5) return true;
  if (count <= 100) return count % 10 === 0;
  if (count <= 1000) return count % 100 === 0;
  return count % 1000 === 0;
}

async function pruneDeadToken(token: string) {
  try {
    await pool.query(
      `UPDATE users SET push_token = NULL WHERE push_token = $1`,
      [token],
    );
  } catch { /* pruning is best-effort */ }
}

export async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const valid = tokens.filter((t) => t && t.startsWith('ExponentPushToken'));
  if (!valid.length) return;

  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunk = valid.slice(i, i + CHUNK_SIZE);
    const messages = chunk.map((to) => ({ to, title, body, data: data ?? {}, sound: 'default' }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        console.warn(`sendPush: Expo responded ${res.status}`);
        continue;
      }
      // Tickets come back in request order. An "error" ticket with
      // DeviceNotRegistered means the token is permanently dead — null it
      // out so we stop paying for it on every send.
      const json: any = await res.json().catch(() => null);
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      for (let t = 0; t < tickets.length; t++) {
        const ticket = tickets[t];
        if (ticket?.status === 'error') {
          const detail = ticket?.details?.error;
          if (detail === 'DeviceNotRegistered' && chunk[t]) {
            await pruneDeadToken(chunk[t]);
          } else {
            console.warn(`sendPush: ticket error ${detail ?? ticket?.message ?? 'unknown'}`);
          }
        }
      }
    } catch (err) {
      // Push failures are non-fatal — don't propagate, but leave a trace so
      // "notifications stopped working" is diagnosable from Railway logs.
      console.warn('sendPush: request failed', err instanceof Error ? err.message : err);
    }
  }
}
