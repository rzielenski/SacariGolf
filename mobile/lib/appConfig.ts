/**
 * Server-driven app config.
 *
 * GET /config returns { min_version, banner, features, ... } from the
 * backend's app_config table. Fetched once on boot (and on foreground
 * via the root layout), cached in AsyncStorage so the last-known config
 * applies instantly on the next cold start even offline.
 *
 * What this buys without app releases:
 *   • min_version — flip it to show the "update required" banner on old
 *     builds (e.g. after shipping a breaking API change).
 *   • banner — freeform announcement line on the home tab ("Sacari Cup
 *     finals this Sunday!").
 *   • features — arbitrary flags future code can gate on
 *     (config.features.myNewThing === true) so half-built features can
 *     ship dark in a binary and switch on server-side.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { api } from './api';

export type AppConfig = {
  min_version?: string;
  banner?: string | null;
  features?: Record<string, unknown>;
  server_time?: string;
};

const CACHE_KEY = 'sacari.app_config.v1';

let cached: AppConfig | null = null;
const listeners = new Set<(c: AppConfig) => void>();

function notify() {
  if (!cached) return;
  for (const fn of listeners) fn(cached);
}

export function getAppConfig(): AppConfig | null {
  return cached;
}

export function subscribeAppConfig(fn: (c: AppConfig) => void): () => void {
  listeners.add(fn);
  if (cached) fn(cached);
  return () => { listeners.delete(fn); };
}

/** Hydrate from cache, then refresh from the server. Either half may
 *  fail independently (fresh install offline / server down) — whatever
 *  succeeds wins. Safe to call repeatedly. */
export async function loadAppConfig(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw && !cached) {
      cached = JSON.parse(raw);
      notify();
    }
  } catch { /* corrupt cache — server fetch below replaces it */ }
  try {
    const fresh = await api.config.get();
    cached = fresh;
    notify();
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh)).catch(() => { });
  } catch { /* offline — cached config (if any) stays in effect */ }
}

/** True when a is a lower version than b ("1.1.1" < "1.2.0"). Non-numeric
 *  or missing segments compare as 0, so "1.2" == "1.2.0". */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** True when the server's min_version is above this binary's version. */
export function updateRequired(config: AppConfig | null): boolean {
  const min = config?.min_version;
  const current = Constants.expoConfig?.version;
  if (!min || !current) return false;
  return versionLt(current, min);
}
