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
import { C, F } from '../../../lib/colors';
import { Hole, Teebox, Course } from '../../../types';

const { width: SCREEN_W } = Dimensions.get('window');
const COLLAPSED_H = 92;
const EXPANDED_H = 348;
const ON_COURSE_METRES = 3 * 1609.34;

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

// ── Screen ───────────────────────────────────────────────────────────────────

export default function ScoringScreen() {
  const { id, holes: holesParam } = useLocalSearchParams<{ id: string; holes?: string }>();
  // numHoles is a state so it can be corrected after loading the match's existing teebox
  const [numHoles, setNumHoles] = useState<number>(holesParam ? parseInt(holesParam, 10) : 18);

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

  // Course selection
  const [selectingCourse, setSelectingCourse] = useState(true);
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
  const [userCoord, setUserCoord] = useState<{ latitude: number; longitude: number } | null>(null);
  const [measurePin, setMeasurePin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [onCourse, setOnCourse] = useState(true);
  const [following, setFollowing] = useState(true);
  const [locGranted, setLocGranted] = useState(false);

  // Score panel
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelAnim = useRef(new Animated.Value(COLLAPSED_H)).current;

  const SAVE_KEY = `scores_${id}`;

  // ── Live progress upload (so friends can watch) ─────────────────────────────
  // Sends scores to backend ~3s after the last edit so friends watching the
  // user's profile see live updates without hammering the API on every tap.
  // We also include teeboxId so the backend can persist it on match_players
  // for matches where no teebox was set at creation (e.g. friend challenges).
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (selectingCourse || holes.length === 0 || scores.length === 0 || !teebox) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => {
      api.matches.progress(id, {
        holeScores: scores.slice(0, currentHole + 1),
        teeboxId: teebox.teebox_id,
      }).catch(() => { });
    }, 3000);
    return () => { if (progressTimer.current) clearTimeout(progressTimer.current); };
  }, [scores, currentHole, selectingCourse, holes.length, id, teebox]);

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const m = await api.matches.get(id);
      setMatch(m);

      // Read any saved local progress (scores + course/teebox the player previously chose)
      let saved: { scores?: number[]; currentHole?: number; teeboxId?: string; courseId?: string } | null = null;
      try {
        const raw = await AsyncStorage.getItem(SAVE_KEY);
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }

      // Resolve which course/teebox to load: server-side player data wins,
      // but fall back to the locally-saved choice (challenge matches don't
      // persist teebox to the match record until scores are submitted).
      const playerWithTeebox = m.players?.find((p: any) => p.teebox_id && p.course_id);
      const courseIdToLoad = playerWithTeebox?.course_id ?? saved?.courseId;
      const teeboxIdToLoad = playerWithTeebox?.teebox_id ?? saved?.teeboxId;

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
          setCurrentHole(saved?.currentHole ?? 0);
          setSelectingCourse(false);
          // Notify friends a round has started (idempotent — backend only fires once)
          api.matches.started(id).catch(() => { });
        }
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

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
      const coord = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
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
          const c = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
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
    const h = [...(t.holes ?? [])].sort((a, b) => a.hole_num - b.hole_num).slice(0, numHoles);
    if (h.length === 0) {
      Alert.alert(
        'No Hole Data',
        'This tee box doesn\'t have hole-by-hole data. Try a different tee or course.',
      );
      return;
    }
    setTeebox(t);
    setCourse(c);
    setHoles(h);
    setScores(h.map((hole) => hole.par));
    setSelectingCourse(false);
    setCurrentHole(0);
    // Notify friends a round has started (idempotent — backend only fires once)
    api.matches.started(id).catch(() => { });
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
          currentHole,
          teeboxId: teebox?.teebox_id,
          courseId: course?.course_id,
        })
      );
    } catch { /* best-effort */ }
    router.back();
  }, [scores, currentHole, teebox, course, SAVE_KEY]);

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
    setScores((prev) => {
      const next = [...prev];
      next[currentHole] = Math.max(1, Math.min(20, (next[currentHole] ?? holes[currentHole].par) + delta));
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
        courseId: course?.course_id,
        teeboxId: teebox?.teebox_id,
      });
      // Clear saved progress on successful submit
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      if (result.result) {
        const r = result.result;
        const won = r.winnerSide === 1;
        const oppLine = r.autoMatched && r.opponentUsername ? `vs ${r.opponentUsername}` : '';
        const eloLine = !match?.is_practice ? `ELO ${won ? '+' : ''}${won ? r.deltaElo : -r.deltaElo}` : 'Practice — no ELO';
        Alert.alert(
          won ? 'Victory' : 'Defeat',
          [oppLine, `Score: ${result.totalScore}`, eloLine].filter(Boolean).join('\n'),
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }]
        );
      } else {
        Alert.alert(
          'Round Submitted',
          'Finding your opponent — check back soon to see your result.',
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
              <TouchableOpacity onPress={() => setFullCourse(null)} style={{ marginBottom: 8, paddingHorizontal: 20 }}>
                <Text style={{ color: C.gold }}>← Choose different course</Text>
              </TouchableOpacity>
              {(fullCourse.teeboxes ?? []).filter((t) => t.num_holes >= numHoles).length === 0 && (
                <Text style={{ color: C.textMuted, paddingHorizontal: 20, marginTop: 12 }}>
                  No tee boxes available for {numHoles} holes at this course.
                </Text>
              )}
              {(fullCourse.teeboxes ?? []).filter((t) => t.num_holes >= numHoles).map((t) => (
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
