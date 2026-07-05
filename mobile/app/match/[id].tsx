import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Share, Modal, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, isSilentError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCensor } from '../../lib/censor';
import { C, F } from '../../lib/colors';
import { Match, MatchPlayer } from '../../types';
import { ScorecardCard, ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { OrnamentTitle, Divider } from '../../components/Flourish';
import { IdentityAvatar, IdentityName } from '../../components/UserIdentity';
import { InviteFriendsModal } from '../../components/InviteFriendsModal';
import { LiveLeaderboard } from '../../components/LiveLeaderboard';
import { rankForElo } from '../../lib/rank';

export default function MatchLobbyScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  // Drop-in censor function — pipes any user-controlled string through
  // the offensive-language filter when the viewer's preference is ON
  // (default). Usernames, match/duo names, and guest names all flow
  // through it.
  const c = useCensor();
  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  // Group-scoring modal: host can enter scorecards for non-account players.
  const [guestModalOpen, setGuestModalOpen] = useState(false);
  const [guestDraft, setGuestDraft] = useState<{ name: string; scores: string[] }[]>([]);
  const [savingGuests, setSavingGuests] = useState(false);
  // Share-loop prompt: when a finished match is a win or a promotion, we nudge
  // the player to share the recap at the dopamine moment (once per match).
  const [sharePrompt, setSharePrompt] = useState<{ won: boolean; rankUp: boolean; delta: number; rankLabel: string } | null>(null);
  // The VS intro is triggered globally by MatchFoundWatcher (registered in
  // app/_layout.tsx) so it fires from any screen — including the scoring
  // screen mid-round and the moment the app foregrounds. No screen-local
  // logic needed here anymore.

  const load = useCallback(async () => {
    try {
      const data = await api.matches.get(id);
      setMatch(data);
      // Check for locally-saved in-progress round (per-user key so accounts
      // on the same device don't see each other's saved progress).
      // Also confirm against the server: if THIS user already submitted scores
      // OR has a teebox set, there's no point showing "Continue Match" — they'd
      // just be re-entering scoring on data the server already has.
      try {
        const saved = await AsyncStorage.getItem(`scores_${user?.user_id ?? 'anon'}_${id}`);
        const me = data.players?.find((p: any) => p.user_id === user?.user_id);
        const hasServerProgress = !!(me?.teebox_id) || (me?.hole_scores?.length ?? 0) > 0;
        setHasSavedProgress(!!saved || hasServerProgress);
      } catch { /* ignore */ }
    } catch (e: any) {
      // This load effect re-fires whenever auth state flips (it depends on
      // user?.user_id). On logout / token-invalidation the re-fire hits the
      // API with no token → NotAuthenticatedError. The app is already
      // navigating to login — surfacing "Error: Not signed in" is just noise.
      if (isSilentError(e)) return;
      // 404 → the match was completed / cancelled / deleted server-side.
      // Most common cause: tapping a stale "resume round" entry or an old
      // notification. Don't pop a scary "Match not found" alert — just go
      // back to wherever the user came from.
      if (e?.status === 404) { router.back(); return; }
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, [id, user?.user_id]);

  useEffect(() => { load(); }, [load]);

  // Keep the lobby live. The only fetch used to be the mount effect above, so a
  // resolved match never flipped to its VICTORY/DEFEAT card, "done" dots never
  // lit, and the waiting copy froze until the user backed out and reopened.
  // Poll lightly while the match is still in progress and stop once it's
  // completed (nothing left to update). Also refetch whenever the screen
  // regains focus so returning from scoring / a profile shows fresh state.
  //
  // Focus-gated: this screen stays MOUNTED underneath the scoring screen for
  // the entire round, and an ungated interval polled from under it for hours.
  // The useFocusEffect below refetches immediately on pop-back, so nothing is
  // stale when the player actually sees the lobby again.
  const lobbyFocused = useIsFocused();
  useEffect(() => {
    if (match?.completed || !lobbyFocused) return;
    const t = setInterval(() => { load(); }, 12000);
    return () => clearInterval(t);
  }, [match?.completed, load, lobbyFocused]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Share-loop trigger. When a completed match the viewer played is a WIN or a
  // promotion, prompt them to share the recap — once per match. Promotion is
  // derived from the current SR and this match's signed swing, so no pre-match
  // SR needs to be stashed. Practice rounds and spectators never prompt.
  useEffect(() => {
    if (!match || !match.completed || match.is_practice) return;
    const me = match.players?.find((p) => p.user_id === user?.user_id);
    if (!me) return;
    const myDelta = match.my_delta_elo ?? 0;
    const won = match.result?.winner_side != null && match.result.winner_side === me.side;
    const postElo = me.elo ?? 0;
    const preRank = rankForElo(postElo - myDelta);
    const postRank = rankForElo(postElo);
    const rankUp = myDelta > 0 && postRank.label !== preRank.label;
    if (!won && !rankUp) return;
    const key = `share_prompt_${user?.user_id ?? 'anon'}_${id}`;
    let cancelled = false;
    (async () => {
      try {
        if (await AsyncStorage.getItem(key)) return;     // already nudged for this match
        await AsyncStorage.setItem(key, '1');
        if (!cancelled) setSharePrompt({ won, rankUp, delta: myDelta, rankLabel: postRank.label });
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [match, user?.user_id, id]);

  // ── ALL HOOKS MUST BE DECLARED BEFORE THE EARLY RETURNS BELOW. ───────────
  // React hooks count must stay identical across renders. The three
  // useCallbacks below USED to live further down, but a `match` null check
  // returned early on first render — skipping them — and then included them
  // on a later render once `match` loaded. That mismatch is the classic
  // "Rendered fewer hooks than expected" crash that took out the entire
  // start-of-round flow. Keep them up here.
  const openGuestModal = useCallback(() => {
    const N = match?.num_holes ?? 18;
    const existing = match?.guest_players ?? [];
    if (existing.length) {
      setGuestDraft(existing.map((g) => ({
        name: g.name,
        scores: Array.from({ length: N }, (_, i) => g.scores?.[i] != null ? String(g.scores[i]) : ''),
      })));
    } else {
      setGuestDraft([{ name: '', scores: Array.from({ length: N }, () => '') }]);
    }
    setGuestModalOpen(true);
  }, [match]);

  const saveGuests = useCallback(async () => {
    setSavingGuests(true);
    try {
      const cleaned = guestDraft
        .filter((g) => g.name.trim())
        .map((g) => ({
          name: g.name.trim().slice(0, 30),
          scores: g.scores.map((s) => {
            const n = parseInt(s, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
          }),
        }));
      await api.matches.setGuests(id, cleaned);
      await load();
      setGuestModalOpen(false);
    } catch (e: any) {
      Alert.alert('Could not save guests', e.message);
    } finally {
      setSavingGuests(false);
    }
  }, [guestDraft, id, load]);

  const shareRoundSummary = useCallback(async () => {
    if (!match || !match.completed) return;
    const me = match.players?.find((p) => p.user_id === user?.user_id);
    // Spectator guard: this helper assumes the caller is a participant
    // (it shares "I won/lost/drew" copy). If a non-participant somehow
    // reaches here — e.g. the Share button were ever re-exposed in a
    // context menu — bail rather than shipping wrong-narrative text.
    if (!me) return;
    const opp = match.players?.find((p) => p.user_id !== user?.user_id);
    const tied = match.result?.winner_side == null;
    const won = !tied && match.result?.winner_side === me.side;
    const myDelta = match.my_delta_elo ?? 0;
    const courseLine = me?.course_name
      ? `${me.course_name}${me.teebox_name ? ` · ${me.teebox_name} tees` : ''}`
      : '';
    const fmtName = (() => {
      switch (match.format) {
        case 'stableford': return 'Stableford';
        case 'match_play': return 'Match Play';
        case 'skins':      return 'Skins';
        case 'scramble':   return 'Scramble';
        default:           return 'Stroke Play';
      }
    })();

    const lines: string[] = [];
    lines.push(tied ? '🤝 Drew on Sacari Golf' : won ? '🏌️ Won on Sacari Golf' : '⛳ Played on Sacari Golf');
    if (courseLine) lines.push(courseLine);
    lines.push(`${fmtName} · ${match.num_holes} holes`);
    if (me?.strokes != null) lines.push(`Score: ${me.strokes}${opp?.strokes != null ? `   vs   ${opp.strokes}` : ''}`);
    if (!match.is_practice && myDelta !== 0) {
      lines.push(`SR ${myDelta > 0 ? '+' : ''}${myDelta}`);
    }
    if (me?.hole_scores?.length && me.course_id) {
      try {
        const courseDetails = await api.courses.get(me.course_id);
        const tb = courseDetails.teeboxes?.find((t: any) => t.teebox_id === me.teebox_id);
        const sortedHoles: any[] = (tb?.holes ?? []).sort((a: any, b: any) => a.hole_num - b.hole_num);
        // Back-9 rounds store hole_scores[0] as hole 10, but sortedHoles[0] is
        // hole 1 — so index the teebox holes with the same offset the scoring
        // screen uses, or we'd read the wrong par and report a hole never played.
        const offset = (match as any).holes_subset === 'back' ? 9 : 0;
        let bestDiff = 999, bestHole: number | null = null, bestScore = 0;
        for (let i = 0; i < me.hole_scores.length; i++) {
          const par = sortedHoles[offset + i]?.par;
          const sc = me.hole_scores[i];
          if (par == null || !sc) continue;
          const d = sc - par;
          if (d < bestDiff) { bestDiff = d; bestHole = sortedHoles[offset + i].hole_num; bestScore = sc; }
        }
        if (bestHole != null && bestDiff <= -1) {
          const label = bestDiff <= -2 ? 'Eagle' : 'Birdie';
          lines.push(`Best moment: ${label} on hole ${bestHole} (${bestScore})`);
        }
      } catch { /* skip best-moment if course fetch fails */ }
    }
    lines.push('');
    // A no-install recap link: opens a rich preview (crests, scores, SR swing)
    // and a download CTA. Falls back to the bare domain line if id is missing.
    const recapUrl = id ? `https://sacarigolf.com/r/${id}` : 'https://sacarigolf.com';
    lines.push(won ? `Think you can beat me? ${recapUrl}` : `Full recap + rematch me → ${recapUrl}`);
    await Share.share({ message: lines.join('\n'), url: recapUrl });
  }, [match, user, id]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.gold} />
      </View>
    );
  }

  if (!match) return null;

  const myPlayer = match.players?.find((p) => p.user_id === user?.user_id);
  const opponents = match.players?.filter((p) => p.user_id !== user?.user_id) ?? [];
  const allReady = match.players && match.players.length >= 2;
  const isCompleted = match.completed;
  const liveActive = !!(match as any).live_scores_active;
  const myLiveOptin = !!(match as any).my_live_optin;

  // Toggle this player's live-scoreboard opt-in, then refetch so the
  // active/waiting state + revealed scores update.
  const toggleLiveScores = async () => {
    setLiveBusy(true);
    try {
      await api.matches.setLiveScores(id, !myLiveOptin);
      await load();
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    } finally {
      setLiveBusy(false);
    }
  };

  const matchTypeRaw = match.match_type ?? 'match';
  const typeLabel = matchTypeRaw.charAt(0).toUpperCase() + matchTypeRaw.slice(1);
  const isPractice = match.is_practice;
  // Arena is stored as match_type 'ffa' but presented as "Arena" everywhere.
  const isArena = matchTypeRaw === 'ffa';

  // Player-count caps mirror the server's SIDE_CAPS in invites.ts so the lobby
  // hides the invite CTA exactly when an accept would be rejected as "full".
  const SIDE_CAPS: Record<string, number> = { solo: 2, duo: 4, squad: 8, ffa: 16, practice: 9 };
  const playerCount = match.players?.length ?? 0;
  const cap = SIDE_CAPS[matchTypeRaw] ?? 2;
  // Who can pull more people in: anyone in an open, non-full match that isn't a
  // pure solo (solo fills its one open slot via random matchmaking, though you
  // can still challenge a specific friend). Arena/duo/squad/practice all invite.
  const canInviteMore = !isCompleted && playerCount < cap;
  // Arena needs at least 2 players to score as a free-for-all; flag the "you're
  // here alone" state so we can nudge the host to invite before they play.
  const arenaNeedsPlayers = isArena && playerCount < 2;

  const handleStartScoring = () => {
    const holeCount = match.num_holes ?? 18;
    router.push(`/match/scoring/${id}?holes=${holeCount}` as any);
  };

  const handleShare = async () => {
    await Share.share({ message: `Join my Sacari Golf match! Match ID: ${id}` });
  };

  /** Direct forfeit — counts as a loss, full SR penalty. Used when the
   *  Cancel path is blocked because an opponent has already submitted a
   *  score, AND when the user explicitly hits the Forfeit button. */
  const doForfeit = async () => {
    setCancelling(true);
    try {
      await api.matches.forfeit(id);
      try { await AsyncStorage.removeItem(`scores_${user?.user_id ?? 'anon'}_${id}`); } catch { }
      // dismissAll, NOT replace('/(tabs)/'): replace swapped only the top
      // screen and left every screen below stranded-but-mounted, growing the
      // stack each round until iOS killed the app for memory.
      router.dismissAll();
    } catch (e: any) {
      Alert.alert('Could not forfeit', e?.message ?? 'Try again.');
    } finally {
      setCancelling(false);
    }
  };

  const handleForfeitMatch = () => {
    Alert.alert(
      'Forfeit Match',
      "Your opponent has already submitted their round, so this match can't be cancelled. Forfeiting counts as a loss and takes the full SR penalty.",
      [
        { text: 'Keep Playing', style: 'cancel' },
        { text: 'Forfeit', style: 'destructive', onPress: doForfeit },
      ],
    );
  };

  const handleCancelMatch = () => {
    Alert.alert(
      'Cancel Match',
      'This match will be deleted with no SR penalty for anyone. Continue?',
      [
        { text: 'Keep Match', style: 'cancel' },
        {
          text: 'Delete Match',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            try {
              await api.matches.cancel(id);
              try { await AsyncStorage.removeItem(`scores_${user?.user_id ?? 'anon'}_${id}`); } catch { }
              // dismissAll — see doForfeit above (stack-leak fix).
              router.dismissAll();
            } catch (e: any) {
              // 409 race: an opponent might submit in the same second the
              // user taps Cancel, even though the button below gates on
              // their player.completed. Surface a direct Forfeit offer
              // instead of just an error toast.
              const msg = String(e?.message ?? '');
              if (/forfeit/i.test(msg)) {
                Alert.alert(
                  "Can't cancel any more",
                  "Your opponent just submitted their round. Forfeit instead?",
                  [
                    { text: 'Keep Playing', style: 'cancel' },
                    { text: 'Forfeit', style: 'destructive', onPress: doForfeit },
                  ],
                );
              } else {
                Alert.alert('Error', msg || 'Try again.');
              }
            } finally {
              setCancelling(false);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>

      {/* Match header */}
      <View style={styles.header}>
        <View style={[styles.typeBadge, isPractice && { borderColor: C.textMuted }]}>
          <Text style={[styles.typeText, isPractice && { color: C.textMuted }]}>{typeLabel}</Text>
        </View>
        <Text style={styles.matchTitle}>{match.name ? c(match.name) : `${typeLabel} Match`}</Text>
        <Text style={styles.matchId}>ID: {id.slice(0, 8).toUpperCase()}</Text>
      </View>

      {/* Result (if completed) */}
      {isCompleted && match.result && (() => {
        const tied = match.result.winner_side == null;
        // Spectator path: when the viewer wasn't a participant in this match
        // (opened it from someone else's feed post), we can't frame the card
        // as VICTORY/DEFEAT — that's a personal lens. Show a neutral FINAL
        // header instead, with the actual winning side named for context.
        // Same data, no implied perspective.
        const isSpectator = !myPlayer;
        const won = !tied && !isSpectator && match.result.winner_side === myPlayer?.side;

        const myDelta = match.my_delta_elo ?? (won ? match.result.delta_elo : -(match.result.delta_elo ?? 0));
        const color = isSpectator
          ? C.gold
          : tied ? C.gold : (won ? C.green : C.red);
        const label = isSpectator
          ? 'FINAL'
          : tied ? 'DRAW' : (won ? 'VICTORY' : 'DEFEAT');
        const myPerk: any = (match as any).my_perk;
        // Format-specific summary line (e.g. "12 to 9 in Stableford points",
        // "Won 5 holes to 3", "8 skins to 4"). Falls back to the standard
        // strokes-differential row for stroke / scramble matches.
        const details: any = match.result.details ?? {};
        const fmt: string = details.format ?? match.format ?? 'stroke';
        const fd: any = details.formatDetails ?? null;
        // Spectators have no "my side" to anchor the format summary against —
        // we always frame them from side 1's perspective with a "Side 1 vs
        // Side 2" line instead of "your X vs their Y". For participants this
        // stays "your X to their Y" as before.
        const mySide = myPlayer?.side ?? 1;
        const myKey  = mySide === 1 ? 's1' : 's2';
        const oppKey = mySide === 1 ? 's2' : 's1';
        let formatLine: string | null = null;
        if (fd) {
          if (isSpectator) {
            if (fmt === 'stableford') {
              formatLine = `Side 1: ${fd.s1Points} pts · Side 2: ${fd.s2Points} pts (Modified Stableford)`;
            } else if (fmt === 'match_play') {
              formatLine = `Side 1 won ${fd.s1Holes} holes · Side 2 won ${fd.s2Holes}`
                + (fd.halved ? ` · ${fd.halved} halved` : '');
            } else if (fmt === 'skins') {
              formatLine = `Side 1: ${fd.s1Skins} skins · Side 2: ${fd.s2Skins}`;
            }
          } else if (fmt === 'stableford') {
            formatLine = `${fd[`${myKey}Points`]} pts to ${fd[`${oppKey}Points`]} (Modified Stableford)`;
          } else if (fmt === 'match_play') {
            formatLine = `Won ${fd[`${myKey}Holes`]} holes to ${fd[`${oppKey}Holes`]}`
              + (fd.halved ? ` · ${fd.halved} halved` : '');
          } else if (fmt === 'skins') {
            formatLine = `${fd[`${myKey}Skins`]} skins to ${fd[`${oppKey}Skins`]}`;
          }
        }
        // Spectators see "Side N wins" subline since they have no personal
        // delta to display. Participants keep the ±SR line as before.
        const spectatorSubline = isSpectator && !tied
          ? `Side ${match.result.winner_side} wins`
          : null;
        return (
          <View style={[styles.resultCard, { borderColor: color }]}>
            <Text style={[styles.resultText, { color }]}>{label}</Text>
            {spectatorSubline && (
              <Text style={styles.formatSummary}>{spectatorSubline}</Text>
            )}
            {formatLine && (
              <Text style={styles.formatSummary}>{formatLine}</Text>
            )}
            {/* SR line is meaningless to a spectator (it's not their swing)
                so we hide it. Practice matches never had it. */}
            {!isPractice && !isSpectator && (
              <Text style={styles.eloChange}>
                {myDelta > 0 ? '+' : ''}{myDelta} SR
              </Text>
            )}
            {myPerk && !isSpectator && (
              <Text style={styles.perkAppliedLine}>
                Lucky Round perk applied — {myPerk.original < 0
                  ? `loss of ${Math.abs(myPerk.original)} SR prevented`
                  : myPerk.original > 0
                    ? `${myPerk.original} SR doubled to ${myPerk.adjusted}`
                    : 'perk consumed'}
              </Text>
            )}
            {/* Stroke-differential row. Participants see "your vs opponent";
                spectators see "side 1 vs side 2". */}
            {(fmt === 'stroke' || fmt === 'scramble') && (
              <View style={styles.diffRow}>
                {isSpectator ? (
                  <>
                    <Text style={styles.diffLabel}>Side 1: {match.result.side1_score_differential?.toFixed(1)}</Text>
                    <Text style={styles.diffLabel}>Side 2: {match.result.side2_score_differential?.toFixed(1)}</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.diffLabel}>Your differential: {(myPlayer?.side === 1 ? match.result.side1_score_differential : match.result.side2_score_differential)?.toFixed(1)}</Text>
                    <Text style={styles.diffLabel}>Opponent: {(myPlayer?.side === 1 ? match.result.side2_score_differential : match.result.side1_score_differential)?.toFixed(1)}</Text>
                  </>
                )}
              </View>
            )}
            {/* Share button only makes sense for participants — a spectator
                isn't sharing "their" round. */}
            {!isSpectator && (
              <TouchableOpacity style={styles.shareRoundBtn} onPress={shareRoundSummary} activeOpacity={0.85}>
                <Text style={styles.shareRoundBtnText}>Share Round →</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {/* Live leaderboard — ranked standings that update on their own while the
          round is in play. Shows once both sides opt into live scores, or when
          the match is final. Tapping a row jumps to that player. */}
      {(liveActive || isCompleted) && (match.players?.length ?? 0) >= 2 && (
        <>
          <OrnamentTitle title="Leaderboard" />
          <LiveLeaderboard
            matchId={id}
            completed={isCompleted}
            onPressPlayer={(uid) => router.push(`/user/${uid}` as any)}
          />
        </>
      )}

      {/* Players */}
      <OrnamentTitle title="Players" />

      {match.players?.map((p) => (
        <PlayerCard
          key={p.user_id}
          player={p}
          isMe={p.user_id === user?.user_id}
          matchCompleted={isCompleted}
          onPress={() => router.push(`/user/${p.user_id}` as any)}
        />
      ))}

      {/* Duo: waiting for teammate/opponent to join via ID */}
      {!isCompleted && match.match_type === 'duo' && (match.players?.length ?? 0) < 2 && !myPlayer?.completed && (
        <View style={styles.waitingCard}>
          <Text style={styles.waitingText}>Invite your duo partner</Text>
          <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
            <Text style={styles.shareBtnText}>Share Match ID</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* You've posted your round and the match isn't resolved yet. Two cases:
          you already HAVE an opponent who just hasn't finished (name who we're
          waiting on), or you're still in the matchmaking queue (no opponent row
          yet). Without this split it wrongly said "Finding your opponent" even
          when the opponent was sitting right there mid-round. Arena has its own
          waiting copy below. */}
      {!isCompleted && myPlayer?.completed && match.match_type !== 'practice' && !isArena && (() => {
        const oppSide = (match.players ?? []).filter((p) => p.side !== myPlayer?.side);
        const hasOpp = oppSide.length > 0;
        const pending = oppSide.some((p) => !p.completed);
        const who = oppSide.length === 1 ? c(oppSide[0].username) : 'the other side';
        return (
          <View style={styles.waitingCard}>
            <ActivityIndicator color={C.gold} size="small" style={{ marginBottom: 8 }} />
            <Text style={styles.waitingText}>
              {!hasOpp ? 'Finding your opponent…' : pending ? `Waiting for ${who} to finish` : 'Finalizing result…'}
            </Text>
            <Text style={styles.waitingSubText}>
              {!hasOpp
                ? "You'll be matched to the closest SR player in the queue."
                : pending
                ? 'Your round is locked in. The match resolves the moment they post their score.'
                : 'Tallying it up — this only takes a moment.'}
            </Text>
          </View>
        );
      })()}

      {/* Arena: round submitted, now waiting on the other invited players. */}
      {!isCompleted && myPlayer?.completed && isArena && (
        <View style={styles.waitingCard}>
          <ActivityIndicator color={C.gold} size="small" style={{ marginBottom: 8 }} />
          <Text style={styles.waitingText}>Waiting on the rest of the Arena</Text>
          <Text style={styles.waitingSubText}>
            SR settles once every invited player finishes their round. Invite more players any time before then.
          </Text>
        </View>
      )}

      {/* Start scoring (or continue if there's saved progress) */}
      {!isCompleted && myPlayer && !myPlayer.completed && (
        <>
          <TouchableOpacity style={styles.startBtn} onPress={handleStartScoring}>
            <Text style={styles.startBtnText}>
              {hasSavedProgress ? 'Continue Match' : 'Start Scoring'}
            </Text>
          </TouchableOpacity>
          {(isArena || isPractice) && (
            <Text style={styles.startHint}>
              {isArena
                ? 'You can start whenever. Others join and play their own round; SR settles once everyone finishes.'
                : 'Invite friends below to play this round together.'}
            </Text>
          )}
        </>
      )}

      {/* Invite players — PRIMARY for Arena/duo/squad/practice (matches that
          need other people), SECONDARY (a challenge) for solo. The modal's
          username search means you can invite anyone, not just existing
          friends — the old #1 reason an invite couldn't be sent. */}
      {!isCompleted && canInviteMore && matchTypeRaw !== 'solo' && (
        <TouchableOpacity
          style={[styles.invitePrimary, arenaNeedsPlayers && styles.invitePrimaryUrgent]}
          onPress={() => setInviteVisible(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.invitePrimaryTitle}>
            {isArena
              ? (arenaNeedsPlayers ? '＋ Invite players to start' : '＋ Invite more players')
              : '＋ Invite friends'}
          </Text>
          <Text style={styles.invitePrimarySub}>
            {isArena
              ? `Arena is a free-for-all (${playerCount}/${cap} in). Search any player or tap a friend. They get a notification and can also Join from the Chats tab.`
              : 'Search any player or tap a friend. They get a notification and can also Join from the Chats tab.'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Solo: optional direct challenge instead of waiting on random matchmaking. */}
      {!isCompleted && matchTypeRaw === 'solo' && canInviteMore && !myPlayer?.completed && (
        <TouchableOpacity style={styles.inviteBtn} onPress={() => setInviteVisible(true)}>
          <Text style={styles.inviteBtnText}>Challenge a specific friend instead</Text>
        </TouchableOpacity>
      )}

      {/* Live scoreboard — both sides must agree, then everyone sees scores
          live. Only shown on an in-progress match that has an opponent. */}
      {!isCompleted && myPlayer && allReady && (
        <TouchableOpacity
          style={[styles.liveBtn, liveActive && styles.liveBtnActive]}
          onPress={toggleLiveScores}
          disabled={liveBusy}
          activeOpacity={0.8}
        >
          <Text style={[styles.liveBtnTitle, liveActive && { color: C.green }]}>
            {liveActive ? '● Live scoreboard ON' : 'Live scoreboard'}
          </Text>
          <Text style={styles.liveBtnSub}>
            {liveActive
              ? 'Both sides agreed. Everyone sees scores live.'
              : myLiveOptin
              ? 'You agreed. Waiting for the other side to turn it on.'
              : 'Tap to share scores live. Activates when both sides agree.'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Auto-rendered scorecards — appear as soon as any player submits scores,
          so per-round strokes-gained shows up without waiting on opponents.
          ANTI-SCOUT: until the match is completed, only the player and their
          same-side teammates can see scorecards. Opponents (even friends) are
          hidden so nobody can pace themselves to a known target. The backend
          additionally redacts hole_scores/hole_stats on those rows. */}
      {(() => {
        const matchCompleted = !!match.completed;
        const me = match.players?.find((p) => p.user_id === user?.user_id);
        const mySide = me?.side ?? null;
        const visiblePlayers = (match.players ?? []).filter((p) => {
          if (!p.hole_scores?.length) return false;
          // Both sides opted into the live scoreboard → everything visible.
          if (matchCompleted || liveActive) return true;
          if (p.user_id === user?.user_id) return true;
          // Same-side teammates (duo/squad) — fine to see during play.
          // Different side (solo opponent, Arena rival) — hidden until done.
          return mySide != null && p.side === mySide;
        });
        if (!visiblePlayers.length && !(match.guest_players ?? []).some((g) => g.scores?.length)) {
          return null;
        }
        return (
        <>
          <Divider style={{ marginTop: 24 }} />
          <OrnamentTitle title="Scorecards" align="center" />
          {!matchCompleted && !liveActive && visiblePlayers.length < (match.players?.filter((p) => p.hole_scores?.length).length ?? 0) && (
            <Text style={styles.scoutHint}>
              Opponent scorecards unlock when the match is final, or when both sides turn on the live scoreboard.
            </Text>
          )}
          {visiblePlayers.map((p) => {
            const entry: ScorecardEntry = {
              username: p.username,
              user_id: p.user_id,
              // Threading the player's handicap so the in-card SG widget
              // uses the same skill baseline as the profile stats page.
              handicap_index: (p as any).handicap_index ?? null,
              teebox_name: p.teebox_name,
              hole_scores: p.hole_scores,
              hole_stats: (p as any).hole_stats,
              course_id: p.course_id,
              course_name: p.course_name ?? null,
              teebox_id: p.teebox_id,
              match_id: id,
              round_id: p.round_id,
            };
            return (
              <ScorecardCard
                key={p.user_id}
                entry={entry}
                highlight={p.user_id === user?.user_id}
                onPress={() => setScorecardEntry(entry)}
              />
            );
          })}
          {/* Guest scorecards — non-account players whose strokes the host
              entered. Same look as real scorecards but no profile link. */}
          {(match.guest_players ?? []).filter((g) => g.scores?.length).map((g, i) => {
            const teebox = match.players?.find((p) => p.teebox_id === g.teebox_id) ?? match.players?.[0];
            const entry: ScorecardEntry = {
              username: c(g.name) + ' (guest)',
              teebox_name: teebox?.teebox_name ?? null,
              hole_scores: g.scores,
              course_id: teebox?.course_id ?? null,
              course_name: teebox?.course_name ?? null,
              teebox_id: g.teebox_id ?? teebox?.teebox_id ?? null,
            };
            return (
              <ScorecardCard
                key={`guest-${i}`}
                entry={entry}
                onPress={() => setScorecardEntry(entry)}
              />
            );
          })}
        </>
        );
      })()}

      {/* Add / edit guest scorecards — open a modal where the host enters
          strokes for non-account players (e.g. four buddies, one phone). */}
      {myPlayer?.completed && (
        <TouchableOpacity
          style={styles.guestBtn}
          onPress={openGuestModal}
          activeOpacity={0.7}
        >
          <Text style={styles.guestBtnText}>
            {(match.guest_players?.length ?? 0) > 0
              ? `Edit guest scorecards (${match.guest_players?.length})`
              : '+ Add guest scorecards'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Match Chat */}
      <TouchableOpacity
        style={styles.chatBtn}
        onPress={() => router.push(`/chat/match/${id}` as any)}
      >
        <Text style={styles.chatBtnText}>Match Chat</Text>
      </TouchableOpacity>

      {/* Cancel OR Forfeit. We surface whichever exit is actually available:
            • Nobody has submitted yet     → Cancel Match (no penalty, deletes the match)
            • Someone else has submitted   → Forfeit Match (counts as a loss, full SR penalty)
            • I have already submitted     → button hidden, my round is locked in
            • Match is completed           → button hidden
          Without this split the button used to disappear the moment an
          opponent submitted, leaving the player with no way to exit the
          match short of running out the 24h auto-cancel cron. */}
      {!isCompleted && !myPlayer?.completed && (() => {
        const othersCompleted = !!match.players?.some(
          (p) => p.user_id !== user?.user_id && p.completed,
        );
        return (
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={othersCompleted ? handleForfeitMatch : handleCancelMatch}
            disabled={cancelling}
          >
            {cancelling
              ? <ActivityIndicator color={C.red} size="small" />
              : <Text style={styles.cancelBtnText}>{othersCompleted ? 'Forfeit Match' : 'Cancel Match'}</Text>}
          </TouchableOpacity>
        );
      })()}

      {/* Guest scorecards modal — host enters strokes for non-account players */}
      <Modal
        visible={guestModalOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setGuestModalOpen(false)}
      >
        <ScrollView
          style={{ flex: 1, backgroundColor: C.bg }}
          contentContainerStyle={{ padding: 20, paddingTop: 28, paddingBottom: 60 }}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: '900' }}>Guest Scorecards</Text>
            <TouchableOpacity onPress={() => setGuestModalOpen(false)}>
              <Text style={{ color: C.textMuted, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ color: C.textMuted, fontSize: 12, marginBottom: 16 }}>
            For people without a Sacari account who played with you. Their scores show on the scorecard but don't affect SR.
          </Text>

          {guestDraft.map((g, gi) => (
            <View key={gi} style={styles.guestCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TextInput
                  style={styles.guestNameInput}
                  value={g.name}
                  onChangeText={(t) => setGuestDraft((prev) => prev.map((p, i) => i === gi ? { ...p, name: t } : p))}
                  placeholder={`Guest ${gi + 1} name`}
                  placeholderTextColor={C.textMuted}
                  maxLength={30}
                />
                <TouchableOpacity
                  onPress={() => setGuestDraft((prev) => prev.filter((_, i) => i !== gi))}
                  style={styles.guestRemoveBtn}
                >
                  <Text style={styles.guestRemoveBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.guestScoreGrid}>
                {g.scores.map((s, hi) => (
                  <View key={hi} style={styles.guestScoreCell}>
                    <Text style={styles.guestHoleNum}>{hi + 1}</Text>
                    <TextInput
                      style={styles.guestHoleInput}
                      value={s}
                      onChangeText={(t) => setGuestDraft((prev) => prev.map((p, i) =>
                        i === gi ? { ...p, scores: p.scores.map((sc, j) => j === hi ? t : sc) } : p
                      ))}
                      keyboardType="number-pad"
                      maxLength={2}
                    />
                  </View>
                ))}
              </View>
            </View>
          ))}

          {guestDraft.length < 7 && (
            <TouchableOpacity
              style={styles.guestAddBtn}
              onPress={() => {
                const N = match.num_holes ?? 18;
                setGuestDraft((prev) => [...prev, { name: '', scores: Array.from({ length: N }, () => '') }]);
              }}
            >
              <Text style={styles.guestAddBtnText}>+ Add another guest</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.guestSaveBtn, savingGuests && { opacity: 0.6 }]}
            onPress={saveGuests}
            disabled={savingGuests}
          >
            {savingGuests
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.guestSaveBtnText}>Save Guest Scorecards</Text>}
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* Invite players — shared modal with a friends list AND a username
          search so the host can pull in anyone, not just existing friends. */}
      <InviteFriendsModal
        visible={inviteVisible}
        matchId={id}
        onClose={() => setInviteVisible(false)}
        excludeUserIds={match.players?.map((p) => p.user_id) ?? []}
        title={isArena ? 'Invite to Arena' : matchTypeRaw === 'solo' ? 'Challenge a Friend' : 'Invite Players'}
      />

      {/* Per-player scorecard modal — also lists tracked shot maps for this match */}
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

      {/* Share-loop prompt — celebratory nudge to share the recap right at the
          win / rank-up moment. One tap shares; the recap link renders a rich
          card in iMessage / socials and carries a "play on Sacari" hook. */}
      <Modal
        visible={!!sharePrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setSharePrompt(null)}
      >
        <View style={styles.sharePromptBackdrop}>
          <View style={styles.sharePromptCard}>
            <Text style={styles.sharePromptEmoji}>{sharePrompt?.rankUp ? '🎖️' : '🏆'}</Text>
            <Text style={styles.sharePromptTitle}>
              {sharePrompt?.rankUp ? `Promoted to ${sharePrompt.rankLabel}!` : 'Victory!'}
            </Text>
            <Text style={styles.sharePromptSub}>
              {sharePrompt?.rankUp
                ? `${(sharePrompt?.delta ?? 0) > 0 ? `+${sharePrompt?.delta} SR. ` : ''}New rank unlocked — show it off.`
                : `${(sharePrompt?.delta ?? 0) > 0 ? `+${sharePrompt?.delta} SR. ` : ''}Brag a little and call out your next challenger.`}
            </Text>
            <TouchableOpacity
              style={styles.sharePromptShareBtn}
              onPress={() => { setSharePrompt(null); shareRoundSummary(); }}
              activeOpacity={0.85}
            >
              <Text style={styles.sharePromptShareText}>Share it</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSharePrompt(null)} style={styles.sharePromptLater} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.sharePromptLaterText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
    </View>
  );
}

function PlayerCard({ player, isMe, matchCompleted, onPress }: {
  player: MatchPlayer; isMe: boolean; matchCompleted: boolean; onPress: () => void;
}) {
  // Anti-cheat: only show stroke totals for me OR when the match is fully completed
  const canSeeStrokes = isMe || matchCompleted;
  const c = useCensor();

  return (
    <TouchableOpacity
      style={[styles.playerCard, isMe && { borderColor: C.gold }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <IdentityAvatar
        visual={(player as any).equipped_visual}
        username={player.username}
        avatarUrl={(player as any).avatar_url}
        size={40}
      />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IdentityName visual={(player as any).equipped_visual} style={styles.playerName}>
            {c(player.username)}
          </IdentityName>
          {isMe && <Text style={{ color: C.gold, fontWeight: '700' }}>(You)</Text>}
        </View>
        <Text style={styles.playerElo}>{player.elo} SR · Side {player.side}</Text>
        {player.teebox_name ? (
          <Text style={styles.playerTeebox} numberOfLines={1}>
            {player.course_name ? `${player.course_name} · ` : ''}
            {player.teebox_name} tees
            {player.num_holes ? ` · ${player.num_holes}h` : ''}
          </Text>
        ) : (
          <Text style={[styles.playerTeebox, { color: C.textDim }]}>Picking course…</Text>
        )}
      </View>
      <View style={styles.playerStatus}>
        {player.completed ? (
          <>
            <Text style={[styles.statusDot, { color: C.green }]}>●</Text>
            <Text style={styles.playerStrokes}>
              {canSeeStrokes ? `${player.strokes} strokes` : 'Done'}
            </Text>
          </>
        ) : (
          <Text style={[styles.statusDot, { color: C.textDim }]}>○</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  backBtn: { marginBottom: 12 },
  backBtnText: { color: C.gold, fontSize: 16 },

  header: { marginBottom: 24 },
  typeBadge: { alignSelf: 'flex-start', borderRadius: 8, borderWidth: 1.5, borderColor: C.gold, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 },
  typeText: { color: C.gold, fontWeight: '700', fontSize: 12, letterSpacing: 1 },
  matchTitle: { color: C.text, fontSize: 26, fontWeight: '900' },
  matchId: { color: C.textMuted, fontSize: 12, marginTop: 4 },

  resultCard: {
    borderRadius: 16, borderWidth: 2, padding: 20, marginBottom: 20, alignItems: 'center',
    backgroundColor: C.card,
  },
  resultText: { fontFamily: F.serif, fontSize: 26, fontWeight: '700', letterSpacing: 3 },
  eloChange: { fontSize: 20, fontWeight: '800', color: C.gold, marginTop: 4 },
  perkAppliedLine: {
    color: C.gold, fontSize: 11, marginTop: 6, textAlign: 'center',
    fontWeight: '700', letterSpacing: 0.3,
  },
  formatSummary: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 4, textAlign: 'center' },
  shareRoundBtn: {
    marginTop: 14, paddingHorizontal: 18, paddingVertical: 9,
    backgroundColor: C.gold, borderRadius: 6,
  },
  shareRoundBtnText: { color: '#000', fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },

  // Group-scoring affordances
  guestBtn: {
    marginTop: 12, paddingVertical: 12, alignItems: 'center',
    borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  guestBtnText: { color: C.text, fontWeight: '700', fontSize: 13 },
  guestCard: {
    backgroundColor: C.card, borderRadius: 8, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: C.border,
  },
  guestNameInput: {
    flex: 1, backgroundColor: C.bg, color: C.text, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  guestRemoveBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: C.red + '88' },
  guestRemoveBtnText: { color: C.red, fontSize: 11, fontWeight: '700' },
  guestScoreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  guestScoreCell: { width: 44, alignItems: 'center' },
  guestHoleNum: { color: C.textMuted, fontSize: 9, fontWeight: '800', marginBottom: 2 },
  guestHoleInput: {
    width: 40, backgroundColor: C.bg, color: C.text, borderRadius: 4,
    paddingVertical: 6, textAlign: 'center', fontWeight: '800',
    borderWidth: 1, borderColor: C.border,
  },
  guestAddBtn: { marginTop: 8, paddingVertical: 12, alignItems: 'center', borderRadius: 6, borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '11' },
  guestAddBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },
  guestSaveBtn: { marginTop: 18, backgroundColor: C.gold, paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  guestSaveBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
  diffRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  diffLabel: { color: C.textMuted, fontSize: 12 },

  sectionTitle: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 },

  playerCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  playerAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold + '22', justifyContent: 'center', alignItems: 'center' },
  playerAvatarText: { color: C.gold, fontWeight: '900', fontSize: 18 },
  playerName: { color: C.text, fontWeight: '700', fontSize: 15 },
  playerElo: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  playerTeebox: { color: C.gold, fontSize: 11, marginTop: 2 },
  playerStatus: { alignItems: 'center' },
  statusDot: { fontSize: 16 },
  playerStrokes: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  waitingCard: { backgroundColor: C.card, borderRadius: 14, padding: 18, alignItems: 'center', marginVertical: 12, borderWidth: 1, borderColor: C.border },
  waitingText: { color: C.text, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  waitingSubText: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6 },
  shareBtn: { marginTop: 12, backgroundColor: C.gold + '22', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: C.gold },
  shareBtnText: { color: C.gold, fontWeight: '700' },

  startBtn: { backgroundColor: C.gold, borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 16 },
  startBtnText: { color: '#000', fontWeight: '900', fontSize: 17 },
  startHint: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 8, lineHeight: 17, paddingHorizontal: 8 },

  // Prominent invite CTA — the primary action for matches that need other
  // people (Arena/duo/squad/practice). Urgent variant when an Arena has nobody
  // else yet, so "invite first" reads louder than "start scoring".
  invitePrimary: {
    marginTop: 16, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '18',
  },
  invitePrimaryUrgent: { borderWidth: 2, backgroundColor: C.gold + '24' },
  invitePrimaryTitle: { color: C.gold, fontWeight: '900', fontSize: 16, letterSpacing: 0.3 },
  invitePrimarySub: { color: C.textMuted, fontSize: 12, marginTop: 5, lineHeight: 17 },

  sharePromptBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 28,
  },
  sharePromptCard: {
    width: '100%', maxWidth: 340, backgroundColor: C.card, borderRadius: 20,
    padding: 24, alignItems: 'center', borderWidth: 1, borderColor: C.gold + '55',
  },
  sharePromptEmoji: { fontSize: 44, marginBottom: 6 },
  sharePromptTitle: { color: C.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  sharePromptSub: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  sharePromptShareBtn: {
    marginTop: 18, alignSelf: 'stretch', backgroundColor: C.gold,
    borderRadius: 14, paddingVertical: 15, alignItems: 'center',
  },
  sharePromptShareText: { color: '#000', fontWeight: '900', fontSize: 16 },
  sharePromptLater: { marginTop: 12, paddingVertical: 4 },
  sharePromptLaterText: { color: C.textMuted, fontSize: 13, fontWeight: '600' },

  chatBtn: {
    marginTop: 12, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  chatBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },

  cancelBtn: {
    marginTop: 24, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.red + '66',
  },
  cancelBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },

  inviteBtn: {
    marginTop: 12, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '22',
  },
  inviteBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },

  liveBtn: {
    marginTop: 12, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  liveBtnActive: { borderColor: C.green, backgroundColor: C.green + '14' },
  liveBtnTitle: { color: C.text, fontWeight: '800', fontSize: 14 },
  liveBtnSub: { color: C.textMuted, fontSize: 11, marginTop: 3, lineHeight: 15 },

  scoutHint: {
    color: C.textMuted, fontSize: 11, textAlign: 'center', fontStyle: 'italic',
    marginTop: 6, marginBottom: 4, paddingHorizontal: 20,
  },

});
