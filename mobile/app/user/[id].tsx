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
import { RankCrest } from '../../components/RankCrest';

function EloRank(elo: number): { label: string; color: string } {
  if (elo >= 2000) return { label: 'Diamond', color: '#a8d8f0' };
  if (elo >= 1800) return { label: 'Platinum', color: '#c0c0d0' };
  if (elo >= 1600) return { label: 'Gold', color: C.gold };
  if (elo >= 1400) return { label: 'Silver', color: '#c0c0c0' };
  return { label: 'Bronze', color: '#cd7f32' };
}

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [handicap, setHandicap] = useState<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number } | null>(null);
  const [activeRound, setActiveRound] = useState<any | null>(null);
  const [courseRecords, setCourseRecords] = useState<any[]>([]);
  const [spectating, setSpectating] = useState(false);
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

  const rank = EloRank(profile.elo);
  const winRate = profile.total_matches > 0 ? Math.round((profile.total_wins / profile.total_matches) * 100) : 0;
  const joined = new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingTop: 60, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.headerSection}>
        <RankCrest elo={profile.elo} size={96} style={{ marginBottom: 8 }}>
          {profile.avatar_url ? (
            <Image source={{ uri: `${API_BASE}${profile.avatar_url}` }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarLetterBg}>
              <Text style={styles.avatarText}>{profile.username?.[0]?.toUpperCase() ?? '?'}</Text>
            </View>
          )}
        </RankCrest>
        <Text style={styles.username}>{profile.username}</Text>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rank.label} · {profile.elo} ELO</Text>
        </View>
      </View>

      {/* Bio */}
      {profile.bio ? (
        <View style={styles.bioCard}>
          <Text style={styles.bioText}>"{profile.bio}"</Text>
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
          value={handicap?.handicap_index != null ? handicap.handicap_index.toFixed(1) : '—'}
        />
        <Stat label="Course Records" value={courseRecords.length} />
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

          {stats.sg_per_round && stats.sg_holes > 0 && (
            <>
              <Text style={styles.sgSubtitle}>STROKES GAINED PER ROUND</Text>
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

      {/* Best round */}
      {profile.best_round && (
        <>
          <OrnamentTitle title="Best Round" />
          <TouchableOpacity
            style={[styles.roundCard, { borderColor: C.gold }]}
            onPress={() => profile.best_round.hole_scores?.length
              ? openScorecard(profile.best_round)
              : profile.best_round.course_id && router.push(`/course/${profile.best_round.course_id}` as any)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.roundCourseName}>{profile.best_round.course_name ?? 'Unknown course'}</Text>
              <Text style={styles.roundMeta}>
                {profile.best_round.teebox_name} · {profile.best_round.num_holes} holes · Par {profile.best_round.teebox_par}
              </Text>
              <Text style={styles.roundDate}>
                {new Date(profile.best_round.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.roundScoreBox}>
              <Text style={[styles.roundScore, { color: C.gold }]}>{profile.best_round.total_score}</Text>
              <Text style={[styles.roundToPar, { color: profile.best_round.to_par <= 0 ? C.green : C.red }]}>
                {profile.best_round.to_par > 0 ? `+${profile.best_round.to_par}` : profile.best_round.to_par === 0 ? 'E' : profile.best_round.to_par}
              </Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {/* Recent rounds */}
      <OrnamentTitle title="Recent Rounds" />
      {profile.recent_rounds?.length === 0 ? (
        <Text style={styles.empty}>No rounds played yet.</Text>
      ) : (
        profile.recent_rounds?.map((r: any) => (
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
                {r.teebox_name ?? '—'} · {r.num_holes ?? r.hole_scores?.length ?? '?'} holes
                {r.format === 'scramble' ? ' · Scramble' : ''}
              </Text>
              <Text style={styles.roundDate}>
                {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </Text>
            </View>
            <View style={styles.roundScoreBox}>
              <Text style={styles.roundScore}>{r.total_score}</Text>
              {r.teebox_par != null && (
                <Text style={[styles.roundToPar, {
                  color: r.total_score - r.teebox_par < 0 ? C.green :
                         r.total_score - r.teebox_par > 0 ? C.red : C.text,
                }]}>
                  {r.total_score - r.teebox_par > 0 ? `+${r.total_score - r.teebox_par}` :
                   r.total_score - r.teebox_par === 0 ? 'E' : r.total_score - r.teebox_par}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        ))
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
    </ScrollView>
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
