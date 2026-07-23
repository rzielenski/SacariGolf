import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, RefreshControl, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { Divider, OrnamentTitle } from '../components/Flourish';
import { useCensor } from '../lib/censor';

/**
 * Buddies Leagues — private, season-long, handicap-adjusted competitions for a
 * friend group. Any user can create one (no approved-creator gate); members
 * just play their normal rounds and the NET (handicap-adjusted) leaderboard
 * scores the season, so a 20-handicap and a scratch golfer compete fairly.
 *
 * A buddies league is a `tournament` row with league_type='buddies'. This
 * screen lists the ones you're in, creates new ones, and joins by code. The
 * detail / standings / feed / chat all live on the shared /tournament/[id].
 */
export default function LeaguesScreen() {
  const c = useCensor();
  const [leagues, setLeagues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const all = await api.tournaments.list();
      setLeagues(Array.isArray(all) ? all.filter((t) => t.league_type === 'buddies') : []);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: '', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold, headerShadowVisible: false }} />

      <Text style={s.title}>Leagues</Text>
      <Text style={s.sub}>
        Private, season-long competitions for your golf group. Everyone plays their normal rounds. the handicap-adjusted board keeps it fair for all levels.
      </Text>
      <Divider style={{ marginTop: 8, marginBottom: 12 }} />

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
        <TouchableOpacity style={[s.actionBtn, { backgroundColor: C.gold }]} onPress={() => setCreateOpen(true)}>
          <Text style={s.actionText}>+ New League</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={() => setJoinOpen(true)}>
          <Text style={[s.actionText, { color: C.text }]}>Join by Code</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 30 }} size="large" />
      ) : leagues.length === 0 ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>Start a league with your friends</Text>
          <Text style={s.emptyBody}>
            Create one, share the code, and everyone competes all season just by playing their rounds. Or join one with a code a friend sent.
          </Text>
        </View>
      ) : (
        <>
          <OrnamentTitle title="Your Leagues" />
          {leagues.map((t) => <Row key={t.tournament_id} t={t} c={c} />)}
        </>
      )}

      {/* Browse public creator leagues — a secondary discovery surface. */}
      <TouchableOpacity style={s.browseRow} onPress={() => router.push('/creator-leagues' as any)} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={s.browseTitle}>Browse public leagues</Text>
          <Text style={s.browseSub}>Creator-hosted leagues anyone can join</Text>
        </View>
        <Text style={s.rowChev}>›</Text>
      </TouchableOpacity>

      <CreateModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => { setCreateOpen(false); load(); if (id) router.push(`/tournament/${id}` as any); }}
      />
      <JoinModal
        visible={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoined={(id) => { setJoinOpen(false); load(); router.push(`/tournament/${id}` as any); }}
      />
    </ScrollView>
  );
}

function Row({ t, c }: { t: any; c: (s: string) => string }) {
  return (
    <TouchableOpacity
      style={s.row}
      onPress={() => router.push(`/tournament/${t.tournament_id}` as any)}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <Text style={s.rowName}>{c(t.name)}</Text>
        <Text style={s.rowMeta}>
          {scoringLabel(t.scoring)}{t.handicap_adjusted ? ' · net' : ''} · {t.player_count ?? '?'} player{(t.player_count ?? 0) === 1 ? '' : 's'}
          {t.reset_period && t.reset_period !== 'none' ? ` · ${t.reset_period}` : ''}
        </Text>
        {t.join_code && t.owned ? (
          <Text style={s.rowCode}>Code: <Text style={{ fontFamily: F.mono, color: C.gold }}>{t.join_code}</Text></Text>
        ) : null}
      </View>
      <Text style={s.rowChev}>›</Text>
    </TouchableOpacity>
  );
}

function CreateModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (id?: string) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [scoring, setScoring] = useState<'best_round' | 'total_strokes'>('best_round');
  const [handicap, setHandicap] = useState(true);
  const [reset, setReset] = useState<'none' | 'weekly' | 'monthly'>('none');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Your league needs a name.'); return; }
    setSubmitting(true);
    try {
      const created = await api.tournaments.create({
        name: name.trim(),
        description: desc.trim() || undefined,
        scoring,
        leagueType: 'buddies',
        handicapAdjusted: handicap,
        resetPeriod: reset,
      });
      setName(''); setDesc('');
      onCreated(created?.tournament_id);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setSubmitting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView
        style={{ flex: 1, backgroundColor: C.bg }}
        contentContainerStyle={{ padding: 20, paddingTop: 28 }}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>New League</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>

        <Text style={s.label}>Name</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. Saturday Crew" placeholderTextColor={C.textMuted} maxLength={80} />

        <Text style={s.label}>Description (optional)</Text>
        <TextInput style={[s.input, { minHeight: 70 }]} value={desc} onChangeText={setDesc} placeholder="Buy-in, rules, whatever's on the line..." placeholderTextColor={C.textMuted} multiline maxLength={500} />

        <Text style={s.label}>How the season scores</Text>
        <ChipRow
          options={[
            ['best_round', 'Best round'],
            ['total_strokes', 'Every round'],
          ]}
          value={scoring}
          onChange={(v) => setScoring(v as any)}
        />
        <Text style={s.hint}>
          {scoring === 'best_round'
            ? 'Your single best round of the season counts. Play as much as you want, only your best shows.'
            : 'Every round you post adds to a running season total.'}
        </Text>

        <View style={s.switchRow}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={s.switchLabel}>Handicap-adjusted (net)</Text>
            <Text style={s.hint}>Subtract each player's handicap so all skill levels compete fairly. Recommended.</Text>
          </View>
          <Switch
            value={handicap} onValueChange={setHandicap}
            trackColor={{ true: C.gold + '88', false: C.border }}
            thumbColor={handicap ? C.gold : C.textMuted}
          />
        </View>

        <Text style={s.label}>Season cadence</Text>
        <ChipRow
          options={[
            ['none', 'One season'],
            ['weekly', 'Weekly'],
            ['monthly', 'Monthly'],
          ]}
          value={reset}
          onChange={(v) => setReset(v as any)}
        />
        <Text style={s.hint}>
          {reset === 'none'
            ? 'One ongoing season. Crown a champion whenever you want.'
            : `Auto-crowns a champion and resets the board every ${reset === 'weekly' ? 'week' : 'month'}.`}
        </Text>

        <TouchableOpacity style={[s.submitBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submit}>
          {submitting ? <ActivityIndicator color="#000" /> : <Text style={s.submitBtnText}>Create League</Text>}
        </TouchableOpacity>
        <Text style={[s.hint, { textAlign: 'center', marginTop: 12 }]}>
          Private by invite. You'll get a code to share once it's created.
        </Text>
      </ScrollView>
    </Modal>
  );
}

function JoinModal({ visible, onClose, onJoined }: { visible: boolean; onClose: () => void; onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (code.trim().length < 4) { Alert.alert('Code missing', 'Enter your league code.'); return; }
    setSubmitting(true);
    try {
      const res = await api.tournaments.joinByCode(code.trim().toUpperCase());
      setCode('');
      onJoined(res.tournament_id);
    } catch (e: any) {
      Alert.alert('Could not join', e.message);
    } finally { setSubmitting(false); }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 28 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>Join a League</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>
        <Text style={s.label}>League code</Text>
        <TextInput
          style={[s.input, { textAlign: 'center', fontSize: 22, fontFamily: F.mono, letterSpacing: 4 }]}
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABC123"
          placeholderTextColor={C.textMuted}
          maxLength={6}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <TouchableOpacity style={[s.submitBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submit}>
          {submitting ? <ActivityIndicator color="#000" /> : <Text style={s.submitBtnText}>Join</Text>}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ChipRow({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
      {options.map(([k, label]) => (
        <TouchableOpacity
          key={k}
          style={[s.chip, value === k && s.chipActive]}
          onPress={() => onChange(k)}
        >
          <Text style={[s.chipText, value === k && { color: '#000' }]}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function scoringLabel(sc: string) {
  switch (sc) {
    case 'best_round':    return 'Best round';
    case 'total_strokes': return 'Every round';
    case 'wins':          return 'Match wins';
    default:              return sc;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 4, lineHeight: 18 },

  actionBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.card,
  },
  actionText: { color: '#000', fontWeight: '900', fontSize: 14 },

  emptyBox: {
    backgroundColor: C.card, borderRadius: 10, padding: 22, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, marginTop: 12,
  },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 16, textAlign: 'center' },
  emptyBody: { color: C.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 6 },

  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  rowName: { color: C.text, fontWeight: '800', fontSize: 15 },
  rowMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  rowCode: { color: C.text, fontSize: 12, marginTop: 4 },
  rowChev: { color: C.textDim, fontSize: 22, marginLeft: 8 },

  browseRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    borderRadius: 8, padding: 14, marginTop: 18, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed',
  },
  browseTitle: { color: C.text, fontWeight: '800', fontSize: 14 },
  browseSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  modalTitle: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif, marginBottom: 6 },
  cancel: { color: C.textMuted, fontSize: 15 },
  label: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  hint: { color: C.textDim, fontSize: 11, lineHeight: 15, marginTop: 6 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    borderWidth: 1, borderColor: C.border, textAlignVertical: 'top',
  },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 18,
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 14,
  },
  switchLabel: { color: C.text, fontWeight: '800', fontSize: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  chipActive: { backgroundColor: C.gold, borderColor: C.gold },
  chipText: { color: C.text, fontWeight: '700', fontSize: 12 },

  submitBtn: { marginTop: 28, backgroundColor: C.gold, padding: 14, borderRadius: 8, alignItems: 'center' },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
});
