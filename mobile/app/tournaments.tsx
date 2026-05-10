import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, RefreshControl,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { Divider, OrnamentTitle } from '../components/Flourish';

/**
 * Tournaments dashboard. Lists tournaments the player is in (owned or
 * joined), surfaces a "Join by code" entry, and lets them create a new one.
 *
 * Tap a row → navigate to /tournaments/[id] for the leaderboard view.
 */
export default function TournamentsScreen() {
  const [mine, setMine] = useState<any[]>([]);
  const [discover, setDiscover] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [m, d] = await Promise.all([api.tournaments.list(), api.tournaments.discover()]);
      setMine(Array.isArray(m) ? m : []);
      setDiscover(Array.isArray(d) ? d : []);
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
      <Stack.Screen options={{ title: 'Tournaments', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      <Text style={s.title}>Tournaments</Text>
      <Text style={s.sub}>Recurring leaderboards across multiple rounds.</Text>
      <Divider style={{ marginTop: 4, marginBottom: 12 }} />

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
        <TouchableOpacity style={[s.actionBtn, { backgroundColor: C.gold }]} onPress={() => setCreateOpen(true)}>
          <Text style={s.actionText}>+ Create</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={() => setJoinOpen(true)}>
          <Text style={[s.actionText, { color: C.text }]}>Join by Code</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 30 }} size="large" />
      ) : mine.length === 0 ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>No tournaments yet</Text>
          <Text style={s.emptyBody}>Create one for your golf group, or join one with a code your friends sent.</Text>
        </View>
      ) : (
        <>
          <OrnamentTitle title="Mine" />
          {mine.map((t) => <Row key={t.tournament_id} t={t} />)}
        </>
      )}

      {discover.length > 0 && (
        <>
          <OrnamentTitle title="Open to Join" />
          {discover.map((t) => (
            <Row
              key={t.tournament_id}
              t={t}
              cta="JOIN"
              onCtaPress={async () => {
                try {
                  await api.tournaments.join(t.tournament_id);
                  await load();
                } catch (e: any) { Alert.alert('Could not join', e.message); }
              }}
            />
          ))}
        </>
      )}

      <CreateModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); load(); }}
      />
      <JoinModal
        visible={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoined={(id) => {
          setJoinOpen(false);
          load();
          router.push(`/tournament/${id}` as any);
        }}
      />
    </ScrollView>
  );
}

function Row({ t, cta, onCtaPress }: { t: any; cta?: string; onCtaPress?: () => void }) {
  const ends = t.ends_at ? new Date(t.ends_at) : null;
  const endsLabel = ends ? `ends ${ends.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'open-ended';
  return (
    <TouchableOpacity
      style={s.row}
      onPress={() => router.push(`/tournament/${t.tournament_id}` as any)}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <Text style={s.rowName}>{t.name}</Text>
        <Text style={s.rowMeta}>
          {scoringLabel(t.scoring)} · {formatLabel(t.format)} · {t.player_count ?? '?'} player{(t.player_count ?? 0) === 1 ? '' : 's'} · {endsLabel}
        </Text>
        {t.join_code && t.owned ? (
          <Text style={s.rowCode}>Code: <Text style={{ fontFamily: F.mono, color: C.gold }}>{t.join_code}</Text></Text>
        ) : null}
      </View>
      {cta ? (
        <TouchableOpacity style={s.rowCta} onPress={(e) => { e.stopPropagation?.(); onCtaPress?.(); }}>
          <Text style={s.rowCtaText}>{cta}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={s.rowChev}>›</Text>
      )}
    </TouchableOpacity>
  );
}

function CreateModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [scoring, setScoring] = useState<'best_round' | 'total_strokes' | 'wins'>('best_round');
  const [format, setFormat] = useState<'stroke' | 'stableford' | 'match_play' | 'skins'>('stroke');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Tournament needs a name.'); return; }
    setSubmitting(true);
    try {
      await api.tournaments.create({
        name: name.trim(),
        description: desc.trim() || undefined,
        scoring, format,
      });
      setName(''); setDesc('');
      onCreated();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setSubmitting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 20, paddingTop: 28 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>New Tournament</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>

        <Text style={s.label}>Name</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. Tuesday Night League" placeholderTextColor={C.textMuted} maxLength={80} />

        <Text style={s.label}>Description (optional)</Text>
        <TextInput style={[s.input, { minHeight: 70 }]} value={desc} onChangeText={setDesc} placeholder="Rules, dates, prizes..." placeholderTextColor={C.textMuted} multiline maxLength={500} />

        <Text style={s.label}>Scoring</Text>
        <ChipRow
          options={[
            ['best_round', 'Best Round'],
            ['total_strokes', 'Total Strokes'],
            ['wins', 'Match Wins'],
          ]}
          value={scoring}
          onChange={(v) => setScoring(v as any)}
        />

        <Text style={s.label}>Default Format</Text>
        <ChipRow
          options={[
            ['stroke', 'Stroke'],
            ['stableford', 'Stableford'],
            ['match_play', 'Match Play'],
            ['skins', 'Skins'],
          ]}
          value={format}
          onChange={(v) => setFormat(v as any)}
        />

        <TouchableOpacity style={[s.submitBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submit}>
          {submitting ? <ActivityIndicator color="#000" /> : <Text style={s.submitBtnText}>Create Tournament</Text>}
        </TouchableOpacity>
      </ScrollView>
    </Modal>
  );
}

function JoinModal({ visible, onClose, onJoined }: { visible: boolean; onClose: () => void; onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (code.trim().length < 4) { Alert.alert('Code missing', 'Enter your tournament code.'); return; }
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
      <View style={{ flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 28 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>Join Tournament</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>
        <Text style={s.label}>Tournament code</Text>
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
      </View>
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

function scoringLabel(s: string) {
  switch (s) {
    case 'best_round':    return 'Best Round';
    case 'total_strokes': return 'Total Strokes';
    case 'wins':          return 'Match Wins';
    case 'points':        return 'Points';
    default:              return s;
  }
}
function formatLabel(f: string) {
  switch (f) {
    case 'stroke':     return 'Stroke';
    case 'stableford': return 'Stableford';
    case 'match_play': return 'Match Play';
    case 'skins':      return 'Skins';
    case 'scramble':   return 'Scramble';
    default:           return f;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 4 },

  actionBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.card,
  },
  actionText: { color: '#000', fontWeight: '900', fontSize: 14 },

  emptyBox: {
    backgroundColor: C.card, borderRadius: 10, padding: 22, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, marginTop: 20,
  },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 16 },
  emptyBody: { color: C.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 6 },

  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  rowName: { color: C.text, fontWeight: '800', fontSize: 15 },
  rowMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  rowCode: { color: C.text, fontSize: 12, marginTop: 4 },
  rowChev: { color: C.textDim, fontSize: 22, marginLeft: 8 },
  rowCta: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6,
    backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold,
  },
  rowCtaText: { color: C.gold, fontWeight: '900', fontSize: 12 },

  modalTitle: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif, marginBottom: 6 },
  cancel: { color: C.textMuted, fontSize: 15 },
  label: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    borderWidth: 1, borderColor: C.border, textAlignVertical: 'top',
  },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  chipActive: { backgroundColor: C.gold, borderColor: C.gold },
  chipText: { color: C.text, fontWeight: '700', fontSize: 12 },

  submitBtn: { marginTop: 28, backgroundColor: C.gold, padding: 14, borderRadius: 8, alignItems: 'center' },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
});
