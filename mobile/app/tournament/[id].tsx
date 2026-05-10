import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Share, Alert, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Divider, OrnamentTitle } from '../../components/Flourish';

/**
 * Tournament detail + leaderboard. Shows the standings, the player roster,
 * and (for owners) the share-code box. Player rows are tappable into the
 * public profile.
 */
export default function TournamentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [t, setT] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try { setT(await api.tournaments.get(id)); }
    catch (e: any) { Alert.alert('Could not load', e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={s.center}><ActivityIndicator color={C.gold} size="large" /></View>;
  if (!t) return <View style={s.center}><Text style={{ color: C.textMuted }}>Tournament not found</Text></View>;

  const isOwner = t.owner_id === user?.user_id;
  const isMember = (t.players ?? []).some((p: any) => p.user_id === user?.user_id);

  const shareCode = async () => {
    if (!t.join_code) return;
    await Share.share({
      message: `Join my Sacari Golf tournament "${t.name}" with code ${t.join_code}.`,
    });
  };

  const handleJoin = async () => {
    try { await api.tournaments.join(t.tournament_id); load(); }
    catch (e: any) { Alert.alert('Could not join', e.message); }
  };
  const handleLeave = async () => {
    Alert.alert('Leave tournament?', 'You\'ll drop off the leaderboard.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        try { await api.tournaments.leave(t.tournament_id); router.back(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };
  const handleDelete = async () => {
    Alert.alert('Delete tournament?', 'This wipes the leaderboard for everyone. Cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await api.tournaments.delete(t.tournament_id); router.back(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: '', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      <Text style={s.title}>{t.name}</Text>
      {t.description ? <Text style={s.desc}>{t.description}</Text> : null}
      <Text style={s.meta}>
        {label('scoring', t.scoring)} · {label('format', t.format)}
        {t.course_name ? ` · ${t.course_name}` : ''}
        {t.ends_at ? ` · ends ${new Date(t.ends_at).toLocaleDateString()}` : ''}
      </Text>
      <Text style={s.meta}>Hosted by {t.owner_username}</Text>
      <Divider style={{ marginTop: 14, marginBottom: 14 }} />

      {t.join_code && (isOwner || isMember) && (
        <TouchableOpacity style={s.codeBox} onPress={shareCode} activeOpacity={0.8}>
          <Text style={s.codeLabel}>JOIN CODE</Text>
          <Text style={s.code}>{t.join_code}</Text>
          <Text style={s.codeShare}>Tap to share →</Text>
        </TouchableOpacity>
      )}

      {!isMember && !isOwner && (
        <TouchableOpacity style={s.joinBtn} onPress={handleJoin}>
          <Text style={s.joinBtnText}>Join Tournament</Text>
        </TouchableOpacity>
      )}

      <OrnamentTitle title="Leaderboard" />
      {(!t.leaderboard || t.leaderboard.length === 0) ? (
        <Text style={s.empty}>No rounds played yet. Standings update automatically as people submit scores.</Text>
      ) : (
        t.leaderboard.map((row: any, i: number) => (
          <TouchableOpacity
            key={row.user_id}
            style={[s.lbRow, row.user_id === user?.user_id && { borderColor: C.gold }]}
            onPress={() => router.push(`/user/${row.user_id}` as any)}
            activeOpacity={0.7}
          >
            <Text style={[s.rank, { color: i === 0 ? C.gold : i === 1 ? '#c0c0c0' : i === 2 ? '#a1673a' : C.textDim }]}>
              {i <= 2 ? ['I','II','III'][i] : `#${i + 1}`}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={s.lbName}>{row.username}</Text>
              <Text style={s.lbMeta}>
                {row.rounds_played ?? 0} round{row.rounds_played === 1 ? '' : 's'} played
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.lbScore}>
                {t.scoring === 'best_round'    ? (row.best_score ?? '—')
                : t.scoring === 'total_strokes' ? (row.total_strokes ?? '—')
                : t.scoring === 'wins'          ? (row.wins ?? 0)
                                                : '—'}
              </Text>
              <Text style={s.lbUnit}>
                {t.scoring === 'wins' ? 'wins' : 'strokes'}
              </Text>
            </View>
          </TouchableOpacity>
        ))
      )}

      <OrnamentTitle title="Players" />
      {(t.players ?? []).map((p: any) => (
        <TouchableOpacity
          key={p.user_id}
          style={s.playerRow}
          onPress={() => router.push(`/user/${p.user_id}` as any)}
          activeOpacity={0.7}
        >
          <Text style={s.playerName}>{p.username}</Text>
          <Text style={s.playerElo}>{p.elo} ELO</Text>
        </TouchableOpacity>
      ))}

      <View style={{ marginTop: 30 }}>
        {isOwner ? (
          <TouchableOpacity style={s.dangerBtn} onPress={handleDelete}>
            <Text style={s.dangerBtnText}>Delete Tournament</Text>
          </TouchableOpacity>
        ) : isMember ? (
          <TouchableOpacity style={s.dangerBtn} onPress={handleLeave}>
            <Text style={s.dangerBtnText}>Leave Tournament</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </ScrollView>
  );
}

function label(kind: 'scoring' | 'format', v: string) {
  if (kind === 'scoring') {
    return v === 'best_round' ? 'Best Round' : v === 'total_strokes' ? 'Total Strokes' : v === 'wins' ? 'Match Wins' : v;
  }
  return v === 'stroke' ? 'Stroke' : v === 'stableford' ? 'Stableford' : v === 'match_play' ? 'Match Play' : v === 'skins' ? 'Skins' : v === 'scramble' ? 'Scramble' : v;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },

  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  desc: { color: C.text, fontSize: 14, marginTop: 8, lineHeight: 20 },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 6 },

  codeBox: {
    backgroundColor: C.card, borderRadius: 12, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: C.gold, alignItems: 'center',
  },
  codeLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  code: { color: C.text, fontFamily: F.mono, fontSize: 30, fontWeight: '900', letterSpacing: 6, marginTop: 4 },
  codeShare: { color: C.textMuted, fontSize: 11, marginTop: 6 },

  joinBtn: { backgroundColor: C.gold, padding: 14, borderRadius: 8, alignItems: 'center', marginBottom: 16 },
  joinBtnText: { color: '#000', fontWeight: '900' },

  empty: { color: C.textMuted, fontSize: 13, padding: 20, textAlign: 'center' },

  lbRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 14, marginBottom: 6,
    borderWidth: 1, borderColor: C.border,
  },
  rank: { width: 36, textAlign: 'center', fontSize: 14, fontFamily: F.serif, fontWeight: '900' },
  lbName: { color: C.text, fontWeight: '800', fontSize: 15 },
  lbMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  lbScore: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  lbUnit: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },

  playerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: C.border + '88',
  },
  playerName: { color: C.text, fontWeight: '700' },
  playerElo: { color: C.textMuted, fontSize: 12 },

  dangerBtn: { paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.red, borderRadius: 8 },
  dangerBtnText: { color: C.red, fontWeight: '700' },
});
