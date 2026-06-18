/**
 * Shared VFX primitive library.
 *
 * One place for the particle systems the celebration overlay + match intro both
 * use, so the juice lives in a single, perf-audited file. Built on the SAME
 * stack and idioms as Cosmetics.tsx (reanimated worklets + react-native-svg),
 * so it ships over the air via `eas update` with no native rebuild.
 *
 * HARD RULES baked in here (do not "simplify" them away):
 *   - SVG TRANSFORMS (rotate/translate/scale) are driven with useAnimatedStyle
 *     on an Animated.View that WRAPS the <Svg>. react-native-svg 15.12 does NOT
 *     reliably animate `transform` fed through useAnimatedProps, so animatedProps
 *     is used ONLY for scalar attributes the lib animates natively: cx, cy, r,
 *     strokeWidth, strokeOpacity, opacity, and the path `d` string.
 *   - The JS PRNG / clock are called ONLY in plain JS or useMemo at mount, never
 *     inside a worklet. Particle layouts are frozen at mount and read by index.
 *   - Every driver cancelAnimation()s on cleanup. Counts hard-clamp to VFX_CAPS.
 *   - Gradient ids are unique via a module counter, NOT React.useId() (its colons
 *     break url(#id) resolution in react-native-svg).
 *   - Glow is faked with layered low-opacity shapes + iOS shadow (no Skia blur).
 *
 * Exports: hooks (useOneShot, useLoopValue), path helpers (starPath, sparkPath),
 * and the primitives ScreenFlash, ShockwaveRing, ParticleBurst, Confetti,
 * RadialRays, SparkleField, GlowPulse, ImpactText.
 */

import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import Svg, { Circle, Path, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps,
  withTiming, withRepeat, withDelay, withSequence,
  interpolate, Easing, cancelAnimation, runOnJS, Extrapolation,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { C } from '../lib/colors';

// ─── Animated SVG primitives (created once, at module level) ─────────────────
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath   = Animated.createAnimatedComponent(Path);

/** Per-primitive particle ceilings. Every system clamps to these so a caller
 *  can never accidentally schedule a thousand nodes. */
export const VFX_CAPS = { confetti: 60, burst: 40, rays: 24, sparkle: 28, rings: 4 } as const;

const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IO  = Easing.inOut(Easing.quad);
const EASE_SIN = Easing.inOut(Easing.sin);

// Unique, colon-free gradient ids. React.useId() injects ':' which produces an
// invalid url(#:r3:) reference that react-native-svg silently fails to paint.
let _gidSeq = 0;
function useGradientId(prefix: string): string {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => `${prefix}${_gidSeq++}`, [prefix]);
}

// ─── Path helpers (worklet-safe: only Math + string ops) ─────────────────────

/** 5-point star outline centred at (cx,cy), outer radius r. Shared with the
 *  backgrounds (FlagBg-style waving stars). */
export function starPath(cx: number, cy: number, r: number): string {
  'worklet';
  let d = '';
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.42;
    d += `${i === 0 ? 'M' : 'L'}${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)} `;
  }
  return d + 'Z ';
}

/** 4-point sparkle/glint (sharper inner ratio than a star) centred at (cx,cy). */
export function sparkPath(cx: number, cy: number, r: number): string {
  'worklet';
  const inner = r * 0.26;
  let d = '';
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI / 4) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : inner;
    d += `${i === 0 ? 'M' : 'L'}${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)} `;
  }
  return d + 'Z';
}

/** Thin diamond of half-length r oriented along `ang`, centred at (x,y). Used
 *  for the albatross "crystal shard" burst. */
function shardPath(x: number, y: number, r: number, ang: number): string {
  'worklet';
  const c = Math.cos(ang), s = Math.sin(ang);
  const lx = c * r,        ly = s * r;          // tip along the travel axis
  const sx = -s * r * 0.32, sy = c * r * 0.32;  // perpendicular half-width
  return `M${(x + lx).toFixed(2)} ${(y + ly).toFixed(2)} `
       + `L${(x + sx).toFixed(2)} ${(y + sy).toFixed(2)} `
       + `L${(x - lx).toFixed(2)} ${(y - ly).toFixed(2)} `
       + `L${(x - sx).toFixed(2)} ${(y - sy).toFixed(2)} Z`;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** A 0→1 ramp that re-fires whenever `replayKey` changes (so back-to-back
 *  events replay). The completion callback is gated on `finished` so a cancel
 *  on unmount never invokes onDone. */
export function useOneShot(
  active: boolean,
  durationMs: number,
  opts?: { delay?: number; easing?: ReturnType<typeof Easing.inOut>; replayKey?: unknown; onDone?: () => void },
): SharedValue<number> {
  const t = useSharedValue(0);
  const delay = opts?.delay ?? 0;
  const easing = opts?.easing ?? EASE_OUT;
  const onDone = opts?.onDone;
  useEffect(() => {
    if (!active) { t.value = 0; return; }
    t.value = 0;
    t.value = withDelay(delay, withTiming(1, { duration: durationMs, easing }, (finished) => {
      'worklet';
      if (finished && onDone) runOnJS(onDone)();
    }));
    return () => cancelAnimation(t);
    // replayKey is intentionally a dep so a fresh event re-fires; easing/onDone
    // are intentionally NOT (they are stable per usage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, durationMs, delay, opts?.replayKey]);
  return t;
}

/** A looping 0→1 driver (ping-pong by default so it never hard-snaps). */
export function useLoopValue(
  durationMs: number,
  opts?: { yoyo?: boolean; delay?: number; easing?: ReturnType<typeof Easing.inOut>; active?: boolean },
): SharedValue<number> {
  const t = useSharedValue(0);
  const yoyo = opts?.yoyo ?? true;
  const delay = opts?.delay ?? 0;
  const easing = opts?.easing ?? Easing.linear;
  const active = opts?.active ?? true;
  useEffect(() => {
    if (!active) { cancelAnimation(t); t.value = 0; return; }
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: durationMs, easing }), -1, yoyo));
    return () => cancelAnimation(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, yoyo, delay, active]);
  return t;
}

// ─── Gradient-stop helper type ───────────────────────────────────────────────
export type GradStop = { offset: number | string; color: string; opacity?: number };

// ═══════════════════════════════════════════════════════════════════════════
// 1. ScreenFlash — full-bleed colour stab that fades
// ═══════════════════════════════════════════════════════════════════════════
export function ScreenFlash({
  active, color = C.goldLight, peak = 0.5, durationMs = 420, replayKey, style,
}: {
  active: boolean; color?: string; peak?: number; durationMs?: number;
  replayKey?: unknown; style?: StyleProp<ViewStyle>;
}) {
  const cappedPeak = Math.min(0.7, peak);
  const t = useOneShot(active, durationMs, { replayKey, easing: EASE_OUT });
  const aStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.12, 1], [0, cappedPeak, 0], Extrapolation.CLAMP),
  }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color }, style, aStyle]} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. ShockwaveRing — expanding stroked ring(s)
// ═══════════════════════════════════════════════════════════════════════════
export function ShockwaveRing({
  active, color = C.goldLight, size, thickness = 4, maxR, durationMs = 700, rings = 1, delay = 0, replayKey,
}: {
  active: boolean; color?: string; size: number; thickness?: number; maxR?: number;
  durationMs?: number; rings?: number; delay?: number; replayKey?: unknown;
}) {
  const n = Math.min(VFX_CAPS.rings, Math.max(1, rings));
  const maxRadius = maxR ?? size * 0.48;
  return (
    <Svg pointerEvents="none" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {Array.from({ length: n }).map((_, i) => (
        <RingNode key={i} active={active} color={color} cx={size / 2} cy={size / 2}
          thickness={thickness} maxR={maxRadius} durationMs={durationMs} delay={delay + i * 120} replayKey={replayKey} />
      ))}
    </Svg>
  );
}
function RingNode({ active, color, cx, cy, thickness, maxR, durationMs, delay, replayKey }: {
  active: boolean; color: string; cx: number; cy: number; thickness: number;
  maxR: number; durationMs: number; delay: number; replayKey?: unknown;
}) {
  const t = useOneShot(active, durationMs, { delay, replayKey, easing: EASE_OUT });
  const props = useAnimatedProps(() => ({
    r: interpolate(t.value, [0, 1], [maxR * 0.04, maxR]),
    strokeWidth: interpolate(t.value, [0, 1], [thickness, 0.3]),
    strokeOpacity: interpolate(t.value, [0, 0.1, 1], [0, 0.9, 0], Extrapolation.CLAMP),
  }));
  return <AnimatedCircle cx={cx} cy={cy} r={0} fill="none" stroke={color} animatedProps={props} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. ParticleBurst — radial explosion of SVG dots (or shards)
//    One shared timeline; each particle reads it + its frozen seed. Replaces
//    the old emoji-glyph burst.
// ═══════════════════════════════════════════════════════════════════════════
type BurstSeed = { ang: number; dist: number; pr: number; lag: number; fill: string };

export function ParticleBurst({
  active, count = 24, color = C.goldLight, color2 = C.text, size, radius,
  particleR = 3, durationMs = 900, gravity = 0, shape = 'dot', delay = 0, replayKey,
}: {
  active: boolean; count?: number; color?: string; color2?: string; size: number;
  radius?: number; particleR?: number; durationMs?: number; gravity?: number;
  shape?: 'dot' | 'shard'; delay?: number; replayKey?: unknown;
}) {
  const n = Math.min(VFX_CAPS.burst, count);
  const R = radius ?? size * 0.46;
  const cx = size / 2, cy = size / 2;
  const seeds = useMemo<BurstSeed[]>(() => Array.from({ length: n }, (_, i) => ({
    ang: (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4,
    dist: R * (0.7 + Math.random() * 0.3),
    pr: particleR * (0.6 + Math.random() * 0.7),
    lag: Math.random() * 0.18,
    fill: i % 2 === 0 ? color : color2,
  })), [n, R, particleR, color, color2]);
  const t = useOneShot(active, durationMs, { delay, replayKey, easing: Easing.linear });
  return (
    <Svg pointerEvents="none" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {seeds.map((s, i) => (
        shape === 'shard'
          ? <BurstShard key={i} t={t} cx={cx} cy={cy} seed={s} gravity={gravity} />
          : <BurstDot   key={i} t={t} cx={cx} cy={cy} seed={s} gravity={gravity} />
      ))}
    </Svg>
  );
}
function BurstDot({ t, cx, cy, seed, gravity }: { t: SharedValue<number>; cx: number; cy: number; seed: BurstSeed; gravity: number }) {
  const dx = Math.cos(seed.ang), dy = Math.sin(seed.ang);
  const props = useAnimatedProps(() => {
    const p = interpolate(t.value, [seed.lag, 1], [0, 1], Extrapolation.CLAMP);
    const e = 1 - (1 - p) * (1 - p);
    return {
      cx: cx + dx * seed.dist * e,
      cy: cy + dy * seed.dist * e + gravity * p * p,
      r: interpolate(p, [0, 0.2, 1], [0, seed.pr, seed.pr * 0.3], Extrapolation.CLAMP),
      opacity: interpolate(p, [0, 0.15, 0.8, 1], [0, 1, 0.85, 0], Extrapolation.CLAMP),
    };
  });
  return <AnimatedCircle cx={cx} cy={cy} r={0} fill={seed.fill} animatedProps={props} />;
}
function BurstShard({ t, cx, cy, seed, gravity }: { t: SharedValue<number>; cx: number; cy: number; seed: BurstSeed; gravity: number }) {
  const dx = Math.cos(seed.ang), dy = Math.sin(seed.ang);
  const props = useAnimatedProps(() => {
    const p = interpolate(t.value, [seed.lag, 1], [0, 1], Extrapolation.CLAMP);
    const e = 1 - (1 - p) * (1 - p);
    const x = cx + dx * seed.dist * e;
    const y = cy + dy * seed.dist * e + gravity * p * p;
    return {
      d: shardPath(x, y, seed.pr * 1.6, seed.ang),
      opacity: interpolate(p, [0, 0.15, 0.8, 1], [0, 1, 0.85, 0], Extrapolation.CLAMP),
    };
  });
  return <AnimatedPath fill={seed.fill} d="" animatedProps={props as any} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Confetti — falling ribbons (absolute Animated.Views, one-shot)
//    Views animate transform on the UI thread natively (the codebase's
//    Petal/Snowflake pattern), avoiding the svg-transform pitfall.
// ═══════════════════════════════════════════════════════════════════════════
type Ribbon = { vx: number; vy: number; w: number; h: number; color: string; spin: number; lag: number; sway: number; swayFreq: number };

export function Confetti({
  active, count = 40, colors, size, origin = { x: 0.5, y: 0.45 },
  spread = 70, gravity, durationMs = 2200, replayKey,
}: {
  active: boolean; count?: number; colors?: string[]; size: number;
  origin?: { x: number; y: number }; spread?: number; gravity?: number;
  durationMs?: number; replayKey?: unknown;
}) {
  const palette = colors ?? [C.goldLight, C.gold, C.text, C.green];
  const n = Math.min(VFX_CAPS.confetti, count);
  const g = gravity ?? size * 0.9;
  const ox = origin.x * size, oy = origin.y * size;
  const seeds = useMemo<Ribbon[]>(() => {
    const spreadRad = (spread * Math.PI) / 180;
    return Array.from({ length: n }, (_, i) => {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * spreadRad;
      const speed = size * (0.5 + Math.random() * 0.5);
      return {
        vx: Math.cos(ang) * speed + (Math.random() - 0.5) * size * 0.2,
        vy: Math.sin(ang) * speed,
        w: 5 + Math.random() * 5,
        h: 8 + Math.random() * 7,
        color: palette[i % palette.length],
        spin: (Math.random() - 0.5) * 1080,
        lag: Math.random() * 0.12,
        sway: 6 + Math.random() * 10,
        swayFreq: 2 + Math.random() * 2,
      };
    });
  }, [n, size, spread]); // palette intentionally excluded (stable per usage)
  const t = useOneShot(active, durationMs, { replayKey, easing: Easing.linear });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {seeds.map((s, i) => <RibbonView key={i} t={t} ox={ox} oy={oy} g={g} seed={s} />)}
    </View>
  );
}
function RibbonView({ t, ox, oy, g, seed }: { t: SharedValue<number>; ox: number; oy: number; g: number; seed: Ribbon }) {
  const aStyle = useAnimatedStyle(() => {
    const p = interpolate(t.value, [seed.lag, 1], [0, 1], Extrapolation.CLAMP);
    const x = ox + seed.vx * p + Math.sin(p * seed.swayFreq * Math.PI * 2) * seed.sway;
    const y = oy + seed.vy * p + 0.5 * g * p * p;
    return {
      transform: [
        { translateX: x }, { translateY: y },
        { rotate: `${seed.spin * p}deg` },
        { scaleX: Math.cos(p * seed.swayFreq * Math.PI * 2) }, // edge-on flutter
      ],
      opacity: interpolate(p, [0, 0.08, 0.85, 1], [0, 1, 1, 0], Extrapolation.CLAMP),
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', left: -seed.w / 2, top: -seed.h / 2, width: seed.w, height: seed.h, backgroundColor: seed.color, borderRadius: 1 },
      aStyle,
    ]} />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. RadialRays — rotating god-ray fan (one animated node: the wrapping View)
// ═══════════════════════════════════════════════════════════════════════════
export function RadialRays({
  count = 12, color = C.gold, size, innerR, outerR, spinMs = 14000,
  pulseMs = 3000, opacity = 0.22, active = true, gradientStops, reverse = false,
}: {
  count?: number; color?: string; size: number; innerR?: number; outerR?: number;
  spinMs?: number; pulseMs?: number; opacity?: number; active?: boolean;
  gradientStops?: GradStop[]; reverse?: boolean;
}) {
  const n = Math.min(VFX_CAPS.rays, count);
  const iR = innerR ?? size * 0.12;
  const oR = outerR ?? size * 0.6;
  const cx = size / 2, cy = size / 2;
  const gid = useGradientId('vfxRays');
  const wedges = useMemo(() => {
    const arr: string[] = [];
    const half = (Math.PI / n) * 0.42;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const a1 = a - half, a2 = a + half;
      const x1 = cx + Math.cos(a1) * iR, y1 = cy + Math.sin(a1) * iR;
      const x2 = cx + Math.cos(a1) * oR, y2 = cy + Math.sin(a1) * oR;
      const x3 = cx + Math.cos(a2) * oR, y3 = cy + Math.sin(a2) * oR;
      const x4 = cx + Math.cos(a2) * iR, y4 = cy + Math.sin(a2) * iR;
      arr.push(`M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${x3.toFixed(1)} ${y3.toFixed(1)} L${x4.toFixed(1)} ${y4.toFixed(1)} Z`);
    }
    return arr;
  }, [n, cx, cy, iR, oR]);
  const spin = useLoopValue(spinMs, { yoyo: false, easing: Easing.linear, active });
  const pulse = useLoopValue(pulseMs, { yoyo: true, easing: EASE_SIN, active });
  const aStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [opacity * 0.55, opacity]),
    transform: [{ rotate: `${interpolate(spin.value, [0, 1], reverse ? [360, 0] : [0, 360])}deg` }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ width: size, height: size }, aStyle]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {gradientStops ? (
          <Defs>
            <RadialGradient id={gid} cx={cx} cy={cy} r={oR} gradientUnits="userSpaceOnUse">
              {gradientStops.map((st, i) => (
                <Stop key={i} offset={st.offset} stopColor={st.color} stopOpacity={st.opacity ?? 1} />
              ))}
            </RadialGradient>
          </Defs>
        ) : null}
        {wedges.map((d, i) => <Path key={i} d={d} fill={gradientStops ? `url(#${gid})` : color} />)}
      </Svg>
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SparkleField — ambient 4-point twinkle (one driver, frozen phases)
//    Replaces the old STORM_POSITIONS emoji glyphs.
// ═══════════════════════════════════════════════════════════════════════════
type SparkSeed = { cx: number; cy: number; r: number; phase: number };

export function SparkleField({
  count = 18, color = C.goldLight, durationMs = 2000, active = true,
}: {
  count?: number; color?: string; durationMs?: number; active?: boolean;
}) {
  const n = Math.min(VFX_CAPS.sparkle, count);
  const sparks = useMemo<SparkSeed[]>(() => Array.from({ length: n }, () => ({
    cx: Math.random() * 100, cy: Math.random() * 100,
    r: 1.2 + Math.random() * 1.8,
    phase: Math.random(),
  })), [n]);
  const t = useLoopValue(durationMs, { yoyo: false, easing: Easing.linear, active });
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
      {sparks.map((s, i) => <Spark key={i} t={t} spark={s} color={color} />)}
    </Svg>
  );
}
function Spark({ t, spark, color }: { t: SharedValue<number>; spark: SparkSeed; color: string }) {
  const props = useAnimatedProps(() => {
    const tp = (t.value + spark.phase) % 1;
    const tw = Math.sin(tp * Math.PI); // 0 → 1 → 0 across the loop
    return {
      d: sparkPath(spark.cx, spark.cy, spark.r * (0.5 + tw * 0.8)),
      opacity: 0.12 + tw * 0.88,
    };
  });
  return <AnimatedPath fill={color} d="" animatedProps={props as any} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. GlowPulse — fake-bloom halo behind a focal point
// ═══════════════════════════════════════════════════════════════════════════
export function GlowPulse({
  color = C.goldLight, size, periodMs = 1800, maxOpacity = 0.35, active = true,
}: {
  color?: string; size: number; periodMs?: number; maxOpacity?: number; active?: boolean;
}) {
  const gid = useGradientId('vfxGlow');
  const cx = size / 2, cy = size / 2;
  const t = useLoopValue(periodMs, { yoyo: true, easing: EASE_SIN, active });
  const props = useAnimatedProps(() => ({
    r: interpolate(t.value, [0, 1], [size * 0.28, size * 0.42]),
    opacity: interpolate(t.value, [0, 1], [maxOpacity * 0.5, maxOpacity]),
  }));
  return (
    <Svg pointerEvents="none" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Defs>
        <RadialGradient id={gid} cx={cx} cy={cy} r={size * 0.42} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={color} stopOpacity="0.9" />
          <Stop offset="0.5" stopColor={color} stopOpacity="0.4" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <AnimatedCircle cx={cx} cy={cy} r={size * 0.35} fill={`url(#${gid})`} animatedProps={props} />
    </Svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. ImpactText — spring-scale label punch (one overshoot, one settle)
// ═══════════════════════════════════════════════════════════════════════════
export function ImpactText({
  active, delay = 0, replayKey, children, style,
}: {
  active: boolean; delay?: number; replayKey?: unknown;
  children?: React.ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    if (!active) { t.value = 0; return; }
    t.value = 0;
    t.value = withDelay(delay, withSequence(
      withTiming(1.12, { duration: 260, easing: EASE_OUT }),
      withTiming(1, { duration: 160, easing: EASE_IO }),
    ));
    return () => cancelAnimation(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, delay, replayKey]);
  const aStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.5], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: t.value }],
  }));
  return <Animated.View pointerEvents="none" style={[aStyle, style]}>{children}</Animated.View>;
}
