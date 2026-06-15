/**
 * Mark / correct tee-box coordinates for every hole of a course.
 *
 * Mirrors the pin-placement screen, with one key difference: a tee box is
 * specific to ONE teebox set (Black tees and Red tees start in different
 * places), so you pick a teebox first, then tap the map to drop that teebox's
 * tee marker for each hole. Pins (greens) are shared across tees; tees are not.
 *
 * Open to any authenticated player — last-write-wins crowdsourcing. The tee
 * coords power the Course Preview (tee→green per hole). No need to mark tees
 * during a round — the app infers them from your tracked first shots.
 *
 * On Save → POSTs to /courses/admin/set-teeboxes for the selected teebox.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, ScrollView,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../../lib/api';
import { C } from '../../../lib/colors';

type Tee = { lat: number; lng: number };
type HoleRow = { hole_num: number; par: number; tee_lat?: number | null; tee_lng?: number | null };

export default function PlaceTeesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [teeboxId, setTeeboxId] = useState<string | null>(null);
  const [tees, setTees] = useState<Record<number, Tee>>({});
  const [serverTees, setServerTees] = useState<Record<number, Tee>>({});
  const [currentHole, setCurrentHole] = useState(1);

  // Seed the local working copy from a teebox's stored tee coords.
  const seedFromTeebox = (teebox: any) => {
    const seeded: Record<number, Tee> = {};
    for (const h of (teebox?.holes ?? []) as HoleRow[]) {
      if (typeof h.tee_lat === 'number' && typeof h.tee_lng === 'number') {
        seeded[h.hole_num] = { lat: h.tee_lat, lng: h.tee_lng };
      }
    }
    setTees(seeded);
    setServerTees({ ...seeded });
    setCurrentHole(1);
  };

  useEffect(() => {
    (async () => {
      try {
        const c = await api.courses.get(id);
        setCourse(c);
        const list = (c?.teeboxes ?? []) as any[];
        const widest = [...list].sort((a, b) => (b?.holes?.length ?? 0) - (a?.holes?.length ?? 0))[0];
        if (widest) {
          setTeeboxId(widest.teebox_id);
          seedFromTeebox(widest);
        }
      } catch (e: any) {
        Alert.alert('Error', e?.message ?? 'Could not load course');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const teeboxes = (course?.teeboxes ?? []) as any[];
  const selectedTeebox = useMemo(
    () => teeboxes.find((t) => t.teebox_id === teeboxId) ?? null,
    [teeboxes, teeboxId],
  );
  const holes = useMemo<HoleRow[]>(() => {
    const listForBox = (selectedTeebox?.holes ?? []) as HoleRow[];
    return [...listForBox].sort((a, b) => a.hole_num - b.hole_num);
  }, [selectedTeebox]);

  const initialRegion: Region | null = useMemo(() => {
    if (!course) return null;
    const lat = Number(course.latitude);
    const lng = Number(course.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng, latitudeDelta: 0.012, longitudeDelta: 0.012 };
  }, [course]);

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(tees), ...Object.keys(serverTees)]);
    for (const k of keys) {
      const a = tees[Number(k)];
      const b = serverTees[Number(k)];
      if (!a || !b) return true;
      if (a.lat !== b.lat || a.lng !== b.lng) return true;
    }
    return false;
  }, [tees, serverTees]);

  const switchTeebox = (tb: any) => {
    if (tb.teebox_id === teeboxId) return;
    const go = () => { setTeeboxId(tb.teebox_id); seedFromTeebox(tb); };
    if (dirty) {
      Alert.alert('Discard changes?', 'You have unsaved tee positions for this teebox. Switching will discard them.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: go },
      ]);
    } else { go(); }
  };

  const handleMapPress = (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    setTees((prev) => ({ ...prev, [currentHole]: { lat: latitude, lng: longitude } }));
    if (currentHole < holes.length) setCurrentHole(currentHole + 1);
  };

  const handleSave = async () => {
    if (!teeboxId) return;
    if (!dirty) { Alert.alert('No changes', 'Tap a teebox on the map to place or move a marker.'); return; }
    setSaving(true);
    try {
      const payload = Object.keys(tees)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((holeNum) => ({ holeNum, lat: tees[holeNum].lat, lng: tees[holeNum].lng }));
      const res = await api.courses.setTeeboxes(teeboxId, payload);
      if (res.missing_hole_nums?.length) {
        Alert.alert('Partial save', `Saved ${res.updated}. No matching rows for holes: ${res.missing_hole_nums.join(', ')}.`);
      } else {
        Alert.alert('Saved', `Updated ${res.updated} tee${res.updated === 1 ? '' : 's'} for the ${selectedTeebox?.name} tees. Thanks!`);
      }
      setServerTees({ ...tees });
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearHole = () => {
    if (!tees[currentHole]) return;
    setTees((prev) => { const next = { ...prev }; delete next[currentHole]; return next; });
  };

  if (loading) {
    return <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>;
  }
  if (!course || !initialRegion) {
    return (
      <View style={s.centered}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}><Text style={s.backText}>← Back</Text></TouchableOpacity>
        <Text style={s.muted}>Course is missing coordinates — can't place tees.</Text>
      </View>
    );
  }

  const placedCount = Object.keys(tees).length;

  return (
    <View style={s.container}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}><Text style={s.backText}>← Back</Text></TouchableOpacity>
        <View style={s.titleWrap}>
          <Text style={s.title}>Mark Tee Boxes</Text>
          <Text style={s.subtitle} numberOfLines={1}>{course.course_name}</Text>
        </View>
        <Text style={s.counter}>{placedCount}/{holes.length}</Text>
      </View>

      {/* Teebox picker — tees are per teebox */}
      <View style={s.teeboxStripWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.teeboxStrip}>
          {teeboxes.map((tb) => {
            const active = tb.teebox_id === teeboxId;
            return (
              <TouchableOpacity
                key={tb.teebox_id}
                style={[s.teeboxChip, active && s.teeboxChipActive]}
                onPress={() => switchTeebox(tb)}
              >
                <Text style={[s.teeboxChipName, active && s.teeboxChipNameActive]}>{tb.name}</Text>
                <Text style={[s.teeboxChipMeta, active && s.teeboxChipMetaActive]}>{tb.num_holes}h</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Map */}
      <MapView style={s.map} initialRegion={initialRegion} mapType="satellite" showsCompass onPress={handleMapPress}>
        {Object.keys(tees).map((k) => {
          const num = Number(k);
          const p = tees[num];
          const isCurrent = num === currentHole;
          return (
            <Marker
              key={`t-${num}`}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
              onPress={() => setCurrentHole(num)}
            >
              <View style={[s.tee, isCurrent && s.teeActive]}>
                <Text style={[s.teeText, isCurrent && s.teeTextActive]}>{num}</Text>
              </View>
            </Marker>
          );
        })}
      </MapView>

      {/* Hole strip */}
      <View style={s.holeStripWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.holeStrip}>
          {holes.map((h) => {
            const placed = !!tees[h.hole_num];
            const isCurrent = h.hole_num === currentHole;
            return (
              <TouchableOpacity
                key={h.hole_num}
                style={[s.holeChip, placed && s.holeChipPlaced, isCurrent && s.holeChipActive]}
                onPress={() => setCurrentHole(h.hole_num)}
              >
                <Text style={[s.holeChipNum, isCurrent && s.holeChipNumActive]}>{h.hole_num}</Text>
                <Text style={[s.holeChipPar, isCurrent && s.holeChipParActive]}>P{h.par}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Footer */}
      <View style={s.footer}>
        <Text style={s.hint}>
          {tees[currentHole]
            ? `Hole ${currentHole}: placed. Tap map to move, or pick another hole.`
            : `Hole ${currentHole}: tap the tee box on the map for the ${selectedTeebox?.name ?? ''} tees.`}
        </Text>
        <View style={s.btnRow}>
          {tees[currentHole] && (
            <TouchableOpacity style={s.clearBtn} onPress={handleClearHole}>
              <Text style={s.clearBtnText}>Clear hole {currentHole}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.saveBtn, (!dirty || saving) && { opacity: 0.5 }]}
            onPress={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? <ActivityIndicator color="#000" /> : <Text style={s.saveBtnText}>Save {dirty ? '•' : ''}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, backgroundColor: C.bg },
  muted: { color: C.textMuted, marginTop: 12, textAlign: 'center' },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 56, paddingHorizontal: 16, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg,
  },
  backBtn: { paddingRight: 8 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { color: C.text, fontWeight: '900', fontSize: 16 },
  subtitle: { color: C.textMuted, fontSize: 11, marginTop: 1 },
  counter: { color: C.gold, fontWeight: '900', fontSize: 13, minWidth: 50, textAlign: 'right' },

  teeboxStripWrap: { borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg },
  teeboxStrip: { padding: 8, gap: 6 },
  teeboxChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: 'center',
  },
  teeboxChipActive: { borderColor: C.gold, backgroundColor: C.gold },
  teeboxChipName: { color: C.text, fontWeight: '800', fontSize: 13 },
  teeboxChipNameActive: { color: C.bg },
  teeboxChipMeta: { color: C.textMuted, fontSize: 9, marginTop: 1 },
  teeboxChipMetaActive: { color: C.bg + 'cc' },

  map: { flex: 1 },

  tee: {
    width: 26, height: 26, borderRadius: 6,
    backgroundColor: '#4da3ff' + 'cc', borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3,
  },
  teeActive: { backgroundColor: C.red, transform: [{ scale: 1.15 }] },
  teeText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  teeTextActive: { color: '#fff' },

  holeStripWrap: { borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  holeStrip: { padding: 10, gap: 6 },
  holeChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: 'center', minWidth: 42,
  },
  holeChipPlaced: { borderColor: '#4da3ff88', backgroundColor: '#4da3ff11' },
  holeChipActive: { borderColor: C.gold, backgroundColor: C.gold },
  holeChipNum: { color: C.text, fontWeight: '900', fontSize: 13 },
  holeChipNumActive: { color: C.bg },
  holeChipPar: { color: C.textMuted, fontSize: 9, marginTop: 1 },
  holeChipParActive: { color: C.bg + 'cc' },

  footer: {
    paddingHorizontal: 14, paddingVertical: 12, paddingBottom: 24,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
  },
  hint: { color: C.textMuted, fontSize: 12, marginBottom: 10, textAlign: 'center' },
  btnRow: { flexDirection: 'row', gap: 10 },
  clearBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.red, backgroundColor: C.red + '22', alignItems: 'center',
  },
  clearBtnText: { color: C.red, fontWeight: '700', fontSize: 13 },
  saveBtn: { flex: 2, paddingVertical: 12, borderRadius: 6, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' },
  saveBtnText: { color: '#000', fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
});
