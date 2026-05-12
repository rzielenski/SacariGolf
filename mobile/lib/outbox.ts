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

type SubmitPayload = {
  matchId: string;
  body: {
    holeScores: number[];
    holeStats: any[];
    courseId?: string;
    teeboxId?: string;
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
    for (const entry of entries) {
      try {
        if (entry.kind === 'submit_scores') {
          await api.matches.submitScores(entry.payload.matchId, entry.payload.body);
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
      } catch (e) {
        // Still offline → keep for next attempt. Server-side error → drop
        // (retrying won't fix a 4xx like "Match already completed").
        if (e instanceof OfflineError) {
          remaining.push(entry);
        } else {
          // eslint-disable-next-line no-console
          console.warn('[outbox] dropping non-retryable entry', entry.kind, e);
        }
      }
    }
    await writeAll(remaining);
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
