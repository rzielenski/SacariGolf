/**
 * Cosmetic renderers — premium-quality visual effects for paid cosmetics.
 *
 * Built on four native libraries (all require a fresh `eas build` to ship
 * the first time; later cosmetic additions only need OTA):
 *
 *   • expo-linear-gradient        — real GPU-accelerated gradients
 *   • react-native-svg            — paths, circles, masks, stroke-dasharray
 *   • react-native-reanimated     — 60fps UI-thread animations via worklets
 *   • @react-native-masked-view   — for real gradient-filled text
 *
 * Components exported:
 *
 *   <CosmeticBackground visual={…} style={…}>             full-bleed bg
 *   <CosmeticBorder visual={…} size={…}>{avatar}</…>      ring around avatar
 *   <CosmeticUsername visual={…}>name</…>                 colored / gradient text
 *   <CosmeticTrailPreview visual={…} />                   small trail swatch
 *
 * visual_data styles supported per kind (each implemented as its own
 * sub-component so logic stays focused):
 *
 *   background:  gradient | flag | storm | aurora | stars | flame | holographic |
 *                cyber | solar | ocean | sakura | liquid | synthwave | eclipse |
 *                matrix | dusk | thunder
 *   border:      glow | pulse | holographic | traveling | flame | plasma | frost |
 *                tesla | eclipse
 *   username:    solid | gradient | shimmer | holographic | neon | glitch
 *   ball_trail:  solid | gradient | crackle | galaxy | traveling | fire | rainbow
 *
 * Performance notes:
 *   • All looped animations use Reanimated worklets running on the UI thread,
 *     so JS-thread stalls (image decode, network, etc.) can't drop frames.
 *   • SVG nodes are static where possible — animated stroke-dasharray /
 *     fill-opacity is driven by useAnimatedProps so reanimated updates the
 *     prop directly without going through the JS bridge.
 *   • Star fields / petal systems memoise their random positions on mount
 *     (useMemo) so re-renders don't re-roll the layout.
 *   • shadowOpacity/shadowRadius are used for glows since blur isn't
 *     supported by react-native-svg without Skia.
 */

import React, { useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, ViewStyle, StyleProp, TextStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle, Path, Line, G, Defs, Rect,
  LinearGradient as SvgLinearGradient, Stop, RadialGradient, Mask, ClipPath, Use,
} from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps, useDerivedValue,
  withTiming, withRepeat, withSequence, withDelay,
  interpolate, Easing, cancelAnimation,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import MaskedView from '@react-native-masked-view/masked-view';
import { C } from '../lib/colors';

// ─── Types ───────────────────────────────────────────────────────────────────

type VisualData = Record<string, any> | null | undefined;

// ─── Animated SVG primitives (must be created once, at module level) ─────────

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath   = Animated.createAnimatedComponent(Path);
const AnimatedG      = Animated.createAnimatedComponent(G);
const AnimatedRect   = Animated.createAnimatedComponent(Rect);
const AnimatedStop   = Animated.createAnimatedComponent(Stop);
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

// ─── Shared timing constants ─────────────────────────────────────────────────

const TIMING = {
  pulse:        1400,
  shimmer:      2200,
  holographic:  4000,
  aurora:       8000,
  flame:        900,
  star:         2000,
  storm:        2500,
  traveling:    2400,
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND
// ═══════════════════════════════════════════════════════════════════════════

export function CosmeticBackground({
  visual, style, children,
}: {
  visual: VisualData;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const v = visual ?? {};
  const styleId = v.style as string | undefined;

  switch (styleId) {
    case 'gradient':    return <GradientBg     v={v} style={style}>{children}</GradientBg>;
    case 'flag':        return <FlagBg         v={v} style={style}>{children}</FlagBg>;
    case 'storm':
    case 'pulse':       return <StormBg        v={v} style={style}>{children}</StormBg>;
    case 'aurora':      return <AuroraBg       v={v} style={style}>{children}</AuroraBg>;
    case 'stars':
    case 'cosmic':      return <StarsBg        v={v} style={style}>{children}</StarsBg>;
    case 'flame':
    case 'fire':        return <FlameBg        v={v} style={style}>{children}</FlameBg>;
    case 'holographic': return <HolographicBg  v={v} style={style}>{children}</HolographicBg>;
    case 'cyber':       return <CyberBg        v={v} style={style}>{children}</CyberBg>;
    case 'solar':       return <SolarBg        v={v} style={style}>{children}</SolarBg>;
    case 'ocean':       return <OceanBg        v={v} style={style}>{children}</OceanBg>;
    case 'sakura':      return <SakuraBg       v={v} style={style}>{children}</SakuraBg>;
    case 'liquid':      return <LiquidGoldBg   v={v} style={style}>{children}</LiquidGoldBg>;
    case 'synthwave':   return <SynthwaveBg    v={v} style={style}>{children}</SynthwaveBg>;
    case 'eclipse':     return <EclipseBg      v={v} style={style}>{children}</EclipseBg>;
    case 'matrix':      return <MatrixBg       v={v} style={style}>{children}</MatrixBg>;
    case 'dusk':        return <DuskLinksBg    v={v} style={style}>{children}</DuskLinksBg>;
    case 'thunder':     return <ThunderBg      v={v} style={style}>{children}</ThunderBg>;
    default:
      return (
        <View style={[{ backgroundColor: v.from ?? C.bg }, style]}>
          {children}
        </View>
      );
  }
}

// ── 1. Gradient ─────────────────────────────────────────────────────────────

function GradientBg({ v, style, children }: BgProps) {
  const colors = [v.from ?? '#000', v.to ?? '#222'] as const as readonly [string, string, ...string[]];
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {v.accent ? (
        <LinearGradient
          colors={['transparent', v.accent, 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.18 }]}
        />
      ) : null}
      {children}
    </View>
  );
}

// ── 2. Flag (Stars & Stripes, waving in the wind) ───────────────────────────

// Flag geometry, in a 300×200 viewBox (vector, scales cleanly).
const FLAG_VB_W = 300;
const FLAG_VB_H = 200;
const FLAG_STRIPE_H = FLAG_VB_H / 13;
const FLAG_CANTON_W = FLAG_VB_W * 0.4;     // hoist = 40% of the fly
const FLAG_CANTON_H = FLAG_STRIPE_H * 7;   // canton is 7 stripes tall

/** Lighten (amt>0) / darken (amt<0) a #hex colour. */
function shade(hex: string, amt: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** SVG path for a 5-point star centred at (cx,cy), outer radius r. Worklet-safe
 *  so it can be rebuilt per-frame inside the waving star group. */
function starPath(cx: number, cy: number, r: number): string {
  'worklet';
  let d = '';
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.42;
    d += `${i === 0 ? 'M' : 'L'}${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)} `;
  }
  return d + 'Z ';
}

// 50-star canton layout (viewBox coords): 9 rows alternating 6 / 5 stars.
const FLAG_STAR_R = 4.4;
const FLAG_STAR_POS: { cx: number; cy: number }[] = (() => {
  const pts: { cx: number; cy: number }[] = [];
  const padX = 13, padY = 9;
  const colGap = (FLAG_CANTON_W - 2 * padX) / 5;
  const usableH = FLAG_CANTON_H - 2 * padY;
  for (let row = 0; row < 9; row++) {
    const six = row % 2 === 0;
    const count = six ? 6 : 5;
    const cy = padY + (usableH * row) / 8;
    for (let c = 0; c < count; c++) {
      pts.push({ cx: six ? padX + c * colGap : padX + colGap / 2 + c * colGap, cy });
    }
  }
  return pts;
})();

/** Shared travelling cloth wave — the SAME offset drives the stripes AND the
 *  canton, so the whole flag moves as one sheet. Amplitude grows toward the fly. */
function flagWaveOffset(x: number, t: number): number {
  'worklet';
  const fx = x / FLAG_VB_W;
  const amp = (0.25 + 0.75 * fx) * 17;
  return amp * (0.72 * Math.sin(fx * Math.PI * 2 * 1.3 - t) + 0.28 * Math.sin(fx * Math.PI * 2 * 2.7 - t * 1.7));
}

/**
 * Stars & Stripes, drawn as art that genuinely waves. Stripes, canton and stars
 * all live in ONE SVG and ride the SAME travelling wave (flagWaveOffset), so the
 * whole flag moves as a single sheet of cloth — the blue canton curves and bobs
 * with the stripes instead of sitting on top as a flat panel. Each stripe is
 * gradient-filled for a rounded, lit ridge; soft light/shadow fold bands drift
 * across on top for 3-D depth.
 */
function FlagBg({ v, style, children }: BgProps) {
  const stripes: string[] = v.stripes ?? [];
  const RED = v.red ?? stripes[0] ?? '#b22234';
  const WHITE = v.white ?? stripes[1] ?? '#ffffff';
  const CANTON = v.canton ?? '#3c3b6e';

  const wave = useSharedValue(0);
  const foldA = useSharedValue(0);
  const foldB = useSharedValue(0);
  useEffect(() => {
    wave.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.linear }), -1, false);
    foldA.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
    foldB.value = withRepeat(withTiming(1, { duration: 3300, easing: Easing.linear }), -1, false);
    return () => { [wave, foldA, foldB].forEach(cancelAnimation); };
  }, [wave, foldA, foldB]);

  // Soft fold light/shadow bands drift across (+ vertical bob) for 3-D depth.
  const shadow1 = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(foldA.value, [0, 1], [-320, 340]) },
      { translateY: interpolate(foldA.value, [0, 0.5, 1], [-10, 10, -10]) },
    ],
  }));
  const shadow2 = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(foldB.value, [0, 1], [-320, 340]) },
      { translateY: interpolate(foldB.value, [0, 0.5, 1], [9, -9, 9]) },
    ],
  }));
  const sheen = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(foldB.value, [0, 1], [340, -320]) },
      { translateY: interpolate(foldB.value, [0, 0.5, 1], [-7, 7, -7]) },
    ],
  }));

  return (
    <View style={[{ overflow: 'hidden', backgroundColor: shade(RED, -0.3) }, style]}>
      {/* One SVG: stripes + canton + stars all share flagWaveOffset */}
      <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${FLAG_VB_W} ${FLAG_VB_H}`} preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="flagRed" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={shade(RED, -0.26)} />
            <Stop offset="0.5" stopColor={RED} />
            <Stop offset="1" stopColor={shade(RED, -0.4)} />
          </SvgLinearGradient>
          <SvgLinearGradient id="flagWhite" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={shade(WHITE, -0.14)} />
            <Stop offset="0.5" stopColor={WHITE} />
            <Stop offset="1" stopColor={shade(WHITE, -0.22)} />
          </SvgLinearGradient>
          <SvgLinearGradient id="flagBlue" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={shade(CANTON, 0.12)} />
            <Stop offset="0.55" stopColor={CANTON} />
            <Stop offset="1" stopColor={shade(CANTON, -0.24)} />
          </SvgLinearGradient>
        </Defs>
        {Array.from({ length: 13 }).map((_, i) => (
          <FlagWaveStripe key={i} index={i} fill={i % 2 === 0 ? 'url(#flagRed)' : 'url(#flagWhite)'} wave={wave} />
        ))}
        {/* Canton, riding the same wave as the stripes underneath it */}
        <FlagCanton wave={wave} fill="url(#flagBlue)" />
        {/* Stars bob with the canton's local wave so they stay attached to it */}
        <FlagStars wave={wave} />
      </Svg>

      {/* Drifting fold shadows + a highlight for 3-D cloth depth */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, shadow1]}>
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.10)', 'rgba(0,0,0,0.34)', 'rgba(0,0,0,0.10)', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ width: '34%', height: '100%' }}
        />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, shadow2]}>
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.08)', 'rgba(0,0,0,0.24)', 'rgba(0,0,0,0.08)', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ width: '30%', height: '100%' }}
        />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, sheen]}>
        <LinearGradient
          colors={['transparent', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.26)', 'rgba(255,255,255,0.06)', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ width: '26%', height: '100%' }}
        />
      </Animated.View>

      {/* Vignette so the flag doesn't fight foreground text */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.14)' }]} />
      {children}
    </View>
  );
}

/** One stripe as a vector band whose top + bottom edges ride the shared wave,
 *  so all 13 ripple together as one sheet. */
function FlagWaveStripe({ index, fill, wave }: { index: number; fill: string; wave: SharedValue<number> }) {
  const animatedProps = useAnimatedProps(() => {
    const overscan = 24;
    const top = index === 0 ? -overscan : index * FLAG_STRIPE_H;
    const bot = index === 12 ? FLAG_VB_H + overscan : (index + 1) * FLAG_STRIPE_H;
    const steps = 28;
    const t = wave.value * Math.PI * 2;
    let d = '';
    for (let s = 0; s <= steps; s++) {
      const x = (s / steps) * FLAG_VB_W;
      d += `${s === 0 ? 'M' : 'L'}${x.toFixed(1)} ${(top + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    for (let s = steps; s >= 0; s--) {
      const x = (s / steps) * FLAG_VB_W;
      d += `L${x.toFixed(1)} ${(bot + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    return { d: d + 'Z' };
  });
  return <AnimatedPath animatedProps={animatedProps} fill={fill} />;
}

/** The blue canton as a band of the same waving sheet — its edges use
 *  flagWaveOffset (sampled on the SAME x-grid as the stripes), so it curves and
 *  bobs exactly like them. The bottom dips slightly past the 7-stripe line so a
 *  waving stripe can never poke up through the blue. */
function FlagCanton({ wave, fill }: { wave: SharedValue<number>; fill: string }) {
  const animatedProps = useAnimatedProps(() => {
    const overscan = 24;
    const x0 = -overscan, x1 = FLAG_CANTON_W;
    const top = -overscan, bot = FLAG_CANTON_H + 3; // overlap hides any seam
    const steps = 30;
    const t = wave.value * Math.PI * 2;
    let d = '';
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (s / steps) * (x1 - x0);
      d += `${s === 0 ? 'M' : 'L'}${x.toFixed(1)} ${(top + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    for (let s = steps; s >= 0; s--) {
      const x = x0 + (s / steps) * (x1 - x0);
      d += `L${x.toFixed(1)} ${(bot + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    return { d: d + 'Z' };
  });
  return <AnimatedPath animatedProps={animatedProps} fill={fill} />;
}

/** The 50 stars as one path, each star displaced by the wave at its OWN x, so
 *  the grid curves with the cloth (the blue field visibly ripples) instead of
 *  bobbing as a flat block. */
function FlagStars({ wave }: { wave: SharedValue<number> }) {
  const animatedProps = useAnimatedProps(() => {
    const t = wave.value * Math.PI * 2;
    let d = '';
    for (let i = 0; i < FLAG_STAR_POS.length; i++) {
      const s = FLAG_STAR_POS[i];
      d += starPath(s.cx, s.cy + flagWaveOffset(s.cx, t), FLAG_STAR_R);
    }
    return { d } as any;
  });
  return <AnimatedPath animatedProps={animatedProps} fill="#ffffff" />;
}

// ── 3. Storm (lightning + flashes) ──────────────────────────────────────────

function StormBg({ v, style, children }: BgProps) {
  const flash = useSharedValue(0);
  const bolt1 = useSharedValue(0);
  const bolt2 = useSharedValue(0);

  useEffect(() => {
    // Strobe-pattern flashes — two quick pulses with a small lull, then a
    // longer dark stretch before the next strike. Mimics real lightning.
    const strike = () => withSequence(
      withDelay(1500 + Math.random() * 2500, withTiming(1, { duration: 70 })),
      withTiming(0.3, { duration: 110 }),
      withTiming(0.9, { duration: 60 }),
      withTiming(0, { duration: 240 }),
    );
    flash.value = withRepeat(strike(), -1, false);
    bolt1.value = withRepeat(
      withSequence(
        withDelay(2000 + Math.random() * 3000, withTiming(1, { duration: 60 })),
        withTiming(0, { duration: 280 }),
      ), -1, false);
    bolt2.value = withRepeat(
      withSequence(
        withDelay(4000 + Math.random() * 3000, withTiming(1, { duration: 80 })),
        withTiming(0, { duration: 240 }),
      ), -1, false);
    return () => { cancelAnimation(flash); cancelAnimation(bolt1); cancelAnimation(bolt2); };
  }, [flash, bolt1, bolt2]);

  const flashStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flash.value, [0, 1], [0, 0.55]),
  }));
  const boltAProps = useAnimatedProps(() => ({ opacity: bolt1.value }));
  const boltBProps = useAnimatedProps(() => ({ opacity: bolt2.value }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a0f1c', v.to ?? '#26304a']}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Lightning bolts — two paths positioned in different regions */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 200">
        <AnimatedPath
          d="M30 0 L25 60 L35 70 L20 130 L32 140 L18 200"
          stroke="#cad9ff" strokeWidth="1.2" fill="none"
          animatedProps={boltAProps}
        />
        <AnimatedPath
          d="M72 10 L68 50 L78 58 L65 110 L75 120 L62 180"
          stroke="#e4ecff" strokeWidth="1.4" fill="none"
          animatedProps={boltBProps}
        />
      </Svg>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, flashStyle, { backgroundColor: v.flash ?? '#cad9ff' }]} />
      {children}
    </View>
  );
}

// ── 4. Aurora (drifting bands) ──────────────────────────────────────────────

function AuroraBg({ v, style, children }: BgProps) {
  const layers: string[] = v.layers ?? ['#00ff9d', '#7fa2ff', '#c779ff'];
  const drift = useSharedValue(0);

  useEffect(() => {
    drift.value = withRepeat(withTiming(1, { duration: TIMING.aurora, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(drift);
  }, [drift]);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#04161e', '#0a2a3a']}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {layers.map((c, i) => <AuroraBand key={i} color={c} index={i} drift={drift} />)}
      {children}
    </View>
  );
}

function AuroraBand({ color, index, drift }: { color: string; index: number; drift: SharedValue<number> }) {
  const animStyle = useAnimatedStyle(() => {
    const phase = index * 0.33;
    const t = (drift.value + phase) % 1;
    return {
      transform: [
        { translateX: interpolate(t, [0, 1], [-40, 40]) },
        { translateY: interpolate(t, [0, 0.5, 1], [0, -20, 0]) },
        { scaleX:     interpolate(t, [0, 0.5, 1], [1, 1.4, 1]) },
      ],
      opacity: interpolate(t, [0, 0.5, 1], [0.25, 0.5, 0.25]),
    };
  });

  return (
    <Animated.View pointerEvents="none" style={[
      {
        position: 'absolute',
        left: -40, right: -40,
        top: `${15 + index * 22}%`,
        height: '40%',
        borderRadius: 999,
      },
      animStyle,
    ]}>
      <LinearGradient
        colors={['transparent', color, 'transparent'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={[StyleSheet.absoluteFill, { borderRadius: 999 }]}
      />
    </Animated.View>
  );
}

// ── 5. Cosmic (twinkling stars + nebula) ────────────────────────────────────

function StarsBg({ v, style, children }: BgProps) {
  const starCount = Math.min(120, v.stars ?? 80);
  // Memoise positions so re-renders don't reshuffle the field.
  const stars = useMemo(() => Array.from({ length: starCount }, () => ({
    cx: Math.random() * 100,
    cy: Math.random() * 100,
    r: Math.random() * 1.4 + 0.3,
    delay: Math.random() * 2000,
    duration: TIMING.star + Math.random() * 1200,
  })), [starCount]);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#040515', v.to ?? '#1a0a3a']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Nebula glow — two soft colored circles to break up the flat gradient */}
      <View pointerEvents="none" style={{
        position: 'absolute', top: '20%', left: '15%',
        width: 220, height: 220, borderRadius: 110,
        backgroundColor: '#7a3ab5', opacity: 0.18,
      }} />
      <View pointerEvents="none" style={{
        position: 'absolute', bottom: '15%', right: '10%',
        width: 180, height: 180, borderRadius: 90,
        backgroundColor: '#3a6bb5', opacity: 0.20,
      }} />
      {/* Star field — SVG so all stars can be one render */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {stars.map((s, i) => <TwinklingStar key={i} {...s} />)}
      </Svg>
      {children}
    </View>
  );
}

function TwinklingStar({ cx, cy, r, delay, duration }: { cx: number; cy: number; r: number; delay: number; duration: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration }), -1, true));
    return () => cancelAnimation(t);
  }, [t, delay, duration]);
  const animatedProps = useAnimatedProps(() => ({
    opacity: interpolate(t.value, [0, 1], [0.25, 1]),
    r: interpolate(t.value, [0, 1], [r * 0.6, r * 1.2]),
  }));
  return <AnimatedCircle cx={cx} cy={cy} r={r} fill="#ffffff" animatedProps={animatedProps} />;
}

// ── 6. Flame / Fire (rising wisps) ──────────────────────────────────────────

function FlameBg({ v, style, children }: BgProps) {
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#1a0807', v.to ?? '#5e1a14']}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Bottom ember glow */}
      <LinearGradient
        colors={['transparent', v.accent ?? '#ffb14a'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
      />
      {/* Rising flame wisps */}
      {Array.from({ length: 6 }).map((_, i) => (
        <RisingWisp key={i} index={i} accent={v.accent ?? '#ffb14a'} />
      ))}
      {children}
    </View>
  );
}

function RisingWisp({ index, accent }: { index: number; accent: string }) {
  const t = useSharedValue(0);
  const left = useMemo(() => `${10 + (index * 13) + Math.random() * 6}%`, [index]);
  const size = useMemo(() => 24 + Math.random() * 22, []);
  const dur = 1800 + Math.random() * 1400;

  useEffect(() => {
    t.value = withDelay(index * 250, withRepeat(withTiming(1, { duration: dur, easing: Easing.out(Easing.cubic) }), -1, false));
    return () => cancelAnimation(t);
  }, [t, index, dur]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [60, -180]) },
      { scale:      interpolate(t.value, [0, 0.4, 1], [0.3, 1, 0.6]) },
    ],
    opacity: interpolate(t.value, [0, 0.15, 0.8, 1], [0, 0.85, 0.5, 0]),
  }));

  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', bottom: 0, left: left as any, width: size, height: size, borderRadius: size / 2 },
      style,
    ]}>
      <LinearGradient
        colors={[accent, 'transparent'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
      />
    </Animated.View>
  );
}

// ── 7. Holographic (rainbow shimmer) ────────────────────────────────────────

function HolographicBg({ v, style, children }: BgProps) {
  const colors = (v.colors ?? ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a', '#ff6b9d']) as readonly [string, string, ...string[]];
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: TIMING.holographic }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);

  // Animate the gradient origin so the rainbow shifts.
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(t.value, [0, 1], [-30, 30]) },
      { translateY: interpolate(t.value, [0, 1], [-15, 15]) },
    ],
  }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a0a14' }]} />
      <Animated.View style={[StyleSheet.absoluteFill, animStyle]}>
        <LinearGradient
          colors={colors}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.55 }]}
        />
        <LinearGradient
          colors={[...colors].reverse() as unknown as readonly [string, string, ...string[]]}
          start={{ x: 1, y: 0 }} end={{ x: 0, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.4 }]}
        />
      </Animated.View>
      {children}
    </View>
  );
}

// ── 8. Cyber (grid + scan line) ─────────────────────────────────────────────

function CyberBg({ v, style, children }: BgProps) {
  const scan = useSharedValue(0);
  useEffect(() => {
    scan.value = withRepeat(withTiming(1, { duration: 3000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(scan);
  }, [scan]);
  const scanStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(scan.value, [0, 1], [0, 400]) }],
  }));

  const accent = v.accent ?? '#00ffd5';
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#02060e', v.to ?? '#0a1e2e'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* Vertical grid lines */}
        {Array.from({ length: 10 }).map((_, i) => (
          <Line key={`v${i}`} x1={i * 10} y1={0} x2={i * 10} y2={100} stroke={accent} strokeOpacity="0.18" strokeWidth="0.2" />
        ))}
        {/* Horizontal grid lines, with perspective (closer-together near the bottom) */}
        {Array.from({ length: 8 }).map((_, i) => (
          <Line key={`h${i}`} x1={0} y1={50 + (i * i) * 0.8} x2={100} y2={50 + (i * i) * 0.8} stroke={accent} strokeOpacity="0.22" strokeWidth="0.2" />
        ))}
      </Svg>
      <Animated.View pointerEvents="none" style={[
        { position: 'absolute', left: 0, right: 0, height: 60, top: -60 },
        scanStyle,
      ]}>
        <LinearGradient
          colors={['transparent', accent + '40', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {children}
    </View>
  );
}

// ── 9. Solar (radial sun + rotating rays) ───────────────────────────────────

function SolarBg({ v, style, children }: BgProps) {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(1, { duration: 20000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rot);
  }, [rot]);
  const rotStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }],
  }));
  const accent = v.accent ?? '#ffb14a';
  const core   = v.core   ?? '#fff3a8';

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#2a0d05', v.to ?? '#0a0204'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Solar core — static gradient sphere */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
        <Defs>
          {/* userSpaceOnUse: coords are viewBox units. The default
              objectBoundingBox mode treats these numbers as multiples
              of the bounding box and washes the gradient out. */}
          <RadialGradient id="solarCore" cx="0" cy="0" r="35" fx="0" fy="0" gradientUnits="userSpaceOnUse">
            <Stop offset="0%" stopColor={core} stopOpacity="0.95" />
            <Stop offset="40%" stopColor={accent} stopOpacity="0.55" />
            <Stop offset="100%" stopColor={accent} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={0} cy={0} r={50} fill="url(#solarCore)" />
      </Svg>
      {/* Rotating ray layer — SVG G doesn't accept a `style` prop, so
          rotate by wrapping the entire Svg in an Animated.View instead. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, rotStyle]}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 18 }).map((_, i) => {
            const ang = (i * (360 / 18)) * (Math.PI / 180);
            const x1 = Math.cos(ang) * 14;
            const y1 = Math.sin(ang) * 14;
            const x2 = Math.cos(ang) * 50;
            const y2 = Math.sin(ang) * 50;
            return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent} strokeOpacity="0.35" strokeWidth="0.7" />;
          })}
        </Svg>
      </Animated.View>
      {children}
    </View>
  );
}

// ── 10. Ocean (rolling waves) ────────────────────────────────────────────────

function OceanBg({ v, style, children }: BgProps) {
  const w1 = useSharedValue(0);
  const w2 = useSharedValue(0);
  useEffect(() => {
    w1.value = withRepeat(withTiming(1, { duration: 6000, easing: Easing.linear }), -1, false);
    w2.value = withRepeat(withTiming(1, { duration: 9000, easing: Easing.linear }), -1, false);
    return () => { cancelAnimation(w1); cancelAnimation(w2); };
  }, [w1, w2]);

  const wave1Style = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(w1.value, [0, 1], [-200, 200]) }],
  }));
  const wave2Style = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(w2.value, [0, 1], [200, -200]) }],
  }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a1e3a', v.to ?? '#072a48'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: '30%', left: -300, right: -300, height: 60 }, wave1Style]}>
        <Svg viewBox="0 0 600 60" width="100%" height="60" preserveAspectRatio="none">
          <Path d="M0 30 Q150 0 300 30 T 600 30 V 60 H 0 Z" fill={v.accent ?? '#3d8bbf'} opacity="0.45" />
        </Svg>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: '15%', left: -300, right: -300, height: 80 }, wave2Style]}>
        <Svg viewBox="0 0 600 80" width="100%" height="80" preserveAspectRatio="none">
          <Path d="M0 40 Q150 10 300 40 T 600 40 V 80 H 0 Z" fill={v.accent ?? '#5aacd9'} opacity="0.55" />
        </Svg>
      </Animated.View>
      {children}
    </View>
  );
}

// ── 11. Sakura (falling petals) ─────────────────────────────────────────────

function SakuraBg({ v, style, children }: BgProps) {
  const petals = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
    left:  `${(i * 7.3 + Math.random() * 6) % 100}%`,
    delay: Math.random() * 4000,
    dur:   4500 + Math.random() * 3500,
    size:  6 + Math.random() * 6,
    drift: (Math.random() - 0.5) * 60,
  })), []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#3a1a2a', v.to ?? '#7a3a55'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {petals.map((p, i) => <Petal key={i} {...p} />)}
      {children}
    </View>
  );
}

function Petal({ left, delay, dur, size, drift }: { left: any; delay: number; dur: number; size: number; drift: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay, dur]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [-30, 600]) },
      { translateX: interpolate(t.value, [0, 0.5, 1], [0, drift, drift * 2]) },
      { rotate: `${interpolate(t.value, [0, 1], [0, 540])}deg` },
    ],
    opacity: interpolate(t.value, [0, 0.1, 0.9, 1], [0, 1, 1, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', top: 0, left, width: size, height: size, backgroundColor: '#ffc4d1', borderRadius: size / 2, borderTopLeftRadius: 1 },
      animStyle,
    ]} />
  );
}

// ── 12. Liquid Gold (shifting molten gradient) ──────────────────────────────

function LiquidGoldBg({ v, style, children }: BgProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 6000, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [0, 40]) }],
  }));
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={['#1a1410', '#3a2a14'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={[StyleSheet.absoluteFill, animStyle]}>
        <LinearGradient
          colors={['transparent', '#d4a93f', '#ffe28a', '#d4a93f', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.7 }]}
        />
      </Animated.View>
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.4)'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.5 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

// ── 13. Synthwave (retro sun + perspective grid) ────────────────────────────

function SynthwaveBg({ v, style, children }: BgProps) {
  const scan = useSharedValue(0);
  const glow = useSharedValue(0);
  useEffect(() => {
    scan.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.linear }), -1, false);
    glow.value = withRepeat(withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(scan); cancelAnimation(glow); };
  }, [scan, glow]);
  const scanStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(scan.value, [0, 1], [0, 320]) }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.55, 0.95]),
  }));
  const pink = v.accent ?? '#ff2d95';
  const grid = v.grid ?? '#ff2d95';

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={['#16042e', '#3d0a55', '#a3155e'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Banded retro sun, dropped behind the grid horizon */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: '16%', alignSelf: 'center', width: 150, height: 150 }, glowStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <SvgLinearGradient id="synthSun" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%"  stopColor="#ffe28a" />
              <Stop offset="55%" stopColor="#ff9a3a" />
              <Stop offset="100%" stopColor={pink} />
            </SvgLinearGradient>
            <Mask id="sunBands">
              <Circle cx="50" cy="50" r="42" fill="#ffffff" />
              {/* Horizontal slices get thicker toward the bottom of the disc */}
              <Rect x="0" y="58" width="100" height="2.5" fill="#000000" />
              <Rect x="0" y="66" width="100" height="3.5" fill="#000000" />
              <Rect x="0" y="75" width="100" height="4.5" fill="#000000" />
              <Rect x="0" y="85" width="100" height="5.5" fill="#000000" />
            </Mask>
          </Defs>
          <Circle cx="50" cy="50" r="42" fill="url(#synthSun)" mask="url(#sunBands)" />
        </Svg>
      </Animated.View>
      {/* Perspective grid below the horizon */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* Horizon glow line */}
        <Line x1={0} y1={58} x2={100} y2={58} stroke={pink} strokeOpacity="0.9" strokeWidth="0.5" />
        {/* Radial floor lines fanning out from the vanishing point */}
        {[-80, -52, -30, -12, 4, 20, 38, 62, 96, 130, 152, 180].map((endX, i) => (
          <Line key={`r${i}`} x1={50} y1={58} x2={endX} y2={100} stroke={grid} strokeOpacity="0.45" strokeWidth="0.3" />
        ))}
        {/* Horizontal floor lines, quadratically spaced for depth */}
        {Array.from({ length: 7 }).map((_, i) => (
          <Line key={`h${i}`} x1={0} y1={58 + (i + 1) * (i + 1) * 0.85} x2={100} y2={58 + (i + 1) * (i + 1) * 0.85} stroke={grid} strokeOpacity="0.4" strokeWidth="0.3" />
        ))}
      </Svg>
      {/* Scanline glow sweeping down the floor */}
      <Animated.View pointerEvents="none" style={[
        { position: 'absolute', left: 0, right: 0, top: '50%', height: 50 },
        scanStyle,
      ]}>
        <LinearGradient
          colors={['transparent', pink + '33', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* A few stars in the sky band */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {[[8, 7, 0.5], [22, 13, 0.35], [38, 5, 0.45], [70, 9, 0.5], [86, 15, 0.4], [93, 4, 0.3]].map(([x, y, r], i) => (
          <Circle key={i} cx={x} cy={y} r={r} fill="#ffd9ec" opacity={0.8} />
        ))}
      </Svg>
      {children}
    </View>
  );
}

// ── 14. Eclipse (corona + moon disc) ────────────────────────────────────────

function EclipseBg({ v, style, children }: BgProps) {
  const breathe = useSharedValue(0);
  const rot = useSharedValue(0);
  const rim = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.sin) }), -1, true);
    rot.value = withRepeat(withTiming(1, { duration: 40000, easing: Easing.linear }), -1, false);
    rim.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(breathe); cancelAnimation(rot); cancelAnimation(rim); };
  }, [breathe, rot, rim]);

  const coronaStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(breathe.value, [0, 1], [1, 1.07]) }],
    opacity: interpolate(breathe.value, [0, 1], [0.8, 1]),
  }));
  const rayStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }],
  }));
  const rimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(rim.value, [0, 1], [0.55, 1]),
  }));

  const corona = v.accent ?? '#ffdf8a';
  const stars = useMemo(() => Array.from({ length: 40 }, () => ({
    cx: Math.random() * 100,
    cy: Math.random() * 100,
    r: Math.random() * 1.1 + 0.25,
    delay: Math.random() * 2500,
    duration: TIMING.star + Math.random() * 1500,
  })), []);

  const DISC = 86;
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={['#05060d', '#0a0d18'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {stars.map((s, i) => <TwinklingStar key={i} {...s} />)}
      </Svg>
      {/* Corona bloom behind the disc */}
      <Animated.View pointerEvents="none" style={[
        { position: 'absolute', top: '22%', alignSelf: 'center', width: 190, height: 190 },
        coronaStyle,
      ]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id="eclipseCorona" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
              <Stop offset="0%"  stopColor="#fff8e0" stopOpacity="0.9" />
              <Stop offset="38%" stopColor={corona} stopOpacity="0.5" />
              <Stop offset="100%" stopColor={corona} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="50" r="50" fill="url(#eclipseCorona)" />
        </Svg>
      </Animated.View>
      {/* Slow-rotating faint rays */}
      <Animated.View pointerEvents="none" style={[
        { position: 'absolute', top: '22%', alignSelf: 'center', width: 190, height: 190 },
        rayStyle,
      ]}>
        <Svg width="100%" height="100%" viewBox="-50 -50 100 100">
          {Array.from({ length: 12 }).map((_, i) => {
            const ang = (i * 30) * (Math.PI / 180);
            return (
              <Line key={i}
                x1={Math.cos(ang) * 24} y1={Math.sin(ang) * 24}
                x2={Math.cos(ang) * 50} y2={Math.sin(ang) * 50}
                stroke={corona} strokeOpacity="0.16" strokeWidth="1.6" strokeLinecap="round" />
            );
          })}
        </Svg>
      </Animated.View>
      {/* The moon disc with a glowing rim */}
      <Animated.View pointerEvents="none" style={[
        {
          position: 'absolute', top: '22%', alignSelf: 'center',
          marginTop: (190 - DISC) / 2, width: DISC, height: DISC, borderRadius: DISC / 2,
          backgroundColor: '#04050c', borderWidth: 1.5, borderColor: '#fff8e0',
          shadowColor: '#fff8e0', shadowOpacity: 0.9, shadowRadius: 12,
        },
        rimStyle,
      ]} />
      {children}
    </View>
  );
}

// ── 15. Matrix (digital rain) ───────────────────────────────────────────────

const MATRIX_GLYPHS = 'アイウエオカキクケコサシスセソタチツテト0123456789Φ$#';

function MatrixBg({ v, style, children }: BgProps) {
  const columns = useMemo(() => Array.from({ length: 8 }, (_, i) => ({
    left: `${i * 12.5 + 2}%`,
    glyphs: Array.from({ length: 22 }, () =>
      MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)]).join('\n'),
    dur: 2600 + Math.random() * 2800,
    delay: Math.random() * 2000,
    opacity: 0.35 + Math.random() * 0.55,
  })), []);

  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#010a04' }, style]}>
      {columns.map((c, i) => <MatrixColumn key={i} {...c} color={v.color ?? '#00ff41'} />)}
      {/* Soft vignette top + bottom so the glyphs fade in/out of frame */}
      <LinearGradient pointerEvents="none"
        colors={['#010a04', 'transparent', 'transparent', '#010a04'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.18, 0.8, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

function MatrixColumn({ left, glyphs, dur, delay, opacity, color }: {
  left: any; glyphs: string; dur: number; delay: number; opacity: number; color: string;
}) {
  // Two stacked copies translate upward-to-downward in a seamless wrap:
  // 22 glyphs x lineHeight 16 = 352px per copy.
  const COPY_H = 352;
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, dur, delay]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [-COPY_H, 0]) }],
  }));
  const textStyle = {
    color, fontSize: 13, lineHeight: 16, fontWeight: '600' as const,
    textShadowColor: color, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 },
  };
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left, opacity }, animStyle]}>
      <Text style={textStyle}>{glyphs}</Text>
      <Text style={textStyle}>{glyphs}</Text>
    </Animated.View>
  );
}

// ── 16. Golden Hour (golf links at dusk) ────────────────────────────────────

function DuskLinksBg({ v, style, children }: BgProps) {
  const sun = useSharedValue(0);
  useEffect(() => {
    sun.value = withRepeat(withTiming(1, { duration: 3600, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(sun);
  }, [sun]);
  const sunStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sun.value, [0, 1], [0.75, 1]),
    transform: [{ scale: interpolate(sun.value, [0, 1], [1, 1.06]) }],
  }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      {/* Sky: deep indigo through burnt orange to gold at the horizon */}
      <LinearGradient
        colors={['#1c1440', '#5e2a50', '#c2542e', '#ffb14a'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.42, 0.66, 0.8]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Setting sun, pulsing gently just above the hills */}
      <Animated.View pointerEvents="none" style={[
        {
          position: 'absolute', top: '52%', left: '24%',
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: '#ffe9a8',
          shadowColor: '#ff9a3a', shadowOpacity: 0.95, shadowRadius: 26,
        },
        sunStyle,
      ]} />
      {/* Drifting clouds, warm-tinted */}
      <DriftingCloud top="14%" width={130} dur={34000} delay={0} />
      <DriftingCloud top="26%" width={90}  dur={26000} delay={9000} />
      {/* Course silhouette: layered hills + flagstick */}
      <Svg pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '34%' }} viewBox="0 0 100 40" preserveAspectRatio="none">
        {/* Far ridge */}
        <Path d="M0 22 Q 18 14 36 20 T 70 18 Q 85 15 100 20 V40 H0 Z" fill="#241024" opacity="0.85" />
        {/* Near fairway hill */}
        <Path d="M0 30 Q 25 20 55 27 T 100 26 V40 H0 Z" fill="#120816" />
        {/* Flagstick + flag on the near hill */}
        <Line x1={62} y1={26.5} x2={62} y2={14} stroke="#0a050c" strokeWidth="0.7" />
        <Path d="M62 14 L69.5 16.6 L62 19.2 Z" fill="#0a050c" />
      </Svg>
      {children}
    </View>
  );
}

function DriftingCloud({ top, width, dur, delay }: { top: any; width: number; dur: number; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, dur, delay]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [0, 560]) }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      {
        position: 'absolute', top, left: -width - 30,
        width, height: width * 0.22, borderRadius: width,
        backgroundColor: 'rgba(255, 206, 150, 0.20)',
      },
      animStyle,
    ]} />
  );
}

// ── 17. Tempest (forked bolts + driving rain) ───────────────────────────────

function ThunderBg({ v, style, children }: BgProps) {
  const flash = useSharedValue(0);
  const bolt1 = useSharedValue(0);
  const bolt2 = useSharedValue(0);
  useEffect(() => {
    flash.value = withRepeat(withSequence(
      withDelay(2200 + Math.random() * 2400, withTiming(1, { duration: 60 })),
      withTiming(0.25, { duration: 90 }),
      withTiming(0.85, { duration: 50 }),
      withTiming(0, { duration: 260 }),
    ), -1, false);
    bolt1.value = withRepeat(withSequence(
      withDelay(1800 + Math.random() * 2600, withTiming(1, { duration: 50 })),
      withTiming(0.4, { duration: 90 }),
      withTiming(0.9, { duration: 50 }),
      withTiming(0, { duration: 220 }),
    ), -1, false);
    bolt2.value = withRepeat(withSequence(
      withDelay(3600 + Math.random() * 3000, withTiming(1, { duration: 70 })),
      withTiming(0, { duration: 300 }),
    ), -1, false);
    return () => { cancelAnimation(flash); cancelAnimation(bolt1); cancelAnimation(bolt2); };
  }, [flash, bolt1, bolt2]);

  const flashStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flash.value, [0, 1], [0, 0.5]),
  }));
  const b1Props = useAnimatedProps(() => ({ opacity: bolt1.value }));
  const b2Props = useAnimatedProps(() => ({ opacity: bolt2.value }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0b0918', v.to ?? '#2a2440'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Forked bolts: main channel + branches as subpaths of one Path */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 200">
        <AnimatedPath
          d="M28 0 L24 42 L33 50 L20 98 L30 106 L17 160 M25 52 L14 76 M27 102 L38 128"
          stroke="#dcd2ff" strokeWidth="1.3" fill="none" strokeLinejoin="round"
          animatedProps={b1Props}
        />
        <AnimatedPath
          d="M74 8 L70 46 L79 54 L66 104 L76 112 L63 172 M71 58 L84 84"
          stroke="#c4b8ff" strokeWidth="1.1" fill="none" strokeLinejoin="round"
          animatedProps={b2Props}
        />
      </Svg>
      {/* Driving rain: two staggered groups of slanted streaks */}
      <RainLayer dur={850} delay={0} opacity={0.32} />
      <RainLayer dur={1150} delay={400} opacity={0.2} />
      {/* Sheet-lightning wash */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, flashStyle, { backgroundColor: '#cfc4ff' }]} />
      {children}
    </View>
  );
}

function RainLayer({ dur, delay, opacity }: { dur: number; delay: number; opacity: number }) {
  const streaks = useMemo(() => Array.from({ length: 7 }, (_, i) => ({
    left: `${(i * 14 + Math.random() * 8) % 100}%`,
    top: `${(i * 29) % 90}%`,
  })), []);
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, dur, delay]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [-140, 140]) },
      { translateX: interpolate(t.value, [0, 1], [40, -40]) },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }, animStyle]}>
      {streaks.map((s, i) => (
        <View key={i} style={{
          position: 'absolute', left: s.left as any, top: s.top as any,
          width: 1.5, height: 26, borderRadius: 1,
          backgroundColor: '#bec8ff',
          transform: [{ rotate: '16deg' }],
        }} />
      ))}
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BORDER (wraps an avatar / crest)
// ═══════════════════════════════════════════════════════════════════════════

export function CosmeticBorder({
  visual, size = 96, children,
}: { visual: VisualData; size?: number; children?: React.ReactNode }) {
  const v = visual ?? {};
  switch (v.style) {
    case 'traveling':  return <TravelingBorder v={v} size={size}>{children}</TravelingBorder>;
    case 'holographic':return <HolographicBorder v={v} size={size}>{children}</HolographicBorder>;
    case 'flame':      return <FlameBorder v={v} size={size}>{children}</FlameBorder>;
    case 'plasma':     return <PlasmaBorder v={v} size={size}>{children}</PlasmaBorder>;
    case 'frost':      return <FrostBorder v={v} size={size}>{children}</FrostBorder>;
    case 'tesla':      return <TeslaBorder v={v} size={size}>{children}</TeslaBorder>;
    case 'eclipse':    return <CoronaBorder v={v} size={size}>{children}</CoronaBorder>;
    case 'pulse':      return <PulseBorder v={v} size={size}>{children}</PulseBorder>;
    case 'glow':       return <GlowBorder v={v} size={size}>{children}</GlowBorder>;
    default:
      if (!v.color) return <>{children}</>;
      return <GlowBorder v={v} size={size}>{children}</GlowBorder>;
  }
}

function GlowBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 6;
  // A slow breathe so even the plainest ring has life everywhere it appears.
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);
  const animStyle = useAnimatedStyle(() => ({
    shadowOpacity: interpolate(t.value, [0, 1], [0.5, 0.95]),
    shadowRadius: interpolate(t.value, [0, 1], [9, 16]),
  }));
  return (
    <Animated.View style={[{
      width: padded, height: padded, borderRadius: padded / 2,
      borderWidth: width, borderColor: v.color ?? C.gold,
      alignItems: 'center', justifyContent: 'center',
      shadowColor: v.color ?? C.gold, shadowOffset: { width: 0, height: 0 },
    }, animStyle]}>
      {children}
    </Animated.View>
  );
}

function PulseBorder({ v, size, children }: BorderProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: TIMING.pulse, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);
  const animStyle = useAnimatedStyle(() => ({
    opacity:   interpolate(t.value, [0, 1], [0.55, 1]),
    transform: [{ scale: interpolate(t.value, [0, 1], [0.97, 1.04]) }],
  }));
  const width = v.width ?? 3;
  const padded = size + width * 2 + 8;
  return (
    <Animated.View style={[{
      width: padded, height: padded, borderRadius: padded / 2,
      borderWidth: width, borderColor: v.color ?? C.gold,
      alignItems: 'center', justifyContent: 'center',
      shadowColor: v.color ?? C.gold, shadowOpacity: 0.9, shadowRadius: 14,
    }, animStyle]}>
      {children}
    </Animated.View>
  );
}

/** A glowing dot orbits the avatar — SVG circle with animated
 *  stroke-dashoffset on the ring path so it looks like light is racing
 *  around the avatar. */
function TravelingBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 12;
  const r = (padded - width) / 2;
  const cx = padded / 2;
  const circ = 2 * Math.PI * r;
  // Two arcs travel: one fast, one slower, to create a chasing-light feel.
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: TIMING.traveling, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const dotProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(t.value, [0, 1], [0, -circ]),
  }));

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        {/* Dim ring underneath */}
        <Circle cx={cx} cy={cx} r={r} stroke={(v.color ?? C.gold) + '44'} strokeWidth={width} fill="none" />
        {/* Bright traveling arc */}
        <AnimatedCircle
          cx={cx} cy={cx} r={r}
          stroke={v.color ?? C.gold}
          strokeWidth={width}
          fill="none"
          strokeDasharray={`${circ * 0.18} ${circ * 0.82}`}
          strokeLinecap="round"
          animatedProps={dotProps}
        />
      </Svg>
      <View style={{
        shadowColor: v.color ?? C.gold, shadowOpacity: 0.7, shadowRadius: 10,
      }}>
        {children}
      </View>
    </View>
  );
}

/** Iridescent ring — masked LinearGradient with hue cycling. */
function HolographicBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 8;
  const colors = ((v.colors ?? ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a', '#ff6b9d']) as readonly string[]) as readonly [string, string, ...string[]];
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(1, { duration: TIMING.holographic, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rot);
  }, [rot]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }],
  }));

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <MaskedView
        style={{ width: padded, height: padded, position: 'absolute' }}
        maskElement={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' }}>
            <View style={{
              width: padded, height: padded, borderRadius: padded / 2,
              borderWidth: width, borderColor: 'black',
            }} />
          </View>
        }
      >
        <Animated.View style={[{ width: padded * 2, height: padded * 2, marginLeft: -padded / 2, marginTop: -padded / 2 }, animStyle]}>
          <LinearGradient
            colors={colors}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      </MaskedView>
      <View style={{
        shadowColor: colors[0], shadowOpacity: 0.7, shadowRadius: 10,
      }}>
        {children}
      </View>
    </View>
  );
}

/** Plasma — multiple traveling arcs at different speeds + colors. */
function PlasmaBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 12;
  const r = (padded - width) / 2;
  const cx = padded / 2;
  const circ = 2 * Math.PI * r;
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
    b.value = withRepeat(withTiming(1, { duration: 3600, easing: Easing.linear }), -1, false);
    return () => { cancelAnimation(a); cancelAnimation(b); };
  }, [a, b]);
  const aProps = useAnimatedProps(() => ({ strokeDashoffset: interpolate(a.value, [0, 1], [0, -circ]) }));
  const bProps = useAnimatedProps(() => ({ strokeDashoffset: interpolate(b.value, [0, 1], [0,  circ]) }));
  const c1 = v.color ?? '#c779ff';
  const c2 = v.accent ?? '#74e0ff';

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        <Circle cx={cx} cy={cx} r={r} stroke={c1 + '33'} strokeWidth={width} fill="none" />
        <AnimatedCircle cx={cx} cy={cx} r={r} stroke={c1} strokeWidth={width} fill="none"
          strokeDasharray={`${circ * 0.20} ${circ * 0.80}`} strokeLinecap="round" animatedProps={aProps} />
        <AnimatedCircle cx={cx} cy={cx} r={r} stroke={c2} strokeWidth={width * 0.7} fill="none"
          strokeDasharray={`${circ * 0.12} ${circ * 0.88}`} strokeLinecap="round" animatedProps={bProps} />
      </Svg>
      <View style={{ shadowColor: c1, shadowOpacity: 0.85, shadowRadius: 14 }}>
        {children}
      </View>
    </View>
  );
}

/** Flame ring — three offset rings with separate flicker timings. */
function FlameBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 14;
  const r = (padded - width) / 2;
  const cx = padded / 2;
  const circ = 2 * Math.PI * r;
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  const c = useSharedValue(0);
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.cubic) }), -1, true);
    b.value = withRepeat(withTiming(1, { duration: 800,  easing: Easing.inOut(Easing.cubic) }), -1, true);
    c.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.cubic) }), -1, true);
    return () => { cancelAnimation(a); cancelAnimation(b); cancelAnimation(c); };
  }, [a, b, c]);
  const aProps = useAnimatedProps(() => ({ strokeOpacity: interpolate(a.value, [0, 1], [0.4, 1]) }));
  const bProps = useAnimatedProps(() => ({ strokeOpacity: interpolate(b.value, [0, 1], [0.3, 0.85]) }));
  const cProps = useAnimatedProps(() => ({ strokeOpacity: interpolate(c.value, [0, 1], [0.2, 0.7]) }));

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        <AnimatedCircle cx={cx} cy={cx} r={r} stroke="#ffd479" strokeWidth={width} fill="none" animatedProps={aProps} />
        <AnimatedCircle cx={cx} cy={cx} r={r + 1.5} stroke="#ffb14a" strokeWidth={width * 0.8} fill="none" animatedProps={bProps} />
        <AnimatedCircle cx={cx} cy={cx} r={r + 3} stroke="#d83a5e" strokeWidth={width * 0.7} fill="none" animatedProps={cProps} />
      </Svg>
      <View style={{ shadowColor: '#ffb14a', shadowOpacity: 0.95, shadowRadius: 14 }}>
        {children}
      </View>
    </View>
  );
}

/** Frost — hexagonal crystals around the ring. */
function FrostBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 14;
  const r = (padded - width) / 2;
  const cx = padded / 2;
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 3500, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);
  const shimmer = useAnimatedProps(() => ({
    strokeOpacity: interpolate(t.value, [0, 1], [0.65, 1]),
  }));
  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        <AnimatedCircle cx={cx} cy={cx} r={r} stroke={v.color ?? '#74e0ff'} strokeWidth={width} fill="none" animatedProps={shimmer} />
        {/* Crystal accents — 12 thin spikes pointing outward */}
        {Array.from({ length: 12 }).map((_, i) => {
          const ang = (i * 30) * (Math.PI / 180);
          const x1 = cx + Math.cos(ang) * r;
          const y1 = cx + Math.sin(ang) * r;
          const x2 = cx + Math.cos(ang) * (r + 4);
          const y2 = cx + Math.sin(ang) * (r + 4);
          return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={v.accent ?? '#cad9ff'} strokeWidth="1.2" strokeLinecap="round" />;
        })}
      </Svg>
      <View style={{ shadowColor: v.color ?? '#74e0ff', shadowOpacity: 0.85, shadowRadius: 10 }}>
        {children}
      </View>
    </View>
  );
}

/** Tesla: electric arc segments flicker at random points around the ring,
 *  with an occasional full-ring discharge flash. */
function TeslaBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 16;
  const r = (padded - width) / 2 - 4;
  const cx = padded / 2;
  const circ = 2 * Math.PI * r;
  const color = v.color ?? '#74e0ff';
  const accent = v.accent ?? '#e4ecff';

  const a = useSharedValue(0);
  const b = useSharedValue(0);
  const c = useSharedValue(0);
  const d = useSharedValue(0);
  const discharge = useSharedValue(0);
  useEffect(() => {
    const arcFlicker = (sv: SharedValue<number>, lull: number) => {
      sv.value = withRepeat(withSequence(
        withDelay(lull, withTiming(1, { duration: 45 })),
        withTiming(0.25, { duration: 70 }),
        withTiming(0.9, { duration: 40 }),
        withTiming(0, { duration: 130 }),
      ), -1, false);
    };
    arcFlicker(a, 500);
    arcFlicker(b, 1100);
    arcFlicker(c, 1700);
    arcFlicker(d, 2400);
    discharge.value = withRepeat(withSequence(
      withDelay(3200, withTiming(0.85, { duration: 60 })),
      withTiming(0, { duration: 320 }),
    ), -1, false);
    return () => { [a, b, c, d, discharge].forEach(cancelAnimation); };
  }, [a, b, c, d, discharge]);

  const arcAProps = useAnimatedProps(() => ({ strokeOpacity: a.value }));
  const arcBProps = useAnimatedProps(() => ({ strokeOpacity: b.value }));
  const arcCProps = useAnimatedProps(() => ({ strokeOpacity: c.value }));
  const arcDProps = useAnimatedProps(() => ({ strokeOpacity: d.value }));
  const ringProps = useAnimatedProps(() => ({ strokeOpacity: discharge.value }));

  // Four arc segments parked at 12 / 3 / 6 / 9 o'clock via dashoffset.
  const seg = `${circ * 0.09} ${circ * 0.91}`;
  const arcProps = [arcAProps, arcBProps, arcCProps, arcDProps];

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        {/* Faint cage ring always present */}
        <Circle cx={cx} cy={cx} r={r} stroke={color + '3a'} strokeWidth={width * 0.8} fill="none" />
        {/* Flickering arc segments */}
        {arcProps.map((p, i) => (
          <AnimatedCircle key={i}
            cx={cx} cy={cx} r={r}
            stroke={i % 2 ? accent : color} strokeWidth={width}
            fill="none" strokeLinecap="round"
            strokeDasharray={seg}
            strokeDashoffset={-(circ * (i / 4))}
            animatedProps={p}
          />
        ))}
        {/* Spark zigzags just outside the ring at the diagonals */}
        {[45, 135, 225, 315].map((deg, i) => {
          const ang = deg * (Math.PI / 180);
          const sx = cx + Math.cos(ang) * (r + 2);
          const sy = cx + Math.sin(ang) * (r + 2);
          const ex = cx + Math.cos(ang) * (r + 9);
          const ey = cx + Math.sin(ang) * (r + 9);
          const mx = (sx + ex) / 2 + Math.cos(ang + Math.PI / 2) * 3;
          const my = (sy + ey) / 2 + Math.sin(ang + Math.PI / 2) * 3;
          return (
            <AnimatedPath key={`s${i}`}
              d={`M ${sx} ${sy} L ${mx} ${my} L ${ex} ${ey}`}
              stroke={accent} strokeWidth={1.4} fill="none" strokeLinecap="round"
              animatedProps={arcProps[(i + 1) % 4]}
            />
          );
        })}
        {/* Occasional full-ring discharge */}
        <AnimatedCircle cx={cx} cy={cx} r={r} stroke={accent} strokeWidth={width * 0.6} fill="none" animatedProps={ringProps} />
      </Svg>
      <View style={{ shadowColor: color, shadowOpacity: 0.85, shadowRadius: 12 }}>
        {children}
      </View>
    </View>
  );
}

/** Corona: a dark eclipse ring with a bright gradient flare arc sweeping
 *  around it, like the sun peeking around the moon's edge. */
function CoronaBorder({ v, size, children }: BorderProps) {
  const width = v.width ?? 3;
  const padded = size + width * 2 + 10;
  const r = (padded - width) / 2 - 2;
  const cx = padded / 2;
  const circ = 2 * Math.PI * r;
  const color = v.color ?? '#d4a93f';
  const accent = v.accent ?? '#ffe28a';

  const rot = useSharedValue(0);
  const breathe = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(1, { duration: 4200, easing: Easing.linear }), -1, false);
    breathe.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(rot); cancelAnimation(breathe); };
  }, [rot, breathe]);
  const rotStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(breathe.value, [0, 1], [0.6, 1]),
  }));

  return (
    <View style={{ width: padded, height: padded, alignItems: 'center', justifyContent: 'center' }}>
      {/* Dark base ring: the "moon" */}
      <Svg width={padded} height={padded} style={StyleSheet.absoluteFill}>
        <Circle cx={cx} cy={cx} r={r} stroke="#171204" strokeWidth={width + 1.5} fill="none" />
        <Circle cx={cx} cy={cx} r={r} stroke={color + '30'} strokeWidth={width} fill="none" />
      </Svg>
      {/* Sweeping flare arc: a 25% arc + a thinner hot core riding it */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, rotStyle]}>
        <Svg width={padded} height={padded}>
          <Circle cx={cx} cy={cx} r={r}
            stroke={color} strokeWidth={width} fill="none" strokeLinecap="round"
            strokeDasharray={`${circ * 0.25} ${circ * 0.75}`} />
          <Circle cx={cx} cy={cx} r={r}
            stroke={accent} strokeWidth={width * 0.45} fill="none" strokeLinecap="round"
            strokeDasharray={`${circ * 0.16} ${circ * 0.84}`}
            strokeDashoffset={-(circ * 0.045)} />
        </Svg>
      </Animated.View>
      <Animated.View style={[{ shadowColor: accent, shadowOpacity: 0.9, shadowRadius: 13 }, glowStyle]}>
        {children}
      </Animated.View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// USERNAME
// ═══════════════════════════════════════════════════════════════════════════

export function CosmeticUsername({
  visual, children, style,
}: { visual: VisualData; children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const v = visual ?? {};
  switch (v.style) {
    case 'gradient':    return <GradientUsername v={v} style={style}>{children}</GradientUsername>;
    case 'shimmer':     return <ShimmerUsername v={v} style={style}>{children}</ShimmerUsername>;
    case 'holographic': return <HolographicUsername v={v} style={style}>{children}</HolographicUsername>;
    case 'neon':        return <NeonUsername v={v} style={style}>{children}</NeonUsername>;
    case 'glitch':      return <GlitchUsername v={v} style={style}>{children}</GlitchUsername>;
    case 'solid':
    default:
      return <SolidUsername v={v} style={style}>{children}</SolidUsername>;
  }
}

function SolidUsername({ v, style, children }: UnameProps) {
  const glow = v.glow ? {
    textShadowColor: v.color ?? '#ffffff',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 0 },
  } : null;
  return <Text style={[style, { color: v.color ?? '#ffffff' }, glow]}>{children}</Text>;
}

/** True gradient text via MaskedView → LinearGradient under a black-on-
 *  transparent text mask. The text fills with the gradient instead of
 *  cycling through a single color. */
function GradientUsername({ v, style, children }: UnameProps) {
  const gradient = (v.gradient ?? ['#ff6b9d', '#74e0ff']) as readonly string[];
  const colors = gradient as readonly [string, string, ...string[]];
  return (
    <MaskedView maskElement={<Text style={style} numberOfLines={1}>{children}</Text>}>
      {/* In-flow invisible copy sizes the MaskedView to the glyphs (an absolute
          spacer gives zero width → blank text). The gradient then fills that
          exact box and is clipped to the letters by the mask above. */}
      <Text style={[style, { opacity: 0 }]} numberOfLines={1}>{children}</Text>
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </MaskedView>
  );
}

/** Shimmer — a bright slice slides across the text. */
function ShimmerUsername({ v, style, children }: UnameProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withTiming(1, { duration: TIMING.shimmer, easing: Easing.inOut(Easing.cubic) }),
        withDelay(1500, withTiming(1, { duration: 0 })),
      ), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [-200, 200]) }],
  }));
  return (
    <MaskedView
      maskElement={
        <Text style={[style, { backgroundColor: 'transparent', color: 'black' }]}>
          {children}
        </Text>
      }
    >
      <View style={{ flexDirection: 'row' }}>
        <Text style={[style, { color: v.color ?? '#d4a93f' }]}>{children}</Text>
        <Animated.View style={[StyleSheet.absoluteFill, animStyle, { overflow: 'hidden' }]} pointerEvents="none">
          <LinearGradient
            colors={['transparent', '#ffffff', 'transparent'] as const as readonly [string, string, ...string[]]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={{ width: 80, height: '100%' }}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
}

/** Holographic text — full spectrum gradient that slides for a moving-rainbow
 *  effect. The slide gives the iridescent "shifting between viewing angles"
 *  illusion that a static gradient can't match. */
function HolographicUsername({ v, style, children }: UnameProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: TIMING.holographic, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const colors = ((v.gradient ?? ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a', '#ff6b9d']) as readonly string[]) as readonly [string, string, ...string[]];
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [-60, 60]) }],
  }));
  return (
    <MaskedView maskElement={<Text style={style} numberOfLines={1}>{children}</Text>}>
      {/* Invisible in-flow copy sizes the box to the glyphs; the spectrum is
          extra-wide and slides under the mask for the moving-rainbow look. */}
      <Text style={[style, { opacity: 0 }]} numberOfLines={1}>{children}</Text>
      <Animated.View style={[StyleSheet.absoluteFill, animStyle]}>
        <LinearGradient
          colors={colors}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', top: 0, bottom: 0, left: '-60%', width: '220%' }}
        />
      </Animated.View>
    </MaskedView>
  );
}

/** Neon sign: hot-white core with a strong colored halo, plus the
 *  characteristic double-blink flicker of a tube that is about to give up. */
function NeonUsername({ v, style, children }: UnameProps) {
  const color = v.color ?? '#ff2d95';
  const t = useSharedValue(1);
  useEffect(() => {
    t.value = withRepeat(withSequence(
      withDelay(1400, withTiming(0.45, { duration: 50 })),
      withTiming(1, { duration: 80 }),
      withDelay(2300, withTiming(0.7, { duration: 40 })),
      withTiming(1, { duration: 60 }),
      withDelay(900, withTiming(1, { duration: 0 })),
    ), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const flicker = useAnimatedStyle(() => ({ opacity: t.value }));
  return (
    <Animated.View style={flicker}>
      <Text style={[style, {
        color: '#fff6fb',
        textShadowColor: color,
        textShadowRadius: 12,
        textShadowOffset: { width: 0, height: 0 },
      }]}>
        {children}
      </Text>
    </Animated.View>
  );
}

/** Glitch: chromatic-aberration ghosts (cyan / magenta) jitter behind the
 *  base text in quick bursts, like a corrupted video frame. */
function GlitchUsername({ v, style, children }: UnameProps) {
  const jit = useSharedValue(0);
  useEffect(() => {
    jit.value = withRepeat(withSequence(
      withDelay(1700, withTiming(1, { duration: 40 })),
      withTiming(-1, { duration: 50 }),
      withTiming(0.6, { duration: 40 }),
      withTiming(0, { duration: 60 }),
      withDelay(700, withTiming(-0.8, { duration: 35 })),
      withTiming(0, { duration: 55 }),
    ), -1, false);
    return () => cancelAnimation(jit);
  }, [jit]);

  const ghostA = useAnimatedStyle(() => ({
    transform: [
      { translateX: jit.value * 2.4 },
      { translateY: jit.value * -0.8 },
    ],
    opacity: 0.75,
  }));
  const ghostB = useAnimatedStyle(() => ({
    transform: [
      { translateX: jit.value * -2.4 },
      { translateY: jit.value * 0.8 },
    ],
    opacity: 0.75,
  }));
  const baseJit = useAnimatedStyle(() => ({
    transform: [{ translateX: jit.value * 0.7 }],
  }));

  return (
    <View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, ghostA]}>
        <Text style={[style, { color: '#00f0ff' }]}>{children}</Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, ghostB]}>
        <Text style={[style, { color: '#ff00d4' }]}>{children}</Text>
      </Animated.View>
      <Animated.View style={baseJit}>
        <Text style={[style, { color: v.color ?? '#ffffff' }]}>{children}</Text>
      </Animated.View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BALL TRAIL PREVIEW
// ═══════════════════════════════════════════════════════════════════════════

export function CosmeticTrailPreview({ visual }: { visual: VisualData }) {
  const v = visual ?? {};
  switch (v.style) {
    case 'crackle':    return <CrackleTrailPreview v={v} />;
    case 'gradient':   return <GradientTrailPreview v={v} />;
    case 'galaxy':     return <GalaxyTrailPreview v={v} />;
    case 'traveling':  return <TravelingTrailPreview v={v} />;
    case 'fire':       return <FireTrailPreview v={v} />;
    case 'rainbow':    return <RainbowTrailPreview v={v} />;
    case 'pulse':      return <PulseTrailPreview v={v} />;
    case 'solid':
    default:           return <SolidTrailPreview v={v} />;
  }
}

function SolidTrailPreview({ v }: TrailProps) {
  return (
    <View style={{ width: '75%', height: v.width ?? 2, borderRadius: 2,
      backgroundColor: v.color ?? '#fff',
      shadowColor: v.color ?? '#fff', shadowOpacity: v.glow ? 0.9 : 0, shadowRadius: 4 }} />
  );
}

function PulseTrailPreview({ v }: TrailProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
    return () => cancelAnimation(t);
  }, [t]);
  const animStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.45, 1]),
  }));
  return (
    <Animated.View style={[{
      width: '75%', height: v.width ?? 3, borderRadius: 2,
      backgroundColor: v.color ?? '#39ff14',
      shadowColor: v.color ?? '#39ff14', shadowOpacity: 0.95, shadowRadius: 6,
    }, animStyle]} />
  );
}

function GradientTrailPreview({ v }: TrailProps) {
  const colors = [v.color ?? '#ffb14a', v.accent ?? '#d83a5e'] as const as readonly [string, string, ...string[]];
  return (
    <View style={{ width: '75%', height: v.width ?? 3, borderRadius: 2, overflow: 'hidden',
      shadowColor: v.color ?? '#fff', shadowOpacity: v.glow ? 0.9 : 0, shadowRadius: 5 }}>
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

/** A jagged lightning-style trail rendered as an SVG path with random
 *  segments. The path is re-rolled on mount only (preview is static-ish). */
function CrackleTrailPreview({ v }: TrailProps) {
  const segments = useMemo(() => {
    const pts: string[] = [];
    let x = 0;
    for (let i = 0; i <= 10; i++) {
      const px = (i / 10) * 100;
      const py = (Math.random() - 0.5) * 12;
      pts.push(`${i === 0 ? 'M' : 'L'} ${px} ${py}`);
    }
    return pts.join(' ');
  }, []);
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withSequence(
      withTiming(1, { duration: 110 }),
      withTiming(0.55, { duration: 160 }),
      withTiming(1, { duration: 80 }),
      withDelay(220, withTiming(0.65, { duration: 0 })),
    ), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const animProps = useAnimatedProps(() => ({ strokeOpacity: t.value }));
  return (
    <View style={{ width: '75%', height: 18 }}>
      <Svg viewBox="0 -10 100 20" preserveAspectRatio="none" width="100%" height="100%">
        <AnimatedPath d={segments} stroke={v.color ?? '#74e0ff'} strokeWidth={v.width ?? 3} fill="none" strokeLinecap="round" animatedProps={animProps} />
        <Path d={segments} stroke={v.accent ?? '#ffffff'} strokeWidth={(v.width ?? 3) * 0.45} fill="none" strokeLinecap="round" opacity="0.9" />
      </Svg>
    </View>
  );
}

/** Galaxy — gradient line with bright star dots along the path. */
function GalaxyTrailPreview({ v }: TrailProps) {
  const stars = useMemo(() => Array.from({ length: 6 }, () => ({
    x: 5 + Math.random() * 90, r: 0.8 + Math.random() * 1.2,
    delay: Math.random() * 1800,
  })), []);
  return (
    <View style={{ width: '75%', height: 12 }}>
      <View style={{ position: 'absolute', top: 4, left: 0, right: 0, height: v.width ?? 3,
        shadowColor: v.color ?? '#c779ff', shadowOpacity: 0.85, shadowRadius: 5 }}>
        <LinearGradient
          colors={[v.color ?? '#c779ff', v.accent ?? '#74e0ff'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ flex: 1, borderRadius: 2 }}
        />
      </View>
      <Svg viewBox="0 0 100 12" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        {stars.map((s, i) => <GalaxyStar key={i} {...s} />)}
      </Svg>
    </View>
  );
}

function GalaxyStar({ x, r, delay }: { x: number; r: number; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: 1400 }), -1, true));
    return () => cancelAnimation(t);
  }, [t, delay]);
  const animProps = useAnimatedProps(() => ({
    opacity: interpolate(t.value, [0, 1], [0.4, 1]),
  }));
  return <AnimatedCircle cx={x} cy={6} r={r} fill="#ffffff" animatedProps={animProps} />;
}

/** Traveling-light dash effect on a straight line. */
function TravelingTrailPreview({ v }: TrailProps) {
  const t = useSharedValue(0);
  const len = 100;
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const animProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(t.value, [0, 1], [0, -len]),
  }));
  return (
    <View style={{ width: '75%', height: 8, shadowColor: v.color ?? '#fff', shadowOpacity: v.glow ? 0.9 : 0.4, shadowRadius: 5 }}>
      <Svg viewBox="0 0 100 8" preserveAspectRatio="none" width="100%" height="100%">
        <Line x1={0} y1={4} x2={100} y2={4} stroke={(v.color ?? '#74e0ff') + '44'} strokeWidth={v.width ?? 3} />
        <AnimatedPath
          d="M 0 4 L 100 4"
          stroke={v.color ?? '#74e0ff'}
          strokeWidth={v.width ?? 3}
          strokeDasharray="18 12"
          strokeLinecap="round"
          fill="none"
          animatedProps={animProps}
        />
      </Svg>
    </View>
  );
}

/** Fire trail — gradient line with flame embers rising. */
function FireTrailPreview({ v }: TrailProps) {
  const embers = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    x: 10 + i * 18 + Math.random() * 6,
    delay: i * 220,
  })), []);
  return (
    <View style={{ width: '75%', height: 18 }}>
      <View style={{ position: 'absolute', top: 8, left: 0, right: 0, height: v.width ?? 3,
        shadowColor: v.color ?? '#ffb14a', shadowOpacity: 0.95, shadowRadius: 6 }}>
        <LinearGradient
          colors={[v.color ?? '#ffb14a', v.accent ?? '#d83a5e'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ flex: 1, borderRadius: 2 }}
        />
      </View>
      {embers.map((e, i) => <Ember key={i} x={e.x} delay={e.delay} color={v.color ?? '#ffb14a'} />)}
    </View>
  );
}

function Ember({ x, delay, color }: { x: number; delay: number; color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: 1000, easing: Easing.out(Easing.cubic) }), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [4, -10]) },
      { scale: interpolate(t.value, [0, 1], [1, 0.3]) },
    ],
    opacity: interpolate(t.value, [0, 0.2, 1], [0, 1, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', top: 5, left: `${x}%`, width: 5, height: 5, borderRadius: 2.5, backgroundColor: color },
      animStyle,
    ]} />
  );
}

/** Prism Ribbon: full-spectrum gradient bar with a white highlight pulse
 *  racing along it. */
function RainbowTrailPreview({ v }: TrailProps) {
  const t = useSharedValue(0);
  const len = 100;
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [t]);
  const animProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(t.value, [0, 1], [0, -len]),
  }));
  const h = v.width ?? 3;
  return (
    <View style={{ width: '75%', height: 12, justifyContent: 'center',
      shadowColor: '#ffffff', shadowOpacity: v.glow ? 0.7 : 0.3, shadowRadius: 5 }}>
      <View style={{ height: h + 1, borderRadius: 3, overflow: 'hidden' }}>
        <LinearGradient
          colors={['#ff3b5c', '#ff9a3a', '#ffe23a', '#3aff7a', '#3ac8ff', '#a36bff'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ flex: 1 }}
        />
      </View>
      <Svg viewBox="0 0 100 12" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <AnimatedPath
          d="M 0 6 L 100 6"
          stroke="#ffffff" strokeWidth={h * 0.5} strokeLinecap="round" fill="none"
          strokeDasharray="14 86" opacity="0.85"
          animatedProps={animProps}
        />
      </Svg>
    </View>
  );
}

// ─── Prop types ──────────────────────────────────────────────────────────────

type BgProps     = { v: any; style?: StyleProp<ViewStyle>; children?: React.ReactNode };
type BorderProps = { v: any; size: number; children?: React.ReactNode };
type UnameProps  = { v: any; style?: StyleProp<TextStyle>; children?: React.ReactNode };
type TrailProps  = { v: any };
