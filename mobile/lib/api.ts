import AsyncStorage from '@react-native-async-storage/async-storage';

// Change this to your computer's local IP (run `ipconfig` to find it)
// Your phone must be on the same WiFi network
export const API_BASE = 'https://determined-perfection-production.up.railway.app';

async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem('coc_token');
}

/** Admin "code" — either the 6-digit ADMIN_PIN or the long PREMIUM_ADMIN_TOKEN
 *  env var on the backend, whichever the user entered. Both unlock the same
 *  endpoints (see backend/src/utils/adminAuth.ts). Stored locally only. */
export async function getAdminToken(): Promise<string | null> {
  return AsyncStorage.getItem('coc_admin_token');
}
export async function setAdminToken(token: string | null): Promise<void> {
  if (token) await AsyncStorage.setItem('coc_admin_token', token);
  else await AsyncStorage.removeItem('coc_admin_token');
}

// Sentinel error so callers can distinguish "no token at all / session ended"
// from a real server error and silently bail rather than alerting the user.
export class NotAuthenticatedError extends Error {
  constructor(message = 'Not signed in') { super(message); this.name = 'NotAuthenticatedError'; }
}

/** Thrown when every retry of a network-class failure has been exhausted.
 *  Callers can catch this specifically to queue an outbox write rather than
 *  surfacing a scary "Network error" alert to the user. */
export class OfflineError extends Error {
  constructor(message = 'No internet connection') { super(message); this.name = 'OfflineError'; }
}

/** True for errors that a screen's load-on-mount effect should SWALLOW rather
 *  than surface via Alert.alert:
 *   • NotAuthenticatedError — the session ended (logout / token invalidated)
 *     while the load was in flight. Screen-load effects re-fire when auth
 *     state flips because `load` depends on `user?.user_id`; the resulting
 *     "Error: Not signed in" popup is pure noise — the app is already
 *     navigating to the login screen.
 *   • OfflineError — the offline banner already communicates this; a second
 *     "No internet connection" alert is redundant.
 *  Real server errors (4xx other than auth, 5xx) are NOT silent — they still
 *  propagate so callers can show them. */
export function isSilentError(e: unknown): boolean {
  return e instanceof NotAuthenticatedError || e instanceof OfflineError;
}

// ── Connectivity singleton ────────────────────────────────────────────────
// We don't pull in @react-native-community/netinfo (extra dep, native build
// implications). Instead, every API call updates a small state machine:
//   • Any 2xx/4xx response → mark online
//   • Three consecutive fetch failures → mark offline
// Subscribers (the offline banner, the outbox drainer) get notified on
// transitions. Pretty accurate in practice — the only way to flip back to
// online is for SOMETHING to succeed, which is the test the user cares
// about anyway.

type ConnState = 'online' | 'offline';
let connState: ConnState = 'online';
let consecutiveFails = 0;
const FAILS_TO_OFFLINE = 3;
const connListeners = new Set<(s: ConnState) => void>();

export function getConnState(): ConnState { return connState; }
export function subscribeConn(fn: (s: ConnState) => void): () => void {
  connListeners.add(fn);
  fn(connState);
  return () => { connListeners.delete(fn); };
}
function setConnState(next: ConnState) {
  if (next === connState) return;
  connState = next;
  for (const fn of connListeners) fn(next);
}
function noteFetchSuccess() {
  consecutiveFails = 0;
  setConnState('online');
}
function noteFetchFailure() {
  consecutiveFails += 1;
  if (consecutiveFails >= FAILS_TO_OFFLINE) setConnState('offline');
}

/** True if an error is a network-class failure (offline, timeout, DNS,
 *  connection reset). These are retried; 4xx/5xx are not. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof OfflineError) return true;
  if (!(e instanceof Error)) return false;
  // RN fetch throws TypeError with this message string on connectivity loss.
  // Also matches "Network request failed", AbortError (timeout).
  return e.name === 'AbortError'
      || e.name === 'TypeError'
      || /Network request failed|network/i.test(e.message);
}

const RETRY_DELAYS_MS = [400, 1200, 3000];   // 3 attempts total beyond the first

/** Race a promise against a timeout. RN's fetch has no built-in timeout,
 *  which on cellular dead-zones can leave a request pending for 60+ seconds
 *  before failing. We bail at 15s so retries can actually fire. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('Request timed out'), { name: 'AbortError' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

// AuthProvider registers a callback so api.ts can ask it to clear state when
// the backend rejects our token. Avoids a circular import.
let onSessionInvalid: (() => void) | null = null;
export function setSessionInvalidHandler(fn: (() => void) | null) {
  onSessionInvalid = fn;
}

async function singleAttempt<T>(
  method: string,
  path: string,
  body: object | undefined,
  auth: boolean,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getToken();
    if (!token) {
      throw new NotAuthenticatedError();
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await withTimeout(
    fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    15000,
  );
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Server returned HTML (e.g. 404 page or crash) — surface a clean message
    throw new Error(`Server error (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && (data?.error === 'Missing token' || data?.error === 'Invalid token')) {
      if (onSessionInvalid) onSessionInvalid();
      throw new NotAuthenticatedError(data.error);
    }
    // 5xx is retryable — wrap with the network-error name so the retry loop
    // catches it. 4xx is a real error and propagates immediately.
    if (res.status >= 500) {
      const err = new Error(data?.error || 'Server error');
      err.name = 'TypeError';
      throw err;
    }
    // Real 4xx — propagate immediately. Attach the HTTP status so callers can
    // distinguish e.g. a 404 ("the thing is gone — navigate away quietly")
    // from a 400/403 ("show the user what went wrong").
    const err = new Error(data.error || 'Request failed');
    (err as any).status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * Public request entry point — wraps singleAttempt with:
 *   • 15s per-attempt timeout (RN fetch has no native timeout)
 *   • Up to 3 retries with backoff for network-class errors and 5xx
 *   • Connectivity state tracking — feeds the offline banner
 *
 * After all retries are exhausted on a network error, throws OfflineError
 * (not the raw fetch TypeError) so callers can distinguish "user is offline,
 * try again later / queue it" from "the server said no".
 */
async function request<T>(
  method: string,
  path: string,
  body?: object,
  auth = true,
): Promise<T> {
  // Idempotency policy: only methods that are safe to repeat get auto-retry
  // on network errors. POST is excluded because we can't distinguish
  // "request never reached the server" from "request succeeded server-side
  // but the response was lost in transit" — retrying the latter creates
  // duplicate writes (extra votes, duplicate posts, double-counted pin
  // samples, ELO applied twice, etc.).
  //
  // Critical POSTs that genuinely need retry semantics route through the
  // outbox (submitScores, contributePin) which retries against server-side
  // idempotency gates (match.completed, ON CONFLICT) rather than blindly.
  const isIdempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
  const maxAttempts = isIdempotent ? 1 + RETRY_DELAYS_MS.length : 1;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const out = await singleAttempt<T>(method, path, body, auth);
      noteFetchSuccess();
      return out;
    } catch (e) {
      lastErr = e;
      // Real, non-retryable errors — propagate immediately.
      if (e instanceof NotAuthenticatedError) throw e;
      if (!isNetworkError(e)) {
        // Server-side 4xx / parse error — still counts as a successful
        // connection (the server answered us), so flip back to online.
        noteFetchSuccess();
        throw e;
      }
      // Retryable: wait and try again unless we've burned all attempts.
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
    }
  }
  noteFetchFailure();
  throw new OfflineError(lastErr instanceof Error ? lastErr.message : 'No internet connection');
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: object) => request<T>('POST', path, body),
  patch: <T>(path: string, body: object) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),

  auth: {
    register: (username: string, email: string, password: string) =>
      request<{ token: string; user: any }>('POST', '/auth/register', { username, email, password }, false),
    login: (email: string, password: string) =>
      request<{ token: string; user: any }>('POST', '/auth/login', { email, password }, false),
    forgotPassword: (email: string) =>
      request<{ success: true }>('POST', '/auth/forgot', { email }, false),
    resetPassword: (email: string, code: string, password: string) =>
      request<{ token: string; user: any }>('POST', '/auth/reset', { email, code, password }, false),
    verifyEmail: (code: string) =>
      request<{ success: true; alreadyVerified?: boolean }>('POST', '/auth/verify-email', { code }),
    resendVerification: () =>
      request<{ success: true; alreadyVerified?: boolean }>('POST', '/auth/resend-verification', {}),
  },

  users: {
    me: () => request<any>('GET', '/users/me'),
    update: (body: {
      pushToken?: string;
      handicapIndex?: number | null;
      username?: string;
      bio?: string | null;
      homeCourseId?: string | null;
      theme?: { trackId: string; title: string; artist: string; artworkUrl?: string; previewUrl: string } | null;
      /** Pass an array of `{ code, label? }` entries to save a bag; pass
       *  null to clear (back to "all clubs eligible"). Server enforces
       *  ≤14 entries + whitelisted codes + ≤30-char labels. Plain
       *  `string[]` (just codes) is also accepted for backward compat. */
      clubsInBag?: ({ code: string; label?: string } | string)[] | null;
    }) => request<any>('PATCH', '/users/me', body),
    uploadAvatar: (imageBase64: string, mimeType: string) => request<any>('POST', '/users/me/avatar', { imageBase64, mimeType }),
    notifications: () => request<{
      notifications: any[];
      unread_count: number;
      /** Subset of unread_count that comes from chats with unread messages.
       *  Tapping the bell only clears the non-chat portion — chat unreads
       *  only drop when the user actually opens the chat. */
      chat_unread_count?: number;
    }>('GET', '/users/me/notifications'),
    perks: () => request<{ perk_id: string; perk_type: string; earned_at: string }[]>('GET', '/users/me/perks'),
    courseRecords: (id: string) => request<{ course_id: string; course_name: string; teebox_name: string; total_score: number; created_at: string }[]>('GET', `/users/${id}/course-records`),
    markNotificationsSeen: () => request<any>('POST', '/users/me/notifications/seen', {}),
    search: (q: string) => request<any[]>('GET', `/users/search?q=${encodeURIComponent(q)}`),
    get: (id: string) => request<any>('GET', `/users/${id}`),
    handicap: (id: string) => request<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number; differentials: any[] }>('GET', `/users/${id}/handicap`),
    stats: (id: string) => request<{
      rounds_count: number;
      holes_played: number;
      avg_strokes_per_hole: number | null;
      fw_hit_pct: number | null; fw_hits: number; fw_eligible: number;
      gir_pct: number | null; gir_count: number; gir_eligible: number;
      avg_putts_per_hole: number | null;
      avg_putts_per_round: number | null;
      avg_chips_per_round: number | null;
      three_putt_count: number;
      up_and_down_pct: number | null; up_and_downs: number; up_and_down_chances: number;
      sg_holes: number;
      sg_per_round: { off_tee: number; approach: number; around_green: number; putting: number; total: number } | null;
    }>('GET', `/users/${id}/stats`),
    holeShots: (id: string, courseId: string, holeNum: number, excludeMatchId?: string) => {
      const q = new URLSearchParams({
        courseId,
        holeNum: String(holeNum),
        ...(excludeMatchId ? { excludeMatchId } : {}),
      });
      return request<{
        rounds: { match_id: string; created_at: string; shots: any[] }[];
      }>('GET', `/users/${id}/hole-shots?${q.toString()}`);
    },
    sgAdvanced: (id: string) => request<{
      shots_used: number;
      holes_used: number;
      rounds_used: number;
      sg_per_round: { off_tee: number; approach: number; around_green: number; putting: number; total: number } | null;
    }>('GET', `/users/${id}/sg-advanced`),
    clubStats: (id: string) => request<{
      clubs: {
        club: string;
        shots: number;
        avg_yds: number;
        median_yds: number;
        dispersion: {
          shot_id: string | null;
          recorded_at: string | null;
          lateral_yds: number;
          long_yds: number;
          dist_yds: number;
        }[];
      }[];
    }>('GET', `/users/${id}/club-stats`),
    /** Delete a single tracked shot from the current user's stats. */
    deleteShot: (shotId: string) =>
      request<{ success: true }>('DELETE', `/users/me/shots/${shotId}`),
    activeRound: (id: string) => request<any | null>('GET', `/users/${id}/active-round`),
    blocks: () => request<{
      blocked_id: string; username: string; elo: number;
      avatar_url: string | null; created_at: string; reason: string | null;
    }[]>('GET', '/users/me/blocks'),
    block: (userId: string, reason?: string) =>
      request<{ success: true }>('POST', `/users/me/blocks/${userId}`, reason ? { reason } : {}),
    unblock: (userId: string) =>
      request<{ success: true }>('DELETE', `/users/me/blocks/${userId}`),
    insights: (id: string) => request<{
      rounds_analyzed: number;
      avg_score_per_par: { '3'?: number | null; '4'?: number | null; '5'?: number | null };
      score_distribution: { eagles: number; birdies: number; pars: number; bogeys: number; doubles_or_worse: number };
      hardest_hole: { course_id: string; course_name: string; hole_num: number; par: number; avg_score: number; plays: number } | null;
      easiest_hole: { course_id: string; course_name: string; hole_num: number; par: number; avg_score: number; plays: number } | null;
      most_played_course: { course_id: string; course_name: string; n: number } | null;
      recent_trend: { last5_avg_to_par: number | null; prev5_avg_to_par: number | null; delta: number | null; improving: boolean };
    }>('GET', `/users/${id}/insights`),
    friends: () => request<any[]>('GET', '/users/me/friends'),
    friendRequests: () => request<any[]>('GET', '/users/me/friend-requests'),
    sendRequest: (friendId: string) => request<any>('POST', '/users/me/friends/request', { friendId }),
    acceptRequest: (friendId: string) => request<any>('POST', '/users/me/friends/accept', { friendId }),
    leaderboard: (friendsOnly = false) => request<any[]>('GET', `/users/leaderboard${friendsOnly ? '?friends=1' : ''}`),
    deleteAccount: () => request<any>('DELETE', '/users/me'),
    importShots: (body: {
      name?: string;
      shots: { club: string; distance_yds: number; lateral_yds?: number; recorded_at?: string }[];
    }) => request<{ success: true; match_id: string; total_shots: number; skipped: number }>(
      'POST', '/users/me/import-shots', body
    ),
  },

  weather: {
    current: (lat: number, lng: number) => request<{
      temperature_f: number | null;
      humidity_pct: number | null;
      wind_speed_mph: number | null;
      wind_from_bearing: number | null;
      precipitation_in: number;
      rain: 'none' | 'light' | 'heavy';
      elevation_ft: number | null;
      observed_at: string | null;
      cached: boolean;
    }>('GET', `/weather?lat=${lat}&lng=${lng}`),
    elevation: (lat: number, lng: number) => request<{
      elevation_m: number;
      source: 'usgs_3dep' | 'open_meteo_copernicus' | string;
      cached: boolean;
    }>('GET', `/weather/elevation?lat=${lat}&lng=${lng}`),
  },

  premium: {
    catalog: () => request<{
      features: { id: string; name: string; blurb: string }[];
      plans: { id: string; name: string; price_cents: number; period: string; savings_pct?: number }[];
    }>('GET', '/premium/catalog'),
    redeem: (code: string) => request<{
      success: boolean; plan: string; premium_until: string | null; label: string;
    }>('POST', '/premium/redeem', { code }),
  },

  messages: {
    list: (params: { matchId?: string; clanId?: string; toUserId?: string }) => {
      const q = params.matchId ? `matchId=${params.matchId}` : params.clanId ? `clanId=${params.clanId}` : `toUserId=${params.toUserId}`;
      return request<any[]>('GET', `/messages?${q}`);
    },
    send: (body: {
      matchId?: string; clanId?: string; toUserId?: string;
      body?: string;
      /** Base64-encoded audio (typically AAC/m4a from expo-av). */
      voiceBase64?: string;
      /** MIME type — defaults server-side to audio/m4a. */
      voiceMime?: string;
      /** Clip length in ms, captured at record time. Server clamps to 60s. */
      voiceDurationMs?: number;
    }) => request<any>('POST', '/messages', body),
    /** Report a message for abuse. Both DMs and channel messages route
     *  here via the `kind` discriminator. Idempotent — repeat reports
     *  from the same user collapse via DB unique constraint. */
    report: (kind: 'channel' | 'dm', messageId: string, reason?: string) =>
      request<{ success: true }>('POST', '/messages/report', { kind, messageId, reason }),
    conversations: () => request<any[]>('GET', '/messages/conversations'),
    /** Match + clan chat ids with unread messages for the current user. */
    unreadSummary: () => request<{ matches: string[]; clans: string[] }>(
      'GET', '/messages/unread-summary'
    ),
    /** Mark a chat read — call when opening a chat screen so the social
     *  tab's unread badge clears on next refresh. */
    markRead: (kind: 'dm' | 'match' | 'clan', key: string) =>
      request<{ success: true }>('POST', '/messages/read', { kind, key }),
  },

  invites: {
    list: () => request<any[]>('GET', '/invites'),
    send: (matchId: string, toUserId: string) => request<any>('POST', '/invites', { matchId, toUserId }),
    accept: (inviteId: string) => request<any>('POST', `/invites/${inviteId}/accept`),
    decline: (inviteId: string) => request<any>('POST', `/invites/${inviteId}/decline`),
  },

  courses: {
    search: (q: string) => request<any[]>('GET', `/courses/search?q=${encodeURIComponent(q)}`),
    nearby: (lat: number, lng: number) => request<any[]>('GET', `/courses/nearby?lat=${lat}&lng=${lng}`),
    get: (id: string) => request<any>('GET', `/courses/${id}`),
    leaderboard: (id: string) => request<any[]>('GET', `/courses/${id}/leaderboard`),
    reportCorrection: (id: string, body: {
      field: string;
      suggestedValue: string;
      currentValue?: string;
      teeboxId?: string;
      holeId?: string;
      notes?: string;
    }) => request<{ success: true }>('POST', `/courses/${id}/corrections`, body),

    /**
     * Batch-set pin coordinates for a course's holes from anywhere (no
     * need to be on-site). Open to any authenticated user — crowdsourced
     * with last-write-wins semantics. The server records `pin_set_by`
     * so we can audit / roll back if a course's pins get vandalised.
     *
     * Pins are applied to every teebox row sharing the same hole_num.
     */
    setPins: async (
      id: string,
      pins: { holeNum: number; lat: number; lng: number; elevation_m?: number | null }[],
    ) => {
      // URL is `/courses/admin/set-pins` for historical reasons — used to
      // be gated by an admin token. Path didn't change to avoid a breaking
      // rename across deployed clients.
      return request<{ updated: number; missing_hole_nums: number[] }>(
        'POST', '/courses/admin/set-pins', { courseId: id, pins },
      );
    },

    // ── Relative-elevation crowdsourcing ──────────────────────────────────
    // Establish per-round offset so the device's barometer-grade RELATIVE
    // accuracy can be projected onto the course's shared origin = 0 frame.
    elevationReference: (id: string, body: { lat: number; lng: number; deviceAltM: number }) =>
      request<{ offsetM: number; mode: 'anchor' | 'global' | 'seed'; distM?: number }>(
        'POST', `/courses/${id}/elevation-reference`, body
      ),
    // Batch upload of (lat, lng, elevation_relative_to_origin) samples.
    elevationPoints: (id: string, samples: { lat: number; lng: number; elevationRelM: number }[]) =>
      request<{ accepted: number }>('POST', `/courses/${id}/elevation-points`, { samples }),
    // Nearest cached relative elevation at a point (or null if too far / empty).
    elevationAt: (id: string, lat: number, lng: number, radiusM = 20) =>
      request<{ elevationRelM: number; samples: number; distM: number; lat: number; lng: number } | null>(
        'GET', `/courses/${id}/elevation-at?lat=${lat}&lng=${lng}&radiusM=${radiusM}`
      ),
    dataQuality: (id: string) => request<{
      elevation_points: number;
      elevation_samples: number;
      total_holes: number;
      holes_with_pins: number;
      pin_coverage: number;
      low_elevation: boolean;
      low_pins: boolean;
      low_data: boolean;
      thresholds: { LOW_ELEV_POINTS: number; LOW_PIN_COVERAGE: number };
    }>('GET', `/courses/${id}/data-quality`),
  },

  matches: {
    list: () => request<any[]>('GET', '/matches'),
    get: (id: string) => request<any>('GET', `/matches/${id}`),
    create: (body: {
      matchType: string;
      isPractice?: boolean;
      teeboxId?: string;
      clanId?: string;
      name?: string;
      format?: string;
      numHoles?: number;
      holesSubset?: 'front' | 'back' | 'full';
    }) => request<any>('POST', '/matches', body),
    join: (id: string, body: object) => request<any>('POST', `/matches/${id}/join`, body),
    submitScores: (id: string, body: {
      holeScores: number[];
      holeStats?: ({ putts?: number; chips?: number; fairwayHit?: boolean | null } | null)[];
      courseId?: string; teeboxId?: string;
    }) => request<any>('POST', `/matches/${id}/scores`, body),
    forfeit: (id: string) => request<any>('POST', `/matches/${id}/forfeit`, {}),
    cancel: (id: string) => request<any>('DELETE', `/matches/${id}`),
    saveShotTrack: (id: string, holeNum: number, shots: any[]) =>
      // Accepts either segment-format or legacy point-format. The server
      // sanitises both and stores them as JSONB, so callers can pass through
      // whatever shape the local state holds.
      request<any>('PUT', `/matches/${id}/shots/${holeNum}`, { shots }),
    contributePin: (id: string, holeId: string, lat: number, lng: number, elevationM?: number | null) =>
      request<{ success: true; samples: number }>('POST', `/matches/${id}/pin`, { holeId, lat, lng, elevationM }),
    listShotTracks: (id: string, userId?: string) =>
      request<{ user_id: string; hole_num: number; shots: { lat: number; lng: number }[] }[]>(
        'GET', `/matches/${id}/shots${userId ? `?user=${encodeURIComponent(userId)}` : ''}`
      ),
    started: (id: string) => request<any>('POST', `/matches/${id}/started`, {}),
    setGuests: (id: string, guests: { name: string; scores: number[]; teebox_id?: string | null }[]) =>
      request<{ success: true; count: number }>('PUT', `/matches/${id}/guests`, { guests }),
    // Tells the server "the VS intro animation has been shown to me on this
    // match, don't ever fire it again." Server uses COALESCE so the call is
    // safely idempotent — duplicate calls are no-ops.
    markIntroShown: (id: string) =>
      request<{ success: true }>('POST', `/matches/${id}/mark-intro-shown`, {}),
    progress: (id: string, body: {
      holeScores: number[];
      holeStats?: ({ putts?: number; chips?: number; fairwayHit?: boolean | null } | null)[];
      teeboxId?: string;
    }) => request<any>('POST', `/matches/${id}/progress`, body),
    /** Poll recent birdie/eagle/ace events for this match. `since` is an
     *  ISO timestamp from the previous poll; the server returns only events
     *  newer than that. Used by both the scoring screen (so opponents see
     *  the celebration) and any spectator view. */
    celebrations: (id: string, since?: string | null) =>
      request<{
        celebration_id: string;
        user_id: string;
        hole_num: number;
        score: number;
        par: number;
        kind: 'birdie' | 'eagle' | 'ace' | 'albatross';
        created_at: string;
        username: string;
        avatar_url: string | null;
        elo: number;
        user_theme_title: string | null;
        user_theme_artist: string | null;
        user_theme_artwork: string | null;
        user_theme_preview: string | null;
        clan_id: string | null;
        clan_name: string | null;
        clan_theme_title: string | null;
        clan_theme_artist: string | null;
        clan_theme_artwork: string | null;
        clan_theme_preview: string | null;
      }[]>(
        'GET',
        `/matches/${id}/celebrations${since ? `?since=${encodeURIComponent(since)}` : ''}`
      ),
  },

  finds: {
    upload: (imageBase64: string, mimeType: string, description: string) =>
      request<any>('POST', '/finds', { imageBase64, mimeType, description }),
    pair: (excludeIds?: string[]) => request<any[]>(
      'GET',
      `/finds/pair${excludeIds && excludeIds.length ? `?exclude=${encodeURIComponent(excludeIds.join(','))}` : ''}`
    ),
    vote: (winnerId: string, loserId: string) =>
      request<any>('POST', '/finds/vote', { winnerId, loserId }),
    leaderboard: () => request<any[]>('GET', '/finds/leaderboard'),
    mine: () => request<{ finds: any[]; avgElo: number | null }>('GET', '/finds/mine'),
    delete: (id: string) => request<any>('DELETE', `/finds/${id}`),
    report: (id: string, reason: string) => request<any>('POST', `/finds/${id}/report`, { reason }),
  },

  posts: {
    /** Feed timeline, newest-first. `scope` picks the audience:
     *   • 'global'  — everyone on the platform (default)
     *   • 'friends' — only the viewer + accepted friends
     *   • 'local'   — viewer + players whose home course is nearby; pass
     *                 lat/lng to anchor on current GPS, otherwise the
     *                 server falls back to the viewer's home course. */
    feed: (
      opts: {
        limit?: number;
        before?: string;
        scope?: 'global' | 'local' | 'friends';
        lat?: number;
        lng?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.before) q.set('before', opts.before);
      if (opts.scope) q.set('scope', opts.scope);
      if (typeof opts.lat === 'number' && typeof opts.lng === 'number') {
        q.set('lat', String(opts.lat));
        q.set('lng', String(opts.lng));
      }
      const qs = q.toString();
      return request<{ posts: any[]; scope?: string; localUnavailable?: boolean }>(
        'GET', `/posts/feed${qs ? `?${qs}` : ''}`,
      );
    },
    /** Create a text or photo post. Round posts can only be created
     *  server-side by the match resolver. */
    create: (body: { body?: string; imageBase64?: string; imageMime?: string }) =>
      request<any>('POST', '/posts', body),
    delete: (id: string) =>
      request<{ success: true }>('DELETE', `/posts/${id}`),
    /** Flag a feed post for moderation. Idempotent — repeat reports from
     *  the same user collapse via the DB unique constraint. */
    report: (id: string, reason?: string) =>
      request<{ success: true }>('POST', `/posts/${id}/report`, { reason }),
  },

  tournaments: {
    list: () => request<any[]>('GET', '/tournaments'),
    discover: () => request<any[]>('GET', '/tournaments/discover'),
    get: (id: string) => request<any>('GET', `/tournaments/${id}`),
    create: (body: {
      name: string;
      description?: string;
      scoring?: 'best_round' | 'total_strokes' | 'wins' | 'points';
      format?: 'stroke' | 'match_play' | 'stableford' | 'skins' | 'scramble';
      courseId?: string;
      clanId?: string;
      endsAt?: string;
      isOpen?: boolean;
    }) => request<any>('POST', '/tournaments', body),
    join: (id: string, joinCode?: string) =>
      request<{ success: true }>('POST', `/tournaments/${id}/join`, joinCode ? { joinCode } : {}),
    joinByCode: (code: string) =>
      request<{ success: true; tournament_id: string }>('POST', '/tournaments/join-by-code', { code }),
    leave: (id: string) => request<{ success: true }>('POST', `/tournaments/${id}/leave`, {}),
    delete: (id: string) => request<{ success: true }>('DELETE', `/tournaments/${id}`),
    linkMatch: (tournamentId: string, matchId: string) =>
      request<{ success: true }>('POST', `/tournaments/${tournamentId}/link-match`, { matchId }),
  },

  rounds: {
    social: (roundId: string) => request<{
      reactions: { reaction: string; count: number; mine: boolean }[];
      comments: { comment_id: string; user_id: string; username: string; body: string; created_at: string; mine: boolean }[];
    }>('GET', `/rounds/${roundId}/social`),
    toggleReaction: (roundId: string, reaction: string) =>
      request<{ added: boolean }>('POST', `/rounds/${roundId}/reactions`, { reaction }),
    addComment: (roundId: string, body: string) =>
      request<{ success: true; comment_id: string; created_at: string }>('POST', `/rounds/${roundId}/comments`, { body }),
    deleteComment: (roundId: string, commentId: string) =>
      request<any>('DELETE', `/rounds/${roundId}/comments/${commentId}`),
  },

  dm: {
    list: (userId: string) => request<any[]>('GET', `/dm/${userId}`),
    send: (userId: string, body: string) => request<any>('POST', `/dm/${userId}`, { body }),
  },

  clans: {
    list: () => request<any[]>('GET', '/clans'),
    mine: () => request<any[]>('GET', '/clans/mine'),
    get: (id: string) => request<any>('GET', `/clans/${id}`),
    create: (name: string, clanMode: string) => request<any>('POST', '/clans', { name, clanMode }),
    join: (id: string) => request<any>('POST', `/clans/${id}/join`, {}),
    update: (id: string, body: {
      name?: string;
      isPublic?: boolean;
      theme?: { trackId: string; title: string; artist: string; artworkUrl?: string; previewUrl: string } | null;
    }) => request<any>('PATCH', `/clans/${id}`, body),
    uploadAvatar: (id: string, imageBase64: string, mimeType: string) =>
      request<{ avatar_url: string }>('POST', `/clans/${id}/avatar`, { imageBase64, mimeType }),
    kick: (id: string, userId: string) => request<any>('DELETE', `/clans/${id}/members/${userId}`, {}),
    leave: (id: string, userId: string) => request<any>('DELETE', `/clans/${id}/members/${userId}`, {}),
    transfer: (id: string, toUserId: string) => request<any>('POST', `/clans/${id}/transfer`, { toUserId }),
    invite: (clanId: string, toUserId: string) => request<any>('POST', `/clans/${clanId}/invite`, { toUserId }),
    clanInvites: () => request<any[]>('GET', '/clans/invites'),
    acceptClanInvite: (inviteId: string) => request<any>('POST', `/clans/invites/${inviteId}/accept`),
    declineClanInvite: (inviteId: string) => request<any>('POST', `/clans/invites/${inviteId}/decline`),
  },
};
