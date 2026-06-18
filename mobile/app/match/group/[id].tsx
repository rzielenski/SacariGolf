/**
 * Organizer scoring — one person keeps score for a whole group on one device.
 * Casual only (the match is created as practice), so nothing here touches
 * ranked SR or handicap; an organizer typing the table's scores can't game
 * anything. Account players in the match get real (casual) rounds; everyone
 * else is a guest (name only). Each hole is committed to par by default and
 * adjusted as needed, then saved to the server, which drives the same live
 * leaderboard friends can spectate.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useCensor } from '../../../lib/censor';
import { C } from '../../../lib/colors';
import { LiveLeaderboard } from '../../../components/LiveLeaderboard';

interface PlayerRow { key: string; name: string; isAccount: boolean; user_id?: string }
type Scores = Record<string, number[]>;

function normalize(arr: any, n: number): number[] {
  const a = Array.isArray(arr) ? arr : [];
  return Array.from({ length: n }, (_, i) => (typeof a[i] === 'number' && a[i] > 0 ? a[i] : 0));
}

export default function GroupScoringScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const c = useCensor();

  const [loading, setLoading] = useState(true);
  const [numHoles, setNumHoles] = useState(18);
  const [pars, setPars] = useState<number[]>([]);
  const [courseName, setCourseName] = useState('Group Round');
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [scores, setScores] = useState<Scores>({});
  const [hole, setHole] = useState(0);
  const [newGuest, setNewGuest] = useState('');
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [guestSeq, setGuestSeq] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const m = await api.matches.get(id);
        if (m.completed) { router.replace(`/match/${id}` as any); return; }
        const N = m.num_holes ?? 18;
        setNumHoles(N);

        const accs: PlayerRow[] = (m.players ?? []).map((p: any) => ({
          key: p.user_id, name: p.username, isAccount: true, user_id: p.user_id,
        }));
        const gs: PlayerRow[] = (m.guest_players ?? []).map((g: any, i: number) => ({
          key: `g${i}`, name: g.name, isAccount: false,
        }));
        setPlayers([...accs, ...gs]);
        setGuestSeq(gs.length);

        const sc: Scores = {};
        for (const p of m.players ?? []) sc[p.user_id] = normalize(p.hole_scores, N);
        (m.guest_players ?? []).forEach((g: any, i: number) => { sc[`g${i}`] = normalize(g.scores, N); });
        setScores(sc);

        const me = (m.players ?? []).find((p: any) => p.user_id === user?.user_id) ?? (m.players ?? [])[0];
        setCourseName(me?.course_name ?? m.name ?? 'Group Round');
        if (me?.course_id && me?.teebox_id) {
          try {
            const course = await api.courses.get(me.course_id);
            const tb = (course.teeboxes ?? []).find((t: any) => t.teebox_id === me.teebox_id);
            const holes = (tb?.holes ?? []).slice().sort((a: any, b: any) => a.hole_num - b.hole_num);
            const off = m.holes_subset === 'back' ? 9 : 0;
            const sliced = holes.slice(off, off + N).map((h: any) => h.par ?? 4);
            setPars(sliced.length ? sliced : Array.from({ length: N }, () => 4));
          } catch { setPars(Array.from({ length: N }, () => 4)); }
        } else {
          setPars(Array.from({ length: N }, () => 4));
        }
      } catch (e: any) {
        Alert.alert('Error', e?.message ?? 'Could not load this round');
        router.back();
      } finally {
        setLoading(false);
      }
    })();
  }, [id, user?.user_id]);

  const par = pars[hole] ?? 4;
  const displayVal = (key: string) => {
    const v = scores[key]?.[hole] ?? 0;
    return v > 0 ? v : par;
  };
  const bump = (key: string, delta: number) => {
    setScores((prev) => {
      const arr = (prev[key] ?? Array.from({ length: numHoles }, () => 0)).slice();
      const cur = arr[hole] > 0 ? arr[hole] : par;
      arr[hole] = Math.max(1, Math.min(29, cur + delta));
      return { ...prev, [key]: arr };
    });
  };

  // Commit the current hole to par for anyone untouched, returning a fresh map.
  const commitHole = (sc: Scores, h: number): Scores => {
    const next: Scores = { ...sc };
    for (const p of players) {
      const arr = (next[p.key] ?? Array.from({ length: numHoles }, () => 0)).slice();
      if ((arr[h] ?? 0) === 0) arr[h] = pars[h] ?? 4;
      next[p.key] = arr;
    }
    return next;
  };

  const save = useCallback(async (finish: boolean, sc: Scores) => {
    const accounts = players
      .filter((p) => p.isAccount && p.user_id)
      .map((p) => ({ user_id: p.user_id as string, hole_scores: sc[p.key] ?? [] }));
    const guests = players
      .filter((p) => !p.isAccount)
      .map((p) => ({ name: p.name, scores: sc[p.key] ?? [] }));
    if (finish) setFinishing(true); else setBusy(true);
    try {
      await api.matches.organizerScores(id, { accounts, guests, finish });
      if (finish) router.replace(`/match/${id}` as any);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setBusy(false); setFinishing(false);
    }
  }, [players, id]);

  const goNext = async () => {
    const committed = commitHole(scores, hole);
    setScores(committed);
    await save(false, committed);
    setHole((h) => Math.min(numHoles - 1, h + 1));
  };
  const goPrev = async () => {
    await save(false, scores);
    setHole((h) => Math.max(0, h - 1));
  };
  const onFinish = () => {
    Alert.alert('Finish round?', 'This locks in the scorecard for everyone.', [
      { text: 'Keep scoring', style: 'cancel' },
      {
        text: 'Finish', style: 'destructive',
        onPress: () => { const committed = commitHole(scores, hole); setScores(committed); save(true, committed); },
      },
    ]);
  };

  const addGuest = () => {
    const name = newGuest.trim().slice(0, 30);
    if (!name) return;
    const key = `g${guestSeq}`;
    setGuestSeq((n) => n + 1);
    setPlayers((prev) => [...prev, { key, name, isAccount: false }]);
    setScores((prev) => ({ ...prev, [key]: Array.from({ length: numHoles }, () => 0) }));
    setNewGuest('');
  };

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  const isLast = hole >= numHoles - 1;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, paddingBottom: 48 }}>
        <TouchableOpacity onPress={() => router.replace(`/match/${id}` as any)} style={{ marginBottom: 8 }}>
          <Text style={{ color: C.gold, fontSize: 16 }}>← Leave (autosaved)</Text>
        </TouchableOpacity>
        <Text style={s.course}>{courseName}</Text>

        {/* Hole header */}
        <View style={s.holeHead}>
          <TouchableOpacity onPress={goPrev} disabled={hole === 0 || busy} style={[s.navBtn, hole === 0 && { opacity: 0.3 }]}>
            <Text style={s.navTxt}>‹</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={s.holeNum}>Hole {hole + 1}</Text>
            <Text style={s.holePar}>Par {par} · {numHoles} holes</Text>
          </View>
          <TouchableOpacity onPress={goNext} disabled={isLast || busy} style={[s.navBtn, isLast && { opacity: 0.3 }]}>
            <Text style={s.navTxt}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Per-player steppers for this hole */}
        {players.map((p) => {
          const v = displayVal(p.key);
          const rel = v - par;
          const relColor = rel < 0 ? C.green : rel > 0 ? C.red : C.textMuted;
          return (
            <View key={p.key} style={s.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{c(p.name)}</Text>
                <Text style={s.tag}>{p.isAccount ? 'Sacari' : 'Guest'}</Text>
              </View>
              <TouchableOpacity style={s.step} onPress={() => bump(p.key, -1)}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
              <View style={s.scoreBox}>
                <Text style={s.score}>{v}</Text>
                <Text style={[s.rel, { color: relColor }]}>{rel === 0 ? 'par' : rel > 0 ? `+${rel}` : `${rel}`}</Text>
              </View>
              <TouchableOpacity style={s.step} onPress={() => bump(p.key, +1)}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
            </View>
          );
        })}

        {/* Add a guest */}
        <View style={s.addRow}>
          <TextInput
            style={s.addInput}
            value={newGuest}
            onChangeText={setNewGuest}
            placeholder="Add a player by name…"
            placeholderTextColor={C.textMuted}
            maxLength={30}
            returnKeyType="done"
            onSubmitEditing={addGuest}
          />
          <TouchableOpacity style={s.addBtn} onPress={addGuest}><Text style={s.addBtnTxt}>Add</Text></TouchableOpacity>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          {!isLast ? (
            <TouchableOpacity style={[s.primary, { flex: 1 }]} onPress={goNext} disabled={busy}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryTxt}>Save · Next hole →</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[s.primary, { flex: 1 }]} onPress={onFinish} disabled={finishing}>
              {finishing ? <ActivityIndicator color="#000" /> : <Text style={s.primaryTxt}>Finish round</Text>}
            </TouchableOpacity>
          )}
        </View>
        {isLast && (
          <Text style={s.finishHint}>You can still go back to fix a hole before finishing.</Text>
        )}

        {/* Live standings — updates as you save each hole */}
        <Text style={s.lbTitle}>LIVE LEADERBOARD</Text>
        <LiveLeaderboard matchId={id} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  course: { color: C.text, fontSize: 22, fontWeight: '900', marginBottom: 14 },
  holeHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16,
    borderWidth: 1, borderColor: C.border, marginBottom: 14,
  },
  navBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  navTxt: { color: C.gold, fontSize: 26, fontWeight: '900', lineHeight: 28 },
  holeNum: { color: C.text, fontSize: 18, fontWeight: '900' },
  holePar: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  tag: { color: C.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 2 },
  step: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  stepTxt: { color: C.gold, fontSize: 24, fontWeight: '900', lineHeight: 26 },
  scoreBox: { width: 52, alignItems: 'center' },
  score: { color: C.text, fontSize: 22, fontWeight: '900' },
  rel: { fontSize: 10, fontWeight: '800', marginTop: 1 },
  addRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  addInput: { flex: 1, backgroundColor: C.card, color: C.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, borderWidth: 1, borderColor: C.border },
  addBtn: { paddingHorizontal: 18, justifyContent: 'center', borderRadius: 10, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  addBtnTxt: { color: C.gold, fontWeight: '800' },
  primary: { backgroundColor: C.gold, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  primaryTxt: { color: '#000', fontWeight: '900', fontSize: 16 },
  finishHint: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 8 },
  lbTitle: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, marginTop: 24, marginBottom: 8 },
});
