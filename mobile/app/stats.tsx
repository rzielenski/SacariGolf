import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Stack, router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';
import { PuttingApproachStats } from '../components/PuttingApproachStats';
import { parseCSV } from '../lib/importShots';
import { fmtHandicap } from '../lib/golfMath';

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
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  /** Open the system file picker, parse the CSV, and POST it to the import
   *  endpoint. Works for Flightscope, Trackman, and any vendor CSV with a
   *  `Club` column and a `Total` or `Carry` distance column. */
  const importCSV = async () => {
    if (importing) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const uri = picked.assets[0].uri;
      // expo-file-system v19+ — `readAsStringAsync` is deprecated in favor of
      // the File class. `.text()` returns the file contents as a UTF-8 string.
      const raw = await new File(uri).text();

      const parsed = parseCSV(raw);
      if (!parsed.shots.length) {
        Alert.alert(
          'No shots found',
          parsed.unmappedClubs.length
            ? `Couldn't recognize these clubs: ${parsed.unmappedClubs.join(', ')}`
            : 'Make sure your CSV has a Club column and a Total/Carry column.',
        );
        return;
      }

      const summary = Object.entries(parsed.perClubCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c.toUpperCase()}: ${n}`)
        .join('\n');

      Alert.alert(
        'Import shots?',
        `${parsed.shots.length} shots across ${Object.keys(parsed.perClubCounts).length} clubs:\n\n${summary}${
          parsed.unmappedClubs.length ? `\n\nSkipped clubs: ${parsed.unmappedClubs.join(', ')}` : ''
        }`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Import',
            onPress: async () => {
              setImporting(true);
              try {
                const fileName = picked.assets?.[0].name?.replace(/\.csv$/i, '') ?? null;
                const res = await api.users.importShots({
                  name: fileName ? `Import · ${fileName}` : undefined,
                  shots: parsed.shots,
                });
                Alert.alert('Imported', `${res.total_shots} shots added to your stats.`);
                // No need to refresh anything explicitly — next stats load
                // (or heatmap visit) reads them from the server.
              } catch (e: any) {
                Alert.alert('Import failed', e.message ?? 'Try again.');
              } finally {
                setImporting(false);
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Could not read file', e.message ?? 'Try a different file.');
    }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      api.users.stats(user.user_id).catch(() => null),
      api.users.handicap(user.user_id).catch(() => null),
    ]).then(([s, h]) => {
      if (cancelled) return;
      setStats(s);
      setHandicap(h);
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
              value={fmtHandicap(handicap?.handicap_index ?? null)}
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

          {/* Strokes-gained — computed ONLY from GPS-tracked shots (Broadie model) */}
          <View style={{ height: 12 }} />
          <OrnamentTitle title="Strokes Gained" align="center" />

          {stats?.sg_per_round ? (
            <>
              <Text style={s.subtitle}>PGA Tour baseline · per round · positive = gaining</Text>
              <Text style={s.sample}>
                Putting & chipping from your putt distances · off-tee & approach from tracked shots · {stats.sg_rounds_used} round{stats.sg_rounds_used === 1 ? '' : 's'}
              </Text>
              {stats.sg_rounds_used < 5 && (
                <Text style={s.warn}>
                  Small sample. Strokes gained gets reliable around 5+ rounds, treat these as early signal.
                </Text>
              )}
              <View style={{ marginTop: 18 }}>
                <SGRow label="Off-the-Tee"  value={stats.sg_per_round.off_tee} />
                <SGRow label="Approach"     value={stats.sg_per_round.approach} />
                <SGRow label="Around-Green" value={stats.sg_per_round.around_green} />
                <SGRow label="Putting"      value={stats.sg_per_round.putting} />
                <View style={s.totalDivider} />
                <SGRow label="TOTAL"        value={stats.sg_per_round.total} bold />
              </View>

              {/* Where the strokes go: biggest leak + tour-baseline what-ifs
                  (Broadie's "Every Shot Counts" decomposition). */}
              {(() => {
                const label: Record<string, string> = {
                  off_tee: 'Off the tee', approach: 'Approach',
                  around_green: 'Around the green', putting: 'Putting',
                };
                const leak = stats.sg_biggest_leak as string | null;
                const whatIf = (stats.sg_what_if ?? []) as { category: string; gain_per_round: number }[];
                const dec = stats.sg_decomposition as Record<string, number> | null;
                const tp = stats.sg_three_putt as { per_round: number; sg_lost_per_round: number } | null;
                const worst = stats.sg_worst_bucket as { kind: string; bucket: string; sg_per_round: number } | null;
                if (!leak && whatIf.length === 0 && !worst) return null;
                // Only frame the long-game share when long-game data exists,
                // else a putts-only profile would read "0% long game".
                const hasLongGame = stats.sg_per_round.off_tee != null || stats.sg_per_round.approach != null;
                const longShare = dec && hasLongGame ? (dec.off_tee ?? 0) + (dec.approach ?? 0) : null;
                return (
                  <View style={s.insightBox}>
                    {leak != null && (
                      <Text style={s.leakLine}>
                        BIGGEST LEAK: <Text style={s.leakName}>{(label[leak] ?? leak).toUpperCase()}</Text>
                      </Text>
                    )}
                    {worst != null && (
                      <Text style={s.insightLine}>
                        · Sharpest leak: {worst.kind === 'approach' ? 'approach from' : 'putts from'} {worst.bucket} ({worst.sg_per_round.toFixed(1)} a round)
                      </Text>
                    )}
                    {whatIf.slice(0, 2).map((w) => (
                      <Text key={w.category} style={s.insightLine}>
                        · {label[w.category] ?? w.category} at the tour baseline: +{w.gain_per_round.toFixed(1)} a round
                      </Text>
                    ))}
                    {tp != null && tp.sg_lost_per_round >= 0.3 && (
                      <Text style={s.insightLine}>
                        · 3-putts alone cost {tp.sg_lost_per_round.toFixed(1)} a round ({tp.per_round.toFixed(1)} per round)
                      </Text>
                    )}
                    {longShare != null && longShare > 0 && (
                      <Text style={s.splitNote}>
                        Long game: {longShare}% of your losses · typical amateur is ~65% (Broadie)
                      </Text>
                    )}
                  </View>
                );
              })()}

              {/* SG by distance — which yardages / putt ranges leak. Per round;
                  sums to the category totals above. */}
              {(() => {
                const app = (stats.sg_approach_buckets ?? []) as { bucket: string; sg_per_round: number; shots: number }[];
                const putt = (stats.sg_putting_buckets ?? []) as { bucket: string; sg_per_round: number; holes: number }[];
                const appRows = app.filter((b) => b.shots > 0);
                const puttRows = putt.filter((b) => b.holes > 0);
                if (appRows.length === 0 && puttRows.length === 0) return null;
                const valColor = (v: number) => (v > 0 ? C.green : v < 0 ? C.red : C.textMuted);
                const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
                return (
                  <View style={s.bucketCard}>
                    {appRows.length > 0 && (
                      <>
                        <Text style={s.bucketHead}>APPROACH · BY START DISTANCE</Text>
                        {appRows.map((b) => (
                          <View key={b.bucket} style={s.bucketRow}>
                            <Text style={s.bucketLabel}>{b.bucket}</Text>
                            <Text style={[s.bucketVal, { color: valColor(b.sg_per_round) }]}>{fmt(b.sg_per_round)}</Text>
                            <Text style={s.bucketN}>{b.shots} shot{b.shots === 1 ? '' : 's'}</Text>
                          </View>
                        ))}
                      </>
                    )}
                    {puttRows.length > 0 && (
                      <>
                        <Text style={[s.bucketHead, appRows.length > 0 && { marginTop: 10 }]}>
                          PUTTING · BY FIRST-PUTT DISTANCE
                        </Text>
                        {puttRows.map((b) => (
                          <View key={b.bucket} style={s.bucketRow}>
                            <Text style={s.bucketLabel}>{b.bucket}</Text>
                            <Text style={[s.bucketVal, { color: valColor(b.sg_per_round) }]}>{fmt(b.sg_per_round)}</Text>
                            <Text style={s.bucketN}>{b.holes} hole{b.holes === 1 ? '' : 's'}</Text>
                          </View>
                        ))}
                      </>
                    )}
                    <Text style={s.sample}>per round vs the tour baseline</Text>
                  </View>
                );
              })()}

              <Text style={s.sample}>
                A dash (—) means no data yet for that category. Putting & chipping need putt distances entered; off-tee & approach need tracked shots.
              </Text>
            </>
          ) : (
            <Text style={s.empty}>
              Enter your putt distances during scoring to unlock putting & chipping strokes-gained.
              Track your shots to add off-the-tee & approach.
            </Text>
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

          {/* Shot breakdown — putting make% + approach proximity vs the PGA
              Tour (Broadie) baselines. Self-contained card, fetches its own
              data + handles its own empty state. */}
          <View style={{ height: 4 }} />
          {user && <PuttingApproachStats userId={user.user_id} />}

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

          {/* Import shots from launch monitor CSV */}
          <View style={{ height: 8 }} />
          <TouchableOpacity
            style={s.heatmapBtn}
            onPress={importCSV}
            disabled={importing}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.heatmapLabel}>{importing ? 'IMPORTING…' : 'IMPORT SHOTS (CSV)'}</Text>
              <Text style={s.heatmapSub}>From Flightscope, Trackman, Mevo, or similar launch monitor exports</Text>
            </View>
            {importing
              ? <ActivityIndicator color={C.gold} size="small" />
              : <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>}
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

function SGRow({ label, value, bold }: { label: string; value: number | null; bold?: boolean }) {
  const has = typeof value === 'number';
  const sign = has && (value as number) > 0 ? '+' : '';
  const color = !has ? C.textMuted : (value as number) > 0.05 ? C.green : (value as number) < -0.05 ? C.red : C.text;
  return (
    <View style={s.sgRow}>
      <Text style={[s.sgLabel, bold && { fontWeight: '900', color: C.gold }]}>{label}</Text>
      <Text style={[s.sgVal, { color }, bold && { fontWeight: '900' }]}>{has ? `${sign}${(value as number).toFixed(2)}` : '—'}</Text>
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
  warn: { color: C.gold, fontSize: 11, textAlign: 'center', marginTop: 8, paddingHorizontal: 24, lineHeight: 16, fontStyle: 'italic' },
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

  // "Where the strokes go" insight block (biggest leak / tour-baseline
  // what-ifs / 3-putt cost) + the SG-by-distance table under it.
  insightBox: {
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingVertical: 12, paddingHorizontal: 14, marginTop: 14, gap: 4,
  },
  leakLine: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  leakName: { color: C.gold },
  insightLine: { color: C.text, fontSize: 13, lineHeight: 18 },
  splitNote: { color: C.textMuted, fontSize: 11, fontStyle: 'italic', marginTop: 4 },
  bucketCard: {
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingVertical: 12, paddingHorizontal: 14, marginTop: 10, gap: 5,
  },
  bucketHead: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 2 },
  bucketRow: { flexDirection: 'row', alignItems: 'center' },
  bucketLabel: { flex: 1, color: C.text, fontSize: 13 },
  bucketVal: { width: 56, textAlign: 'right', fontSize: 14, fontWeight: '900', fontFamily: F.serif },
  bucketN: { width: 74, textAlign: 'right', color: C.textMuted, fontSize: 10 },

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
