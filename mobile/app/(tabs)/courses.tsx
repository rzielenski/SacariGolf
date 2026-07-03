import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../lib/api';
import { C } from '../../lib/colors';
import { Course } from '../../types';
import { Divider } from '../../components/Flourish';

// One-time tip shown the first time the Courses tab is opened, nudging users to
// request any course that's missing from the still-growing catalog.
const COURSE_TIP_KEY = 'courses_request_tip_seen_v1';

// Great-circle distance in miles between two lat/lng points. Used to show how
// far each course is from the player and to sort results nearest-first.
function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatMiles(d: number): string {
  if (d < 0.1) return '< 0.1 mi';
  if (d < 10) return `${d.toFixed(1)} mi`;
  return `${Math.round(d)} mi`;
}

export default function CoursesScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Course[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Monotonic request counter so out-of-order search responses can't clobber
  // newer results — only the latest in-flight request may commit state.
  const seqRef = useRef(0);
  const [nearby, setNearby] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  // The player's current location, captured once we have permission. Drives
  // the per-row distance badge and the nearest-first sort.
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  // First-visit tip: point users at the +Request flow for missing courses.
  useEffect(() => {
    (async () => {
      try {
        if (await AsyncStorage.getItem(COURSE_TIP_KEY)) return;
        await AsyncStorage.setItem(COURSE_TIP_KEY, '1');
        Alert.alert(
          "Don't see your course?",
          'Our course list is still growing. If you can’t find yours, tap “+ Request” at the top right and add the course details. We’ll get it added within the next couple of days.',
          [
            { text: 'Maybe later', style: 'cancel' },
            { text: 'Request a course', onPress: () => router.push('/course-request' as any) },
          ],
        );
      } catch { /* ignore */ }
    })();
  }, []);

  // Load nearby courses on mount
  useEffect(() => {
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        const courses = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearby(courses);
      } catch { /* silent */ } finally {
        setLoadingNearby(false);
      }
    })();
  }, []);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); setSearchError(null); return; }
    setSearching(true);
    setSearchError(null);
    // Capture a per-request sequence number; only the most recent request is
    // allowed to commit, so a slow response for an earlier query (e.g. "Peb")
    // can't overwrite the results for the current one ("Pebble").
    const seq = ++seqRef.current;
    try {
      const r = await api.courses.search(q);
      if (seq === seqRef.current) setResults(r);
    } catch {
      if (seq === seqRef.current) {
        setResults([]);
        setSearchError("Couldn't reach the server. Check your connection and try again.");
      }
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  }, []);

  const open = (c: Course) => router.push(`/course/${c.course_id}` as any);

  // Sort a list nearest-first when we know where the player is; courses with no
  // coordinates sink to the bottom. Applied to both search results and the
  // Nearby list so distance is the primary ordering everywhere.
  const sortByDistance = useCallback((list: Course[]): Course[] => {
    if (!userCoords) return list;
    const d = (c: Course) =>
      c.latitude != null && c.longitude != null
        ? distanceMiles(userCoords.lat, userCoords.lng, c.latitude, c.longitude)
        : Infinity;
    return [...list].sort((a, b) => d(a) - d(b));
  }, [userCoords]);

  const showResults = query.length >= 2;

  return (
    <View style={styles.container}>
      {/* Title row with the +Request CTA. Mirrors the +Find button on the
          Finds tab so the affordance for "this catalog is missing
          something — add it" is consistent across the app. */}
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Courses</Text>
          <Text style={styles.subtitle}>Browse courses, see leaderboards & tee info</Text>
        </View>
        <TouchableOpacity
          style={styles.requestBtn}
          onPress={() => router.push('/course-request' as any)}
          activeOpacity={0.7}
        >
          <Text style={styles.requestBtnText}>+ Request</Text>
        </TouchableOpacity>
      </View>
      <Divider style={{ marginTop: -4, marginBottom: 8 }} />

      <TextInput
        style={styles.searchInput}
        value={query}
        onChangeText={search}
        placeholder="Search course, club, city, state..."
        placeholderTextColor={C.textMuted}
        autoCorrect={false}
        autoCapitalize="words"
      />

      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
        {showResults ? (
          <>
            {searching && <ActivityIndicator color={C.gold} style={{ marginTop: 16 }} />}
            {!searching && searchError && (
              <Text style={styles.empty}>{searchError}</Text>
            )}
            {!searching && !searchError && results.length === 0 && (
              <Text style={styles.empty}>No courses match "{query}"</Text>
            )}
            {sortByDistance(results).map((c) => (
              <CourseRow key={c.course_id} course={c} userCoords={userCoords} onPress={() => open(c)} />
            ))}
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>{userCoords ? 'Nearest to you' : 'Nearby'}</Text>
            {loadingNearby
              ? <ActivityIndicator color={C.gold} style={{ marginTop: 16 }} />
              : nearby.length === 0
                ? <Text style={styles.empty}>No nearby courses found. Try searching above.</Text>
                : sortByDistance(nearby).map((c) => (
                    <CourseRow key={c.course_id} course={c} userCoords={userCoords} onPress={() => open(c)} />
                  ))
            }
          </>
        )}
      </ScrollView>
    </View>
  );
}

function CourseRow({
  course, userCoords, onPress,
}: {
  course: Course;
  userCoords: { lat: number; lng: number } | null;
  onPress: () => void;
}) {
  const dist = userCoords && course.latitude != null && course.longitude != null
    ? distanceMiles(userCoords.lat, userCoords.lng, course.latitude, course.longitude)
    : null;
  return (
    <TouchableOpacity style={styles.courseCard} onPress={onPress} activeOpacity={0.7}>
      <View style={{ flex: 1 }}>
        <Text style={styles.courseName}>{course.course_name}</Text>
        {course.club_name && course.club_name !== course.course_name && (
          <Text style={styles.clubName}>{course.club_name}</Text>
        )}
        <Text style={styles.location}>
          {[course.city, course.state, course.country].filter(Boolean).join(', ')}
        </Text>
      </View>
      {dist != null ? (
        <View style={styles.distBadge}>
          <Text style={styles.distValue}>{formatMiles(dist)}</Text>
          <Text style={styles.distLabel}>away</Text>
        </View>
      ) : (
        <Text style={styles.chev}>›</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 4 },
  subtitle: { color: C.textMuted, fontSize: 13, marginBottom: 16 },
  // Same look as the +Find button on the Finds tab — gold-tinted pill,
  // small + glyph, sits aligned to the title's top so the row doesn't
  // distort vertically as the subtitle wraps.
  requestBtn: {
    backgroundColor: C.gold + '22', borderRadius: 4,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: C.gold,
    marginTop: 4,
  },
  requestBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border, marginBottom: 16,
  },
  sectionLabel: {
    color: C.textMuted, fontSize: 11, fontWeight: '700',
    letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8,
  },
  courseCard: {
    backgroundColor: C.card, borderRadius: 8, padding: 14,
    marginBottom: 8, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clubName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  location: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  chev: { color: C.textDim, fontSize: 22, marginLeft: 8 },
  // Prominent distance badge on the right of each row — the headline number
  // so "how far is this course" reads at a glance.
  distBadge: {
    alignItems: 'center', justifyContent: 'center', marginLeft: 10,
    minWidth: 58, paddingHorizontal: 8, paddingVertical: 6,
    backgroundColor: C.gold + '1a', borderRadius: 8, borderWidth: 1, borderColor: C.gold + '55',
  },
  distValue: { color: C.gold, fontSize: 14, fontWeight: '900' },
  distLabel: { color: C.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 1 },
  empty: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 24 },
});
