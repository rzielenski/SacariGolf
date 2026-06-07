/**
 * Lost / found ball counter — optimistic UI with a persistent retry queue.
 *
 * Old version waited for every /balls/log round-trip before updating the
 * UI, so a flaky network made the counter feel sticky or just silently
 * dropped taps when offline. The fix is the standard optimistic pattern:
 *
 *   1. Tap updates the displayed totals INSTANTLY via a queued action.
 *   2. The action is persisted to AsyncStorage so it survives a kill or a
 *      no-service stretch.
 *   3. A background drainer flushes the queue serially, retrying on
 *      failure. Each action carries a clientId; the server dedupes via
 *      the partial-unique index on ball_log + the ball_log_undo ledger
 *      (see backend/src/routes/balls.ts) so a retry can't double-count.
 *   4. When the queue drains, we reconcile by re-reading server totals;
 *      the server wins any disagreement (e.g. logs from another device).
 *
 * Displayed totals = serverTotals + queue effects. Undo "pops" the most
 * recent kind off a virtual stack seeded by serverRecent so a fresh
 * Undo (no queued logs yet) still removes the right counter.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { useCensor } from '../lib/censor';

type Totals = { found: number; lost: number; net: number };
type LeaderRow = Awaited<ReturnType<typeof api.balls.leaderboard>>[number];
type RecentEntry = { kind: 'found' | 'lost' };
type Queued = { id: string; op: 'log' | 'undo'; kind?: 'found' | 'lost' };

const QUEUE_KEY = 'sacari.balls.queue.v1';
const DRAIN_INTERVAL_MS = 15_000;     // periodic retry when items remain queued
const FLUSH_DEBOUNCE_MS = 200;        // batch fast taps into one drain pass

function genClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Project the queue onto the server's current state. We seed a "recent
 * kinds" stack from the server's recent log so an Undo issued before any
 * local Log still knows what to subtract. Each queue item then either
 * pushes (log) or pops (undo) the stack. Output is what the hero card
 * should display.
 */
function applyQueue(server: Totals, serverRecent: RecentEntry[], queue: Queued[]): Totals {
  let found = server.found;
  let lost  = server.lost;
  // serverRecent is newest-first per the API; reverse so push/pop walk
  // the natural chronological order.
  const stack: Array<'found' | 'lost'> = [...serverRecent].reverse().map((r) => r.kind);
  for (const a of queue) {
    if (a.op === 'log' && (a.kind === 'found' || a.kind === 'lost')) {
      stack.push(a.kind);
      if (a.kind === 'found') found++;
      else lost++;
    } else if (a.op === 'undo') {
      const k = stack.pop();
      if (k === 'found') found = Math.max(0, found - 1);
      else if (k === 'lost') lost = Math.max(0, lost - 1);
      // Empty stack: server reconcile on drain will settle the truth.
    }
  }
  return { found, lost, net: found - lost };
}

async function readQueue(): Promise<Queued[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
async function writeQueue(q: Queued[]) {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* non-fatal */ }
}

export default function BallsScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  const [server, setServer] = useState<Totals>({ found: 0, lost: 0, net: 0 });
  const [serverRecent, setServerRecent] = useState<RecentEntry[]>([]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<'global' | 'friends'>('global');

  // Refs so the drainer (running outside React's render cycle) reads the
  // latest queue without relying on re-renders happening in between awaits.
  const queueRef = useRef<Queued[]>([]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const draining = useRef(false);
  const drainDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totals = applyQueue(server, serverRecent, queue);

  // ── Server loaders ────────────────────────────────────────────────────
  const loadBoard = useCallback(async () => {
    try { setBoard(await api.balls.leaderboard(scope === 'friends')); } catch { /* silent */ }
  }, [scope]);
  const loadServer = useCallback(async () => {
    try {
      const me = await api.balls.me();
      setServer({ found: me.found, lost: me.lost, net: me.net });
      setServerRecent((me.recent ?? []).map((r) => ({ kind: r.kind })));
    } catch { /* silent — keep last known */ }
  }, []);

  // ── Queue persistence + drainer ───────────────────────────────────────
  const persist = useCallback((q: Queued[]) => { writeQueue(q); }, []);

  const drainQueue = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queueRef.current.length > 0) {
        const head = queueRef.current[0];
        try {
          if (head.op === 'log' && head.kind) {
            await api.balls.log(head.kind, head.id);
          } else if (head.op === 'undo') {
            await api.balls.undo(head.id);
          }
          // Dequeue by id so we don't trip over concurrently-enqueued items.
          const next = queueRef.current.filter((q) => q.id !== head.id);
          queueRef.current = next;
          setQueue(next);
          persist(next);
        } catch {
          // Network / 5xx — keep the item in the queue and bail; the next
          // tap or the periodic timer will retry.
          return;
        }
      }
      // Queue empty: server is now the source of truth.
      await loadServer();
      loadBoard();
    } finally {
      draining.current = false;
    }
  }, [loadServer, loadBoard, persist]);

  // Coalesce fast taps so a flurry of +/- in 200ms triggers ONE drain pass.
  const scheduleDrain = useCallback(() => {
    if (drainDebounceTimer.current) clearTimeout(drainDebounceTimer.current);
    drainDebounceTimer.current = setTimeout(() => { drainQueue(); }, FLUSH_DEBOUNCE_MS);
  }, [drainQueue]);

  // Initial mount: restore queue from AsyncStorage, load server, kick drainer.
  useEffect(() => {
    (async () => {
      const restored = await readQueue();
      if (restored.length > 0) {
        setQueue(restored);
        queueRef.current = restored;
      }
      await Promise.all([loadServer(), loadBoard()]);
      setLoading(false);
      // If we restored anything, flush it now.
      if (restored.length > 0) drainQueue();
    })();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic retry: if anything is stuck in the queue, try again every 15s.
  useEffect(() => {
    const t = setInterval(() => {
      if (queueRef.current.length > 0) drainQueue();
    }, DRAIN_INTERVAL_MS);
    return () => clearInterval(t);
  }, [drainQueue]);

  // ── Tap handlers ──────────────────────────────────────────────────────
  const enqueue = useCallback((op: 'log' | 'undo', kind?: 'found' | 'lost') => {
    const item: Queued = { id: genClientId(), op, ...(kind ? { kind } : {}) };
    setQueue((prev) => {
      const next = [...prev, item];
      queueRef.current = next;
      persist(next);
      return next;
    });
    scheduleDrain();
  }, [persist, scheduleDrain]);

  const onLog  = (kind: 'found' | 'lost') => enqueue('log', kind);
  const onUndo = () => enqueue('undo');

  // Pull-to-refresh: re-read server + leaderboard. Doesn't touch the queue.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadServer(), loadBoard()]);
    setRefreshing(false);
  }, [loadServer, loadBoard]);

  // When the leaderboard scope flips, just refetch the board.
  useEffect(() => { loadBoard(); }, [scope, loadBoard]);

  const queuedCount = queue.length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={styles.titleBox}>
          <Text style={styles.title}>Ball Count</Text>
          <Text style={styles.subtitle}>Found vs. lost</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <FlatList
          data={board}
          keyExtractor={(r) => r.user_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.gold} />}
          ListHeaderComponent={
            <View>
              {/* Counter hero. Buttons are NEVER disabled — they just enqueue. */}
              <View style={styles.hero}>
                <Text style={styles.heroLabel}>YOUR BALL COUNT</Text>
                <Text style={styles.heroNet}>{totals.net > 0 ? `+${totals.net}` : totals.net}</Text>
                <View style={styles.splitRow}>
                  <View style={styles.splitCell}>
                    <Text style={[styles.splitVal, { color: C.green }]}>{totals.found}</Text>
                    <Text style={styles.splitLabel}>FOUND</Text>
                  </View>
                  <View style={styles.splitDivider} />
                  <View style={styles.splitCell}>
                    <Text style={[styles.splitVal, { color: C.red }]}>{totals.lost}</Text>
                    <Text style={styles.splitLabel}>LOST</Text>
                  </View>
                </View>

                <View style={styles.logRow}>
                  <TouchableOpacity
                    style={[styles.logBtn, { borderColor: C.green, backgroundColor: C.green + '1f' }]}
                    onPress={() => onLog('found')}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.logBtnText, { color: C.green }]}>＋ Found a ball</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.logBtn, { borderColor: C.red, backgroundColor: C.red + '1f' }]}
                    onPress={() => onLog('lost')}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.logBtnText, { color: C.red }]}>－ Lost a ball</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity onPress={onUndo} hitSlop={8}>
                  <Text style={styles.undoText}>Undo last</Text>
                </TouchableOpacity>

                {/* Subtle "n queued / not yet saved" indicator. Reassures
                    the user the tap landed even when offline. */}
                {queuedCount > 0 && (
                  <Text style={styles.queuedText}>
                    Syncing… {queuedCount} pending
                  </Text>
                )}
              </View>

              <View style={styles.scopeRow}>
                {(['global', 'friends'] as const).map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[styles.scopeBtn, scope === s && styles.scopeBtnActive]}
                    onPress={() => setScope(s)}
                  >
                    <Text style={[styles.scopeBtnText, scope === s && styles.scopeBtnTextActive]}>
                      {s === 'global' ? 'Global' : 'Friends'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.boardTitle}>Most balls found</Text>
            </View>
          }
          renderItem={({ item }) => (
            <BallRow row={item} isMe={item.user_id === user?.user_id} censor={censor} />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No balls logged yet. Find one and tap ＋ to get on the board.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function BallRow({ row, isMe, censor }: { row: LeaderRow; isMe: boolean; censor: (s: string) => string }) {
  const medalColor =
    row.rank === 1 ? C.gold :
    row.rank === 2 ? '#c0c0c0' :
    row.rank === 3 ? '#a1673a' : C.textDim;

  return (
    <TouchableOpacity
      style={[styles.row, isMe && styles.rowMe]}
      onPress={() => router.push(`/user/${row.user_id}` as any)}
      activeOpacity={0.7}
    >
      <Text style={[styles.rank, { color: medalColor, fontFamily: row.rank <= 3 ? F.serif : undefined }]}>
        {row.rank <= 3 ? ['I', 'II', 'III'][row.rank - 1] : `#${row.rank}`}
      </Text>
      <UserAvatar username={row.username} avatarUrl={row.avatar_url} size={40} borderRadius={4} />
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <Text style={styles.username}>{censor(row.username)}</Text>
          {isMe && <Text style={styles.youBadge}>You</Text>}
        </View>
        <Text style={styles.meta}>{row.found} found · {row.lost} lost</Text>
      </View>
      <View style={styles.netBox}>
        <Text style={styles.netVal}>{row.net > 0 ? `+${row.net}` : row.net}</Text>
        <Text style={styles.netLabel}>NET</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60, paddingHorizontal: 30 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: { width: 60 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  titleBox: { alignItems: 'center' },
  title: { color: C.text, fontSize: 18, fontWeight: '900' },
  subtitle: { color: C.gold, fontSize: 12, fontWeight: '700', marginTop: 2 },

  listContent: { padding: 16, paddingBottom: 40 },

  hero: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 2, borderColor: C.gold,
    padding: 18, alignItems: 'center', marginBottom: 14,
  },
  heroLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  heroNet: { fontFamily: F.serif, color: C.gold, fontSize: 56, fontWeight: '900', marginTop: 2 },
  splitRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 16 },
  splitCell: { alignItems: 'center', minWidth: 70 },
  splitVal: { fontSize: 22, fontWeight: '900' },
  splitLabel: { color: C.textDim, fontSize: 10, fontWeight: '700', marginTop: 1, letterSpacing: 1 },
  splitDivider: { width: 1, height: 34, backgroundColor: C.border, marginHorizontal: 18 },

  logRow: { flexDirection: 'row', gap: 10, width: '100%' },
  logBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1,
  },
  logBtnText: { fontWeight: '900', fontSize: 14 },
  undoText: { color: C.textMuted, fontSize: 12, fontWeight: '700', marginTop: 12, textDecorationLine: 'underline' },
  queuedText: { color: C.gold, fontSize: 11, fontWeight: '700', marginTop: 8, letterSpacing: 0.5 },

  scopeRow: { flexDirection: 'row', gap: 8, paddingBottom: 10 },
  scopeBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  scopeBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  scopeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 13 },
  scopeBtnTextActive: { color: C.gold },

  boardTitle: { color: C.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginBottom: 8, marginTop: 2 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 6, padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  rowMe: { borderColor: C.gold },
  rank: { width: 32, textAlign: 'center', fontSize: 13, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  username: { color: C.text, fontWeight: '700', fontSize: 15 },
  youBadge: {
    color: C.gold, fontSize: 10, fontWeight: '700',
    backgroundColor: C.gold + '22', borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: C.gold,
  },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  netBox: { alignItems: 'center', minWidth: 44 },
  netVal: { fontFamily: F.serif, fontSize: 20, fontWeight: '700', color: C.gold },
  netLabel: { color: C.textDim, fontSize: 9, marginTop: 1 },

  emptyText: { color: C.textMuted, fontSize: 14, textAlign: 'center' },
});
