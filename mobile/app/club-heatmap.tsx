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
              <OrnamentTitle title="Range Pattern" align="center" />
              <Text style={s.subtitle}>Top-down view of where your shots actually land.</Text>
              <RangeHeatmap dispersion={club.dispersion} medianYds={club.median_yds} />

              <Text style={s.legend}>
                <Text style={{ color: '#00ff88', fontWeight: '900' }}>● </Text>
                average ·
                <Text style={{ color: '#fff200', fontWeight: '900' }}> ◯ </Text>
                1σ (~68%) ·
                <Text style={{ color: '#ff2d55', fontWeight: '900' }}>◯ </Text>
                2σ (~95%)
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
 * Driving-range style scatter view, modelled on the FS Golf heatmap.
 * Renders a top-down green range with yardage gridlines, a tee at the
 * bottom, and every shot plotted at its absolute (lateral, distance)
 * position. Each dot is coloured by local 2D Gaussian density so the
 * "sweet spot" of the player's typical landing area pops red, while
 * outliers fade to yellow / green.
 *
 * Pure View-based render — no SVG, no chart lib. Cheap enough for
 * thousands of shots since rendering is O(n) absolutely-positioned
 * Views and density is O(n²) but n is bounded by API page (≤ 5000).
 */
function RangeHeatmap({
  dispersion,
  medianYds,
}: {
  dispersion: { lateral_yds: number; long_yds: number; dist_yds: number }[];
  medianYds: number;
}) {
  // Range surface dimensions. Portrait — longer than wide, like a real range.
  const W = 320;
  const H = 480;
  const PAD_X = 30;          // left/right gutter for lateral labels
  const PAD_TOP = 24;        // top gutter so the longest shots aren't clipped
  const PAD_BOTTOM = 44;     // bottom gutter for tee + lateral axis

  const layout = useMemo(() => {
    if (!dispersion.length) return null;

    // Absolute landing distance per shot (median + delta).
    const points = dispersion.map(d => ({
      lat: d.lateral_yds,
      dist: typeof d.dist_yds === 'number'
        ? d.dist_yds
        : medianYds + (d.long_yds ?? 0),
    }));

    // Choose lateral domain symmetrically so the target line stays centered.
    const absLats = points.map(p => Math.abs(p.lat));
    absLats.sort((a, b) => a - b);
    const latP95 = absLats[Math.floor(absLats.length * 0.95)] ?? 25;
    // Snap up to the next 10 yds and ensure a minimum 25yd width so a single
    // perfect shot doesn't render as a giant dot in a tiny frame.
    const latHalf = Math.max(25, Math.ceil(Math.max(latP95 * 1.4, 20) / 10) * 10);

    // Distance domain: from a clean 50-yd boundary below the shortest shot
    // to a clean 50-yd boundary above the longest shot, with a touch of pad.
    const dists = points.map(p => p.dist);
    const minDist = Math.min(...dists);
    const maxDist = Math.max(...dists);
    const distLo = Math.max(0, Math.floor((minDist - 15) / 50) * 50);
    const distHi = Math.ceil((maxDist + 15) / 50) * 50;
    const distRange = Math.max(50, distHi - distLo);

    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_TOP - PAD_BOTTOM;

    // Pixel mappers
    const xFor = (lat: number) =>
      PAD_X + innerW / 2 + (lat / latHalf) * (innerW / 2);
    const yFor = (dist: number) =>
      PAD_TOP + innerH - ((dist - distLo) / distRange) * innerH;

    // Yardage gridlines: major every 50 yds (labeled), minor every 10 yds
    // (unlabeled, lighter). Walk the domain once and tag each tick by type.
    const arcs: { y: number; major: boolean }[] = [];
    for (let y = distLo; y <= distHi; y += 10) {
      arcs.push({ y, major: y % 50 === 0 });
    }

    // Lateral tick marks (every 10 yds, but only label every 20).
    const lateralTicks: number[] = [];
    for (let l = -latHalf; l <= latHalf; l += 10) lateralTicks.push(l);

    // Full 2D covariance of the player's shots in (lateral, longitudinal)
    // yards. The 1σ / 2σ confidence ellipses are derived from this — using
    // the eigenvectors lets the ovals **tilt** to match real shot bias
    // (e.g. a hooked driver where short shots tend to go left and long
    // shots straight gives a sloped ellipse). Plain axis-aligned ellipses
    // would hide that pattern.
    const N = points.length;
    const meanLat = points.reduce((a, p) => a + p.lat, 0) / N;
    const meanLong = dispersion.reduce((a, d) => a + (d.long_yds ?? 0), 0) / N;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < N; i++) {
      const dx = points[i].lat - meanLat;
      const dy = (dispersion[i].long_yds ?? 0) - meanLong;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
    cxx /= N; cyy /= N; cxy /= N;

    // 2D Gaussian KDE — bandwidth scales with domain so density reads
    // similarly tight regardless of the player's spread.
    const sigmaLat = Math.max(6, latHalf / 4);
    const sigmaDist = Math.max(8, distRange / 8);
    const densities = points.map((p, i) => {
      let sum = 0;
      for (let j = 0; j < points.length; j++) {
        const q = points[j];
        const dx = (p.lat - q.lat) / sigmaLat;
        const dy = (p.dist - q.dist) / sigmaDist;
        sum += Math.exp(-(dx * dx + dy * dy) / 2);
      }
      return sum;
    });
    const dMin = Math.min(...densities);
    const dMax = Math.max(...densities);
    const dRange = Math.max(1e-6, dMax - dMin);

    return {
      points,
      densities,
      dMin,
      dRange,
      arcs,
      lateralTicks,
      latHalf,
      distLo,
      distHi,
      xFor,
      yFor,
      cxx, cyy, cxy,
      meanLong,
    };
  }, [dispersion, medianYds]);

  if (!layout) return null;

  const {
    points, densities, dMin, dRange,
    arcs, lateralTicks, latHalf,
    xFor, yFor,
    cxx, cyy, cxy, meanLong,
  } = layout;

  return (
    <View style={{ alignItems: 'center', marginVertical: 18 }}>
      <View style={s.range}>
        {/* Sky→fairway vertical gradient, faked with three stacked layers. */}
        {/* Pitch-black gradient — six bands stepping from pure black at the
            top to a very dark cool grey near the tee. Reads like a HUD /
            radar surface so neon accents pop. */}
        <View style={[s.rangeBand, { top: '0%',  height: '17%', backgroundColor: '#000000' }]} />
        <View style={[s.rangeBand, { top: '17%', height: '17%', backgroundColor: '#050608' }]} />
        <View style={[s.rangeBand, { top: '34%', height: '16%', backgroundColor: '#0a0c10' }]} />
        <View style={[s.rangeBand, { top: '50%', height: '17%', backgroundColor: '#10141a' }]} />
        <View style={[s.rangeBand, { top: '67%', height: '17%', backgroundColor: '#161b22' }]} />
        <View style={[s.rangeBand, { top: '84%', height: '16%', backgroundColor: '#1c222b' }]} />

        {/* Soft top vignette to anchor the panel against the screen above. */}
        <View
          style={{
            position: 'absolute',
            left: 0, right: 0, top: 0, height: 28,
            backgroundColor: 'rgba(255,255,255,0.03)',
          }}
        />

        {/* Yardage gridlines: major (every 50) thicker + labeled, minor
            (every 10) slim and faded. Modern: hairline rules, monospaced
            numerics, consistent right-aligned label rail. */}
        {arcs.map(({ y, major }) => {
          const py = yFor(y);
          return (
            <React.Fragment key={`arc-${y}`}>
              <View
                style={{
                  position: 'absolute',
                  left:  major ? PAD_X      : PAD_X + 8,
                  right: major ? PAD_X      : PAD_X + 8,
                  top: py,
                  height: major ? 1 : StyleSheet.hairlineWidth,
                  backgroundColor: major
                    ? 'rgba(255,255,255,0.20)'
                    : 'rgba(255,255,255,0.07)',
                }}
              />
              {major && (
                <Text
                  style={{
                    position: 'absolute',
                    right: 4, top: py - 7,
                    color: 'rgba(255,255,255,0.65)',
                    fontSize: 10, fontWeight: '600', letterSpacing: 0.5,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {y}
                </Text>
              )}
            </React.Fragment>
          );
        })}

        {/* Center target line — finer dashes, slight glow. */}
        {Array.from({ length: 32 }).map((_, i) => (
          <View
            key={`tgt-${i}`}
            style={{
              position: 'absolute',
              left: W / 2 - 0.5,
              top: PAD_TOP + i * ((H - PAD_TOP - PAD_BOTTOM) / 32),
              width: 1, height: 4,
              backgroundColor: 'rgba(255,255,255,0.18)',
            }}
          />
        ))}

        {/* Tilted covariance ellipses — derived from the eigenvectors of
            the screen-space covariance matrix so the ovals lean in the
            actual direction the shots tend to fall. A hooked driver where
            longer shots drift right yields a positively-tilted ellipse;
            a swing where every miss is short-and-left yields a negative
            tilt. Neon borders, transparent fill, glow shadows. */}
        {(() => {
          // Pixel-per-yard scales (linear mappers, so global = local slope).
          const pxPerYdLat = (xFor(latHalf) - xFor(0)) / latHalf;
          const pxPerYdDist = (yFor(layout.distLo) - yFor(layout.distHi))
            / (layout.distHi - layout.distLo);

          // Transform data-space covariance → screen-space covariance.
          // Note: screen Y axis points down while distance points up, so the
          // off-diagonal flips sign. (This sign flip mirrors visual tilt
          // correctly; without it, a pull-fade would render as a push-fade.)
          const sxx = pxPerYdLat * pxPerYdLat * cxx;
          const syy = pxPerYdDist * pxPerYdDist * cyy;
          const sxy = -pxPerYdLat * pxPerYdDist * cxy;

          // Eigen-decomposition of a 2×2 symmetric matrix. λ₁ ≥ λ₂ ≥ 0.
          const trace = sxx + syy;
          const det   = sxx * syy - sxy * sxy;
          const disc  = Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
          const lambda1 = trace / 2 + disc;          // larger eigenvalue
          const lambda2 = Math.max(1e-6, trace / 2 - disc);

          // Rotation of the major axis (radians). atan2 gives the right
          // quadrant automatically.
          const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
          const angleDeg = theta * 180 / Math.PI;

          const cx = xFor(0);
          const cy = yFor(medianYds + meanLong);

          // 2σ outer first so it sits beneath 1σ. Neon outline, soft glow.
          const rings = [
            {
              mult: 2,
              border: '#ff2d55',                     // neon red
              fill:   'rgba(255,45,85,0.05)',
              bw: 1,
              glow: '#ff2d55',
              glowOpacity: 0.55,
              glowRadius: 10,
            },
            {
              mult: 1,
              border: '#fff200',                     // neon yellow
              fill:   'rgba(255,242,0,0.07)',
              bw: 1.5,
              glow: '#fff200',
              glowOpacity: 0.7,
              glowRadius: 8,
            },
          ];

          return rings.map(({ mult, border, fill, bw, glow, glowOpacity, glowRadius }) => {
            const semiMajor = mult * Math.sqrt(lambda1);
            const semiMinor = mult * Math.sqrt(lambda2);
            const w = 2 * semiMajor;
            const h = 2 * semiMinor;
            return (
              <View
                key={`sigma-${mult}`}
                style={{
                  position: 'absolute',
                  left: cx - w / 2,
                  top:  cy - h / 2,
                  width: w,
                  height: h,
                  borderRadius: 9999,
                  borderWidth: bw,
                  borderColor: border,
                  backgroundColor: fill,
                  // Rotation is around the View's centre, so the ellipse
                  // re-orients without translating off the mean.
                  transform: [{ rotate: `${angleDeg}deg` }],
                  shadowColor: glow,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: glowOpacity,
                  shadowRadius: glowRadius,
                }}
              />
            );
          });
        })()}

        {/* Shots — small filled dots, soft outline, subtle shadow. The
            outline reads as a halo on the green; combined with the heat
            colour this gives the modern "plotted on radar" look. */}
        {points.map((p, i) => {
          const t = (densities[i] - dMin) / dRange;     // 0..1
          const fill = densityColor(t);
          const size = 8;
          return (
            <View
              key={`shot-${i}`}
              style={{
                position: 'absolute',
                left: xFor(p.lat) - size / 2,
                top: yFor(p.dist) - size / 2,
                width: size, height: size, borderRadius: size / 2,
                backgroundColor: fill,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: 'rgba(255,255,255,0.55)',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.5, shadowRadius: 2,
              }}
            />
          );
        })}

        {/* Median marker — neon green dot at the actual mean landing point.
            Two concentric layers: a faint halo for glow, a bright core on
            top. Stays above every other layer so the "expected" shot is
            always visible. */}
        {medianYds >= layout.distLo && medianYds <= layout.distHi && (
          <>
            <View
              style={{
                position: 'absolute',
                left: xFor(0) - 14,
                top: yFor(medianYds + meanLong) - 14,
                width: 28, height: 28, borderRadius: 14,
                backgroundColor: 'rgba(0,255,140,0.14)',
              }}
            />
            <View
              style={{
                position: 'absolute',
                left: xFor(0) - 6,
                top: yFor(medianYds + meanLong) - 6,
                width: 12, height: 12, borderRadius: 6,
                backgroundColor: '#00ff88',
                borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.95)',
                shadowColor: '#00ff88',
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 1,
                shadowRadius: 8,
              }}
            />
          </>
        )}

        {/* Tee — slim bar with a thin highlight line above it. Reads more
            like a HUD marker than a chunky rectangle. */}
        <View
          style={{
            position: 'absolute',
            left: W / 2 - 18,
            bottom: PAD_BOTTOM - 14,
            width: 36, height: 3,
            borderRadius: 2,
            backgroundColor: 'rgba(255,255,255,0.85)',
          }}
        />
        <View
          style={{
            position: 'absolute',
            left: W / 2 - 1,
            bottom: PAD_BOTTOM - 11,
            width: 2, height: 8,
            borderRadius: 1,
            backgroundColor: 'rgba(255,255,255,0.6)',
          }}
        />
        <Text
          style={{
            position: 'absolute',
            left: 0, right: 0, bottom: PAD_BOTTOM - 30,
            textAlign: 'center',
            color: 'rgba(255,255,255,0.55)',
            fontSize: 9, fontWeight: '700', letterSpacing: 2,
          }}
        >
          TEE
        </Text>

        {/* Lateral axis labels along the bottom inside the green. */}
        {lateralTicks.map((l) => {
          const tx = xFor(l);
          const isMajor = l % 20 === 0;
          return (
            <React.Fragment key={`lat-${l}`}>
              <View
                style={{
                  position: 'absolute',
                  left: tx - 0.5,
                  bottom: PAD_BOTTOM - 4,
                  width: 1, height: isMajor ? 6 : 3,
                  backgroundColor: 'rgba(255,255,255,0.35)',
                }}
              />
              {isMajor && (
                <Text
                  style={{
                    position: 'absolute',
                    left: tx - 16, width: 32,
                    bottom: PAD_BOTTOM - 18,
                    textAlign: 'center',
                    color: 'rgba(255,255,255,0.55)',
                    fontSize: 9, fontWeight: '700',
                  }}
                >
                  {l === 0 ? '0' : l > 0 ? `+${l}R` : `${-l}L`}
                </Text>
              )}
            </React.Fragment>
          );
        })}
      </View>

      {/* Caption under the range surface. */}
      <Text style={{ color: C.textMuted, fontSize: 10, marginTop: 8 }}>
        Lateral spread ±{latHalf} yds · {dispersion.length} shots plotted
      </Text>
    </View>
  );
}

/** Map a normalised density value (0..1) to a cool→hot neon shot colour:
 *  isolated  shots = cool cyan
 *  grouped   shots = neon magenta / pink
 *  sweet-spot shots = white-hot
 *  Picked to sit OFF the green/yellow/red ring palette so the dots and
 *  rings stay visually distinct against the black HUD surface. */
function densityColor(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k < 0.5) {
    // cyan (0,212,255) → magenta (255,45,200)
    const m = k / 0.5;
    const r = Math.round(0   + m * (255 - 0));
    const g = Math.round(212 + m * (45 - 212));
    const b = Math.round(255 + m * (200 - 255));
    return `rgb(${r},${g},${b})`;
  }
  // magenta (255,45,200) → near-white-hot (255,230,255)
  const m = (k - 0.5) / 0.5;
  const r = 255;
  const g = Math.round(45  + m * (230 - 45));
  const b = Math.round(200 + m * (255 - 200));
  return `rgb(${r},${g},${b})`;
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

  // Range surface — radar/HUD aesthetic. Pitch-black gradient inside, soft
  // hairline inner border for a glass rim, and a deep drop shadow so the
  // panel floats above the surrounding app chrome.
  range: {
    width: 320,
    height: 480,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#000000',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.6,
    shadowRadius: 18,
    elevation: 10,
    position: 'relative',
  },
  // Stacked horizontal bands fake a vertical gradient (sky-ish at the top,
  // saturated grass at the bottom) without pulling in a gradient lib.
  rangeBand: {
    position: 'absolute',
    left: 0, right: 0,
  },
});
