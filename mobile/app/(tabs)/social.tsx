import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator,
  Animated, Easing,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { MatchInvite, Clan } from '../../types';
import { C } from '../../lib/colors';
import { UserAvatar } from '../../components/UserAvatar';

type Tab = 'friends' | 'clans' | 'chats';

/**
 * Shared pulse driver for the unread indicators. One Animated.Value at module
 * scope means every unread chat across DMs / matches / clans beats in sync —
 * cheaper than per-row timers and visually feels intentional rather than
 * chaotic. Started lazily on first subscribe; never stopped since it costs
 * essentially nothing while the social tab is open and pauses naturally when
 * the screen unmounts.
 */
const unreadPulse = new Animated.Value(0);
let unreadPulseStarted = false;
function startUnreadPulse() {
  if (unreadPulseStarted) return;
  unreadPulseStarted = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(unreadPulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(unreadPulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]),
  ).start();
}

/** The actual unread dot — slightly bigger than the old static dot and pulses
 *  opacity + scale from the shared driver. Wrapped in a glow halo (separate
 *  View since RN can't animate shadow on a borderless circle directly). */
function UnreadDot() {
  useEffect(() => { startUnreadPulse(); }, []);
  const opacity = unreadPulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  const scale   = unreadPulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] });
  return (
    <Animated.View style={[styles.unreadDotGlow, { opacity, transform: [{ scale }] }]}>
      <View style={styles.unreadDotCore} />
    </Animated.View>
  );
}

export default function SocialScreen() {
  const [tab, setTab] = useState<Tab>('friends');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Social</Text>
      <View style={styles.tabRow}>
        {(['friends', 'clans', 'chats'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t === 'friends' ? 'Friends' : t === 'clans' ? 'Teams' : 'Chats'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab === 'friends' && <FriendsTab />}
      {tab === 'clans' && <ClansTab />}
      {tab === 'chats' && <ChatsTab />}
    </View>
  );
}

function FriendsTab() {
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [clanInvites, setClanInvites] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, r, inv, ci] = await Promise.all([
        api.users.friends(),
        api.users.friendRequests(),
        api.invites.list(),
        api.clans.clanInvites(),
      ]);
      setFriends(f);
      setRequests(r);
      setInvites(inv);
      setClanInvites(ci);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const search = async (q: string) => {
    setSearchQ(q);
    if (q.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const results = await api.users.search(q);
      setSearchResults(Array.isArray(results) ? results : []);
    } finally { setSearching(false); }
  };

  const sendRequest = async (userId: string) => {
    try {
      const res: any = await api.users.sendRequest(userId);
      // Server tells us if the request was a no-op because one was already
      // pending — surface that explicitly so the user knows to wait rather
      // than spam-tap "+ Add" thinking nothing happened.
      if (res?.alreadyRequested) {
        Alert.alert('Already sent', 'You already sent this user a friend request — waiting for them to accept.');
      } else {
        Alert.alert('Request sent!');
      }
    } catch (e: any) {
      // Server returns 409 + a clear message for both "already friends"
      // and "they already sent YOU a request"; map both to friendly alerts.
      const msg = e?.message ?? 'Unknown error';
      if (e?.status === 409) {
        Alert.alert('Heads up', msg);
      } else {
        Alert.alert('Error', msg);
      }
    }
  };

  const acceptRequest = async (userId: string) => {
    await api.users.acceptRequest(userId);
    load();
  };

  const acceptInvite = async (invite: MatchInvite) => {
    try {
      const result = await api.invites.accept(invite.invite_id);
      router.push(`/match/${result.matchId}` as any);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const declineInvite = async (inviteId: string) => {
    try {
      await api.invites.decline(inviteId);
      setInvites((prev) => prev.filter((i) => i.invite_id !== inviteId));
    } catch { /* silent */ }
  };

  const acceptClanInvite = async (invite: any) => {
    try {
      const result = await api.clans.acceptClanInvite(invite.invite_id);
      setClanInvites((prev) => prev.filter((i) => i.invite_id !== invite.invite_id));
      Alert.alert('Joined!', `You joined ${invite.clan_name}.`, [
        { text: 'View Team', onPress: () => router.push(`/clan/${result.clanId}` as any) },
        { text: 'OK' },
      ]);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const declineClanInvite = async (inviteId: string) => {
    try {
      await api.clans.declineClanInvite(inviteId);
      setClanInvites((prev) => prev.filter((i) => i.invite_id !== inviteId));
    } catch { /* silent */ }
  };

  // Challenge a friend → route through the same setup wizard as the Play
  // tab, with the friend's user_id and username pre-attached. The wizard
  // then asks the SAME questions (course → teebox → holes / front-back)
  // every other match creation flow asks, and at the end fires off a
  // match invite to the friend before navigating to the lobby. Replaces
  // the old two-button "9 Holes / 18 Holes" Alert.alert flow that skipped
  // course/teebox entirely and made challenge matches feel like a different
  // product than ranked matches.
  const challengeFriend = (friend: any) => {
    router.push(
      `/(tabs)/play?challenge=${encodeURIComponent(friend.user_id)}` +
      `&challengeName=${encodeURIComponent(friend.username)}` as any,
    );
  };

  if (loading) return <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />;

  return (
    <ScrollView style={{ flex: 1 }}>
      <TextInput
        style={styles.searchInput}
        value={searchQ}
        onChangeText={search}
        placeholder="Search players by username..."
        placeholderTextColor={C.textMuted}
      />

      {/* Match Invites */}
      {invites.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Match Invites</Text>
          {invites.map((inv) => (
            <View key={inv.invite_id} style={styles.inviteRow}>
              <UserAvatar username={inv.from_username} avatarUrl={inv.from_avatar_url} size={36} borderRadius={4} />
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{inv.from_username} invited you</Text>
                <Text style={styles.userElo}>
                  {(inv.match_type ?? 'match').charAt(0).toUpperCase() + (inv.match_type ?? 'match').slice(1)}
                  {inv.match_name ? ` · ${inv.match_name}` : ''}
                  {' · '}{inv.from_elo} ELO
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: C.green + '22', borderColor: C.green, marginRight: 6 }]}
                onPress={() => acceptInvite(inv)}
              >
                <Text style={[styles.addBtnText, { color: C.green }]}>Join</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: C.card, borderColor: C.border }]}
                onPress={() => declineInvite(inv.invite_id)}
              >
                <Text style={[styles.addBtnText, { color: C.textMuted }]}>Decline</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {/* Clan Invites */}
      {clanInvites.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Team Invites</Text>
          {clanInvites.map((inv) => (
            <View key={inv.invite_id} style={styles.inviteRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{inv.clan_name}</Text>
                <Text style={styles.userElo}>
                  {inv.clan_mode.toUpperCase()} · {inv.member_count}/{inv.max_players} members · {inv.clan_elo} ELO
                </Text>
                <Text style={[styles.userElo, { marginTop: 2 }]}>Invited by {inv.from_username}</Text>
              </View>
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: C.green + '22', borderColor: C.green, marginRight: 6 }]}
                onPress={() => acceptClanInvite(inv)}
              >
                <Text style={[styles.addBtnText, { color: C.green }]}>Join</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: C.card, borderColor: C.border }]}
                onPress={() => declineClanInvite(inv.invite_id)}
              >
                <Text style={[styles.addBtnText, { color: C.textMuted }]}>Decline</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {searching && <ActivityIndicator color={C.gold} style={{ marginVertical: 10 }} />}
      {searchResults.map((u) => (
        <View key={u.user_id} style={styles.userRow}>
          <UserAvatar username={u.username} avatarUrl={u.avatar_url} size={40} borderRadius={4} />
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{u.username}</Text>
            <Text style={styles.userElo}>{u.elo} ELO</Text>
          </View>
          <TouchableOpacity style={styles.addBtn} onPress={() => sendRequest(u.user_id)}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
        </View>
      ))}

      {requests.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Friend Requests</Text>
          {requests.map((u) => (
            <View key={u.user_id} style={styles.userRow}>
              <UserAvatar username={u.username} avatarUrl={u.avatar_url} size={40} borderRadius={4} />
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.username}</Text>
                <Text style={styles.userElo}>{u.elo} ELO</Text>
              </View>
              <TouchableOpacity style={[styles.addBtn, { backgroundColor: C.green + '22', borderColor: C.green }]} onPress={() => acceptRequest(u.user_id)}>
                <Text style={[styles.addBtnText, { color: C.green }]}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {friends.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Friends ({friends.length})</Text>
          {friends.map((u) => (
            <TouchableOpacity
              key={u.user_id}
              style={styles.userRow}
              onPress={() => router.push(`/user/${u.user_id}` as any)}
              activeOpacity={0.7}
            >
              <UserAvatar username={u.username} avatarUrl={u.avatar_url} size={40} borderRadius={4} />
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.username}</Text>
                <Text style={styles.userElo}>{u.elo} ELO</Text>
              </View>
              <TouchableOpacity
                style={[styles.addBtn, { marginRight: 6 }]}
                onPress={() => challengeFriend(u)}
              >
                <Text style={styles.addBtnText}>⚔ Challenge</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: C.card, borderColor: C.border }]}
                onPress={() => router.push(`/chat/dm/${u.user_id}?name=${encodeURIComponent(u.username)}` as any)}
              >
                <Text style={[styles.addBtnText, { color: C.textMuted }]}>Message</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </>
      )}

      {friends.length === 0 && !searchQ && (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>No friends yet</Text>
          <Text style={styles.emptySubText}>Search for players to connect with</Text>
        </View>
      )}
    </ScrollView>
  );
}

function ClansTab() {
  const [clans, setClans] = useState<Clan[]>([]);
  const [mine, setMine] = useState<Clan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [clanName, setClanName] = useState('');
  const [clanMode, setClanMode] = useState<'duo' | 'squad'>('duo');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, m] = await Promise.all([api.clans.list(), api.clans.mine()]);
      setClans(all);
      setMine(m);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createClan = async () => {
    if (!clanName.trim()) { Alert.alert('Name required'); return; }
    setCreating(true);
    try {
      await api.clans.create(clanName.trim(), clanMode);
      setShowCreate(false);
      setClanName('');
      load();
    } catch (e: any) { Alert.alert('Error', e.message); } finally { setCreating(false); }
  };

  const joinClan = async (clanId: string) => {
    try {
      await api.clans.join(clanId);
      load();
      Alert.alert('Joined!');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  if (loading) return <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />;

  return (
    <ScrollView style={{ flex: 1 }}>
      <TouchableOpacity style={styles.createBtn} onPress={() => setShowCreate(!showCreate)}>
        <Text style={styles.createBtnText}>+ Create Team</Text>
      </TouchableOpacity>

      {showCreate && (
        <View style={styles.createForm}>
          <TextInput
            style={styles.searchInput}
            value={clanName}
            onChangeText={setClanName}
            placeholder="Team name..."
            placeholderTextColor={C.textMuted}
          />
          <View style={styles.modeRow}>
            {(['duo', 'squad'] as const).map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.modeBtn, clanMode === m && styles.modeBtnActive]}
                onPress={() => setClanMode(m)}
              >
                <Text style={[styles.modeBtnText, clanMode === m && { color: C.gold }]}>{m.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={styles.confirmBtn} onPress={createClan} disabled={creating}>
            {creating ? <ActivityIndicator color="#000" /> : <Text style={styles.confirmBtnText}>Create</Text>}
          </TouchableOpacity>
        </View>
      )}

      {mine.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>My Teams</Text>
          {mine.map((c) => <ClanCard key={c.clan_id} clan={c} joined />)}
        </>
      )}

      <Text style={styles.sectionTitle}>Public Teams</Text>
      {clans.filter((c) => !mine.find((m) => m.clan_id === c.clan_id)).map((c) => (
        <ClanCard key={c.clan_id} clan={c} onJoin={() => joinClan(c.clan_id)} />
      ))}
    </ScrollView>
  );
}

function ClanCard({ clan, joined, onJoin }: { clan: Clan; joined?: boolean; onJoin?: () => void }) {
  return (
    <TouchableOpacity style={styles.clanCard} onPress={() => router.push(`/clan/${clan.clan_id}` as any)}>
      <View style={{ flex: 1 }}>
        <Text style={styles.clanName}>{clan.name}</Text>
        <Text style={styles.clanMeta}>
          {clan.clan_mode.toUpperCase()} · {clan.member_count}/{clan.max_players} members · {clan.elo} ELO
        </Text>
      </View>
      {!joined && onJoin && (
        <TouchableOpacity style={styles.joinBtn} onPress={(e) => { e.stopPropagation?.(); onJoin(); }}>
          <Text style={styles.joinBtnText}>Join</Text>
        </TouchableOpacity>
      )}
      {joined && <Text style={styles.joinedBadge}>✓</Text>}
    </TouchableOpacity>
  );
}

function ChatsTab() {
  const [dms, setDms] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [clans, setClans] = useState<any[]>([]);
  // Unread tracking — DM unread comes inline on `conversations`; match + clan
  // unread come from the separate /messages/unread-summary endpoint so we
  // don't bloat the matches.list / clans.mine responses everyone else uses.
  const [unreadMatchIds, setUnreadMatchIds] = useState<Set<string>>(new Set());
  const [unreadClanIds, setUnreadClanIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [convs, allMatches, myClans, unread] = await Promise.all([
        api.messages.conversations(),
        api.matches.list(),
        api.clans.mine(),
        api.messages.unreadSummary().catch(() => ({ matches: [], clans: [] })),
      ]);
      setDms(convs);
      setMatches(allMatches.filter((m: any) => !m.completed));
      setClans(myClans);
      setUnreadMatchIds(new Set(unread.matches));
      setUnreadClanIds(new Set(unread.clans));
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />;

  // Sort each list: unread first (preserving their relative order), then read.
  // Stable partition keeps server-side ordering (most-recent-first) intact
  // within each bucket so newest unread floats to the top.
  const sortByUnread = <T,>(arr: T[], isUnread: (x: T) => boolean): T[] => {
    const u: T[] = [], r: T[] = [];
    for (const x of arr) (isUnread(x) ? u : r).push(x);
    return [...u, ...r];
  };
  const dmsSorted     = sortByUnread(dms,     (c: any) => !!c.unread);
  const matchesSorted = sortByUnread(matches, (m: any) => unreadMatchIds.has(m.match_id));
  const clansSorted   = sortByUnread(clans,   (c: any) => unreadClanIds.has(c.clan_id));

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={styles.sectionTitle}>Direct Messages</Text>
      {dmsSorted.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No conversations yet</Text>}
      {dmsSorted.map((conv) => (
        <TouchableOpacity
          key={conv.other_id}
          style={[styles.userRow, conv.unread && styles.userRowUnread]}
          onPress={() => {
            // Optimistically clear the local dot so it disappears before
            // the chat screen even loads. Server mark happens in chat/[id].
            if (conv.unread) {
              setDms((prev) => prev.map((c: any) => c.other_id === conv.other_id ? { ...c, unread: false } : c));
            }
            router.push(`/chat/dm/${conv.other_id}?name=${encodeURIComponent(conv.other_username)}` as any);
          }}
        >
          <UserAvatar
            username={conv.other_username}
            avatarUrl={(conv as any).other_avatar_url}
            size={40}
            borderRadius={4}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.userName, conv.unread && styles.userNameUnread]}>{conv.other_username}</Text>
            {conv.last_message ? (
              <Text
                style={[styles.userElo, conv.unread && styles.userMsgUnread]}
                numberOfLines={1}
              >
                {conv.last_message}
              </Text>
            ) : null}
          </View>
          {conv.unread && <UnreadDot />}
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionTitle}>Match Chats</Text>
      {matchesSorted.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No active matches</Text>}
      {matchesSorted.map((m) => {
        const unread = unreadMatchIds.has(m.match_id);
        return (
          <TouchableOpacity
            key={m.match_id}
            style={[styles.userRow, unread && styles.userRowUnread]}
            onPress={() => {
              if (unread) {
                setUnreadMatchIds((prev) => {
                  const next = new Set(prev); next.delete(m.match_id); return next;
                });
              }
              router.push(`/chat/match/${m.match_id}` as any);
            }}
          >
            <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
              <Text style={[styles.avatarText, { fontSize: 12 }]}>
                {m.match_type === 'solo' ? '1v1'
                  : m.match_type === 'duo' ? '2v2'
                  : m.match_type === 'squad' ? '4v4'
                  : m.match_type === 'ffa' ? 'ARN'
                  : 'PRC'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.userName, unread && styles.userNameUnread]}>{m.name || m.match_type}</Text>
              <Text style={styles.userElo}>Match ID: {m.match_id.slice(0, 8)}…</Text>
            </View>
            {unread && <UnreadDot />}
          </TouchableOpacity>
        );
      })}

      <Text style={styles.sectionTitle}>Team Chats</Text>
      {clansSorted.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No clans joined</Text>}
      {clansSorted.map((c) => {
        const unread = unreadClanIds.has(c.clan_id);
        return (
          <TouchableOpacity
            key={c.clan_id}
            style={[styles.userRow, unread && styles.userRowUnread]}
            onPress={() => {
              if (unread) {
                setUnreadClanIds((prev) => {
                  const next = new Set(prev); next.delete(c.clan_id); return next;
                });
              }
              router.push(`/chat/clan/${c.clan_id}` as any);
            }}
          >
            <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
              <Text style={styles.avatarText}>{c.name?.[0]?.toUpperCase() ?? '?'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.userName, unread && styles.userNameUnread]}>{c.name}</Text>
              <Text style={styles.userElo}>{c.clan_mode.toUpperCase()} · {c.member_count} members</Text>
            </View>
            {unread && <UnreadDot />}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 16 },
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  tabBtn: { flex: 1, paddingVertical: 10, borderRadius: 4, alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  tabBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  tabLabel: { color: C.textMuted, fontWeight: '600' },
  tabLabelActive: { color: C.gold },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border, marginBottom: 10,
  },
  sectionTitle: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8, marginTop: 16 },
  userRow: {
    backgroundColor: C.card, borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  userAvatar: { width: 40, height: 40, borderRadius: 4, backgroundColor: C.gold + '33', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: C.gold, fontWeight: '800', fontSize: 16 },
  userName: { color: C.text, fontWeight: '700', fontSize: 15 },
  userElo: { color: C.textMuted, fontSize: 12 },
  // Unread states — brighter border + tinted fill + a soft gold glow that
  // hangs around the row. iOS uses the shadow props; Android picks up
  // `elevation` (the colour is approximate on Android since elevation
  // shadows are always greyscale natively, but it still gives depth so the
  // unread rows visibly lift off the page).
  userRowUnread: {
    borderColor: C.gold,
    backgroundColor: C.gold + '14',
    shadowColor: C.gold,
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  userNameUnread: { color: C.gold },
  userMsgUnread: { color: C.text, fontWeight: '600' },

  // Pulsing unread dot — bigger than the old static circle, with its own
  // gold glow halo. The Animated wrapper handles opacity + scale; the inner
  // solid dot keeps the colour saturated at the centre regardless of the
  // outer halo's alpha animation.
  unreadDotGlow: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: C.gold + 'aa',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 6,
    shadowColor: C.gold,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  unreadDotCore: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: C.gold,
  },
  addBtn: { borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  addBtnText: { color: C.gold, fontWeight: '700', fontSize: 12 },
  inviteRow: {
    backgroundColor: C.card, borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.gold + '55',
  },
  emptyBox: { alignItems: 'center', paddingTop: 50 },
  emptyText: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySubText: { color: C.textMuted, fontSize: 13, marginTop: 6 },

  createBtn: { backgroundColor: C.gold + '22', borderRadius: 6, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.gold, marginBottom: 12 },
  createBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },
  createForm: { backgroundColor: C.card, borderRadius: 6, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  modeBtn: { flex: 1, padding: 10, borderRadius: 4, alignItems: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  modeBtnActive: { borderColor: C.gold },
  modeBtnText: { color: C.textMuted, fontWeight: '700' },
  confirmBtn: { backgroundColor: C.gold, borderRadius: 6, padding: 12, alignItems: 'center' },
  confirmBtnText: { color: '#000', fontWeight: '800' },

  clanCard: { backgroundColor: C.card, borderRadius: 6, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: C.border },
  clanName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clanMeta: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  joinBtn: { backgroundColor: C.gold + '22', borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: C.gold },
  joinBtnText: { color: C.gold, fontWeight: '700' },
  joinedBadge: { color: C.green, fontWeight: '700', fontSize: 13 },
});
