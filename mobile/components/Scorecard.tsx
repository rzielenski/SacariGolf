import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal, TextInput, Alert } from 'react-native';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { ShotMapModal } from './ShotMap';

const REACTION_OPTIONS = [
  { id: 'fire', label: 'FIRE' },
  { id: 'pure', label: 'PURE' },
  { id: 'goat', label: 'GOAT' },
  { id: 'clutch', label: 'CLUTCH' },
  { id: 'respect', label: 'RESPECT' },
  { id: 'oof', label: 'OOF' },
];

export type HoleStat = {
  putts?: number;
  chips?: number;
  gir?: boolean | null;
  fairwayHit?: boolean | null;
};

export type ScorecardEntry = {
  username?: string;
  user_id?: string;
  teebox_name?: string | null;
  hole_scores?: number[] | null;
  hole_stats?: HoleStat[] | null;
  course_id?: string | null;
  course_name?: string | null;
  teebox_id?: string | null;
  total_score?: number;
  created_at?: string;
  teebox_par?: number | null; // optional fallback total par
  match_id?: string | null;   // when set, enables shot-map viewing
  round_id?: string | null;   // when set, enables comments / reactions
};

/** Compute 4-category strokes-gained totals and the per-hole sample size. */
export function computeRoundSG(
  scores: number[],
  stats: HoleStat[] | null | undefined,
  holes: { par: number }[],
) {
  let off_tee = 0, approach = 0, around_green = 0, putting = 0, total = 0;
  let sgHoles = 0;
  if (!stats || !stats.length) return null;
  for (let i = 0; i < scores.length; i++) {
    const par = holes[i]?.par;
    const strokes = scores[i];
    const h = stats[i];
    if (!h || par == null || !strokes) continue;
    const putts = typeof h.putts === 'number' ? h.putts : null;
    const chips = typeof h.chips === 'number' ? h.chips : null;
    const gir = typeof h.gir === 'boolean' ? h.gir : null;
    if (putts === null || chips === null || gir === null) continue;
    const putt = 2 - putts;
    const around = chips > 0 ? 1 - chips : 0;
    const appr = gir ? 0 : -1;
    const tee = (par - strokes) - putt - around - appr;
    putting += putt;
    around_green += around;
    approach += appr;
    off_tee += tee;
    total += (par - strokes);
    sgHoles += 1;
  }
  if (sgHoles === 0) return null;
  return { off_tee, approach, around_green, putting, total, sgHoles };
}

/** Inline strokes-gained summary row — renders nothing if no SG-eligible holes. */
export function RoundSGSummary({ entry, holes }: { entry: ScorecardEntry; holes: any[] }) {
  const sg = computeRoundSG(entry.hole_scores ?? [], entry.hole_stats ?? null, holes);
  if (!sg) return null;
  const fmt = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
  const color = (n: number) => (n > 0.05 ? C.green : n < -0.05 ? C.red : C.text);
  return (
    <View style={s.sgWrap}>
      <Text style={s.sgHeader}>STROKES GAINED  ·  {sg.sgHoles} hole{sg.sgHoles === 1 ? '' : 's'} tracked</Text>
      <View style={s.sgRow}>
        <View style={s.sgCell}><Text style={s.sgLabel}>Off-Tee</Text><Text style={[s.sgVal, { color: color(sg.off_tee) }]}>{fmt(sg.off_tee)}</Text></View>
        <View style={s.sgCell}><Text style={s.sgLabel}>Approach</Text><Text style={[s.sgVal, { color: color(sg.approach) }]}>{fmt(sg.approach)}</Text></View>
        <View style={s.sgCell}><Text style={s.sgLabel}>Around</Text><Text style={[s.sgVal, { color: color(sg.around_green) }]}>{fmt(sg.around_green)}</Text></View>
        <View style={s.sgCell}><Text style={s.sgLabel}>Putt</Text><Text style={[s.sgVal, { color: color(sg.putting) }]}>{fmt(sg.putting)}</Text></View>
        <View style={s.sgCell}><Text style={s.sgLabel}>Total</Text><Text style={[s.sgVal, { color: color(sg.total), fontWeight: '800' }]}>{fmt(sg.total)}</Text></View>
      </View>
    </View>
  );
}

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
export function ScorecardCard({ entry, highlight, onPress }: {
  entry: ScorecardEntry;
  highlight?: boolean;
  onPress?: () => void;
}) {
  const holes = useTeeboxHoles(entry.course_id, entry.teebox_id);
  const { front, back, frontScores, backScores, frontPar, backPar, totalPar, totalScore } = buildGridData(entry, holes);
  const diff = totalScore - totalPar;

  const Inner = (
    <>
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
      <RoundSGSummary entry={entry} holes={[...front, ...back]} />
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.7} style={[s.card, highlight && { borderColor: C.gold }]} onPress={onPress}>
        {Inner}
      </TouchableOpacity>
    );
  }
  return <View style={[s.card, highlight && { borderColor: C.gold }]}>{Inner}</View>;
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

  // Pull shot tracks for this player on this match so we can list which holes
  // have a recorded track and let the user tap into the shot map.
  const [trackedHoles, setTrackedHoles] = useState<{ hole_num: number; count: number }[]>([]);
  const [shotHole, setShotHole] = useState<number | null>(null);
  useEffect(() => {
    if (!entry.match_id || !entry.user_id) { setTrackedHoles([]); return; }
    let cancelled = false;
    api.matches.listShotTracks(entry.match_id, entry.user_id)
      .then((rows) => {
        if (cancelled) return;
        setTrackedHoles(
          rows
            .filter((r) => (r.shots?.length ?? 0) > 0)
            .map((r) => ({ hole_num: r.hole_num, count: r.shots.length }))
            .sort((a, b) => a.hole_num - b.hole_num)
        );
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [entry.match_id, entry.user_id]);

  const allHoles = [...front, ...back];
  const parForHole = (holeNum: number) =>
    allHoles.find((h: any) => h.hole_num === holeNum)?.par ?? null;

  // Reactions + comments — only enabled when a round_id is supplied
  const [reactions, setReactions] = useState<{ reaction: string; count: number; mine: boolean }[]>([]);
  const [comments, setComments] = useState<{ comment_id: string; user_id: string; username: string; body: string; created_at: string; mine: boolean }[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const loadSocial = useCallback(() => {
    if (!entry.round_id) return;
    api.rounds.social(entry.round_id)
      .then((d) => { setReactions(d.reactions); setComments(d.comments); })
      .catch(() => { });
  }, [entry.round_id]);

  useEffect(() => { loadSocial(); }, [loadSocial]);

  const toggleReaction = async (id: string) => {
    if (!entry.round_id) return;
    // Optimistic update
    setReactions((prev) => {
      const found = prev.find((r) => r.reaction === id);
      if (found) {
        const newCount = found.count + (found.mine ? -1 : 1);
        const next = newCount <= 0 && found.mine
          ? prev.filter((r) => r.reaction !== id)
          : prev.map((r) => r.reaction === id ? { ...r, count: newCount, mine: !r.mine } : r);
        return next;
      }
      return [...prev, { reaction: id, count: 1, mine: true }];
    });
    try { await api.rounds.toggleReaction(entry.round_id, id); }
    catch { loadSocial(); /* revert via refetch */ }
  };

  const submitComment = async () => {
    const text = commentDraft.trim();
    if (!text || !entry.round_id) return;
    setPosting(true);
    try {
      await api.rounds.addComment(entry.round_id, text);
      setCommentDraft('');
      loadSocial();
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setPosting(false); }
  };

  const deleteComment = (commentId: string) => {
    Alert.alert('Delete comment', 'Remove this comment?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          if (!entry.round_id) return;
          try { await api.rounds.deleteComment(entry.round_id, commentId); loadSocial(); }
          catch (e: any) { Alert.alert('Error', e.message); }
        }
      }
    ]);
  };

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
        <RoundSGSummary entry={entry} holes={[...front, ...back]} />

        {/* Shot maps — holes the player tracked GPS shots on */}
        {trackedHoles.length > 0 && (
          <>
            <Text style={s.shotsTitle}>SHOT MAPS</Text>
            {trackedHoles.map((th) => (
              <TouchableOpacity
                key={th.hole_num}
                style={s.shotsRow}
                onPress={() => setShotHole(th.hole_num)}
              >
                <Text style={s.shotsRowHole}>Hole {th.hole_num}</Text>
                <Text style={s.shotsRowMeta}>{th.count} {th.count === 1 ? 'shot' : 'shots'} tracked</Text>
                <Text style={s.shotsRowChev}>›</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* Reactions + comments — only shown when this scorecard has a round_id */}
        {entry.round_id && (
          <>
            <Text style={s.shotsTitle}>REACTIONS</Text>
            <View style={s.reactionRow}>
              {REACTION_OPTIONS.map((opt) => {
                const r = reactions.find((rx) => rx.reaction === opt.id);
                const count = r?.count ?? 0;
                const mine = r?.mine ?? false;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[s.reactionBtn, mine && s.reactionBtnActive]}
                    onPress={() => toggleReaction(opt.id)}
                  >
                    <Text style={[s.reactionLabel, mine && { color: C.gold }]}>{opt.label}</Text>
                    {count > 0 && <Text style={[s.reactionCount, mine && { color: C.gold }]}>{count}</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={s.shotsTitle}>COMMENTS</Text>
            {comments.length === 0 ? (
              <Text style={s.emptyComment}>Be the first to comment.</Text>
            ) : comments.map((c) => (
              <View key={c.comment_id} style={s.commentRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.commentAuthor}>{c.username}</Text>
                  <Text style={s.commentBody}>{c.body}</Text>
                  <Text style={s.commentTime}>{new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                </View>
                {c.mine && (
                  <TouchableOpacity onPress={() => deleteComment(c.comment_id)}>
                    <Text style={s.commentDelete}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            <View style={s.commentInputRow}>
              <TextInput
                style={s.commentInput}
                value={commentDraft}
                onChangeText={(t) => setCommentDraft(t.slice(0, 280))}
                placeholder="Write a comment..."
                placeholderTextColor={C.textMuted}
                multiline
                maxLength={280}
              />
              <TouchableOpacity
                style={[s.commentSendBtn, (!commentDraft.trim() || posting) && { opacity: 0.4 }]}
                onPress={submitComment}
                disabled={!commentDraft.trim() || posting}
              >
                <Text style={s.commentSendText}>{posting ? '...' : 'Post'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {onViewProfile && entry.user_id && (
          <TouchableOpacity style={s.viewProfileBtn} onPress={onViewProfile}>
            <Text style={s.viewProfileBtnText}>View Profile</Text>
          </TouchableOpacity>
        )}

        <ShotMapModal
          visible={shotHole != null}
          matchId={entry.match_id}
          userId={entry.user_id}
          username={entry.username}
          holeNum={shotHole}
          par={shotHole != null ? parForHole(shotHole) : null}
          onClose={() => setShotHole(null)}
        />
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
  sgWrap: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  sgHeader: { color: C.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginBottom: 4 },
  sgRow: { flexDirection: 'row', justifyContent: 'space-between' },
  sgCell: { flex: 1, alignItems: 'center' },
  sgLabel: { color: C.textMuted, fontSize: 10 },
  sgVal: { color: C.text, fontFamily: F.serif, fontSize: 14, marginTop: 2 },

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

  shotsTitle: {
    color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.5,
    marginTop: 24, marginBottom: 8, fontFamily: F.serif,
  },
  shotsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  shotsRowHole: { color: C.text, fontWeight: '800', fontSize: 14, minWidth: 60 },
  shotsRowMeta: { color: C.textMuted, fontSize: 12, flex: 1 },
  shotsRowChev: { color: C.gold, fontSize: 22, fontWeight: '300' },

  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  reactionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  reactionBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  reactionLabel: { color: C.textMuted, fontWeight: '800', fontSize: 11, letterSpacing: 0.8, fontFamily: F.serif },
  reactionCount: { color: C.textMuted, fontWeight: '800', fontSize: 11 },

  emptyComment: { color: C.textDim, fontStyle: 'italic', fontSize: 12, paddingVertical: 8 },
  commentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  commentAuthor: { color: C.gold, fontWeight: '800', fontSize: 12 },
  commentBody: { color: C.text, fontSize: 13, marginTop: 3, lineHeight: 18 },
  commentTime: { color: C.textDim, fontSize: 10, marginTop: 4 },
  commentDelete: { color: C.red, fontSize: 11, fontWeight: '700' },
  commentInputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 6,
  },
  commentInput: {
    flex: 1, backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, maxHeight: 120,
    borderWidth: 1, borderColor: C.border, minHeight: 40,
  },
  commentSendBtn: {
    backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 10,
  },
  commentSendText: { color: '#000', fontWeight: '800', fontSize: 13 },
});
