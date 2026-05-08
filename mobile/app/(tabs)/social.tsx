import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, FlatList, Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { MatchInvite } from '../../types';
import { C } from '../../lib/colors';
import { Clan } from '../../types';

type Tab = 'friends' | 'clans' | 'chats';

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
      await api.users.sendRequest(userId);
      Alert.alert('Request sent!');
    } catch (e: any) { Alert.alert('Error', e.message); }
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

  const challengeFriend = (friend: any) => {
    Alert.alert(
      `Challenge ${friend.username}`,
      'Pick a match format',
      [
        {
          text: '9 Holes',
          onPress: () => sendChallenge(friend, '9'),
        },
        {
          text: '18 Holes',
          onPress: () => sendChallenge(friend, '18'),
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const sendChallenge = async (friend: any, holes: string) => {
    // Defensive — only allow 9 or 18 even if a stale Alert button somehow
    // passes a different value.
    const parsed = parseInt(holes, 10);
    const numHoles: 9 | 18 = parsed === 9 ? 9 : 18;
    try {
      const match = await api.matches.create({
        matchType: 'solo',
        name: `${numHoles}-hole challenge`,
        numHoles,
      });
      await api.invites.send(match.match_id, friend.user_id);
      Alert.alert('Challenge sent!', `${friend.username} has been invited. Start your round now — they'll join when they accept.`, [
        { text: 'Start My Round', onPress: () => router.push(`/match/scoring/${match.match_id}?holes=${numHoles}` as any) },
        { text: 'Later' },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
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
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{inv.from_username} invited you</Text>
                <Text style={styles.userElo}>
                  {inv.match_type.charAt(0).toUpperCase() + inv.match_type.slice(1)}
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
          <View style={styles.userAvatar}>
            <Text style={styles.avatarText}>{u.username[0].toUpperCase()}</Text>
          </View>
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
              <View style={styles.userAvatar}>
                <Text style={styles.avatarText}>{u.username[0].toUpperCase()}</Text>
              </View>
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
              <View style={styles.userAvatar}>
                <Text style={styles.avatarText}>{u.username[0].toUpperCase()}</Text>
              </View>
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [convs, allMatches, myClans] = await Promise.all([
        api.messages.conversations(),
        api.matches.list(),
        api.clans.mine(),
      ]);
      setDms(convs);
      setMatches(allMatches.filter((m: any) => !m.completed));
      setClans(myClans);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />;

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={styles.sectionTitle}>Direct Messages</Text>
      {dms.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No conversations yet</Text>}
      {dms.map((conv) => (
        <TouchableOpacity
          key={conv.other_id}
          style={styles.userRow}
          onPress={() => router.push(`/chat/dm/${conv.other_id}?name=${encodeURIComponent(conv.other_username)}` as any)}
        >
          <View style={styles.userAvatar}>
            <Text style={styles.avatarText}>{conv.other_username[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{conv.other_username}</Text>
            {conv.last_message ? <Text style={styles.userElo} numberOfLines={1}>{conv.last_message}</Text> : null}
          </View>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionTitle}>Match Chats</Text>
      {matches.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No active matches</Text>}
      {matches.map((m) => (
        <TouchableOpacity
          key={m.match_id}
          style={styles.userRow}
          onPress={() => router.push(`/chat/match/${m.match_id}` as any)}
        >
          <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
            <Text style={[styles.avatarText, { fontSize: 12 }]}>
              {m.match_type === 'solo' ? '1v1' : m.match_type === 'duo' ? '2v2' : m.match_type === 'squad' ? '4v4' : 'PRC'}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{m.name || m.match_type}</Text>
            <Text style={styles.userElo}>Match ID: {m.match_id.slice(0, 8)}…</Text>
          </View>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionTitle}>Team Chats</Text>
      {clans.length === 0 && <Text style={[styles.emptySubText, { marginLeft: 16, marginBottom: 8 }]}>No clans joined</Text>}
      {clans.map((c) => (
        <TouchableOpacity
          key={c.clan_id}
          style={styles.userRow}
          onPress={() => router.push(`/chat/clan/${c.clan_id}` as any)}
        >
          <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
            <Text style={styles.avatarText}>{c.name[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{c.name}</Text>
            <Text style={styles.userElo}>{c.clan_mode.toUpperCase()} · {c.member_count} members</Text>
          </View>
        </TouchableOpacity>
      ))}
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
  addBtn: { borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  addBtnText: { color: C.gold, fontWeight: '700', fontSize: 12 },
  inviteRow: {
    backgroundColor: C.card, borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 0, marginBottom: 8,
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
