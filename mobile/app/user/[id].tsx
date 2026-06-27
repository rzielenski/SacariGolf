import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api, API_BASE } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { OrnamentTitle } from '../../components/Flourish';
import { LiveSpectatorModal } from '../../components/LiveSpectator';
import { RankCrest, crestFootprint } from '../../components/RankCrest';
import { AvatarViewer } from '../../components/AvatarViewer';
import { CosmeticBackground, CosmeticBorder, CosmeticUsername } from '../../components/Cosmetics';
import { fmtHandicap, parForHolesPlayed, toParForHolesPlayed, fmtToPar } from '../../lib/golfMath';
import { useCensor } from '../../lib/censor';
import { rankForElo, rankHeadline } from '../../lib/rank';

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const c = useCensor();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [handicap, setHandicap] = useState<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number } | null>(null);
  const [activeRound, setActiveRound] = useState<any | null>(null);
  const [courseRecords, setCourseRecords] = useState<any[]>([]);
  const [spectating, setSpectating] = useState(false);
  const [viewingAvatar, setViewingAvatar] = useState(false);
  const [stats, setStats] = useState<any | null>(null);
  const [insights, setInsights] = useState<any | null>(null);

  const openScorecard = (round: any) => {
    setScorecardEntry({
      username: profile?.username,
      user_id: profile?.user_id,
      teebox_name: round.teebox_name,
      hole_scores: round.hole_scores,
      // hole_stats and holes_subset come through from the active-round endpoint
      // too — they let the modal render putts/chips/GIR alongside the running
      // hole-by-hole grid even for in-progress rounds.
      hole_stats: round.hole_stats,
      holes_subset: round.holes_subset,
      handicap_index: profile?.handicap_index ?? null,
      course_id: round.course_id,
      course_name: round.course_name,
      teebox_id: round.teebox_id,
      total_score: round.total_score,
      created_at: round.created_at,
      teebox_par: round.teebox_par,
      match_id: round.match_id,
      round_id: round.round_id,
    });
  };

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setProfile(await api.users.get(id));
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.users.handicap(id).then(setHandicap).catch(() => { });
  }, [id]);

  useEffect(() => {
    api.users.courseRecords(id).then(setCourseRecords).catch(() => { });
  }, [id]);

  useEffect(() => {
    api.users.stats(id).then(setStats).catch(() => { });
    api.users.insights(id).then(setInsights).catch(() => { });
  }, [id]);

  // Poll the player's live in-progress round every 15s while the screen is open
  useEffect(() => {
    let cancelled = false;
    const fetchActive = () => api.users.activeRound(id)
      .then((data) => { if (!cancelled) setActiveRound(data); })
      .catch(() => { });
    fetchActive();
    const t = setInterval(fetchActive, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [id]);

  if (loading) return <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>;
  if (!profile) {
    return (
      <View style={styles.centered}>
        <TouchableOpacity onPress={() => router.back()} style={{ position: 'absolute', top: 60, left: 20 }}>
          <Text style={{ color: C.gold }}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ color: C.textMuted }}>User not found</Text>
      </View>
    );
  }

  const rank = rankForElo(profile.elo);
  const winRate = profile.total_matches > 0 ? Math.round((profile.total_wins / profile.total_matches) * 100) : 0;
  const joined = new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // This user's equipped cosmetics — full animated treatment here. The
  // public profile is the surface a cosmetic owner most wants seen, and
  // it renders exactly one identity, so the animation budget is fine.
  const equipped = profile.equipped_visual ?? {};
  const bgVisual = equipped.background ?? null;
  const borderVisual = equipped.border ?? null;
  const usernameVisual = equipped.username ?? null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
    {bgVisual ? (
      <CosmeticBackground visual={bgVisual} style={StyleSheet.absoluteFillObject} />
    ) : null}
    <ScrollView
      style={[styles.container, bgVisual && { backgroundColor: 'transparent' }]}
      contentContainerStyle={{ padding: 20, paddingTop: 60, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.headerSection}>
        <CosmeticBorder visual={borderVisual} size={crestFootprint(profile.elo, 96)}>
          <RankCrest elo={profile.elo} size={96} style={borderVisual ? undefined : { marginBottom: 8 }}>
            {profile.avatar_url ? (
              // Tap to view the photo full-screen — same pattern as a Find.
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setViewingAvatar(true)}
                style={{ width: '100%', height: '100%' }}
              >
                <Image source={{ uri: `${API_BASE}${profile.avatar_url}` }} style={styles.avatarImage} />
              </TouchableOpacity>
            ) : (
              <View style={styles.avatarLetterBg}>
                <Text style={styles.avatarText}>{c(profile.username)[0]?.toUpperCase() ?? '?'}</Text>
              </View>
            )}
          </RankCrest>
        </CosmeticBorder>
        <CosmeticUsername visual={usernameVisual} style={styles.username}>
          {c(profile.username)}
        </CosmeticUsername>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rankHeadline(profile.elo)}</Text>
        </View>

        {/* Following / Followers strip — tappable, opens a list of each
            group with deep links into individual profiles. */}
        <View style={styles.followRow}>
          <TouchableOpacity
            style={styles.followCol}
            onPress={() => router.push(`/user/${profile.user_id}/following` as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.followNum}>{profile.following_count ?? 0}</Text>
            <Text style={styles.followLabel}>Following</Text>
          </TouchableOpacity>
          <View style={styles.followDivider} />
          <TouchableOpacity
            style={styles.followCol}
            onPress={() => router.push(`/user/${profile.user_id}/followers` as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.followNum}>{profile.followers_count ?? 0}</Text>
            <Text style={styles.followLabel}>Followers</Text>
          </TouchableOpacity>
        </View>

        {/* Friendship CTA — only on someone else's profile. Reflects the
            current relationship: stranger → "Add Friend", outgoing pending
            → "Request Sent" (disabled), incoming pending → "Accept Request",
            already friends → "Friends ✓" (disabled). Optimistically updates
            the profile so the button changes immediately after a tap. */}
        {user && user.user_id !== profile.user_id && (
          <View style={styles.actionRow}>
            <FriendshipButton
              status={profile.friendship_status}
              targetUserId={profile.user_id}
              targetUsername={profile.username}
              onChange={(next) => setProfile((p: any) => p ? { ...p, friendship_status: next } : p)}
            />
            {/* Message — jumps straight to (or resumes) the 1:1 chat with
                this player. Backwards-compat with the old conversations
                list: the chat screen creates the thread on first send if
                one doesn't exist yet, so this works for strangers too. */}
            <TouchableOpacity
              style={[styles.friendBtn, styles.friendBtnMessage]}
              onPress={() => router.push(
                `/chat/dm/${profile.user_id}?name=${encodeURIComponent(profile.username)}` as any,
              )}
              activeOpacity={0.7}
            >
              <Text style={[styles.friendBtnText, { color: C.bg }]}>Message</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Bio */}
      {profile.bio ? (
        <View style={styles.bioCard}>
          <Text style={styles.bioText}>"{c(profile.bio)}"</Text>
        </View>
      ) : null}

      {/* Home course */}
      {profile.home_course_id && (
        <TouchableOpacity
          style={styles.homeCourseCard}
          onPress={() => router.push(`/course/${profile.home_course_id}` as any)}
        >
          <Text style={styles.homeCourseLabel}>HOME COURSE</Text>
          <Text style={styles.homeCourseName}>{profile.home_course_name}</Text>
          {(profile.home_course_city || profile.home_course_state) && (
            <Text style={styles.homeCourseLoc}>
              {[profile.home_course_city, profile.home_course_state].filter(Boolean).join(', ')}
            </Text>
          )}
        </TouchableOpacity>
      )}

      {/* Stats */}
      <View style={styles.statsGrid}>
        <Stat label="Matches" value={profile.total_matches} />
        <Stat label="Wins" value={profile.total_wins} />
        <Stat label="Win Rate" value={`${winRate}%`} />
        <Stat
          label="Handicap"
          value={fmtHandicap(handicap?.handicap_index ?? null)}
        />
        <Stat label="Course Records" value={courseRecords.length} />
        {/* Lifetime range + putting reps from The Grind. Public, shown on every
            profile (even at 0) so it's a consistent dedication stat. */}
        <Stat label="Practice Shots" value={(profile.practice_shots ?? 0).toLocaleString()} />
        {/* Drinks — only present in the API response for yourself + accepted
            friends (server gates it to null otherwise), and only shown once
            they've logged at least one. Read-only here; the owner adjusts it
            from their own profile. A private/friends stat, not a public board. */}
        {typeof profile.drinks === 'number' && profile.drinks > 0 && (
          <Stat label="🍺 Drinks Drunk" value={profile.drinks} />
        )}
      </View>

      {/* Performance — only when this user has tracked any stats */}
      {stats && (stats.gir_eligible > 0 || stats.fw_eligible > 0) && (
        <>
          <OrnamentTitle title="Performance" />
          <View style={styles.perfGrid}>
            <Stat label="GIR" value={stats.gir_pct != null ? `${stats.gir_pct}%` : '—'} />
            <Stat label="Fairways" value={stats.fw_hit_pct != null ? `${stats.fw_hit_pct}%` : '—'} />
            <Stat label="Putts/Round" value={stats.avg_putts_per_round != null ? stats.avg_putts_per_round.toFixed(1) : '—'} />
            <Stat label="Up-and-Down" value={stats.up_and_down_pct != null ? `${stats.up_and_down_pct}%` : '—'} />
            <Stat label="3-putts" value={stats.three_putt_count ?? 0} />
            <Stat label="Avg/Hole" value={stats.avg_strokes_per_hole != null ? stats.avg_strokes_per_hole.toFixed(2) : '—'} />
          </View>

          {/* Strokes gained — from GPS-tracked shots only (Broadie model). */}
          {stats.sg_per_round && (
            <>
              <Text style={styles.sgSubtitle}>
                STROKES GAINED / 18  ·  {stats.sg_rounds_used} round{stats.sg_rounds_used === 1 ? '' : 's'} tracked
              </Text>
              {stats.sg_rounds_used < 5 && (
                <Text style={styles.sgWarn}>Small sample — more tracked rounds needed for a reliable read.</Text>
              )}
              <View style={styles.sgRow}>
                <SGCell label="Off-Tee" value={stats.sg_per_round.off_tee} />
                <SGCell label="Approach" value={stats.sg_per_round.approach} />
                <SGCell label="Around" value={stats.sg_per_round.around_green} />
                <SGCell label="Putt" value={stats.sg_per_round.putting} />
                <SGCell label="Total" value={stats.sg_per_round.total} highlight />
              </View>
            </>
          )}
        </>
      )}

      {/* Course records detail */}
      {courseRecords.length > 0 && (
        <>
          <OrnamentTitle title="Course Records" />
          {courseRecords.map((cr: any) => (
            <TouchableOpacity
              key={cr.course_id}
              style={[styles.roundCard, { borderColor: C.gold }]}
              onPress={() => router.push(`/course/${cr.course_id}` as any)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.roundCourseName}>{cr.course_name}</Text>
                <Text style={styles.roundMeta}>{cr.teebox_name} tees · {new Date(cr.created_at).toLocaleDateString()}</Text>
              </View>
              <View style={styles.roundScoreBox}>
                <Text style={[styles.roundScore, { color: C.gold }]}>{cr.total_score}</Text>
                <Text style={[styles.roundToPar, { color: C.gold }]}>RECORD</Text>
              </View>
            </TouchableOpacity>
          ))}
        </>
      )}

      {/* Live round (in-progress) */}
      {activeRound && (
        <>
          <View style={styles.liveBadgeRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveLabel}>PLAYING NOW</Text>
          </View>
          {/* Tap → opens the friend's live scorecard (per-hole breakdown
              using the same ScorecardModal as completed rounds). Long-press
              → drops into the satellite shot-map spectator view for watching
              shots arrive in real time. Anti-cheat: the backend already
              returns null for opposing-side viewers in the same match,
              so this card simply won't appear in that case. */}
          <TouchableOpacity
            style={[styles.roundCard, { borderColor: C.green }]}
            onPress={() => openScorecard({
              ...activeRound,
              // total_score isn't populated until submit — derive on the fly so
              // the modal header shows the running total.
              total_score: Array.isArray(activeRound.hole_scores)
                ? activeRound.hole_scores.reduce((a: number, b: number) => a + b, 0)
                : 0,
              created_at: activeRound.round_started_at,
            })}
            onLongPress={() => setSpectating(true)}
            delayLongPress={350}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.roundCourseName}>{activeRound.course_name ?? 'Unknown course'}</Text>
              <Text style={styles.roundMeta}>
                {activeRound.teebox_name ?? '—'}
                {activeRound.hole_scores?.length
                  ? ` · Hole ${activeRound.hole_scores.length} of ${activeRound.num_holes}`
                  : ' · Just started'}
              </Text>
              <Text style={styles.roundDate}>
                Tap for scorecard · Hold for shot map
              </Text>
            </View>
            <View style={styles.roundScoreBox}>
              {activeRound.hole_scores?.length ? (
                <>
                  <Text style={[styles.roundScore, { color: C.green }]}>
                    {activeRound.hole_scores.reduce((a: number, b: number) => a + b, 0)}
                  </Text>
                  <Text style={[styles.roundToPar, { color: C.textMuted }]}>thru {activeRound.hole_scores.length}</Text>
                </>
              ) : (
                <ActivityIndicator color={C.green} size="small" />
              )}
            </View>
          </TouchableOpacity>
        </>
      )}

      {/* Insights — narrative coaching observations from the player's
          history. Each tile is independent so the section degrades gracefully
          when the player is too new for one of them (e.g. trend needs ≥6
          rounds, hardest hole needs ≥2 plays of the same hole). */}
      {insights && insights.rounds_analyzed > 0 && (
        <>
          <OrnamentTitle title="Insights" />
          <View style={styles.insightsGrid}>
            {/* Per-par scoring averages */}
            {(['3', '4', '5'] as const).map((par) => {
              const v = insights.avg_score_per_par?.[par];
              if (v == null) return null;
              const diff = v - Number(par);
              return (
                <View key={par} style={styles.insightTile}>
                  <Text style={styles.insightLabel}>PAR {par}</Text>
                  <Text style={styles.insightVal}>{v.toFixed(2)}</Text>
                  <Text style={[styles.insightSub, { color: diff < 0 ? C.green : diff > 0 ? C.red : C.text }]}>
                    {diff > 0 ? `+${diff.toFixed(2)}` : diff === 0 ? 'E' : diff.toFixed(2)}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Trend strip */}
          {insights.recent_trend?.delta != null && (
            <View style={[styles.insightRow, { borderColor: insights.recent_trend.improving ? C.green : C.red }]}>
              <Text style={styles.insightRowLabel}>RECENT TREND</Text>
              <Text style={styles.insightRowText}>
                {insights.recent_trend.improving
                  ? `Improving — last 5 rounds avg ${insights.recent_trend.last5_avg_to_par > 0 ? '+' : ''}${insights.recent_trend.last5_avg_to_par} vs ${insights.recent_trend.prev5_avg_to_par > 0 ? '+' : ''}${insights.recent_trend.prev5_avg_to_par} prior 5 (${insights.recent_trend.delta > 0 ? '+' : ''}${insights.recent_trend.delta} strokes)`
                  : insights.recent_trend.delta === 0
                    ? 'Holding steady — last 5 vs previous 5 average is identical.'
                    : `Slumping — last 5 rounds avg ${insights.recent_trend.last5_avg_to_par > 0 ? '+' : ''}${insights.recent_trend.last5_avg_to_par} vs ${insights.recent_trend.prev5_avg_to_par > 0 ? '+' : ''}${insights.recent_trend.prev5_avg_to_par} prior 5 (${insights.recent_trend.delta > 0 ? '+' : ''}${insights.recent_trend.delta} strokes)`}
              </Text>
            </View>
          )}

          {/* Hardest hole */}
          {insights.hardest_hole && (
            <TouchableOpacity
              style={styles.insightRow}
              onPress={() => router.push(`/course/${insights.hardest_hole.course_id}` as any)}
              activeOpacity={0.7}
            >
              <Text style={styles.insightRowLabel}>HARDEST HOLE</Text>
              <Text style={styles.insightRowText}>
                {insights.hardest_hole.course_name} — Hole {insights.hardest_hole.hole_num} (Par {insights.hardest_hole.par}) — averages {insights.hardest_hole.avg_score} over {insights.hardest_hole.plays} plays
              </Text>
            </TouchableOpacity>
          )}

          {/* Easiest hole */}
          {insights.easiest_hole && insights.easiest_hole.hole_num !== insights.hardest_hole?.hole_num && (
            <TouchableOpacity
              style={styles.insightRow}
              onPress={() => router.push(`/course/${insights.easiest_hole.course_id}` as any)}
              activeOpacity={0.7}
            >
              <Text style={styles.insightRowLabel}>BEST HOLE</Text>
              <Text style={styles.insightRowText}>
                {insights.easiest_hole.course_name} — Hole {insights.easiest_hole.hole_num} (Par {insights.easiest_hole.par}) — averages {insights.easiest_hole.avg_score} over {insights.easiest_hole.plays} plays
              </Text>
            </TouchableOpacity>
          )}

          {/* Score distribution */}
          <View style={styles.insightRow}>
            <Text style={styles.insightRowLabel}>SCORE DISTRIBUTION</Text>
            <Text style={styles.insightRowText}>
              {insights.score_distribution.eagles} Eagle{insights.score_distribution.eagles === 1 ? '' : 's'} ·{' '}
              {insights.score_distribution.birdies} Birdie{insights.score_distribution.birdies === 1 ? '' : 's'} ·{' '}
              {insights.score_distribution.pars} Par{insights.score_distribution.pars === 1 ? '' : 's'} ·{' '}
              {insights.score_distribution.bogeys} Bogey{insights.score_distribution.bogeys === 1 ? '' : 's'} ·{' '}
              {insights.score_distribution.doubles_or_worse} Double+
            </Text>
          </View>
        </>
      )}

      {/* Best round. To-par + the displayed par get pro-rated to the holes
          the player actually completed — a 9-hole round of an 18-hole
          teebox compares against ~36, not 72 (see lib/golfMath.ts). */}
      {profile.best_round && (() => {
        const br = profile.best_round;
        const played = br.hole_scores?.length ?? br.num_holes ?? null;
        // `br.num_holes` is the teebox's num_holes from the SQL (t.num_holes),
        // not the match's. Passing it explicitly is required since the helper
        // no longer defaults to 18 — see lib/golfMath.ts for why.
        const effPar = parForHolesPlayed(br.teebox_par, played, br.num_holes);
        const toPar  = toParForHolesPlayed(br.total_score, br.teebox_par, played, br.num_holes);
        return (
          <>
            <OrnamentTitle title="Best Round" />
            <TouchableOpacity
              style={[styles.roundCard, { borderColor: C.gold }]}
              onPress={() => br.hole_scores?.length
                ? openScorecard(br)
                : br.course_id && router.push(`/course/${br.course_id}` as any)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.roundCourseName}>{br.course_name ?? 'Unknown course'}</Text>
                <Text style={styles.roundMeta}>
                  {br.teebox_name} · {played ?? br.num_holes} holes · Par {effPar ?? br.teebox_par}
                </Text>
                <Text style={styles.roundDate}>
                  {new Date(br.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </Text>
              </View>
              <View style={styles.roundScoreBox}>
                <Text style={[styles.roundScore, { color: C.gold }]}>{br.total_score}</Text>
                <Text style={[styles.roundToPar, { color: (toPar ?? 0) <= 0 ? C.green : C.red }]}>
                  {fmtToPar(toPar)}
                </Text>
              </View>
            </TouchableOpacity>
          </>
        );
      })()}

      {/* Recent rounds */}
      <OrnamentTitle title="Recent Rounds" />
      {profile.recent_rounds?.length === 0 ? (
        <Text style={styles.empty}>No rounds played yet.</Text>
      ) : (
        profile.recent_rounds?.map((r: any) => {
          // Pro-rate par to the holes actually played (front 9 of an 18-hole
          // teebox compares against ~36, not the full 72). `r.num_holes`
          // is the teebox's full num_holes (from t.num_holes in the SQL),
          // required so 9-hole teeboxes don't get judged against 18.
          const played = r.hole_scores?.length ?? r.num_holes ?? null;
          const toPar  = toParForHolesPlayed(r.total_score, r.teebox_par, played, r.num_holes);
          return (
            <TouchableOpacity
              key={r.round_id}
              style={styles.roundCard}
              onPress={() => r.hole_scores?.length
                ? openScorecard(r)
                : r.course_id && router.push(`/course/${r.course_id}` as any)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.roundCourseName}>{r.course_name ?? 'Unknown'}</Text>
                <Text style={styles.roundMeta}>
                  {r.teebox_name ?? '—'} · {played ?? '?'} holes
                  {r.format === 'scramble' ? ' · Scramble' : ''}
                </Text>
                <Text style={styles.roundDate}>
                  {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <View style={styles.roundScoreBox}>
                <Text style={styles.roundScore}>{r.total_score}</Text>
                {toPar != null && (
                  <Text style={[styles.roundToPar, {
                    color: toPar < 0 ? C.green : toPar > 0 ? C.red : C.text,
                  }]}>
                    {fmtToPar(toPar)}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })
      )}

      {/* Block button — required by App Store Guideline 1.2 for UGC apps.
          Hidden when viewing your own profile. Confirmation prompt before
          firing so an accidental tap doesn't silently nuke the relationship. */}
      {user && user.user_id !== profile.user_id && (
        <TouchableOpacity
          style={styles.blockBtn}
          onPress={() => {
            Alert.alert(
              `Block ${profile.username}?`,
              `You won't see them in search, on the leaderboard, or in finds. They won't be notified.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Block',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await api.users.block(profile.user_id);
                      Alert.alert('Blocked', `${profile.username} is blocked. You can unblock from Profile → Blocked Users.`);
                      router.back();
                    } catch (e: any) {
                      Alert.alert('Error', e.message);
                    }
                  },
                },
              ]
            );
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.blockBtnText}>Block this user</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.joined}>Joined {joined}</Text>

      <ScorecardModal
        visible={!!scorecardEntry}
        entry={scorecardEntry}
        onClose={() => setScorecardEntry(null)}
      />

      <LiveSpectatorModal
        visible={spectating}
        userId={profile?.user_id}
        username={profile?.username}
        onClose={() => setSpectating(false)}
      />

      <AvatarViewer
        uri={viewingAvatar && profile?.avatar_url ? `${API_BASE}${profile.avatar_url}` : null}
        username={c(profile.username)}
        onClose={() => setViewingAvatar(false)}
      />
    </ScrollView>
    </View>
  );
}

/**
 * Friendship CTA shown on someone else's profile. Translates the
 * `friendship_status` enum coming from /users/:id into one of four UI
 * states. Tapping fires the appropriate API call and optimistically
 * advances the local state so the button feedback is instant.
 *
 *   none              → "Add Friend"            (tap → sendRequest)
 *   request_sent      → "Request Sent" (muted, disabled)
 *   request_received  → "Accept Request"        (tap → acceptRequest)
 *   friends           → "Friends ✓" (muted, disabled)
 */
function FriendshipButton({
  status, targetUserId, targetUsername, onChange,
}: {
  status: 'self' | 'friends' | 'request_sent' | 'request_received' | 'none' | undefined;
  targetUserId: string;
  targetUsername: string;
  onChange: (next: 'self' | 'friends' | 'request_sent' | 'request_received' | 'none') => void;
}) {
  const [busy, setBusy] = useState(false);
  if (status === 'self' || status === undefined) return null;

  const send = async () => {
    setBusy(true);
    try {
      const res: any = await api.users.sendRequest(targetUserId);
      onChange('request_sent');
      if (!res?.alreadyRequested) {
        Alert.alert('Request sent!', `${targetUsername} will see your friend request.`);
      }
    } catch (e: any) {
      // Server returns 409 with `pendingFromThem: true` if the OTHER user
      // already sent us one — flip the state so the button switches to
      // "Accept Request" instead of staying on "Add Friend".
      const msg = String(e?.message ?? '');
      if (/already sent you/i.test(msg)) {
        onChange('request_received');
        Alert.alert('They sent you a request first', `Tap "Accept Request" to become friends with ${targetUsername}.`);
      } else if (/already friends/i.test(msg)) {
        onChange('friends');
        Alert.alert('Already friends', `You're already friends with ${targetUsername}.`);
      } else {
        Alert.alert('Could not send request', msg || 'Try again later.');
      }
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    try {
      await api.users.acceptRequest(targetUserId);
      onChange('friends');
      Alert.alert('Friends!', `You and ${targetUsername} are now friends.`);
    } catch (e: any) {
      Alert.alert('Could not accept', e?.message ?? 'Try again later.');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'friends') {
    return (
      <View style={[styles.friendBtn, styles.friendBtnDone]}>
        <Text style={[styles.friendBtnText, { color: C.green }]}>Friends ✓</Text>
      </View>
    );
  }
  if (status === 'request_sent') {
    return (
      <View style={[styles.friendBtn, styles.friendBtnDone]}>
        <Text style={[styles.friendBtnText, { color: C.textMuted }]}>Request Sent</Text>
      </View>
    );
  }
  if (status === 'request_received') {
    return (
      <TouchableOpacity
        style={[styles.friendBtn, styles.friendBtnAccept]}
        onPress={accept}
        disabled={busy}
        activeOpacity={0.7}
      >
        {busy
          ? <ActivityIndicator color={C.bg} size="small" />
          : <Text style={[styles.friendBtnText, { color: C.bg }]}>Accept Request</Text>}
      </TouchableOpacity>
    );
  }
  // none
  return (
    <TouchableOpacity
      style={[styles.friendBtn, styles.friendBtnAdd]}
      onPress={send}
      disabled={busy}
      activeOpacity={0.7}
    >
      {busy
        ? <ActivityIndicator color={C.bg} size="small" />
        : <Text style={[styles.friendBtnText, { color: C.bg }]}>+ Add Friend</Text>}
    </TouchableOpacity>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SGCell({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const sign = value > 0 ? '+' : '';
  const color = value > 0 ? C.green : value < 0 ? C.red : C.textMuted;
  return (
    <View style={[styles.sgCell, highlight && { borderColor: C.gold }]}>
      <Text style={styles.sgLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.sgValue, { color }]}>{sign}{value.toFixed(1)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  backBtn: { marginBottom: 8 },
  backBtnText: { color: C.gold, fontSize: 16 },

  headerSection: { alignItems: 'center', marginVertical: 12 },
  avatar: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 3, marginBottom: 12,
    overflow: 'hidden',
  },
  avatarImage: { width: 96, height: 96, borderRadius: 48 },
  avatarText: { fontSize: 40, color: C.gold, fontWeight: '900' },
  avatarLetterBg: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    alignItems: 'center', justifyContent: 'center',
  },
  username: { color: C.text, fontSize: 24, fontWeight: '900', marginBottom: 6 },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 5 },
  rankLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  followRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 12, marginBottom: 4, gap: 8,
  },
  followCol: { alignItems: 'center', paddingHorizontal: 18, paddingVertical: 6 },
  followNum: { color: C.text, fontSize: 18, fontWeight: '900', fontFamily: F.serif },
  followLabel: { color: C.textMuted, fontSize: 11, marginTop: 1, letterSpacing: 0.5 },
  followDivider: { width: 1, height: 30, backgroundColor: C.border },

  friendBtn: {
    marginTop: 14, paddingHorizontal: 22, paddingVertical: 10,
    borderRadius: 22, alignSelf: 'center', minWidth: 160, alignItems: 'center',
  },
  friendBtnAdd:    { backgroundColor: C.gold },
  friendBtnAccept: { backgroundColor: C.green },
  friendBtnDone:   { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
  friendBtnMessage:{ backgroundColor: C.blue ?? '#4a9eff' },
  friendBtnText:   { fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },
  // Two-up row: Friendship CTA + Message side by side. Centered as a
  // group so a single-button layout (when friendship is "self" and there's
  // only the message-equivalent) still looks balanced.
  actionRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 10, marginTop: 14, flexWrap: 'wrap',
  },

  bioCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 14,
    marginBottom: 14, borderWidth: 1, borderColor: C.border,
  },
  bioText: { color: C.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },

  homeCourseCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 14,
    marginBottom: 14, borderWidth: 1, borderColor: C.gold + '55',
  },
  homeCourseLabel: { color: C.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 4 },
  homeCourseName: { color: C.text, fontSize: 16, fontWeight: '700' },
  homeCourseLoc: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  perfGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  sgSubtitle: { color: C.textDim, fontSize: 10, letterSpacing: 1, fontWeight: '700', marginBottom: 6, marginTop: 2 },
  sgWarn: { color: C.gold, fontSize: 10, fontStyle: 'italic', marginTop: -2, marginBottom: 6 },
  sgRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  sgCell: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    backgroundColor: C.card, borderRadius: 6, borderWidth: 1, borderColor: C.border,
  },
  sgLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  sgValue: { fontSize: 18, fontWeight: '900', marginTop: 2, fontFamily: F.serif },
  statBox: {
    flex: 1, minWidth: '45%', backgroundColor: C.card, borderRadius: 10, padding: 14,
    alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  statValue: { color: C.text, fontSize: 22, fontWeight: '900' },
  statLabel: { color: C.textMuted, fontSize: 11, marginTop: 3 },

  sectionTitle: {
    color: C.textMuted, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.5, marginBottom: 8, marginTop: 14,
  },

  insightsGrid: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  insightTile: {
    flex: 1, backgroundColor: C.card, borderRadius: 8, padding: 12,
    alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  insightLabel: { color: C.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  insightVal: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif, marginTop: 4 },
  insightSub: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  insightRow: {
    backgroundColor: C.card, borderRadius: 8, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  insightRowLabel: { color: C.gold, fontSize: 9, fontWeight: '900', letterSpacing: 1.5, marginBottom: 4 },
  insightRowText: { color: C.text, fontSize: 13, lineHeight: 18 },

  roundCard: {
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  roundCourseName: { color: C.text, fontWeight: '700', fontSize: 14 },
  roundMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  roundDate: { color: C.textDim, fontSize: 11, marginTop: 4 },
  roundScoreBox: { alignItems: 'flex-end', minWidth: 50 },
  roundScore: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '700' },
  roundToPar: { fontSize: 12, fontWeight: '700', marginTop: 1 },

  empty: { color: C.textMuted, fontSize: 13, paddingVertical: 12 },
  joined: { color: C.textDim, textAlign: 'center', fontSize: 12, marginTop: 24 },
  blockBtn: {
    alignSelf: 'center', marginTop: 28, paddingVertical: 10, paddingHorizontal: 22,
    borderRadius: 8, borderWidth: 1, borderColor: C.red + '88',
  },
  blockBtnText: { color: C.red, fontSize: 13, fontWeight: '700' },

  liveBadgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 14, marginBottom: 6,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  liveLabel: { color: C.green, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
});
