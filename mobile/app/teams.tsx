/**
 * Browse + join public teams.
 *
 * Previously, joining a team meant either accepting an invite or knowing
 * the team's ID — the public-team list endpoint (GET /clans) wasn't
 * surfaced anywhere after the Social → Teams sub-tab was removed. This
 * screen reopens that path: it lists every public team, lets the user
 * filter by mode (Duo / Squad), tap to join, or create their own.
 *
 * Free-tier cap: the server limits non-premium users to 2 duos + 2 squads.
 * A 402 from /join surfaces here as an "Upgrade to Premium" dialog.
 *
 * Reachable from the My Teams section of the profile and from the
 * Browse / + Create chips in this header.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Alert, Modal, TextInput, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { useCensor } from '../lib/censor';

type Mode = 'all' | 'duo' | 'squad';

export default function TeamsBrowseScreen() {
  const { user } = useAuth();
  const censor = useCensor();
  // Team creation is free + uncapped now (non-cosmetic features aren't gated).
  const userIsPremium = true;
  const [teams, setTeams] = useState<any[]>([]);
  const [myTeams, setMyTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<Mode>('all');
  const [joining, setJoining] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([
        api.clans.list(),
        api.clans.mine(),
      ]);
      setTeams(Array.isArray(all)  ? all  : []);
      setMyTeams(Array.isArray(mine) ? mine : []);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const myTeamIds = useMemo(() => new Set(myTeams.map((t) => t.clan_id)), [myTeams]);
  // Show all public teams, with my-already-joined ones flagged.
  const filtered = teams.filter((t) => mode === 'all' ? true : t.clan_mode === mode);

  // Per-mode free-tier headroom — drives the "X of 2 used" pill at the top
  // so the user knows their cap status before they ever tap Join.
  const duoCount   = myTeams.filter((t) => t.clan_mode === 'duo').length;
  const squadCount = myTeams.filter((t) => t.clan_mode === 'squad').length;

  const tryJoin = async (team: any) => {
    setJoining(team.clan_id);
    try {
      await api.clans.join(team.clan_id);
      Alert.alert('Joined!', `Welcome to ${team.name}.`, [
        { text: 'View team', onPress: () => router.replace(`/clan/${team.clan_id}` as any) },
        { text: 'OK' },
      ]);
      await load();
    } catch (e: any) {
      // Server emits 402 + `upgrade_required:true` when the free-tier
      // cap is hit. Map to a friendly upgrade prompt rather than a
      // generic error toast.
      const msg = e?.message ?? 'Could not join';
      if (e?.status === 402 || /Upgrade to Premium/i.test(msg)) {
        Alert.alert('Team limit reached', msg, [
          { text: 'Not now', style: 'cancel' },
          { text: 'See Premium', onPress: () => router.push('/premium' as any) },
        ]);
      } else {
        Alert.alert('Could not join', msg);
      }
    } finally {
      setJoining(null);
    }
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Teams',
        headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text,
      }} />

      {/* Header row — mode filter + Create CTA. The Create button leads
          to the same modal regardless of mode; the user picks duo/squad
          inside it. */}
      <View style={s.headerRow}>
        <View style={s.modeRow}>
          {(['all', 'duo', 'squad'] as Mode[]).map((m) => (
            <TouchableOpacity
              key={m}
              style={[s.modeChip, mode === m && s.modeChipActive]}
              onPress={() => setMode(m)}
            >
              <Text style={[s.modeChipText, mode === m && s.modeChipTextActive]}>
                {m === 'all' ? 'ALL' : m.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={s.createBtn}
          onPress={() => setCreateOpen(true)}
          activeOpacity={0.7}
        >
          <Text style={s.createBtnText}>+ Create</Text>
        </TouchableOpacity>
      </View>

      {/* Free-tier cap banner. Premium users don't see it. */}
      {!userIsPremium && (
        <View style={s.capBanner}>
          <Text style={s.capBannerText}>
            FREE PLAN · {duoCount}/2 duos · {squadCount}/2 squads
            {(duoCount >= 2 || squadCount >= 2) && (
              <Text style={{ color: C.gold }}>  ·  Tap to upgrade</Text>
            )}
          </Text>
          {(duoCount >= 2 || squadCount >= 2) && (
            <TouchableOpacity
              onPress={() => router.push('/premium' as any)}
              style={StyleSheet.absoluteFill}
            />
          )}
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(t) => t.clan_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={C.gold}
            />
          }
          ListEmptyComponent={
            <View style={{ padding: 30 }}>
              <Text style={s.empty}>No public {mode === 'all' ? '' : mode + ' '}teams yet.</Text>
              <Text style={s.emptySub}>Tap + Create to start your own.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const isMember = myTeamIds.has(item.clan_id);
            const isFull   = (item.member_count ?? 0) >= (item.max_players ?? 0);
            const isJoining = joining === item.clan_id;
            return (
              <View style={s.teamCard}>
                <TouchableOpacity
                  style={s.teamMain}
                  onPress={() => router.push(`/clan/${item.clan_id}` as any)}
                  activeOpacity={0.7}
                >
                  <View style={s.teamIcon}>
                    <Text style={s.teamIconText}>{censor(item.name)[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.teamName} numberOfLines={1}>{censor(item.name)}</Text>
                    <Text style={s.teamMeta} numberOfLines={1}>
                      {(item.clan_mode ?? '').toString().toUpperCase()}
                      {'  ·  '}{item.member_count ?? 0}/{item.max_players ?? '?'} members
                      {item.elo != null ? `  ·  ${item.elo} SR` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
                {isMember ? (
                  <View style={[s.joinBtn, s.joinBtnMember]}>
                    <Text style={[s.joinBtnText, { color: C.green }]}>✓ Member</Text>
                  </View>
                ) : isFull ? (
                  <View style={[s.joinBtn, s.joinBtnFull]}>
                    <Text style={[s.joinBtnText, { color: C.textMuted }]}>Full</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[s.joinBtn, s.joinBtnGo]}
                    onPress={() => tryJoin(item)}
                    disabled={isJoining}
                    activeOpacity={0.7}
                  >
                    {isJoining
                      ? <ActivityIndicator color={C.bg} size="small" />
                      : <Text style={[s.joinBtnText, { color: C.bg }]}>Join</Text>}
                  </TouchableOpacity>
                )}
              </View>
            );
          }}
        />
      )}

      <CreateTeamModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (clanId) => {
          setCreateOpen(false);
          await load();
          router.push(`/clan/${clanId}` as any);
        }}
        userIsPremium={userIsPremium}
        duoCount={duoCount}
        squadCount={squadCount}
      />
    </View>
  );
}

function CreateTeamModal({
  visible, onClose, onCreated, userIsPremium, duoCount, squadCount,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (clanId: string) => void;
  userIsPremium: boolean;
  duoCount: number;
  squadCount: number;
}) {
  const [name, setName] = useState('');
  const [clanMode, setClanMode] = useState<'duo' | 'squad'>('duo');
  const [submitting, setSubmitting] = useState(false);

  const wouldExceedCap = !userIsPremium && (
    (clanMode === 'duo'   && duoCount   >= 2) ||
    (clanMode === 'squad' && squadCount >= 2)
  );

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      Alert.alert('Name required', 'Team names must be at least 2 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.clans.create(trimmed, clanMode);
      setName('');
      onCreated(created.clan_id);
    } catch (e: any) {
      const msg = e?.message ?? 'Could not create team';
      if (e?.status === 402 || /Upgrade to Premium/i.test(msg)) {
        Alert.alert('Team limit reached', msg, [
          { text: 'Not now', style: 'cancel' },
          { text: 'See Premium', onPress: () => router.push('/premium' as any) },
        ]);
      } else {
        Alert.alert('Could not create team', msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.modalContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.modalHeader}>
          <TouchableOpacity onPress={onClose}>
            <Text style={{ color: C.textMuted, fontSize: 15 }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.modalTitle}>New Team</Text>
          <TouchableOpacity onPress={submit} disabled={submitting || wouldExceedCap}>
            <Text style={[
              { color: C.gold, fontSize: 15, fontWeight: '700' },
              (submitting || wouldExceedCap) && { opacity: 0.4 },
            ]}>
              {submitting ? '…' : 'Create'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ padding: 20 }}>
          <Text style={s.modalLabel}>NAME</Text>
          <TextInput
            style={s.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Thunder Cats"
            placeholderTextColor={C.textMuted}
            maxLength={60}
            autoFocus
          />

          <Text style={[s.modalLabel, { marginTop: 18 }]}>MODE</Text>
          <View style={s.modeRow}>
            <TouchableOpacity
              style={[s.modeChip, { flex: 1 }, clanMode === 'duo' && s.modeChipActive]}
              onPress={() => setClanMode('duo')}
            >
              <Text style={[s.modeChipText, clanMode === 'duo' && s.modeChipTextActive]}>
                DUO · 2 players
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeChip, { flex: 1 }, clanMode === 'squad' && s.modeChipActive]}
              onPress={() => setClanMode('squad')}
            >
              <Text style={[s.modeChipText, clanMode === 'squad' && s.modeChipTextActive]}>
                SQUAD · 4 players
              </Text>
            </TouchableOpacity>
          </View>

          {wouldExceedCap && (
            <View style={[s.capBanner, { marginTop: 14, position: 'relative' }]}>
              <Text style={s.capBannerText}>
                You&apos;re on the max number of {clanMode}s for the free
                plan ({clanMode === 'duo' ? duoCount : squadCount}/2).{'  '}
                <Text style={{ color: C.gold }}>Tap to upgrade →</Text>
              </Text>
              <TouchableOpacity
                onPress={() => { onClose(); router.push('/premium' as any); }}
                style={StyleSheet.absoluteFill}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8,
  },
  modeRow: { flexDirection: 'row', gap: 6, flex: 1 },
  modeChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    alignItems: 'center',
  },
  modeChipActive: { backgroundColor: C.gold, borderColor: C.gold },
  modeChipText: { color: C.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  modeChipTextActive: { color: C.bg },

  createBtn: {
    backgroundColor: C.gold + '22', borderColor: C.gold, borderWidth: 1,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7,
  },
  createBtnText: { color: C.gold, fontWeight: '900', fontSize: 12, letterSpacing: 0.5 },

  capBanner: {
    marginHorizontal: 16,
    backgroundColor: C.gold + '11',
    borderColor: C.gold + '66', borderWidth: 1,
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12,
    overflow: 'hidden',
  },
  capBannerText: {
    color: C.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.5,
  },

  teamCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderColor: C.border, borderWidth: 1,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  teamMain: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0,
  },
  teamIcon: {
    width: 40, height: 40, borderRadius: 6,
    backgroundColor: C.gold + '22',
    alignItems: 'center', justifyContent: 'center',
  },
  teamIconText: { color: C.gold, fontWeight: '900', fontSize: 16, fontFamily: F.serif },
  teamName: { color: C.text, fontSize: 15, fontWeight: '800' },
  teamMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  joinBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
    minWidth: 76, alignItems: 'center', justifyContent: 'center',
  },
  joinBtnGo:     { backgroundColor: C.gold },
  joinBtnFull:   { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
  joinBtnMember: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.green + '66' },
  joinBtnText:   { fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },

  empty:    { color: C.text, fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  emptySub: { color: C.textMuted, fontSize: 12, textAlign: 'center' },

  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '900' },
  modalLabel: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8 },
  modalInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
    borderWidth: 1, borderColor: C.border,
  },
});
