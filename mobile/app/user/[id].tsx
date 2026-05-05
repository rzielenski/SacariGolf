import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api, API_BASE } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';

function EloRank(elo: number): { label: string; color: string } {
  if (elo >= 2000) return { label: 'Diamond', color: '#a8d8f0' };
  if (elo >= 1800) return { label: 'Platinum', color: '#c0c0d0' };
  if (elo >= 1600) return { label: 'Gold', color: C.gold };
  if (elo >= 1400) return { label: 'Silver', color: '#c0c0c0' };
  return { label: 'Bronze', color: '#cd7f32' };
}

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [handicap, setHandicap] = useState<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number } | null>(null);
  const [activeRound, setActiveRound] = useState<any | null>(null);

  const openScorecard = (round: any) => {
    setScorecardEntry({
      username: profile?.username,
      user_id: profile?.user_id,
      teebox_name: round.teebox_name,
      hole_scores: round.hole_scores,
      course_id: round.course_id,
      course_name: round.course_name,
      teebox_id: round.teebox_id,
      total_score: round.total_score,
      created_at: round.created_at,
      teebox_par: round.teebox_par,
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

  // Poll the player's live in-progress round every 30s while the screen is open
  useEffect(() => {
    let cancelled = false;
    const fetchActive = () => api.users.activeRound(id)
      .then((data) => { if (!cancelled) setActiveRound(data); })
      .catch(() => { });
    fetchActive();
    const t = setInterval(fetchActive, 30_000);
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
        <View style={[styles.avatar, { borderColor: rank.color }]}>
          {profile.avatar_url ? (
            <Image source={{ uri: `${API_BASE}${profile.avatar_url}` }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{profile.username[0].toUpperCase()}</Text>
          )}
        </View>
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
      </View>

      {/* Live round (in-progress) */}
      {activeRound && activeRound.hole_scores?.length > 0 && (
        <>
          <View style={styles.liveBadgeRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveLabel}>PLAYING NOW</Text>
          </View>
          <TouchableOpacity
            style={[styles.roundCard, { borderColor: C.green }]}
            onPress={() => setScorecardEntry({
              username: profile.username,
              user_id: profile.user_id,
              teebox_name: activeRound.teebox_name,
              hole_scores: activeRound.hole_scores,
              course_id: activeRound.course_id,
              course_name: activeRound.course_name,
              teebox_id: activeRound.teebox_id,
              total_score: activeRound.hole_scores.reduce((a: number, b: number) => a + b, 0),
              created_at: activeRound.round_started_at,
            })}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.roundCourseName}>{activeRound.course_name ?? 'Unknown course'}</Text>
              <Text style={styles.roundMeta}>
                {activeRound.teebox_name} · Hole {activeRound.hole_scores.length} of {activeRound.num_holes}
              </Text>
              <Text style={styles.roundDate}>Tap to view live scorecard</Text>
            </View>
            <View style={styles.roundScoreBox}>
              <Text style={[styles.roundScore, { color: C.green }]}>
                {activeRound.hole_scores.reduce((a: number, b: number) => a + b, 0)}
              </Text>
              <Text style={[styles.roundToPar, { color: C.textMuted }]}>thru {activeRound.hole_scores.length}</Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {/* Best round */}
      {profile.best_round && (
        <>
          <Text style={styles.sectionTitle}>BEST ROUND</Text>
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
      <Text style={styles.sectionTitle}>RECENT ROUNDS</Text>
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

      <Text style={styles.joined}>Joined {joined}</Text>

      <ScorecardModal
        visible={!!scorecardEntry}
        entry={scorecardEntry}
        onClose={() => setScorecardEntry(null)}
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

  liveBadgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 14, marginBottom: 6,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  liveLabel: { color: C.green, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
});
