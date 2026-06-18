import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { Divider, OrnamentTitle } from '../components/Flourish';
import { UserAvatar } from '../components/UserAvatar';
import { useCensor } from '../lib/censor';

/**
 * Creator Leagues — the fan discovery surface. A creator league is a branded
 * tournament (reuses the whole tournaments engine) with a "beat the creator"
 * target. Fans browse open leagues, join with a tap / code / QR, and chase the
 * creator's standing score. Tapping a card opens the shared league detail at
 * /tournament/[id], which renders its creator branding + beat-the-creator UI.
 */

// Accent swatches a creator can brand their league with.
const ACCENTS = ['#d4a93f', '#e5484d', '#3ddc97', '#b06bff', '#7cc4ff', '#ff8a3a', '#ff2d95', '#00d9c4'];

function toParLabel(v: number | null | undefined): string {
  if (v == null) return '';
  const n = Math.round(Number(v));
  return n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`;
}

export default function CreatorLeaguesScreen() {
  const c = useCensor();
  const { user } = useAuth();
  // Hosting a creator league is gated to the approved-creator group (owners
  // count too). Everyone else can still browse + join.
  const canHost = !!((user as any)?.is_creator || (user as any)?.is_owner);
  const [leagues, setLeagues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const rows = await api.tournaments.creatorLeagues();
      setLeagues(Array.isArray(rows) ? rows : []);
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const join = async (id: string) => {
    setJoiningId(id);
    try {
      await api.tournaments.join(id);
      router.push(`/tournament/${id}` as any);
    } catch (e: any) {
      Alert.alert('Could not join', e?.message ?? 'Try again.');
    } finally { setJoiningId(null); }
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: 'Creator Leagues', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      <Text style={s.title}>Creator Leagues</Text>
      <Text style={s.sub}>Join a creator's league and chase their score. Beat the creator to earn their mark.</Text>
      <Divider style={{ marginTop: 4, marginBottom: 12 }} />

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: canHost ? 18 : 8 }}>
        {canHost && (
          <TouchableOpacity style={[s.actionBtn, { backgroundColor: C.gold }]} onPress={() => setCreateOpen(true)}>
            <Text style={[s.actionText, { color: '#000' }]}>+ Start a League</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.actionBtn} onPress={() => setJoinOpen(true)}>
          <Text style={[s.actionText, { color: C.text }]}>Join by Code</Text>
        </TouchableOpacity>
      </View>
      {!canHost && (
        <Text style={s.hostNote}>Hosting a league is for approved creators. Want in? Reach out to get set up.</Text>
      )}

      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 30 }} size="large" />
      ) : leagues.length === 0 ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>No creator leagues yet</Text>
          <Text style={s.emptyBody}>Start your own, or join one with a code a creator shared.</Text>
        </View>
      ) : (
        <>
          <OrnamentTitle title="Browse" />
          {leagues.map((l) => {
            const joined = !!l.joined || !!l.owned;
            const accent = l.accent_color || C.gold;
            return (
              <TouchableOpacity
                key={l.tournament_id}
                style={[s.card, { borderColor: accent + '88' }]}
                onPress={() => router.push(`/tournament/${l.tournament_id}` as any)}
                activeOpacity={0.85}
              >
                <View style={[s.accentBar, { backgroundColor: accent }]} />
                <View style={s.cardBody}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <UserAvatar username={l.owner_username} avatarUrl={l.owner_avatar_url} size={40} borderRadius={6} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.cardName} numberOfLines={1}>{c(l.name)}</Text>
                      <Text style={s.cardHost} numberOfLines={1}>by {c(l.owner_username)} · {l.player_count ?? 0} player{(l.player_count ?? 0) === 1 ? '' : 's'}</Text>
                    </View>
                    {joined ? (
                      <View style={[s.joinedPill, { borderColor: accent }]}><Text style={[s.joinedPillText, { color: accent }]}>JOINED</Text></View>
                    ) : (
                      <TouchableOpacity
                        style={[s.joinBtn, { backgroundColor: accent }]}
                        onPress={(e) => { e.stopPropagation?.(); join(l.tournament_id); }}
                        disabled={joiningId === l.tournament_id}
                      >
                        {joiningId === l.tournament_id
                          ? <ActivityIndicator color="#000" size="small" />
                          : <Text style={s.joinBtnText}>JOIN</Text>}
                      </TouchableOpacity>
                    )}
                  </View>
                  {l.tagline ? <Text style={s.cardTagline} numberOfLines={2}>{c(l.tagline)}</Text> : null}
                  {l.target_to_par != null && (
                    <View style={[s.beatRow, { backgroundColor: accent + '14', borderColor: accent + '55' }]}>
                      <Text style={[s.beatLabel, { color: accent }]}>BEAT THE CREATOR</Text>
                      <Text style={s.beatScore}>
                        {toParLabel(l.target_to_par)}{l.target_label ? ` · ${c(l.target_label)}` : ''}
                      </Text>
                      <Text style={s.beatCount}>{l.beaten_count ?? 0} done it</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </>
      )}

      <CreateLeagueModal visible={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); router.push(`/tournament/${id}` as any); }} />
      <JoinModal visible={joinOpen} onClose={() => setJoinOpen(false)} onJoined={(id) => { setJoinOpen(false); router.push(`/tournament/${id}` as any); }} />
    </ScrollView>
  );
}

function CreateLeagueModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [accent, setAccent] = useState(ACCENTS[0]);
  const [scoring, setScoring] = useState<'best_round' | 'total_strokes'>('best_round');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Your league needs a name.'); return; }
    setSubmitting(true);
    try {
      const t = await api.tournaments.create({
        name: name.trim(),
        tagline: tagline.trim() || undefined,
        accentColor: accent,
        scoring,
        isCreatorLeague: true,
        isOpen: true,
      });
      setName(''); setTagline('');
      onCreated(t.tournament_id);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Try again.');
    } finally { setSubmitting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 20, paddingTop: 28 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>Start a Creator League</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>

        <Text style={s.label}>League name</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. The Birdie Club" placeholderTextColor={C.textMuted} maxLength={80} />

        <Text style={s.label}>Tagline (optional)</Text>
        <TextInput style={s.input} value={tagline} onChangeText={setTagline} placeholder="One line your fans see" placeholderTextColor={C.textMuted} maxLength={120} />

        <Text style={s.label}>Accent color</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
          {ACCENTS.map((a) => (
            <TouchableOpacity key={a} onPress={() => setAccent(a)} style={[s.swatch, { backgroundColor: a }, accent === a && s.swatchActive]} />
          ))}
        </View>

        <Text style={s.label}>Scoring</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {([['best_round', 'Best Round'], ['total_strokes', 'Total Strokes']] as const).map(([k, lbl]) => (
            <TouchableOpacity key={k} style={[s.chip, scoring === k && s.chipActive]} onPress={() => setScoring(k)}>
              <Text style={[s.chipText, scoring === k && { color: '#000' }]}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.hint}>Best Round is the classic "beat my score" format. You set the score to beat from the league screen after you create it.</Text>

        <TouchableOpacity style={[s.submitBtn, { backgroundColor: accent }, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submit}>
          {submitting ? <ActivityIndicator color="#000" /> : <Text style={s.submitBtnText}>Create League</Text>}
        </TouchableOpacity>
      </ScrollView>
    </Modal>
  );
}

function JoinModal({ visible, onClose, onJoined }: { visible: boolean; onClose: () => void; onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (code.trim().length < 4) { Alert.alert('Code missing', 'Enter the league code.'); return; }
    setSubmitting(true);
    try {
      const res = await api.tournaments.joinByCode(code.trim().toUpperCase());
      setCode('');
      onJoined(res.tournament_id);
    } catch (e: any) {
      Alert.alert('Could not join', e?.message ?? 'Try again.');
    } finally { setSubmitting(false); }
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 28 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>Join a League</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>
        <Text style={s.label}>League code</Text>
        <TextInput
          style={[s.input, { textAlign: 'center', fontSize: 22, fontFamily: F.mono, letterSpacing: 4 }]}
          value={code} onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABC123" placeholderTextColor={C.textMuted}
          maxLength={6} autoCapitalize="characters" autoCorrect={false}
        />
        <Text style={s.hint}>Got a QR instead? Point your phone camera at it to jump straight in.</Text>
        <TouchableOpacity style={[s.submitBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submit}>
          {submitting ? <ActivityIndicator color="#000" /> : <Text style={s.submitBtnText}>Join</Text>}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 4, lineHeight: 18 },
  hostNote: { color: C.textDim, fontSize: 12, marginBottom: 16, lineHeight: 17 },

  actionBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: C.gold, backgroundColor: C.card },
  actionText: { fontWeight: '900', fontSize: 14 },

  emptyBox: { backgroundColor: C.card, borderRadius: 10, padding: 22, alignItems: 'center', borderWidth: 1, borderColor: C.border, marginTop: 20 },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 16 },
  emptyBody: { color: C.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 6 },

  card: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 10, marginBottom: 10, borderWidth: 1, overflow: 'hidden' },
  accentBar: { width: 5 },
  cardBody: { flex: 1, padding: 14 },
  cardName: { color: C.text, fontWeight: '900', fontSize: 16, fontFamily: F.serif },
  cardHost: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  cardTagline: { color: C.text, fontSize: 13, marginTop: 10, lineHeight: 18 },
  joinBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  joinBtnText: { color: '#000', fontWeight: '900', fontSize: 12 },
  joinedPill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 7, borderWidth: 1 },
  joinedPillText: { fontWeight: '900', fontSize: 11, letterSpacing: 1 },

  beatRow: { marginTop: 12, borderRadius: 8, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  beatLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  beatScore: { color: C.text, fontWeight: '900', fontSize: 14, fontFamily: F.serif, flex: 1 },
  beatCount: { color: C.textMuted, fontSize: 11, fontWeight: '700' },

  modalTitle: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif, marginBottom: 6 },
  cancel: { color: C.textMuted, fontSize: 15 },
  label: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 18, marginBottom: 6 },
  hint: { color: C.textDim, fontSize: 12, marginTop: 8, lineHeight: 17 },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, borderWidth: 1, borderColor: C.border, textAlignVertical: 'top' },
  swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { borderColor: C.text },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  chipActive: { backgroundColor: C.gold, borderColor: C.gold },
  chipText: { color: C.text, fontWeight: '700', fontSize: 12 },
  submitBtn: { marginTop: 28, backgroundColor: C.gold, padding: 14, borderRadius: 8, alignItems: 'center' },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
});
