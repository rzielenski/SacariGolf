import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, FlatList,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C } from '../lib/colors';
import { UserAvatar } from './UserAvatar';
import { useCensor } from '../lib/censor';

/**
 * Reusable "invite players to a match" modal. Used from:
 *   • Match lobby (`match/[id].tsx`) — invite into a pending Arena/duo/squad/solo
 *   • Scoring screen (`match/scoring/[id].tsx`) — invite into a practice round
 *
 * Two ways to find someone:
 *   1. Your friends list (shown by default — the fast path).
 *   2. Search ANY player by username. The server only requires the inviter to
 *      be in the match (no friends-only guard), so you can pull in someone you
 *      haven't friended yet — the #1 reason invites used to be impossible to
 *      send. Type 2+ characters to switch the list to live search results.
 *
 * Pass `excludeUserIds` to render friends/results already in the match as
 * "In match". `onInvited` fires after each successful invite so the parent can
 * optimistically bump a local count.
 */
interface Person {
  user_id: string;
  username: string;
  elo?: number;
  avatar_url?: string | null;
}

interface Props {
  visible: boolean;
  matchId: string;
  onClose: () => void;
  /** Friends/results already in the match — rendered as "In match". */
  excludeUserIds?: string[];
  /** Optional cap — once N friends have been invited this session, the
   *  remaining rows go disabled. Used by practice to enforce the 8-max rule. */
  maxAdditional?: number;
  /** Called after each successful invite — parent can update local count. */
  onInvited?: (friendId: string) => void;
  title?: string;
  subtitle?: string;
}

export function InviteFriendsModal({
  visible, matchId, onClose, excludeUserIds, maxAdditional, onInvited,
  title = 'Invite Players', subtitle,
}: Props) {
  const c = useCensor();
  const { user } = useAuth();
  const [friends, setFriends] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [invitedThisSession, setInvitedThisSession] = useState<Set<string>>(new Set());

  // Username search — lets you invite anyone, not just existing friends.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!visible || friends.length > 0) return;
    setLoading(true);
    api.users.friends()
      .then((rows) => setFriends(rows as Person[]))
      .catch(() => { /* show empty list */ })
      .finally(() => setLoading(false));
    // We deliberately don't refetch every time `visible` flips — friends
    // change rarely enough that the in-modal cached list is fine.
  }, [visible]);

  // Reset per-session state when the modal is reopened on a different match.
  useEffect(() => {
    if (visible) { setInvitedThisSession(new Set()); setQuery(''); setResults([]); }
  }, [matchId]);

  // Debounced username search. Below 2 chars we fall back to the friends list.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.users.search(q)
        .then((rows) => setResults((rows as Person[]) ?? []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const excludeSet = new Set(excludeUserIds ?? []);
  const additionalCount = invitedThisSession.size;
  const capReached = typeof maxAdditional === 'number' && additionalCount >= maxAdditional;

  const sendInvite = async (person: Person) => {
    if (sendingId) return;
    if (capReached) {
      Alert.alert('Cap reached', `You can only invite ${maxAdditional} more player${maxAdditional === 1 ? '' : 's'} to this match.`);
      return;
    }
    setSendingId(person.user_id);
    try {
      await api.invites.send(matchId, person.user_id);
      setInvitedThisSession((prev) => {
        const next = new Set(prev);
        next.add(person.user_id);
        return next;
      });
      onInvited?.(person.user_id);
    } catch (e: any) {
      Alert.alert('Could not invite', e?.message ?? 'Try again.');
    } finally {
      setSendingId(null);
    }
  };

  const searchMode = query.trim().length >= 2;
  // Search mode shows live results (minus yourself); otherwise the friends list.
  const data = searchMode
    ? results.filter((r) => r.user_id !== user?.user_id)
    : friends;

  const renderRow = ({ item }: { item: Person }) => {
    const inMatch = excludeSet.has(item.user_id);
    const invited = invitedThisSession.has(item.user_id);
    const disabled = inMatch || invited || sendingId === item.user_id || (capReached && !invited);
    return (
      <View style={s.row}>
        <UserAvatar username={item.username} avatarUrl={item.avatar_url} size={40} borderRadius={4} />
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{c(item.username)}</Text>
          {item.elo != null && <Text style={s.meta}>{item.elo} ELO</Text>}
        </View>
        <TouchableOpacity
          style={[s.btn, disabled && s.btnDisabled, invited && s.btnSent]}
          onPress={() => sendInvite(item)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          {sendingId === item.user_id ? (
            <ActivityIndicator color={C.gold} size="small" />
          ) : (
            <Text style={[s.btnText, invited && s.btnSentText]}>
              {inMatch ? 'In Match' : invited ? 'Invited' : 'Invite'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    );
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
        <Text style={s.subtitle}>
          {subtitle ?? 'Invited players get a notification and can also Join from the Chats tab, then play their own round.'}
        </Text>

        {/* Search ANY player by username — not just friends. */}
        <TextInput
          style={s.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search any player by username…"
          placeholderTextColor={C.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {(searchMode ? searching : loading) ? (
          <View style={s.center}><ActivityIndicator color={C.gold} /></View>
        ) : data.length === 0 ? (
          <View style={s.center}>
            {searchMode ? (
              <>
                <Text style={s.empty}>No players found</Text>
                <Text style={s.emptySub}>Check the spelling, or have them search for you.</Text>
              </>
            ) : (
              <>
                <Text style={s.empty}>No friends yet</Text>
                <Text style={s.emptySub}>Use the search above to invite any player by username.</Text>
              </>
            )}
          </View>
        ) : (
          <>
            <Text style={s.listLabel}>{searchMode ? 'Search results' : 'Your friends'}</Text>
            <FlatList
              data={data}
              keyExtractor={(f) => f.user_id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={renderRow}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 18 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 8,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '900' },
  close: { color: C.gold, fontSize: 15, fontWeight: '700' },
  subtitle: { color: C.textMuted, fontSize: 12, paddingHorizontal: 20, paddingBottom: 12, lineHeight: 17 },
  search: {
    marginHorizontal: 20, marginBottom: 12,
    backgroundColor: C.card, color: C.text, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  listLabel: {
    color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.2,
    paddingHorizontal: 20, marginBottom: 8,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  empty: { color: C.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: C.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
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
