/**
 * Weekly Sacari Cup leaderboard.
 *
 * Free to enter — any ranked round during the Monday-to-Sunday UTC week
 * automatically counts; your BEST round (lowest pro-rated to-par) is
 * what ranks you. Top 3 at week's end unlock cup-winner cosmetics in
 * the Locker Room (champion border, gold dust background, gold streak
 * ball trail for 1st; ascending tiers for 2nd/3rd).
 *
 * Reads /weekly-cup/current. Includes the caller's row pinned at the
 * top of the leaderboard so they don't have to scroll to find it, plus
 * a "past champions" strip at the bottom for social proof.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, Image,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { IdentityAvatar, IdentityName } from '../components/UserIdentity';
import { fmtToPar } from '../lib/golfMath';

type LBRow = {
  user_id: string; username: string; avatar_url: string | null;
  elo: number; best_to_par: number; rank: number; is_me: boolean;
};

function fmtTimeLeft(weekEndsAt: string): string {
  const end = new Date(weekEndsAt).getTime();
  const ms = end - Date.now();
  if (ms <= 0) return 'Resolving…';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 1) return `${days}d ${hours}h left`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m left`;
}

export default function SacariCupScreen() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.weeklyCup.current>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Ticks every 30s so the "Xd Yh left" / "Yh Zm left" countdown re-renders
  // while the screen is open instead of freezing at its first-render value.
  const [, setNow] = useState(Date.now());
  // Fire load() exactly once when the countdown crosses zero so the board
  // flips from a stale countdown to the server's "resolving" state.
  const resolvedRef = useRef(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try { setData(await api.weeklyCup.current()); }
    catch { /* silent */ }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // When the week ends, refetch once so the resolved cup / next week loads.
  const weekEndsAt = data?.cup?.week_ends_at;
  // Re-arm the once-only guard whenever a new week's deadline arrives.
  useEffect(() => { resolvedRef.current = false; }, [weekEndsAt]);
  useEffect(() => {
    if (!weekEndsAt) return;
    if (new Date(weekEndsAt).getTime() - Date.now() <= 0 && !resolvedRef.current) {
      resolvedRef.current = true;
      load();
    }
  });

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Sacari Cup',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      {loading || !data ? (
        <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <FlatList
          data={data.leaderboard}
          keyExtractor={(r) => r.user_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
          ListHeaderComponent={
            <>
              <View style={s.hero}>
                <Text style={s.heroLabel}>THIS WEEK'S</Text>
                <Text style={s.heroTitle}>Sacari Cup</Text>
                <Text style={s.heroSub}>
                  {data.cup ? fmtTimeLeft(data.cup.week_ends_at) : 'No active cup yet'}
                </Text>
                <Text style={s.heroRule}>
                  Free to enter. Your best ranked round this week ranks you.
                </Text>
              </View>

              {/* Your row pinned */}
              {data.my_row ? (
                <View style={s.mePill}>
                  <Text style={s.mePillLabel}>YOUR POSITION</Text>
                  <View style={s.meRow}>
                    <Text style={s.meRank}>#{data.my_row.rank}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.meName}>{data.my_row.username}</Text>
                      <Text style={s.meMeta}>{fmtToPar(data.my_row.best_to_par)} this week</Text>
                    </View>
                  </View>
                </View>
              ) : (
                <View style={s.notInPill}>
                  <Text style={s.notInText}>
                    You haven't logged a ranked round this week. Any ranked match counts.
                  </Text>
                </View>
              )}

              {/* Prizes — only render places that actually pay out. The cup
                  awards 1st only; second/third come back null. */}
              <View style={s.prizes}>
                <Text style={s.prizesLabel}>PRIZES</Text>
                {data.prizes.first  && <PrizeRow place="1st" reward={data.prizes.first}  medal="🥇" />}
                {data.prizes.second && <PrizeRow place="2nd" reward={data.prizes.second} medal="🥈" />}
                {data.prizes.third  && <PrizeRow place="3rd" reward={data.prizes.third}  medal="🥉" />}
              </View>

              <Text style={s.boardLabel}>LIVE LEADERBOARD</Text>
            </>
          }
          renderItem={({ item }) => <LBItem row={item} />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>
                No ranked rounds logged this week yet. Be the first on the board.
              </Text>
              <TouchableOpacity style={s.playBtn} onPress={() => router.push('/(tabs)/play' as any)}>
                <Text style={s.playBtnText}>START A RANKED ROUND</Text>
              </TouchableOpacity>
            </View>
          }
          ListFooterComponent={
            data.past_champions && data.past_champions.length > 0 ? (
              <View style={{ marginTop: 30 }}>
                <Text style={s.boardLabel}>RECENT CHAMPIONS</Text>
                {data.past_champions.map((c: any, i: number) => (
                  <View key={i} style={s.champRow}>
                    <IdentityAvatar
                      visual={c.equipped_visual}
                      username={c.username}
                      avatarUrl={c.avatar_url}
                      size={32}
                    />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <IdentityName visual={c.equipped_visual} style={s.champName}>
                        {c.username}
                      </IdentityName>
                      <Text style={s.champWeek}>
                        Week of {new Date(c.week_starts_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text style={s.champMedal}>🏆</Text>
                  </View>
                ))}
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function PrizeRow({ place, reward, medal }: { place: string; reward: string; medal: string }) {
  return (
    <View style={s.prizeRow}>
      <Text style={s.prizeMedal}>{medal}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.prizePlace}>{place}</Text>
        <Text style={s.prizeReward} numberOfLines={3}>{reward}</Text>
      </View>
    </View>
  );
}

function LBItem({ row }: { row: LBRow }) {
  const medalColor =
    row.rank === 1 ? '#d4a93f' :
    row.rank === 2 ? '#c0c0c0' :
    row.rank === 3 ? '#a1673a' : C.textDim;
  return (
    <TouchableOpacity
      style={[s.lbRow, row.is_me && s.lbRowMe]}
      onPress={() => router.push(`/user/${row.user_id}` as any)}
      activeOpacity={0.7}
    >
      <Text style={[s.lbRank, { color: medalColor, fontFamily: row.rank <= 3 ? F.serif : undefined }]}>
        {row.rank <= 3 ? ['I', 'II', 'III'][row.rank - 1] : `#${row.rank}`}
      </Text>
      <IdentityAvatar
        visual={(row as any).equipped_visual}
        username={row.username}
        avatarUrl={row.avatar_url}
        size={40}
        borderRadius={6}
      />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <IdentityName visual={(row as any).equipped_visual} style={s.lbName}>
          {row.username}{row.is_me ? '  (You)' : ''}
        </IdentityName>
        <Text style={s.lbMeta}>{row.elo} SR</Text>
      </View>
      <View style={s.lbScoreBox}>
        <Text style={s.lbScore}>{fmtToPar(row.best_to_par)}</Text>
        <Text style={s.lbScoreLabel}>best</Text>
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  hero: {
    alignItems: 'center', backgroundColor: C.card,
    borderRadius: 14, padding: 22, borderWidth: 2, borderColor: C.gold,
    marginBottom: 16,
  },
  heroLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  heroTitle: { color: C.gold, fontSize: 36, fontWeight: '900', fontFamily: F.serif, marginTop: 4 },
  heroSub: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 6 },
  heroRule: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 12, lineHeight: 17 },

  mePill: {
    backgroundColor: C.gold + '22', borderColor: C.gold, borderWidth: 1,
    borderRadius: 10, padding: 12, marginBottom: 14,
  },
  mePillLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  meRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  meRank: { color: C.gold, fontFamily: F.serif, fontSize: 28, fontWeight: '900', width: 50 },
  meName: { color: C.text, fontSize: 15, fontWeight: '900' },
  meMeta: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  notInPill: {
    backgroundColor: C.card, borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: C.border, marginBottom: 14,
  },
  notInText: { color: C.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  prizes: { marginBottom: 18 },
  prizesLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 8 },
  prizeRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 6,
  },
  prizeMedal: { fontSize: 22 },
  prizePlace: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  prizeReward: { color: C.text, fontSize: 12, marginTop: 2, lineHeight: 16 },

  boardLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: 4, marginBottom: 8 },

  lbRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  lbRowMe: { borderColor: C.gold },
  lbRank: { fontWeight: '900', fontSize: 13, width: 32, textAlign: 'center' },
  lbName: { color: C.text, fontWeight: '700', fontSize: 14 },
  lbMeta: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  lbScoreBox: { alignItems: 'flex-end', minWidth: 50 },
  lbScore: { color: C.gold, fontFamily: F.serif, fontSize: 18, fontWeight: '900' },
  lbScoreLabel: { color: C.textDim, fontSize: 9 },

  empty: { alignItems: 'center', paddingVertical: 30 },
  emptyText: { color: C.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 16 },
  playBtn: {
    backgroundColor: C.gold, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 22,
  },
  playBtnText: { color: C.bg, fontWeight: '900', letterSpacing: 1 },

  champRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 8, padding: 10,
    marginBottom: 4, borderWidth: 1, borderColor: C.border,
  },
  champName: { color: C.text, fontWeight: '700', fontSize: 13 },
  champWeek: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  champMedal: { fontSize: 18 },
});
