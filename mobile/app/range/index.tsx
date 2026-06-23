/**
 * The Grind — practice home. Three modes (Range Sesh, Putting Sesh, Review
 * Sesh) plus a lifetime total-shots banner and recent practice sessions.
 *   • Range / Putting Sesh → /range/sesh?kind=… (live counter + metronome)
 *   • Review Sesh          → /range/review     (record/import + slow-mo + draw)
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { C, F } from '../../lib/colors';
import { api } from '../../lib/api';

type Summary = { total_shots: number; range_shots: number; putting_shots: number; session_count: number };
type Sesh = { session_id: string; kind: 'range' | 'putting'; shots: number; duration_s: number; bpm: number | null; created_at: string };

const MODES = [
  { key: 'range',   title: 'Range Sesh',   sub: 'Auto-count contact + metronome', icon: 'golf',            href: '/range/sesh?kind=range' },
  { key: 'putting', title: 'Putting Sesh', sub: 'Auto-count putts + metronome',   icon: 'ellipse-outline', href: '/range/sesh?kind=putting' },
  { key: 'review',  title: 'Review Sesh',  sub: 'Record, slow-mo + draw on swings', icon: 'videocam',      href: '/range/review' },
] as const;

export default function TheGrind() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<Sesh[] | null>(null);

  const reload = useCallback(() => {
    api.practice.summary().then(setSummary).catch(() => { });
    api.practice.sessions().then(setSessions).catch(() => setSessions([]));
  }, []);
  // Refresh whenever the hub regains focus (e.g. after finishing a sesh).
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'The Grind', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>The Grind</Text>
        <Text style={s.sub}>Put in the reps. Every shot you log here counts toward your lifetime total.</Text>

        <View style={s.banner}>
          <Text style={s.bannerNum}>{summary ? summary.total_shots.toLocaleString() : '—'}</Text>
          <Text style={s.bannerLabel}>TOTAL SHOTS HIT</Text>
          {summary && (summary.range_shots > 0 || summary.putting_shots > 0) && (
            <Text style={s.bannerBreak}>
              {summary.range_shots.toLocaleString()} range · {summary.putting_shots.toLocaleString()} putts
            </Text>
          )}
        </View>

        {MODES.map((m) => (
          <TouchableOpacity key={m.key} style={s.modeCard} onPress={() => router.push(m.href as any)} activeOpacity={0.85}>
            <View style={s.modeIcon}><Ionicons name={m.icon as any} size={22} color={C.gold} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.modeTitle}>{m.title}</Text>
              <Text style={s.modeSub}>{m.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={C.textDim} />
          </TouchableOpacity>
        ))}

        <Text style={s.section}>RECENT SESSIONS</Text>
        {sessions === null ? (
          <ActivityIndicator color={C.gold} style={{ marginTop: 16 }} />
        ) : sessions.length === 0 ? (
          <Text style={s.empty}>No sessions yet. Start a Range or Putting sesh above.</Text>
        ) : (
          sessions.map((x) => (
            <View key={x.session_id} style={s.seshRow}>
              <View style={[s.seshDot, x.kind === 'putting' && { backgroundColor: C.green + '22', borderColor: C.green }]}>
                <Ionicons name={x.kind === 'putting' ? 'ellipse-outline' : 'golf'} size={16} color={x.kind === 'putting' ? C.green : C.gold} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.seshTitle}>{x.shots} {x.kind === 'putting' ? 'putts' : 'shots'}</Text>
                <Text style={s.seshMeta}>
                  {new Date(x.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {x.duration_s > 0 ? ` · ${Math.max(1, Math.round(x.duration_s / 60))}m` : ''}
                  {x.bpm ? ` · ${x.bpm} bpm` : ''}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  title: { color: C.text, fontFamily: F.serif, fontSize: 28, fontWeight: '900', marginBottom: 6 },
  sub: { color: C.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 20 },

  banner: {
    backgroundColor: C.gold + '14', borderColor: C.gold, borderWidth: 1, borderRadius: 14,
    paddingVertical: 22, alignItems: 'center', marginBottom: 22,
  },
  bannerNum: { color: C.gold, fontSize: 52, fontWeight: '900', fontFamily: F.serif, lineHeight: 56 },
  bannerLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginTop: 2 },
  bannerBreak: { color: C.textMuted, fontSize: 12, marginTop: 8, fontWeight: '600' },

  modeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 10,
    padding: 16, marginBottom: 10,
  },
  modeIcon: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: C.gold + '1c',
    borderWidth: 1, borderColor: C.gold + '55', alignItems: 'center', justifyContent: 'center',
  },
  modeTitle: { color: C.text, fontSize: 16, fontWeight: '900' },
  modeSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  section: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 22, marginBottom: 10 },
  empty: { color: C.textMuted, fontSize: 12, fontStyle: 'italic' },
  seshRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 8,
  },
  seshDot: {
    width: 36, height: 36, borderRadius: 8, backgroundColor: C.gold + '22',
    borderWidth: 1, borderColor: C.gold, alignItems: 'center', justifyContent: 'center',
  },
  seshTitle: { color: C.text, fontSize: 14, fontWeight: '800' },
  seshMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
});
