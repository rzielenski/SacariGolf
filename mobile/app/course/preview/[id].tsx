/**
 * Course Preview — "walk" a course hole-by-hole without playing a round.
 *
 * Like the 18Birdies course preview: positioned at each teebox, you see the
 * satellite layout (tee → green), the hole's distance / par / handicap, and
 * your own shot heatmap for that hole (landing spots from every round you've
 * tracked here). Step through all 18 with next/prev or the hole strip. No
 * scores are entered — it's a scouting / yardage tool.
 *
 * Tee positions come from the crowd-sourced tee markers (Mark Tee Boxes); the
 * green comes from the pin data. If a hole's tee isn't marked yet, the preview
 * still shows the green + your shots and links to the tee-marking screen.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import MapView, { Marker, Polyline, Circle, Region } from 'react-native-maps';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { isPremium } from '../../../lib/premium';
import { C, F } from '../../../lib/colors';
import { distYards, bearingDeg, projectYards } from '../../../lib/golfMath';

type Hole = {
  hole_num: number; par: number; yardage?: number | null; handicap?: number | null;
  pin_lat?: number | null; pin_lng?: number | null;
  tee_lat?: number | null; tee_lng?: number | null;
};
type ShotRow = {
  hole_num: number; club: string | null;
  start_lat: number; start_lng: number; end_lat: number; end_lng: number; total_yds: number | null;
};
type ClubStat = {
  club: string; shots: number; avg_yds: number; median_yds: number;
  dispersion: { lateral_yds: number; long_yds: number; dist_yds: number }[];
};
type LL = { lat: number; lng: number };

export default function CoursePreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any | null>(null);
  const [shots, setShots] = useState<ShotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [teeboxId, setTeeboxId] = useState<string | null>(null);
  const [idx, setIdx] = useState(0); // index into holes
  const [editTee, setEditTee] = useState(false);
  const [teeEdits, setTeeEdits] = useState<Record<number, { lat: number; lng: number }>>({});
  const [savingTee, setSavingTee] = useState(false);
  // Tap-to-measure point. Also the aim the club heatmap rotates toward.
  const [measurePin, setMeasurePin] = useState<LL | null>(null);
  const [clubStats, setClubStats] = useState<ClubStat[] | null>(null);
  const [selectedClub, setSelectedClub] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);

  const { user } = useAuth();
  const userIsPremium = isPremium(user as any);

  // Per-club dispersion (premium consumer, like the in-round heatmap).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.users.clubStats(user.user_id)
      .then((d: any) => { if (!cancelled) setClubStats(d.clubs ?? []); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [user?.user_id]);

  // Reset the measure point when you move to a different hole / teebox.
  useEffect(() => { setMeasurePin(null); }, [idx, teeboxId]);

  useEffect(() => {
    (async () => {
      try {
        const [c, sh] = await Promise.all([
          api.courses.get(id),
          api.courses.myShots(id).catch(() => ({ shots: [] as ShotRow[] })),
        ]);
        setCourse(c);
        setShots(sh.shots ?? []);
        const list = (c?.teeboxes ?? []) as any[];
        const widest = [...list].sort((a, b) => (b?.holes?.length ?? 0) - (a?.holes?.length ?? 0))[0];
        if (widest) setTeeboxId(widest.teebox_id);
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
  const holes = useMemo<Hole[]>(
    () => [...((selectedTeebox?.holes ?? []) as Hole[])].sort((a, b) => a.hole_num - b.hole_num),
    [selectedTeebox],
  );
  const hole = holes[idx] ?? null;

  // Shots grouped by hole_num for the per-hole heatmap.
  const shotsByHole = useMemo(() => {
    const m = new Map<number, ShotRow[]>();
    for (const sh of shots) {
      const arr = m.get(sh.hole_num) ?? [];
      arr.push(sh); m.set(sh.hole_num, arr);
    }
    return m;
  }, [shots]);
  const holeShots = hole ? (shotsByHole.get(hole.hole_num) ?? []) : [];

  const editedTee = hole ? (teeEdits[hole.hole_num] ?? null) : null;
  const markedTee = hole && typeof hole.tee_lat === 'number' && typeof hole.tee_lng === 'number'
    ? { lat: hole.tee_lat, lng: hole.tee_lng } : null;
  // An explicitly-placed (and editable) tee: an unsaved edit wins over the
  // saved marker.
  const baseTee = editedTee ?? markedTee;
  // Fall back to your first tracked shot's start — no need to mark a tee in
  // the round, the app reads it off your opening shot.
  const inferredTee = !baseTee && holeShots.length
    ? { lat: holeShots[0].start_lat, lng: holeShots[0].start_lng } : null;
  const tee = baseTee ?? inferredTee;
  const green = hole && typeof hole.pin_lat === 'number' && typeof hole.pin_lng === 'number'
    ? { lat: hole.pin_lat, lng: hole.pin_lng } : null;

  // Distance: real tee→green if both known, else the printed yardage.
  const playsYards = tee && green ? Math.round(distYards(tee.lat, tee.lng, green.lat, green.lng)) : null;
  const distLabel = playsYards ?? (hole?.yardage ?? null);

  // Tap-to-measure: tee → tapped point (and tapped point → green).
  const measureFromTee = tee && measurePin ? Math.round(distYards(tee.lat, tee.lng, measurePin.lat, measurePin.lng)) : null;
  const measureToGreen = green && measurePin ? Math.round(distYards(measurePin.lat, measurePin.lng, green.lat, green.lng)) : null;

  // Clubs with enough data to draw a dispersion (premium feature, like in-round).
  const availableClubs = useMemo(
    () => (clubStats ?? []).filter((c) => c.median_yds > 0 && (c.dispersion?.length ?? 0) >= 2),
    [clubStats],
  );
  const activeClubStat = userIsPremium && selectedClub
    ? availableClubs.find((c) => c.club === selectedClub) ?? null : null;

  // Project the selected club's dispersion from the tee toward the aim (the
  // tapped point, else the green) — same model as the in-round heatmap.
  const heatmap = useMemo(() => {
    if (!tee || !activeClubStat) return null;
    const aim = measurePin ?? green;
    if (!aim) return null;
    const brg = bearingDeg(tee.lat, tee.lng, aim.lat, aim.lng);
    const dots = activeClubStat.dispersion.slice(-150).map((d) =>
      projectYards(tee.lat, tee.lng, brg, activeClubStat.median_yds + d.long_yds, d.lateral_yds));
    const center = projectYards(tee.lat, tee.lng, brg, activeClubStat.median_yds, 0);
    return { dots, center, median: Math.round(activeClubStat.median_yds) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tee?.lat, tee?.lng, green?.lat, green?.lng, measurePin?.lat, measurePin?.lng, activeClubStat]);

  const regionForHole = (): Region | null => {
    const pts: { lat: number; lng: number }[] = [];
    if (tee) pts.push(tee);
    if (green) pts.push(green);
    for (const sh of holeShots) { pts.push({ lat: sh.start_lat, lng: sh.start_lng }); pts.push({ lat: sh.end_lat, lng: sh.end_lng }); }
    if (!pts.length) {
      const lat = Number(course?.latitude), lng = Number(course?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { latitude: lat, longitude: lng, latitudeDelta: 0.01, longitudeDelta: 0.01 };
      return null;
    }
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.8, 0.0025),
      longitudeDelta: Math.max((maxLng - minLng) * 1.8, 0.0025),
    };
  };

  // Re-fit the map whenever the hole or teebox changes.
  useEffect(() => {
    const r = regionForHole();
    if (r && mapRef.current) mapRef.current.animateToRegion(r, 550);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, teeboxId, shots.length]);

  // Map tap: in Mark-Tee mode it sets the hole's tee; otherwise it drops the
  // measure point (yardage from the tee + the aim for the club heatmap).
  const handleMapPress = (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    if (editTee) {
      if (!hole) return;
      setTeeEdits((prev) => ({ ...prev, [hole.hole_num]: { lat: latitude, lng: longitude } }));
    } else {
      setMeasurePin({ lat: latitude, lng: longitude });
    }
  };

  // Persist all staged tee edits for the selected teebox, then fold them into
  // the loaded course so the markers stick without a reload.
  const handleSaveTees = async () => {
    const entries = Object.keys(teeEdits).map(Number).sort((a, b) => a - b);
    if (!teeboxId || !entries.length) { setEditTee(false); return; }
    setSavingTee(true);
    try {
      const payload = entries.map((holeNum) => ({ holeNum, lat: teeEdits[holeNum].lat, lng: teeEdits[holeNum].lng }));
      const res = await api.courses.setTeeboxes(teeboxId, payload);
      setCourse((prev: any) => {
        if (!prev) return prev;
        const teeboxesU = (prev.teeboxes ?? []).map((tb: any) => {
          if (tb.teebox_id !== teeboxId) return tb;
          const holesU = (tb.holes ?? []).map((h: any) =>
            teeEdits[h.hole_num] ? { ...h, tee_lat: teeEdits[h.hole_num].lat, tee_lng: teeEdits[h.hole_num].lng } : h,
          );
          return { ...tb, holes: holesU };
        });
        return { ...prev, teeboxes: teeboxesU };
      });
      setTeeEdits({});
      setEditTee(false);
      Alert.alert('Saved', `Marked ${res.updated} tee${res.updated === 1 ? '' : 's'} for the ${selectedTeebox?.name} tees.`);
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSavingTee(false);
    }
  };

  if (loading) {
    return <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>;
  }
  if (!course) {
    return (
      <View style={s.centered}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}><Text style={s.backText}>← Back</Text></TouchableOpacity>
        <Text style={s.muted}>Course not found.</Text>
      </View>
    );
  }

  const initialRegion: Region = regionForHole() ?? { latitude: 0, longitude: 0, latitudeDelta: 0.01, longitudeDelta: 0.01 };
  const atFirst = idx <= 0;
  const atLast = idx >= holes.length - 1;

  return (
    <View style={s.container}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}><Text style={s.backText}>← Back</Text></TouchableOpacity>
        <View style={s.titleWrap}>
          <Text style={s.title}>Course Preview</Text>
          <Text style={s.subtitle} numberOfLines={1}>{course.course_name}</Text>
        </View>
        <View style={{ minWidth: 50 }} />
      </View>

      {/* Teebox picker */}
      {teeboxes.length > 1 && (
        <View style={s.teeboxStripWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.teeboxStrip}>
            {teeboxes.map((tb) => {
              const active = tb.teebox_id === teeboxId;
              return (
                <TouchableOpacity key={tb.teebox_id} style={[s.teeboxChip, active && s.teeboxChipActive]} onPress={() => { setTeeboxId(tb.teebox_id); setIdx(0); setTeeEdits({}); setEditTee(false); }}>
                  <Text style={[s.teeboxChipName, active && s.teeboxChipNameActive]}>{tb.name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Map */}
      <View style={s.mapWrap}>
        <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={initialRegion} mapType="satellite" showsCompass onPress={handleMapPress}>
          {/* Your shot heatmap for this hole — translucent landing dots */}
          {holeShots.map((sh, i) => (
            <Circle
              key={`shot-${i}`}
              center={{ latitude: sh.end_lat, longitude: sh.end_lng }}
              radius={6}
              strokeColor="transparent"
              fillColor={'rgba(212,169,63,0.35)'}
            />
          ))}
          {/* Selected-club dispersion, projected from the tee toward your aim */}
          {heatmap?.dots.map((p, i) => (
            <Circle
              key={`disp-${i}`}
              center={{ latitude: p.lat, longitude: p.lng }}
              radius={4}
              strokeColor="transparent"
              fillColor={'rgba(77,163,255,0.40)'}
            />
          ))}
          {/* Tee → green reference line */}
          {tee && green && (
            <Polyline
              coordinates={[{ latitude: tee.lat, longitude: tee.lng }, { latitude: green.lat, longitude: green.lng }]}
              strokeColor={C.gold + 'cc'}
              strokeWidth={2}
              lineDashPattern={[6, 6]}
            />
          )}
          {tee && (
            <Marker coordinate={{ latitude: tee.lat, longitude: tee.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <View style={s.teeMarker}><Text style={s.teeMarkerText}>T</Text></View>
            </Marker>
          )}
          {green && (
            <Marker coordinate={{ latitude: green.lat, longitude: green.lng }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
              <Text style={s.flag}>⛳</Text>
            </Marker>
          )}
          {/* Club carry center (median distance for the selected club) */}
          {heatmap && (
            <Marker coordinate={{ latitude: heatmap.center.lat, longitude: heatmap.center.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <View style={s.carryDot} />
            </Marker>
          )}
          {/* Measure line tee → tapped point + yardage label */}
          {tee && measurePin && (
            <Polyline
              coordinates={[{ latitude: tee.lat, longitude: tee.lng }, { latitude: measurePin.lat, longitude: measurePin.lng }]}
              strokeColor={'#ffffff'} strokeWidth={2}
            />
          )}
          {measurePin && (
            <Marker coordinate={{ latitude: measurePin.lat, longitude: measurePin.lng }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
              <View style={s.measureLabel}>
                <Text style={s.measureLabelText}>{measureFromTee != null ? `${measureFromTee} yds` : 'tap'}</Text>
                {measureToGreen != null && <Text style={s.measureSub}>{measureToGreen} to green</Text>}
              </View>
            </Marker>
          )}
        </MapView>

        {/* Hole badge overlay */}
        {hole && (
          <View style={s.holeBadge}>
            <Text style={s.holeBadgeNum}>HOLE {hole.hole_num}</Text>
            <Text style={s.holeBadgePar}>PAR {hole.par}</Text>
          </View>
        )}

        {/* Mark-tee toggle (top-right). While on, tap the map to set the
            current hole's tee; the button becomes Save. */}
        <TouchableOpacity
          style={[s.editToggle, editTee && s.editToggleOn]}
          onPress={() => (editTee ? handleSaveTees() : setEditTee(true))}
          disabled={savingTee}
        >
          {savingTee
            ? <ActivityIndicator color="#000" />
            : <Text style={[s.editToggleText, editTee && s.editToggleTextOn]}>
                {editTee ? `✓ Save${Object.keys(teeEdits).length ? ` (${Object.keys(teeEdits).length})` : ''}` : '📍 Mark Tee'}
              </Text>}
        </TouchableOpacity>
        {editTee && (
          <TouchableOpacity style={s.editCancel} onPress={() => { setTeeEdits({}); setEditTee(false); }}>
            <Text style={s.editCancelText}>Cancel</Text>
          </TouchableOpacity>
        )}

        {/* Bottom status line */}
        {editTee ? (
          <View style={s.editBar}><Text style={s.editBarText}>Tap the tee box for hole {hole?.hole_num}</Text></View>
        ) : !baseTee ? (
          <View style={s.editBar}>
            <Text style={s.editBarText}>{inferredTee ? 'Tee shown from your 1st shot' : 'Tee not marked yet'}</Text>
          </View>
        ) : null}
      </View>

      {/* Stats row */}
      <View style={s.statsRow}>
        <Stat label="DISTANCE" value={distLabel != null ? `${distLabel}` : '—'} unit={distLabel != null ? 'yds' : ''} accent />
        <Stat label="PAR" value={hole ? `${hole.par}` : '—'} />
        <Stat label="HANDICAP" value={hole?.handicap != null ? `${hole.handicap}` : '—'} />
        <Stat label="YOUR SHOTS" value={`${holeShots.length}`} />
      </View>
      {playsYards != null && hole?.yardage ? (
        <Text style={s.distNote}>Tee→green {playsYards} yds · card {hole.yardage} yds</Text>
      ) : null}

      {/* Tap-to-measure readout */}
      {measureFromTee != null && (
        <Text style={s.measureReadout}>
          To point: <Text style={{ color: C.gold, fontWeight: '900' }}>{measureFromTee} yds</Text>
          {measureToGreen != null ? `  ·  ${measureToGreen} to green` : ''}  ·  tap to move
        </Text>
      )}

      {/* Club dispersion selector (premium) — same heatmap model as a round */}
      {userIsPremium && availableClubs.length > 0 && (
        <View style={s.clubRowWrap}>
          <Text style={s.clubRowLabel}>
            CLUB HEATMAP{measurePin ? ' · AIMED AT YOUR POINT' : green ? ' · AIMED AT THE GREEN' : ''}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.clubRow}>
            {availableClubs.map((c) => {
              const active = c.club === selectedClub;
              return (
                <TouchableOpacity
                  key={c.club}
                  style={[s.clubChip, active && s.clubChipActive]}
                  onPress={() => setSelectedClub(active ? null : c.club)}
                >
                  <Text style={[s.clubChipText, active && s.clubChipTextActive]}>{c.club.toUpperCase()}</Text>
                  <Text style={[s.clubChipMeta, active && s.clubChipMetaActive]}>{Math.round(c.median_yds)}y</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Hole strip */}
      <View style={s.holeStripWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.holeStrip}>
          {holes.map((h, i) => {
            const active = i === idx;
            return (
              <TouchableOpacity key={h.hole_num} style={[s.holeChip, active && s.holeChipActive]} onPress={() => setIdx(i)}>
                <Text style={[s.holeChipNum, active && s.holeChipNumActive]}>{h.hole_num}</Text>
                <Text style={[s.holeChipPar, active && s.holeChipParActive]}>P{h.par}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Prev / next */}
      <View style={s.navRow}>
        <TouchableOpacity style={[s.navBtn, atFirst && { opacity: 0.4 }]} disabled={atFirst} onPress={() => setIdx((i) => Math.max(0, i - 1))}>
          <Text style={s.navBtnText}>‹ Prev</Text>
        </TouchableOpacity>
        <Text style={s.navCounter}>{holes.length ? `${idx + 1} / ${holes.length}` : '—'}</Text>
        <TouchableOpacity style={[s.navBtn, atLast && { opacity: 0.4 }]} disabled={atLast} onPress={() => setIdx((i) => Math.min(holes.length - 1, i + 1))}>
          <Text style={s.navBtnText}>Next ›</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, accent && { color: C.gold }]}>
        {value}{unit ? <Text style={s.statUnit}> {unit}</Text> : null}
      </Text>
      <Text style={s.statLabel}>{label}</Text>
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
  backBtn: { paddingRight: 8, minWidth: 50 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { color: C.text, fontWeight: '900', fontSize: 16 },
  subtitle: { color: C.textMuted, fontSize: 11, marginTop: 1 },

  teeboxStripWrap: { borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg },
  teeboxStrip: { padding: 8, gap: 6 },
  teeboxChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  teeboxChipActive: { borderColor: C.gold, backgroundColor: C.gold },
  teeboxChipName: { color: C.text, fontWeight: '800', fontSize: 12 },
  teeboxChipNameActive: { color: C.bg },

  mapWrap: { flex: 1, position: 'relative' },
  teeMarker: {
    width: 22, height: 22, borderRadius: 5, backgroundColor: '#4da3ff', borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  teeMarkerText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  flag: { fontSize: 26 },

  holeBadge: {
    position: 'absolute', top: 12, left: 12, backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: C.gold + '66',
  },
  holeBadgeNum: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 1 },
  holeBadgePar: { color: '#fff', fontSize: 11, marginTop: 1 },

  // Top-LEFT, below the hole badge — keeps clear of the map compass (top-right).
  editToggle: {
    position: 'absolute', top: 64, left: 12, minWidth: 96, alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: '#4da3ff88',
  },
  editToggleOn: { backgroundColor: C.gold, borderColor: C.gold },
  editToggleText: { color: '#9ccaff', fontSize: 13, fontWeight: '800' },
  editToggleTextOn: { color: '#000' },
  editCancel: {
    position: 'absolute', top: 104, left: 12, alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border,
  },
  editCancelText: { color: C.textMuted, fontSize: 12, fontWeight: '700' },

  carryDot: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: '#4da3ff',
    borderWidth: 2, borderColor: '#fff',
  },
  measureLabel: {
    backgroundColor: 'rgba(0,0,0,0.78)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
    alignItems: 'center', borderWidth: 1, borderColor: '#ffffff55', marginBottom: 4,
  },
  measureLabelText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  measureSub: { color: C.textMuted, fontSize: 10, marginTop: 1 },

  clubRowWrap: { borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  clubRowLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 12, paddingTop: 8 },
  clubRow: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  clubChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1,
    borderColor: '#4da3ff66', backgroundColor: C.card, alignItems: 'center',
  },
  clubChipActive: { backgroundColor: '#4da3ff', borderColor: '#4da3ff' },
  clubChipText: { color: '#9ccaff', fontWeight: '800', fontSize: 13 },
  clubChipTextActive: { color: '#001b33' },
  clubChipMeta: { color: C.textDim, fontSize: 9, marginTop: 1 },
  clubChipMetaActive: { color: '#001b33cc' },
  editBar: {
    position: 'absolute', bottom: 12, alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: '#4da3ff66',
  },
  editBarText: { color: '#cfe4ff', fontSize: 12, fontWeight: '700' },

  statsRow: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
    paddingVertical: 10,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '700' },
  statUnit: { color: C.textMuted, fontSize: 11, fontWeight: '600' },
  statLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
  distNote: { color: C.textDim, fontSize: 11, textAlign: 'center', paddingBottom: 6 },
  measureReadout: { color: C.textMuted, fontSize: 12, textAlign: 'center', paddingBottom: 8 },

  holeStripWrap: { borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  holeStrip: { padding: 10, gap: 6 },
  holeChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1,
    borderColor: C.border, backgroundColor: C.card, alignItems: 'center', minWidth: 42,
  },
  holeChipActive: { borderColor: C.gold, backgroundColor: C.gold },
  holeChipNum: { color: C.text, fontWeight: '900', fontSize: 13 },
  holeChipNumActive: { color: C.bg },
  holeChipPar: { color: C.textMuted, fontSize: 9, marginTop: 1 },
  holeChipParActive: { color: C.bg + 'cc' },

  navRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, paddingBottom: 24,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
  },
  navBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  navBtnText: { color: C.gold, fontWeight: '800', fontSize: 15 },
  navCounter: { color: C.textMuted, fontSize: 13, fontWeight: '700' },
});
