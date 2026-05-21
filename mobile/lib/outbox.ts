/**
 * Tiny offline outbox for critical writes — currently just score submission.
 *
 * When a user finishes a round on a hill with no service and taps Submit,
 * we can't afford to throw a "Network error" alert and lose the round. We
 * push the submission into this outbox, surface a friendly "Saved — will
 * sync when you're online" message, and replay it the moment connectivity
 * returns OR the app foregrounds.
 *
 * Backed by AsyncStorage so it survives app kills. The outbox is intentionally
 * minimal — one operation kind at a time, no priorities, single retry-on-
 * connection trigger. Add more kinds as needed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { api, subscribeConn, OfflineError } from './api';

/** Per-match local cache keys that need clearing once the round's been
 *  successfully submitted by the outbox. Mirrors the cleanup the inline
 *  submit path does on success — without this, a player who submitted
 *  offline then came back online would still see the local-draft state
 *  ("scores_<uid>_<mid>") on the next mount even though the server now
 *  has authoritative data. */
function localKeysForMatch(matchId: string): string[] {
  return [
    // Score draft. Note: SAVE_KEY uses `scores_<userId>_<matchId>` so we
    // can't reconstruct it without the userId. The async-storage prefix
    // scan in drainOutbox handles that.
    `shots_${matchId}`,
    `shots_active_${matchId}`,
    `match_cache_${matchId}`,
  ];
}

type SubmitPayload = {
  matchId: string;
  body: {
    holeScores: number[];
    holeStats: any[];
    courseId?: string;
    teeboxId?: string;
    beers?: number;
  };
};

type PinPayload = {
  matchId: string;
  holeId: string;
  lat: number;
  lng: number;
  elevation_m: number | null;
};

type Entry =
  | { kind: 'submit_scores'; queuedAt: string; payload: SubmitPayload }
  | { kind: 'contribute_pin'; queuedAt: string; payload: PinPayload };

const KEY = 'coc_outbox_v1';

async function readAll(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeAll(entries: Entry[]) {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* disk full → drop, caller already failed */ }
}

export async function queueSubmitScores(payload: SubmitPayload): Promise<void> {
  const entries = await readAll();
  // Replace any prior queued submit for the same matchId — only the latest
  // score state matters. Prevents racy double-submits if the user taps
  // submit, then tweaks a hole, then taps submit again before sync.
  const next = entries.filter((e) =>
    !(e.kind === 'submit_scores' && e.payload.matchId === payload.matchId)
  );
  next.push({ kind: 'submit_scores', queuedAt: new Date().toISOString(), payload });
  await writeAll(next);
}

/** Queue a pin contribution for later upload. Deduplicates by (matchId, holeId)
 *  — only the most-recent pin per hole survives, matching the server's
 *  median-aggregator semantics where each device contributes once per hole. */
export async function queueContributePin(payload: PinPayload): Promise<void> {
  const entries = await readAll();
  const next = entries.filter((e) =>
    !(e.kind === 'contribute_pin'
      && e.payload.matchId === payload.matchId
      && e.payload.holeId === payload.holeId)
  );
  next.push({ kind: 'contribute_pin', queuedAt: new Date().toISOString(), payload });
  await writeAll(next);
}

export async function hasQueuedSubmitFor(matchId: string): Promise<boolean> {
  const entries = await readAll();
  return entries.some((e) => e.kind === 'submit_scores' && e.payload.matchId === matchId);
}

/** Returns true if there's anything queued that we should be trying to send. */
export async function isOutboxEmpty(): Promise<boolean> {
  const entries = await readAll();
  return entries.length === 0;
}

let draining = false;

/** Drain the outbox best-effort. Network errors leave entries in place for
 *  the next drain tick; other errors (4xx — e.g. match already completed)
 *  drop the entry since retrying won't help. */
export async function drainOutbox(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    let entries = await readAll();
    if (!entries.length) return;
    const remaining: Entry[] = [];
    // Match IDs whose submit landed (either fresh or "already completed" =
    // server confirms there's nothing more to send). We clear the local
    // round caches for these so a stranded score draft doesn't linger.
    const submittedMatchIds = new Set<string>();
    for (const entry of entries) {
      try {
        if (entry.kind === 'submit_scores') {
          await api.matches.submitScores(entry.payload.matchId, entry.payload.body);
          submittedMatchIds.add(entry.payload.matchId);
        } else if (entry.kind === 'contribute_pin') {
          await api.matches.contributePin(
            entry.payload.matchId,
            entry.payload.holeId,
            entry.payload.lat,
            entry.payload.lng,
            entry.payload.elevation_m,
          );
        }
        // Success → don't re-queue.
      } catch (e: any) {
        // Still offline → keep for next attempt. Server-side error → drop
        // (retrying won't fix a 4xx like "Match already completed"). A
        // 409 'Match already completed' on submit means another device
        // already submitted the round; treat that as "done" so the local
        // draft caches get cleaned up too.
        if (e instanceof OfflineError) {
          remaining.push(entry);
        } else {
          if (entry.kind === 'submit_scores'
              && /already completed/i.test(String(e?.message ?? ''))) {
            submittedMatchIds.add(entry.payload.matchId);
          }
          // eslint-disable-next-line no-console
          console.warn('[outbox] dropping non-retryable entry', entry.kind, e);
        }
      }
    }
    await writeAll(remaining);

    // Local-draft cleanup for every match whose submit successfully landed
    // (or was already done server-side). Best-effort — a failed unlink
    // just means the next mount sees a stale draft that load() will
    // happily overwrite.
    if (submittedMatchIds.size) {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const toRemove: string[] = [];
        for (const matchId of submittedMatchIds) {
          for (const k of localKeysForMatch(matchId)) {
            if (keys.includes(k)) toRemove.push(k);
          }
          // SAVE_KEY has the user_id baked in (scores_<uid>_<mid>); scan
          // by suffix so we clear it regardless of which account submitted.
          const suffix = `_${matchId}`;
          for (const k of keys) {
            if (k.startsWith('scores_') && k.endsWith(suffix)) toRemove.push(k);
          }
        }
        if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
      } catch { /* best-effort */ }
    }
  } finally {
    draining = false;
  }
}

/** Wire up automatic draining triggers. Call once on app boot. */
let installed = false;
export function installOutboxDrainTriggers() {
  if (installed) return;
  installed = true;

  // 1. Drain whenever connectivity flips back to online.
  subscribeConn((state) => {
    if (state === 'online') { drainOutbox().catch(() => { }); }
  });

  // 2. Drain whenever the app foregrounds — handles the "phone was locked,
  //    came back into service while screen was off" case where no API call
  //    has yet flipped the conn state.
  AppState.addEventListener('change', (s) => {
    if (s === 'active') { drainOutbox().catch(() => { }); }
  });

  // 3. Initial attempt on boot — in case we crashed mid-drain last session.
  drainOutbox().catch(() => { });
}
