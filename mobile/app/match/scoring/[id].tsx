import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, Animated, Dimensions, TextInput, Modal,
  PanResponder,
} from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { C, F } from '../../../lib/colors';
import { Hole, Teebox, Course } from '../../../types';

const { width: SCREEN_W } = Dimensions.get('window');
const COLLAPSED_H = 92;
const EXPANDED_H = 348;
const ON_COURSE_METRES = 3 * 1609.34;

// Per-shot color palette — each successive shot on a hole renders in the next color.
const SHOT_COLORS = ['#4a9eff', '#9c2128', '#7aab78', '#bdb9aa', '#c89a45', '#a672b8', '#d4794a'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function distMetres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distYards(lat1: number, lon1: number, lat2: number, lon2: number) {
  return distMetres(lat1, lon1, lat2, lon2) * 1.09361;
}

function scoreLabel(strokes: number, par: number) {
  const diff = strokes - par;
  if (strokes === 1) return { label: 'Hole in One!', color: '#FFD700' };
  if (diff <= -3) return { label: 'Albatross', color: '#FF00FF' };
  if (diff === -2) return { label: 'Eagle', color: '#4CAF50' };
  if (diff === -1) return { label: 'Birdie', color: '#81C784' };
  if (diff === 0) return { label: 'Par', color: C.text };
  if (diff === 1) return { label: 'Bogey', color: '#FF9800' };
  if (diff === 2) return { label: 'Double Bogey', color: '#F44336' };
  if (diff === 3) return { label: 'Triple Bogey', color: '#B71C1C' };
  return { label: `+${diff}`, color: '#7B1FA2' };
}

function scoreColor(score: number, par: number) {
  const d = score - par;
  if (d <= -2) return '#4CAF50';
  if (d === -1) return '#81C784';
  if (d === 0) return C.text;
  if (d === 1) return '#FF9800';
  return '#F44336';
}

// ── Small stepper for per-hole stats (putts / chips) ───────────────────────
function StatStepper({ label, value, onChange }: {
  label: string;
  value: number | null;
  onChange: (n: number) => void;
}) {
  const display = value == null ? '—' : String(value);
  const inc = () => onChange(Math.min(10, (value ?? 0) + 1));
  const dec = () => onChange(Math.max(0, (value ?? 0) - 1));
  return (
    <View style={stepperStyles.wrap}>
      <Text style={stepperStyles.label}>{label.toUpperCase()}</Text>
      <View style={stepperStyles.row}>
        <TouchableOpacity style={stepperStyles.btn} onPress={dec}>
          <Text style={stepperStyles.btnText}>−</Text>
        </TouchableOpacity>
        <Text style={stepperStyles.value}>{display}</Text>
        <TouchableOpacity style={stepperStyles.btn} onPress={inc}>
          <Text style={stepperStyles.btnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const stepperStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', gap: 4 },
  label: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btn: {
    width: 28, height: 28, borderRadius: 4,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    justifyContent: 'center', alignItems: 'center',
  },
  btnText: { color: C.text, fontSize: 18, fontWeight: '700', lineHeight: 20 },
  value: { color: C.text, fontSize: 16, fontWeight: '800', minWidth: 18, textAlign: 'center' },
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function ScoringScreen() {
  const { id, holes: holesParam } = useLocalSearchParams<{ id: string; holes?: string }>();
  // numHoles is a state so it can be corrected after loading the match's existing teebox
  const [numHoles, setNumHoles] = useState<number>(holesParam ? parseInt(holesParam, 10) : 18);
  const { user } = useAuth();

  // Match / course data
  const [match, setMatch] = useState<any>(null);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [teebox, setTeebox] = useState<Teebox | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [scores, setScores] = useState<number[]>([]);
  const [currentHole, setCurrentHole] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [scorecardVisible, setScorecardVisible] = useState(false);

  // Per-hole shot tracking. Keyed by hole_num (the actual hole number on the
  // course, not the index into our `holes` array). elevation_m is the device's
  // GPS altitude at the moment the shot was tracked — captured so we can
  // crowdsource pin elevation data and offer slope-adjusted distances.
  type ShotPoint = { lat: number; lng: number; elevation_m?: number };
  const [shotsByHole, setShotsByHole] = useState<Record<number, ShotPoint[]>>({});

  // Per-hole stat tracking — putts, chips, fairway hit. Indexed by the hole
  // INDEX in our holes array (not hole_num) so we can submit it as a parallel
  // array alongside scores. Tracking is opt-in: untouched holes stay empty.
  type HoleStat = { putts?: number; chips?: number; fairwayHit?: boolean | null };
  const [holeStats, setHoleStats] = useState<HoleStat[]>([]);

  // Course selection
  const [selectingCourse, setSelectingCourse] = useState(true);
  // Round length the player chose for this round. Null until they pick;
  // forces a step between course-pick and teebox-pick (matches play.tsx flow).
  const [chosenRoundHoles, setChosenRoundHoles] = useState<9 | 18 | null>(null);
  const [courseQuery, setCourseQuery] = useState('');
  const [courseResults, setCourseResults] = useState<Course[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [courseSearching, setCourseSearching] = useState(false);
  const [loadingCourse, setLoadingCourse] = useState(false);
  const [fullCourse, setFullCourse] = useState<Course | null>(null);

  // Map / location
  const mapRef = useRef<MapView>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const [userCoord, setUserCoord] = useState<{ latitude: number; longitude: number; altitude?: number | null } | null>(null);
  const [measurePin, setMeasurePin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [onCourse, setOnCourse] = useState(true);
  const [following, setFollowing] = useState(true);
  const [locGranted, setLocGranted] = useState(false);

  // Score panel
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelAnim = useRef(new Animated.Value(COLLAPSED_H)).current;

  // Namespace saved progress by user so logging into a different account on
  // the same device doesn't pick up the previous user's in-progress round.
  const SAVE_KEY = `scores_${user?.user_id ?? 'anon'}_${id}`;

  // ── Live progress upload (so friends can watch) ─────────────────────────────
  // First update fires immediately when scoring starts (so the backend's
  // active-round query has a row to find). Subsequent updates are debounced
  // 2s after the last score change to avoid hammering the API.
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReportedOnce = useRef(false);
  useEffect(() => {
    if (selectingCourse || holes.length === 0 || scores.length === 0 || !teebox) return;
    const send = () => {
      api.matches.progress(id, {
        holeScores: scores.slice(0, Math.max(currentHole + 1, 1)),
        holeStats: holeStats.slice(0, Math.max(currentHole + 1, 1)),
        teeboxId: teebox.teebox_id,
      }).catch(() => { });
    };
    if (!hasReportedOnce.current) {
      hasReportedOnce.current = true;
      send();
      return;
    }
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(send, 2000);
    return () => { if (progressTimer.current) clearTimeout(progressTimer.current); };
  }, [scores, holeStats, currentHole, selectingCourse, holes.length, id, teebox]);

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const m = await api.matches.get(id);
      setMatch(m);

      // Read any saved local progress (scores + course/teebox the player previously chose)
      let saved: { scores?: number[]; currentHole?: number; teeboxId?: string; courseId?: string; holeStats?: HoleStat[] } | null = null;
      try {
        const raw = await AsyncStorage.getItem(SAVE_KEY);
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }

      // Resolve which course/teebox to load — only look at THIS user's player row,
      // because every player in a match can pick their own course/teebox.
      // Falls back to locally-saved choice if I haven't picked yet (challenge
      // matches don't persist teebox to match_players until scores submit).
      const myPlayer = m.players?.find((p: any) => p.user_id === user?.user_id);
      const courseIdToLoad = myPlayer?.course_id ?? saved?.courseId;
      const teeboxIdToLoad = myPlayer?.teebox_id ?? saved?.teeboxId;

      if (courseIdToLoad && teeboxIdToLoad) {
        const courseDetails: Course = await api.courses.get(courseIdToLoad);
        const tb: Teebox | undefined = courseDetails.teeboxes?.find(
          (t) => t.teebox_id === teeboxIdToLoad
        );
        if (tb && tb.holes?.length > 0) {
          // Use the teebox's own num_holes as ground truth (fixes 9-hole matches
          // opened via the match lobby which may not have ?holes= in the URL).
          const effectiveHoles = tb.num_holes ?? numHoles;
          if (effectiveHoles !== numHoles) setNumHoles(effectiveHoles);
          const sorted = [...tb.holes].sort((a, b) => a.hole_num - b.hole_num).slice(0, effectiveHoles);
          setCourse(courseDetails);
          setTeebox(tb);
          setHoles(sorted);
          setScores(saved?.scores ?? sorted.map((h) => h.par));
          setHoleStats(
            saved?.holeStats && Array.isArray(saved.holeStats)
              ? saved.holeStats
              : sorted.map(() => ({}))
          );
          setCurrentHole(saved?.currentHole ?? 0);
          setSelectingCourse(false);
          // Notify friends a round has started (idempotent — backend only fires once)
          api.matches.started(id).catch(() => { });
          // Hydrate any previously-saved shot tracks for this round
          api.matches.listShotTracks(id, user?.user_id).then((rows) => {
            const byHole: Record<number, ShotPoint[]> = {};
            for (const r of rows) byHole[r.hole_num] = r.shots ?? [];
            setShotsByHole(byHole);
          }).catch(() => { });
        }
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, [id, user?.user_id]);

  useEffect(() => { load(); }, [load]);

  // Nearby courses for the course selection step
  useEffect(() => {
    if (!selectingCourse) return;
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const results = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearbyCourses(results);
      } catch { /* silent */ } finally {
        setLoadingNearby(false);
      }
    })();
  }, [selectingCourse]);

  // ── Location tracking ───────────────────────────────────────────────────────

  useEffect(() => {
    if (selectingCourse) return;
    let active = true;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      setLocGranted(true);

      // maximumAge: 0 forces a fresh GPS fix (prevents stale cached position bug)
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        maximumAge: 0,
      } as any);
      if (!active) return;
      const coord = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        altitude: pos.coords.altitude, // meters, may be null on some devices
      };
      const cLat = course?.latitude ?? 0;
      const cLng = course?.longitude ?? 0;
      const near = !cLat || distMetres(coord.latitude, coord.longitude, cLat, cLng) <= ON_COURSE_METRES;
      setOnCourse(near);
      setUserCoord(coord);
      if (!near) setFollowing(false);

      watchRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2 },
        (loc) => {
          if (!active) return;
          const c = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            altitude: loc.coords.altitude,
          };
          const near2 = !cLat || distMetres(c.latitude, c.longitude, cLat, cLng) <= ON_COURSE_METRES;
          setOnCourse(near2);
          if (!near2) setFollowing(false);
          setUserCoord(c);
        },
      );
    })();
    return () => {
      active = false;
      watchRef.current?.remove();
    };
  }, [selectingCourse, course]);

  // Follow user on map
  useEffect(() => {
    if (following && onCourse && userCoord && mapRef.current) {
      mapRef.current.animateToRegion(
        { latitude: userCoord.latitude, longitude: userCoord.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 },
        400,
      );
    }
  }, [userCoord, following, onCourse]);

  // ── Panel gesture ────────────────────────────────────────────────────────────

  const dragStartHeight = useRef(COLLAPSED_H);

  const snapPanel = (toExpanded: boolean) => {
    setPanelExpanded(toExpanded);
    Animated.spring(panelAnim, {
      toValue: toExpanded ? EXPANDED_H : COLLAPSED_H,
      useNativeDriver: false,
      friction: 12,
      tension: 120,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dy }) => Math.abs(dy) > 6,
      onPanResponderGrant: () => {
        panelAnim.stopAnimation((val) => { dragStartHeight.current = val; });
      },
      onPanResponderMove: (_, { dy }) => {
        const next = Math.max(COLLAPSED_H, Math.min(EXPANDED_H, dragStartHeight.current - dy));
        panelAnim.setValue(next);
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        const endH = Math.max(COLLAPSED_H, Math.min(EXPANDED_H, dragStartHeight.current - dy));
        const mid = (COLLAPSED_H + EXPANDED_H) / 2;
        const toExpanded = vy < -0.3 || (Math.abs(vy) <= 0.3 && endH > mid);
        snapPanel(toExpanded);
      },
    })
  ).current;

  // ── Course selection helpers ─────────────────────────────────────────────────

  const searchCourses = useCallback(async (q: string) => {
    setCourseQuery(q);
    if (q.length < 2) { setCourseResults([]); return; }
    setCourseSearching(true);
    try {
      const results = await api.courses.search(q);
      setCourseResults(results);
    } finally { setCourseSearching(false); }
  }, []);

  const selectTeebox = (t: Teebox, c: Course) => {
    // Each player chooses their own teebox AND round length.
    // diff18() on the backend normalises 9-hole rounds to 18-hole equivalents
    // so different teeboxes (and different hole counts) compare fairly.
    const want = chosenRoundHoles ?? 18;
    const playableHoles = Math.min(t.num_holes, want, (t.holes ?? []).length);
    const h = [...(t.holes ?? [])].sort((a, b) => a.hole_num - b.hole_num).slice(0, playableHoles);
    if (h.length === 0) {
      Alert.alert(
        'No Hole Data',
        'This tee box doesn\'t have hole-by-hole data. Try a different tee or course.',
      );
      return;
    }
    setNumHoles(playableHoles);
    setTeebox(t);
    setCourse(c);
    setHoles(h);
    setScores(h.map((hole) => hole.par));
    setHoleStats(h.map(() => ({})));
    setSelectingCourse(false);
    setCurrentHole(0);
    // Notify friends a round has started (idempotent — backend only fires once)
    api.matches.started(id).catch(() => { });
  };

  // ── Shot tracking ───────────────────────────────────────────────────────────

  const currentHoleNum = holes[currentHole]?.hole_num;
  const currentShots = currentHoleNum != null ? (shotsByHole[currentHoleNum] ?? []) : [];

  const persistShots = (holeNum: number, next: ShotPoint[]) => {
    api.matches.saveShotTrack(id, holeNum, next).catch(() => { /* best-effort */ });
  };

  const recordShot = () => {
    if (!userCoord || currentHoleNum == null) {
      Alert.alert('No GPS', 'Wait for a GPS lock before tracking shots.');
      return;
    }
    setShotsByHole((prev) => {
      const cur = prev[currentHoleNum] ?? [];
      const point: ShotPoint = { lat: userCoord.latitude, lng: userCoord.longitude };
      if (typeof userCoord.altitude === 'number') point.elevation_m = userCoord.altitude;
      const next = [...cur, point];
      persistShots(currentHoleNum, next);
      return { ...prev, [currentHoleNum]: next };
    });
  };

  const undoShot = () => {
    if (currentHoleNum == null) return;
    setShotsByHole((prev) => {
      const cur = prev[currentHoleNum] ?? [];
      if (!cur.length) return prev;
      const next = cur.slice(0, -1);
      persistShots(currentHoleNum, next);
      return { ...prev, [currentHoleNum]: next };
    });
  };

  // ── Pin (center of green) — community-contributed location & distance ──────

  // Local override for pins set during this round (so the UI updates immediately
  // even though the holes API response is cached in our state).
  type LocalPin = { lat: number; lng: number; elevation_m?: number | null };
  const [pinByHole, setPinByHole] = useState<Record<string, LocalPin>>({});
  const currentHoleObj = holes[currentHole];
  const knownPin: LocalPin | null = currentHoleObj
    ? (pinByHole[currentHoleObj.hole_id] ??
       (currentHoleObj.pin_lat != null && currentHoleObj.pin_lng != null
         ? {
             lat: currentHoleObj.pin_lat,
             lng: currentHoleObj.pin_lng,
             elevation_m: currentHoleObj.pin_elevation_m ?? null,
           }
         : null))
    : null;

  const yardsToPin = (knownPin && userCoord)
    ? Math.round(distYards(userCoord.latitude, userCoord.longitude, knownPin.lat, knownPin.lng))
    : null;

  // Slope adjustment: each metre of elevation gain adds ~1.09 yards to the
  // play distance (and conversely, downhill plays shorter). Only computed
  // when we have both pin and player altitude AND the difference is large
  // enough to be meaningful (≥ 2 yards) — suppresses GPS noise on flat holes.
  const slopeAdjustment = (() => {
    if (!knownPin || !userCoord || yardsToPin == null) return null;
    const pinElev = knownPin.elevation_m;
    const userAlt = userCoord.altitude;
    if (typeof pinElev !== 'number' || typeof userAlt !== 'number') return null;
    const elevDiffM = pinElev - userAlt;       // positive = uphill
    const adj = Math.round(elevDiffM * 1.09);  // yards of correction
    if (Math.abs(adj) < 2) return null;        // too small to surface
    return { adj, playsLike: yardsToPin + adj, uphill: adj > 0 };
  })();

  const markPin = () => {
    if (!userCoord || !currentHoleObj) {
      Alert.alert('No GPS', 'Wait for a GPS lock before marking the pin.');
      return;
    }
    const elevation_m = typeof userCoord.altitude === 'number' ? userCoord.altitude : null;
    const point: LocalPin = { lat: userCoord.latitude, lng: userCoord.longitude, elevation_m };
    setPinByHole((prev) => ({ ...prev, [currentHoleObj.hole_id]: point }));
    api.matches.contributePin(id, currentHoleObj.hole_id, point.lat, point.lng, elevation_m)
      .catch((e: any) => {
        // Roll back local override so the user can retry rather than silently
        // believing the pin was saved.
        setPinByHole((prev) => {
          const next = { ...prev };
          delete next[currentHoleObj.hole_id];
          return next;
        });
        Alert.alert('Could not save pin', e?.message ?? 'Try again.');
      });
  };

  const pickCourse = async (c: Course) => {
    setLoadingCourse(true);
    try {
      const details = await api.courses.get(c.course_id);
      setFullCourse(details);
    } catch (e: any) { Alert.alert('Error', e.message); } finally { setLoadingCourse(false); }
  };

  // ── Leave / Cancel / Forfeit ────────────────────────────────────────────────

  const saveAndLeave = useCallback(async () => {
    try {
      await AsyncStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          scores,
          holeStats,
          currentHole,
          teeboxId: teebox?.teebox_id,
          courseId: course?.course_id,
        })
      );
    } catch { /* best-effort */ }
    router.back();
  }, [scores, holeStats, currentHole, teebox, course, SAVE_KEY]);

  const doCancel = useCallback(async () => {
    setForfeiting(true);
    try {
      await api.matches.cancel(id);
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      router.replace('/(tabs)/' as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setForfeiting(false);
    }
  }, [id, SAVE_KEY]);

  const doForfeit = useCallback(async () => {
    setForfeiting(true);
    try {
      await api.matches.forfeit(id);
      // Clear any saved progress
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      router.replace(`/match/${id}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setForfeiting(false);
    }
  }, [id, SAVE_KEY]);

  const handleLeave = useCallback(() => {
    // "Cancel" (no ELO) is offered when the user is still in course selection
    // OR has not advanced past hole 0 with no score changes — backend enforces
    // the real rule (no player completed = safe to cancel).
    const noScoringStarted = selectingCourse || currentHole === 0;

    const buttons: any[] = [
      { text: 'Keep Playing', style: 'cancel' },
      { text: 'Save & Leave', onPress: saveAndLeave },
    ];

    if (noScoringStarted) {
      buttons.push({
        text: 'Cancel Match',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Cancel Match?',
            'The match will be deleted. No ELO penalty for anyone.',
            [
              { text: 'Keep Match', style: 'cancel' },
              { text: 'Cancel Match', style: 'destructive', onPress: doCancel },
            ]
          );
        },
      });
    } else {
      buttons.push({
        text: 'Forfeit Match',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Forfeit?',
            'You will take an ELO penalty. This cannot be undone.',
            [
              { text: 'Keep Playing', style: 'cancel' },
              { text: 'Forfeit', style: 'destructive', onPress: doForfeit },
            ]
          );
        },
      });
    }

    Alert.alert('Leave Round', 'What would you like to do?', buttons);
  }, [saveAndLeave, doCancel, doForfeit, selectingCourse, currentHole]);

  // ── Scoring helpers ─────────────────────────────────────────────────────────

  const adjustScore = (delta: number) => {
    // Guard against currentHole drifting out of bounds (e.g. holes were resliced
    // or scoring screen briefly mounts before holes load).
    if (currentHole < 0 || currentHole >= holes.length) return;
    const fallbackPar = holes[currentHole]?.par ?? 4;
    setScores((prev) => {
      const next = [...prev];
      next[currentHole] = Math.max(1, Math.min(20, (next[currentHole] ?? fallbackPar) + delta));
      return next;
    });
  };

  const goToHole = (dir: 1 | -1) => {
    const next = currentHole + dir;
    if (next < 0 || next >= holes.length) return;
    setCurrentHole(next);
  };

  const jumpToHole = (index: number) => {
    setScorecardVisible(false);
    setCurrentHole(index);
  };

  const handleSubmit = () => {
    Alert.alert(
      'Submit Scores?',
      `Total: ${scores.reduce((a, b) => a + b, 0)} strokes\n\nThis will finalise your round.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Submit', onPress: doSubmit },
      ]
    );
  };

  const doSubmit = async () => {
    setSubmitting(true);
    try {
      const result = await api.matches.submitScores(id, {
        holeScores: scores,
        holeStats,
        courseId: course?.course_id,
        teeboxId: teebox?.teebox_id,
      });
      // Clear saved progress on successful submit
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      const perkEarned = result?.result?.perkAwarded === 'lucky_round';
      if (result.result && !result.result.perkAwarded) {
        // Match fully resolved — go straight to the post-match page where
        // the win/loss/draw card is rendered from authoritative server data.
        router.replace(`/match/${id}` as any);
      } else if (result.result && perkEarned) {
        Alert.alert(
          'Lucky Round Earned',
          'You marked the pin on enough holes to earn a Lucky Round perk! It will double your win or prevent a loss on your next ranked match.',
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }]
        );
      } else {
        const msg = perkEarned
          ? 'Round submitted! You also earned a Lucky Round perk for marking the pin on enough holes.'
          : 'Waiting for the other side to finish — check back soon.';
        Alert.alert(
          perkEarned ? 'Lucky Round Earned' : 'Round Submitted',
          msg,
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }]
        );
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / course selection ───────────────────────────────────────────────

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  if (selectingCourse) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Select Course</Text>
        <TextInput
          style={styles.searchInput}
          value={courseQuery}
          onChangeText={searchCourses}
          placeholder="Search course or city..."
          placeholderTextColor={C.textMuted}
          autoFocus
        />
        {(courseSearching || loadingCourse) && <ActivityIndicator color={C.gold} style={{ marginTop: 12 }} />}
        <ScrollView style={{ flex: 1 }}>
          {!fullCourse ? (
            courseQuery.length < 2 ? (
              loadingNearby
                ? <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />
                : nearbyCourses.length > 0 && (
                  <>
                    <Text style={styles.nearbyLabel}>Nearby</Text>
                    {nearbyCourses.map((c) => (
                      <TouchableOpacity key={c.course_id} style={styles.courseCard} onPress={() => pickCourse(c)}>
                        <Text style={styles.courseName}>{c.course_name}</Text>
                        <Text style={styles.courseLocation}>{[c.city, c.state].filter(Boolean).join(', ')}</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                )
            ) : courseResults.map((c) => (
              <TouchableOpacity key={c.course_id} style={styles.courseCard} onPress={() => pickCourse(c)}>
                <Text style={styles.courseName}>{c.course_name}</Text>
                <Text style={styles.courseLocation}>{[c.city, c.state].filter(Boolean).join(', ')}</Text>
              </TouchableOpacity>
            ))
          ) : (
            <>
              <Text style={styles.sectionTitle}>{fullCourse.course_name}</Text>
              <Text style={styles.subtitle}>{[fullCourse.city, fullCourse.state].filter(Boolean).join(', ')}</Text>
              <TouchableOpacity
                onPress={() => { setFullCourse(null); setChosenRoundHoles(null); }}
                style={{ marginBottom: 8, paddingHorizontal: 20 }}
              >
                <Text style={{ color: C.gold }}>← Choose different course</Text>
              </TouchableOpacity>

              {/* Step: pick round length (9 or 18) */}
              {chosenRoundHoles == null ? (
                <>
                  <Text style={styles.holesLabel}>How many holes?</Text>
                  <View style={styles.holesRow}>
                    {([9, 18] as const).map((n) => (
                      <TouchableOpacity
                        key={n}
                        style={styles.holesBtn}
                        onPress={() => setChosenRoundHoles(n)}
                      >
                        <Text style={styles.holesBtnText}>{n} Holes</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : (
                <>
                  {/* Step: pick teebox (only those long enough for the chosen length) */}
                  <TouchableOpacity
                    onPress={() => setChosenRoundHoles(null)}
                    style={{ marginBottom: 8, paddingHorizontal: 20 }}
                  >
                    <Text style={{ color: C.gold }}>← Change round length ({chosenRoundHoles})</Text>
                  </TouchableOpacity>
                  {(fullCourse.teeboxes ?? []).filter((t) => t.num_holes >= chosenRoundHoles).length === 0 && (
                    <Text style={{ color: C.textMuted, paddingHorizontal: 20, marginTop: 12 }}>
                      No tee boxes for {chosenRoundHoles} holes at this course.
                    </Text>
                  )}
                  {(fullCourse.teeboxes ?? []).filter((t) => t.num_holes >= chosenRoundHoles).map((t) => (
                    <TouchableOpacity
                      key={t.teebox_id}
                      style={[styles.teeboxCard, (t.holes ?? []).length === 0 && styles.teeboxCardDisabled]}
                      onPress={() => selectTeebox(t, fullCourse)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.teeboxName}>{t.name} Tees</Text>
                        <Text style={styles.teeboxMeta}>
                          {t.num_holes} holes · Par {t.par} · {t.total_yards?.toLocaleString()} yds
                          {(t.holes ?? []).length === 0 ? '  ·  No hole data' : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.rating}>Rating {t.course_rating}</Text>
                        <Text style={styles.slope}>Slope {t.slope_rating}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  if (holes.length === 0 || !holes[currentHole]) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  // ── Scoring view ─────────────────────────────────────────────────────────────

  const hole = holes[currentHole];
  const score = scores[currentHole] ?? hole.par;
  const sl = scoreLabel(score, hole.par);
  const totalScore = scores.reduce((a, b) => a + b, 0);
  const totalPar = holes.reduce((a, h) => a + h.par, 0);
  const scoreToPar = totalScore - totalPar;
  const isLastHole = currentHole === holes.length - 1;

  const front = holes.slice(0, 9);
  const back = holes.slice(9);
  const frontParTotal = front.reduce((a, h) => a + h.par, 0);
  const backParTotal = back.reduce((a, h) => a + h.par, 0);
  const frontScoreTotal = front.reduce((a, h, i) => a + (scores[i] ?? h.par), 0);
  const backScoreTotal = back.reduce((a, h, i) => a + (scores[9 + i] ?? h.par), 0);

  const cLat = course?.latitude ?? 0;
  const cLng = course?.longitude ?? 0;
  const initialRegion: Region = {
    latitude: userCoord && onCourse ? userCoord.latitude : (cLat || 37.5),
    longitude: userCoord && onCourse ? userCoord.longitude : (cLng || -100),
    latitudeDelta: 0.004,
    longitudeDelta: 0.004,
  };

  const measureDist = userCoord && measurePin
    ? distYards(userCoord.latitude, userCoord.longitude, measurePin.latitude, measurePin.longitude)
    : null;

  const scoreParColor = scoreToPar < 0 ? C.green : scoreToPar > 0 ? C.red : C.text;

  return (
    <View style={styles.container}>
      {/* ── Map (fills screen) ── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation={locGranted}
        showsMyLocationButton={false}
        showsCompass
        mapType="satellite"
        onPress={(e) => {
          setMeasurePin(e.nativeEvent.coordinate);
          setFollowing(false);
        }}
        onPanDrag={() => setFollowing(false)}
      >
        {measurePin && (
          <>
            <Marker coordinate={measurePin} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={styles.pinOuter}>
                <View style={styles.pinInner} />
              </View>
            </Marker>
            {userCoord && (
              <Polyline
                coordinates={[userCoord, measurePin]}
                strokeColor={C.gold}
                strokeWidth={2}
                lineDashPattern={[6, 4]}
              />
            )}
          </>
        )}

        {/* Pin marker (center of green) for the current hole */}
        {knownPin && (
          <Marker
            coordinate={{ latitude: knownPin.lat, longitude: knownPin.lng }}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={styles.pinMarker}>
              <View style={styles.pinMarkerHead} />
              <View style={styles.pinMarkerStaff} />
            </View>
          </Marker>
        )}

        {/* Shot track for the current hole — each shot a different color line */}
        {currentShots.map((sh, i) => {
          if (i === 0) return null;
          const prev = currentShots[i - 1];
          return (
            <Polyline
              key={`shot-line-${i}`}
              coordinates={[
                { latitude: prev.lat, longitude: prev.lng },
                { latitude: sh.lat, longitude: sh.lng },
              ]}
              strokeColor={SHOT_COLORS[(i - 1) % SHOT_COLORS.length]}
              strokeWidth={3}
            />
          );
        })}
        {currentShots.map((sh, i) => (
          <Marker
            key={`shot-${i}`}
            coordinate={{ latitude: sh.lat, longitude: sh.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={[styles.shotDot, { backgroundColor: SHOT_COLORS[i % SHOT_COLORS.length] }]}>
              <Text style={styles.shotDotText}>{i + 1}</Text>
            </View>
          </Marker>
        ))}
      </MapView>

      {/* ── Top bar (floats over map) ── */}
      <View style={styles.topBar}>
        {/* Leave button — replaces the old ✕ + separate leaveBtn */}
        <TouchableOpacity onPress={handleLeave} style={styles.topBarLeave} disabled={forfeiting}>
          {forfeiting
            ? <ActivityIndicator color={C.textMuted} size="small" />
            : <Text style={styles.topBarLeaveText}>⋮</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.topBarCenter}
          onPress={() => course && router.push(`/course/${course.course_id}` as any)}
          activeOpacity={0.7}
        >
          <Text style={styles.courseName2} numberOfLines={1}>{course?.course_name}</Text>
          <Text style={styles.teeboxName2}>{teebox?.name} · {holes.length} holes</Text>
        </TouchableOpacity>
        <View style={styles.topBarRight}>
          <Text style={[styles.scoreToPar, { color: scoreParColor }]}>
            {scoreToPar === 0 ? 'E' : scoreToPar > 0 ? `+${scoreToPar}` : `${scoreToPar}`}
          </Text>
          <TouchableOpacity style={styles.topBarBtn} onPress={() => setScorecardVisible(true)}>
            <Text style={styles.topBarBtnText}>Card</Text>
          </TouchableOpacity>
          {onCourse ? (
            <TouchableOpacity
              style={[styles.topBarBtn, following && styles.topBarBtnActive]}
              onPress={() => {
                if (!onCourse) return;
                setFollowing(true);
                if (userCoord && mapRef.current) {
                  mapRef.current.animateToRegion(
                    { latitude: userCoord.latitude, longitude: userCoord.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 },
                    400,
                  );
                }
              }}
            >
              <Text style={[styles.topBarBtnText, following && { color: C.gold }]}>
                {following ? 'GPS' : 'Find Me'}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.topBarBtn, { opacity: 0.4 }]}>
              <Text style={styles.topBarBtnText}>Off Course</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Track-shot button (floats over the map, right side) ── */}
      <TouchableOpacity
        style={styles.trackShotBtn}
        onPress={recordShot}
        onLongPress={undoShot}
        delayLongPress={500}
        disabled={!userCoord}
      >
        <Text style={styles.trackShotLabel}>TRACK SHOT</Text>
        <Text style={styles.trackShotCount}>
          {currentShots.length === 0 ? 'Tap to begin' : `Shot ${currentShots.length + 1}`}
        </Text>
        {currentShots.length > 0 && (
          <Text style={styles.trackShotHint}>Hold to undo</Text>
        )}
      </TouchableOpacity>

      {/* ── Pin distance / Mark Pin button (right side, below track shot) ── */}
      {yardsToPin != null ? (
        <View style={styles.pinDistChip}>
          <Text style={styles.pinDistLabel}>TO PIN</Text>
          <Text style={styles.pinDistVal}>{yardsToPin} yds</Text>
          {slopeAdjustment && (
            <Text style={styles.pinDistPlaysLike}>
              plays {slopeAdjustment.playsLike}  ({slopeAdjustment.uphill ? '+' : ''}{slopeAdjustment.adj})
            </Text>
          )}
        </View>
      ) : (
        <TouchableOpacity
          style={styles.markPinBtn}
          onPress={markPin}
          disabled={!userCoord}
        >
          <Text style={styles.markPinLabel}>MARK PIN</Text>
          <Text style={styles.markPinHint}>Stand on the green</Text>
        </TouchableOpacity>
      )}

      {/* ── Measure distance banner ── */}
      {measureDist !== null && (
        <View style={styles.distBanner}>
          <Text style={styles.distNum}>{Math.round(measureDist)} yds</Text>
          <TouchableOpacity onPress={() => setMeasurePin(null)} style={styles.distClear}>
            <Text style={styles.distClearText}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Score panel (collapsible, anchored at bottom) ── */}
      <Animated.View style={[styles.panel, { height: panelAnim }]}>
        <View style={styles.panelHandle} {...panResponder.panHandlers}>
          <TouchableOpacity onPress={() => snapPanel(!panelExpanded)} activeOpacity={0.6}>
            <View style={styles.handleBar} />
          </TouchableOpacity>
          <View style={styles.collapsedRow}>
            <TouchableOpacity
              style={[styles.miniNavBtn, currentHole === 0 && styles.miniNavBtnDisabled]}
              onPress={(e) => { e.stopPropagation?.(); goToHole(-1); }}
              disabled={currentHole === 0}
            >
              <Text style={styles.miniNavText}>←</Text>
            </TouchableOpacity>

            <View style={styles.holeSummary}>
              <Text style={styles.holeSummaryHole}>
                Hole {hole.hole_num}
                <Text style={styles.holeSummaryPar}>  Par {hole.par}{hole.yardage ? `  ·  ${hole.yardage} yds` : ''}</Text>
              </Text>
              <View style={styles.scoreSummaryRow}>
                <Text style={[styles.scoreSummaryNum, { color: sl.color }]}>{score}</Text>
                <Text style={[styles.scoreSummaryLabel, { color: sl.color }]}>{sl.label}</Text>
              </View>
            </View>

            {isLastHole ? (
              <TouchableOpacity
                style={styles.miniSubmitBtn}
                onPress={(e) => { e.stopPropagation?.(); handleSubmit(); }}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator color="#000" size="small" />
                  : <Text style={styles.miniSubmitText}>Submit</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.miniNavBtn}
                onPress={(e) => { e.stopPropagation?.(); goToHole(1); }}
              >
                <Text style={styles.miniNavText}>→</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {panelExpanded && (
          <View style={styles.expandedContent}>
            {hole.handicap != null && (
              <Text style={styles.hcapLine}>Handicap {hole.handicap}</Text>
            )}

            <View style={styles.scoreRow}>
              <TouchableOpacity style={styles.scoreBtn} onPress={() => adjustScore(-1)}>
                <Text style={styles.scoreBtnText}>−</Text>
              </TouchableOpacity>
              <View style={styles.scoreCenter}>
                <Text style={styles.scoreNum}>{score}</Text>
              </View>
              <TouchableOpacity style={styles.scoreBtn} onPress={() => adjustScore(1)}>
                <Text style={styles.scoreBtnText}>+</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.quickScoreRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[styles.quickBtn, score === n && { backgroundColor: C.gold }]}
                  onPress={() => setScores((prev) => { const next = [...prev]; next[currentHole] = n; return next; })}
                >
                  <Text style={[styles.quickBtnText, score === n && { color: '#000' }]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Per-hole stats — putts, chips, fairway hit. All optional. */}
            <View style={styles.statsRow}>
              <StatStepper
                label="Putts"
                value={holeStats[currentHole]?.putts ?? null}
                onChange={(v) => setHoleStats((prev) => {
                  const next = [...prev];
                  next[currentHole] = { ...(next[currentHole] ?? {}), putts: v };
                  return next;
                })}
              />
              <StatStepper
                label="Chips"
                value={holeStats[currentHole]?.chips ?? null}
                onChange={(v) => setHoleStats((prev) => {
                  const next = [...prev];
                  next[currentHole] = { ...(next[currentHole] ?? {}), chips: v };
                  return next;
                })}
              />
              {hole.par >= 4 && (
                <TouchableOpacity
                  style={[
                    styles.fwBtn,
                    holeStats[currentHole]?.fairwayHit === true && styles.fwBtnHit,
                    holeStats[currentHole]?.fairwayHit === false && styles.fwBtnMiss,
                  ]}
                  onPress={() => setHoleStats((prev) => {
                    const next = [...prev];
                    const cur = next[currentHole]?.fairwayHit;
                    // Cycle through: null → true (hit) → false (miss) → null
                    const nextVal: boolean | null | undefined =
                      cur === undefined || cur === null ? true
                      : cur === true ? false
                      : null;
                    next[currentHole] = { ...(next[currentHole] ?? {}), fairwayHit: nextVal as any };
                    return next;
                  })}
                >
                  <Text style={styles.fwLabel}>FAIRWAY</Text>
                  <Text style={[
                    styles.fwValue,
                    holeStats[currentHole]?.fairwayHit === true && { color: C.green },
                    holeStats[currentHole]?.fairwayHit === false && { color: C.red },
                  ]}>
                    {holeStats[currentHole]?.fairwayHit === true ? 'HIT'
                     : holeStats[currentHole]?.fairwayHit === false ? 'MISS'
                     : '—'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.navRow}>
              <TouchableOpacity
                style={[styles.navBtn, currentHole === 0 && styles.navBtnDisabled]}
                onPress={() => goToHole(-1)}
                disabled={currentHole === 0}
              >
                <Text style={styles.navBtnText}>← Prev</Text>
              </TouchableOpacity>
              {isLastHole ? (
                <TouchableOpacity
                  style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                  onPress={handleSubmit}
                  disabled={submitting}
                >
                  {submitting
                    ? <ActivityIndicator color="#000" />
                    : <Text style={styles.submitBtnText}>Submit Round</Text>}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.nextBtn} onPress={() => goToHole(1)}>
                  <Text style={styles.nextBtnText}>Next →</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      </Animated.View>

      {/* ── Scorecard Modal ── */}
      <Modal
        visible={scorecardVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setScorecardVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{course?.course_name}</Text>
              <Text style={styles.modalSub}>{teebox?.name} Tees · Par {totalPar}</Text>
            </View>
            <TouchableOpacity style={styles.modalClose} onPress={() => setScorecardVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 40 }}>
            <View style={styles.scRow}>
              <Text style={[styles.scCell, styles.scHoleCol, styles.scHeader]}>HOLE</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>PAR</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>YDS</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>HCP</Text>
              <Text style={[styles.scCell, styles.scScoreCol, styles.scHeader]}>SCORE</Text>
            </View>

            {holes.map((h, i) => {
              const s = scores[i] ?? h.par;
              const isActive = i === currentHole;
              return (
                <TouchableOpacity key={h.hole_id} onPress={() => jumpToHole(i)}>
                  <View style={[styles.scRow, isActive && styles.scRowActive]}>
                    <View style={[styles.scCell, styles.scHoleCol, { alignItems: 'flex-start' }]}>
                      <View style={[styles.holeNumBadge, isActive && { backgroundColor: C.gold }]}>
                        <Text style={[styles.holeNumBadgeText, isActive && { color: '#000' }]}>{h.hole_num}</Text>
                      </View>
                    </View>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.par}</Text>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.yardage ?? '—'}</Text>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.handicap ?? '—'}</Text>
                    <Text style={[styles.scCell, styles.scScoreCol, styles.scScore, { color: scoreColor(s, h.par) }]}>{s}</Text>
                  </View>
                  {(i === 8 && holes.length > 9) && (
                    <View style={styles.subtotalRow}>
                      <Text style={styles.subtotalLabel}>OUT</Text>
                      <Text style={styles.subtotalPar}>{frontParTotal}</Text>
                      <Text style={[styles.subtotalScore, { color: frontScoreTotal - frontParTotal < 0 ? C.green : frontScoreTotal - frontParTotal > 0 ? C.red : C.text }]}>
                        {frontScoreTotal}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {holes.length > 9 && (
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>IN</Text>
                <Text style={styles.subtotalPar}>{backParTotal}</Text>
                <Text style={[styles.subtotalScore, { color: backScoreTotal - backParTotal < 0 ? C.green : backScoreTotal - backParTotal > 0 ? C.red : C.text }]}>
                  {backScoreTotal}
                </Text>
              </View>
            )}
            <View style={[styles.subtotalRow, styles.totalRow]}>
              <Text style={[styles.subtotalLabel, { color: C.gold }]}>TOTAL</Text>
              <Text style={[styles.subtotalPar, { color: C.gold }]}>{totalPar}</Text>
              <Text style={[styles.subtotalScore, { color: scoreToPar < 0 ? C.green : scoreToPar > 0 ? C.red : C.gold, fontSize: 18 }]}>
                {totalScore}
              </Text>
            </View>
            <Text style={styles.tapHint}>Tap a hole to jump to it</Text>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },

  // Course selection
  backBtn: { marginBottom: 10, marginTop: 60, paddingHorizontal: 20 },
  backBtnText: { color: C.gold, fontSize: 16 },
  title: { color: C.text, fontSize: 24, fontWeight: '900', paddingHorizontal: 20, marginBottom: 4 },
  subtitle: { color: C.textMuted, fontSize: 13, paddingHorizontal: 20, marginBottom: 12 },
  sectionTitle: { color: C.text, fontSize: 18, fontWeight: '800', paddingHorizontal: 20, marginBottom: 4, marginTop: 8 },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border, marginHorizontal: 20, marginBottom: 10,
  },
  nearbyLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 8, paddingHorizontal: 20 },
  courseCard: { backgroundColor: C.card, borderRadius: 6, padding: 14, marginHorizontal: 20, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  courseLocation: { color: C.gold, fontSize: 12, marginTop: 3 },
  teeboxCard: { backgroundColor: C.cardAlt, borderRadius: 6, padding: 16, marginHorizontal: 20, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.border },
  teeboxCardDisabled: { opacity: 0.45 },
  holesLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 8, marginBottom: 6, paddingHorizontal: 20 },
  holesRow: { flexDirection: 'row', gap: 10, marginHorizontal: 20, marginBottom: 14 },
  holesBtn: { flex: 1, paddingVertical: 14, borderRadius: 6, alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  holesBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },
  teeboxName: { color: C.text, fontWeight: '700', fontSize: 15 },
  teeboxMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  rating: { color: C.gold, fontWeight: '700', fontSize: 12 },
  slope: { color: C.textMuted, fontSize: 12 },

  // Top bar (floating over map) — no separate leave button anymore
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 56, paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: C.bg + 'dd',
    borderBottomWidth: 1, borderBottomColor: C.border + '88',
    gap: 8,
  },
  topBarLeave: {
    width: 36, height: 36, borderRadius: 6, backgroundColor: C.card + 'cc',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  topBarLeaveText: { color: C.textMuted, fontSize: 20, fontWeight: '700', lineHeight: 22 },
  topBarCenter: { flex: 1 },
  courseName2: { color: C.text, fontWeight: '700', fontSize: 13 },
  teeboxName2: { color: C.textMuted, fontSize: 10 },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scoreToPar: { fontSize: 20, fontWeight: '900', marginRight: 4 },
  topBarBtn: {
    backgroundColor: C.card + 'cc', borderRadius: 4, paddingHorizontal: 9, paddingVertical: 5,
    borderWidth: 1, borderColor: C.border,
  },
  topBarBtnActive: { borderColor: C.gold },
  topBarBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 11 },

  // Shot tracking
  trackShotBtn: {
    position: 'absolute', right: 12, top: 140,
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1, borderColor: C.gold,
    paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 6, minWidth: 86,
  },
  trackShotLabel: { color: C.gold, fontWeight: '800', fontSize: 10, letterSpacing: 1.2 },
  trackShotCount: { color: C.text, fontWeight: '700', fontSize: 12, marginTop: 3 },
  trackShotHint: { color: C.textDim, fontSize: 9, marginTop: 2 },
  shotDot: {
    width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 3,
  },
  shotDotText: { color: '#fff', fontWeight: '900', fontSize: 11 },

  // Pin distance + Mark Pin
  pinDistChip: {
    position: 'absolute', right: 12, top: 222,
    backgroundColor: C.green + 'ee',
    borderRadius: 8, borderWidth: 1, borderColor: '#fff',
    paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', minWidth: 86,
  },
  pinDistLabel: { color: '#fff', fontWeight: '800', fontSize: 9, letterSpacing: 1.2 },
  pinDistVal: { color: '#fff', fontWeight: '900', fontSize: 16, marginTop: 2, fontFamily: F.serif },
  pinDistPlaysLike: { color: '#fff', fontWeight: '700', fontSize: 10, marginTop: 2, opacity: 0.9 },
  markPinBtn: {
    position: 'absolute', right: 12, top: 222,
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1, borderColor: C.green,
    paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center', minWidth: 86,
  },
  markPinLabel: { color: C.green, fontWeight: '800', fontSize: 10, letterSpacing: 1.2 },
  markPinHint: { color: C.textDim, fontSize: 9, marginTop: 2 },

  // Pin marker on the map (small red flag)
  pinMarker: { width: 18, height: 24, alignItems: 'center' },
  pinMarkerHead: {
    width: 12, height: 8, backgroundColor: C.red,
    borderRadius: 1, borderWidth: 1, borderColor: '#fff',
  },
  pinMarkerStaff: {
    width: 1.5, height: 16, backgroundColor: '#fff',
    marginTop: -1,
  },

  // Measure pin
  pinOuter: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: C.gold + 'aa', borderWidth: 2, borderColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
  },
  pinInner: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },

  // Distance banner
  distBanner: {
    position: 'absolute',
    bottom: COLLAPSED_H + 12,
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bg + 'f0', borderRadius: 6,
    borderWidth: 1, borderColor: C.gold,
    paddingVertical: 10, paddingHorizontal: 18,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 8,
  },
  distNum: { fontFamily: F.serif, color: C.gold, fontSize: 24, fontWeight: '700' },
  distClear: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.border },
  distClearText: { color: C.textMuted, fontWeight: '700', fontSize: 11 },

  // Collapsible score panel
  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: C.bg + 'f5',
    borderTopWidth: 1, borderTopColor: C.border,
    overflow: 'hidden',
  },
  panelHandle: { paddingTop: 8, paddingBottom: 4, paddingHorizontal: 16 },
  handleBar: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 10,
  },
  collapsedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12,
  },
  holeSummary: { flex: 1, alignItems: 'center' },
  holeSummaryHole: { color: C.text, fontWeight: '700', fontSize: 13 },
  holeSummaryPar: { color: C.textMuted, fontWeight: '400', fontSize: 12 },
  scoreSummaryRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  scoreSummaryNum: { fontFamily: F.serif, fontSize: 28, fontWeight: '700' },
  scoreSummaryLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  miniNavBtn: {
    width: 44, height: 44, borderRadius: 4, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  miniNavBtnDisabled: { opacity: 0.3 },
  miniNavText: { color: C.text, fontSize: 18, fontWeight: '700' },
  miniSubmitBtn: {
    paddingHorizontal: 12, height: 44, borderRadius: 4,
    backgroundColor: C.gold, justifyContent: 'center', alignItems: 'center',
  },
  miniSubmitText: { color: '#000', fontWeight: '900', fontSize: 13 },

  // Expanded panel content
  expandedContent: { paddingHorizontal: 16, paddingBottom: 8 },
  hcapLine: { color: C.textDim, fontSize: 11, letterSpacing: 1, textAlign: 'center', marginBottom: 8 },

  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  scoreBtn: {
    width: 58, height: 58, borderRadius: 6, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: C.border,
  },
  scoreBtnText: { color: C.text, fontSize: 30, fontWeight: '300' },
  scoreCenter: { width: 110, alignItems: 'center' },
  scoreNum: { fontFamily: F.serif, fontSize: 64, fontWeight: '700', color: C.text, lineHeight: 72 },

  quickScoreRow: { flexDirection: 'row', gap: 5, justifyContent: 'center', marginBottom: 12 },
  statsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, marginBottom: 12, paddingVertical: 4,
  },
  fwBtn: {
    flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4,
    borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  fwBtnHit: { borderColor: C.green },
  fwBtnMiss: { borderColor: C.red },
  fwLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  fwValue: { color: C.text, fontSize: 14, fontWeight: '800' },
  quickBtn: {
    width: 34, height: 34, borderRadius: 4, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  quickBtnText: { color: C.text, fontWeight: '700', fontSize: 13 },

  navRow: { flexDirection: 'row', gap: 10 },
  navBtn: { flex: 1, backgroundColor: C.card, borderRadius: 6, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  navBtnDisabled: { opacity: 0.3 },
  navBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },
  nextBtn: { flex: 2, backgroundColor: C.gold + '22', borderRadius: 6, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.gold },
  nextBtnText: { color: C.gold, fontWeight: '800', fontSize: 14 },
  submitBtn: { flex: 2, backgroundColor: C.gold, borderRadius: 6, padding: 12, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },

  // Scorecard modal
  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  modalSub: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  modalClose: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 8 },
  modalCloseText: { color: '#000', fontWeight: '800', fontSize: 14 },
  modalScroll: { flex: 1 },

  scRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: C.border + '55',
  },
  scRowActive: { backgroundColor: C.card },
  scHeader: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  scCell: { justifyContent: 'center' },
  scHoleCol: { width: 48 },
  scStatCol: { flex: 1, textAlign: 'center' },
  scScoreCol: { width: 52, textAlign: 'right' },
  scText: { color: C.text, fontSize: 14 },
  scScore: { fontSize: 16, fontWeight: '800', textAlign: 'right' },

  holeNumBadge: {
    width: 32, height: 32, borderRadius: 4, backgroundColor: C.surface,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  holeNumBadgeText: { color: C.text, fontWeight: '800', fontSize: 13 },

  subtotalRow: {
    flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 16,
    backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  subtotalLabel: { width: 48, color: C.textMuted, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  subtotalPar: { flex: 3, color: C.textMuted, fontSize: 13, textAlign: 'center' },
  subtotalScore: { width: 52, fontWeight: '800', fontSize: 15, textAlign: 'right' },
  totalRow: { backgroundColor: C.cardAlt, marginTop: 2 },

  tapHint: { color: C.textDim, fontSize: 12, textAlign: 'center', marginTop: 16 },
});
