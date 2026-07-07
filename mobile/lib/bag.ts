/**
 * Bag persistence — local-first so a player's club bag is NEVER lost.
 *
 * The bag used to save with a single `PATCH /users/me` call: if that request
 * failed (spotty course signal, backgrounded mid-save) the edit was gone. This
 * module writes the bag to AsyncStorage FIRST (instant, offline-safe, and it
 * survives OTA/app updates — AsyncStorage is not cleared by an update), then
 * best-effort syncs to the server for cross-device. A local copy that couldn't
 * reach the server is flagged dirty and retried on the next `syncBag()`.
 *
 * Read order everywhere (editor + in-round picker): local copy first (the
 * device's last explicit save, including edits not yet synced), else the
 * server value from `/me`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import type { BagEntry } from '../types';

// Namespaced by user so two accounts on one device don't share a bag.
const KEY = (userId: string) => `bag_v1_${userId}`;
const DIRTY = (userId: string) => `bag_v1_${userId}_dirty`;

function normalize(arr: any): BagEntry[] | null {
  if (!Array.isArray(arr)) return null;
  const out: BagEntry[] = [];
  for (const e of arr) {
    if (typeof e === 'string') out.push({ code: e });
    else if (e && typeof e.code === 'string') out.push(e.label ? { code: e.code, label: e.label } : { code: e.code });
  }
  return out;
}

/** The device's saved bag, or null if none saved on this device. */
export async function loadLocalBag(userId: string): Promise<BagEntry[] | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch { return null; }
}

async function writeLocal(userId: string, entries: BagEntry[]) {
  try { await AsyncStorage.setItem(KEY(userId), JSON.stringify(entries)); } catch { /* disk full — nothing we can do */ }
}

/** Save the bag. Local write happens FIRST and always succeeds from the
 *  caller's view (so the bag is never lost); the server sync is best-effort and
 *  its success is reported so the UI can note "saved, will sync". */
export async function saveBag(userId: string, entries: BagEntry[]): Promise<{ synced: boolean }> {
  await writeLocal(userId, entries);
  try {
    await api.users.update({ clubsInBag: entries });
    try { await AsyncStorage.removeItem(DIRTY(userId)); } catch { /* noop */ }
    return { synced: true };
  } catch {
    try { await AsyncStorage.setItem(DIRTY(userId), '1'); } catch { /* noop */ }
    return { synced: false };
  }
}

/** Clear the bag (local + server) — "reset to all clubs". */
export async function resetBag(userId: string): Promise<{ synced: boolean }> {
  try { await AsyncStorage.removeItem(KEY(userId)); await AsyncStorage.removeItem(DIRTY(userId)); } catch { /* noop */ }
  try { await api.users.update({ clubsInBag: null }); return { synced: true }; }
  catch { return { synced: false }; }
}

/** Reconcile local ↔ server. Call on boot / foreground and after a /me refresh:
 *   • a dirty (unsynced) local bag is retried against the server;
 *   • if this device has no local bag but the server has one, adopt it locally
 *     (so the local-first read path is seeded on a fresh install / new device).
 */
export async function syncBag(userId: string, serverBag: any): Promise<void> {
  if (!userId) return;
  const local = await loadLocalBag(userId);
  let dirty = false;
  try { dirty = (await AsyncStorage.getItem(DIRTY(userId))) === '1'; } catch { /* noop */ }
  if (local && dirty) {
    try { await api.users.update({ clubsInBag: local }); await AsyncStorage.removeItem(DIRTY(userId)); } catch { /* retry next time */ }
  } else if (!local) {
    const srv = normalize(serverBag);
    if (srv && srv.length) await writeLocal(userId, srv);
  }
}
