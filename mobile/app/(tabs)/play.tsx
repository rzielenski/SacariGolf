import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, FlatList, ActivityIndicator, Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { Course, Teebox } from '../../types';

type MatchType = 'solo' | 'duo' | 'practice';

export default function PlayScreen() {
  const [step, setStep] = useState<'type' | 'join' | 'course' | 'teebox'>('type');
  const [joinId, setJoinId] = useState('');
  const [joining, setJoining] = useState(false);

  const handleJoinById = async () => {
    if (!joinId.trim()) { Alert.alert('Enter a Match ID'); return; }
    setJoining(true);
    try {
      const match = await api.matches.get(joinId.trim());
      if (match.completed) { Alert.alert('Match already completed'); setJoining(false); return; }
      await api.matches.join(joinId.trim(), {});
      router.push(`/match/${joinId.trim()}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setJoining(false); }
  };
  const [matchType, setMatchType] = useState<MatchType>('solo');
  const [numHoles, setNumHoles] = useState<9 | 18>(18);
  const [query, setQuery] = useState('');
  const [courses, setCourses] = useState<Course[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [courseDetails, setCourseDetails] = useState<Course | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [creating, setCreating] = useState(false);

  // Load nearby courses once when the course step becomes active
  useEffect(() => {
    if (step !== 'course' || nearbyCourses.length > 0) return;
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const results = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearbyCourses(results);
      } catch { /* silent — nearby is best-effort */ } finally {
        setLoadingNearby(false);
      }
    })();
  }, [step]);

  const searchCourses = useCallback(async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setCourses([]); return; }
    setSearching(true);
    try {
      const results = await api.courses.search(q);
      setCourses(results);
    } catch { /* silent */ } finally {
      setSearching(false);
    }
  }, []);

  const selectCourse = async (course: Course) => {
    setSelectedCourse(course);
    setLoadingDetails(true);
    try {
      const details = await api.courses.get(course.course_id);
      setCourseDetails(details);
      setStep('teebox');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoadingDetails(false);
    }
  };

  const startMatch = async (teebox: Teebox) => {
    setCreating(true);
    try {
      const match = await api.matches.create({
        matchType,
        isPractice: matchType === 'practice',
        teeboxId: teebox.teebox_id,
      });
      // Skip lobby — go straight to scoring, pass the selected hole count
      router.push(`/match/scoring/${match.match_id}?holes=${numHoles}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setCreating(false);
    }
  };

  if (step === 'type') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Start a Round</Text>
        <Text style={styles.subtitle}>Choose your match type</Text>

        {(['solo', 'duo', 'practice'] as MatchType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.typeCard, matchType === t && styles.typeCardActive]}
            onPress={() => setMatchType(t)}
          >
            <View style={styles.typeMark}>
              <Text style={[styles.typeMarkText, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? '1v1' : t === 'duo' ? '2v2' : 'PRC'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.typeName, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? 'Solo' : t === 'duo' ? 'Duo' : 'Practice'}
              </Text>
              <Text style={styles.typeDesc}>
                {t === 'solo' ? 'Ranked 1v1 — auto-matched by ELO'
                  : t === 'duo' ? 'Ranked 2v2 — play with a partner'
                  : 'No ELO — just get the reps in'}
              </Text>
            </View>
            {matchType === t && <Text style={styles.checkmark}>—</Text>}
          </TouchableOpacity>
        ))}

        {/* Hole count */}
        <Text style={styles.holeLabel}>Holes</Text>
        <View style={styles.holeRow}>
          {([9, 18] as const).map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.holeBtn, numHoles === n && styles.holeBtnActive]}
              onPress={() => setNumHoles(n)}
            >
              <Text style={[styles.holeBtnText, numHoles === n && styles.holeBtnTextActive]}>{n} Holes</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.nextBtn} onPress={() => setStep('course')}>
          <Text style={styles.nextBtnText}>Select Course →</Text>
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <TouchableOpacity style={styles.joinMatchBtn} onPress={() => setStep('join')}>
          <Text style={styles.joinMatchText}>Join Match by ID</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (step === 'join') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep('type')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Join a Match</Text>
        <Text style={styles.subtitle}>Enter the Match ID shared by your friend</Text>

        <TextInput
          style={styles.searchInput}
          value={joinId}
          onChangeText={setJoinId}
          placeholder="Paste Match ID here..."
          placeholderTextColor={C.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />

        <TouchableOpacity
          style={[styles.nextBtn, joining && { opacity: 0.6 }]}
          onPress={handleJoinById}
          disabled={joining}
        >
          {joining
            ? <ActivityIndicator color="#000" />
            : <Text style={styles.nextBtnText}>Join Match →</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  if (step === 'course') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep('type')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Find a Course</Text>
        <Text style={styles.subtitle}>Search by name, city, or state</Text>

        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={searchCourses}
          placeholder="e.g. Potsdam, Clarkson, Pebble..."
          placeholderTextColor={C.textMuted}
          autoFocus
        />

        {(searching || loadingDetails) && (
          <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />
        )}

        {/* Before search: show nearby courses */}
        {query.length < 2 && !searching && (
          <>
            {loadingNearby
              ? <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />
              : nearbyCourses.length > 0 && (
                <>
                  <Text style={styles.nearbyLabel}>Nearby</Text>
                  <FlatList
                    data={nearbyCourses}
                    keyExtractor={(c) => c.course_id}
                    renderItem={({ item }) => <CourseRow course={item} onPress={() => selectCourse(item)} />}
                    scrollEnabled={false}
                  />
                </>
              )}
          </>
        )}

        {/* Search results */}
        {query.length >= 2 && (
          <FlatList
            data={courses}
            keyExtractor={(c) => c.course_id}
            renderItem={({ item }) => <CourseRow course={item} onPress={() => selectCourse(item)} />}
            style={{ marginTop: 4 }}
          />
        )}
      </View>
    );
  }

  // Teebox selection
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => { setStep('course'); setCourseDetails(null); }}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>{courseDetails?.course_name}</Text>
      <Text style={styles.subtitle}>Select your tee box</Text>

      <ScrollView>
        {(courseDetails?.teeboxes ?? []).filter((t) => t.num_holes >= numHoles).map((t) => (
          <TouchableOpacity key={t.teebox_id} style={styles.teeboxCard} onPress={() => startMatch(t)}>
            <View style={styles.teeboxLeft}>
              <Text style={styles.teeboxName}>{t.name}</Text>
              <Text style={styles.teeboxMeta}>{t.num_holes} holes · Par {t.par} · {t.total_yards?.toLocaleString()} yds</Text>
            </View>
            <View style={styles.teeboxRight}>
              <Text style={styles.teeboxRating}>Rating: {t.course_rating}</Text>
              <Text style={styles.teeboxSlope}>Slope: {t.slope_rating}</Text>
            </View>
          </TouchableOpacity>
        ))}
        {creating && (
          <View style={{ alignItems: 'center', marginTop: 20 }}>
            <ActivityIndicator color={C.gold} />
            <Text style={{ color: C.textMuted, marginTop: 8 }}>Creating match...</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function CourseRow({ course, onPress }: { course: Course; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.courseCard} onPress={onPress}>
      <Text style={styles.courseName}>{course.course_name}</Text>
      {course.club_name && course.club_name !== course.course_name && (
        <Text style={styles.clubName}>{course.club_name}</Text>
      )}
      <Text style={styles.courseLocation}>
        {[course.city, course.state].filter(Boolean).join(', ')}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 4 },
  subtitle: { color: C.textMuted, fontSize: 14, marginBottom: 24 },
  backBtn: { marginBottom: 12 },
  backBtnText: { color: C.gold, fontSize: 16 },

  typeCard: {
    backgroundColor: C.card,
    borderRadius: 6,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  typeCardActive: { borderColor: C.gold },
  typeMark: { width: 44, height: 44, borderRadius: 4, borderWidth: 1, borderColor: C.border, justifyContent: 'center', alignItems: 'center' },
  typeMarkText: { fontFamily: F.serif, fontSize: 13, fontWeight: '700', color: C.textMuted, letterSpacing: 1 },
  typeName: { color: C.text, fontWeight: '700', fontSize: 15, letterSpacing: 0.3 },
  typeDesc: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  checkmark: { color: C.gold, fontSize: 18, fontWeight: '900' },

  holeLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  holeRow: { flexDirection: 'row', gap: 10 },
  holeBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: C.card, borderWidth: 2, borderColor: C.border },
  holeBtnActive: { borderColor: C.gold, backgroundColor: C.gold + '18' },
  holeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 15 },
  holeBtnTextActive: { color: C.gold },

  nextBtn: {
    backgroundColor: C.gold,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  nextBtnText: { color: '#000', fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.border },
  dividerText: { color: C.textMuted, fontSize: 13 },
  joinMatchBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  joinMatchText: { color: C.textMuted, fontWeight: '600', fontSize: 15 },

  searchInput: {
    backgroundColor: C.card,
    color: C.text,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 8,
  },

  nearbyLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 8 },
  courseCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clubName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  courseLocation: { color: C.gold, fontSize: 12, marginTop: 4 },

  teeboxCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 18,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: C.border,
  },
  teeboxLeft: { flex: 1 },
  teeboxName: { color: C.text, fontWeight: '800', fontSize: 17 },
  teeboxMeta: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  teeboxRight: { alignItems: 'flex-end' },
  teeboxRating: { color: C.gold, fontWeight: '700', fontSize: 13 },
  teeboxSlope: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  loadingOverlay: { alignItems: 'center', marginTop: 30 },
  loadingText: { color: C.textMuted, marginTop: 10 },
});
