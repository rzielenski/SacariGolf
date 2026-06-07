/**
 * Lost / found ball counter — pure-local state with a fire-and-forget
 * background sync.
 *
 * Previous design held a `server` snapshot and recomputed the displayed
 * total on every render via `applyQueue(server, recent, queue)`. The
 * trouble was the order of state updates around drain: the queue
 * dequeued first, the server snapshot updated a moment later, and in
 * the gap the projection briefly showed the stale server number. That's
 * the "bounces back and forth before settling" the user saw.
 *
 * New shape:
 *
 *   1. The displayed `totals` is local state, period. Taps mutate it
 *      directly. There is no recompute-from-server projection.
 *   2. Totals + the pending queue are persisted to AsyncStorage on every
 *      change so we survive kill / no-service.
 *   3. Each tap fires its API call in the background (idempotent via a
 *      clientId, so a retry can't double-count). On failure the action
 *      stays queued; the next tap or a focus-event triggers a drain.
 *   4. We RECONCILE WITH THE SERVER only on:
 *         • initial mount
 *         • tab focus
 *         • pull-to-refresh
 *      And only when the queue is empty (otherwise the server is missing
 *      our pending writes — overriding would clobber them). When we do
 *      reconcile, we adopt the server number directly. One paint, no
 *      flicker.
 *
 * Undo: maintained as a local "recent stack" of kinds. Pop subtracts the
 * right counter. If the stack is empty (no local context — e.g. straight
 * after opening the app), we fall back to subtracting from net + treating
 * it as 'found' optimistically; the next reconcile corrects it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { useCensor } from '../lib/censor';

type Totals = { found: number; lost: number; net: number };
type LeaderRow = Awaited<ReturnType<typeof api.balls.leaderboard>>[number];
type Queued = { id: string; op: 'log' | 'undo'; kind?: 'found' | 'lost' };

const TOTALS_KEY  = 'sacari.balls.totals.v1';
const QUEUE_KEY   = 'sacari.balls.queue.v1';
const RECENT_KEY  = 'sacari.balls.recent.v1';

function genClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export default function BallsScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  const [totals, setTotals] = useState<Totals>({ found: 0, lost: 0, net: 0 });
  const [recent, setRecent] = useState<Array<'found' | 'lost'>>([]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [scope, setScope] = useState<'global' | 'friends'>('global');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Refs let the background drainer / focus listener read the latest
  // queue + totals without depending on React's render-cycle.
  const queueRef = useRef<Queued[]>([]);
  const totalsRef = useRef<Totals>({ found: 0, lost: 0, net: 0 });
  const draining = useRef(false);

  // ── Persistence ──────────────────────────────────────────────────────
  useEffect(() => { totalsRef.current = totals;
    AsyncStorage.setItem(TOTALS_KEY, JSON.stringify(totals)).catch(() => {});
  }, [totals]);
  useEffect(() => { queueRef.current = queue;
    AsyncStorage.setItem(QUEUE_KEY,  JSON.stringify(queue)).catch(() => {});
  }, [queue]);
  useEffect(() => {
    AsyncStorage.setItem(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
  }, [recent]);

  // ── Server I/O ───────────────────────────────────────────────────────
  const loadBoard = useCallback(async () => {
    try { setBoard(await api.balls.leaderboard(scope === 'friends')); } catch { /* silent */ }
  }, [scope]);

  /** Replace local totals with server's, but ONLY if our queue is empty.
   *  With pending writes still in flight, the server hasn't seen them yet
   *  and overriding would erase the user's optimistic increments. */
  const reconcileWithServer = useCallback(async () => {
    try {
      const me = await api.balls.me();
      if (queueRef.current.length === 0) {
        const next: Totals = { found: me.found, lost: me.lost, net: me.net };
        setTotals(next);
        totalsRef.current = next;
        // Re-seed the local recent stack from the server so an Undo after
        // opening the app still knows what to subtract.
        const fromServer = (me.recent ?? []).slice().reverse().map((r) => r.kind);
        setRecent(fromServer);
      }
      loadBoard();
    } catch { /* offline — keep local */ }
  }, [loadBoard]);

  // ── Background drainer ──────────────────────────────────────────────
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
          // Dequeue ONLY. The displayed totals were already updated
          // optimistically on tap — do NOT re-set them from the response,
          // that's what caused the flicker.
          const next = queueRef.current.filter((q) => q.id !== head.id);
          queueRef.current = next;
          setQueue(next);
        } catch {
          // Network / 5xx — keep queued, bail. Next focus / tap retries.
          return;
        }
      }
      // Drain complete. Refresh the leaderboard so rank updates.
      // We DO NOT refetch /balls/me here on purpose: the local total is
      // already the truth (we just confirmed all the writes), and a
      // refetch could race the next tap and cause flicker.
      loadBoard();
    } finally {
      draining.current = false;
    }
  }, [loadBoard]);

  // ── Mount: restore local state, then reconcile ──────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [tRaw, qRaw, rRaw] = await Promise.all([
          AsyncStorage.getItem(TOTALS_KEY),
          AsyncStorage.getItem(QUEUE_KEY),
          AsyncStorage.getItem(RECENT_KEY),
        ]);
        if (tRaw) {
          const t = JSON.parse(tRaw);
          setTotals(t);
          totalsRef.current = t;
        }
        if (qRaw) {
          const q = JSON.parse(qRaw);
          setQueue(q);
          queueRef.current = q;
        }
        if (rRaw) setRecent(JSON.parse(rRaw));
      } catch { /* corrupt storage — start clean */ }
      await reconcileWithServer();
      setLoading(false);
      if (queueRef.current.length > 0) drainQueue();
    })();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus: reconcile + flush queue if anything's stuck ──────────────
  useFocusEffect(
    useCallback(() => {
      reconcileWithServer();
      if (queueRef.current.length > 0) drainQueue();
    }, [reconcileWithServer, drainQueue])
  );

  // Re-fetch the leaderboard when the scope flips.
  useEffect(() => { loadBoard(); }, [scope, loadBoard]);

  // ── Tap handlers ────────────────────────────────────────────────────
  const onLog = (kind: 'found' | 'lost') => {
    // 1. Optimistic update — instant.
    setTotals((t) => ({
      found: t.found + (kind === 'found' ? 1 : 0),
      lost:  t.lost  + (kind === 'lost'  ? 1 : 0),
      net:   t.net   + (kind === 'found' ? 1 : -1),
    }));
    setRecent((r) => [...r, kind]);
    // 2. Enqueue + kick the drainer.
    const item: Queued = { id: genClientId(), op: 'log', kind };
    setQueue((q) => {
      const next = [...q, item];
      queueRef.current = next;
      return next;
    });
    drainQueue();
  };

  const onUndo = () => {
    // Decrement the right counter using the local recent stack. If empty
    // (fresh tab open with no local context), we still optimistically
    // drop net by 1 and let the next reconcile correct found/lost.
    const last = recent[recent.length - 1];
    setTotals((t) => {
      if (last === 'found') return { found: Math.max(0, t.found - 1), lost: t.lost,                   net: t.net - 1 };
      if (last === 'lost')  return { found: t.found,                   lost: Math.max(0, t.lost - 1), net: t.net + 1 };
      // Empty stack: best-effort net drop; reconcile resolves found/lost.
      return { found: t.found, lost: t.lost, net: t.net - 1 };
    });
    if (last) setRecent((r) => r.slice(0, -1));
    const item: Queued = { id: genClientId(), op: 'undo' };
    setQueue((q) => {
      const next = [...q, item];
      queueRef.current = next;
      return next;
    });
    drainQueue();
  };

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    // First drain any pending writes so the server has them before we
    // overwrite our local total with its number.
    if (queueRef.current.length > 0) await drainQueue();
    await reconcileWithServer();
    setRefreshing(false);
  }, [drainQueue, reconcileWithServer]);

  const pending = queue.length;

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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={C.gold} />}
          ListHeaderComponent={
            <View>
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

                {pending > 0 && (
                  <Text style={styles.queuedText}>Syncing… {pending} pending</Text>
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
