/**
 * Generic followers/following list view. Re-used by both
 * /user/[id]/following and /user/[id]/followers screens — the data shape
 * is identical (an array of user summaries) so a single component handles
 * loading, empty, and rendered states.
 *
 * Each row navigates to the tapped user's profile so the player can keep
 * walking the social graph.
 */

import React from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { API_BASE } from '../lib/api';
import { C, F } from '../lib/colors';

type FollowUser = {
  user_id: string;
  username: string;
  elo: number;
  avatar_url: string | null;
};

export function FollowList({
  title, data, emptyText,
}: {
  title: string;
  data: FollowUser[] | null;
  emptyText: string;
}) {
  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title,
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />
      {data === null ? (
        <View style={s.centered}><ActivityIndicator color={C.gold} /></View>
      ) : data.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyText}>{emptyText}</Text>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(u) => u.user_id}
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.row}
              activeOpacity={0.7}
              onPress={() => router.push(`/user/${item.user_id}` as any)}
            >
              {item.avatar_url ? (
                <Image source={{ uri: `${API_BASE}${item.avatar_url}` }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarFallback]}>
                  <Text style={s.avatarLetter}>{item.username?.[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.username}>{item.username}</Text>
                <Text style={s.elo}>{item.elo} ELO</Text>
              </View>
              <Text style={s.chev}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyText: { color: C.textMuted, fontSize: 14, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border + '88',
  },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarFallback: { backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: C.gold, fontSize: 18, fontWeight: '900', fontFamily: F.serif },
  username: { color: C.text, fontSize: 15, fontWeight: '700' },
  elo: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  chev: { color: C.textDim, fontSize: 22 },
});
