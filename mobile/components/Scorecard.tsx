import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

export type ScorecardEntry = {
  username?: string;
  user_id?: string;
  teebox_name?: string | null;
  hole_scores?: number[] | null;
  course_id?: string | null;
  course_name?: string | null;
  teebox_id?: string | null;
  total_score?: number;
  created_at?: string;
  teebox_par?: number | null; // optional fallback total par
};

function scoreColor(score: number, par: number) {
  const d = score - par;
  if (d <= -2) return '#4CAF50';
  if (d === -1) return '#81C784';
  if (d === 0) return C.text;
  if (d === 1) return '#FF9800';
  return '#F44336';
}

function useTeeboxHoles(courseId?: string | null, teeboxId?: string | null) {
  const [holes, setHoles] = useState<any[]>([]);
  useEffect(() => {
    if (!courseId || !teeboxId) { setHoles([]); return; }
    let active = true;
    (async () => {
      try {
        const course = await api.courses.get(courseId);
        if (!active) return;
        const tb = course.teeboxes?.find((t: any) => t.teebox_id === teeboxId);
        if (tb?.holes) {
          setHoles([...tb.holes].sort((a: any, b: any) => a.hole_num - b.hole_num));
        }
      } catch { /* placeholder fallback */ }
    })();
    return () => { active = false; };
  }, [courseId, teeboxId]);
  return holes;
}

function buildGridData(entry: ScorecardEntry, holes: any[]) {
  const scores = entry.hole_scores ?? [];
  const playedHoles = holes.length >= scores.length
    ? holes.slice(0, scores.length)
    : scores.map((_, i) => ({ hole_id: `ph-${i}`, hole_num: i + 1, par: 4 }));
  const front = playedHoles.slice(0, 9);
  const back = playedHoles.slice(9);
  const frontScores = scores.slice(0, 9);
  const backScores = scores.slice(9);
  const frontPar = front.reduce((a, h) => a + h.par, 0);
  const backPar = back.reduce((a, h) => a + h.par, 0);
  const totalPar = frontPar + backPar;
  const totalScore = scores.reduce((a, b) => a + b, 0);
  return { front, back, frontScores, backScores, frontPar, backPar, totalPar, totalScore };
}

function Grid({ label, holes, scores, parTotal }: { label: string; holes: any[]; scores: number[]; parTotal: number }) {
  const scoreTotal = scores.reduce((a, b) => a + b, 0);
  return (
    <View style={{ marginTop: 10 }}>
      <View style={s.scGrid}>
        <Text style={s.scLabel}>Hole</Text>
        {holes.map((h) => <Text key={h.hole_id} style={s.scNum}>{h.hole_num}</Text>)}
        <Text style={s.scTotal}>{label}</Text>
      </View>
      <View style={s.scGrid}>
        <Text style={s.scLabel}>Par</Text>
        {holes.map((h) => <Text key={h.hole_id} style={s.scParCell}>{h.par}</Text>)}
        <Text style={s.scTotal}>{parTotal}</Text>
      </View>
      <View style={s.scGrid}>
        <Text style={s.scLabel}>Score</Text>
        {holes.map((h, i) => (
          <Text key={h.hole_id} style={[s.scScoreCell, { color: scoreColor(scores[i], h.par) }]}>
            {scores[i] ?? '-'}
          </Text>
        ))}
        <Text style={[s.scTotal, { color: scoreTotal - parTotal < 0 ? C.green : scoreTotal - parTotal > 0 ? C.red : C.text }]}>
          {scoreTotal || '-'}
        </Text>
      </View>
    </View>
  );
}

/** Inline compact scorecard — used to auto-render below match players. */
export function ScorecardCard({ entry, highlight }: { entry: ScorecardEntry; highlight?: boolean }) {
  const holes = useTeeboxHoles(entry.course_id, entry.teebox_id);
  const { front, back, frontScores, backScores, frontPar, backPar, totalPar, totalScore } = buildGridData(entry, holes);
  const diff = totalScore - totalPar;

  return (
    <View style={[s.card, highlight && { borderColor: C.gold }]}>
      <View style={s.cardHeader}>
        <Text style={s.cardName}>{entry.username}</Text>
        <Text style={s.cardTotal}>
          {totalScore} <Text style={{ color: C.textMuted, fontSize: 12 }}>
            ({diff === 0 ? 'E' : diff > 0 ? `+${diff}` : diff})
          </Text>
        </Text>
      </View>
      {entry.teebox_name && (
        <Text style={s.cardSub}>{entry.teebox_name} · Par {totalPar}</Text>
      )}
      <Grid label="OUT" holes={front} scores={frontScores} parTotal={frontPar} />
      {back.length > 0 && <Grid label="IN" holes={back} scores={backScores} parTotal={backPar} />}
    </View>
  );
}

/** Full-screen scorecard modal — used from leaderboard, profile rounds, etc. */
export function ScorecardModal({ visible, entry, onClose, onViewProfile }: {
  visible: boolean;
  entry: ScorecardEntry | null;
  onClose: () => void;
  onViewProfile?: () => void;
}) {
  const holes = useTeeboxHoles(entry?.course_id, entry?.teebox_id);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {entry && <ModalContents entry={entry} holes={holes} onClose={onClose} onViewProfile={onViewProfile} />}
    </Modal>
  );
}

function ModalContents({ entry, holes, onClose, onViewProfile }: {
  entry: ScorecardEntry;
  holes: any[];
  onClose: () => void;
  onViewProfile?: () => void;
}) {
  const { front, back, frontScores, backScores, frontPar, backPar, totalPar, totalScore } = buildGridData(entry, holes);
  const diff = totalScore - totalPar;

  return (
    <View style={s.modalContainer}>
      <View style={s.modalHeader}>
        <View style={{ flex: 1 }}>
          <Text style={s.modalTitle}>{entry.username ?? 'Scorecard'}</Text>
          <Text style={s.modalSub}>
            {[entry.teebox_name, entry.course_name].filter(Boolean).join(' · ')}
            {entry.created_at ? ` · ${new Date(entry.created_at).toLocaleDateString()}` : ''}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} style={s.modalDone}>
          <Text style={s.modalDoneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <View style={s.totalsCard}>
          <View style={s.totalCell}>
            <Text style={s.totalLabel}>SCORE</Text>
            <Text style={s.totalValue}>{totalScore}</Text>
          </View>
          <View style={s.totalCell}>
            <Text style={s.totalLabel}>TO PAR</Text>
            <Text style={[s.totalValue, { color: diff < 0 ? C.green : diff > 0 ? C.red : C.text }]}>
              {diff > 0 ? `+${diff}` : diff === 0 ? 'E' : diff}
            </Text>
          </View>
          <View style={s.totalCell}>
            <Text style={s.totalLabel}>PAR</Text>
            <Text style={[s.totalValue, { color: C.textMuted }]}>{totalPar}</Text>
          </View>
        </View>

        <Grid label="OUT" holes={front} scores={frontScores} parTotal={frontPar} />
        {back.length > 0 && <Grid label="IN" holes={back} scores={backScores} parTotal={backPar} />}

        {onViewProfile && entry.user_id && (
          <TouchableOpacity style={s.viewProfileBtn} onPress={onViewProfile}>
            <Text style={s.viewProfileBtnText}>View Profile</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderRadius: 10, padding: 12,
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  cardName: { color: C.text, fontWeight: '800', fontSize: 14 },
  cardTotal: { color: C.text, fontFamily: F.serif, fontSize: 20, fontWeight: '700' },
  cardSub: { color: C.textMuted, fontSize: 11, marginBottom: 8 },

  scGrid: { flexDirection: 'row', alignItems: 'center', minHeight: 22 },
  scLabel: { width: 40, color: C.textDim, fontSize: 10, fontWeight: '700' },
  scNum: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center', fontWeight: '700' },
  scParCell: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center' },
  scScoreCell: { flex: 1, fontSize: 13, textAlign: 'center', fontWeight: '700' },
  scTotal: { width: 40, color: C.gold, fontSize: 11, textAlign: 'center', fontWeight: '800' },

  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border, gap: 12,
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

  viewProfileBtn: {
    marginTop: 24, borderRadius: 8, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '22',
  },
  viewProfileBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },
});
