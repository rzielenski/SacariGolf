/**
 * Team tab — the one place for everything people-related:
 *
 *   • INVITES  — match + team invites with inline Accept/Decline. This is the
 *     invites hub (the tab badge counts these), so "someone invited me" is
 *     never buried in a chats list again.
 *   • MY TEAMS — the player's duos/squads, one tap into each team room,
 *     plus Browse/Create.
 *   • FRIENDS  — jump into the friends list / add-friends search.
 *
 * Born from launch feedback: creating a team, inviting, and accepting used
 * to span four screens in three different tabs. Team management still lives
 * on /teams and /clan/[id] — this tab is the front door.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { api } from '../../lib/api';
import { MatchInvite } from '../../types';
import { C } from '../../lib/colors';
import { UserAvatar } from '../../components/UserAvatar';
import { useAuth } from '../../lib/auth';
import { censorText } from '../../lib/censor';

export default function TeamScreen() {
  const { user } = useAuth();
  const censor = user?.censor_offensive_language !== false;
  const [matchInvites, setMatchInvites] = useState<MatchInvite[]>([]);
  const [clanInvites, setClanInvites] = useState<any[]>([]);
  const [myTeams, setMyTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [mi, ci, clans] = await Promise.all([
        api.invites.list().catch(() => []),
        api.clans.clanInvites().catch(() => []),
        api.clans.mine().catch(() => []),
      ]);
      setMatchInvites(Array.isArray(mi) ? mi : []);
      setClanInvites(Array.isArray(ci) ? ci : []);
      setMyTeams(Array.isArray(clans) ? clans : []);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refresh every time the tab is focused so a just-received invite shows
  // without a manual pull (the tab badge already hinted it's here).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Invite actions (same behavior the old Chats-tab surfaces had) ────────
  const acceptMatchInvite = async (invite: MatchInvite) => {
    try {
      const result = await api.invites.accept(invite.invite_id);
      router.push(`/match/${result.matchId}` as any);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };
  const declineMatchInvite = async (inviteId: string) => {
    try {
      await api.invites.decline(inviteId);
      setMatchInvites((prev) => prev.filter((i) => i.invite_id !== inviteId));
    } catch { /* silent */ }
  };
  const acceptClanInvite = async (invite: any) => {
    try {
      const result = await api.clans.acceptClanInvite(invite.invite_id);
      setClanInvites((prev) => prev.filter((i) => i.invite_id !== invite.invite_id));
      load();
      Alert.alert('Joined!', `You joined ${invite.clan_name}.`, [
        { text: 'View Team', onPress: () => router.push(`/clan/${result.clanId}` as any) },
        { text: 'OK' },
      ]);
    } catch (e: any) {
      const msg = e?.message ?? 'Could not accept';
      if (e?.status === 402 || /Upgrade to Premium/i.test(msg)) {
        Alert.alert('Team limit reached', msg, [
          { text: 'Not now', style: 'cancel' },
          { text: 'See Premium', onPress: () => router.push('/premium' as any) },
        ]);
      } else {
        Alert.alert('Error', msg);
      }
    }
  };
  const declineClanInvite = async (inviteId: string) => {
    try {
      await api.clans.declineClanInvite(inviteId);
      setClanInvites((prev) => prev.filter((i) => i.invite_id !== inviteId));
    } catch { /* silent */ }
  };

  const inviteCount = matchInvites.length + clanInvites.length;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Team</Text>
      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
        >
          {/* ── Invites hub ─────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>Invites</Text>
          {inviteCount === 0 && (
            <Text style={styles.emptySubText}>Nothing waiting. Match and team invites land here.</Text>
          )}
          {matchInvites.map((inv) => (
            <View key={inv.invite_id} style={styles.inviteRow}>
              <UserAvatar username={inv.from_username} avatarUrl={inv.from_avatar_url} size={36} borderRadius={4} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName} numberOfLines={1}>{censorText(inv.from_username, censor)} invited you</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {(inv.match_type ?? 'match').charAt(0).toUpperCase() + (inv.match_type ?? 'match').slice(1)}
                  {inv.match_name ? ` · ${censorText(inv.match_name, censor)}` : ''}
                  {' · '}{inv.from_elo} SR
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.inviteBtn, { backgroundColor: C.green + '22', borderColor: C.green }]}
                onPress={() => acceptMatchInvite(inv)}
              >
                <Text style={[styles.inviteBtnText, { color: C.green }]}>Join</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.inviteBtn, { backgroundColor: C.card, borderColor: C.border }]}
                onPress={() => declineMatchInvite(inv.invite_id)}
              >
                <Text style={[styles.inviteBtnText, { color: C.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
          {clanInvites.map((inv) => (
            <View key={inv.invite_id} style={styles.inviteRow}>
              <View style={[styles.teamAvatar, { backgroundColor: C.gold + '22' }]}>
                <Text style={styles.teamAvatarText}>{censorText(inv.clan_name ?? '', censor)[0]?.toUpperCase() ?? '?'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName} numberOfLines={1}>{censorText(inv.clan_name, censor)}</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {inv.clan_mode.toUpperCase()} · {inv.member_count}/{inv.max_players} · from {censorText(inv.from_username, censor)}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.inviteBtn, { backgroundColor: C.green + '22', borderColor: C.green }]}
                onPress={() => acceptClanInvite(inv)}
              >
                <Text style={[styles.inviteBtnText, { color: C.green }]}>Join</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.inviteBtn, { backgroundColor: C.card, borderColor: C.border }]}
                onPress={() => declineClanInvite(inv.invite_id)}
              >
                <Text style={[styles.inviteBtnText, { color: C.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}

          {/* ── My teams ────────────────────────────────────────────── */}
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>My Teams</Text>
            <TouchableOpacity onPress={() => router.push('/teams' as any)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.sectionAction}>Browse / + New</Text>
            </TouchableOpacity>
          </View>
          {myTeams.length === 0 ? (
            <TouchableOpacity style={styles.emptyCta} onPress={() => router.push('/teams' as any)} activeOpacity={0.7}>
              <Text style={styles.emptyCtaTitle}>Create your first team</Text>
              <Text style={styles.emptyCtaSub}>
                A Duo (2 players) or Squad (4) lets you play ranked team matches with friends. Make one, then invite from the team page.
              </Text>
            </TouchableOpacity>
          ) : (
            myTeams.map((t) => (
              <TouchableOpacity
                key={t.clan_id}
                style={styles.teamRow}
                onPress={() => router.push(`/clan/${t.clan_id}` as any)}
                activeOpacity={0.7}
              >
                <View style={[styles.teamAvatar, { backgroundColor: C.gold + '22' }]}>
                  <Text style={styles.teamAvatarText}>{censorText(t.name ?? '', censor)[0]?.toUpperCase() ?? '?'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{censorText(t.name, censor)}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {t.clan_mode === 'duo' ? 'DUO' : 'SQUAD'} · {t.member_count}/{t.max_players} members · {t.elo} SR
                    {t.role === 'leader' ? ' · Leader' : ''}
                  </Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </TouchableOpacity>
            ))
          )}

          {/* ── Friends ─────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>Friends</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={styles.friendBtn} onPress={() => router.push('/friends' as any)} activeOpacity={0.7}>
              <Text style={styles.friendBtnText}>My Friends</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.friendBtn, { borderColor: C.gold, backgroundColor: C.gold + '14' }]}
              onPress={() => router.push('/friends?tab=add' as any)}
              activeOpacity={0.7}
            >
              <Text style={[styles.friendBtnText, { color: C.gold }]}>+ Add Friends</Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 8 },

  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionTitle: {
    color: C.gold, fontSize: 11, fontWeight: '900',
    letterSpacing: 1.4, marginTop: 18, marginBottom: 8,
  },
  sectionAction: { color: C.gold, fontSize: 12, fontWeight: '800' },
  emptySubText: {
    color: C.textMuted, fontSize: 12, fontStyle: 'italic',
    paddingHorizontal: 4, paddingBottom: 4, lineHeight: 17,
  },

  inviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 10,
    borderRadius: 8, backgroundColor: C.card,
    marginBottom: 6, borderWidth: 1, borderColor: C.gold + '55',
  },
  inviteBtn: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, minWidth: 36, alignItems: 'center',
  },
  inviteBtnText: { fontSize: 12, fontWeight: '800' },

  teamRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 10, paddingVertical: 12,
    borderRadius: 8, backgroundColor: C.card,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  teamAvatar: { width: 40, height: 40, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  teamAvatarText: { color: C.gold, fontWeight: '900', fontSize: 16 },
  rowName: { color: C.text, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  chev: { color: C.textDim, fontSize: 22, marginLeft: 4 },

  emptyCta: {
    backgroundColor: C.gold + '11', borderColor: C.gold + '66', borderWidth: 1,
    borderRadius: 10, padding: 16, marginBottom: 6,
  },
  emptyCtaTitle: { color: C.gold, fontWeight: '900', fontSize: 14 },
  emptyCtaSub: { color: C.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 },

  friendBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  friendBtnText: { color: C.text, fontWeight: '800', fontSize: 13 },
});
