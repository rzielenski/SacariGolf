import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { useCensor } from '../lib/censor';

type Totals = { found: number; lost: number; net: number };
type LeaderRow = Awaited<ReturnType<typeof api.balls.leaderboard>>[number];

export default function BallsScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  const [totals, setTotals] = useState<Totals>({ found: 0, lost: 0, net: 0 });
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'global' | 'friends'>('global');

  const loadBoard = useCallback(async () => {
    try {
      setBoard(await api.balls.leaderboard(scope === 'friends'));
    } catch { /* silent */ }
  }, [scope]);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [me] = await Promise.all([api.balls.me(), loadBoard()]);
      setTotals({ found: me.found, lost: me.lost, net: me.net });
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadBoard]);

  useEffect(() => { load(); }, [load]);

  // Log / undo: update the hero totals from the server response immediately,
  // then refresh the leaderboard in the background so the rank reflects it.
  const act = useCallback(async (fn: () => Promise<Totals>) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await fn();
      setTotals(next);
      loadBoard();
    } catch { /* silent */ } finally {
      setBusy(false);
    }
  }, [busy, loadBoard]);

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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
          ListHeaderComponent={
            <View>
              {/* Counter hero */}
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
                    onPress={() => act(() => api.balls.log('found'))}
                    disabled={busy}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.logBtnText, { color: C.green }]}>＋ Found a ball</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.logBtn, { borderColor: C.red, backgroundColor: C.red + '1f' }]}
                    onPress={() => act(() => api.balls.log('lost'))}
                    disabled={busy}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.logBtnText, { color: C.red }]}>－ Lost a ball</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity onPress={() => act(() => api.balls.undo())} disabled={busy} hitSlop={8}>
                  <Text style={styles.undoText}>Undo last</Text>
                </TouchableOpacity>
              </View>

              {/* Scope toggle */}
              <View style={styles.scopeRow}>
                {(['global', 'friends'] as const).map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[styles.scopeBtn, scope === s && styles.scopeBtnActive]}
                    onPress={() => { setScope(s); setLoading(true); }}
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
