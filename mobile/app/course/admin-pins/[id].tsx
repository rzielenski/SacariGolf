/**
 * Place / correct pin (cup) coordinates for every hole of a course remotely.
 *
 * Open to any authenticated player — last-write-wins crowdsourcing. Same
 * satellite-map UX as the in-match course-map: tap a green to drop the pin
 * for the currently-selected hole, then auto-advance to the next hole. Tap
 * an existing pin to re-select that hole and reposition it.
 *
 * On Save → POSTs all placed pins to /courses/admin/set-pins. The URL still
 * says "admin" for legacy compatibility but the endpoint is now ungated.
 * Server stamps `pin_set_by` with the contributing user so we can audit
 * or roll back if a course's data gets vandalised.
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

type Pin = { lat: number; lng: number };
type HoleRow = { hole_num: number; par: number; pin_lat?: number | null; pin_lng?: number | null };

export default function PlacePinsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Local working copy of pin positions, keyed by hole_num. Seeded from the
  // course's existing pins on load; mutations only commit to the server on
  // Save tap.
  const [pins, setPins] = useState<Record<number, Pin>>({});
  const [currentHole, setCurrentHole] = useState(1);
  // Snapshot of the loaded pin coords so we can compute a `dirty` flag
  // without reloading the course.
  const [serverPins, setServerPins] = useState<Record<number, Pin>>({});

  useEffect(() => {
    (async () => {
      try {
        const c = await api.courses.get(id);
        setCourse(c);
        const teebox = pickWidestTeebox(c?.teeboxes ?? []);
        const seeded: Record<number, Pin> = {};
        for (const h of (teebox?.holes ?? []) as HoleRow[]) {
          if (typeof h.pin_lat === 'number' && typeof h.pin_lng === 'number') {
            seeded[h.hole_num] = { lat: h.pin_lat, lng: h.pin_lng };
          }
        }
        setPins(seeded);
        setServerPins({ ...seeded });
      } catch (e: any) {
        Alert.alert('Error', e?.message ?? 'Could not load course');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const widestTeebox = useMemo(
    () => pickWidestTeebox(course?.teeboxes ?? []),
    [course?.teeboxes],
  );
  const holes = useMemo<HoleRow[]>(() => {
    const list = (widestTeebox?.holes ?? []) as HoleRow[];
    return [...list].sort((a, b) => a.hole_num - b.hole_num);
  }, [widestTeebox]);

  const initialRegion: Region | null = useMemo(() => {
    if (!course) return null;
    const lat = Number(course.latitude);
    const lng = Number(course.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng, latitudeDelta: 0.01, longitudeDelta: 0.01 };
  }, [course]);

  const placedCount = Object.keys(pins).length;
  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(pins), ...Object.keys(serverPins)]);
    for (const k of keys) {
      const a = pins[Number(k)];
      const b = serverPins[Number(k)];
      if (!a || !b) return true;
      if (a.lat !== b.lat || a.lng !== b.lng) return true;
    }
    return false;
  }, [pins, serverPins]);

  const handleMapPress = (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    setPins((prev) => ({ ...prev, [currentHole]: { lat: latitude, lng: longitude } }));
    // Auto-advance — speeds up the "walk the course in your head" workflow.
    // Stops at the last hole so a re-tap on the same hole still re-positions
    // rather than wrapping around to hole 1.
    if (currentHole < holes.length) setCurrentHole(currentHole + 1);
  };

  const handleSave = async () => {
    if (!dirty) {
      Alert.alert('No changes', 'Tap a green to place or move a pin.');
      return;
    }
    setSaving(true);
    try {
      const payload = Object.keys(pins)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((holeNum) => ({ holeNum, lat: pins[holeNum].lat, lng: pins[holeNum].lng }));
      const res = await api.courses.setPins(id, payload);
      if (res.missing_hole_nums?.length) {
        Alert.alert(
          'Partial save',
          `Saved ${res.updated} row${res.updated === 1 ? '' : 's'}. These hole numbers had no matching rows: ${res.missing_hole_nums.join(', ')}.`,
        );
      } else {
        Alert.alert('Saved', `Updated ${res.updated} row${res.updated === 1 ? '' : 's'} across all teeboxes. Thanks for the contribution!`);
      }
      setServerPins({ ...pins });
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearHole = () => {
    if (!pins[currentHole]) return;
    Alert.alert(
      `Clear pin for hole ${currentHole}?`,
      'Removes the pin from this hole locally. Tap Save to commit. Other contributors\' pins for this hole on the server are unaffected unless you save with this hole cleared and someone re-places it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear', style: 'destructive',
          onPress: () => setPins((prev) => {
            const next = { ...prev };
            delete next[currentHole];
            return next;
          }),
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator color={C.gold} size="large" />
      </View>
    );
  }
  if (!course || !initialRegion) {
    return (
      <View style={s.centered}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.muted}>Course is missing coordinates — can't place pins.</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={s.titleWrap}>
          <Text style={s.title}>Place Pins</Text>
          <Text style={s.subtitle} numberOfLines={1}>{course.course_name}</Text>
        </View>
        <Text style={s.counter}>{placedCount}/{holes.length}</Text>
      </View>

      {/* Map */}
      <MapView
        style={s.map}
        initialRegion={initialRegion}
        mapType="satellite"
        showsCompass
        onPress={handleMapPress}
      >
        {Object.keys(pins).map((k) => {
          const num = Number(k);
          const p = pins[num];
          const isCurrent = num === currentHole;
          return (
            <Marker
              key={`p-${num}`}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
              onPress={() => setCurrentHole(num)}
            >
              <View style={[s.pin, isCurrent && s.pinActive]}>
                <Text style={[s.pinText, isCurrent && s.pinTextActive]}>{num}</Text>
              </View>
            </Marker>
          );
        })}
      </MapView>

      {/* Hole strip */}
      <View style={s.holeStripWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.holeStrip}>
          {holes.map((h) => {
            const placed = !!pins[h.hole_num];
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
          {pins[currentHole]
            ? `Hole ${currentHole}: placed. Tap map to move, or pick another hole.`
            : `Hole ${currentHole}: tap the green on the map to place a pin.`}
        </Text>
        <View style={s.btnRow}>
          {pins[currentHole] && (
            <TouchableOpacity style={s.clearBtn} onPress={handleClearHole}>
              <Text style={s.clearBtnText}>Clear hole {currentHole}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.saveBtn, (!dirty || saving) && { opacity: 0.5 }]}
            onPress={handleSave}
            disabled={!dirty || saving}
          >
            {saving
              ? <ActivityIndicator color="#000" />
              : <Text style={s.saveBtnText}>Save {dirty ? '•' : ''}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

/** Pick the teebox with the most holes — we want the full 18-hole picture
 *  even when 9-hole tees exist on the same course. Falls back to whatever
 *  the first teebox is when all are the same size. */
function pickWidestTeebox(teeboxes: any[]): any | null {
  if (!Array.isArray(teeboxes) || !teeboxes.length) return null;
  return [...teeboxes].sort((a, b) =>
    (b?.holes?.length ?? 0) - (a?.holes?.length ?? 0),
  )[0];
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, backgroundColor: C.bg },
  muted: { color: C.textMuted, marginTop: 12, textAlign: 'center' },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 56, paddingHorizontal: 16, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  backBtn: { paddingRight: 8 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { color: C.text, fontWeight: '900', fontSize: 16 },
  subtitle: { color: C.textMuted, fontSize: 11, marginTop: 1 },
  counter: { color: C.gold, fontWeight: '900', fontSize: 13, minWidth: 50, textAlign: 'right' },

  map: { flex: 1 },

  pin: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: C.gold + 'cc', borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3,
  },
  pinActive: { backgroundColor: C.red, transform: [{ scale: 1.15 }] },
  pinText: { color: '#000', fontWeight: '900', fontSize: 11 },
  pinTextActive: { color: '#fff' },

  holeStripWrap: { borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  holeStrip: { padding: 10, gap: 6 },
  holeChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    alignItems: 'center', minWidth: 42,
  },
  holeChipPlaced: { borderColor: C.gold + '88', backgroundColor: C.gold + '11' },
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
    borderWidth: 1, borderColor: C.red, backgroundColor: C.red + '22',
    alignItems: 'center',
  },
  clearBtnText: { color: C.red, fontWeight: '700', fontSize: 13 },
  saveBtn: {
    flex: 2, paddingVertical: 12, borderRadius: 6,
    backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center',
  },
  saveBtnText: { color: '#000', fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
});
