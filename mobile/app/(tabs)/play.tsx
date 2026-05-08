import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, FlatList, ActivityIndicator, Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Course, Teebox } from '../../types';
import { Divider } from '../../components/Flourish';

type MatchType = 'solo' | 'duo' | 'squad' | 'practice';
type Format = 'stroke' | 'scramble';
type Step = 'type' | 'clan' | 'format' | 'join' | 'course' | 'teebox';

export default function PlayScreen() {
  const { user } = useAuth();
  const [step, setStep] = useState<Step>('type');
  const [joinId, setJoinId] = useState('');
  const [joining, setJoining] = useState(false);
  const [matchType, setMatchType] = useState<MatchType>('solo');
  const [numHoles, setNumHoles] = useState<9 | 18>(18);
  const [format, setFormat] = useState<Format>('stroke');
  const [selectedClanId, setSelectedClanId] = useState<string | null>(null);
  const [myclans, setMyClans] = useState<any[]>([]);
  const [loadingClans, setLoadingClans] = useState(false);
  const [query, setQuery] = useState('');
  const [courses, setCourses] = useState<Course[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [searching, setSearching] = useState(false);
  const [courseDetails, setCourseDetails] = useState<Course | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [creating, setCreating] = useState(false);

  // Load nearby courses once
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
      } catch { } finally { setLoadingNearby(false); }
    })();
  }, [step]);

  // Load clans when clan step becomes active
  useEffect(() => {
    if (step !== 'clan') return;
    setLoadingClans(true);
    api.clans.mine()
      .then((all) => {
        const filtered = matchType === 'duo'
          ? all.filter((c: any) => c.clan_mode === 'duo' && c.member_count === 2)
          : all.filter((c: any) => c.clan_mode === 'squad' && c.role === 'leader' && c.member_count >= 3);
        setMyClans(filtered);
      })
      .catch(() => { })
      .finally(() => setLoadingClans(false));
  }, [step, matchType]);

  const handleJoinById = async () => {
    if (!joinId.trim()) { Alert.alert('Enter a Match ID'); return; }
    setJoining(true);
    try {
      const match = await api.matches.get(joinId.trim());
      if (match.completed) { Alert.alert('Match already completed'); return; }
      await api.matches.join(joinId.trim(), {});
      router.push(`/match/${joinId.trim()}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setJoining(false); }
  };

  const searchCourses = useCallback(async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setCourses([]); return; }
    setSearching(true);
    try {
      const results = await api.courses.search(q);
      setCourses(Array.isArray(results) ? results : []);
    } catch { } finally { setSearching(false); }
  }, []);

  const selectCourse = async (course: Course) => {
    setLoadingDetails(true);
    try {
      const details = await api.courses.get(course.course_id);
      setCourseDetails(details);
      setStep('teebox');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setLoadingDetails(false); }
  };

  const startMatch = async (teebox: Teebox) => {
    setCreating(true);
    try {
      const match = await api.matches.create({
        matchType,
        isPractice: matchType === 'practice',
        teeboxId: teebox.teebox_id,
        clanId: selectedClanId ?? undefined,
        format: (matchType === 'duo' || matchType === 'squad') ? format : 'stroke',
        numHoles,
      });
      if ((matchType === 'duo' || matchType === 'squad') && selectedClanId) {
        Alert.alert(
          'Match Created!',
          'Your teammates have been invited. They have 24 hours to accept.',
          [{ text: 'OK', onPress: () => router.push(`/match/${match.match_id}` as any) }]
        );
      } else {
        router.push(`/match/scoring/${match.match_id}?holes=${numHoles}` as any);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setCreating(false); }
  };

  const goToNextStep = () => {
    if (matchType === 'duo' || matchType === 'squad') {
      setStep('clan');
    } else {
      setStep('course');
    }
  };

  // Button label for next step
  const nextStepLabel = matchType === 'duo' || matchType === 'squad' ? 'Select Team →' : 'Select Course →';

  // ── Type selection ────────────────────────────────────────────────────────────
  if (step === 'type') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Start a Round</Text>
        <Text style={styles.subtitle}>Choose your match type</Text>
        <Divider style={{ marginTop: -8, marginBottom: 8 }} />

        {(['solo', 'duo', 'squad', 'practice'] as MatchType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.typeCard, matchType === t && styles.typeCardActive]}
            onPress={() => setMatchType(t)}
          >
            <View style={styles.typeMark}>
              <Text style={[styles.typeMarkText, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? '1v1' : t === 'duo' ? '2v2' : t === 'squad' ? '4v4' : 'PRC'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.typeName, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? 'Solo' : t === 'duo' ? 'Duo' : t === 'squad' ? 'Squad' : 'Practice'}
              </Text>
              <Text style={styles.typeDesc}>
                {t === 'solo' ? 'Ranked 1v1 — auto-matched by ELO'
                  : t === 'duo' ? 'Ranked 2v2 — stroke play or scramble'
                  : t === 'squad' ? 'Ranked 4v4 — stroke play or scramble'
                  : 'No ELO — just get the reps in'}
              </Text>
            </View>
            {matchType === t && <Text style={styles.checkmark}>—</Text>}
          </TouchableOpacity>
        ))}

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

        <TouchableOpacity style={styles.nextBtn} onPress={goToNextStep}>
          <Text style={styles.nextBtnText}>{nextStepLabel}</Text>
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

  // ── Clan selection ────────────────────────────────────────────────────────────
  if (step === 'clan') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep('type')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>
          {matchType === 'duo' ? 'Pick Your Duo' : 'Pick Your Squad'}
        </Text>
        <Text style={styles.subtitle}>
          {matchType === 'duo'
            ? 'Your partner will be notified and must accept within 24 hours'
            : 'All squad members will be notified. Only leaders can start squad matches.'}
        </Text>

        {loadingClans
          ? <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
          : myclans.length === 0
            ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>
                  {matchType === 'duo'
                    ? 'No eligible duos'
                    : 'No eligible squads'}
                </Text>
                <Text style={styles.emptySub}>
                  {matchType === 'duo'
                    ? 'Your duo must have both members before starting a match'
                    : 'Your squad needs at least 3 members and you must be the leader'}
                </Text>
              </View>
            )
            : myclans.map((c) => (
              <TouchableOpacity
                key={c.clan_id}
                style={[styles.clanCard, selectedClanId === c.clan_id && styles.clanCardActive]}
                onPress={() => setSelectedClanId(c.clan_id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.clanName, selectedClanId === c.clan_id && { color: C.gold }]}>{c.name}</Text>
                  <Text style={styles.clanMeta}>{c.clan_mode.toUpperCase()} · {c.member_count}/{c.max_players} members · {c.elo} ELO</Text>
                </View>
                {selectedClanId === c.clan_id && <Text style={{ color: C.gold, fontSize: 18 }}>✓</Text>}
              </TouchableOpacity>
            ))
        }

        {selectedClanId && (
          <TouchableOpacity style={[styles.nextBtn, { marginTop: 20 }]} onPress={() => setStep('format')}>
            <Text style={styles.nextBtnText}>Choose Format →</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── Format selection ──────────────────────────────────────────────────────────
  if (step === 'format') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep('clan')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Choose Format</Text>
        <Text style={styles.subtitle}>How will your team play?</Text>

        <TouchableOpacity
          style={[styles.formatCard, format === 'stroke' && styles.formatCardActive]}
          onPress={() => setFormat('stroke')}
        >
          <View style={styles.formatIcon}>
            <Text style={[styles.formatIconText, format === 'stroke' && { color: C.gold }]}>STK</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.formatName, format === 'stroke' && { color: C.gold }]}>Stroke Play</Text>
            <Text style={styles.formatDesc}>
              Each player plays their own ball. Scores are averaged after course normalization.
            </Text>
          </View>
          {format === 'stroke' && <Text style={{ color: C.gold, fontSize: 20 }}>✓</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.formatCard, format === 'scramble' && styles.formatCardActive]}
          onPress={() => setFormat('scramble')}
        >
          <View style={styles.formatIcon}>
            <Text style={[styles.formatIconText, format === 'scramble' && { color: C.gold }]}>SCR</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.formatName, format === 'scramble' && { color: C.gold }]}>Scramble</Text>
            <Text style={styles.formatDesc}>
              Everyone plays from the best shot each time. One final team score per side.
              {'\n'}
              <Text style={{ color: C.gold }}>Both teams must have equal players.</Text>
            </Text>
          </View>
          {format === 'scramble' && <Text style={{ color: C.gold, fontSize: 20 }}>✓</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={[styles.nextBtn, { marginTop: 20 }]} onPress={() => setStep('course')}>
          <Text style={styles.nextBtnText}>Select Course →</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Join by ID ────────────────────────────────────────────────────────────────
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
        />
        <TouchableOpacity
          style={[styles.nextBtn, joining && { opacity: 0.6 }]}
          onPress={handleJoinById}
          disabled={joining}
        >
          {joining ? <ActivityIndicator color="#000" /> : <Text style={styles.nextBtnText}>Join Match →</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  // ── Course search ─────────────────────────────────────────────────────────────
  if (step === 'course') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep(matchType === 'duo' || matchType === 'squad' ? 'format' : 'type')} >
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
        {(searching || loadingDetails) && <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />}
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

  // ── Teebox selection ──────────────────────────────────────────────────────────
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
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
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

  nextBtn: { backgroundColor: C.gold, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  nextBtnText: { color: '#000', fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.border },
  dividerText: { color: C.textMuted, fontSize: 13 },
  joinMatchBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  joinMatchText: { color: C.textMuted, fontWeight: '600', fontSize: 15 },

  clanCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'center',
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  clanCardActive: { borderColor: C.gold },
  clanName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clanMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },

  formatCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'flex-start', gap: 14,
    marginBottom: 12, borderWidth: 1, borderColor: C.border,
  },
  formatCardActive: { borderColor: C.gold },
  formatIcon: { width: 48, height: 48, borderRadius: 4, borderWidth: 1, borderColor: C.border, justifyContent: 'center', alignItems: 'center', marginTop: 2 },
  formatIconText: { fontFamily: F.serif, fontSize: 12, fontWeight: '700', color: C.textMuted, letterSpacing: 1 },
  formatName: { color: C.text, fontWeight: '700', fontSize: 15, marginBottom: 4 },
  formatDesc: { color: C.textMuted, fontSize: 12, lineHeight: 18 },

  emptyBox: { alignItems: 'center', paddingTop: 50 },
  emptyText: { color: C.text, fontWeight: '700', fontSize: 16, textAlign: 'center' },
  emptySub: { color: C.textMuted, fontSize: 13, marginTop: 8, textAlign: 'center' },

  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  nearbyLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 8 },
  courseCard: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clubName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  courseLocation: { color: C.gold, fontSize: 12, marginTop: 4 },

  teeboxCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 18, marginBottom: 10,
    flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: C.border,
  },
  teeboxLeft: { flex: 1 },
  teeboxName: { color: C.text, fontWeight: '800', fontSize: 17 },
  teeboxMeta: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  teeboxRight: { alignItems: 'flex-end' },
  teeboxRating: { color: C.gold, fontWeight: '700', fontSize: 13 },
  teeboxSlope: { color: C.textMuted, fontSize: 12, marginTop: 2 },
});
