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
import { isPremium } from '../../../lib/premium';
import { adjustDistance, windComponents, metersToFeet } from '../../../lib/weatherAdjust';
import { C, F } from '../../../lib/colors';
import { Hole, Teebox, Course } from '../../../types';

const { width: SCREEN_W } = Dimensions.get('window');
const COLLAPSED_H = 110;
const EXPANDED_H = 380;
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
  // `club` and `lie` are optional and feed per-club stats / heatmap. Tracking
  // a club is opt-in: a player can record shots without ever picking one.
  type ShotPoint = { lat: number; lng: number; elevation_m?: number; club?: string; lie?: string };
  const [shotsByHole, setShotsByHole] = useState<Record<number, ShotPoint[]>>({});
  // Pre-selected club for the next shot, persisted across taps. Cleared on hole change.
  const [pendingClub, setPendingClub] = useState<string | null>(null);
  const [clubPickerVisible, setClubPickerVisible] = useState(false);
  // Advanced detail entry modal — miss directions + per-putt distance sliders
  const [advancedVisible, setAdvancedVisible] = useState(false);

  // Weather conditions — fetched once per round (course location-based) and
  // refreshed every 15 min while playing. Drives the premium "plays-like"
  // distance adjustment.
  type WeatherData = {
    temperature_f: number | null;
    wind_speed_mph: number | null;
    wind_from_bearing: number | null;
    rain: 'none' | 'light' | 'heavy';
    elevation_ft: number | null;
  };
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherSheetVisible, setWeatherSheetVisible] = useState(false);
  const userIsPremium = isPremium(user as any);
  // Elevation of the user's home course, used as a baseline so altitude
  // effects on plays-like distance are RELATIVE to where the player normally
  // calibrates their distances. e.g. a player who lives at 5,000 ft will
  // see a NEGATIVE altitude adjustment when playing at sea level (ball
  // flies shorter than they're used to). Fetched once per round.
  const [homeElevationFt, setHomeElevationFt] = useState<number | null>(null);

  // Per-hole stat tracking — putts, chips, fairway hit. Indexed by the hole
  // INDEX in our holes array (not hole_num) so we can submit it as a parallel
  // array alongside scores. Tracking is opt-in: untouched holes stay empty.
  type HoleStat = {
    putts?: number;
    chips?: number;
    gir?: boolean | null;
    fairwayHit?: boolean | null;
    // Advanced entry — direction of miss when fairway/green wasn't hit.
    fairwayMiss?: 'left' | 'right' | null;
    greenMiss?: 'left' | 'right' | 'short' | 'long' | null;
    // One distance entry per putt taken (in feet). Length should match `putts`.
    // Allowed stops: 3, 6, 10, 15, 20, 30, 40, 50.
    puttDistances?: number[];
  };
  const [holeStats, setHoleStats] = useState<HoleStat[]>([]);
  // Per-hole record of which fields the user manually set. Auto-derivation
  // from tracked shots will only overwrite fields NOT in this set, so user
  // taps always win.
  const [manualFields, setManualFields] = useState<Record<number, Set<string>>>({});
  const markManual = (holeIdx: number, ...fields: string[]) => {
    setManualFields((prev) => {
      const cur = prev[holeIdx] ?? new Set<string>();
      const next = new Set(cur);
      for (const f of fields) next.add(f);
      return { ...prev, [holeIdx]: next };
    });
  };

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
      // Tag with the currently-selected club so the per-club aggregator can
      // bucket this shot. Optional — skipped if user never picked one.
      if (pendingClub) point.club = pendingClub;
      const next = [...cur, point];
      persistShots(currentHoleNum, next);
      return { ...prev, [currentHoleNum]: next };
    });
  };

  // Keep the ref pointed at the current closure so the watch listener (which
  // we register once) always operates on fresh state.
  // ── Home-course elevation baseline ─────────────────────────────────────
  // One-time fetch when we know the user's home course coordinates. Reused
  // by the altitude adjustment so distances are calibrated relative to where
  // the player typically plays. Premium-only since it's only consumed by
  // the plays-like math, which is itself premium.
  useEffect(() => {
    if (!userIsPremium) return;
    const homeLat = (user as any)?.home_course_lat;
    const homeLng = (user as any)?.home_course_lng;
    if (typeof homeLat !== 'number' || typeof homeLng !== 'number') return;
    let cancelled = false;
    api.weather.current(homeLat, homeLng)
      .then((d) => { if (!cancelled && d.elevation_ft != null) setHomeElevationFt(d.elevation_ft); })
      .catch(() => { /* non-fatal — falls back to absolute altitude */ });
    return () => { cancelled = true; };
  }, [userIsPremium, (user as any)?.home_course_lat, (user as any)?.home_course_lng]);

  // ── Weather fetching ───────────────────────────────────────────────────
  // Premium-only — non-premium users get the upgrade prompt instead, so we
  // don't bother hitting the upstream for them. Refreshes every 15 min.
  useEffect(() => {
    if (!userCoord || !userIsPremium) return;
    let cancelled = false;
    const load = () => {
      api.weather.current(userCoord.latitude, userCoord.longitude)
        .then(d => { if (!cancelled) setWeather(d); })
        .catch(() => { /* silent — weather is non-essential */ });
    };
    load();
    const id = setInterval(load, 15 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
    // Only re-key on coarse position change to avoid spamming the upstream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIsPremium,
      userCoord ? Math.round(userCoord.latitude * 100) : null,
      userCoord ? Math.round(userCoord.longitude * 100) : null]);

  // ── Auto-fill hole stats from tracked shots ────────────────────────────
  // Whenever the current hole's shot list changes, derive fairwayHit/Miss,
  // gir/greenMiss, putts, chips from GPS + pin. Only applies to fields the
  // user hasn't manually set (tracked in `manualFields[currentHole]`).
  useEffect(() => {
    if (currentHoleNum == null) return;
    const hole = holes[currentHole];
    if (!hole) return;
    const shots = currentShots;
    if (shots.length === 0) return;
    const inferred = inferHoleStatsFromShots(shots, {
      par: hole.par,
      pin_lat: hole.pin_lat,
      pin_lng: hole.pin_lng,
    });
    if (Object.keys(inferred).length === 0) return;

    const manual = manualFields[currentHole] ?? new Set<string>();
    setHoleStats((prev) => {
      const next = [...prev];
      const cur = next[currentHole] ?? {};
      const merged: any = { ...cur };
      let changed = false;
      for (const [k, v] of Object.entries(inferred)) {
        if (manual.has(k)) continue;          // user-owned → don't touch
        if ((merged as any)[k] === v) continue; // already up to date
        merged[k] = v;
        changed = true;
      }
      if (!changed) return prev;
      next[currentHole] = merged;
      return next;
    });
    // currentShots is a new array each render so include only its length / last
    // coordinates as deps to avoid infinite loops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHole, currentShots.length, currentShots[currentShots.length - 1]?.lat, currentShots[currentShots.length - 1]?.lng]);

  // Set/replace the club tag on the most-recent shot of the current hole.
  const setLastShotClub = (club: string | null) => {
    if (currentHoleNum == null) return;
    setPendingClub(club);
    setShotsByHole((prev) => {
      const cur = prev[currentHoleNum] ?? [];
      if (!cur.length) return prev; // no shot yet — pendingClub will tag the next one
      const last = { ...cur[cur.length - 1] };
      if (club) last.club = club; else delete last.club;
      const next = [...cur.slice(0, -1), last];
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

  // Weather-adjusted plays-like distance — premium feature. Layers altitude,
  // temperature, wind, and rain on top of the slope-adjusted yardage.
  const weatherAdjustment = (() => {
    if (!userIsPremium || !weather || yardsToPin == null) return null;
    const baseYds = (slopeAdjustment?.playsLike ?? yardsToPin); // start from slope-adjusted
    if (weather.temperature_f == null) return null;             // need the basics

    // Derive shot bearing (player → pin) for wind decomposition.
    let along = 0;
    if (knownPin && userCoord && weather.wind_speed_mph && weather.wind_from_bearing != null) {
      const lat1 = userCoord.latitude * Math.PI / 180;
      const lat2 = knownPin.lat * Math.PI / 180;
      const dLng = (knownPin.lng - userCoord.longitude) * Math.PI / 180;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      const shotBearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      const comps = windComponents(weather.wind_speed_mph, weather.wind_from_bearing, shotBearingDeg);
      along = comps.along_mph;
    }

    // Use measured GPS altitude as a fallback if upstream elevation is missing.
    const courseAltFt = weather.elevation_ft
      ?? (typeof userCoord?.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);

    // Altitude effect is RELATIVE to the player's home course when one is set.
    // A player who calibrates their distances at 5,000 ft will see a negative
    // adjustment when playing at sea level (denser air → less carry than they
    // expect). When no home course is known, falls back to absolute altitude
    // (i.e. sea-level baseline).
    const altDeltaFt = homeElevationFt != null
      ? courseAltFt - homeElevationFt
      : courseAltFt;

    const adj = adjustDistance(baseYds, {
      altitudeFt:   altDeltaFt,
      temperatureF: weather.temperature_f,
      windAlongMph: along,
      rain:         weather.rain,
    });
    const effective = Math.round(baseYds + (-adj.effective_delta_yds));
    if (Math.abs(effective - baseYds) < 2) return null;
    return {
      effective, breakdown: adj, windAlong: along,
      altRelative: homeElevationFt != null,
      altDeltaFt,
    };
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
    setPendingClub(null); // reset club tag between holes
  };

  const jumpToHole = (index: number) => {
    setScorecardVisible(false);
    setCurrentHole(index);
    setPendingClub(null);
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

      {/* ── Top action row: WEATHER · TRACK SHOT · CLUB ── */}
      <View style={styles.topActionRow}>
        {/* WEATHER — premium users see live conditions; free users see a lock that prompts upgrade. */}
        <TouchableOpacity
          style={[styles.topChip, !userIsPremium && styles.topChipLocked]}
          onPress={() => setWeatherSheetVisible(true)}
          activeOpacity={0.7}
        >
          {userIsPremium && weather ? (
            <>
              <Text style={styles.topChipLabel}>WX</Text>
              <Text style={styles.topChipValue}>
                {weather.temperature_f != null ? `${weather.temperature_f}°` : '—'}
                {weather.wind_speed_mph != null ? ` · ${weather.wind_speed_mph}mph` : ''}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.topChipLabel}>WEATHER</Text>
              <Text style={styles.topChipValue}>👑</Text>
            </>
          )}
        </TouchableOpacity>

        {/* TRACK SHOT — record a GPS waypoint. Long-press to undo. */}
        <TouchableOpacity
          style={[styles.topChip, styles.topChipPrimary, !userCoord && { opacity: 0.4 }]}
          onPress={recordShot}
          onLongPress={undoShot}
          delayLongPress={500}
          disabled={!userCoord}
          activeOpacity={0.7}
        >
          <Text style={[styles.topChipLabel, { color: C.gold }]}>TRACK SHOT</Text>
          <Text style={styles.topChipValue}>
            {currentShots.length === 0 ? 'Tap to begin' : `Shot ${currentShots.length + 1}`}
          </Text>
        </TouchableOpacity>

        {/* CLUB tag — opens picker for the current/next shot. */}
        <TouchableOpacity
          style={styles.topChip}
          onPress={() => setClubPickerVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.topChipLabel}>CLUB</Text>
          <Text style={styles.topChipValue}>
            {currentShots[currentShots.length - 1]?.club?.toUpperCase()
              ?? pendingClub?.toUpperCase()
              ?? '—'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Club picker modal */}
      <Modal
        visible={clubPickerVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setClubPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.clubPickerBackdrop}
          activeOpacity={1}
          onPress={() => setClubPickerVisible(false)}
        >
          <View style={styles.clubPickerSheet}>
            <Text style={styles.clubPickerTitle}>Tag Club</Text>
            <Text style={styles.clubPickerSub}>
              {currentShots.length === 0
                ? 'Pre-select a club for your next tracked shot'
                : `Tagging shot #${currentShots.length}`}
            </Text>
            <View style={styles.clubGrid}>
              {(['driver','3w','5w','7w','hybrid','3i','4i','5i','6i','7i','8i','9i','pw','gw','sw','lw','putter'] as const).map(c => {
                const active = (currentShots[currentShots.length - 1]?.club ?? pendingClub) === c;
                return (
                  <TouchableOpacity
                    key={c}
                    style={[styles.clubBtn, active && styles.clubBtnActive]}
                    onPress={() => { setLastShotClub(c); setClubPickerVisible(false); }}
                  >
                    <Text style={[styles.clubBtnText, active && { color: C.bg }]}>{c.toUpperCase()}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={styles.clubClearBtn} onPress={() => { setLastShotClub(null); setClubPickerVisible(false); }}>
              <Text style={styles.clubClearText}>Clear tag</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Advanced entry modal — fairway/green miss directions + per-putt distances */}
      <AdvancedEntryModal
        visible={advancedVisible}
        onClose={() => setAdvancedVisible(false)}
        holePar={holes[currentHole]?.par ?? 4}
        stat={holeStats[currentHole]}
        onChange={(patch) => {
          markManual(currentHole, ...Object.keys(patch));
          setHoleStats((prev) => {
            const next = [...prev];
            next[currentHole] = { ...(next[currentHole] ?? {}), ...patch };
            return next;
          });
        }}
      />

      {/* ── Pin distance / Mark Pin — bottom-right, lifts with the score panel ── */}
      <Animated.View style={[
        styles.pinDistAnchor,
        // Sit 12px above the panel's current top edge, regardless of
        // collapsed/expanded state.
        { bottom: Animated.add(panelAnim, new Animated.Value(12)) },
      ]}>
        {yardsToPin != null ? (
          <View style={[styles.mapChipBase, styles.pinDistChip]}>
            <Text style={styles.pinDistLabel}>TO PIN</Text>
            <Text style={styles.pinDistVal}>{yardsToPin} yds</Text>
            {(() => {
              // Combined adjusted distance: weatherAdjustment.effective already
              // layers weather on top of the slope-adjusted base. If only slope
              // is available (free user, no weather data), fall back to that.
              const adjusted = weatherAdjustment?.effective ?? slopeAdjustment?.playsLike ?? null;
              if (adjusted == null || adjusted === yardsToPin) return null;
              const delta = adjusted - yardsToPin;
              const sign = delta > 0 ? '+' : '';
              return (
                <Text style={styles.pinDistPlaysLike}>
                  plays {adjusted} ({sign}{delta})
                </Text>
              );
            })()}
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.markPinBtnSmall, !userCoord && { opacity: 0.4 }]}
            onPress={() => {
              if (!userCoord) {
                Alert.alert('No GPS', 'Wait for a GPS lock before marking the pin.');
                return;
              }
              Alert.alert(
                'Confirm Pin Location',
                'Are you standing at the cup right now? This GPS reading will become the pin location for everyone playing this hole.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Yes, mark it', style: 'default', onPress: markPin },
                ],
              );
            }}
            disabled={!userCoord}
            activeOpacity={0.7}
          >
            <Text style={styles.markPinLabelSmall}>MARK</Text>
            <Text style={styles.markPinLabelSmall}>PIN</Text>
          </TouchableOpacity>
        )}
      </Animated.View>

      {/* Weather details sheet */}
      <Modal
        visible={weatherSheetVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setWeatherSheetVisible(false)}
      >
        <TouchableOpacity
          style={styles.advBackdrop}
          activeOpacity={1}
          onPress={() => setWeatherSheetVisible(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow */ }}>
            <View style={styles.advSheet}>
              <Text style={styles.advTitle}>{userIsPremium ? 'Conditions' : 'Weather'}</Text>
              {!userIsPremium ? (
                // Free users: simple paywall — no live weather data shown.
                <View style={styles.wxLockBox}>
                  <Text style={styles.wxLockTitle}>👑 Premium feature</Text>
                  <Text style={styles.wxLockBody}>
                    See live conditions and plays-like distances auto-adjusted
                    for altitude, temperature, wind, and rain.
                  </Text>
                  <TouchableOpacity
                    style={styles.wxLockBtn}
                    onPress={() => { setWeatherSheetVisible(false); router.push('/premium' as any); }}
                  >
                    <Text style={styles.wxLockBtnText}>UNLOCK PREMIUM</Text>
                  </TouchableOpacity>
                </View>
              ) : weather ? (
                <>
                  <View style={styles.wxGrid}>
                    <WxStat label="TEMP"   value={weather.temperature_f != null ? `${weather.temperature_f}°F` : '—'} />
                    <WxStat label="WIND"   value={weather.wind_speed_mph != null ? `${weather.wind_speed_mph} mph` : '—'} />
                    <WxStat label="RAIN"   value={weather.rain.toUpperCase()} />
                    <WxStat label="ELEV"   value={weather.elevation_ft != null ? `${weather.elevation_ft} ft` : '—'} />
                  </View>
                  {weatherAdjustment && yardsToPin != null && (
                    <>
                      <Text style={styles.advSection}>PLAYS-LIKE BREAKDOWN</Text>
                      <Text style={styles.wxBaseLine}>
                        Base distance: {yardsToPin} yds
                      </Text>
                      <WxRow
                        label={weatherAdjustment.altRelative ? 'Altitude vs home' : 'Altitude'}
                        yds={weatherAdjustment.breakdown.altitude_yds}
                        extra={weatherAdjustment.altRelative
                          ? `${weatherAdjustment.altDeltaFt > 0 ? '+' : ''}${weatherAdjustment.altDeltaFt} ft`
                          : undefined}
                      />
                      <WxRow label="Temperature"  yds={weatherAdjustment.breakdown.temperature_yds} />
                      <WxRow label="Wind"         yds={weatherAdjustment.breakdown.wind_yds} extra={
                        weatherAdjustment.windAlong > 0
                          ? `${Math.round(weatherAdjustment.windAlong)} mph tailwind`
                          : weatherAdjustment.windAlong < 0
                            ? `${Math.round(-weatherAdjustment.windAlong)} mph headwind`
                            : 'crosswind only'
                      } />
                      <WxRow label="Rain"         yds={weatherAdjustment.breakdown.rain_yds} />
                      <View style={styles.totalDivider2} />
                      <View style={styles.wxTotalRow}>
                        <Text style={styles.wxTotalLabel}>PLAYS LIKE</Text>
                        <Text style={styles.wxTotalVal}>{weatherAdjustment.effective} yds</Text>
                      </View>
                    </>
                  )}
                </>
              ) : null}
              <TouchableOpacity style={styles.advCloseBtn} onPress={() => setWeatherSheetVisible(false)}>
                <Text style={styles.advCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Measure distance banner — centered, lifts with score panel ── */}
      {measureDist !== null && (() => {
        const raw = Math.round(measureDist);
        // Apply weather adjustments to the measure distance for premium users.
        // Slope isn't included here because we don't know the elevation of
        // the tapped point — only the pin chip has slope info.
        let adjusted: number | null = null;
        if (userIsPremium && weather?.temperature_f != null) {
          const courseAltFt = weather.elevation_ft
            ?? (typeof userCoord?.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);
          const altDeltaFt = homeElevationFt != null ? courseAltFt - homeElevationFt : courseAltFt;
          // Wind component along measure-line
          let along = 0;
          if (measurePin && userCoord && weather.wind_speed_mph && weather.wind_from_bearing != null) {
            const lat1 = userCoord.latitude * Math.PI / 180;
            const lat2 = measurePin.latitude * Math.PI / 180;
            const dLng = (measurePin.longitude - userCoord.longitude) * Math.PI / 180;
            const y = Math.sin(dLng) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
            const shotBearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
            along = windComponents(weather.wind_speed_mph, weather.wind_from_bearing, shotBearingDeg).along_mph;
          }
          const adj = adjustDistance(raw, {
            altitudeFt: altDeltaFt,
            temperatureF: weather.temperature_f,
            windAlongMph: along,
            rain: weather.rain,
          });
          const eff = Math.round(raw + (-adj.effective_delta_yds));
          if (Math.abs(eff - raw) >= 2) adjusted = eff;
        }
        return (
          <Animated.View style={[
            styles.distBanner,
            { bottom: Animated.add(panelAnim, new Animated.Value(20)) },
          ]}>
            <View>
              <Text style={styles.distNum}>{raw} yds</Text>
              {adjusted != null && (
                <Text style={styles.distAdj}>
                  plays {adjusted} ({adjusted > raw ? '+' : ''}{adjusted - raw})
                </Text>
              )}
            </View>
            <TouchableOpacity onPress={() => setMeasurePin(null)} style={styles.distClear}>
              <Text style={styles.distClearText}>Clear</Text>
            </TouchableOpacity>
          </Animated.View>
        );
      })()}

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

            {/* Single DETAILS button — opens the full hole-detail modal where
                putts, chips, fairway, GIR, and putt distances all live. */}
            <TouchableOpacity
              style={styles.detailBtn}
              onPress={() => setAdvancedVisible(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.detailBtnLabel}>HOLE DETAILS</Text>
              {(() => {
                const hs = holeStats[currentHole];
                const manual = manualFields[currentHole] ?? new Set<string>();
                const bits: string[] = [];
                if (hs?.putts != null) bits.push(`${hs.putts} putt${hs.putts === 1 ? '' : 's'}`);
                if (hs?.chips != null && hs.chips > 0) bits.push(`${hs.chips} chip${hs.chips === 1 ? '' : 's'}`);
                if (hs?.fairwayHit === true) bits.push('FW hit');
                if (hs?.fairwayHit === false) bits.push(`FW ${hs.fairwayMiss ?? 'miss'}`);
                if (hs?.gir === true) bits.push('GIR');
                if (hs?.gir === false) bits.push(`grn ${hs.greenMiss ?? 'miss'}`);
                const hasAuto = ['fairwayHit','fairwayMiss','gir','greenMiss','putts','chips']
                  .some(k => (hs as any)?.[k] !== undefined && !manual.has(k));
                if (!bits.length) {
                  return <Text style={styles.detailBtnHint}>tap to enter putts, chips, FW, GIR…</Text>;
                }
                return (
                  <Text style={styles.detailBtnSummary}>
                    {hasAuto && '⚡ '}{bits.join(' · ')}
                  </Text>
                );
              })()}
            </TouchableOpacity>

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

  // ── Top action row (3 small chips: Weather · Track · Club) ─────────────
  topActionRow: {
    position: 'absolute', top: 124, left: 12, right: 12,
    flexDirection: 'row', gap: 8,
    zIndex: 5,
  },
  topChip: {
    flex: 1,
    backgroundColor: C.bg + 'ee',
    borderRadius: 6, borderWidth: 1, borderColor: C.gold + '66',
    paddingVertical: 8, paddingHorizontal: 8,
    alignItems: 'center', justifyContent: 'center', minHeight: 50,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  topChipPrimary: { borderColor: C.gold, borderWidth: 2 },
  topChipLocked:  { borderColor: C.textMuted + '88' },
  topChipLabel:   { color: C.textMuted, fontWeight: '800', fontSize: 9, letterSpacing: 1 },
  topChipValue:   { color: C.text, fontWeight: '900', fontSize: 12, marginTop: 2 },

  // ── Bottom-right pin anchor — bottom value follows panel height ────────
  pinDistAnchor: { position: 'absolute', right: 12 },

  // Floating chip base — used by pin distance / mark-pin variants.
  mapChipBase: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8,
    minWidth: 110, minHeight: 64,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  pinDistChip: { borderColor: '#fff', backgroundColor: C.green + 'ee' },
  markPinBtn:  { borderColor: C.green },

  clubPickerBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end',
  },
  clubPickerSheet: {
    backgroundColor: C.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 20, paddingBottom: 36,
    borderTopWidth: 1, borderColor: C.gold + '88',
  },
  clubPickerTitle: { color: C.gold, fontFamily: F.serif, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  clubPickerSub: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  clubGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  clubBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, minWidth: 64,
  },
  clubBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  clubBtnText: { color: C.text, fontWeight: '800', fontSize: 12, textAlign: 'center', letterSpacing: 0.6 },
  clubClearBtn: { marginTop: 14, alignSelf: 'center', padding: 8 },
  clubClearText: { color: C.textMuted, fontSize: 12 },
  shotDot: {
    width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 3,
  },
  shotDotText: { color: '#fff', fontWeight: '900', fontSize: 11 },

  // Pin distance + Mark Pin (chip variants are defined above; only the
  // text styling lives here)
  pinDistLabel: { color: '#fff', fontWeight: '800', fontSize: 9, letterSpacing: 1.2 },
  pinDistVal: { color: '#fff', fontWeight: '900', fontSize: 16, marginTop: 2, fontFamily: F.serif },
  pinDistPlaysLike: { color: '#fff', fontWeight: '700', fontSize: 11, marginTop: 3, opacity: 0.95 },

  // Weather details sheet
  wxGrid: { flexDirection: 'row', gap: 8, marginTop: 12 },
  wxStatBox: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    backgroundColor: C.bg, borderRadius: 6, borderWidth: 1, borderColor: C.border,
  },
  wxStatLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  wxStatVal: { color: C.text, fontFamily: F.serif, fontSize: 16, fontWeight: '900', marginTop: 4 },
  wxBaseLine: { color: C.textMuted, fontSize: 11, marginBottom: 6 },
  wxLineRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: C.bg, borderRadius: 6, borderWidth: 1, borderColor: C.border,
    marginBottom: 6,
  },
  wxLineLabel: { color: C.text, fontSize: 13, fontWeight: '700' },
  wxLineYds: { fontFamily: F.serif, fontSize: 14, fontWeight: '900' },
  wxLineExtra: { color: C.textMuted, fontSize: 9, marginTop: 1 },
  totalDivider2: { height: 1, backgroundColor: C.gold + '44', marginVertical: 8 },
  wxTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: C.gold + '22', borderRadius: 6, borderWidth: 1, borderColor: C.gold,
  },
  wxTotalLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },
  wxTotalVal: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },

  wxLockBox: {
    marginTop: 16, padding: 16, borderRadius: 8,
    borderWidth: 1, borderColor: C.gold + '88', backgroundColor: C.bg, alignItems: 'center',
  },
  wxLockTitle: { color: C.gold, fontWeight: '900', fontSize: 14 },
  wxLockBody: { color: C.text, fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: 8 },
  wxLockBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: C.gold, borderRadius: 6,
  },
  wxLockBtnText: { color: C.bg, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },

  // Mark Pin chip text styling (chip variant defined above)
  // Compact MARK / PIN button — stacked label, smaller footprint than the
  // floating chips so the centered distance banner has more breathing room.
  markPinBtnSmall: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1, borderColor: C.green,
    paddingHorizontal: 10, paddingVertical: 8,
    minWidth: 70, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  markPinLabelSmall: { color: C.green, fontWeight: '900', fontSize: 12, letterSpacing: 1.5, lineHeight: 14 },

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

  // Distance banner — centered, lifts with the collapsible score panel.
  distBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bg + 'f0', borderRadius: 6,
    borderWidth: 1, borderColor: C.gold,
    paddingVertical: 10, paddingHorizontal: 18,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 8,
  },
  distNum: { fontFamily: F.serif, color: C.gold, fontSize: 22, fontWeight: '700' },
  distAdj: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 2 },
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
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 28,
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
  expandedContent: { paddingHorizontal: 16, paddingBottom: 36 },
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

  // ── Single DETAILS button on the score panel ────────────────────────────
  detailBtn: {
    marginTop: 4, marginBottom: 12,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, borderColor: C.gold,
    backgroundColor: C.card, alignItems: 'center',
  },
  detailBtnLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 1.2 },
  detailBtnHint: { color: C.textMuted, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
  detailBtnSummary: { color: C.text, fontSize: 11, marginTop: 4, textAlign: 'center' },

  // Row holding the Putts/Chips steppers inside the detail modal
  advCountsRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },

  // ── Advanced entry modal ────────────────────────────────────────────────
  advBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  advSheet: {
    backgroundColor: C.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    height: '92%',
    borderTopWidth: 1, borderColor: C.gold + '88',
  },
  advSheetInner: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  advTitle: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  advSheetHeader: {
    paddingTop: 8, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  advSheetGrip: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 12,
  },
  advSheetTitleRow: { flexDirection: 'row', alignItems: 'center', paddingBottom: 12 },
  advHeaderClose: { paddingHorizontal: 12, paddingVertical: 6 },
  advHeaderCloseText: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 0.6 },
  advSection: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 18, marginBottom: 8 },

  // Direction button (LEFT / FAIRWAY / RIGHT and the green compass rose)
  dirRow: { flexDirection: 'row', gap: 6 },
  dirBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },
  dirBtnActive: { borderColor: C.gold, backgroundColor: C.gold },
  dirBtnText: { color: C.text, fontWeight: '800', fontSize: 12, letterSpacing: 0.6 },
  dirBtnTextActive: { color: C.bg },

  // Compass rose for green miss
  greenRose: { alignItems: 'center', marginTop: 4 },
  greenRoseRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginVertical: 4 },
  greenCenter: {
    width: 80, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },
  greenSide: {
    width: 80, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },

  // Per-putt slider
  putRow: { marginTop: 10 },
  putHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  putLabel: { color: C.text, fontSize: 13, fontWeight: '700' },
  putVal: { color: C.gold, fontFamily: F.serif, fontSize: 16, fontWeight: '900' },

  // SnapSlider primitive
  snapWrap: { paddingVertical: 12 },
  snapTrack: {
    height: 4, backgroundColor: C.border, borderRadius: 2,
    flexDirection: 'row', alignItems: 'center', position: 'relative',
  },
  snapFill: { position: 'absolute', left: 0, top: 0, height: 4, backgroundColor: C.gold, borderRadius: 2 },
  snapStop: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: C.cardAlt,
    borderWidth: 1, borderColor: C.border, position: 'absolute',
  },
  snapStopActive: { backgroundColor: C.gold, borderColor: C.gold },
  snapThumb: {
    position: 'absolute', width: 22, height: 22, borderRadius: 11,
    backgroundColor: C.gold, borderWidth: 2, borderColor: C.bg,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  snapStopLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 2 },
  snapStopLabel: { color: C.textMuted, fontSize: 10 },
  snapStopLabelActive: { color: C.gold, fontWeight: '900' },

  advCloseBtn: { marginTop: 20, alignSelf: 'center', padding: 10 },
  advCloseText: { color: C.gold, fontSize: 14, fontWeight: '700' },
});

// ── Geometry helpers (shared with derivation) ─────────────────────────────
const EARTH_R_M = 6371000;
const _toRad = (d: number) => d * Math.PI / 180;
function haversineYds(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = _toRad(b.lat - a.lat);
  const dLng = _toRad(b.lng - a.lng);
  const lat1 = _toRad(a.lat), lat2 = _toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return (2 * EARTH_R_M * Math.asin(Math.sqrt(h))) * 1.0936;
}
function bearingRad(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const lat1 = _toRad(a.lat), lat2 = _toRad(b.lat);
  const dLng = _toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return Math.atan2(y, x);
}

/**
 * Infer per-hole stat fields (fairwayHit/Miss, gir/greenMiss, putts, chips)
 * from a sequence of tracked shot GPS points + the hole's pin location.
 *
 * Conventions:
 *   • `shots[i]` is the GPS where shot i+1 was struck FROM. So `shots[0]` is
 *     the tee box; `shots[1]` is where the tee shot landed; `shots[2]` is
 *     where shot 2 landed; etc. The ball ending in the cup is implicit.
 *   • "GIR" = the player's `par − 2` shot landed on the green (within ~12 yds).
 *   • Fairway concept only applies to par 4+.
 *   • Green miss direction uses the tee→pin centerline as the reference axis.
 *     Right of line = positive lateral; long = past the pin along the axis.
 *
 * Returns only the fields it can confidently derive; everything else stays
 * undefined so the caller can leave manual values intact.
 */
function inferHoleStatsFromShots(
  shots: { lat: number; lng: number }[],
  hole: { par: number; pin_lat?: number | null; pin_lng?: number | null },
): {
  fairwayHit?: boolean;
  fairwayMiss?: 'left' | 'right' | null;
  gir?: boolean;
  greenMiss?: 'left' | 'right' | 'short' | 'long' | null;
  putts?: number;
  chips?: number;
} {
  if (!hole.pin_lat || !hole.pin_lng || shots.length === 0) return {};
  const pin = { lat: hole.pin_lat, lng: hole.pin_lng };
  const tee = shots[0];
  const centerB = bearingRad(tee, pin);
  const teeToPinYds = haversineYds(tee, pin);

  // Project a point onto the tee→pin axis: returns { lateral, longitudinal }
  // both in yards. Lateral positive = right of line. Longitudinal = forward.
  const project = (p: { lat: number; lng: number }) => {
    const d = haversineYds(tee, p);
    const b = bearingRad(tee, p);
    let off = b - centerB;
    while (off > Math.PI) off -= 2 * Math.PI;
    while (off < -Math.PI) off += 2 * Math.PI;
    return { lateral: d * Math.sin(off), longitudinal: d * Math.cos(off) };
  };

  const GREEN_RADIUS_YDS = 12;     // ~36 ft — typical green effective radius
  const FAIRWAY_HALF_YDS = 25;     // ~30-yd-wide fairway; ±25 yds = forgiving

  const out: ReturnType<typeof inferHoleStatsFromShots> = {};

  // Fairway hit (par 4+, needs the tee shot to have landed somewhere)
  if (hole.par >= 4 && shots.length >= 2) {
    const teeShotLanding = shots[1];
    const { lateral } = project(teeShotLanding);
    if (Math.abs(lateral) <= FAIRWAY_HALF_YDS) {
      out.fairwayHit = true;
      out.fairwayMiss = null;
    } else {
      out.fairwayHit = false;
      out.fairwayMiss = lateral > 0 ? 'right' : 'left';
    }
  }

  // GIR: did the player's `par − 2` shot land on the green?
  // shots[par - 2] is where that shot ENDED (= where the next shot was hit from).
  const girLandingIdx = hole.par - 2;
  if (girLandingIdx >= 1 && shots.length > girLandingIdx) {
    const girLanding = shots[girLandingIdx];
    const distToPin = haversineYds(girLanding, pin);
    if (distToPin <= GREEN_RADIUS_YDS) {
      out.gir = true;
      out.greenMiss = null;
    } else {
      out.gir = false;
      const { lateral, longitudinal } = project(girLanding);
      // Decide whether the dominant miss is lateral or distance.
      const distMiss = longitudinal - teeToPinYds; // + = long, − = short
      if (Math.abs(lateral) > Math.abs(distMiss)) {
        out.greenMiss = lateral > 0 ? 'right' : 'left';
      } else {
        out.greenMiss = distMiss > 0 ? 'long' : 'short';
      }
    }
  } else if (girLandingIdx >= 1 && shots.length === girLandingIdx) {
    // Player only recorded enough shots to reach the green-attempt position
    // (e.g. par 4 with 2 tracked shots). No landing position = ambiguous.
    // Skip auto-fill.
  }

  // Putts and chips — count shots whose start position implies the lie type.
  // "On green" is within ~GREEN_RADIUS_YDS of pin; chips are the band 12–30 yds.
  let putts = 0, chips = 0;
  for (let i = 1; i < shots.length; i++) {
    // shots[i] is the start position of shot (i+1). To check "did shot i+1
    // come from on/near the green", measure shots[i]'s distance to pin.
    const dist = haversineYds(shots[i], pin);
    if (dist <= GREEN_RADIUS_YDS) putts += 1;
    else if (dist <= 30) chips += 1;
  }
  if (shots.length > 1) {
    out.putts = putts;
    out.chips = chips;
  }

  return out;
}

// ── Weather details sheet helpers ────────────────────────────────────────
function WxStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.wxStatBox}>
      <Text style={styles.wxStatLabel}>{label}</Text>
      <Text style={styles.wxStatVal}>{value}</Text>
    </View>
  );
}
function WxRow({ label, yds, extra }: { label: string; yds: number; extra?: string }) {
  const rounded = Math.round(yds);
  if (Math.abs(rounded) < 1 && !extra) return null;
  const sign = rounded > 0 ? '+' : '';
  const color = rounded > 0 ? C.green : rounded < 0 ? C.red : C.text;
  return (
    <View style={styles.wxLineRow}>
      <Text style={styles.wxLineLabel}>{label}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.wxLineYds, { color }]}>{sign}{rounded} yds</Text>
        {extra && <Text style={styles.wxLineExtra}>{extra}</Text>}
      </View>
    </View>
  );
}

// ── Advanced entry modal ──────────────────────────────────────────────────
// Lets the player record the direction of fairway and green misses, plus the
// distance of each individual putt. All optional; informs strokes-gained.

const PUTT_STOPS = [3, 6, 10, 15, 20, 30, 40, 50] as const;

function AdvancedEntryModal({
  visible, onClose, holePar, stat, onChange,
}: {
  visible: boolean;
  onClose: () => void;
  holePar: number;
  stat: any | undefined;
  onChange: (patch: Record<string, any>) => void;
}) {
  const fwMiss = stat?.fairwayMiss ?? null;
  const fwHit  = stat?.fairwayHit ?? null;
  const grMiss = stat?.greenMiss ?? null;
  const gir    = stat?.gir ?? null;
  const putts  = stat?.putts ?? 0;
  const dists: number[] = stat?.puttDistances ?? [];

  // Set the i-th putt distance, padding with default 10ft for any earlier
  // putts the player hasn't dialed in yet.
  const setPuttDist = (i: number, d: number) => {
    const next = [...dists];
    while (next.length <= i) next.push(10);
    next[i] = d;
    // Trim to current putt count so we don't store stale entries.
    onChange({ puttDistances: next.slice(0, putts) });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.advBackdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.advSheet}>
          {/* Header: drag handle + title + close, fixed at top */}
          <View style={styles.advSheetHeader}>
            <View style={styles.advSheetGrip} />
            <View style={styles.advSheetTitleRow}>
              <Text style={[styles.advTitle, { flex: 1, textAlign: 'left' }]}>Hole Detail</Text>
              <TouchableOpacity onPress={onClose} style={styles.advHeaderClose}>
                <Text style={styles.advHeaderCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView
            style={styles.advSheetInner}
            contentContainerStyle={{ paddingBottom: 60 }}
            showsVerticalScrollIndicator={true}
          >

            {/* Putts + Chips counts — basic numbers */}
            <Text style={styles.advSection}>SHOT COUNTS</Text>
            <View style={styles.advCountsRow}>
              <StatStepper
                label="Putts"
                value={stat?.putts ?? null}
                onChange={(v) => onChange({ putts: v })}
              />
              <StatStepper
                label="Chips"
                value={stat?.chips ?? null}
                onChange={(v) => onChange({ chips: v })}
              />
            </View>

            {/* Fairway miss — only relevant on par 4+ */}
            {holePar >= 4 && (
              <>
                <Text style={styles.advSection}>FAIRWAY</Text>
                <View style={styles.dirRow}>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === false && fwMiss === 'left' && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: false, fairwayMiss: 'left' })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === false && fwMiss === 'left' && styles.dirBtnTextActive]}>← LEFT</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === true && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: true, fairwayMiss: null })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === true && styles.dirBtnTextActive]}>FAIRWAY</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === false && fwMiss === 'right' && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: false, fairwayMiss: 'right' })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === false && fwMiss === 'right' && styles.dirBtnTextActive]}>RIGHT →</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* Green miss — compass rose */}
            <Text style={styles.advSection}>GREEN</Text>
            <View style={styles.greenRose}>
              {/* LONG */}
              <TouchableOpacity
                style={[styles.greenSide, gir === false && grMiss === 'long' && styles.dirBtnActive]}
                onPress={() => onChange({ gir: false, greenMiss: 'long' })}
              >
                <Text style={[styles.dirBtnText, gir === false && grMiss === 'long' && styles.dirBtnTextActive]}>↑ LONG</Text>
              </TouchableOpacity>
              {/* LEFT — HIT — RIGHT */}
              <View style={styles.greenRoseRow}>
                <TouchableOpacity
                  style={[styles.greenSide, gir === false && grMiss === 'left' && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: false, greenMiss: 'left' })}
                >
                  <Text style={[styles.dirBtnText, gir === false && grMiss === 'left' && styles.dirBtnTextActive]}>← LEFT</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.greenCenter, gir === true && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: true, greenMiss: null })}
                >
                  <Text style={[styles.dirBtnText, gir === true && styles.dirBtnTextActive]}>GREEN</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.greenSide, gir === false && grMiss === 'right' && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: false, greenMiss: 'right' })}
                >
                  <Text style={[styles.dirBtnText, gir === false && grMiss === 'right' && styles.dirBtnTextActive]}>RIGHT →</Text>
                </TouchableOpacity>
              </View>
              {/* SHORT */}
              <TouchableOpacity
                style={[styles.greenSide, gir === false && grMiss === 'short' && styles.dirBtnActive]}
                onPress={() => onChange({ gir: false, greenMiss: 'short' })}
              >
                <Text style={[styles.dirBtnText, gir === false && grMiss === 'short' && styles.dirBtnTextActive]}>↓ SHORT</Text>
              </TouchableOpacity>
            </View>

            {/* Per-putt distance sliders — one per putt entered on the basic screen */}
            <Text style={styles.advSection}>
              PUTT DISTANCES {putts === 0 ? '(set Putts on the basic screen first)' : `· ${putts} putt${putts === 1 ? '' : 's'}`}
            </Text>
            {Array.from({ length: putts }).map((_, i) => (
              <View key={i} style={styles.putRow}>
                <View style={styles.putHeader}>
                  <Text style={styles.putLabel}>Putt #{i + 1}</Text>
                  <Text style={styles.putVal}>
                    {(dists[i] ?? 10) === 50 ? '50+ ft' : `${dists[i] ?? 10} ft`}
                  </Text>
                </View>
                <SnapSlider
                  stops={[...PUTT_STOPS]}
                  value={dists[i] ?? 10}
                  onChange={(v) => setPuttDist(i, v)}
                />
              </View>
            ))}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Touch-driven slider over a discrete value set. The thumb tracks the finger
// continuously while dragging (fluid feel), but the saved value always snaps
// to the nearest stop. On release, the thumb glides to the snapped position.
//
// "Magnetism" comes from the rounding-to-nearest behaviour: the saved value
// flips to the next stop only when you cross the midpoint, so each stop has
// a comfortable capture zone.
function SnapSlider({
  stops, value, onChange,
}: {
  stops: number[];
  value: number;
  onChange: (v: number) => void;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null); // null = not dragging
  const idx = Math.max(0, stops.indexOf(value));
  const segCount = stops.length - 1;
  const fracForIdx = (i: number) => (segCount === 0 ? 0 : i / segCount);

  const valueAtX = (x: number) => {
    if (trackWidth <= 0) return stops[0];
    const frac = Math.max(0, Math.min(1, x / trackWidth));
    const closestIdx = Math.round(frac * segCount);
    return stops[Math.max(0, Math.min(stops.length - 1, closestIdx))];
  };

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const x = e.nativeEvent.locationX;
      setDragX(x);
      const v = valueAtX(x);
      if (v !== value) onChange(v);
    },
    onPanResponderMove: (e) => {
      const x = e.nativeEvent.locationX;
      setDragX(x);
      const v = valueAtX(x);
      if (v !== value) onChange(v);
    },
    onPanResponderRelease: () => setDragX(null),
    onPanResponderTerminate: () => setDragX(null),
  });

  // Thumb position: follow finger continuously while dragging; otherwise
  // sit on the snapped stop. Clamped to the track bounds.
  const thumbX = dragX != null
    ? Math.max(0, Math.min(trackWidth, dragX))
    : fracForIdx(idx) * trackWidth;
  const fillPct = trackWidth > 0 ? (thumbX / trackWidth) * 100 : 0;

  return (
    <View style={styles.snapWrap} {...responder.panHandlers}>
      <View
        style={styles.snapTrack}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      >
        <View style={[styles.snapFill, { width: `${fillPct}%` }]} />
        {stops.map((s, i) => (
          <View
            key={s}
            style={[
              styles.snapStop,
              { left: `${fracForIdx(i) * 100}%`, marginLeft: -4, top: -2 },
              i <= idx && styles.snapStopActive,
            ]}
          />
        ))}
        {trackWidth > 0 && (
          <View style={[
            styles.snapThumb,
            { left: thumbX - 11, top: -9 },
          ]} />
        )}
      </View>
      <View style={styles.snapStopLabels}>
        {stops.map((s, i) => (
          <Text key={s} style={[styles.snapStopLabel, i === idx && styles.snapStopLabelActive]}>
            {s === 50 ? '50+' : s}
          </Text>
        ))}
      </View>
    </View>
  );
}
