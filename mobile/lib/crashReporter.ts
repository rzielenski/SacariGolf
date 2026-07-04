/**
 * Homegrown crash reporter — no Sentry (that needs a native build; this ships
 * over-the-air). It captures the failures a React error boundary CAN'T:
 *
 *   • js_fatal      — an uncaught JS exception, via the ErrorUtils global hook.
 *   • js_boundary   — a render error AppErrorBoundary caught (wired from there).
 *   • abnormal_exit — the killer case. A native crash / iOS OOM-kill / watchdog
 *                     force-close runs NO JavaScript, so nothing can report it
 *                     in-the-moment. Instead we keep a "session marker" in
 *                     AsyncStorage that's refreshed as you use the app; on the
 *                     NEXT launch, if the previous session was still FOREGROUNDED
 *                     ("active") and never went to background, it died mid-use —
 *                     i.e. force-closed. We report it then, with the last route,
 *                     the breadcrumb trail, and how many iOS memory warnings
 *                     preceded it. Lots of memory warnings → it's a leak/OOM.
 *
 * A normal exit (you swipe the app away) transitions through 'background' first,
 * so it's NOT flagged — only crashes that happen while you're actively in the
 * app are, which is exactly the "force closes while I'm just moving around"
 * report we're chasing.
 *
 * Everything here is best-effort and self-contained: it does its own bounded
 * fetch (so it works even mid-crash) and swallows all its own errors — a crash
 * reporter must never be the thing that crashes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { API_BASE } from './api';

type Breadcrumb = { t: number; type: string; msg: string };

type SessionMarker = {
  id: string;
  startedAt: number;
  lastAlive: number;
  state: 'active' | 'background';
  memWarns: number;
  lastRoute: string;
  breadcrumbs: Breadcrumb[];
  appVersion: string;
  updateId: string;
  platform: string;
  osVersion: string;
};

const MARKER_KEY = 'crash_session_v1';
const PENDING_KEY = 'crash_pending_v1';
const MAX_CRUMBS = 40;
const MAX_PENDING = 20;
const HEARTBEAT_MS = 5000;
const POST_TIMEOUT_MS = 10000;

let marker: SessionMarker | null = null;
let installed = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function now() { return Date.now(); }

function newId(): string {
  // Not crypto — just needs to be distinct across sessions. Time + a random
  // suffix is plenty; this is diagnostics, not security.
  return `${now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function updateId(): string {
  // The running OTA update id tells us WHICH bundle crashed (or 'embedded' for
  // the built-in one). Loaded lazily so a missing expo-updates never throws.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Updates = require('expo-updates');
    return (Updates?.updateId as string) || (Updates?.isEmbeddedLaunch ? 'embedded' : 'none');
  } catch {
    return 'unknown';
  }
}

async function persist() {
  if (!marker) return;
  try { await AsyncStorage.setItem(MARKER_KEY, JSON.stringify(marker)); } catch { /* best effort */ }
}

/** Add a breadcrumb and persist immediately — we can't know which breadcrumb is
 *  the last one before a crash, so freshness matters more than write volume
 *  (these events are user-paced: routes, app-state, warnings). */
export function logBreadcrumb(type: string, msg: string) {
  if (!marker) return;
  try {
    marker.breadcrumbs.push({ t: now(), type: String(type).slice(0, 40), msg: String(msg).slice(0, 300) });
    if (marker.breadcrumbs.length > MAX_CRUMBS) marker.breadcrumbs.splice(0, marker.breadcrumbs.length - MAX_CRUMBS);
    marker.lastAlive = now();
    void persist();
  } catch { /* never throw from the reporter */ }
}

/** Called on navigation so a crash report says exactly which screen the user
 *  was on. Wired from the root layout's segment watcher. */
export function noteRoute(route: string) {
  if (!marker) return;
  marker.lastRoute = String(route).slice(0, 300);
  logBreadcrumb('route', route);
}

// ── Pending-report queue (a mini-outbox) ────────────────────────────────────
// A js_fatal fires as the app is dying, so its POST often can't finish. We
// enqueue every report and flush the queue on the next launch, so nothing is
// lost even if the in-the-moment send doesn't complete.
async function enqueue(report: Record<string, unknown>) {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const list: any[] = raw ? JSON.parse(raw) : [];
    list.push(report);
    while (list.length > MAX_PENDING) list.shift();
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch { /* best effort */ }
}

async function postReport(report: Record<string, unknown>): Promise<boolean> {
  try {
    const token = await AsyncStorage.getItem('coc_token');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/telemetry/crash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(report),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    return res.ok;
  } catch {
    return false;
  }
}

async function flushPending() {
  let list: any[] = [];
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch { return; }
  if (!list.length) return;
  const keep: any[] = [];
  for (const report of list) {
    const ok = await postReport(report);
    if (!ok) keep.push(report);   // still offline / server down → retry next launch
  }
  try { await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(keep)); } catch { /* best effort */ }
}

/** Build a report payload from the live session snapshot + the crash specifics. */
function buildReport(kind: string, fields: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    kind,
    appVersion: marker?.appVersion ?? String(Constants.expoConfig?.version ?? ''),
    updateId: marker?.updateId ?? updateId(),
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? ''),
    lastRoute: marker?.lastRoute ?? '',
    memWarns: marker?.memWarns ?? 0,
    breadcrumbs: marker?.breadcrumbs ?? [],
    ...fields,
  };
}

/** Report a render error caught by AppErrorBoundary (called from there). */
export function reportBoundaryError(error: Error, componentStack?: string) {
  try {
    logBreadcrumb('boundary', error?.message ?? String(error));
    const report = buildReport('js_boundary', {
      message: String(error?.message ?? error).slice(0, 2000),
      stack: String(error?.stack ?? componentStack ?? '').slice(0, 8000),
      extra: componentStack ? { componentStack: componentStack.slice(0, 4000) } : undefined,
    });
    void enqueue(report).then(() => { void postReport(report); });
  } catch { /* never throw */ }
}

/**
 * Install the reporter. Call ONCE at boot, as early as possible so breadcrumbs
 * capture everything. Idempotent (HMR-safe).
 */
export function initCrashReporter() {
  if (installed) return;
  installed = true;

  (async () => {
    // 1. Inspect the PREVIOUS session before we overwrite it.
    try {
      const raw = await AsyncStorage.getItem(MARKER_KEY);
      if (raw) {
        const prev: SessionMarker = JSON.parse(raw);
        // Foregrounded ('active') and never cleanly backgrounded → it died
        // mid-use. A normal quit would have left it 'background'.
        if (prev && prev.state === 'active') {
          const report = {
            kind: 'abnormal_exit',
            appVersion: prev.appVersion,
            updateId: prev.updateId,
            platform: prev.platform,
            osVersion: prev.osVersion,
            lastRoute: prev.lastRoute,
            memWarns: prev.memWarns,
            breadcrumbs: prev.breadcrumbs,
            message: `App force-closed while foregrounded on "${prev.lastRoute || 'unknown'}"`
              + (prev.memWarns > 0 ? ` after ${prev.memWarns} memory warning(s)` : ''),
            extra: {
              sessionMs: Math.max(0, prev.lastAlive - prev.startedAt),
              sinceLastAliveMs: Math.max(0, now() - prev.lastAlive),
              likelyOom: prev.memWarns >= 1,
            },
          };
          await enqueue(report);
        }
      }
    } catch { /* ignore a corrupt marker */ }

    // 2. Flush anything queued from prior sessions (incl. the abnormal_exit
    //    we may have just enqueued, and js_fatals that couldn't send in-flight).
    await flushPending();

    // 3. Start a fresh session marker.
    marker = {
      id: newId(),
      startedAt: now(),
      lastAlive: now(),
      state: 'active',
      memWarns: 0,
      lastRoute: '',
      breadcrumbs: [],
      appVersion: String(Constants.expoConfig?.version ?? ''),
      updateId: updateId(),
      platform: Platform.OS,
      osVersion: String(Platform.Version ?? ''),
    };
    await persist();
    logBreadcrumb('launch', 'app started');
  })();

  // 4. Catch uncaught JS exceptions. We report, then defer to the previous
  //    handler (which may show the redbox in dev / terminate in prod).
  try {
    const g: any = global as any;
    const prevHandler = g.ErrorUtils?.getGlobalHandler?.();
    g.ErrorUtils?.setGlobalHandler?.((error: any, isFatal?: boolean) => {
      try {
        logBreadcrumb('fatal', error?.message ?? String(error));
        const report = buildReport('js_fatal', {
          message: String(error?.message ?? error).slice(0, 2000),
          stack: String(error?.stack ?? '').slice(0, 8000),
          extra: { isFatal: !!isFatal },
        });
        // Enqueue first (survives the process dying), then try an immediate send.
        void enqueue(report).then(() => { void postReport(report); });
      } catch { /* never throw from the handler */ }
      if (typeof prevHandler === 'function') prevHandler(error, isFatal);
    });
  } catch { /* ErrorUtils absent → skip, abnormal_exit still catches natives */ }

  // 5. Track foreground/background + iOS memory warnings.
  try {
    AppState.addEventListener('change', (state) => {
      if (!marker) return;
      if (state === 'active') {
        marker.state = 'active';
        logBreadcrumb('appstate', 'active');
      } else if (state === 'background' || state === 'inactive') {
        // Mark 'background' so a subsequent OS kill / user swipe-away is NOT
        // misreported as a crash — only foreground deaths are.
        marker.state = 'background';
        marker.lastAlive = now();
        logBreadcrumb('appstate', state);
      }
    });
    // iOS low-memory warning. A burst of these right before an abnormal_exit is
    // the fingerprint of a leak / OOM force-close.
    AppState.addEventListener('memoryWarning', () => {
      if (!marker) return;
      marker.memWarns += 1;
      logBreadcrumb('memory', `low-memory warning #${marker.memWarns}`);
    });
  } catch { /* AppState always exists; guard anyway */ }

  // 6. Heartbeat: refresh lastAlive so abnormal_exit knows roughly WHEN it died.
  heartbeat = setInterval(() => {
    if (!marker) return;
    marker.lastAlive = now();
    void persist();
  }, HEARTBEAT_MS);
}
