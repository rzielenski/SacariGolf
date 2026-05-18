import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { C } from '../../lib/colors';
import { Course } from '../../types';
import { Divider } from '../../components/Flourish';

export default function CoursesScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Course[]>([]);
  const [searching, setSearching] = useState(false);
  const [nearby, setNearby] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);

  // Load nearby courses on mount
  useEffect(() => {
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const courses = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearby(courses);
      } catch { /* silent */ } finally {
        setLoadingNearby(false);
      }
    })();
  }, []);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      const r = await api.courses.search(q);
      setResults(r);
    } finally { setSearching(false); }
  }, []);

  const open = (c: Course) => router.push(`/course/${c.course_id}` as any);

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
            {!searching && results.length === 0 && (
              <Text style={styles.empty}>No courses match "{query}"</Text>
            )}
            {results.map((c) => <CourseRow key={c.course_id} course={c} onPress={() => open(c)} />)}
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Nearby</Text>
            {loadingNearby
              ? <ActivityIndicator color={C.gold} style={{ marginTop: 16 }} />
              : nearby.length === 0
                ? <Text style={styles.empty}>No nearby courses found. Try searching above.</Text>
                : nearby.map((c) => <CourseRow key={c.course_id} course={c} onPress={() => open(c)} />)
            }
          </>
        )}
      </ScrollView>
    </View>
  );
}

function CourseRow({ course, onPress }: { course: Course; onPress: () => void }) {
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
      <Text style={styles.chev}>›</Text>
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
  location: { color: C.gold, fontSize: 12, marginTop: 4 },
  chev: { color: C.textDim, fontSize: 22, marginLeft: 8 },
  empty: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 24 },
});
