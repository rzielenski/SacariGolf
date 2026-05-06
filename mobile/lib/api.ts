import AsyncStorage from '@react-native-async-storage/async-storage';

// Change this to your computer's local IP (run `ipconfig` to find it)
// Your phone must be on the same WiFi network
export const API_BASE = 'https://determined-perfection-production.up.railway.app';

async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem('coc_token');
}

// Sentinel error so callers can distinguish "no token at all / session ended"
// from a real server error and silently bail rather than alerting the user.
export class NotAuthenticatedError extends Error {
  constructor(message = 'Not signed in') { super(message); this.name = 'NotAuthenticatedError'; }
}

// AuthProvider registers a callback so api.ts can ask it to clear state when
// the backend rejects our token. Avoids a circular import.
let onSessionInvalid: (() => void) | null = null;
export function setSessionInvalidHandler(fn: (() => void) | null) {
  onSessionInvalid = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: object,
  auth = true
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getToken();
    if (!token) {
      // Fail fast client-side rather than firing an unauthenticated request
      // that the server will reject with a confusing "Missing token" error.
      throw new NotAuthenticatedError();
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Server returned HTML (e.g. 404 page or crash) — surface a clean message
    throw new Error(`Server error (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) {
    // Backend says our token is bad → trigger global logout so AuthGuard
    // routes to login. Throw NotAuthenticated so callers can bail quietly.
    if (res.status === 401 && (data?.error === 'Missing token' || data?.error === 'Invalid token')) {
      if (onSessionInvalid) onSessionInvalid();
      throw new NotAuthenticatedError(data.error);
    }
    throw new Error(data.error || 'Request failed');
  }
  return data as T;
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
    update: (body: { pushToken?: string; handicapIndex?: number | null; username?: string; bio?: string | null; homeCourseId?: string | null }) => request<any>('PATCH', '/users/me', body),
    uploadAvatar: (imageBase64: string, mimeType: string) => request<any>('POST', '/users/me/avatar', { imageBase64, mimeType }),
    notifications: () => request<{ notifications: any[]; unread_count: number }>('GET', '/users/me/notifications'),
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
        dispersion: { lateral_yds: number; long_yds: number; dist_yds: number }[];
      }[];
    }>('GET', `/users/${id}/club-stats`),
    activeRound: (id: string) => request<any | null>('GET', `/users/${id}/active-round`),
    friends: () => request<any[]>('GET', '/users/me/friends'),
    friendRequests: () => request<any[]>('GET', '/users/me/friend-requests'),
    sendRequest: (friendId: string) => request<any>('POST', '/users/me/friends/request', { friendId }),
    acceptRequest: (friendId: string) => request<any>('POST', '/users/me/friends/accept', { friendId }),
    leaderboard: (friendsOnly = false) => request<any[]>('GET', `/users/leaderboard${friendsOnly ? '?friends=1' : ''}`),
    deleteAccount: () => request<any>('DELETE', '/users/me'),
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
    send: (body: { matchId?: string; clanId?: string; toUserId?: string; body: string }) =>
      request<any>('POST', '/messages', body),
    conversations: () => request<any[]>('GET', '/messages/conversations'),
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
  },

  matches: {
    list: () => request<any[]>('GET', '/matches'),
    get: (id: string) => request<any>('GET', `/matches/${id}`),
    create: (body: { matchType: string; isPractice?: boolean; teeboxId?: string; clanId?: string; name?: string; format?: string; numHoles?: number }) => request<any>('POST', '/matches', body),
    join: (id: string, body: object) => request<any>('POST', `/matches/${id}/join`, body),
    submitScores: (id: string, body: {
      holeScores: number[];
      holeStats?: ({ putts?: number; chips?: number; fairwayHit?: boolean | null } | null)[];
      courseId?: string; teeboxId?: string;
    }) => request<any>('POST', `/matches/${id}/scores`, body),
    forfeit: (id: string) => request<any>('POST', `/matches/${id}/forfeit`, {}),
    cancel: (id: string) => request<any>('DELETE', `/matches/${id}`),
    saveShotTrack: (id: string, holeNum: number, shots: { lat: number; lng: number; elevation_m?: number; club?: string; lie?: string }[]) =>
      request<any>('PUT', `/matches/${id}/shots/${holeNum}`, { shots }),
    contributePin: (id: string, holeId: string, lat: number, lng: number, elevationM?: number | null) =>
      request<any>('POST', `/matches/${id}/pin`, { holeId, lat, lng, elevationM }),
    listShotTracks: (id: string, userId?: string) =>
      request<{ user_id: string; hole_num: number; shots: { lat: number; lng: number }[] }[]>(
        'GET', `/matches/${id}/shots${userId ? `?user=${encodeURIComponent(userId)}` : ''}`
      ),
    started: (id: string) => request<any>('POST', `/matches/${id}/started`, {}),
    progress: (id: string, body: {
      holeScores: number[];
      holeStats?: ({ putts?: number; chips?: number; fairwayHit?: boolean | null } | null)[];
      teeboxId?: string;
    }) => request<any>('POST', `/matches/${id}/progress`, body),
  },

  finds: {
    upload: (imageBase64: string, mimeType: string, description: string) =>
      request<any>('POST', '/finds', { imageBase64, mimeType, description }),
    pair: () => request<any[]>('GET', '/finds/pair'),
    vote: (winnerId: string, loserId: string) =>
      request<any>('POST', '/finds/vote', { winnerId, loserId }),
    leaderboard: () => request<any[]>('GET', '/finds/leaderboard'),
    mine: () => request<{ finds: any[]; avgElo: number | null }>('GET', '/finds/mine'),
    delete: (id: string) => request<any>('DELETE', `/finds/${id}`),
    report: (id: string, reason: string) => request<any>('POST', `/finds/${id}/report`, { reason }),
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
    update: (id: string, body: { name?: string; isPublic?: boolean }) => request<any>('PATCH', `/clans/${id}`, body),
    kick: (id: string, userId: string) => request<any>('DELETE', `/clans/${id}/members/${userId}`, {}),
    leave: (id: string, userId: string) => request<any>('DELETE', `/clans/${id}/members/${userId}`, {}),
    transfer: (id: string, toUserId: string) => request<any>('POST', `/clans/${id}/transfer`, { toUserId }),
    invite: (clanId: string, toUserId: string) => request<any>('POST', `/clans/${clanId}/invite`, { toUserId }),
    clanInvites: () => request<any[]>('GET', '/clans/invites'),
    acceptClanInvite: (inviteId: string) => request<any>('POST', `/clans/invites/${inviteId}/accept`),
    declineClanInvite: (inviteId: string) => request<any>('POST', `/clans/invites/${inviteId}/decline`),
  },
};
