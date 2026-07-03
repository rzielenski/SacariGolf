/**
 * Friends hub — a 3-tab swipeable surface for the CURRENT user's social
 * graph. Reached by tapping the Following / Followers counts on your own
 * profile.
 *
 *   Tab 0  FOLLOWERS  — people who added you (accepted, they initiated)
 *   Tab 1  FOLLOWING  — people you added (accepted, you initiated)
 *   Tab 2  ADD        — incoming friend requests (accept = "add back") +
 *                       a username search to follow new people
 *
 * Swipe left/right between tabs, or tap a header. `?tab=` sets the initial
 * page (following | followers | add).
 *
 * Mutual-friend model note: once a request is accepted the friendship is
 * mutual, so an accepted "follower" is also a friend. The genuinely
 * actionable "add back" cases are the PENDING incoming requests, which
 * live in the ADD tab with a one-tap Accept.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, TextInput, Dimensions, Alert, RefreshControl,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../lib/auth';
import { api, API_BASE } from '../lib/api';
import { C, F } from '../lib/colors';
import { useCensor } from '../lib/censor';
import { IdentityName } from '../components/UserIdentity';

const { width: PAGE_W } = Dimensions.get('window');

type Person = {
  user_id: string; username: string; elo: number;
  avatar_url: string | null; created_at?: string;
};

const TABS = ['Followers', 'Following', 'Add'] as const;
const TAB_INDEX: Record<string, number> = { followers: 0, following: 1, add: 2 };

export default function FriendsScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  const params = useLocalSearchParams<{ tab?: string }>();
  const initialIndex = TAB_INDEX[params.tab ?? 'followers'] ?? 0;

  const [index, setIndex] = useState(initialIndex);
  const pagerRef = useRef<ScrollView>(null);

  const [followers, setFollowers] = useState<Person[] | null>(null);
  const [following, setFollowing] = useState<Person[] | null>(null);
  const [requests, setRequests] = useState<Person[] | null>(null);

  const reload = useCallback(async () => {
    if (!user?.user_id) return;
    const [fw, fg, rq] = await Promise.all([
      api.users.followers(user.user_id).catch(() => []),
      api.users.following(user.user_id).catch(() => []),
      api.users.friendRequests().catch(() => []),
    ]);
    setFollowers(fw as Person[]);
    setFollowing(fg as Person[]);
    setRequests(rq as Person[]);
  }, [user?.user_id]);

  useEffect(() => { reload(); }, [reload]);

  // Land on the requested tab once mounted (ScrollView needs a tick to
  // measure before scrollTo lands).
  useEffect(() => {
    const t = setTimeout(() => {
      pagerRef.current?.scrollTo({ x: initialIndex * PAGE_W, animated: false });
    }, 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = (i: number) => {
    setIndex(i);
    pagerRef.current?.scrollTo({ x: i * PAGE_W, animated: true });
  };

  const onPagerScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / PAGE_W);
    if (i !== index) setIndex(i);
  };

  const acceptRequest = async (p: Person) => {
    try {
      await api.users.acceptRequest(p.user_id);
      await reload();
    } catch (e: any) {
      Alert.alert('Could not accept', e?.message ?? 'Try again.');
    }
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Friends', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />

      {/* Tab header */}
      <View style={s.tabRow}>
        {TABS.map((label, i) => {
          const count =
            i === 0 ? followers?.length :
            i === 1 ? following?.length :
            requests?.length;
          const badge = i === 2 && (requests?.length ?? 0) > 0;
          return (
            <TouchableOpacity
              key={label}
              style={[s.tab, index === i && s.tabActive]}
              onPress={() => goTo(i)}
              activeOpacity={0.7}
            >
              <Text style={[s.tabLabel, index === i && s.tabLabelActive]}>
                {label === 'Add' ? 'Add Friends' : label}
                {count != null && label !== 'Add' ? ` ${count}` : ''}
              </Text>
              {badge && <View style={s.tabDot} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Swipeable pager */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onPagerScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Page 0: Followers ── */}
        <View style={{ width: PAGE_W }}>
          <PeopleList
            data={followers}
            censor={censor}
            emptyText="No one follows you yet. Share your username so friends can add you."
            onReload={reload}
          />
        </View>

        {/* ── Page 1: Following ── */}
        <View style={{ width: PAGE_W }}>
          <PeopleList
            data={following}
            censor={censor}
            emptyText="You haven't added anyone yet. Use the Add Friends tab to find players."
            onReload={reload}
          />
        </View>

        {/* ── Page 2: Add Friends (requests + search) ── */}
        <View style={{ width: PAGE_W }}>
          <AddFriendsTab
            requests={requests}
            censor={censor}
            onAccept={acceptRequest}
            onReload={reload}
          />
        </View>
      </ScrollView>
    </View>
  );
}

/** Plain list of people — each row taps through to that profile. */
function PeopleList({
  data, censor, emptyText, onReload,
}: {
  data: Person[] | null;
  censor: (s: string | null | undefined) => string;
  emptyText: string;
  onReload: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  if (data === null) {
    return <View style={s.centered}><ActivityIndicator color={C.gold} /></View>;
  }
  return (
    <FlatList
      data={data}
      keyExtractor={(p) => p.user_id}
      contentContainerStyle={data.length === 0 ? { flex: 1 } : { paddingVertical: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => { setRefreshing(true); await onReload(); setRefreshing(false); }}
          tintColor={C.gold}
        />
      }
      ListEmptyComponent={
        <View style={s.centered}><Text style={s.emptyText}>{emptyText}</Text></View>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={s.row}
          activeOpacity={0.7}
          onPress={() => router.push(`/user/${item.user_id}` as any)}
        >
          <Avatar person={item} censor={censor} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <IdentityName
              visual={(item as any).equipped_visual}
              style={s.username}
              numberOfLines={1}
            >
              {censor(item.username)}
            </IdentityName>
            <Text style={s.elo}>{item.elo} SR</Text>
          </View>
          <Text style={s.chev}>›</Text>
        </TouchableOpacity>
      )}
    />
  );
}

/** Add Friends tab — incoming requests (accept = add back) + username search. */
function AddFriendsTab({
  requests, censor, onAccept, onReload,
}: {
  requests: Person[] | null;
  censor: (s: string | null | undefined) => string;
  onAccept: (p: Person) => void;
  onReload: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  // Track which search results we've already sent a request to this session
  // so the button flips to "Requested" without a full reload.
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  // Monotonic token so out-of-order search responses can't overwrite newer
  // results (typing 'ric' then 'rich' must never land 'ric' last).
  const seqRef = useRef(0);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    const seq = ++seqRef.current;
    setSearching(true);
    try {
      const r = await api.users.search(q.trim());
      if (seq !== seqRef.current) return; // a newer query superseded this one
      setResults(Array.isArray(r) ? r : []);
    } catch { /* silent */ } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  };

  const add = async (p: Person) => {
    try {
      const res: any = await api.users.sendRequest(p.user_id);
      setSentIds((prev) => new Set(prev).add(p.user_id));
      if (!res?.alreadyRequested) {
        Alert.alert('Request sent!', `${censor(p.username)} will see your friend request.`);
      }
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (/already sent you/i.test(msg)) {
        Alert.alert('They added you first', 'Accept their request in the requests list above.');
        await onReload();
      } else if (/already friends/i.test(msg)) {
        Alert.alert('Already friends', `You're already friends with ${censor(p.username)}.`);
      } else {
        Alert.alert('Could not send request', msg || 'Try again.');
      }
    }
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {/* Incoming requests — the "add back" surface */}
      <Text style={s.sectionLabel}>FRIEND REQUESTS</Text>
      {requests === null ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 12 }} />
      ) : requests.length === 0 ? (
        <Text style={s.sectionEmpty}>No pending requests.</Text>
      ) : (
        requests.map((p) => (
          <View key={p.user_id} style={s.row}>
            <TouchableOpacity
              style={s.rowMain}
              onPress={() => router.push(`/user/${p.user_id}` as any)}
              activeOpacity={0.7}
            >
              <Avatar person={p} censor={censor} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.username} numberOfLines={1}>{censor(p.username)}</Text>
                <Text style={s.elo}>{p.elo} SR · added you</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnAccept]}
              onPress={() => onAccept(p)}
              activeOpacity={0.7}
            >
              <Text style={[s.actionBtnText, { color: C.bg }]}>Add back</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      {/* Username search — follow new people */}
      <Text style={[s.sectionLabel, { marginTop: 22 }]}>FIND PEOPLE</Text>
      <View style={s.searchWrap}>
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={search}
          placeholder="Search players by username…"
          placeholderTextColor={C.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      {searching && <ActivityIndicator color={C.gold} style={{ marginTop: 12 }} />}
      {results.map((p) => {
        const sent = sentIds.has(p.user_id);
        return (
          <View key={p.user_id} style={s.row}>
            <TouchableOpacity
              style={s.rowMain}
              onPress={() => router.push(`/user/${p.user_id}` as any)}
              activeOpacity={0.7}
            >
              <Avatar person={p} censor={censor} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.username} numberOfLines={1}>{censor(p.username)}</Text>
                <Text style={s.elo}>{p.elo} SR</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.actionBtn, sent ? s.actionBtnDone : s.actionBtnAdd]}
              onPress={() => !sent && add(p)}
              disabled={sent}
              activeOpacity={0.7}
            >
              <Text style={[s.actionBtnText, { color: sent ? C.textMuted : C.bg }]}>
                {sent ? 'Requested' : '+ Add'}
              </Text>
            </TouchableOpacity>
          </View>
        );
      })}
      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <Text style={s.sectionEmpty}>No players match “{query.trim()}”.</Text>
      )}
    </ScrollView>
  );
}

function Avatar({ person, censor }: { person: Person; censor: (s: string | null | undefined) => string }) {
  if (person.avatar_url) {
    return (
      <Image
        source={{ uri: person.avatar_url.startsWith('http') ? person.avatar_url : `${API_BASE}${person.avatar_url}` }}
        style={s.avatar}
      />
    );
  }
  return (
    <View style={[s.avatar, s.avatarFallback]}>
      <Text style={s.avatarLetter}>{censor(person.username)[0]?.toUpperCase() ?? '?'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  tab: {
    flex: 1, paddingVertical: 13, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    flexDirection: 'row', justifyContent: 'center', gap: 5,
  },
  tabActive: { borderBottomColor: C.gold },
  tabLabel: { color: C.textMuted, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  tabLabelActive: { color: C.gold },
  tabDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.red },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyText: { color: C.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: C.border + '66',
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarFallback: { backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: C.gold, fontSize: 18, fontWeight: '900', fontFamily: F.serif },
  username: { color: C.text, fontSize: 15, fontWeight: '700' },
  elo: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  chev: { color: C.textDim, fontSize: 22 },

  sectionLabel: {
    color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.4,
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8,
  },
  sectionEmpty: { color: C.textMuted, fontSize: 13, fontStyle: 'italic', paddingHorizontal: 18 },

  searchWrap: { paddingHorizontal: 18, paddingBottom: 4 },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },

  actionBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
    minWidth: 78, alignItems: 'center',
  },
  actionBtnAccept: { backgroundColor: C.green },
  actionBtnAdd: { backgroundColor: C.gold },
  actionBtnDone: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
  actionBtnText: { fontSize: 12, fontWeight: '900', letterSpacing: 0.3 },
});
