/**
 * Generic followers/following list view. Re-used by both
 * /user/[id]/following and /user/[id]/followers screens — the data shape
 * is identical (an array of user summaries) so a single component handles
 * loading, empty, and rendered states.
 *
 * Each row navigates to the tapped user's profile so the player can keep
 * walking the social graph.
 *
 * The optional `showAddFriend` prop renders a username-search input at the
 * top of the list. Tapping a result jumps to that user's profile, which is
 * where the "+ Add Friend" button now lives. This replaced the Social tab's
 * Friends sub-page; the user-lookup feature lives here now since "people
 * I follow" + "find someone new to follow" naturally belong together.
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator, TextInput,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api, API_BASE } from '../lib/api';
import { C, F } from '../lib/colors';
import { useCensor } from '../lib/censor';

type FollowUser = {
  user_id: string;
  username: string;
  elo: number;
  avatar_url: string | null;
};

export function FollowList({
  title, data, emptyText, showAddFriend,
}: {
  title: string;
  data: FollowUser[] | null;
  emptyText: string;
  /** When true, render a username-search field above the list so the user
   *  can look up someone new and jump to their profile. */
  showAddFriend?: boolean;
}) {
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<FollowUser[]>([]);
  const censor = useCensor();

  const onSearchChange = async (q: string) => {
    setSearchQ(q);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const results = await api.users.search(q.trim());
      setSearchResults(Array.isArray(results) ? results : []);
    } catch { /* silent */ } finally { setSearching(false); }
  };

  // Header has the screen padding so the FlatList renders flush against
  // its edges. Only mounted when showAddFriend is on, otherwise we'd add
  // a chunk of empty space at the top of every Followers screen.
  const Header = showAddFriend ? (
    <View style={s.searchHeader}>
      <TextInput
        style={s.searchInput}
        value={searchQ}
        onChangeText={onSearchChange}
        placeholder="Find someone to add as a friend…"
        placeholderTextColor={C.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {searching && <ActivityIndicator color={C.gold} style={{ marginTop: 8 }} />}
      {searchResults.length > 0 && (
        <View style={s.searchResults}>
          <Text style={s.searchResultsLabel}>SEARCH RESULTS</Text>
          {searchResults.map((u) => (
            <TouchableOpacity
              key={u.user_id}
              style={s.row}
              activeOpacity={0.7}
              onPress={() => router.push(`/user/${u.user_id}` as any)}
            >
              {u.avatar_url ? (
                <Image source={{ uri: `${API_BASE}${u.avatar_url}` }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarFallback]}>
                  <Text style={s.avatarLetter}>{censor(u.username)[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.username} numberOfLines={1}>{censor(u.username)}</Text>
                <Text style={s.elo}>{u.elo} SR</Text>
              </View>
              <Text style={s.chev}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {/* Section label for the actual following/followers list — only when
          there's something below it and we're in the search-enabled view. */}
      {data && data.length > 0 && (
        <Text style={s.sectionLabel}>{title.toUpperCase()}</Text>
      )}
    </View>
  ) : null;

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title,
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />
      {data === null ? (
        <View style={s.centered}><ActivityIndicator color={C.gold} /></View>
      ) : data.length === 0 && !showAddFriend ? (
        <View style={s.centered}>
          <Text style={s.emptyText}>{emptyText}</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(u) => u.user_id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={Header}
          ListEmptyComponent={
            showAddFriend ? (
              <Text style={s.emptyInline}>{emptyText}</Text>
            ) : null
          }
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
                  <Text style={s.avatarLetter}>{censor(item.username)[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.username} numberOfLines={1}>{censor(item.username)}</Text>
                <Text style={s.elo}>{item.elo} SR</Text>
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
  emptyInline: {
    color: C.textMuted, fontSize: 13, fontStyle: 'italic',
    paddingHorizontal: 20, paddingVertical: 18, textAlign: 'center',
  },

  searchHeader: { paddingHorizontal: 20, paddingTop: 14 },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  searchResults: { marginTop: 10 },
  searchResultsLabel: {
    color: C.gold, fontSize: 10, fontWeight: '900',
    letterSpacing: 1.4, marginBottom: 6,
  },
  sectionLabel: {
    color: C.textMuted, fontSize: 10, fontWeight: '900',
    letterSpacing: 1.4, marginTop: 18, marginBottom: 4,
  },

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
