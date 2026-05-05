import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';

function scoreColor(score: number, par: number) {
  const d = score - par;
  if (d <= -2) return '#4CAF50';
  if (d === -1) return '#81C784';
  if (d === 0) return C.text;
  if (d === 1) return '#FF9800';
  return '#F44336';
}

export default function CourseInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lbTab, setLbTab] = useState<'stroke' | 'scramble'>('stroke');
  const [scorecardEntry, setScorecardEntry] = useState<any | null>(null);

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
            style={styles.lbRow}
            onPress={() => router.push(`/user/${r.user_id}` as any)}
            onLongPress={() => r.hole_scores?.length && setScorecardEntry(r)}
            delayLongPress={300}
            activeOpacity={0.7}
          >
            <Text style={[styles.lbRank, { color: i === 0 ? C.gold : i === 1 ? '#b0bec5' : i === 2 ? '#a1673a' : C.textDim }]}>
              #{i + 1}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.lbUser}>{r.username}</Text>
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
      {displayLb.length > 0 && <Text style={styles.tapHint}>Tap a row for profile · Hold for scorecard</Text>}

      {/* Scorecard Modal */}
      <Modal
        visible={!!scorecardEntry}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setScorecardEntry(null)}
      >
        {scorecardEntry && (
          <ScorecardModal
            entry={scorecardEntry}
            teebox={course.teeboxes?.find((t: any) => t.teebox_id === scorecardEntry.teebox_id)}
            onClose={() => setScorecardEntry(null)}
          />
        )}
      </Modal>
    </ScrollView>
  );
}

function ScorecardModal({ entry, teebox, onClose }: { entry: any; teebox: any; onClose: () => void }) {
  const scores: number[] = entry.hole_scores ?? [];
  const holes = (teebox?.holes ?? []).slice().sort((a: any, b: any) => a.hole_num - b.hole_num).slice(0, scores.length);
  const front = holes.slice(0, 9);
  const back = holes.slice(9);
  const frontScores = scores.slice(0, 9);
  const backScores = scores.slice(9);
  const frontPar = front.reduce((a: number, h: any) => a + h.par, 0);
  const backPar = back.reduce((a: number, h: any) => a + h.par, 0);
  const totalPar = frontPar + backPar;
  const diff = entry.total_score - totalPar;

  return (
    <View style={styles.modalContainer}>
      <View style={styles.modalHeader}>
        <View>
          <Text style={styles.modalTitle}>{entry.username}</Text>
          <Text style={styles.modalSub}>{entry.teebox_name} · {new Date(entry.created_at).toLocaleDateString()}</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={styles.modalDone}>
          <Text style={styles.modalDoneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <View style={styles.totalsCard}>
          <View style={styles.totalCell}>
            <Text style={styles.totalLabel}>SCORE</Text>
            <Text style={styles.totalValue}>{entry.total_score}</Text>
          </View>
          <View style={styles.totalCell}>
            <Text style={styles.totalLabel}>TO PAR</Text>
            <Text style={[styles.totalValue, { color: diff < 0 ? C.green : diff > 0 ? C.red : C.text }]}>
              {diff > 0 ? `+${diff}` : diff === 0 ? 'E' : diff}
            </Text>
          </View>
          <View style={styles.totalCell}>
            <Text style={styles.totalLabel}>PAR</Text>
            <Text style={[styles.totalValue, { color: C.textMuted }]}>{totalPar}</Text>
          </View>
        </View>

        <ScorecardGrid label="OUT" holes={front} scores={frontScores} parTotal={frontPar} />
        {back.length > 0 && <ScorecardGrid label="IN" holes={back} scores={backScores} parTotal={backPar} />}
      </ScrollView>
    </View>
  );
}

function ScorecardGrid({ label, holes, scores, parTotal }: { label: string; holes: any[]; scores: number[]; parTotal: number }) {
  const scoreTotal = scores.reduce((a, b) => a + b, 0);
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Hole</Text>
        {holes.map((h) => <Text key={h.hole_id} style={styles.scNum}>{h.hole_num}</Text>)}
        <Text style={styles.scTotal}>{label}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Par</Text>
        {holes.map((h) => <Text key={h.hole_id} style={styles.scParCell}>{h.par}</Text>)}
        <Text style={styles.scTotal}>{parTotal}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Score</Text>
        {holes.map((h, i) => (
          <Text key={h.hole_id} style={[styles.scScoreCell, { color: scoreColor(scores[i], h.par) }]}>
            {scores[i] ?? '-'}
          </Text>
        ))}
        <Text style={[styles.scTotal, { color: scoreTotal - parTotal < 0 ? C.green : scoreTotal - parTotal > 0 ? C.red : C.text }]}>
          {scoreTotal || '-'}
        </Text>
      </View>
    </View>
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
