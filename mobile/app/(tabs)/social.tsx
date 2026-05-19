/**
 * Social tab — now a chats-only inbox.
 *
 * What used to be a three-tab (Friends / Teams / Chats) screen lived here.
 * The Friends sub-tab had cramped rows with cut-off usernames and big
 * Message / Challenge buttons jammed against the right edge — every row
 * was a UX compromise. The Teams sub-tab and the friend-search overlap
 * with the rest of the app:
 *
 *   • Friends list — already exists on the player's own profile via the
 *     Following / Followers strip. The list pages now host the user-
 *     lookup search bar so "add a friend" lives next to "see my friends."
 *   • Teams       — reachable from the profile's clan section and (when
 *     invited) from the inline Team Invite card on this screen.
 *   • Challenge   — every profile already has a "+ Add Friend" / chat
 *     button row; the per-row Challenge button on the friends list was
 *     duplicative with the Play tab's challenge flow.
 *
 * What remains here:
 *   • Match Invites and Team Invites surfaces — actionable items that
 *     don't have an obvious home elsewhere yet.
 *   • Direct Messages, Match Chats, Team Chats — the three chat lists
 *     that drove ~all the navigation traffic from this tab anyway.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, Animated, Easing,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { MatchInvite } from '../../types';
import { C } from '../../lib/colors';
import { UserAvatar } from '../../components/UserAvatar';
import { useAuth } from '../../lib/auth';
import { censorText } from '../../lib/censor';

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
 *  opacity + scale from the shared driver. */
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
  const { user } = useAuth();
  // Default ON: censor unless the viewer explicitly turned it off.
  const censor = user?.censor_offensive_language !== false;
  // Invites — actionable items that surface alongside the chats. Match
  // invites and Team invites both need accept/decline before they can
  // open a chat, so we render them at the top of the same scroll view.
  const [matchInvites, setMatchInvites] = useState<MatchInvite[]>([]);
  const [clanInvites, setClanInvites] = useState<any[]>([]);

  // Chats
  const [dms, setDms] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [clans, setClans] = useState<any[]>([]);
  // Unread tracking — DM unread comes inline on `conversations`; match +
  // clan unread come from the separate /messages/unread-summary endpoint
  // so we don't bloat the matches.list / clans.mine responses everyone
  // else uses.
  const [unreadMatchIds, setUnreadMatchIds] = useState<Set<string>>(new Set());
  const [unreadClanIds, setUnreadClanIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [invites, ci, convs, allMatches, myClans, unread] = await Promise.all([
        api.invites.list(),
        api.clans.clanInvites(),
        api.messages.conversations(),
        api.matches.list(),
        api.clans.mine(),
        api.messages.unreadSummary().catch(() => ({ matches: [], clans: [] })),
      ]);
      setMatchInvites(invites);
      setClanInvites(ci);
      setDms(convs);
      setMatches(allMatches.filter((m: any) => !m.completed));
      setClans(myClans);
      setUnreadMatchIds(new Set(unread.matches));
      setUnreadClanIds(new Set(unread.clans));
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Invite actions ──────────────────────────────────────────────────────
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

  // Sort each list: unread first (preserving their relative order), then
  // read. Stable partition keeps server-side ordering (most-recent-first)
  // intact within each bucket so newest unread floats to the top.
  const sortByUnread = <T,>(arr: T[], isUnread: (x: T) => boolean): T[] => {
    const u: T[] = [], r: T[] = [];
    for (const x of arr) (isUnread(x) ? u : r).push(x);
    return [...u, ...r];
  };
  const dmsSorted     = sortByUnread(dms,     (c: any) => !!c.unread);
  const matchesSorted = sortByUnread(matches, (m: any) => unreadMatchIds.has(m.match_id));
  const clansSorted   = sortByUnread(clans,   (c: any) => unreadClanIds.has(c.clan_id));

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Chats</Text>
        <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chats</Text>
      <ScrollView style={{ flex: 1 }}>
        {/* ── Match Invites ─────────────────────────────────────────── */}
        {matchInvites.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Match Invites</Text>
            {matchInvites.map((inv) => (
              <View key={inv.invite_id} style={styles.inviteRow}>
                <UserAvatar username={inv.from_username} avatarUrl={inv.from_avatar_url} size={36} borderRadius={4} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName} numberOfLines={1}>{inv.from_username} invited you</Text>
                  <Text style={styles.userElo} numberOfLines={1}>
                    {(inv.match_type ?? 'match').charAt(0).toUpperCase() + (inv.match_type ?? 'match').slice(1)}
                    {inv.match_name ? ` · ${inv.match_name}` : ''}
                    {' · '}{inv.from_elo} ELO
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
          </>
        )}

        {/* ── Team Invites ──────────────────────────────────────────── */}
        {clanInvites.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Team Invites</Text>
            {clanInvites.map((inv) => (
              <View key={inv.invite_id} style={styles.inviteRow}>
                <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
                  <Text style={styles.avatarText}>{inv.clan_name?.[0]?.toUpperCase() ?? '?'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName} numberOfLines={1}>{inv.clan_name}</Text>
                  <Text style={styles.userElo} numberOfLines={1}>
                    {inv.clan_mode.toUpperCase()} · {inv.member_count}/{inv.max_players} · from {inv.from_username}
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
          </>
        )}

        {/* ── Direct Messages ─────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>Direct Messages</Text>
        {dmsSorted.length === 0 && (
          <Text style={styles.emptySubText}>
            No conversations yet — visit a friend&apos;s profile and tap Message to start one.
          </Text>
        )}
        {dmsSorted.map((conv) => (
          <TouchableOpacity
            key={conv.other_id}
            style={[styles.userRow, conv.unread && styles.userRowUnread]}
            onPress={() => {
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
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.userName, conv.unread && styles.userNameUnread]} numberOfLines={1}>
                {conv.other_username}
              </Text>
              {conv.last_message ? (
                <Text
                  style={[styles.userElo, conv.unread && styles.userMsgUnread]}
                  numberOfLines={1}
                >
                  {censorText(conv.last_message, censor)}
                </Text>
              ) : null}
            </View>
            {conv.unread && <UnreadDot />}
          </TouchableOpacity>
        ))}

        {/* ── Match Chats ────────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>Match Chats</Text>
        {matchesSorted.length === 0 && (
          <Text style={styles.emptySubText}>No active matches</Text>
        )}
        {matchesSorted.map((m) => {
          const unread = unreadMatchIds.has(m.match_id);
          return (
            <TouchableOpacity
              key={m.match_id}
              style={[styles.userRow, unread && styles.userRowUnread]}
              onPress={() => {
                if (unread) {
                  setUnreadMatchIds((prev) => { const next = new Set(prev); next.delete(m.match_id); return next; });
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
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.userName, unread && styles.userNameUnread]} numberOfLines={1}>
                  {m.name || m.match_type}
                </Text>
                <Text style={styles.userElo} numberOfLines={1}>Match ID: {m.match_id.slice(0, 8)}…</Text>
              </View>
              {unread && <UnreadDot />}
            </TouchableOpacity>
          );
        })}

        {/* ── Team Chats ────────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>Team Chats</Text>
        {clansSorted.length === 0 && (
          <Text style={styles.emptySubText}>
            No clans joined — find or start one from your profile.
          </Text>
        )}
        {clansSorted.map((c) => {
          const unread = unreadClanIds.has(c.clan_id);
          return (
            <TouchableOpacity
              key={c.clan_id}
              style={[styles.userRow, unread && styles.userRowUnread]}
              onPress={() => {
                if (unread) {
                  setUnreadClanIds((prev) => { const next = new Set(prev); next.delete(c.clan_id); return next; });
                }
                router.push(`/chat/clan/${c.clan_id}` as any);
              }}
            >
              <View style={[styles.userAvatar, { backgroundColor: C.gold + '22' }]}>
                <Text style={styles.avatarText}>{c.name?.[0]?.toUpperCase() ?? '?'}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.userName, unread && styles.userNameUnread]} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text style={styles.userElo} numberOfLines={1}>
                  {c.clan_mode.toUpperCase()} · {c.member_count} members
                </Text>
              </View>
              {unread && <UnreadDot />}
            </TouchableOpacity>
          );
        })}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 16 },

  sectionTitle: {
    color: C.gold, fontSize: 11, fontWeight: '900',
    letterSpacing: 1.4, marginTop: 18, marginBottom: 8,
  },
  emptySubText: {
    color: C.textMuted, fontSize: 12, fontStyle: 'italic',
    paddingHorizontal: 4, paddingBottom: 4, lineHeight: 17,
  },

  userRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 10, paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: C.card,
    marginBottom: 6,
    borderWidth: 1, borderColor: C.border,
  },
  userRowUnread: { borderColor: C.gold + '88', backgroundColor: C.gold + '0a' },
  userAvatar: {
    width: 40, height: 40, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: C.gold, fontWeight: '900', fontSize: 16 },

  userName: { color: C.text, fontSize: 15, fontWeight: '700' },
  userNameUnread: { color: C.gold },
  userElo: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  userMsgUnread: { color: C.text + 'dd' },

  inviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: C.card,
    marginBottom: 6,
    borderWidth: 1, borderColor: C.gold + '55',
  },
  // Compact pill — Join is text, Decline is just ✕, so the row breathes.
  inviteBtn: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, minWidth: 36, alignItems: 'center',
  },
  inviteBtnText: { fontSize: 12, fontWeight: '800' },

  unreadDotGlow: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: C.gold + '55',
    alignItems: 'center', justifyContent: 'center',
  },
  unreadDotCore: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.gold },
});
