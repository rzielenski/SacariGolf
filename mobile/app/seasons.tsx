import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { useCensor } from '../lib/censor';
import { rankForElo, rankHeadline } from '../lib/rank';

type SeasonData = Awaited<ReturnType<typeof api.seasons.current>>;
type StandingRow = Awaited<ReturnType<typeof api.seasons.standings>>['standings'][number];

export default function SeasonsScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  const [data, setData] = useState<SeasonData | null>(null);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // null = the player's own division (server default). 'all' = every tier.
  const [division, setDivision] = useState<string | null>(null);
  const [scope, setScope] = useState<'global' | 'friends'>('global');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [cur, st] = await Promise.all([
        api.seasons.current(),
        api.seasons.standings(division ?? undefined, scope === 'friends'),
      ]);
      setData(cur);
      setStandings(st.standings);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [division, scope]);

  useEffect(() => { load(); }, [load]);

  const me = data?.me;
  const season = data?.season;
  // 6-month seasons → show weeks for long spans, days when it's down to the wire.
  const timeLeft = season
    ? (season.days_left >= 60
        ? `${Math.round(season.days_left / 7)} weeks left`
        : `${season.days_left} day${season.days_left === 1 ? '' : 's'} left`)
    : '';

  // Sub-division rank (Wood 4 → Obsidian) derived from the raw ELO. The bar
  // fills toward the next division (or sits full for Obsidian's open climb).
  const myRank = me ? rankForElo(me.elo) : null;
  const bandFill = myRank ? myRank.progress : 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={styles.titleBox}>
          <Text style={styles.title}>Season Ladder</Text>
          {season && (
            <Text style={styles.subtitle}>
              {season.name} · {timeLeft}
            </Text>
          )}
        </View>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <FlatList
          data={standings}
          keyExtractor={(r) => r.user_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
          ListHeaderComponent={
            <View>
              {/* Division hero */}
              {me && (
                <View style={[styles.hero, { borderColor: myRank?.color ?? me.division.color }]}>
                  <Text style={[styles.heroDivision, { color: myRank?.color ?? me.division.color }]}>
                    {(myRank?.label ?? me.division.name).toUpperCase()}
                  </Text>
                  <Text style={styles.heroElo}>
                    {myRank?.isObsidian ? `${me.elo} ELO` : `${myRank?.lp ?? 0} LP`}
                  </Text>
                  <Text style={styles.heroRecord}>
                    {me.record.wins}–{me.record.losses}–{me.record.ties}
                    <Text style={styles.heroPoints}>  ·  {me.record.points} pts this season</Text>
                  </Text>

                  {/* Win streak (🔥) — only once it's a genuine streak (2+). */}
                  {me.streak.current >= 2 && (
                    <View style={styles.streakChip}>
                      <Text style={styles.streakChipText}>🔥 {me.streak.current} WIN STREAK</Text>
                      {me.streak.best > me.streak.current && (
                        <Text style={styles.streakBest}>best {me.streak.best}</Text>
                      )}
                    </View>
                  )}

                  {/* Progress to next division */}
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${bandFill * 100}%`, backgroundColor: myRank?.color ?? me.division.color }]} />
                  </View>
                  {myRank && !myRank.isObsidian && myRank.next ? (
                    <Text style={styles.heroNext}>
                      {myRank.lpToNext} LP to{' '}
                      <Text style={{ color: myRank.next.color, fontWeight: '900' }}>
                        {myRank.next.label}
                      </Text>
                    </Text>
                  ) : (
                    <Text style={styles.heroNext}>Obsidian — no ceiling, just keep climbing 🏆</Text>
                  )}

                  {/* Placement on-ramp (LoL/Overwatch-style). */}
                  {me.placement.placing && (
                    <Text style={styles.heroPlacement}>
                      Placement {me.placement.played}/{me.placement.required} — win to lock in your season rank
                    </Text>
                  )}
                </View>
              )}

              {/* Division filter chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.divRow}
              >
                <DivChip
                  label="My Division"
                  active={division === null}
                  color={me?.division.color ?? C.gold}
                  onPress={() => { setDivision(null); setLoading(true); }}
                />
                {(data?.divisions ?? []).map((d) => (
                  <DivChip
                    key={d.key}
                    label={d.name}
                    active={division === d.key}
                    color={d.color}
                    onPress={() => { setDivision(d.key); setLoading(true); }}
                  />
                ))}
                <DivChip
                  label="All"
                  active={division === 'all'}
                  color={C.textMuted}
                  onPress={() => { setDivision('all'); setLoading(true); }}
                />
              </ScrollView>

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
            </View>
          }
          renderItem={({ item }) => (
            <StandingRowView row={item} isMe={item.user_id === user?.user_id} censor={censor} />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No ranked matches in this division yet this season.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function DivChip({ label, active, color, onPress }: {
  label: string; active: boolean; color: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.divChip, active && { backgroundColor: color + '22', borderColor: color }]}
      onPress={onPress}
    >
      <Text style={[styles.divChipText, active && { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StandingRowView({ row, isMe, censor }: { row: StandingRow; isMe: boolean; censor: (s: string) => string }) {
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
          {row.current_streak >= 2 && <Text style={styles.streakBadge}>🔥{row.current_streak}</Text>}
        </View>
        <Text style={styles.meta}>{row.wins}–{row.losses}–{row.ties} · {rankHeadline(row.elo)}</Text>
      </View>
      <View style={styles.ptsBox}>
        <Text style={styles.pts}>{row.points}</Text>
        <Text style={styles.ptsLabel}>PTS</Text>
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
    backgroundColor: C.card, borderRadius: 12, borderWidth: 2,
    padding: 18, alignItems: 'center', marginBottom: 14,
  },
  heroDivision: { fontFamily: F.serif, fontSize: 30, fontWeight: '900', letterSpacing: 2 },
  heroElo: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 2 },
  heroRecord: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 6 },
  heroPoints: { color: C.textMuted, fontWeight: '700' },
  barTrack: {
    width: '100%', height: 8, borderRadius: 4, backgroundColor: C.bg,
    marginTop: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border,
  },
  barFill: { height: '100%', borderRadius: 4 },
  heroNext: { color: C.textMuted, fontSize: 12, fontWeight: '700', marginTop: 8 },
  heroPlacement: { color: C.goldLight, fontSize: 11, fontWeight: '700', marginTop: 8, textAlign: 'center' },

  streakChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    backgroundColor: '#ff6a0022', borderWidth: 1, borderColor: '#ff8a3d',
  },
  streakChipText: { color: '#ff8a3d', fontWeight: '900', fontSize: 12, letterSpacing: 0.5 },
  streakBest: { color: C.textMuted, fontWeight: '700', fontSize: 10 },

  divRow: { gap: 8, paddingBottom: 4 },
  divChip: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 16,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  divChipText: { color: C.textMuted, fontWeight: '800', fontSize: 12 },

  scopeRow: { flexDirection: 'row', gap: 8, paddingTop: 12, paddingBottom: 8 },
  scopeBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  scopeBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  scopeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 13 },
  scopeBtnTextActive: { color: C.gold },

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
  streakBadge: { color: '#ff8a3d', fontSize: 11, fontWeight: '900' },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  ptsBox: { alignItems: 'center', minWidth: 44 },
  pts: { fontFamily: F.serif, fontSize: 20, fontWeight: '700', color: C.gold },
  ptsLabel: { color: C.textDim, fontSize: 9, marginTop: 1 },

  emptyText: { color: C.textMuted, fontSize: 14, textAlign: 'center' },
});
