import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, TextInput, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';

export default function CourseInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lbTab, setLbTab] = useState<'stroke' | 'scramble'>('stroke');
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportField, setReportField] = useState('course_rating');
  const [reportSuggested, setReportSuggested] = useState('');
  const [reportNotes, setReportNotes] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);

  const submitCorrection = async () => {
    if (!reportSuggested.trim()) { Alert.alert('Missing', 'Please describe the correction.'); return; }
    setReportSubmitting(true);
    try {
      await api.courses.reportCorrection(id, {
        field: reportField,
        suggestedValue: reportSuggested.trim(),
        notes: reportNotes.trim() || undefined,
      });
      Alert.alert('Thank you!', 'Submitted for review. We typically apply valid corrections within a day or two.');
      setReportOpen(false);
      setReportSuggested('');
      setReportNotes('');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setReportSubmitting(false);
    }
  };

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [details, lb] = await Promise.all([
        api.courses.get(id),
        api.courses.leaderboard(id),
      ]);
      setCourse(details);
      setLeaderboard(lb);
    } catch (e: any) {
      // silent on leaderboard fail
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }
  if (!course) {
    return (
      <View style={styles.centered}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ color: C.textMuted }}>Course not found</Text>
      </View>
    );
  }

  const strokeLb = leaderboard.filter((r) => r.format !== 'scramble');
  const scrambleLb = leaderboard.filter((r) => r.format === 'scramble');
  const displayLb = lbTab === 'stroke' ? strokeLb : scrambleLb;

  // Summarise tee boxes for display
  const par18 = course.teeboxes?.find((t: any) => t.num_holes === 18)?.par;
  const par9 = course.teeboxes?.find((t: any) => t.num_holes === 9)?.par;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.courseName}>{course.course_name}</Text>
        {course.club_name && course.club_name !== course.course_name && (
          <Text style={styles.clubName}>{course.club_name}</Text>
        )}
        <Text style={styles.location}>
          {[course.city, course.state, course.country].filter(Boolean).join(', ')}
        </Text>
        {course.address && <Text style={styles.address}>{course.address}</Text>}
      </View>

      {/* Quick stats */}
      {par18 && (
        <View style={styles.statRow}>
          <StatChip label="Par (18)" value={par18} />
          {par9 && <StatChip label="Par (9)" value={par9} />}
          <StatChip label="Tee Boxes" value={course.teeboxes?.length ?? 0} />
        </View>
      )}

      {/* Tee boxes */}
      <Text style={styles.sectionHeader}>TEE BOXES</Text>
      {(course.teeboxes ?? []).map((t: any) => (
        <View key={t.teebox_id} style={styles.teeCard}>
          <View style={styles.teeLeft}>
            <Text style={styles.teeName}>{t.name}</Text>
            <Text style={styles.teeMeta}>
              {t.num_holes} holes · Par {t.par} · {t.total_yards?.toLocaleString() ?? '—'} yds
            </Text>
          </View>
          <View style={styles.teeRight}>
            {t.course_rating && <Text style={styles.teeRating}>Rating {t.course_rating}</Text>}
            {t.slope_rating && <Text style={styles.teeSlope}>Slope {t.slope_rating}</Text>}
          </View>
        </View>
      ))}
      {!course.teeboxes?.length && (
        <Text style={styles.empty}>No tee box data available.</Text>
      )}

      {/* Leaderboard */}
      <Text style={styles.sectionHeader}>COURSE LEADERBOARD</Text>
      <View style={styles.lbTabRow}>
        {(['stroke', 'scramble'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.lbTab, lbTab === t && styles.lbTabActive]}
            onPress={() => setLbTab(t)}
          >
            <Text style={[styles.lbTabText, lbTab === t && styles.lbTabTextActive]}>
              {t === 'stroke' ? 'Stroke Play' : 'Scramble'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {displayLb.length === 0 ? (
        <Text style={styles.empty}>
          No {lbTab === 'stroke' ? 'stroke play' : 'scramble'} rounds recorded here yet.
        </Text>
      ) : (
        displayLb.map((r, i) => (
          <TouchableOpacity
            key={r.round_id ?? i}
            style={[styles.lbRow, i === 0 && lbTab === 'stroke' && { borderColor: C.gold }]}
            onPress={() => r.hole_scores?.length
              ? setScorecardEntry({ ...r, course_id: course.course_id, course_name: course.course_name })
              : router.push(`/user/${r.user_id}` as any)
            }
            onLongPress={() => router.push(`/user/${r.user_id}` as any)}
            delayLongPress={300}
            activeOpacity={0.7}
          >
            <Text style={[styles.lbRank, { color: i === 0 ? C.gold : i === 1 ? '#b0bec5' : i === 2 ? '#a1673a' : C.textDim }]}>
              #{i + 1}
            </Text>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.lbUser}>{r.username}</Text>
                {i === 0 && lbTab === 'stroke' && (
                  <View style={styles.recordBadge}>
                    <Text style={styles.recordBadgeText}>RECORD</Text>
                  </View>
                )}
              </View>
              <Text style={styles.lbMeta}>
                {r.teebox_name} · {r.holes_played ?? r.num_holes} holes · {new Date(r.created_at).toLocaleDateString()}
              </Text>
            </View>
            <View style={styles.lbScoreBox}>
              <Text style={styles.lbScore}>{r.total_score}</Text>
              <Text style={styles.lbPar}>
                {r.total_score - r.par > 0 ? `+${r.total_score - r.par}` : r.total_score - r.par === 0 ? 'E' : r.total_score - r.par}
              </Text>
            </View>
          </TouchableOpacity>
        ))
      )}
      {displayLb.length > 0 && <Text style={styles.tapHint}>Tap a row to view scorecard · Hold for profile</Text>}

      {/* Report incorrect data — tucked at the bottom so the picker UX
          isn't cluttered, but discoverable for typos in rating/slope/par. */}
      <TouchableOpacity
        style={styles.reportBtn}
        onPress={() => setReportOpen(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.reportBtnText}>Report incorrect course data</Text>
      </TouchableOpacity>

      {/* Crowd-sourced pin placement — open to anyone. Lets players place
          or correct each hole's cup coordinates from a satellite view, no
          need to be on-site. Last-write-wins; the server tracks who placed
          each pin so we can roll back vandalism. */}
      <TouchableOpacity
        style={styles.adminBtn}
        onPress={() => router.push(`/course/admin-pins/${id}` as any)}
        activeOpacity={0.7}
      >
        <Text style={styles.adminBtnText}>📍 Place / Correct Pins</Text>
      </TouchableOpacity>

      <ScorecardModal
        visible={!!scorecardEntry}
        entry={scorecardEntry}
        onClose={() => setScorecardEntry(null)}
        onViewProfile={() => {
          const userId = scorecardEntry?.user_id;
          setScorecardEntry(null);
          if (userId) router.push(`/user/${userId}` as any);
        }}
      />

      <Modal
        visible={reportOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setReportOpen(false)}
      >
        <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 20, paddingTop: 30 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: '900' }}>Report Incorrect Data</Text>
            <TouchableOpacity onPress={() => setReportOpen(false)}>
              <Text style={{ color: C.textMuted, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>
            For: {course.course_name}
          </Text>

          <Text style={styles.reportLabel}>What's wrong?</Text>
          <View style={styles.reportFieldRow}>
            {[
              ['course_rating', 'Course Rating'],
              ['slope_rating', 'Slope'],
              ['par', 'Par'],
              ['yardage', 'Yardage'],
              ['tee_name', 'Tee name'],
              ['pin_location', 'Pin location'],
              ['course_name', 'Course name'],
              ['address', 'Address'],
              ['other', 'Other'],
            ].map(([k, label]) => (
              <TouchableOpacity
                key={k}
                style={[styles.reportChip, reportField === k && styles.reportChipActive]}
                onPress={() => setReportField(k)}
              >
                <Text style={[styles.reportChipText, reportField === k && { color: C.bg }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.reportLabel}>What should it be?</Text>
          <TextInput
            style={styles.reportInput}
            value={reportSuggested}
            onChangeText={setReportSuggested}
            placeholder="e.g. 70.4, or describe in plain English"
            placeholderTextColor={C.textMuted}
            autoCapitalize="none"
            multiline
          />

          <Text style={styles.reportLabel}>Notes (optional)</Text>
          <TextInput
            style={[styles.reportInput, { minHeight: 80 }]}
            value={reportNotes}
            onChangeText={setReportNotes}
            placeholder="Anything else we should know? Source for the correction?"
            placeholderTextColor={C.textMuted}
            multiline
          />

          <TouchableOpacity
            style={[styles.reportSubmit, reportSubmitting && { opacity: 0.6 }]}
            onPress={submitCorrection}
            disabled={reportSubmitting}
          >
            {reportSubmitting
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.reportSubmitText}>Submit Correction</Text>}
          </TouchableOpacity>
        </ScrollView>
      </Modal>
    </ScrollView>
  );
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statChip}>
      <Text style={styles.statChipValue}>{value}</Text>
      <Text style={styles.statChipLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },

  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  backBtn: { marginBottom: 16 },
  backBtnText: { color: C.gold, fontSize: 16 },
  courseName: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 4 },
  clubName: { color: C.textMuted, fontSize: 14, marginBottom: 4 },
  location: { color: C.gold, fontSize: 13, marginBottom: 2 },
  address: { color: C.textDim, fontSize: 12 },

  statRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingVertical: 16 },
  statChip: {
    flex: 1, backgroundColor: C.card, borderRadius: 8, padding: 14,
    alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  statChipValue: { fontFamily: F.serif, color: C.gold, fontSize: 24, fontWeight: '700' },
  statChipLabel: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  sectionHeader: {
    color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 20, marginBottom: 10,
  },

  teeCard: {
    backgroundColor: C.card, borderRadius: 8, padding: 14, marginHorizontal: 20,
    marginBottom: 8, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  teeLeft: { flex: 1 },
  teeName: { color: C.text, fontWeight: '700', fontSize: 15 },
  teeMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  teeRight: { alignItems: 'flex-end' },
  teeRating: { color: C.gold, fontWeight: '700', fontSize: 12 },
  teeSlope: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  lbTabRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 12 },
  lbTab: {
    flex: 1, paddingVertical: 9, borderRadius: 6, alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  lbTabActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  lbTabText: { color: C.textMuted, fontWeight: '600', fontSize: 13 },
  lbTabTextActive: { color: C.gold },

  lbRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 8, marginHorizontal: 20,
    marginBottom: 8, padding: 12, borderWidth: 1, borderColor: C.border,
  },
  lbRank: { fontFamily: F.serif, fontSize: 15, fontWeight: '700', width: 32, textAlign: 'center' },
  lbUser: { color: C.text, fontWeight: '700', fontSize: 14 },
  lbMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  lbScoreBox: { alignItems: 'center', minWidth: 48 },
  lbScore: { color: C.text, fontSize: 20, fontWeight: '900' },
  lbPar: { color: C.textMuted, fontSize: 11, marginTop: 1 },

  empty: { color: C.textMuted, fontSize: 13, paddingHorizontal: 20, paddingVertical: 12 },
  tapHint: { color: C.textDim, fontSize: 11, textAlign: 'center', paddingVertical: 12, paddingHorizontal: 20 },

  reportBtn: {
    marginTop: 24, marginHorizontal: 20, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, borderRadius: 8, backgroundColor: C.card,
  },
  reportBtnText: { color: C.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },

  // Admin-only entry — visually distinct so the operator can spot it but
  // not flashy enough to imply "tap here" to regular users (it's hidden
  // entirely without the admin token).
  adminBtn: {
    marginTop: 10, marginHorizontal: 20, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold + '88', borderRadius: 8,
    backgroundColor: C.gold + '11',
  },
  adminBtnText: { color: C.gold, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },

  reportLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  reportFieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  reportChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  reportChipActive: { backgroundColor: C.gold, borderColor: C.gold },
  reportChipText: { color: C.text, fontSize: 12, fontWeight: '700' },
  reportInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    borderWidth: 1, borderColor: C.border, minHeight: 44, textAlignVertical: 'top',
  },
  reportSubmit: {
    marginTop: 22, backgroundColor: C.gold, borderRadius: 8, paddingVertical: 14, alignItems: 'center',
  },
  reportSubmitText: { color: '#000', fontSize: 15, fontWeight: '900' },
  recordBadge: { backgroundColor: C.gold + '33', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: C.gold },
  recordBadgeText: { color: C.gold, fontWeight: '900', fontSize: 9, letterSpacing: 1 },

  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  modalSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  modalDone: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  modalDoneText: { color: '#000', fontWeight: '800', fontSize: 14 },

  totalsCard: {
    flexDirection: 'row', backgroundColor: C.card, borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 6,
  },
  totalCell: { flex: 1, alignItems: 'center' },
  totalLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  totalValue: { color: C.text, fontFamily: F.serif, fontSize: 24, fontWeight: '700', marginTop: 4 },

  scGrid: { flexDirection: 'row', alignItems: 'center', minHeight: 26 },
  scLabel: { width: 40, color: C.textDim, fontSize: 10, fontWeight: '700' },
  scNum: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center', fontWeight: '700' },
  scParCell: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center' },
  scScoreCell: { flex: 1, fontSize: 13, textAlign: 'center', fontWeight: '700' },
  scTotal: { width: 40, color: C.gold, fontSize: 11, textAlign: 'center', fontWeight: '800' },
});
