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

type Tab = 'friends' | 'clans';

export default function SocialScreen() {
  const [tab, setTab] = useState<Tab>('friends');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Social</Text>
      <View style={styles.tabRow}>
        {(['friends', 'clans'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab === 'friends' ? <FriendsTab /> : <ClansTab />}
    </View>
  );
}

function FriendsTab() {
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, r, inv] = await Promise.all([
        api.users.friends(),
        api.users.friendRequests(),
        api.invites.list(),
      ]);
      setFriends(f);
      setRequests(r);
      setInvites(inv);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const search = async (q: string) => {
    setSearchQ(q);
    if (q.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const results = await api.users.search(q);
      setSearchResults(results);
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
            <View key={u.user_id} style={styles.userRow}>
              <View style={styles.userAvatar}>
                <Text style={styles.avatarText}>{u.username[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.username}</Text>
                <Text style={styles.userElo}>{u.elo} ELO</Text>
              </View>
            </View>
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
      Alert.alert('Joined clan!');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  if (loading) return <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />;

  return (
    <ScrollView style={{ flex: 1 }}>
      <TouchableOpacity style={styles.createBtn} onPress={() => setShowCreate(!showCreate)}>
        <Text style={styles.createBtnText}>+ Create Clan</Text>
      </TouchableOpacity>

      {showCreate && (
        <View style={styles.createForm}>
          <TextInput
            style={styles.searchInput}
            value={clanName}
            onChangeText={setClanName}
            placeholder="Clan name..."
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
          <Text style={styles.sectionTitle}>My Clans</Text>
          {mine.map((c) => <ClanCard key={c.clan_id} clan={c} joined />)}
        </>
      )}

      <Text style={styles.sectionTitle}>Public Clans</Text>
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
