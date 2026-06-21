import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import Svg, {
  Circle, Path, Defs, LinearGradient as SvgLinearGradient, Stop,
} from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, withTiming, withRepeat, withSequence,
  withDelay, interpolate, Easing, cancelAnimation,
} from 'react-native-reanimated';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { distYards, SHOT_COLORS } from '../lib/golfMath';
import { Course3DView } from './Course3DView';
import { HAS_MAPBOX } from '../lib/mapbox';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Local narrower types — ShotMap accepts legacy point arrays and segment
 *  arrays and converts on load, so club + lie are optional here. The
 *  canonical scoring types in lib/scoringTypes.ts are a superset. */
type Pt = { lat: number; lng: number };
type Shot = { start: Pt; end: Pt; club?: string };

/** A shot segment projected from lat/lng into map-view pixel space via
 *  MapView.pointForCoordinate. Recomputed after every region change. */
type PxSeg = { x1: number; y1: number; x2: number; y2: number };

export function ShotMapModal({
  visible,
  matchId,
  userId,
  username,
  holeNum,
  par,
  onClose,
}: {
  visible: boolean;
  matchId?: string | null;
  userId?: string | null;
  username?: string;
  holeNum?: number | null;
  par?: number | null;
  onClose: () => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(false);
  // The shooter's equipped ball-trail cosmetic (visual_data), if any.
  const [trailVisual, setTrailVisual] = useState<any>(null);
  // Opt-in tilted "3D course view" (beta). Persisted so the choice sticks.
  // Default OFF: the classic top-down 2D map is unchanged for everyone who
  // never flips it on. Tilts the satellite camera + arcs the shot trails.
  const [threeD, setThreeD] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem('coc_course_3d').then((v) => { if (v != null) setThreeD(v === '1'); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible || !matchId || !userId || !holeNum) { setShots([]); setTrailVisual(null); return; }
    let cancelled = false;
    setLoading(true);
    api.matches.listShotTracks(matchId, userId)
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.hole_num === holeNum);
        setTrailVisual((row as any)?.trail_visual ?? (rows[0] as any)?.trail_visual ?? null);
        const raw = (row?.shots as any[]) ?? [];
        if (!raw.length) { setShots([]); return; }
        // Detect format and normalise to segment shape.
        if (raw[0]?.start && raw[0]?.end) {
          setShots(raw as Shot[]);
        } else {
          const segs: Shot[] = [];
          for (let i = 0; i < raw.length - 1; i++) {
            segs.push({
              start: { lat: raw[i].lat, lng: raw[i].lng },
              end:   { lat: raw[i + 1].lat, lng: raw[i + 1].lng },
              club:  raw[i]?.club,
            });
          }
          setShots(segs);
        }
      })
      .catch(() => { if (!cancelled) setShots([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, matchId, userId, holeNum]);

  // ── Trail-effect overlay projection ─────────────────────────────────
  // react-native-maps Polyline only does static strokes, so the animated
  // cosmetic trail is drawn in an SVG overlay pinned over the map. After
  // the map settles (onMapReady / onRegionChangeComplete) every shot
  // endpoint is projected to pixel space with pointForCoordinate; during
  // gestures the overlay hides (its pixels would be stale) and the plain
  // map polylines keep the shape visible.
  const mapRef = useRef<MapView>(null);
  const [pxSegs, setPxSegs] = useState<PxSeg[] | null>(null);
  const [mapSize, setMapSize] = useState<{ w: number; h: number } | null>(null);
  const projectGen = useRef(0);

  const projectShots = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !shots.length || (!trailVisual && !threeD)) { setPxSegs(null); return; }
    const gen = ++projectGen.current;
    try {
      const pts = await Promise.all(shots.flatMap((s) => [
        map.pointForCoordinate({ latitude: s.start.lat, longitude: s.start.lng }),
        map.pointForCoordinate({ latitude: s.end.lat, longitude: s.end.lng }),
      ]));
      if (gen !== projectGen.current) return; // a newer projection superseded us
      const segs: PxSeg[] = [];
      for (let i = 0; i < shots.length; i++) {
        segs.push({
          x1: pts[i * 2].x, y1: pts[i * 2].y,
          x2: pts[i * 2 + 1].x, y2: pts[i * 2 + 1].y,
        });
      }
      setPxSegs(segs);
    } catch { /* projection unavailable (map tearing down) — keep overlay hidden */ }
  }, [shots, trailVisual, threeD]);

  // Aim the tilted camera down the hole (tee → pin) so the arc reads as a
  // ball flight rising away from the viewer.
  const holeHeading = useCallback(() => (
    shots.length ? bearing(shots[0].start, shots[shots.length - 1].end) : 0
  ), [shots]);

  const applyCamera = useCallback((tilted: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    map.animateCamera(
      tilted ? { pitch: 56, heading: holeHeading() } : { pitch: 0, heading: 0 },
      { duration: tilted ? 650 : 450 },
    );
  }, [holeHeading]);

  const toggle3D = useCallback(() => {
    setThreeD((prev) => {
      const next = !prev;
      AsyncStorage.setItem('coc_course_3d', next ? '1' : '0').catch(() => {});
      applyCamera(next);
      return next;
    });
  }, [applyCamera]);

  // On first map paint, project the trails and, if 3D is already the saved
  // preference, snap straight into the tilted camera.
  const onMapReady = useCallback(() => {
    projectShots();
    if (threeD) applyCamera(true);
  }, [projectShots, threeD, applyCamera]);

  // Compute initial map region from all shot endpoints
  const region: Region | undefined = shots.length > 0
    ? (() => {
        const allPts = shots.flatMap((s) => [s.start, s.end]);
        const lats = allPts.map((p) => p.lat);
        const lngs = allPts.map((p) => p.lng);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        return {
          latitude: (minLat + maxLat) / 2,
          longitude: (minLng + maxLng) / 2,
          latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.0015),
          longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.0015),
        };
      })()
    : undefined;

  // Shots mapped for the 3D arc renderer, coloured like the 2D markers.
  const shots3d = shots.map((s, i) => ({
    start: s.start,
    end: s.end,
    color: trailVisual?.color ?? SHOT_COLORS[i % SHOT_COLORS.length],
  }));

  // Per-shot distances
  const segments = shots.map((s) => ({
    yards: distYards(s.start.lat, s.start.lng, s.end.lat, s.end.lng),
    club: s.club,
  }));
  const totalYards = segments.reduce((a, b) => a + b.yards, 0);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.container}>
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Hole {holeNum}{par != null ? `  ·  Par ${par}` : ''}</Text>
            {username && <Text style={s.sub}>{username}</Text>}
          </View>
          {shots.length > 0 && (
            <TouchableOpacity
              onPress={toggle3D}
              style={[s.toggle3d, threeD && s.toggle3dOn]}
              accessibilityRole="button"
              accessibilityLabel={threeD ? 'Switch to 2D map view' : 'Switch to 3D course view'}
            >
              <Text style={[s.toggle3dText, threeD && s.toggle3dTextOn]}>{threeD ? '3D' : '2D'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={s.doneBtn}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={s.empty}><ActivityIndicator color={C.gold} size="large" /></View>
        ) : shots.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No shot track</Text>
            <Text style={s.emptySub}>This hole wasn't recorded.</Text>
          </View>
        ) : (
          <>
            <View
              style={s.mapWrap}
              onLayout={(e) => setMapSize({
                w: e.nativeEvent.layout.width,
                h: e.nativeEvent.layout.height,
              })}
            >
              {threeD && HAS_MAPBOX ? (
                <Course3DView shots={shots3d} />
              ) : (
              <>
              <MapView
                ref={mapRef}
                style={{ flex: 1 }}
                initialRegion={region}
                mapType="satellite"
                pitchEnabled={threeD}
                rotateEnabled={threeD}
                onMapReady={onMapReady}
                onRegionChange={() => { if (pxSegs) setPxSegs(null); }}
                onRegionChangeComplete={projectShots}
              >
                {shots.map((shot, i) => {
                  // With a cosmetic trail equipped, the map polyline drops
                  // to a dim neutral underlay: it keeps the shot shape
                  // visible mid-gesture while the overlay paints the color.
                  // In 3D (or with a cosmetic trail) the map polyline drops to
                  // a dim ground-track underlay so the arced overlay is the hero.
                  const dim = trailVisual || threeD;
                  const color = dim
                    ? 'rgba(255,255,255,0.30)'
                    : SHOT_COLORS[i % SHOT_COLORS.length];
                  const markerColor = trailVisual
                    ? (trailVisual.color ?? '#ffe28a')
                    : SHOT_COLORS[i % SHOT_COLORS.length];
                  return (
                    <React.Fragment key={`shot-${i}`}>
                      <Polyline
                        coordinates={[
                          { latitude: shot.start.lat, longitude: shot.start.lng },
                          { latitude: shot.end.lat,   longitude: shot.end.lng },
                        ]}
                        strokeColor={color}
                        strokeWidth={dim ? 2 : 4}
                      />
                      <Marker
                        coordinate={{ latitude: shot.start.lat, longitude: shot.start.lng }}
                        anchor={{ x: 0.5, y: 0.5 }}
                      >
                        <View style={[s.dot, { backgroundColor: markerColor }]}>
                          <Text style={s.dotText}>{i + 1}</Text>
                        </View>
                      </Marker>
                      <Marker
                        coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
                        anchor={{ x: 0.5, y: 0.5 }}
                      >
                        <View style={[s.endDot, { borderColor: markerColor }]} />
                      </Marker>
                    </React.Fragment>
                  );
                })}
              </MapView>
              {/* Pixel-pinned overlay over the map: in 3D, arced ball-flight
                  trails; in 2D with a cosmetic equipped, the cosmetic trail. */}
              {pxSegs && mapSize ? (
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  {threeD ? (
                    <ArcTrailOverlay segs={pxSegs} color={trailVisual?.color ?? '#f0c95a'} w={mapSize.w} h={mapSize.h} />
                  ) : trailVisual ? (
                    <TrailEffectOverlay segs={pxSegs} visual={trailVisual} w={mapSize.w} h={mapSize.h} />
                  ) : null}
                </View>
              ) : null}
              </>
              )}
            </View>

            {/* Distance summary */}
            <View style={s.summary}>
              <View style={s.summaryRow}>
                <Text style={s.summaryLabel}>SHOTS</Text>
                <Text style={s.summaryValue}>{shots.length}</Text>
              </View>
              <View style={s.summaryRow}>
                <Text style={s.summaryLabel}>TOTAL</Text>
                <Text style={s.summaryValue}>{Math.round(totalYards)} yds</Text>
              </View>
            </View>

            {/* Per-shot distances */}
            <View style={s.shotList}>
              {segments.map((seg, i) => (
                <View key={i} style={s.shotRow}>
                  <View style={[s.shotRowDot, {
                    backgroundColor: trailVisual
                      ? (trailVisual.color ?? '#d4a93f')
                      : SHOT_COLORS[i % SHOT_COLORS.length],
                  }]}>
                    <Text style={s.shotRowDotText}>SHOT {i + 1}</Text>
                  </View>
                  {seg.club && <Text style={s.shotRowClub}>{seg.club.toUpperCase()}</Text>}
                  <Text style={s.shotRowYards}>{Math.round(seg.yards)} yds</Text>
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3D (tilted) view — arced ball-flight trails over the pitched satellite map
// ═══════════════════════════════════════════════════════════════════════════

/** Initial great-circle bearing (degrees) a → b, used to aim the tilted camera
 *  down the hole so the arc reads as a ball flight away from the viewer. */
function bearing(a: Pt, b: Pt): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLon = toRad(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Arced shot trails in pixel space over the tilted map: each shot is a
 *  quadratic curve rising above the straight ground track (a ball flight), with
 *  a dot riding start → end on a loop. Reuses the same projected segments the
 *  cosmetic overlay uses, so it stays pinned as the map pitches/pans. */
function ArcTrailOverlay({ segs, color, w, h }: {
  segs: PxSeg[]; color: string; w: number; h: number;
}) {
  return (
    <Svg width={w} height={h}>
      {segs.map((g, i) => <ArcTrail key={i} seg={g} index={i} color={color} />)}
    </Svg>
  );
}

function ArcTrail({ seg, index, color }: { seg: PxSeg; index: number; color: string }) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.max(1, Math.hypot(dx, dy));
  // Apex scales with shot length (longer shots fly higher), clamped.
  const apex = Math.min(130, Math.max(16, len * 0.34));
  const cx = (seg.x1 + seg.x2) / 2;
  const cy = (seg.y1 + seg.y2) / 2 - apex;
  const d = `M ${seg.x1} ${seg.y1} Q ${cx} ${cy} ${seg.x2} ${seg.y2}`;

  const t = useSharedValue(0);
  useEffect(() => {
    t.value = 0;
    t.value = withDelay(
      index * 240,
      withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(t);
  }, [t, index, seg.x1, seg.y1, seg.x2, seg.y2]);

  // Travelling ball position along the quadratic Bézier at t.
  const ballProps = useAnimatedProps(() => {
    const u = t.value, mt = 1 - u;
    return {
      cx: mt * mt * seg.x1 + 2 * mt * u * cx + u * u * seg.x2,
      cy: mt * mt * seg.y1 + 2 * mt * u * cy + u * u * seg.y2,
    };
  });

  return (
    <>
      <Path d={d} stroke={color} strokeWidth={9} strokeOpacity={0.2} strokeLinecap="round" fill="none" />
      <Path d={d} stroke={color} strokeWidth={3.5} strokeLinecap="round" fill="none" />
      <AnimatedCircle cx={seg.x1} cy={seg.y1} r={4} fill="#ffffff" animatedProps={ballProps} />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Cosmetic trail effects — pixel-space SVG over the satellite map
// ═══════════════════════════════════════════════════════════════════════════

/** Deterministic 0..1 noise so the crackle path doesn't re-roll between
 *  projections (which would make the bolt shape jump on every pan). */
function frac(seed: number): number {
  const x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

function TrailEffectOverlay({ segs, visual, w, h }: {
  segs: PxSeg[]; visual: any; w: number; h: number;
}) {
  return (
    <Svg width={w} height={h}>
      {segs.map((g, i) => (
        <SegmentEffect key={i} seg={g} index={i} visual={visual} />
      ))}
    </Svg>
  );
}

/** One shot segment rendered in the equipped trail's style. Each segment
 *  carries at most a couple of animation drivers; a full hole is ~6
 *  segments, well inside the animation budget. */
function SegmentEffect({ seg, index, visual }: { seg: PxSeg; index: number; visual: any }) {
  const styleId: string = visual?.style ?? 'solid';
  const color: string = visual?.color ?? '#74e0ff';
  const accent: string = visual?.accent ?? '#ffffff';
  const width = Math.max(2.5, Number(visual?.width) || 3);
  const glow = visual?.glow !== false;

  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.max(1, Math.hypot(dx, dy));

  // Crackle gets a jagged bolt path; everything else is a straight line.
  const d = useMemo(() => {
    if (styleId !== 'crackle') return `M ${seg.x1} ${seg.y1} L ${seg.x2} ${seg.y2}`;
    const steps = Math.max(4, Math.min(14, Math.round(len / 26)));
    const nx = -dy / len;
    const ny = dx / len;
    let path = `M ${seg.x1} ${seg.y1}`;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const jit = (frac(i * 12.9898 + index * 78.233) - 0.5) * Math.min(14, len * 0.12);
      path += ` L ${seg.x1 + dx * t + nx * jit} ${seg.y1 + dy * t + ny * jit}`;
    }
    return `${path} L ${seg.x2} ${seg.y2}`;
  }, [seg.x1, seg.y1, seg.x2, seg.y2, styleId, index, len, dx, dy]);

  // Particle anchor points along the segment (embers / galaxy stars).
  const particles = useMemo(() => [0.3, 0.55, 0.8].map((t, i) => ({
    x: seg.x1 + dx * t,
    y: seg.y1 + dy * t,
    delay: index * 180 + i * 320,
  })), [seg.x1, seg.y1, dx, dy, index]);

  const runner = useSharedValue(0);
  const flick = useSharedValue(1);
  useEffect(() => {
    runner.value = 0;
    runner.value = withDelay(
      index * 140,
      withRepeat(withTiming(1, { duration: 1700, easing: Easing.linear }), -1, false),
    );
    if (styleId === 'crackle') {
      flick.value = withRepeat(withSequence(
        withTiming(1, { duration: 90 }),
        withTiming(0.45, { duration: 140 }),
        withTiming(0.95, { duration: 70 }),
        withDelay(260, withTiming(0.65, { duration: 0 })),
      ), -1, false);
    } else if (styleId === 'pulse') {
      flick.value = withRepeat(
        withTiming(0.45, { duration: 850, easing: Easing.inOut(Easing.sin) }), -1, true,
      );
    } else {
      flick.value = 1;
    }
    return () => { cancelAnimation(runner); cancelAnimation(flick); };
  }, [styleId, index, runner, flick]);

  const runnerProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(runner.value, [0, 1], [0, -len]),
  }));
  const flickProps = useAnimatedProps(() => ({ strokeOpacity: flick.value }));

  const gradId = `trailgrad-${index}`;
  const gradStops: string[] = styleId === 'rainbow'
    ? ['#ff3b5c', '#ff9a3a', '#ffe23a', '#3aff7a', '#3ac8ff', '#a36bff']
    : [color, accent];
  const usesGradientStroke =
    styleId === 'rainbow' || styleId === 'fire' || styleId === 'galaxy' || styleId === 'gradient';
  const baseStroke = usesGradientStroke ? `url(#${gradId})` : color;
  const showRunner =
    styleId === 'traveling' || styleId === 'rainbow' || styleId === 'galaxy' || styleId === 'fire';

  return (
    <>
      {usesGradientStroke && (
        <Defs>
          <SvgLinearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
          >
            {gradStops.map((c, i) => (
              <Stop key={i} offset={`${(i / (gradStops.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </SvgLinearGradient>
        </Defs>
      )}
      {/* Soft glow underlay — SVG has no shadows, so fake it with a wide
          low-opacity stroke under the core line. */}
      {glow && (
        <Path d={d} stroke={usesGradientStroke ? `url(#${gradId})` : color}
          strokeWidth={width * 2.6} strokeOpacity={0.22} strokeLinecap="round" fill="none" />
      )}
      {/* Core stroke (flickers for crackle, breathes for pulse) */}
      <AnimatedPath
        d={d} stroke={baseStroke} strokeWidth={width}
        strokeLinecap="round" fill="none" animatedProps={flickProps}
      />
      {/* Crackle's hot white core */}
      {styleId === 'crackle' && (
        <Path d={d} stroke={accent} strokeWidth={width * 0.4}
          strokeLinecap="round" fill="none" opacity={0.9} />
      )}
      {/* Traveling highlight racing start → end */}
      {showRunner && (
        <AnimatedPath
          d={`M ${seg.x1} ${seg.y1} L ${seg.x2} ${seg.y2}`}
          stroke="#ffffff" strokeWidth={width * 0.55}
          strokeLinecap="round" fill="none" opacity={0.85}
          strokeDasharray={`${len * 0.16} ${len * 0.84}`}
          animatedProps={runnerProps}
        />
      )}
      {/* Particles: rising embers for fire, twinkling stars for galaxy */}
      {styleId === 'fire' && particles.map((p, i) => (
        <EmberDot key={i} x={p.x} y={p.y} delay={p.delay} color={accent} />
      ))}
      {styleId === 'galaxy' && particles.map((p, i) => (
        <TwinkleDot key={i} x={p.x} y={p.y} delay={p.delay} />
      ))}
    </>
  );
}

function EmberDot({ x, y, delay, color }: { x: number; y: number; delay: number; color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) }), -1, false,
    ));
    return () => cancelAnimation(t);
  }, [t, delay]);
  const props = useAnimatedProps(() => ({
    cy: interpolate(t.value, [0, 1], [y, y - 16]),
    opacity: interpolate(t.value, [0, 0.2, 1], [0, 0.95, 0]),
    r: interpolate(t.value, [0, 1], [2.4, 0.8]),
  }));
  return <AnimatedCircle cx={x} cy={y} r={2.4} fill={color} animatedProps={props} />;
}

function TwinkleDot({ x, y, delay }: { x: number; y: number; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: 1300 }), -1, true));
    return () => cancelAnimation(t);
  }, [t, delay]);
  const props = useAnimatedProps(() => ({
    opacity: interpolate(t.value, [0, 1], [0.3, 1]),
    r: interpolate(t.value, [0, 1], [1.1, 2.1]),
  }));
  return <AnimatedCircle cx={x} cy={y} r={1.5} fill="#ffffff" animatedProps={props} />;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border, gap: 12,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  sub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  toggle3d: { borderWidth: 1, borderColor: C.border, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: C.card },
  toggle3dOn: { borderColor: C.gold, backgroundColor: 'rgba(212,169,63,0.16)' },
  toggle3dText: { color: C.textMuted, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },
  toggle3dTextOn: { color: C.gold },
  doneBtn: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  doneText: { color: '#000', fontWeight: '800', fontSize: 14 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6 },
  emptyTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySub: { color: C.textMuted, fontSize: 13 },

  mapWrap: { flex: 1, minHeight: 280 },

  dot: {
    width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3,
  },
  dotText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  endDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#fff', borderWidth: 3,
  },
  shotRowClub: { color: C.gold, fontWeight: '800', fontSize: 11 },

  summary: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: C.card,
  },
  summaryRow: { alignItems: 'center' },
  summaryLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  summaryValue: { color: C.text, fontSize: 22, fontFamily: F.serif, fontWeight: '700', marginTop: 2 },

  shotList: { paddingHorizontal: 20, paddingVertical: 12, paddingBottom: 28 },
  shotRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 6,
  },
  shotRowDot: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
    minWidth: 50, alignItems: 'center',
  },
  shotRowDotText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  shotRowYards: { color: C.text, fontWeight: '700', fontSize: 14, fontFamily: F.serif },
});
