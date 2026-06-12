import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal, TextInput, Alert } from 'react-native';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { scoreColor } from '../lib/golfMath';
import type { HoleStat } from '../lib/scoringTypes';
import { ShotMapModal } from './ShotMap';
import { useCensor } from '../lib/censor';

/** Idempotency key for a single comment send attempt. The server has a
 *  partial unique index on (user_id, client_id), so retrying with the same
 *  id can never duplicate the comment — which makes retry-after-timeout
 *  safe. Same scheme as chat sends. */
function genClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** One comment row. `_status` / `_failReason` are LOCAL ONLY — never come
 *  from the server. 'sending' renders the row dimmed; 'failed' renders the
 *  tap-to-retry affordance. */
type RoundComment = {
  comment_id: string;
  user_id: string;
  username: string;
  body: string;
  created_at: string;
  mine: boolean;
  client_id?: string | null;
  _status?: 'sending' | 'failed';
  _failReason?: string;
};

// Re-export so existing importers of HoleStat from Scorecard keep working.
export type { HoleStat };

/** Default emoji reactions — shown as quick-pick chips. The user can also
 *  type any emoji via the "+" button which opens an inline input. Reactions
 *  are now stored as the raw emoji string on the server. */
const DEFAULT_REACTION_EMOJIS = ['🔥', '👏', '💪', '😂', '🤯', '🐐'] as const;

/** Back-compat: map historical text-token reactions ('fire', 'pure', etc.)
 *  to their emoji equivalents so legacy rows render nicely alongside new
 *  emoji-style reactions. Toggling one of these still sends the original
 *  token to the server (back-compat path through isValidReaction). */
const LEGACY_TOKEN_TO_EMOJI: Record<string, string> = {
  fire: '🔥',
  pure: '🎯',
  goat: '🐐',
  clutch: '💪',
  respect: '🙌',
  oof: '😬',
};
function displayReaction(stored: string): string {
  return LEGACY_TOKEN_TO_EMOJI[stored] ?? stored;
}

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
  // Which subset of an 18-hole teebox this round covered. 'full' = 18 holes,
  // 'front' = 1-9, 'back' = 10-18. When 'back', the score array represents
  // holes 10-18 and the grid should render with those hole numbers.
  holes_subset?: 'front' | 'back' | 'full' | null;
  /** Player's handicap index — used as the SG skill baseline. When omitted
   *  (e.g. legacy callers, or a player with no rounds yet) the SG math
   *  falls back to scratch (par) baseline. */
  handicap_index?: number | null;
};

/** Compute 4-category strokes-gained totals and the per-hole sample size.
 *
 * SG is measured against the player's *handicap-adjusted* expectation, not
 * against par. A 20-cap shooting their handicap on par 72 should see ~0 SG
 * total. Mirrors the backend basic-SG model in users.ts so the in-app
 * scorecard preview matches the profile-stats numbers.
 *
 *   expected_strokes_per_hole = par + (handicap_index / 18)
 *
 * Short-game baselines (putting/around-green/approach) stay absolute —
 * they measure short-game skill in absolute terms regardless of handicap.
 * The handicap shift is absorbed entirely by the Off-the-Tee residual.
 */
function computeRoundSG(
  scores: number[],
  stats: HoleStat[] | null | undefined,
  holes: { par: number }[],
  handicapIndex: number = 0,
) {
  let off_tee = 0, approach = 0, around_green = 0, putting = 0, total = 0;
  let sgHoles = 0;
  if (!stats || !stats.length) return null;
  const expectedExtraPerHole = (handicapIndex || 0) / 18;
  for (let i = 0; i < scores.length; i++) {
    const par = holes[i]?.par;
    const strokes = scores[i];
    const h = stats[i];
    if (!h || par == null || !strokes) continue;
    const putts = typeof h.putts === 'number' ? h.putts : null;
    const chips = typeof h.chips === 'number' ? h.chips : null;
    const gir = typeof h.gir === 'boolean' ? h.gir : null;
    if (putts === null || chips === null || gir === null) continue;
    // Putting baseline: 1 if player chipped on (already "near" green), else 2.
    // Mirrors backend basic-SG model in users.ts.
    const puttBaseline = chips > 0 ? 1 : 2;
    const putt = puttBaseline - putts;
    const around = chips > 0 ? 1 - chips : 0;
    const appr = gir ? 0 : -1;
    const expectedStrokes = par + expectedExtraPerHole;
    const tee = (expectedStrokes - strokes) - putt - around - appr;
    putting += putt;
    around_green += around;
    approach += appr;
    off_tee += tee;
    total += (expectedStrokes - strokes);
    sgHoles += 1;
  }
  if (sgHoles === 0) return null;
  return { off_tee, approach, around_green, putting, total, sgHoles };
}

/** Inline strokes-gained summary row — renders nothing if no SG-eligible holes. */
function RoundSGSummary({ entry, holes }: { entry: ScorecardEntry; holes: any[] }) {
  const sg = computeRoundSG(
    entry.hole_scores ?? [], entry.hole_stats ?? null, holes,
    entry.handicap_index ?? 0,
  );
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
  // For a back-9 round, the score array's first element is hole 10. Offset
  // the teebox holes window accordingly so the grid labels match.
  const isBack9 = entry.holes_subset === 'back';
  const offset = isBack9 ? 9 : 0;
  const playedHoles = holes.length >= offset + scores.length
    ? holes.slice(offset, offset + scores.length)
    : scores.map((_, i) => ({ hole_id: `ph-${i}`, hole_num: offset + i + 1, par: 4 }));
  // For a back-9, all played holes go in the "back" column; "front" is empty.
  // For a front-9 (or 18), the existing 0-9 / 9-18 split applies.
  const front = isBack9 ? [] : playedHoles.slice(0, 9);
  const back  = isBack9 ? playedHoles : playedHoles.slice(9);
  const frontScores = isBack9 ? [] : scores.slice(0, 9);
  const backScores  = isBack9 ? scores : scores.slice(9);
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
  const c = useCensor();
  const { front, back, frontScores, backScores, frontPar, backPar, totalPar, totalScore } = buildGridData(entry, holes);
  const diff = totalScore - totalPar;

  const Inner = (
    <>
      <View style={s.cardHeader}>
        <Text style={s.cardName}>{c(entry.username)}</Text>
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
  const censor = useCensor();
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
  const { user } = useAuth();
  const [reactions, setReactions] = useState<{ reaction: string; count: number; mine: boolean }[]>([]);
  const [comments, setComments] = useState<RoundComment[]>([]);
  const [commentDraft, setCommentDraft] = useState('');

  // Local comments that haven't been confirmed by the server yet, keyed by
  // client_id. The merged view = server rows + these, with any local whose
  // client_id shows up in a server row dropped (its send actually landed —
  // covers the "request succeeded but the response timed out" case).
  const localsRef = useRef<Map<string, RoundComment>>(new Map());

  const mergeServer = useCallback((server: RoundComment[]) => {
    const locals = localsRef.current;
    for (const c of server) {
      if (c.client_id && locals.has(c.client_id)) locals.delete(c.client_id);
    }
    return [...server, ...Array.from(locals.values())];
  }, []);

  const loadSocial = useCallback(() => {
    if (!entry.round_id) return;
    api.rounds.social(entry.round_id)
      .then((d) => { setReactions(d.reactions); setComments(mergeServer(d.comments)); })
      .catch(() => { });
  }, [entry.round_id, mergeServer]);

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

  /** POST one comment. On success the optimistic row is swapped for the
   *  confirmed row; on failure it flips to 'failed' (tap to retry).
   *  Retries reuse the same clientId, so duplicates are impossible. */
  const postComment = useCallback(async (clientId: string, bodyText: string) => {
    if (!entry.round_id) return;
    try {
      const r = await api.rounds.addComment(entry.round_id, bodyText, clientId);
      const cur = localsRef.current.get(clientId);
      localsRef.current.delete(clientId);
      const confirmed: RoundComment = {
        ...(cur ?? { user_id: user?.user_id ?? '', username: user?.username ?? '', body: bodyText, mine: true }),
        comment_id: r.comment_id,
        created_at: r.created_at,
        client_id: r.client_id ?? clientId,
        _status: undefined,
        _failReason: undefined,
      };
      setComments((prev) => {
        const without = prev.filter((c) =>
          (c.client_id ?? c.comment_id) !== clientId && c.comment_id !== confirmed.comment_id);
        return [...without, confirmed];
      });
    } catch (e: any) {
      // 4xx = the server understood and said no (round deleted...). Surface
      // the reason — a retry without fixing the cause fails the same way.
      // Network-class failures stay quiet: the row shows the retry state.
      const rejected = typeof e?.status === 'number' && e.status >= 400 && e.status < 500;
      const cur = localsRef.current.get(clientId);
      if (cur) {
        const failed: RoundComment = {
          ...cur, _status: 'failed',
          _failReason: rejected ? (e?.message ?? 'Could not post') : undefined,
        };
        localsRef.current.set(clientId, failed);
        setComments((prev) => prev.map((c) =>
          (c.client_id ?? c.comment_id) === clientId ? failed : c));
      }
      if (rejected) Alert.alert('Could not comment', e?.message ?? 'Try again.');
    }
  }, [entry.round_id, user?.user_id, user?.username]);

  /** Flip a failed comment back to 'sending' and re-POST it. */
  const retryComment = useCallback((clientId: string) => {
    const cur = localsRef.current.get(clientId);
    if (!cur) return;
    const again: RoundComment = { ...cur, _status: 'sending', _failReason: undefined };
    localsRef.current.set(clientId, again);
    setComments((prev) => prev.map((c) =>
      (c.client_id ?? c.comment_id) === clientId ? again : c));
    void postComment(clientId, again.body);
  }, [postComment]);

  /** Remove a failed local comment that never reached the server. */
  const discardComment = useCallback((clientId: string) => {
    localsRef.current.delete(clientId);
    setComments((prev) => prev.filter((c) => (c.client_id ?? c.comment_id) !== clientId));
  }, []);

  const submitComment = () => {
    const text = commentDraft.trim();
    if (!text || !entry.round_id || !user) return;
    setCommentDraft('');
    // Optimistic: the comment appears instantly in 'sending' state and the
    // POST happens behind it — same flow as chat bubbles. Failures show an
    // explicit tap-to-retry row instead of silently eating the text.
    const clientId = genClientId();
    const local: RoundComment = {
      comment_id: clientId,
      client_id: clientId,
      created_at: new Date().toISOString(),
      body: text,
      user_id: user.user_id,
      username: user.username,
      mine: true,
      _status: 'sending',
    };
    localsRef.current.set(clientId, local);
    setComments((prev) => [...prev, local]);
    void postComment(clientId, text);
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
          <Text style={s.modalTitle}>{entry.username ? censor(entry.username) : 'Scorecard'}</Text>
          <Text style={s.modalSub}>
            {[entry.teebox_name, entry.course_name].filter(Boolean).join(' · ')}
            {entry.created_at ? ` · ${new Date(entry.created_at).toLocaleDateString()}` : ''}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} style={s.modalDone}>
          <Text style={s.modalDoneText}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
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
            <ReactionsRow
              reactions={reactions}
              onToggle={toggleReaction}
            />

            <Text style={s.shotsTitle}>COMMENTS</Text>
            {comments.length === 0 ? (
              <Text style={s.emptyComment}>Be the first to comment.</Text>
            ) : comments.map((c) => (
              // Tap a failed row to retry the send; sending rows render dimmed.
              <TouchableOpacity
                key={c.client_id ?? c.comment_id}
                style={[s.commentRow, c._status === 'sending' && { opacity: 0.55 }]}
                disabled={c._status !== 'failed'}
                onPress={() => c.client_id && retryComment(c.client_id)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.commentAuthor}>{censor(c.username)}</Text>
                  <Text style={s.commentBody}>{censor(c.body)}</Text>
                  {c._status === 'sending' ? (
                    <Text style={s.commentTime}>Sending…</Text>
                  ) : c._status === 'failed' ? (
                    <Text style={s.commentFailed}>
                      {c._failReason ? `${c._failReason} · tap to retry` : 'Not sent · tap to retry'}
                    </Text>
                  ) : (
                    <Text style={s.commentTime}>{new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                  )}
                </View>
                {/* Failed locals get Discard (drop the unsent text); confirmed
                    own comments keep the server Delete. Hidden mid-send. */}
                {c._status === 'failed' && c.client_id ? (
                  <TouchableOpacity onPress={() => discardComment(c.client_id!)}>
                    <Text style={s.commentDelete}>Discard</Text>
                  </TouchableOpacity>
                ) : c.mine && !c._status ? (
                  <TouchableOpacity onPress={() => deleteComment(c.comment_id)}>
                    <Text style={s.commentDelete}>Delete</Text>
                  </TouchableOpacity>
                ) : null}
              </TouchableOpacity>
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
                style={[s.commentSendBtn, !commentDraft.trim() && { opacity: 0.4 }]}
                onPress={submitComment}
                disabled={!commentDraft.trim()}
              >
                <Text style={s.commentSendText}>Post</Text>
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

/**
 * Reactions row — quick-pick default emojis + every server-stored reaction
 * (so legacy tokens and custom emojis other viewers added still appear) +
 * a "+" button that opens an inline TextInput for any emoji.
 *
 * Stored vs displayed: the server keeps the raw string (emoji or legacy
 * token). For display we map legacy tokens to emojis via displayReaction.
 * For toggle, we always send the raw stored string back to the server so
 * back-compat keeps working.
 */
function ReactionsRow({
  reactions,
  onToggle,
}: {
  reactions: { reaction: string; count: number; mine: boolean }[];
  onToggle: (raw: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Union of: server-stored reactions (with counts) + default emoji presets
  // that have no count yet (so the quick-picks always show as "tappable").
  // Dedup by stored key so a default that's also stored doesn't double-render.
  const present = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) present.set(r.reaction, { count: r.count, mine: r.mine });

  const ordered: { stored: string; count: number; mine: boolean; isDefault: boolean }[] = [];
  // Defaults first so the UX stays consistent across reloads.
  for (const e of DEFAULT_REACTION_EMOJIS) {
    const p = present.get(e);
    ordered.push({ stored: e, count: p?.count ?? 0, mine: p?.mine ?? false, isDefault: true });
    if (p) present.delete(e);
  }
  // Then any other server reactions (legacy tokens + custom emojis).
  for (const [stored, info] of present.entries()) {
    ordered.push({ stored, count: info.count, mine: info.mine, isDefault: false });
  }

  const submitCustom = () => {
    const v = draft.trim();
    // Server validates further (length, non-ASCII), but a quick local check
    // avoids a pointless round-trip on empty/whitespace input.
    if (!v || v.length > 16) return;
    if (/^[\x00-\x7F]+$/.test(v)) {
      Alert.alert('Use an emoji', 'Reactions must include at least one emoji character.');
      return;
    }
    onToggle(v);
    setDraft('');
    setPickerOpen(false);
  };

  return (
    <View>
      <View style={s.reactionRow}>
        {ordered.map((o) => (
          <TouchableOpacity
            key={o.stored}
            style={[s.reactionBtn, o.mine && s.reactionBtnActive]}
            onPress={() => onToggle(o.stored)}
          >
            <Text style={[s.reactionLabel, o.mine && { color: C.gold }]}>
              {displayReaction(o.stored)}
            </Text>
            {o.count > 0 && (
              <Text style={[s.reactionCount, o.mine && { color: C.gold }]}>{o.count}</Text>
            )}
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[s.reactionBtn, pickerOpen && s.reactionBtnActive]}
          onPress={() => setPickerOpen((v) => !v)}
        >
          <Text style={[s.reactionLabel, pickerOpen && { color: C.gold }]}>+</Text>
        </TouchableOpacity>
      </View>

      {pickerOpen && (
        <View style={s.customReactionRow}>
          <TextInput
            style={s.customReactionInput}
            value={draft}
            onChangeText={(t) => setDraft(t.slice(0, 16))}
            placeholder="Tap 🌐 on your keyboard for emojis"
            placeholderTextColor={C.textMuted}
            maxLength={16}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
          />
          <TouchableOpacity
            style={[s.customReactionAdd, !draft.trim() && { opacity: 0.4 }]}
            onPress={submitCustom}
            disabled={!draft.trim()}
          >
            <Text style={s.customReactionAddText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}
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
  // Emojis render at a slightly bigger font than the old text labels so the
  // glyph reads clearly. Drop the serif font + letter-spacing — both are
  // text-only typographic flourishes that hurt emoji rendering.
  reactionLabel: { color: C.text, fontWeight: '800', fontSize: 16 },
  reactionCount: { color: C.textMuted, fontWeight: '800', fontSize: 11 },

  customReactionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 8,
  },
  customReactionInput: {
    flex: 1, backgroundColor: C.card, color: C.text,
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16,
    borderWidth: 1, borderColor: C.border,
  },
  customReactionAdd: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6,
    backgroundColor: C.gold,
  },
  customReactionAddText: { color: '#000', fontWeight: '900', fontSize: 13 },

  emptyComment: { color: C.textDim, fontStyle: 'italic', fontSize: 12, paddingVertical: 8 },
  commentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  commentAuthor: { color: C.gold, fontWeight: '800', fontSize: 12 },
  commentBody: { color: C.text, fontSize: 13, marginTop: 3, lineHeight: 18 },
  commentTime: { color: C.textDim, fontSize: 10, marginTop: 4 },
  commentFailed: { color: C.red, fontSize: 10, marginTop: 4, fontWeight: '700' },
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
