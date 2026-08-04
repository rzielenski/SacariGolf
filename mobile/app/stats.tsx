import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  Alert, Animated, PanResponder,
} from 'react-native';
import { Stack, router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';
import { parseCSV } from '../lib/importShots';
import { fmtHandicap } from '../lib/golfMath';
import { clubLabel } from '../lib/clubs';
import {
  BENCH, BENCH_SG, BENCH_PUTT_MAKE, BENCH_PROXIMITY,
  BenchStat, BenchTier, TIER_LABEL, compare, fmtBench,
} from '../lib/benchmarks';

/**
 * Stats dashboard. Every stat the app accumulates, in one place:
 *   • Tabs by game area (overview, long game, approach, short game,
 *     putting, clubs).
 *   • A benchmark slider: compare any stat against the PGA Tour, a scratch
 *     golfer, or a 10 handicap.
 *   • Robust aggregates only: distances and proximities are medians (with the
 *     75th percentile as the "bad but normal" line), never raw means — one
 *     shank should not move a stat.
 *
 * Tour benchmarks are published figures; scratch and 10-hcp are estimates
 * from published amateur data (Broadie's tables + USGA/Arccos distance
 * reports), labelled as such on screen.
 */

type Tab = 'overview' | 'long' | 'approach' | 'short' | 'putting' | 'clubs';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'long', label: 'Long Game' },
  { key: 'approach', label: 'Approach' },
  { key: 'short', label: 'Short Game' },
  { key: 'putting', label: 'Putting' },
  { key: 'clubs', label: 'Clubs' },
];

const TIERS: BenchTier[] = ['tour', 'scratch', 'hcp10'];

/** p75 of a numeric array (linear interpolation), null when empty. */
function p75(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * 0.75;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export default function StatsScreen() {
  const { user } = useAuth();
  const [stats, setStats] = useState<any | null>(null);
  const [handicap, setHandicap] = useState<any | null>(null);
  const [clubs, setClubs] = useState<any[] | null>(null);
  const [shotStats, setShotStats] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [tier, setTier] = useState<BenchTier>('scratch');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      api.users.stats(user.user_id).catch(() => null),
      api.users.handicap(user.user_id).catch(() => null),
      api.users.clubStats(user.user_id).catch(() => null),
      api.users.shotStats(user.user_id).catch(() => null),
    ]).then(([s, h, c, ss]) => {
      if (cancelled) return;
      setStats(s);
      setHandicap(h);
      setClubs(c?.clubs ?? null);
      setShotStats(ss);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user?.user_id]);

  /** Driver distances, robust: median from the server, p75 computed from the
   *  dispersion samples. */
  const driver = useMemo(() => {
    const d = clubs?.find((c) => c.club === 'driver');
    if (!d || !(d.shots > 0)) return null;
    const dists = (d.dispersion ?? []).map((p: any) => p.dist_yds).filter((n: any) => Number.isFinite(n));
    return {
      median: d.median_yds as number,
      p75: p75(dists),
      shots: d.shots as number,
    };
  }, [clubs]);

  const threePuttsPerRound = stats?.rounds_count
    ? stats.three_putt_count / stats.rounds_count : null;

  const importCSV = async () => {
    if (importing) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const raw = await new File(picked.assets[0].uri).text();
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

  if (!user) return null;

  const avgScore18 = stats?.avg_strokes_per_hole != null
    ? (stats.avg_strokes_per_hole * 18).toFixed(1)
    : null;

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'My Stats', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      {loading ? (
        <View style={{ paddingTop: 80, alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} size="large" />
        </View>
      ) : (
        <>
          {/* Tab strip */}
          <View style={s.tabWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabStrip}>
              {TABS.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={[s.tabChip, tab === t.key && s.tabChipActive]}
                  onPress={() => setTab(t.key)}
                >
                  <Text style={[s.tabLabel, tab === t.key && s.tabLabelActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Benchmark slider — who am I comparing against? */}
          {tab !== 'clubs' && <BenchSlider tier={tier} onChange={setTier} />}

          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.content}>
            {tab === 'overview' && (
              <OverviewTab
                stats={stats} handicap={handicap} tier={tier}
                avgScore18={avgScore18} threePuttsPerRound={threePuttsPerRound}
              />
            )}
            {tab === 'long' && <LongGameTab stats={stats} driver={driver} tier={tier} />}
            {tab === 'approach' && <ApproachTab stats={stats} shotStats={shotStats} tier={tier} />}
            {tab === 'short' && <ShortGameTab stats={stats} shotStats={shotStats} tier={tier} />}
            {tab === 'putting' && (
              <PuttingTab stats={stats} shotStats={shotStats} tier={tier} threePuttsPerRound={threePuttsPerRound} />
            )}
            {tab === 'clubs' && (
              <ClubsTab clubs={clubs} importing={importing} onImport={importCSV} />
            )}

            <Text style={s.benchNote}>
              Tour numbers are published ShotLink and Broadie figures. Scratch and 10-handicap are
              estimates from published amateur data, not Sacari players.
            </Text>
            <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
              <Text style={s.backLabel}>Back to profile</Text>
            </TouchableOpacity>
          </ScrollView>
        </>
      )}
    </View>
  );
}

/* ───────────────────────────── Benchmark slider ───────────────────────────── */

function BenchSlider({ tier, onChange }: { tier: BenchTier; onChange: (t: BenchTier) => void }) {
  const [trackW, setTrackW] = useState(0);
  const segW = trackW / TIERS.length;
  const x = useRef(new Animated.Value(TIERS.indexOf(tier))).current;
  const trackRef = useRef<View | null>(null);
  // The track's absolute X. Drag math uses pageX - this, because inside a
  // PanResponder `locationX` can be relative to whichever CHILD the finger is
  // over, which made the thumb jump between segments mid-drag.
  const trackPageX = useRef(0);
  // Geometry refs so the PanResponder (created once) always sees fresh values.
  const segWRef = useRef(0);
  segWRef.current = segW;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    Animated.spring(x, { toValue: TIERS.indexOf(tier), useNativeDriver: false, friction: 9, tension: 90 }).start();
  }, [tier, x]);

  const idxFromPageX = (pageX: number) => {
    const w = segWRef.current;
    if (!w) return 0;
    return Math.max(0, Math.min(TIERS.length - 1, (pageX - trackPageX.current - w / 2) / w));
  };

  // Drag support: the thumb follows the finger and snaps to the nearest stop
  // on release. Taps on a segment also work (the TouchableOpacity layer).
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6,
      onPanResponderMove: (e) => { x.setValue(idxFromPageX(e.nativeEvent.pageX)); },
      onPanResponderRelease: (e) => {
        const idx = Math.round(idxFromPageX(e.nativeEvent.pageX));
        onChangeRef.current(TIERS[idx]);
        // Snap even when the tier didn't change, else the thumb parks mid-track.
        Animated.spring(x, { toValue: idx, useNativeDriver: false, friction: 9, tension: 90 }).start();
      },
    }),
  ).current;

  return (
    <View style={s.sliderWrap}>
      <Text style={s.sliderCaption}>COMPARE AGAINST</Text>
      <View
        ref={trackRef}
        style={s.sliderTrack}
        onLayout={(e) => {
          setTrackW(e.nativeEvent.layout.width);
          trackRef.current?.measureInWindow((wx) => { trackPageX.current = wx; });
        }}
        {...pan.panHandlers}
      >
        {segW > 0 && (
          <Animated.View
            style={[s.sliderThumb, {
              width: segW - 6,
              transform: [{ translateX: Animated.add(Animated.multiply(x, segW), new Animated.Value(3)) }],
            }]}
          />
        )}
        {TIERS.map((t) => (
          <TouchableOpacity key={t} style={s.sliderSeg} onPress={() => onChange(t)}>
            <Text style={[s.sliderSegText, tier === t && s.sliderSegTextActive]}>{TIER_LABEL[t]}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

/* ───────────────────────────── Shared rows ───────────────────────────── */

/** One stat vs the selected benchmark: label, your value, theirs, verdict dot. */
function CompareRow({ label, mine, bench, tier, sub }: {
  label: string; mine: number | null | undefined; bench: BenchStat;
  tier: BenchTier; sub?: string;
}) {
  const verdict = compare(mine, bench, tier);
  const color = verdict === 'better' ? C.green : verdict === 'worse' ? C.red : C.textMuted;
  return (
    <View style={s.cmpRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.cmpLabel}>{label}</Text>
        {sub ? <Text style={s.cmpSub}>{sub}</Text> : null}
      </View>
      <Text style={[s.cmpMine, mine == null && { color: C.textMuted }]}>
        {fmtBench(mine, bench.unit)}
      </Text>
      <View style={s.cmpBenchCol}>
        <Text style={s.cmpBench}>{fmtBench(bench[tier], bench.unit)}</Text>
        <Text style={s.cmpBenchWho}>{TIER_LABEL[tier]}</Text>
      </View>
      <View style={[s.cmpDot, { backgroundColor: mine == null ? C.border : color }]} />
    </View>
  );
}

/** Bucket bar: your value as a fill, benchmark as a tick on the same track.
 *  For lower-is-better stats the scale runs to the worst of the two. */
function BucketBar({ label, mine, bench, tier, n, extra }: {
  label: string; mine: number | null; bench: BenchStat; tier: BenchTier;
  n: number; extra?: string | null;
}) {
  const benchV = bench[tier];
  const scale = Math.max(mine ?? 0, benchV) * 1.25 || 1;
  const verdict = compare(mine, bench, tier);
  const fillColor = verdict === 'better' ? C.green : verdict === 'worse' ? C.red : C.gold;
  return (
    <View style={s.bktRow}>
      <View style={s.bktHead}>
        <Text style={s.bktLabel}>{label}</Text>
        <Text style={s.bktVals}>
          <Text style={{ color: mine == null ? C.textMuted : C.text, fontWeight: '800' }}>
            {fmtBench(mine, bench.unit)}
          </Text>
          <Text style={{ color: C.textMuted }}>  vs {fmtBench(benchV, bench.unit)}</Text>
        </Text>
      </View>
      <View style={s.bktTrack}>
        {mine != null && (
          <View style={[s.bktFill, { width: `${Math.min(100, (mine / scale) * 100)}%`, backgroundColor: fillColor + '55', borderColor: fillColor }]} />
        )}
        <View style={[s.bktTick, { left: `${Math.min(100, (benchV / scale) * 100)}%` }]} />
      </View>
      <Text style={s.bktN}>
        {n > 0 ? `${n} ${n === 1 ? 'sample' : 'samples'}` : 'no data yet'}
        {extra ? ` · ${extra}` : ''}
      </Text>
    </View>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <Text style={s.empty}>{children}</Text>;
}

/* ───────────────────────────── Tabs ───────────────────────────── */

function OverviewTab({ stats, handicap, tier, avgScore18, threePuttsPerRound }: any) {
  const label: Record<string, string> = {
    off_tee: 'Off the tee', approach: 'Approach',
    around_green: 'Around the green', putting: 'Putting',
  };
  const sg = stats?.sg_per_round;
  return (
    <>
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

      <OrnamentTitle title="Strokes Gained" align="center" />
      {sg ? (
        <>
          <Text style={s.subtitle}>Per round vs the PGA Tour baseline · positive = gaining</Text>
          {stats.sg_rounds_used < 5 && (
            <Text style={s.warn}>
              Small sample. Strokes gained gets reliable around 5+ rounds.
            </Text>
          )}
          <View style={{ marginTop: 14 }}>
            <CompareRow label="Off the tee" mine={sg.off_tee} bench={BENCH_SG.off_tee} tier={tier} />
            <CompareRow label="Approach" mine={sg.approach} bench={BENCH_SG.approach} tier={tier} />
            <CompareRow label="Around the green" mine={sg.around_green} bench={BENCH_SG.around_green} tier={tier} />
            <CompareRow label="Putting" mine={sg.putting} bench={BENCH_SG.putting} tier={tier} />
            <View style={s.totalDivider} />
            <CompareRow label="TOTAL" mine={sg.total} bench={BENCH_SG.total} tier={tier} />
          </View>

          {(() => {
            const leak = stats.sg_biggest_leak as string | null;
            const whatIf = (stats.sg_what_if ?? []) as { category: string; gain_per_round: number }[];
            const tp = stats.sg_three_putt as { per_round: number; sg_lost_per_round: number } | null;
            const worst = stats.sg_worst_bucket as { kind: string; bucket: string; sg_per_round: number } | null;
            if (!leak && whatIf.length === 0 && !worst) return null;
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
                    · 3-putts alone cost {tp.sg_lost_per_round.toFixed(1)} a round
                  </Text>
                )}
              </View>
            );
          })()}
        </>
      ) : (
        <EmptyHint>
          Enter putt distances during scoring to unlock putting and chipping strokes gained.
          Track shots for off-the-tee and approach.
        </EmptyHint>
      )}

      <View style={{ height: 16 }} />
      <OrnamentTitle title="At a Glance" align="center" />
      <View style={{ marginTop: 12 }}>
        <CompareRow label="Fairways hit" mine={stats?.fw_hit_pct} bench={BENCH.fairway_pct} tier={tier}
          sub={stats?.fw_eligible ? `${stats.fw_hits} of ${stats.fw_eligible}` : undefined} />
        <CompareRow label="Greens in regulation" mine={stats?.gir_pct} bench={BENCH.gir_pct} tier={tier}
          sub={stats?.gir_eligible ? `${stats.gir_count} of ${stats.gir_eligible}` : undefined} />
        <CompareRow label="Putts per round" mine={stats?.avg_putts_per_round} bench={BENCH.putts_per_round} tier={tier} />
        <CompareRow label="Up and down" mine={stats?.up_and_down_pct} bench={BENCH.up_and_down_pct} tier={tier} />
        <CompareRow label="3-putts per round" mine={threePuttsPerRound} bench={BENCH.three_putts_per_round} tier={tier} />
      </View>
    </>
  );
}

function LongGameTab({ stats, driver, tier }: any) {
  return (
    <>
      <OrnamentTitle title="Long Game" align="center" />
      <View style={{ marginTop: 12 }}>
        <CompareRow
          label="Driving distance"
          mine={driver?.median ?? null}
          bench={BENCH.driving_distance}
          tier={tier}
          sub={driver ? `median of ${driver.shots} tracked drives` : 'track drives to fill this in'}
        />
        {driver?.p75 != null && (
          <Text style={s.p75Note}>
            Your 75th percentile drive is {Math.round(driver.p75)} yds. The median is the honest number;
            one bomb does not move it.
          </Text>
        )}
        <CompareRow
          label="Fairways hit"
          mine={stats?.fw_hit_pct}
          bench={BENCH.fairway_pct}
          tier={tier}
          sub={stats?.fw_eligible ? `${stats.fw_hits} of ${stats.fw_eligible} par 4s and 5s` : undefined}
        />
        <CompareRow
          label="SG off the tee"
          mine={stats?.sg_per_round?.off_tee}
          bench={BENCH_SG.off_tee}
          tier={tier}
          sub="per round vs tour"
        />
      </View>
      {!driver && (
        <EmptyHint>
          No tracked drives yet. Track tee shots on the course, hit Range Live with a launch
          monitor, or import a CSV in the Clubs tab.
        </EmptyHint>
      )}
    </>
  );
}

function ApproachTab({ stats, shotStats, tier }: any) {
  const buckets = (shotStats?.approach ?? []).filter((b: any) => BENCH_PROXIMITY[b.bucket]);
  const hasAny = buckets.some((b: any) => b.shots > 0);
  const sgBuckets = ((stats?.sg_approach_buckets ?? []) as any[]).filter((b) => b.shots > 0);
  return (
    <>
      <OrnamentTitle title="Approach" align="center" />
      <View style={{ marginTop: 12 }}>
        <CompareRow
          label="Greens in regulation"
          mine={stats?.gir_pct}
          bench={BENCH.gir_pct}
          tier={tier}
          sub={stats?.gir_eligible ? `${stats.gir_count} of ${stats.gir_eligible}` : undefined}
        />
        <CompareRow
          label="SG approach"
          mine={stats?.sg_per_round?.approach}
          bench={BENCH_SG.approach}
          tier={tier}
          sub="per round vs tour"
        />
      </View>

      <Text style={s.sectionHead}>PROXIMITY TO THE PIN · MEDIAN BY START DISTANCE</Text>
      {hasAny ? buckets.map((b: any) => (
        <BucketBar
          key={b.bucket}
          label={b.bucket}
          mine={b.median_proximity_ft ?? b.avg_proximity_ft}
          bench={BENCH_PROXIMITY[b.bucket]}
          tier={tier}
          n={b.shots}
          extra={b.p75_proximity_ft != null ? `3 of 4 inside ${Math.round(b.p75_proximity_ft)} ft` : null}
        />
      )) : (
        <EmptyHint>
          Track approach shots on holes with a marked pin to build your proximity profile.
        </EmptyHint>
      )}

      {sgBuckets.length > 0 && (
        <>
          <Text style={s.sectionHead}>STROKES GAINED · BY START DISTANCE</Text>
          {sgBuckets.map((b) => (
            <SGBucketRow key={b.bucket} label={b.bucket} value={b.sg_per_round} n={b.shots} nWord="shot" />
          ))}
        </>
      )}
    </>
  );
}

function ShortGameTab({ stats, shotStats, tier }: any) {
  const chip = (shotStats?.approach ?? []).find((b: any) => b.bucket === '<50 yd (chip)');
  return (
    <>
      <OrnamentTitle title="Short Game" align="center" />
      <View style={{ marginTop: 12 }}>
        <CompareRow
          label="Up and down"
          mine={stats?.up_and_down_pct}
          bench={BENCH.up_and_down_pct}
          tier={tier}
          sub={stats?.up_and_down_chances ? `${stats.up_and_downs} of ${stats.up_and_down_chances} chances` : undefined}
        />
        <CompareRow
          label="SG around the green"
          mine={stats?.sg_per_round?.around_green}
          bench={BENCH_SG.around_green}
          tier={tier}
          sub="per round vs tour"
        />
      </View>
      {chip && (
        <>
          <Text style={s.sectionHead}>INSIDE 50 YARDS</Text>
          <BucketBar
            label="Chip and pitch proximity"
            mine={chip.median_proximity_ft ?? chip.avg_proximity_ft}
            bench={BENCH_PROXIMITY['<50 yd (chip)']}
            tier={tier}
            n={chip.shots}
            extra={chip.p75_proximity_ft != null ? `3 of 4 inside ${Math.round(chip.p75_proximity_ft)} ft` : null}
          />
        </>
      )}
      {stats?.avg_chips_per_round != null && (
        <Text style={s.p75Note}>
          You chip {stats.avg_chips_per_round.toFixed(1)} times a round. Fewer chips means more
          greens; better chips mean more of those turn into par saves.
        </Text>
      )}
    </>
  );
}

function PuttingTab({ stats, shotStats, tier, threePuttsPerRound }: any) {
  const buckets = (shotStats?.putting ?? []).filter((b: any) => BENCH_PUTT_MAKE[b.bucket]);
  const hasAny = buckets.some((b: any) => b.attempts > 0);
  const sgBuckets = ((stats?.sg_putting_buckets ?? []) as any[]).filter((b) => b.holes > 0);
  return (
    <>
      <OrnamentTitle title="Putting" align="center" />
      <View style={{ marginTop: 12 }}>
        <CompareRow label="Putts per round" mine={stats?.avg_putts_per_round} bench={BENCH.putts_per_round} tier={tier} />
        <CompareRow label="3-putts per round" mine={threePuttsPerRound} bench={BENCH.three_putts_per_round} tier={tier} />
        <CompareRow label="SG putting" mine={stats?.sg_per_round?.putting} bench={BENCH_SG.putting} tier={tier}
          sub="per round vs tour" />
      </View>

      <Text style={s.sectionHead}>MAKE RATE · BY FIRST-PUTT DISTANCE</Text>
      {hasAny ? buckets.map((b: any) => (
        <BucketBar
          key={b.bucket}
          label={b.bucket}
          mine={b.make_pct}
          bench={BENCH_PUTT_MAKE[b.bucket]}
          tier={tier}
          n={b.attempts}
          extra={b.attempts > 0 ? `${b.made} made` : null}
        />
      )) : (
        <EmptyHint>
          Type your putt distances into the hole detail sheet while scoring and your make
          rates build themselves.
        </EmptyHint>
      )}

      {sgBuckets.length > 0 && (
        <>
          <Text style={s.sectionHead}>STROKES GAINED · BY FIRST-PUTT DISTANCE</Text>
          {sgBuckets.map((b) => (
            <SGBucketRow key={b.bucket} label={b.bucket} value={b.sg_per_round} n={b.holes} nWord="hole" />
          ))}
        </>
      )}
    </>
  );
}

function ClubsTab({ clubs, importing, onImport }: {
  clubs: any[] | null; importing: boolean; onImport: () => void;
}) {
  const rows = (clubs ?? [])
    .filter((c) => c.club !== 'putter' && c.shots > 0)
    .map((c) => ({
      club: c.club,
      shots: c.shots,
      median: c.median_yds,
      p75: p75((c.dispersion ?? []).map((p: any) => p.dist_yds).filter((n: any) => Number.isFinite(n))),
    }));
  return (
    <>
      <OrnamentTitle title="Clubs" align="center" />
      <Text style={s.subtitle}>Median carries the stat. p75 is your longer, still-normal hit.</Text>
      {rows.length ? (
        <View style={s.clubTable}>
          <View style={s.clubHeadRow}>
            <Text style={[s.clubHead, { flex: 1 }]}>CLUB</Text>
            <Text style={[s.clubHead, s.clubNum]}>MEDIAN</Text>
            <Text style={[s.clubHead, s.clubNum]}>P75</Text>
            <Text style={[s.clubHead, s.clubNum]}>SHOTS</Text>
          </View>
          {rows.map((r) => (
            <View key={r.club} style={s.clubRow}>
              <Text style={[s.clubName, { flex: 1 }]}>{clubLabel(r.club)}</Text>
              <Text style={[s.clubVal, s.clubNum]}>{Math.round(r.median)}</Text>
              <Text style={[s.clubValMuted, s.clubNum]}>{r.p75 != null ? Math.round(r.p75) : '—'}</Text>
              <Text style={[s.clubValMuted, s.clubNum]}>{r.shots}</Text>
            </View>
          ))}
        </View>
      ) : (
        <EmptyHint>No tagged shots yet. Track shots with a club selected, or import below.</EmptyHint>
      )}

      <View style={{ height: 14 }} />
      <TouchableOpacity style={s.linkBtn} onPress={() => router.push('/club-heatmap' as any)} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={s.linkLabel}>CLUB HEATMAP</Text>
          <Text style={s.linkSub}>Per-club dispersion patterns from your tagged shots</Text>
        </View>
        <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>
      </TouchableOpacity>
      <View style={{ height: 8 }} />
      <TouchableOpacity style={s.linkBtn} onPress={onImport} disabled={importing} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={s.linkLabel}>{importing ? 'IMPORTING…' : 'IMPORT SHOTS (CSV)'}</Text>
          <Text style={s.linkSub}>From Flightscope, Trackman, Mevo, or similar exports</Text>
        </View>
        {importing
          ? <ActivityIndicator color={C.gold} size="small" />
          : <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>}
      </TouchableOpacity>
    </>
  );
}

/* ───────────────────────────── Small pieces ───────────────────────────── */

function SummaryBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={s.summaryBox}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
      {sub && <Text style={s.summarySub}>{sub}</Text>}
    </View>
  );
}

function SGBucketRow({ label, value, n, nWord }: { label: string; value: number; n: number; nWord: string }) {
  const color = value > 0 ? C.green : value < 0 ? C.red : C.textMuted;
  return (
    <View style={s.sgBktRow}>
      <Text style={s.sgBktLabel}>{label}</Text>
      <Text style={[s.sgBktVal, { color }]}>{value > 0 ? '+' : ''}{value.toFixed(1)}</Text>
      <Text style={s.sgBktN}>{n} {nWord}{n === 1 ? '' : 's'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingBottom: 80 },
  subtitle: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 10 },
  warn: { color: C.gold, fontSize: 11, textAlign: 'center', marginTop: 8, paddingHorizontal: 24, lineHeight: 16, fontStyle: 'italic' },
  empty: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 16, paddingHorizontal: 20, lineHeight: 18 },

  tabWrap: { borderBottomWidth: 1, borderBottomColor: C.border },
  tabStrip: { paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  tabChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  tabChipActive: { borderColor: C.gold, backgroundColor: C.gold + '22' },
  tabLabel: { color: C.textMuted, fontSize: 12, fontWeight: '700' },
  tabLabelActive: { color: C.gold },

  sliderWrap: { paddingHorizontal: 20, paddingTop: 12 },
  sliderCaption: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 6, textAlign: 'center' },
  sliderTrack: {
    flexDirection: 'row', height: 38, borderRadius: 999,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
  },
  sliderThumb: {
    position: 'absolute', top: 3, bottom: 3, borderRadius: 999,
    backgroundColor: C.gold + '2e', borderWidth: 1, borderColor: C.gold,
  },
  sliderSeg: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sliderSegText: { color: C.textMuted, fontSize: 12, fontWeight: '700' },
  sliderSegTextActive: { color: C.gold },

  summaryRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  summaryBox: {
    flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '66',
    borderRadius: 8, padding: 14, alignItems: 'center',
  },
  summaryLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  summaryValue: { color: C.gold, fontFamily: F.serif, fontSize: 32, fontWeight: '900', marginTop: 4 },
  summarySub: { color: C.textMuted, fontSize: 10, marginTop: 4, textAlign: 'center' },

  cmpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 6, marginBottom: 8,
  },
  cmpLabel: { color: C.text, fontSize: 14, fontWeight: '600' },
  cmpSub: { color: C.textMuted, fontSize: 10, marginTop: 2 },
  cmpMine: { color: C.text, fontFamily: F.serif, fontSize: 17, fontWeight: '800', minWidth: 62, textAlign: 'right' },
  cmpBenchCol: { minWidth: 64, alignItems: 'flex-end' },
  cmpBench: { color: C.textMuted, fontSize: 13, fontWeight: '700' },
  cmpBenchWho: { color: C.textDim, fontSize: 8, fontWeight: '800', letterSpacing: 0.5, marginTop: 1 },
  cmpDot: { width: 8, height: 8, borderRadius: 4 },
  totalDivider: { height: 1, backgroundColor: C.gold + '44', marginVertical: 10 },

  sectionHead: {
    color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1,
    marginTop: 20, marginBottom: 10, textAlign: 'center',
  },

  bktRow: { marginBottom: 14 },
  bktHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  bktLabel: { color: C.text, fontSize: 13, fontWeight: '600' },
  bktVals: { fontSize: 12 },
  bktTrack: {
    height: 14, borderRadius: 4, backgroundColor: C.card,
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  bktFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRightWidth: 2, borderRadius: 3 },
  bktTick: { position: 'absolute', top: -2, bottom: -2, width: 2, backgroundColor: C.textMuted },
  bktN: { color: C.textDim, fontSize: 10, marginTop: 4 },

  sgBktRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 4 },
  sgBktLabel: { flex: 1, color: C.text, fontSize: 13 },
  sgBktVal: { width: 56, textAlign: 'right', fontSize: 14, fontWeight: '900', fontFamily: F.serif },
  sgBktN: { width: 74, textAlign: 'right', color: C.textMuted, fontSize: 10 },

  insightBox: {
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingVertical: 12, paddingHorizontal: 14, marginTop: 14, gap: 4,
  },
  leakLine: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  leakName: { color: C.gold },
  insightLine: { color: C.text, fontSize: 13, lineHeight: 18 },

  p75Note: {
    color: C.textMuted, fontSize: 11, fontStyle: 'italic', lineHeight: 16,
    marginTop: 2, marginBottom: 10, paddingHorizontal: 4,
  },

  clubTable: {
    marginTop: 14, backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  clubHeadRow: {
    flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  clubHead: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  clubNum: { width: 58, textAlign: 'right' },
  clubRow: {
    flexDirection: 'row', paddingVertical: 9, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: C.border + '66',
  },
  clubName: { color: C.text, fontSize: 13, fontWeight: '600' },
  clubVal: { color: C.text, fontSize: 13, fontWeight: '800', fontFamily: F.serif },
  clubValMuted: { color: C.textMuted, fontSize: 13 },

  linkBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '88',
    borderRadius: 8, padding: 14,
  },
  linkLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },
  linkSub: { color: C.textMuted, fontSize: 11, marginTop: 3 },

  benchNote: {
    color: C.textDim, fontSize: 10, fontStyle: 'italic', textAlign: 'center',
    marginTop: 24, paddingHorizontal: 12, lineHeight: 14,
  },
  backBtn: { marginTop: 14, alignSelf: 'center', padding: 10 },
  backLabel: { color: C.gold, fontSize: 14 },
});
