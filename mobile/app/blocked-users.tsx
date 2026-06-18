import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { useCensor } from '../lib/censor';

/**
 * "Blocked users" management screen. Lists every user the caller has blocked
 * and exposes a one-tap unblock. Required by Apple's UGC moderation rules —
 * if you can block, you must be able to view and reverse the list.
 */
export default function BlockedUsersScreen() {
  const c = useCensor();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const r = await api.users.blocks();
      setList(Array.isArray(r) ? r : []);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const unblock = (u: any) => {
    Alert.alert(`Unblock ${u.username}?`,
      'They\'ll be visible again in search and on the leaderboard.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            try {
              await api.users.unblock(u.blocked_id);
              setList((prev) => prev.filter((x) => x.blocked_id !== u.blocked_id));
            } catch (e: any) { Alert.alert('Error', e.message); }
          },
        },
      ]
    );
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 20, paddingTop: 14, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: 'Blocked Users', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      <Text style={s.intro}>
        Users you've blocked don't appear in search, on leaderboards, or in finds. They aren't notified when you block them.
      </Text>

      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 30 }} size="large" />
      ) : list.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>No one blocked.</Text>
          <Text style={s.emptySub}>To block a user, open their profile and tap "Block this user" at the bottom.</Text>
        </View>
      ) : (
        list.map((u) => (
          <View key={u.blocked_id} style={s.row}>
            <TouchableOpacity
              style={{ flex: 1 }}
              onPress={() => router.push(`/user/${u.blocked_id}` as any)}
              activeOpacity={0.6}
            >
              <Text style={s.name}>{c(u.username)}</Text>
              <Text style={s.meta}>
                {u.elo} SR · blocked {new Date(u.created_at).toLocaleDateString()}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.unblockBtn} onPress={() => unblock(u)}>
              <Text style={s.unblockText}>Unblock</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  intro: { color: C.textMuted, fontSize: 12, lineHeight: 18, marginBottom: 18 },
  empty: { backgroundColor: C.card, borderRadius: 10, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: C.border, marginTop: 20 },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 15 },
  emptySub: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: 8, padding: 12, marginBottom: 6,
    borderWidth: 1, borderColor: C.border,
  },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  meta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  unblockBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: C.gold + '88' },
  unblockText: { color: C.gold, fontSize: 12, fontWeight: '700' },
});
