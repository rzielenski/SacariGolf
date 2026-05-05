import AsyncStorage from '@react-native-async-storage/async-storage';

// Change this to your computer's local IP (run `ipconfig` to find it)
// Your phone must be on the same WiFi network
export const API_BASE = 'https://determined-perfection-production.up.railway.app';

async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem('coc_token');
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
    if (token) headers['Authorization'] = `Bearer ${token}`;
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
  if (!res.ok) throw new Error(data.error || 'Request failed');
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
  },

  users: {
    me: () => request<any>('GET', '/users/me'),
    update: (body: { pushToken?: string; handicapIndex?: number | null; username?: string; bio?: string | null; homeCourseId?: string | null }) => request<any>('PATCH', '/users/me', body),
    uploadAvatar: (imageBase64: string, mimeType: string) => request<any>('POST', '/users/me/avatar', { imageBase64, mimeType }),
    notifications: () => request<any[]>('GET', '/users/me/notifications'),
    search: (q: string) => request<any[]>('GET', `/users/search?q=${encodeURIComponent(q)}`),
    get: (id: string) => request<any>('GET', `/users/${id}`),
    friends: () => request<any[]>('GET', '/users/me/friends'),
    friendRequests: () => request<any[]>('GET', '/users/me/friend-requests'),
    sendRequest: (friendId: string) => request<any>('POST', '/users/me/friends/request', { friendId }),
    acceptRequest: (friendId: string) => request<any>('POST', '/users/me/friends/accept', { friendId }),
    leaderboard: () => request<any[]>('GET', '/users/leaderboard'),
    deleteAccount: () => request<any>('DELETE', '/users/me'),
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
    submitScores: (id: string, body: object) => request<any>('POST', `/matches/${id}/scores`, body),
    forfeit: (id: string) => request<any>('POST', `/matches/${id}/forfeit`, {}),
    cancel: (id: string) => request<any>('DELETE', `/matches/${id}`),
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
