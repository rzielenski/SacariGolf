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
import { useCensor } from '../lib/censor';
import { rankForElo } from '../lib/rank';

type Mode = 'all' | 'solo' | 'duo' | 'squad';
const MODES: { key: Mode; label: string }[] = [
  { key: 'all',   label: 'Overall' },
  { key: 'solo',  label: 'Solo' },
  { key: 'duo',   label: 'Duo' },
  { key: 'squad', label: 'Squad' },
];

export default function LeaderboardScreen() {
  const { user } = useAuth();
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<'global' | 'friends'>('global');
  const [mode, setMode] = useState<Mode>('all');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setPlayers(await api.users.leaderboard(scope === 'friends', mode));
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scope, mode]);

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

      {/* Season ladder entry — the competitive divisions + monthly standings. */}
      <TouchableOpacity style={styles.seasonBanner} onPress={() => router.push('/seasons' as any)} activeOpacity={0.8}>
        <Text style={styles.seasonBannerText}>🏆  Season Ladder — divisions & monthly standings</Text>
        <Text style={styles.seasonBannerChev}>›</Text>
      </TouchableOpacity>

      {/* Ball-count entry — running found/lost tally + leaderboard. */}
      <TouchableOpacity style={styles.ballBanner} onPress={() => router.push('/balls' as any)} activeOpacity={0.8}>
        <Text style={styles.ballBannerText}>⛳  Ball Count — log found & lost balls</Text>
        <Text style={styles.ballBannerChev}>›</Text>
      </TouchableOpacity>

      {/* Mode selector — Overall ELO vs per-mode (ranked by wins). */}
      <View style={styles.modeRow}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m.key}
            style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
            onPress={() => { setMode(m.key); setLoading(true); }}
          >
            <Text style={[styles.modeBtnText, mode === m.key && styles.modeBtnTextActive]}>
              {m.label}
            </Text>
          </TouchableOpacity>
        ))}
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
              mode={mode}
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                {mode === 'all'
                  ? 'No players yet.'
                  : `No ${MODES.find((m) => m.key === mode)?.label.toLowerCase()} matches played yet.`}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function PlayerRow({ player, rank, isMe, mode }: {
  player: any; rank: number; isMe: boolean; mode: Mode;
}) {
  const c = useCensor();
  const r = rankForElo(player.elo);
  const eloColor = r.color;

  const medalColor =
    rank === 1 ? C.gold :
    rank === 2 ? '#c0c0c0' :
    rank === 3 ? '#a1673a' : C.textDim;

  // Overall board → ELO + win-rate meta. Mode board → wins + W/L meta.
  let statValue: string;
  let statLabel: string;
  let metaLine: string;
  if (mode === 'all') {
    const winRate = player.total_matches > 0
      ? Math.round((player.total_wins / player.total_matches) * 100)
      : 0;
    statValue = r.isObsidian ? String(player.elo) : r.shortLabel;
    statLabel = r.isObsidian ? 'ELO' : 'RANK';
    metaLine = `${player.total_matches}M · ${winRate}% WR`;
  } else {
    const wins = player.mode_wins ?? 0;
    const matches = player.mode_matches ?? 0;
    const wr = matches > 0 ? Math.round((wins / matches) * 100) : 0;
    statValue = String(wins);
    statLabel = 'WINS';
    metaLine = `${matches} played · ${wr}% WR`;
  }

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
          <Text style={styles.username}>{c(player.username)}</Text>
          {isMe && <Text style={styles.youBadge}>You</Text>}
        </View>
        <Text style={styles.meta}>{metaLine}</Text>
      </View>
      <View style={styles.eloBox}>
        <Text style={[styles.elo, { color: eloColor }]}>{statValue}</Text>
        <Text style={styles.eloLabel}>{statLabel}</Text>
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

  seasonBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 8, backgroundColor: C.gold + '18', borderWidth: 1, borderColor: C.gold,
  },
  seasonBannerText: { color: C.gold, fontWeight: '800', fontSize: 13, flex: 1 },
  seasonBannerChev: { color: C.gold, fontSize: 20, fontWeight: '900' },

  ballBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 8, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 8, backgroundColor: C.green + '18', borderWidth: 1, borderColor: C.green,
  },
  ballBannerText: { color: C.green, fontWeight: '800', fontSize: 13, flex: 1 },
  ballBannerChev: { color: C.green, fontSize: 20, fontWeight: '900' },

  modeRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
  modeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  modeBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  modeBtnText: { color: C.textMuted, fontWeight: '800', fontSize: 12 },
  modeBtnTextActive: { color: C.bg },

  scopeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  scopeBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  scopeBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  scopeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 13 },
  scopeBtnTextActive: { color: C.gold },
});
