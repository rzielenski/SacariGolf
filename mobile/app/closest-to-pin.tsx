import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { UserAvatar } from '../components/UserAvatar';
import { OrnamentTitle } from '../components/Flourish';
import { useCensor } from '../lib/censor';

/**
 * Weekly Closest to the Pin. Each tracked approach that finishes on the green
 * counts: the first putt's length is the distance to the pin, bucketed by how
 * far the approach was. Closest wins each bucket; resets weekly with the Cup.
 */
export default function ClosestToPinScreen() {
  const c = useCensor();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.closestToPin.get>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (r = false) => {
    if (r) setRefreshing(true);
    try { setData(await api.closestToPin.get()); }
    catch { /* best-effort */ }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={s.center}><ActivityIndicator color={C.gold} size="large" /></View>;

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 18, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: 'Closest to the Pin', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />
      <Text style={s.intro}>
        Your first putt is the distance to the pin, so just track your approach and the putt that follows. Closest wins each bucket. Resets weekly.
      </Text>
      {(data?.buckets ?? []).map((b) => (
        <View key={b.key} style={{ marginBottom: 18 }}>
          <OrnamentTitle title={b.label} align="center" />
          {b.rows.length === 0 ? (
            <Text style={s.empty}>No one has stuck one close yet. Be the first.</Text>
          ) : b.rows.map((r) => (
            <View key={r.user_id} style={[s.row, r.is_me && { borderColor: C.gold }]}>
              <Text style={[s.rank, { color: r.rank === 1 ? C.gold : C.textDim }]}>{r.rank === 1 ? '①' : `#${r.rank}`}</Text>
              <UserAvatar username={r.username} avatarUrl={r.avatar_url} size={30} />
              <Text style={s.name} numberOfLines={1}>{c(r.username)}</Text>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={s.dist}>{r.proximity_ft} ft</Text>
                <Text style={s.from}>from {r.approach_yds} yds</Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  intro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  empty: { color: C.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 10, marginBottom: 6 },
  rank: { width: 34, fontWeight: '900', fontSize: 13 },
  name: { flex: 1, color: C.text, fontWeight: '700', fontSize: 14 },
  dist: { color: C.gold, fontWeight: '900', fontSize: 16, fontFamily: F.serif },
  from: { color: C.textMuted, fontSize: 11 },
});
