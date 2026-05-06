import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, router } from 'expo-router';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';

/**
 * Per-club dispersion view. For each club the user has tagged on at least
 * 2 shots, we render:
 *   • Sample size + median yardage
 *   • A square grid heatmap of (lateral, longitudinal) deltas relative to
 *     the user's median shot for that club. Origin = "perfect average shot."
 *
 * No rendering library required — we just compute a coarse 2D histogram and
 * draw it with absolutely-positioned Views. Keeps the bundle small.
 */
export default function ClubHeatmapScreen() {
  const { user } = useAuth();
  const [data, setData] = useState<{
    clubs: {
      club: string; shots: number; avg_yds: number; median_yds: number;
      dispersion: { lateral_yds: number; long_yds: number; dist_yds: number }[];
    }[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api.users.clubStats(user.user_id)
      .then(d => {
        setData(d);
        if (d.clubs.length) setSelected(d.clubs[0].club);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, [user?.user_id]);

  if (!user) return null;

  const club = data?.clubs.find(c => c.club === selected) ?? null;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Club Heatmap', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      {loading ? (
        <View style={{ paddingTop: 80, alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} size="large" />
        </View>
      ) : !data?.clubs.length ? (
        <View style={s.emptyBox}>
          <Text style={s.emptyTitle}>No tagged shots yet</Text>
          <Text style={s.emptyBody}>
            Track shots during a round and tap the <Text style={{ color: C.gold, fontWeight: '900' }}>CLUB</Text> chip
            on the map to tag each one. Once you have a few shots per club,
            their dispersion patterns appear here.
          </Text>
        </View>
      ) : (
        <>
          <OrnamentTitle title="Club" align="center" />
          <Text style={s.subtitle}>Tap a club to see its dispersion vs. your average</Text>

          {/* Club picker tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabRow}>
            {data.clubs.map(c => {
              const active = c.club === selected;
              return (
                <TouchableOpacity
                  key={c.club}
                  onPress={() => setSelected(c.club)}
                  style={[s.tab, active && s.tabActive]}
                  activeOpacity={0.7}
                >
                  <Text style={[s.tabLabel, active && { color: C.bg }]}>{c.club.toUpperCase()}</Text>
                  <Text style={[s.tabSub, active && { color: C.bg + 'cc' }]}>{c.shots} shot{c.shots === 1 ? '' : 's'}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {club && (
            <>
              {/* Summary */}
              <View style={s.summaryRow}>
                <SumCell label="MEDIAN" value={`${club.median_yds} yds`} />
                <SumCell label="AVG"    value={`${club.avg_yds} yds`} />
                <SumCell label="SHOTS"  value={`${club.shots}`} />
              </View>

              {/* Dispersion heatmap */}
              <OrnamentTitle title="Miss Pattern" align="center" />
              <Text style={s.subtitle}>Lateral / Long-Short relative to your average. Center = your typical shot.</Text>
              <Heatmap dispersion={club.dispersion} />

              <Text style={s.legend}>
                Hotter cells = more shots landed there.
                {'\n'}Left/right = lateral miss. Up = long, down = short.
              </Text>
            </>
          )}

          <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
            <Text style={s.backLabel}>← Back</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

/**
 * 2D histogram heatmap. Bins shot deltas into a 7×7 grid, color-codes each
 * cell by count. Origin (3,3) = the user's median shot.
 */
function Heatmap({ dispersion }: { dispersion: { lateral_yds: number; long_yds: number }[] }) {
  const SIZE = 7;          // grid cells per side (odd → has a center cell)
  const HALF = (SIZE - 1) / 2;
  const CELL = 36;         // px per cell

  const grid = useMemo(() => {
    if (!dispersion.length) return null;
    // Bin width chosen from the 90th-percentile of |miss| so most points fit.
    const lats  = dispersion.map(d => Math.abs(d.lateral_yds));
    const longs = dispersion.map(d => Math.abs(d.long_yds));
    const sorted = [...lats, ...longs].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 10;
    const binYds = Math.max(5, Math.ceil(p90 / HALF));

    const counts: number[][] = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    for (const d of dispersion) {
      const cx = Math.max(0, Math.min(SIZE - 1, HALF + Math.round(d.lateral_yds / binYds)));
      // y axis: long miss should appear "up". In screen coords, up = lower y.
      const cy = Math.max(0, Math.min(SIZE - 1, HALF - Math.round(d.long_yds / binYds)));
      counts[cy][cx] += 1;
    }
    let max = 0;
    for (const row of counts) for (const v of row) if (v > max) max = v;
    return { counts, max, binYds };
  }, [dispersion]);

  if (!grid) return null;

  return (
    <View style={{ alignItems: 'center', marginVertical: 20 }}>
      <View style={{ width: SIZE * CELL, height: SIZE * CELL, position: 'relative' }}>
        {grid.counts.map((row, y) =>
          row.map((count, x) => {
            const intensity = grid.max > 0 ? count / grid.max : 0;
            return (
              <View
                key={`${x}-${y}`}
                style={{
                  position: 'absolute',
                  left: x * CELL, top: y * CELL,
                  width: CELL, height: CELL,
                  backgroundColor: count === 0
                    ? C.card
                    : `rgba(212, 175, 55, ${0.15 + intensity * 0.85})`, // gold with intensity
                  borderWidth: 0.5, borderColor: C.border,
                  justifyContent: 'center', alignItems: 'center',
                }}
              >
                {count > 0 && (
                  <Text style={{
                    color: intensity > 0.6 ? C.bg : C.text,
                    fontSize: 10, fontWeight: '900',
                  }}>
                    {count}
                  </Text>
                )}
              </View>
            );
          })
        )}
        {/* Center crosshair = the user's median shot */}
        <View style={{
          position: 'absolute',
          left: HALF * CELL, top: 0, width: 1, height: SIZE * CELL,
          backgroundColor: C.gold + '55',
        }} />
        <View style={{
          position: 'absolute',
          left: 0, top: HALF * CELL, width: SIZE * CELL, height: 1,
          backgroundColor: C.gold + '55',
        }} />
      </View>
      <Text style={{ color: C.textMuted, fontSize: 10, marginTop: 8 }}>
        Each cell ≈ {grid.binYds} yards
      </Text>
    </View>
  );
}

function SumCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.sumCell}>
      <Text style={s.sumLabel}>{label}</Text>
      <Text style={s.sumVal}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingBottom: 60 },
  subtitle: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6 },
  legend: { color: C.textMuted, fontSize: 11, textAlign: 'center', marginTop: 4, lineHeight: 16 },

  emptyBox: {
    backgroundColor: C.card, borderRadius: 10, padding: 24, marginTop: 40,
    borderWidth: 1, borderColor: C.border, alignItems: 'center',
  },
  emptyTitle: { color: C.gold, fontFamily: F.serif, fontSize: 20, fontWeight: '900', marginBottom: 10 },
  emptyBody: { color: C.text, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  tabRow: { paddingVertical: 12, gap: 6 },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  tabActive: { backgroundColor: C.gold, borderColor: C.gold },
  tabLabel: { color: C.text, fontWeight: '900', fontSize: 12, letterSpacing: 0.6 },
  tabSub: { color: C.textMuted, fontSize: 10, marginTop: 2 },

  summaryRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 16 },
  sumCell: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    backgroundColor: C.card, borderRadius: 6, borderWidth: 1, borderColor: C.border,
  },
  sumLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  sumVal: { color: C.text, fontFamily: F.serif, fontSize: 18, fontWeight: '900', marginTop: 4 },

  backBtn: { marginTop: 24, alignSelf: 'center', padding: 10 },
  backLabel: { color: C.gold, fontSize: 14 },
});
