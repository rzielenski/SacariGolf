import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, TextInput, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { useCensor } from '../../lib/censor';

export default function CourseInfoScreen() {
  const insets = useSafeAreaInsets();
  const c = useCensor();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [course, setCourse] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lbTab, setLbTab] = useState<'stroke' | 'scramble'>('stroke');
  // Board length: 9 or 18. Null until the course loads, then defaults to the
  // course's native length (18 if any 18-hole teebox exists, else 9). A 9-hole
  // course still offers the 18 board (played-9-twice cards); an 18-hole course
  // offers the 9 board (front/back-nine rounds).
  const [lbHoles, setLbHoles] = useState<9 | 18 | null>(null);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  // The teebox whose generic (par/yardage/HCP) scorecard is open, if any.
  const [teeScorecard, setTeeScorecard] = useState<any | null>(null);
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
      const details = await api.courses.get(id);
      setCourse(details);
      // Default the board length to the course's native length, once.
      setLbHoles((prev) => prev
        ?? ((details?.teeboxes ?? []).some((t: any) => t.num_holes === 18) ? 18 : 9));
    } catch (e: any) {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Board fetch — server-side solo/scramble split + 9/18 length filter, so
  // each board is complete (the old single fetch kept ONE row per player
  // across all formats: a scramble best hid that player's solo round).
  const fetchBoard = useCallback(async (holes: 9 | 18, tab: 'stroke' | 'scramble') => {
    try {
      setLeaderboard(await api.courses.leaderboard(id, {
        format: tab === 'scramble' ? 'scramble' : 'solo',
        holes,
      }));
    } catch { /* silent on leaderboard fail */ }
  }, [id]);
  useEffect(() => {
    if (lbHoles != null) fetchBoard(lbHoles, lbTab);
  }, [lbHoles, lbTab, fetchBoard]);

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

  // Boards are already filtered server-side (format + holes).
  const displayLb = leaderboard;

  // Summarise tee boxes for display
  const par18 = course.teeboxes?.find((t: any) => t.num_holes === 18)?.par;
  const par9 = course.teeboxes?.find((t: any) => t.num_holes === 9)?.par;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { load(true); if (lbHoles != null) fetchBoard(lbHoles, lbTab); }} tintColor={C.gold} />}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
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

      {/* Course Preview — walk the course hole-by-hole (tee→green, distances,
          your shot heatmaps) without playing a round. */}
      <TouchableOpacity
        style={styles.previewBtn}
        onPress={() => router.push({ pathname: '/match/scoring/[id]', params: { id: 'preview', preview: '1', course: id } } as any)}
        activeOpacity={0.85}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.previewBtnTitle}>Course Preview</Text>
          <Text style={styles.previewBtnSub}>Walk every hole · rangefinder · club heatmaps</Text>
        </View>
        <Text style={styles.previewBtnChev}>›</Text>
      </TouchableOpacity>

      {/* Tee boxes — tap any to see its full hole-by-hole scorecard */}
      <Text style={styles.sectionHeader}>TEE BOXES</Text>
      {(course.teeboxes ?? []).map((t: any) => (
        <TouchableOpacity
          key={t.teebox_id}
          style={styles.teeCard}
          activeOpacity={0.7}
          onPress={() => setTeeScorecard(t)}
        >
          <View style={styles.teeLeft}>
            <Text style={styles.teeName}>{t.name}</Text>
            <Text style={styles.teeMeta}>
              {t.num_holes} holes · Par {t.par} · {t.total_yards?.toLocaleString() ?? '—'} yds
            </Text>
          </View>
          <View style={styles.teeRight}>
            {t.course_rating ? <Text style={styles.teeRating}>Rating {t.course_rating}</Text> : null}
            {t.slope_rating ? <Text style={styles.teeSlope}>Slope {t.slope_rating}</Text> : null}
          </View>
          <Text style={styles.teeChev}>›</Text>
        </TouchableOpacity>
      ))}
      {course.teeboxes?.length ? (
        <Text style={styles.tapHint}>Tap a tee to view its scorecard</Text>
      ) : (
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
              {t === 'stroke' ? 'Solo' : 'Scramble'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {/* Board length: raw strokes only compare within one length, so 9- and
          18-hole cards get their own boards (a 9-hole course's 18 board is
          the played-9-twice card; an 18's 9 board is front/back nines). */}
      <View style={[styles.lbTabRow, { marginTop: 6 }]}>
        {([9, 18] as const).map((h) => (
          <TouchableOpacity
            key={h}
            style={[styles.lbTab, lbHoles === h && styles.lbTabActive]}
            onPress={() => setLbHoles(h)}
          >
            <Text style={[styles.lbTabText, lbHoles === h && styles.lbTabTextActive]}>
              {h} Holes
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {displayLb.length === 0 ? (
        <Text style={styles.empty}>
          No {lbHoles ?? 18}-hole {lbTab === 'stroke' ? 'solo' : 'scramble'} rounds recorded here yet.
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
                <Text style={styles.lbUser}>{c(r.username)}</Text>
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
              {(() => {
                // RAW score is the headline (a 28 on 9 holes reads -8, exactly
                // what happened on the course). The 18-hole-equivalent stays as
                // a labeled secondary so cross-length comparisons are possible
                // without a bare normalized number masquerading as the real one.
                const fmt = (n: number) => (n > 0 ? `+${n}` : n === 0 ? 'E' : `${n}`);
                const raw = r.raw_to_par ?? (r.par_played != null ? r.total_score - r.par_played : r.total_score - r.par);
                return (
                  <>
                    <Text style={styles.lbScore}>{r.total_score}</Text>
                    <Text style={styles.lbPar}>{fmt(raw)}</Text>
                    {r.to_par != null && r.to_par !== raw && (
                      <Text style={styles.lbNorm}>18-eq {fmt(r.to_par)}</Text>
                    )}
                  </>
                );
              })()}
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
        <Text style={styles.adminBtnText}>Place / Correct Pins</Text>
      </TouchableOpacity>

      {/* Mark tee boxes — powers the Course Preview's tee→green lines. Per
          teebox (tees differ by set), crowd-sourced like pins. */}
      <TouchableOpacity
        style={styles.adminBtn}
        onPress={() => router.push(`/course/admin-tees/${id}` as any)}
        activeOpacity={0.7}
      >
        <Text style={styles.adminBtnText}>Mark Tee Boxes</Text>
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

      <TeeScorecardModal
        teebox={teeScorecard}
        courseName={course.course_name}
        onClose={() => setTeeScorecard(null)}
      />

      <Modal
        visible={reportOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setReportOpen(false)}
      >
        <ScrollView
          style={{ flex: 1, backgroundColor: C.bg }}
          contentContainerStyle={{ padding: 20, paddingTop: 30 }}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
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

/**
 * Generic (blank) scorecard for one tee set — the course's own par / yardage /
 * handicap per hole, with no player scores. Reads straight from the holes the
 * /courses/:id endpoint already returns on each teebox, so no extra fetch.
 */
function TeeScorecardModal({ teebox, courseName, onClose }: {
  teebox: any | null;
  courseName: string;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={!!teebox}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {teebox && <TeeScorecardContents teebox={teebox} courseName={courseName} onClose={onClose} />}
    </Modal>
  );
}

function TeeScorecardContents({ teebox, courseName, onClose }: {
  teebox: any;
  courseName: string;
  onClose: () => void;
}) {
  const holes = [...(teebox.holes ?? [])].sort((a: any, b: any) => a.hole_num - b.hole_num);
  const front = holes.filter((h: any) => h.hole_num <= 9);
  const back = holes.filter((h: any) => h.hole_num > 9);
  const totalPar = holes.reduce((a: number, h: any) => a + (h.par || 0), 0);
  const totalYards = holes.reduce((a: number, h: any) => a + (h.yardage || 0), 0);

  return (
    <View style={styles.modalContainer}>
      <View style={styles.modalHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.modalTitle}>{teebox.name} Tees</Text>
          <Text style={styles.modalSub}>
            {[
              courseName,
              `Par ${totalPar}`,
              teebox.course_rating ? `Rating ${teebox.course_rating}` : null,
              teebox.slope_rating ? `Slope ${teebox.slope_rating}` : null,
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} style={styles.modalDone}>
          <Text style={styles.modalDoneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {holes.length === 0 ? (
          <Text style={styles.empty}>No hole-by-hole data for this tee yet.</Text>
        ) : (
          <>
            <View style={styles.totalsCard}>
              <View style={styles.totalCell}>
                <Text style={styles.totalLabel}>PAR</Text>
                <Text style={styles.totalValue}>{totalPar}</Text>
              </View>
              <View style={styles.totalCell}>
                <Text style={styles.totalLabel}>YARDS</Text>
                <Text style={[styles.totalValue, { color: C.gold }]}>
                  {totalYards ? totalYards.toLocaleString() : '—'}
                </Text>
              </View>
              <View style={styles.totalCell}>
                <Text style={styles.totalLabel}>HOLES</Text>
                <Text style={[styles.totalValue, { color: C.textMuted }]}>
                  {teebox.num_holes ?? holes.length}
                </Text>
              </View>
            </View>

            {front.length > 0 && <TeeNineGrid label="OUT" holes={front} />}
            {back.length > 0 && <TeeNineGrid label="IN" holes={back} />}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** One nine of a generic scorecard: Hole / Par / Yards / HCP rows + a subtotal. */
function TeeNineGrid({ label, holes }: { label: string; holes: any[] }) {
  const parTotal = holes.reduce((a, h) => a + (h.par || 0), 0);
  const yardTotal = holes.reduce((a, h) => a + (h.yardage || 0), 0);
  const key = (h: any) => h.hole_id ?? h.hole_num;
  return (
    <View style={{ marginTop: 14 }}>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Hole</Text>
        {holes.map((h) => <Text key={key(h)} style={styles.scNum}>{h.hole_num}</Text>)}
        <Text style={styles.scTotal}>{label}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Par</Text>
        {holes.map((h) => <Text key={key(h)} style={styles.scParCell}>{h.par ?? '—'}</Text>)}
        <Text style={styles.scTotal}>{parTotal}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Yards</Text>
        {holes.map((h) => <Text key={key(h)} style={styles.scParCell}>{h.yardage ?? '—'}</Text>)}
        <Text style={styles.scTotal}>{yardTotal || '—'}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>HCP</Text>
        {holes.map((h) => <Text key={key(h)} style={styles.scParCell}>{h.handicap ?? '—'}</Text>)}
        <Text style={styles.scTotal}> </Text>
      </View>
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
  teeChev: { color: C.textDim, fontSize: 22, marginLeft: 8 },

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
  lbScoreBox: { alignItems: 'center', minWidth: 56 },
  lbScore: { color: C.text, fontSize: 20, fontWeight: '900' },
  lbPar: { color: C.textMuted, fontSize: 11, marginTop: 1 },
  lbNorm: { color: C.textDim, fontSize: 9, marginTop: 1 },

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

  previewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 20, marginTop: 16, padding: 16, borderRadius: 10,
    backgroundColor: C.gold + '14', borderWidth: 1, borderColor: C.gold + '66',
  },
  previewBtnTitle: { color: C.gold, fontWeight: '900', fontSize: 16 },
  previewBtnSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  previewBtnChev: { color: C.gold, fontSize: 24, fontWeight: '300' },

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
