import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, FlatList,
  ActivityIndicator, Alert,
} from 'react-native';
import { api } from '../lib/api';
import { C } from '../lib/colors';

/**
 * Reusable "invite friends to a match" modal. Same UX as the match lobby's
 * invite list — fetches the user's friends, lets them tap Invite per friend.
 * Used from:
 *   • Match lobby (`match/[id].tsx`) — invite into a pending Arena/duo/squad
 *   • Scoring screen (`match/scoring/[id].tsx`) — invite into a practice round
 *
 * Pass `excludeUserIds` to hide friends already in the match. `onInvited` is
 * called after each successful invite so the parent can optimistically bump a
 * local count (e.g. dim already-invited friends without a refetch).
 */
interface Friend {
  user_id: string;
  username: string;
  elo: number;
}

interface Props {
  visible: boolean;
  matchId: string;
  onClose: () => void;
  /** Friends already in the match — rendered as "In match" instead of Invite. */
  excludeUserIds?: string[];
  /** Optional cap — once N already-invited friends have been added in this
   *  session, the remaining rows go disabled. Used by practice to enforce
   *  the 8-friends-max rule from the host's side. */
  maxAdditional?: number;
  /** Called after each successful invite — parent can update local count. */
  onInvited?: (friendId: string) => void;
  title?: string;
  subtitle?: string;
}

export function InviteFriendsModal({
  visible, matchId, onClose, excludeUserIds, maxAdditional, onInvited,
  title = 'Invite Friends', subtitle,
}: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [invitedThisSession, setInvitedThisSession] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible || friends.length > 0) return;
    setLoading(true);
    api.users.friends()
      .then((rows) => setFriends(rows as Friend[]))
      .catch(() => { /* show empty list */ })
      .finally(() => setLoading(false));
    // We deliberately don't refetch every time `visible` flips — friends
    // change rarely enough that the in-modal cached list is fine.
  }, [visible]);

  // Reset the per-session "invited" memo when the modal is reopened on a
  // different match. Otherwise re-using the modal for a second match shows
  // friends as already-invited from the previous one.
  useEffect(() => {
    if (visible) setInvitedThisSession(new Set());
  }, [matchId]);

  const excludeSet = new Set(excludeUserIds ?? []);
  const additionalCount = invitedThisSession.size;
  const capReached = typeof maxAdditional === 'number' && additionalCount >= maxAdditional;

  const sendInvite = async (friend: Friend) => {
    if (sendingId) return;
    if (capReached) {
      Alert.alert('Cap reached', `You can only invite ${maxAdditional} more friend${maxAdditional === 1 ? '' : 's'} to this match.`);
      return;
    }
    setSendingId(friend.user_id);
    try {
      await api.invites.send(matchId, friend.user_id);
      setInvitedThisSession((prev) => {
        const next = new Set(prev);
        next.add(friend.user_id);
        return next;
      });
      onInvited?.(friend.user_id);
    } catch (e: any) {
      Alert.alert('Could not invite', e?.message ?? 'Try again.');
    } finally {
      setSendingId(null);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.close}>Done</Text>
          </TouchableOpacity>
        </View>
        {subtitle && <Text style={s.subtitle}>{subtitle}</Text>}

        {loading ? (
          <View style={s.center}><ActivityIndicator color={C.gold} /></View>
        ) : friends.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No friends yet</Text>
            <Text style={s.emptySub}>Add friends from the Social tab to invite them to matches.</Text>
          </View>
        ) : (
          <FlatList
            data={friends}
            keyExtractor={(f) => f.user_id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
            renderItem={({ item }) => {
              const inMatch = excludeSet.has(item.user_id);
              const invitedThisVisit = invitedThisSession.has(item.user_id);
              const disabled = inMatch || invitedThisVisit || sendingId === item.user_id || (capReached && !invitedThisVisit);
              return (
                <View style={s.row}>
                  <View style={s.avatar}>
                    <Text style={s.avatarText}>{item.username[0]?.toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>{item.username}</Text>
                    <Text style={s.meta}>{item.elo} ELO</Text>
                  </View>
                  <TouchableOpacity
                    style={[s.btn, disabled && s.btnDisabled, invitedThisVisit && s.btnSent]}
                    onPress={() => sendInvite(item)}
                    disabled={disabled}
                    activeOpacity={0.7}
                  >
                    {sendingId === item.user_id ? (
                      <ActivityIndicator color={C.gold} size="small" />
                    ) : (
                      <Text style={[s.btnText, invitedThisVisit && s.btnSentText]}>
                        {inMatch ? 'In Match' : invitedThisVisit ? 'Invited' : 'Invite'}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 18 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '900' },
  close: { color: C.gold, fontSize: 15, fontWeight: '700' },
  subtitle: { color: C.textMuted, fontSize: 12, paddingHorizontal: 20, paddingBottom: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  empty: { color: C.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: C.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: C.gold, fontWeight: '900', fontSize: 16 },
  name: { color: C.text, fontSize: 15, fontWeight: '700' },
  meta: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  btn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6,
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '22',
    minWidth: 76, alignItems: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  btnSent: { backgroundColor: C.card, borderColor: C.border },
  btnText: { color: C.gold, fontWeight: '900', fontSize: 12, letterSpacing: 0.6 },
  btnSentText: { color: C.textMuted },
});
