import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';

function EloColor(elo: number) {
  if (elo >= 2000) return '#a8d8f0';
  if (elo >= 1800) return '#c0c0d0';
  if (elo >= 1600) return C.gold;
  if (elo >= 1400) return '#c0c0c0';
  return '#cd7f32';
}

export default function LeaderboardScreen() {
  const { user } = useAuth();
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<'global' | 'friends'>('global');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setPlayers(await api.users.leaderboard(scope === 'friends'));
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const myRank = players.findIndex((p) => p.user_id === user?.user_id) + 1;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={styles.titleBox}>
          <Text style={styles.title}>Leaderboard</Text>
          {myRank > 0 && <Text style={styles.subtitle}>You are #{myRank}</Text>}
        </View>
        <View style={{ width: 60 }} />
      </View>

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

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <FlatList
          data={players}
          keyExtractor={(p) => p.user_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
          renderItem={({ item, index }) => (
            <PlayerRow
              player={item}
              rank={index + 1}
              isMe={item.user_id === user?.user_id}
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No players yet.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function PlayerRow({ player, rank, isMe }: { player: any; rank: number; isMe: boolean }) {
  const eloColor = EloColor(player.elo);
  const winRate = player.total_matches > 0
    ? Math.round((player.total_wins / player.total_matches) * 100)
    : 0;

  const medalColor =
    rank === 1 ? C.gold :
    rank === 2 ? '#c0c0c0' :
    rank === 3 ? '#a1673a' : C.textDim;

  return (
    <TouchableOpacity
      style={[styles.row, isMe && styles.rowMe]}
      onPress={() => router.push(`/user/${player.user_id}` as any)}
      activeOpacity={0.7}
    >
      <Text style={[styles.rank, { color: medalColor, fontFamily: rank <= 3 ? F.serif : undefined }]}>
        {rank <= 3 ? ['I', 'II', 'III'][rank - 1] : `#${rank}`}
      </Text>
      <UserAvatar
        username={player.username}
        avatarUrl={player.avatar_url}
        size={40}
        borderRadius={4}
        tintColor={eloColor + '22'}
      />
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <Text style={styles.username}>{player.username}</Text>
          {isMe && <Text style={styles.youBadge}>You</Text>}
        </View>
        <Text style={styles.meta}>
          {player.total_matches}M · {winRate}% WR
        </Text>
      </View>
      <View style={styles.eloBox}>
        <Text style={[styles.elo, { color: eloColor }]}>{player.elo}</Text>
        <Text style={styles.eloLabel}>ELO</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60 },

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

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 6, padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  rowMe: { borderColor: C.gold },

  rank: { width: 32, textAlign: 'center', fontSize: 13, fontWeight: '700', color: C.textDim },
  avatar: { width: 40, height: 40, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontWeight: '800', fontSize: 16 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  username: { color: C.text, fontWeight: '700', fontSize: 15 },
  youBadge: {
    color: C.gold, fontSize: 10, fontWeight: '700',
    backgroundColor: C.gold + '22', borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: C.gold,
  },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  eloBox: { alignItems: 'center', minWidth: 48 },
  elo: { fontFamily: F.serif, fontSize: 20, fontWeight: '700' },
  eloLabel: { color: C.textDim, fontSize: 9, marginTop: 1 },

  emptyText: { color: C.textMuted, fontSize: 15 },

  scopeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  scopeBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  scopeBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  scopeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 13 },
  scopeBtnTextActive: { color: C.gold },
});
