/**
 * Simulator Course Play — play a real course indoors with a launch monitor.
 *
 * The whole thing runs on data players gathered on the course: every hole's
 * pin and tee box were marked during real rounds, so we know the actual
 * geometry and can place a ball in the world. A shot arrives from the monitor,
 * our ball-flight model (lib/ballFlight.ts) says where it finished, and the
 * ball advances down the real hole from the real tee toward the real pin.
 *
 * SCOPE (deliberate): no lies, no hazards, no putting. Courses have no
 * fairway/rough/green polygons yet, so pretending to know you're in a bunker
 * would be a lie. Instead the hole AUTO-COMPLETES once the ball is on the
 * green, and the score is strokes-to-green plus a two-putt — stated plainly
 * rather than hidden.
 *
 * Only courses that pass the geometry bar are offered (api.courses.simReady).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, Modal,
} from 'react-native';
import { Stack, router } from 'expo-router';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { C, F } from '../../lib/colors';
import { api } from '../../lib/api';
import { simulateFlight } from '../../lib/ballFlight';
import { demoShot, LaunchShot } from '../../lib/launchMonitor';
import { useLaunchMonitorLink } from '../../lib/useLaunchMonitorLink';
import { CLUBS_CATALOG, clubLabel } from '../../lib/clubs';
import { bearingDeg, distYards, SHOT_COLORS } from '../../lib/golfMath';

/** Ball is "on the green" — hole completes. 12 yds ≈ 36 ft, the same effective
 *  green radius the rest of the app's analytics use. */
const GREEN_RADIUS_YDS = 12;
/** Putts assumed once the ball reaches the green. */
const ASSUMED_PUTTS = 2;
const M_PER_YD = 0.9144;

type Hole = {
  hole_num: number; par: number | null; yardage: number | null;
  pin_lat: number | null; pin_lng: number | null;
  tee_lat: number | null; tee_lng: number | null;
};
type Pt = { lat: number; lng: number };
type PlayedShot = { start: Pt; end: Pt; club: string; carryYds: number; totalYds: number };
type HoleScore = { hole_num: number; par: number | null; strokes: number; toGreen: number };

/**
 * Move a point by (downrange, lateral) yards along a bearing. Flat-earth
 * offsets are fine at golf-hole scale (sub-metre error over 300 yds).
 */
function offsetPoint(from: Pt, bearingDeg: number, forwardYds: number, lateralYds: number): Pt {
  const br = (bearingDeg * Math.PI) / 180;
  // Forward along the bearing, lateral 90° clockwise of it (positive = right).
  const dNorth = (forwardYds * Math.cos(br) - lateralYds * Math.sin(br)) * M_PER_YD;
  const dEast = (forwardYds * Math.sin(br) + lateralYds * Math.cos(br)) * M_PER_YD;
  const dLat = dNorth / 111_320;
  const dLng = dEast / (111_320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

const bearingBetween = (a: Pt, b: Pt) => bearingDeg(a.lat, a.lng, b.lat, b.lng);

export default function CourseSim() {
  const [loading, setLoading] = useState(true);
  const [simCourses, setSimCourses] = useState<any[] | null>(null);
  const [reqs, setReqs] = useState<{ min_holes: number; min_hole_fraction: number } | null>(null);

  // Chosen round
  const [course, setCourse] = useState<any | null>(null);
  const [teebox, setTeebox] = useState<any | null>(null);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [holeIdx, setHoleIdx] = useState(0);

  // Live hole state
  const [ball, setBall] = useState<Pt | null>(null);
  const [played, setPlayed] = useState<PlayedShot[]>([]);
  const [scores, setScores] = useState<HoleScore[]>([]);
  const [club, setClub] = useState('driver');
  const [clubPickerOpen, setClubPickerOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  // Shots arrive from the monitor before playShot exists in this render, so the
  // link calls through a ref rather than re-subscribing on every state change.
  const playShotRef = useRef<((s: LaunchShot) => void) | null>(null);
  const link = useLaunchMonitorLink((s) => playShotRef.current?.(s));

  useEffect(() => {
    api.courses.simReady()
      .then((r) => { setSimCourses(r.courses); setReqs(r.requirements); })
      .catch(() => setSimCourses([]))
      .finally(() => setLoading(false));
  }, []);

  const hole = holes[holeIdx] ?? null;
  const tee: Pt | null = hole?.tee_lat != null && hole?.tee_lng != null
    ? { lat: hole.tee_lat, lng: hole.tee_lng } : null;
  const pin: Pt | null = hole?.pin_lat != null && hole?.pin_lng != null
    ? { lat: hole.pin_lat, lng: hole.pin_lng } : null;

  /** Yards from the ball (or tee, before the first swing) to the pin. */
  const toPin = useMemo(() => {
    const from = ball ?? tee;
    if (!from || !pin) return null;
    return Math.round(distYards(from.lat, from.lng, pin.lat, pin.lng));
  }, [ball, tee, pin]);

  const startRound = async (c: any, tb: any) => {
    setLoading(true);
    try {
      const detail = await api.courses.get(c.course_id);
      const full = (detail?.teeboxes ?? []).find((t: any) => t.teebox_id === tb.teebox_id);
      const hs: Hole[] = (full?.holes ?? [])
        .filter((h: any) => h.pin_lat != null && h.tee_lat != null)
        .sort((a: any, b: any) => a.hole_num - b.hole_num);
      if (!hs.length) { Alert.alert('No geometry', 'This tee has no mapped holes.'); return; }
      setCourse(detail); setTeebox(full ?? tb); setHoles(hs);
      setHoleIdx(0); setBall(null); setPlayed([]); setScores([]);
    } catch (e: any) {
      Alert.alert('Could not load course', e?.message ?? 'Try again.');
    } finally { setLoading(false); }
  };

  /** Frame the tee, the pin, and everything played so far. Applied
   *  imperatively (see below) so the player can still pan and zoom freely. */
  const region: Region | undefined = useMemo(() => {
    const pts: Pt[] = [];
    if (tee) pts.push(tee);
    if (pin) pts.push(pin);
    if (ball) pts.push(ball);
    played.forEach((s) => { pts.push(s.start); pts.push(s.end); });
    if (!pts.length) return undefined;
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.0022),
      longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.0022),
    };
  }, [tee, pin, ball, played]);

  /** Complete the hole: strokes to reach the green + assumed putts. */
  const finishHole = useCallback((strokesToGreen: number) => {
    if (!hole) return;
    const entry: HoleScore = {
      hole_num: hole.hole_num,
      par: hole.par,
      strokes: strokesToGreen + ASSUMED_PUTTS,
      toGreen: strokesToGreen,
    };
    setScores((prev) => [...prev, entry]);
    const last = holeIdx >= holes.length - 1;
    Alert.alert(
      `Hole ${hole.hole_num} — green in ${strokesToGreen}`,
      `Scored ${entry.strokes} (${strokesToGreen} to the green + ${ASSUMED_PUTTS} putts).`,
      last
        ? [{ text: 'See card', onPress: () => setCardOpen(true) }]
        : [{
            text: 'Next hole',
            onPress: () => { setHoleIdx((i) => i + 1); setBall(null); setPlayed([]); },
          }],
    );
  }, [hole, holeIdx, holes.length]);

  /**
   * Play one shot. The launch monitor gives launch conditions; the flight
   * model gives carry/offline; we lay that onto the real hole from wherever
   * the ball currently sits, aimed at the pin.
   */
  const playShot = useCallback((ls: LaunchShot) => {
    if (!hole || !pin) return;
    const from = ball ?? tee;
    if (!from) return;
    const flight = simulateFlight({
      ballSpeedMph: ls.ballSpeedMph,
      launchAngleDeg: ls.launchAngleDeg,
      azimuthDeg: ls.azimuthDeg,
      spinRpm: ls.spinRpm,
      spinAxisDeg: ls.spinAxisDeg,
    });
    // Aim at the pin; the shot's own curve carries it off that line. The ball
    // finishes wherever the physics puts it, long or short.
    const aim = bearingBetween(from, pin);
    const end = offsetPoint(from, aim, flight.totalYds, flight.offlineYds);

    const shot: PlayedShot = {
      start: from, end, club,
      carryYds: flight.carryYds, totalYds: flight.totalYds,
    };
    const nextPlayed = [...played, shot];
    setPlayed(nextPlayed);
    setBall(end);

    const remaining = distYards(end.lat, end.lng, pin.lat, pin.lng);
    if (remaining <= GREEN_RADIUS_YDS) {
      // On the green — hole is done, no putting simulated.
      setTimeout(() => finishHole(nextPlayed.length), 350);
    } else if (nextPlayed.length >= 12) {
      // Safety valve so a badly-calibrated monitor can't trap the player.
      Alert.alert('Hole abandoned', 'Twelve shots without reaching the green.', [
        { text: 'Move on', onPress: () => finishHole(nextPlayed.length) },
      ]);
    }
  }, [hole, pin, ball, tee, club, played, finishHole]);
  playShotRef.current = playShot;

  // Re-frame on a new hole and after each shot, but only then — leaving the
  // map uncontrolled in between means a pan or zoom sticks.
  useEffect(() => {
    if (region) mapRef.current?.animateToRegion(region, 550);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holeIdx, played.length]);

  // Connect once a round is actually underway, not while browsing courses.
  useEffect(() => {
    if (course && link.phase === 'idle') link.connect();
  }, [course, link.phase, link.connect]);

  // ── Course picker ──────────────────────────────────────────────────────────
  if (!course) {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ title: 'Play a Course', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <Text style={s.title}>Play a Course</Text>
          <Text style={s.sub}>
            Play a real course on the simulator. Only courses whose holes have been
            mapped by players — pin and tee marked on the ground — can be played,
            because that's what puts the ball in the right place.
          </Text>

          {loading ? (
            <ActivityIndicator color={C.gold} style={{ marginTop: 30 }} size="large" />
          ) : !simCourses?.length ? (
            <View style={s.emptyBox}>
              <Text style={s.emptyTitle}>No courses mapped yet</Text>
              <Text style={s.emptyBody}>
                A course needs pins and tee boxes on at least
                {reqs ? ` ${Math.round(reqs.min_hole_fraction * 100)}%` : ''} of its holes
                (minimum {reqs?.min_holes ?? 9}). Mark them while you play a round, or from
                a course's Place Pins and Mark Tee Boxes screens, and it'll appear here.
              </Text>
            </View>
          ) : (
            simCourses.map((c) => (
              <View key={c.course_id} style={s.courseCard}>
                <Text style={s.courseName}>{c.course_name}</Text>
                <Text style={s.courseMeta}>
                  {[c.city, c.state].filter(Boolean).join(', ')}
                  {c.elevation_samples > 0 ? ` · ${c.elevation_samples.toLocaleString()} elevation samples` : ''}
                </Text>
                {c.teeboxes.map((tb: any) => (
                  <TouchableOpacity
                    key={tb.teebox_id}
                    style={s.teeRow}
                    onPress={() => startRound(c, tb)}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.teeName}>{tb.name}</Text>
                      <Text style={s.teeMeta}>
                        {tb.holes_playable} of {tb.holes_total} holes mapped
                        {tb.par ? ` · par ${tb.par}` : ''}
                        {tb.total_yards ? ` · ${tb.total_yards.toLocaleString()} yds` : ''}
                      </Text>
                    </View>
                    <Text style={s.teeChev}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Playing ────────────────────────────────────────────────────────────────
  const strokesSoFar = played.length;
  const totalToPar = scores.reduce((a, h) => a + (h.par ? h.strokes - h.par : 0), 0);

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: course.course_name, headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />

      <View style={s.holeBar}>
        <View>
          <Text style={s.holeNum}>HOLE {hole?.hole_num ?? '—'}</Text>
          <Text style={s.holeMeta}>
            Par {hole?.par ?? '—'}{hole?.yardage ? ` · ${hole.yardage} yds` : ''} · {teebox?.name}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.toPin}>{toPin ?? '—'}</Text>
          <Text style={s.toPinLabel}>YDS TO PIN</Text>
        </View>
      </View>

      <TouchableOpacity
        style={s.linkBar}
        onPress={() => { if (link.phase !== 'searching') link.connect(); }}
        activeOpacity={0.8}
      >
        <View style={[s.linkDot, {
          backgroundColor: link.phase === 'ready' ? C.green
            : link.phase === 'error' ? C.red
            : link.phase === 'idle' ? C.textDim : C.gold,
        }]} />
        <Text style={s.linkText} numberOfLines={1}>
          {link.phase === 'ready' ? 'Monitor connected. Hit a shot.'
            : link.phase === 'searching' ? `Searching${link.scanPct ? ` ${link.scanPct}%` : ''}…`
            : link.phase === 'connecting' ? 'Connecting…'
            : link.detail ?? 'Tap to connect a launch monitor'}
        </Text>
      </TouchableOpacity>

      <View style={s.mapWrap}>
        <MapView
          ref={mapRef}
          style={{ flex: 1 }}
          initialRegion={region}
          mapType="satellite"
          pitchEnabled={false}
          rotateEnabled={false}
        >
          {tee && (
            <Marker coordinate={{ latitude: tee.lat, longitude: tee.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <View style={s.teeMarker} />
            </Marker>
          )}
          {pin && (
            <Marker coordinate={{ latitude: pin.lat, longitude: pin.lng }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
              <View style={s.pinMarker}><Text style={s.pinMarkerText}>⚑</Text></View>
            </Marker>
          )}
          {/* Shot tracers — one coloured line per shot, same visual language as
              a tracked round on the course. */}
          {played.map((sh, i) => {
            const color = SHOT_COLORS[i % SHOT_COLORS.length];
            return (
              <React.Fragment key={`sh${i}`}>
                <Polyline
                  coordinates={[
                    { latitude: sh.start.lat, longitude: sh.start.lng },
                    { latitude: sh.end.lat, longitude: sh.end.lng },
                  ]}
                  strokeColor={color}
                  strokeWidth={4}
                />
                <Marker coordinate={{ latitude: sh.end.lat, longitude: sh.end.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                  <View style={[s.shotDot, { borderColor: color }]}>
                    <Text style={s.shotDotText}>{i + 1}</Text>
                  </View>
                </Marker>
              </React.Fragment>
            );
          })}
        </MapView>

        {strokesSoFar > 0 && (
          <View style={s.lastShotChip} pointerEvents="none">
            <Text style={s.lastShotText}>
              Shot {strokesSoFar}: {clubLabel(played[strokesSoFar - 1].club)} ·{' '}
              {Math.round(played[strokesSoFar - 1].totalYds)} yds
            </Text>
          </View>
        )}
      </View>

      <View style={s.controls}>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => setClubPickerOpen(true)} activeOpacity={0.85}>
          <Text style={s.ctrlLabel}>CLUB</Text>
          <Text style={s.ctrlValue}>{clubLabel(club)}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.ctrlBtn, s.ctrlGold]} onPress={() => playShot(demoShot(club))} activeOpacity={0.85}>
          <Text style={[s.ctrlValue, { color: C.gold }]}>Demo Shot</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.ctrlBtn, !played.length && { opacity: 0.4 }]}
          disabled={!played.length}
          onPress={() => {
            const next = played.slice(0, -1);
            setPlayed(next);
            setBall(next.length ? next[next.length - 1].end : null);
          }}
          activeOpacity={0.85}
        >
          <Text style={s.ctrlLabel}>UNDO</Text>
          <Text style={s.ctrlValue}>{strokesSoFar}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => setCardOpen(true)} activeOpacity={0.85}>
          <Text style={s.ctrlLabel}>CARD</Text>
          <Text style={s.ctrlValue}>{totalToPar > 0 ? `+${totalToPar}` : totalToPar === 0 ? 'E' : totalToPar}</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.footNote}>
        The hole completes when the ball reaches the green; putting isn't simulated,
        so each hole scores as strokes-to-green plus {ASSUMED_PUTTS} putts.
      </Text>

      {/* Scorecard */}
      <Modal visible={cardOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setCardOpen(false)}>
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Scorecard</Text>
            <TouchableOpacity onPress={() => setCardOpen(false)}><Text style={s.modalDone}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {scores.length === 0 ? (
              <Text style={s.emptyBody}>No holes finished yet.</Text>
            ) : (
              <>
                {scores.map((h) => (
                  <View key={h.hole_num} style={s.cardRow}>
                    <Text style={s.cardHole}>{h.hole_num}</Text>
                    <Text style={s.cardPar}>par {h.par ?? '—'}</Text>
                    <Text style={s.cardGreen}>green in {h.toGreen}</Text>
                    <Text style={s.cardScore}>{h.strokes}</Text>
                  </View>
                ))}
                <View style={s.cardTotal}>
                  <Text style={s.cardTotalLabel}>THROUGH {scores.length}</Text>
                  <Text style={s.cardTotalVal}>
                    {scores.reduce((a, h) => a + h.strokes, 0)}
                    {'  ('}{totalToPar > 0 ? `+${totalToPar}` : totalToPar === 0 ? 'E' : totalToPar}{')'}
                  </Text>
                </View>
              </>
            )}
            <TouchableOpacity style={s.exitBtn} onPress={() => { setCardOpen(false); setCourse(null); }}>
              <Text style={s.exitBtnText}>Leave this round</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Club picker */}
      <Modal visible={clubPickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setClubPickerOpen(false)}>
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Club</Text>
            <TouchableOpacity onPress={() => setClubPickerOpen(false)}><Text style={s.modalDone}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {CLUBS_CATALOG.filter((c) => c.code !== 'putter').map((c) => (
              <TouchableOpacity
                key={c.code}
                style={[s.clubRow, club === c.code && s.clubRowActive]}
                onPress={() => { setClub(c.code); setClubPickerOpen(false); }}
              >
                <Text style={[s.clubRowText, club === c.code && { color: C.gold }]}>{c.defaultLabel}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 6, lineHeight: 19, marginBottom: 14 },

  emptyBox: {
    backgroundColor: C.card, borderRadius: 10, padding: 20,
    borderWidth: 1, borderColor: C.border, marginTop: 10,
  },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 15 },
  emptyBody: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 },

  courseCard: {
    backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    padding: 14, marginBottom: 10,
  },
  courseName: { color: C.text, fontSize: 16, fontWeight: '800' },
  courseMeta: { color: C.textMuted, fontSize: 11, marginTop: 2, marginBottom: 8 },
  teeRow: {
    flexDirection: 'row', alignItems: 'center',
    borderTopWidth: 1, borderTopColor: C.border, paddingVertical: 10,
  },
  teeName: { color: C.text, fontSize: 14, fontWeight: '700' },
  teeMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  teeChev: { color: C.textDim, fontSize: 22 },

  holeBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  holeNum: { color: C.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.6 },
  holeMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  toPin: { color: C.gold, fontFamily: F.serif, fontSize: 30, fontWeight: '900' },
  toPinLabel: { color: C.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },

  linkBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 7,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  linkDot: { width: 7, height: 7, borderRadius: 4 },
  linkText: { flex: 1, color: C.textMuted, fontSize: 11, fontWeight: '600' },

  mapWrap: { flex: 1, minHeight: 240 },
  teeMarker: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#333',
  },
  pinMarker: { alignItems: 'center' },
  pinMarkerText: { color: C.gold, fontSize: 22, fontWeight: '900' },
  shotDot: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: '#000000aa',
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  shotDotText: { color: '#fff', fontSize: 10, fontWeight: '900' },
  lastShotChip: {
    position: 'absolute', bottom: 10, left: 12, right: 12,
    backgroundColor: '#000000aa', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12,
    borderWidth: 1, borderColor: '#ffffff22',
  },
  lastShotText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  controls: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 12 },
  ctrlBtn: {
    flex: 1, backgroundColor: C.card, borderRadius: 10,
    borderWidth: 1, borderColor: C.border,
    paddingVertical: 9, alignItems: 'center', justifyContent: 'center',
  },
  ctrlGold: { borderColor: C.gold + 'aa' },
  ctrlLabel: { color: C.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  ctrlValue: { color: C.text, fontSize: 13, fontWeight: '800', marginTop: 1 },
  footNote: {
    color: C.textDim, fontSize: 11, lineHeight: 16,
    paddingHorizontal: 14, paddingVertical: 10, fontStyle: 'italic',
  },

  modal: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  modalDone: { color: C.gold, fontSize: 15, fontWeight: '800' },

  cardRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6, gap: 10,
  },
  cardHole: { color: C.gold, fontSize: 14, fontWeight: '900', width: 24 },
  cardPar: { color: C.textMuted, fontSize: 12, width: 54 },
  cardGreen: { flex: 1, color: C.textMuted, fontSize: 12 },
  cardScore: { color: C.text, fontFamily: F.serif, fontSize: 18, fontWeight: '900' },
  cardTotal: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.gold + '44',
  },
  cardTotalLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  cardTotalVal: { color: C.gold, fontFamily: F.serif, fontSize: 20, fontWeight: '900' },
  exitBtn: { marginTop: 26, alignSelf: 'center', padding: 10 },
  exitBtnText: { color: C.red, fontSize: 14, fontWeight: '700' },

  clubRow: {
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 8,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, marginBottom: 6,
  },
  clubRowActive: { borderColor: C.gold },
  clubRowText: { color: C.text, fontSize: 15, fontWeight: '700' },
});
