import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, router } from 'expo-router';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';

/**
 * Detailed stats view. Shows handicap, strokes-gained per category (per round,
 * normalized to 18 holes), and average score normalized to 18 holes.
 *
 * SG categories require putts, chips, and GIR to be tracked on the hole;
 * unrated rounds and rounds without per-hole stats are excluded automatically
 * by the backend aggregator.
 */
export default function StatsScreen() {
  const { user } = useAuth();
  const [stats, setStats] = useState<any | null>(null);
  const [handicap, setHandicap] = useState<any | null>(null);
  const [advancedSG, setAdvancedSG] = useState<any | null>(null);
  const [sgMode, setSgMode] = useState<'basic' | 'advanced'>('basic');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      api.users.stats(user.user_id).catch(() => null),
      api.users.handicap(user.user_id).catch(() => null),
      api.users.sgAdvanced(user.user_id).catch(() => null),
    ]).then(([s, h, adv]) => {
      if (cancelled) return;
      setStats(s);
      setHandicap(h);
      setAdvancedSG(adv);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user?.user_id]);

  if (!user) return null;

  const avgScore18 = stats?.avg_strokes_per_hole != null
    ? (stats.avg_strokes_per_hole * 18).toFixed(1)
    : null;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'My Stats', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      {loading ? (
        <View style={{ paddingTop: 80, alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} size="large" />
        </View>
      ) : (
        <>
          {/* Handicap & average score — top-line summary */}
          <OrnamentTitle title="Summary" align="center" />
          <View style={s.summaryRow}>
            <SummaryBox
              label="HANDICAP"
              value={handicap?.handicap_index != null ? handicap.handicap_index.toFixed(1) : '—'}
              sub={handicap?.num_rounds_used
                ? `${handicap.num_rounds_used} of ${handicap.total_rated_rounds} rounds`
                : 'Need 3+ rated rounds'}
            />
            <SummaryBox
              label="AVG SCORE (18)"
              value={avgScore18 ?? '—'}
              sub={stats?.rounds_count
                ? `${stats.rounds_count} round${stats.rounds_count === 1 ? '' : 's'} · ${stats.holes_played} holes`
                : 'No rounds played'}
            />
          </View>

          {/* Strokes-gained breakdown — basic vs advanced */}
          <View style={{ height: 12 }} />
          <OrnamentTitle title="Strokes Gained" align="center" />

          {/* Mode toggle */}
          <View style={s.modeRow}>
            <TouchableOpacity
              style={[s.modeBtn, sgMode === 'basic' && s.modeBtnActive]}
              onPress={() => setSgMode('basic')}
              activeOpacity={0.7}
            >
              <Text style={[s.modeLabel, sgMode === 'basic' && { color: C.bg }]}>BASIC</Text>
              <Text style={[s.modeSub, sgMode === 'basic' && { color: C.bg + 'cc' }]}>From scorecard stats</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                s.modeBtn,
                sgMode === 'advanced' && s.modeBtnActive,
                !advancedSG?.sg_per_round && { opacity: 0.5 },
              ]}
              onPress={() => advancedSG?.sg_per_round && setSgMode('advanced')}
              disabled={!advancedSG?.sg_per_round}
              activeOpacity={0.7}
            >
              <Text style={[s.modeLabel, sgMode === 'advanced' && { color: C.bg }]}>ADVANCED</Text>
              <Text style={[s.modeSub, sgMode === 'advanced' && { color: C.bg + 'cc' }]}>From tracked shots</Text>
            </TouchableOpacity>
          </View>

          {sgMode === 'basic' ? (
            stats?.sg_per_round && stats.sg_holes > 0 ? (
              <>
                <Text style={s.subtitle}>Per round (normalized to 18 holes) · positive = gaining vs scratch</Text>
                <Text style={s.sample}>{stats.sg_holes} hole{stats.sg_holes === 1 ? '' : 's'} tracked across {stats.rounds_count} round{stats.rounds_count === 1 ? '' : 's'}</Text>
                <View style={{ marginTop: 18 }}>
                  <SGRow label="Off-the-Tee"  value={stats.sg_per_round.off_tee} />
                  <SGRow label="Approach"     value={stats.sg_per_round.approach} />
                  <SGRow label="Around-Green" value={stats.sg_per_round.around_green} />
                  <SGRow label="Putting"      value={stats.sg_per_round.putting} />
                  <View style={s.totalDivider} />
                  <SGRow label="TOTAL"        value={stats.sg_per_round.total} bold />
                </View>
              </>
            ) : (
              <Text style={s.empty}>
                Track putts, chips, and GIR during scoring to unlock strokes-gained categories.
                Toggle stats on each hole in the scoring screen.
              </Text>
            )
          ) : (
            advancedSG?.sg_per_round ? (
              <>
                <Text style={s.subtitle}>PGA Tour baseline model · {advancedSG.shots_used} shots, {advancedSG.holes_used} holes</Text>
                <Text style={s.sample}>Computed from your tracked shot locations and lies</Text>
                <View style={{ marginTop: 18 }}>
                  <SGRow label="Off-the-Tee"  value={advancedSG.sg_per_round.off_tee} />
                  <SGRow label="Approach"     value={advancedSG.sg_per_round.approach} />
                  <SGRow label="Around-Green" value={advancedSG.sg_per_round.around_green} />
                  <SGRow label="Putting"      value={advancedSG.sg_per_round.putting} />
                  <View style={s.totalDivider} />
                  <SGRow label="TOTAL"        value={advancedSG.sg_per_round.total} bold />
                </View>
              </>
            ) : (
              <Text style={s.empty}>
                Advanced strokes-gained needs tracked shot locations + pin coordinates.
                Track every shot during a round and the heatmap unlocks too.
              </Text>
            )
          )}

          {/* Other accumulated stats */}
          <View style={{ height: 20 }} />
          <OrnamentTitle title="On-Course" align="center" />
          <View style={s.statGrid}>
            <Stat label="GIR" value={stats?.gir_pct != null ? `${stats.gir_pct}%` : '—'} sub={stats?.gir_eligible ? `${stats.gir_count} of ${stats.gir_eligible}` : undefined} />
            <Stat label="Fairways" value={stats?.fw_hit_pct != null ? `${stats.fw_hit_pct}%` : '—'} sub={stats?.fw_eligible ? `${stats.fw_hits} of ${stats.fw_eligible}` : undefined} />
            <Stat label="Putts/Round" value={stats?.avg_putts_per_round != null ? stats.avg_putts_per_round.toFixed(1) : '—'} />
            <Stat label="Up & Down" value={stats?.up_and_down_pct != null ? `${stats.up_and_down_pct}%` : '—'} sub={stats?.up_and_down_chances ? `${stats.up_and_downs} of ${stats.up_and_down_chances}` : undefined} />
            <Stat label="3-Putts" value={stats?.three_putt_count ?? '—'} />
            <Stat label="Chips/Round" value={stats?.avg_chips_per_round != null ? stats.avg_chips_per_round.toFixed(1) : '—'} />
          </View>

          {/* Club heatmap entry */}
          <View style={{ height: 12 }} />
          <TouchableOpacity
            style={s.heatmapBtn}
            onPress={() => router.push('/club-heatmap' as any)}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.heatmapLabel}>CLUB HEATMAP</Text>
              <Text style={s.heatmapSub}>Per-club dispersion patterns from your tagged shots</Text>
            </View>
            <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
            <Text style={s.backLabel}>← Back to profile</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

function SummaryBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={s.summaryBox}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
      {sub && <Text style={s.summarySub}>{sub}</Text>}
    </View>
  );
}

function SGRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  const sign = value > 0 ? '+' : '';
  const color = value > 0.05 ? C.green : value < -0.05 ? C.red : C.text;
  return (
    <View style={s.sgRow}>
      <Text style={[s.sgLabel, bold && { fontWeight: '900', color: C.gold }]}>{label}</Text>
      <Text style={[s.sgVal, { color }, bold && { fontWeight: '900' }]}>{sign}{value.toFixed(2)}</Text>
    </View>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <View style={s.statBox}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
      {sub && <Text style={s.statSub}>{sub}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingBottom: 80 },
  subtitle: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 10 },
  sample: { color: C.textMuted, fontSize: 11, textAlign: 'center', marginTop: 4, fontStyle: 'italic' },
  empty: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 20, paddingHorizontal: 20, lineHeight: 18 },

  summaryRow: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 24 },
  summaryBox: {
    flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '66',
    borderRadius: 8, padding: 14, alignItems: 'center',
  },
  summaryLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  summaryValue: { color: C.gold, fontFamily: F.serif, fontSize: 32, fontWeight: '900', marginTop: 4 },
  summarySub: { color: C.textMuted, fontSize: 10, marginTop: 4, textAlign: 'center' },

  sgRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 6, marginBottom: 8,
  },
  sgLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  sgVal: { fontFamily: F.serif, fontSize: 20, fontWeight: '700' },
  totalDivider: { height: 1, backgroundColor: C.gold + '44', marginVertical: 12 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18, marginBottom: 16 },
  statBox: {
    width: '31%', minHeight: 88, backgroundColor: C.card, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, paddingHorizontal: 4,
  },
  statValue: { color: C.text, fontSize: 18, fontFamily: F.serif, fontWeight: '800' },
  statLabel: { color: C.textMuted, fontSize: 10, marginTop: 2, fontWeight: '700', letterSpacing: 0.6 },
  statSub: { color: C.textMuted, fontSize: 9, marginTop: 2 },

  backBtn: { marginTop: 24, alignSelf: 'center', padding: 10 },
  backLabel: { color: C.gold, fontSize: 14 },

  modeRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 4 },
  modeBtn: {
    flex: 1, paddingVertical: 10, paddingHorizontal: 8,
    borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  modeLabel: { color: C.text, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },
  modeSub: { color: C.textMuted, fontSize: 9, marginTop: 2 },

  heatmapBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '88',
    borderRadius: 8, padding: 14,
  },
  heatmapLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },
  heatmapSub: { color: C.textMuted, fontSize: 11, marginTop: 3 },
});
