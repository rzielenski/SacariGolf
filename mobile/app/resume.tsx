/**
 * Resume-round picker.
 *
 * Lists every match the player is in that's still open (not completed,
 * not cancelled) so they can pick which one to continue. Tap a row → the
 * match detail screen, which is the existing scoring entry point.
 *
 * The list endpoint (GET /matches) doesn't carry course / teebox info on
 * each row — that data lives nested in /matches/:id. For a small set of
 * active matches we fan those out in parallel so each row can show the
 * course, tee set, and hole-by-hole progress (so the player can pick the
 * right round if they have several going at once).
 *
 * Entry points:
 *   • Home-tab Resume chip
 *   • Play-tab "you have rounds in progress" banner
 *   • Future: notification deep-links
 */

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Stack, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

type ActiveMatch = {
  match_id: string;
  match_type: string;
  created_at: string;
  num_holes?: number;
  course_name?: string | null;
  teebox_name?: string | null;
  // Holes already scored — pulled from the in-flight scoring's AsyncStorage
  // entry. Optional: a match with no local scoring yet just shows "Just
  // started".
  holes_played?: number;
};

export default function ResumeRoundScreen() {
  const { user } = useAuth();
  const [matches, setMatches] = useState<ActiveMatch[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const list = await api.matches.list();
      const actives = (Array.isArray(list) ? list : [])
        .filter((m: any) => !m.completed && !m.cancelled);

      // Fan out detail fetches so each row can show course + teebox.
      // Errors per-row are swallowed so one stale match_id can't blank
      // the whole list.
      const detailed = await Promise.all(actives.map(async (m: any) => {
        let course_name: string | null = null;
        let teebox_name: string | null = null;
        let num_holes: number | undefined = undefined;
        try {
          const d = await api.matches.get(m.match_id);
          num_holes = d?.num_holes;
          // Pull THIS user's player row to find their teebox + course.
          const mine = (d?.players ?? []).find((p: any) => p.user_id === user?.user_id);
          if (mine) {
            course_name = mine.course_name ?? null;
            teebox_name = mine.teebox_name ?? null;
          }
        } catch { /* per-row failure is silent */ }

        // Local scoring progress — written by the scoring screen on "Save
        // & Leave". Lets us show "Hole 7 of 18" instead of just a date.
        let holes_played: number | undefined;
        try {
          const raw = await AsyncStorage.getItem(`scores_${user?.user_id ?? 'anon'}_${m.match_id}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.scores)) {
              holes_played = parsed.scores.filter((s: any) => Number.isFinite(s) && s > 0).length;
            }
          }
        } catch { /* unparseable → just skip */ }

        return {
          match_id: m.match_id,
          match_type: m.match_type,
          created_at: m.created_at,
          num_holes,
          course_name,
          teebox_name,
          holes_played,
        } as ActiveMatch;
      }));

      setMatches(detailed);
    } catch { setMatches([]); }
    finally { setRefreshing(false); }
  }, [user?.user_id]);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Resume a Round',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      {matches === null ? (
        <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : matches.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyTitle}>No rounds in progress</Text>
          <Text style={s.emptySub}>
            Start one from the Play tab and it&apos;ll show up here if you
            need to step away.
          </Text>
          <TouchableOpacity style={s.startBtn} onPress={() => router.replace('/(tabs)/play' as any)}>
            <Text style={s.startBtnText}>Start a Round →</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
        >
          <Text style={s.intro}>
            Pick the round you want to continue. Tap any card to jump back
            into scoring.
          </Text>
          {matches.map((m) => (
            <TouchableOpacity
              key={m.match_id}
              style={s.card}
              onPress={() => router.push(`/match/${m.match_id}` as any)}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.cardCourse} numberOfLines={1}>
                  {m.course_name ?? 'Match in progress'}
                </Text>
                <Text style={s.cardMeta} numberOfLines={1}>
                  {[
                    m.teebox_name && `${m.teebox_name} tees`,
                    matchTypeLabel(m.match_type),
                    holeProgress(m),
                  ].filter(Boolean).join(' · ')}
                </Text>
                <Text style={s.cardDate}>{fmtDate(m.created_at)}</Text>
              </View>
              <Text style={s.cardChev}>›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function holeProgress(m: ActiveMatch): string {
  if (m.holes_played != null && m.num_holes) {
    return `Hole ${Math.min(m.holes_played + 1, m.num_holes)} of ${m.num_holes}`;
  }
  if (m.num_holes) return `${m.num_holes} holes`;
  return 'Just started';
}

function matchTypeLabel(t: string): string {
  switch (t) {
    case 'solo':     return '1v1';
    case 'duo':      return '2v2';
    case 'squad':    return '4v4';
    case 'ffa':      return 'Arena';
    case 'practice': return 'Practice';
    default:         return t.toUpperCase();
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Started today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now.getTime() - 86400 * 1000);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Started yesterday`;
  }
  return `Started ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  intro: { color: C.textMuted, fontSize: 13, marginBottom: 16, lineHeight: 18 },
  emptyTitle: { color: C.text, fontSize: 18, fontWeight: '900', marginBottom: 6 },
  emptySub: { color: C.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  startBtn: {
    marginTop: 24, paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: 8, backgroundColor: C.gold,
  },
  startBtnText: { color: C.bg, fontWeight: '900', letterSpacing: 0.5 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: C.gold + '55',
    marginBottom: 10,
  },
  cardCourse: { color: C.text, fontSize: 16, fontWeight: '800', fontFamily: F.serif },
  cardMeta: { color: C.gold, fontSize: 12, fontWeight: '700', marginTop: 4 },
  cardDate: { color: C.textMuted, fontSize: 11, marginTop: 4 },
  cardChev: { color: C.gold, fontSize: 26, fontWeight: '300', paddingHorizontal: 8 },
});
