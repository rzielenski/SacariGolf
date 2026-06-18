import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { IdentityAvatar, IdentityName } from '../components/UserIdentity';
import { useCensor } from '../lib/censor';
import { rankForElo, rankBadge } from '../lib/rank';

type Mode = 'all' | 'solo' | 'duo' | 'squad';
const MODES: { key: Mode; label: string }[] = [
  { key: 'all',   label: 'Overall' },
  { key: 'solo',  label: 'Solo' },
  { key: 'duo',   label: 'Duo' },
  { key: 'squad', label: 'Squad' },
];

export default function LeaderboardScreen() {
  const insets = useSafeAreaInsets();
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

  const isTeamMode = mode === 'duo' || mode === 'squad';
  // "You are #N" only applies to the individual boards (you can be in
  // several teams, so it's ambiguous on the team boards — skip it there).
  const myRank = isTeamMode ? 0 : players.findIndex((p) => p.user_id === user?.user_id) + 1;

  return (
    <View style={styles.container}>
      {/* Safe-area padding: fixed 56pt sat under the Dynamic Island on Pro
          models (59pt inset). */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
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
        <Text style={styles.seasonBannerText}>🏆  Season Ladder · divisions & monthly standings</Text>
        <Text style={styles.seasonBannerChev}>›</Text>
      </TouchableOpacity>

      {/* Ball-count entry — running found/lost tally + leaderboard. */}
      <TouchableOpacity style={styles.ballBanner} onPress={() => router.push('/balls' as any)} activeOpacity={0.8}>
        <Text style={styles.ballBannerText}>⛳  Ball Count · log found & lost balls</Text>
        <Text style={styles.ballBannerChev}>›</Text>
      </TouchableOpacity>

      {/* Mode selector — Overall SR vs per-mode (ranked by wins). */}
      <View style={styles.modeRow}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m.key}
            style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
            onPress={() => { setMode(m.key); setLoading(true); }}
            disabled={loading}
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
            disabled={loading}
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
          // Player rows key on user_id; team (duo/squad) rows on clan_id.
          keyExtractor={(item) => item.user_id ?? item.clan_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
          renderItem={({ item, index }) => (
            isTeamMode
              ? <TeamRow team={item} rank={index + 1} />
              : <PlayerRow player={item} rank={index + 1} isMe={item.user_id === user?.user_id} />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                {mode === 'all'
                  ? 'No players yet.'
                  : isTeamMode
                  ? `No ${MODES.find((m) => m.key === mode)?.label.toLowerCase()} teams yet.`
                  : `No ${MODES.find((m) => m.key === mode)?.label.toLowerCase()} players yet.`}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

// Individual board row (Overall / Solo). Every board ranks by SR and
// shows the raw SR number as the headline stat (rank tier still drives
// the accent color + the meta line for context).
function PlayerRow({ player, rank, isMe }: {
  player: any; rank: number; isMe: boolean;
}) {
  const c = useCensor();
  const r = rankForElo(player.elo);
  const eloColor = r.color;

  const medalColor =
    rank === 1 ? C.gold :
    rank === 2 ? '#c0c0c0' :
    rank === 3 ? '#a1673a' : C.textDim;

  const winRate = player.total_matches > 0
    ? Math.round((player.total_wins / player.total_matches) * 100)
    : 0;
  // Division + SR, e.g. "B III 23". Obsidian shows raw SR ("OBS 1620").
  const badge = rankBadge(player.elo);
  const metaLine = `${player.total_matches}M · ${winRate}% WR`;

  return (
    <TouchableOpacity
      style={[styles.row, isMe && styles.rowMe]}
      onPress={() => router.push(`/user/${player.user_id}` as any)}
      activeOpacity={0.7}
    >
      <Text style={[styles.rank, { color: medalColor, fontFamily: rank <= 3 ? F.serif : undefined }]}>
        {rank <= 3 ? ['I', 'II', 'III'][rank - 1] : `#${rank}`}
      </Text>
      <IdentityAvatar
        visual={player.equipped_visual}
        username={player.username}
        avatarUrl={player.avatar_url}
        size={40}
        borderRadius={4}
      />
      <View style={styles.middle}>
        <IdentityName
          visual={player.equipped_visual}
          style={styles.username}
          numberOfLines={1}
        >
          {c(player.username)}
        </IdentityName>
        <Text style={styles.meta} numberOfLines={1}>{metaLine}</Text>
      </View>
      <View style={styles.eloBox}>
        <Text style={[styles.rankBadgeText, { color: eloColor }]} numberOfLines={1}>{badge}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Team board row (Duo / Squad). Shows the team name + its SR (the
// average of its members' ratings, computed server-side) and highlights
// teams the current user belongs to. Tapping opens the clan screen.
function TeamRow({ team, rank }: { team: any; rank: number }) {
  const c = useCensor();
  const isMine = !!team.is_mine;

  const medalColor =
    rank === 1 ? C.gold :
    rank === 2 ? '#c0c0c0' :
    rank === 3 ? '#a1673a' : C.textDim;

  const winRate = team.total_matches > 0
    ? Math.round((team.total_wins / team.total_matches) * 100)
    : 0;

  return (
    <TouchableOpacity
      style={[styles.row, isMine && styles.rowMe]}
      onPress={() => router.push(`/clan/${team.clan_id}` as any)}
      activeOpacity={0.7}
    >
      <Text style={[styles.rank, { color: medalColor, fontFamily: rank <= 3 ? F.serif : undefined }]}>
        {rank <= 3 ? ['I', 'II', 'III'][rank - 1] : `#${rank}`}
      </Text>
      <UserAvatar username={team.name} avatarUrl={team.avatar_url} size={40} borderRadius={8} />
      <View style={styles.middle}>
        <Text style={styles.username} numberOfLines={1}>{c(team.name)}</Text>
        <Text style={styles.meta} numberOfLines={1}>{team.member_count} members · {winRate}% WR</Text>
      </View>
      <View style={styles.eloBox}>
        <Text style={[styles.elo, { color: C.gold }]} numberOfLines={1}>{team.team_elo}</Text>
        <Text style={styles.eloLabel}>TEAM SR</Text>
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

  rank: { width: 28, textAlign: 'center', fontSize: 13, fontWeight: '700', color: C.textDim },
  avatar: { width: 40, height: 40, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontWeight: '800', fontSize: 16 },
  // Shrinkable middle column. minWidth:0 lets the name/meta ellipsize
  // instead of pushing the rank stat off the row or overlapping it.
  middle: { flex: 1, minWidth: 0 },
  username: { color: C.text, fontWeight: '700', fontSize: 15 },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  // Right-side stat. flexShrink:0 + right-align so it never collides with
  // a long name; wide enough for "B III 23" / "TEAM SR".
  eloBox: { alignItems: 'flex-end', minWidth: 66, flexShrink: 0 },
  elo: { fontFamily: F.serif, fontSize: 20, fontWeight: '700' },
  eloLabel: { color: C.textDim, fontSize: 9, marginTop: 1 },
  rankBadgeText: { fontFamily: F.serif, fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },

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
