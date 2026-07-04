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
 *                matrix | dusk | thunder | nebula | embers | meteor | plasma |
 *                blizzard | prism
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
  View, Text, StyleSheet, ViewStyle, StyleProp, TextStyle, useWindowDimensions, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle, Ellipse, Path, Line, G, Defs, Rect,
  LinearGradient as SvgLinearGradient, Stop, RadialGradient, Mask, ClipPath, Use,
} from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps,
  withTiming, withRepeat, withSequence, withDelay,
  interpolate, Easing, cancelAnimation,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import MaskedView from '@react-native-masked-view/masked-view';
import { C } from '../lib/colors';
import { SparkleField } from './vfx';

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

// ── Shared background helpers ────────────────────────────────────────────────
// Reusable depth/light/motion building blocks so each background gains polish
// without re-rolling the same code. All are pointerEvents="none" decoration.

let _bgIdSeq = 0;
/** Unique, colon-free SVG gradient id (React.useId() colons break url(#id)). */
function useBgId(prefix: string): string {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => `${prefix}${_bgIdSeq++}`, [prefix]);
}

/** Soft edge vignette — darkens the frame so a flat field gains depth. */
function Vignette({ color = '#000000', opacity = 0.5 }: { color?: string; opacity?: number }) {
  const gid = useBgId('vig');
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={gid} cx="50" cy="50" r="62" gradientUnits="userSpaceOnUse">
          <Stop offset="0.45" stopColor={color} stopOpacity="0" />
          <Stop offset="1" stopColor={color} stopOpacity={opacity} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill={`url(#${gid})`} />
    </Svg>
  );
}

/** A diagonal specular sheen that sweeps across on a slow loop — makes a flat
 *  gradient feel lit. */
function SheenSweep({ color = 'rgba(255,255,255,0.5)', durationMs = 7000, angle = 18, opacity = 0.16 }: {
  color?: string; durationMs?: number; angle?: number; opacity?: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: durationMs, easing: Easing.inOut(Easing.sin) }), -1, false);
    return () => cancelAnimation(t);
  }, [t, durationMs]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [-260, 260]) }, { rotate: `${angle}deg` }],
    opacity: interpolate(t.value, [0, 0.5, 1], [0, opacity, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -60, bottom: -60, left: -40, width: 90 }, aStyle]}>
      <LinearGradient
        colors={['transparent', color, 'transparent'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** A soft breathing radial bloom at a fixed spot — fakes volumetric light. */
function BreathingGlow({ cx, cy, r, color, periodMs = 9000, min = 0.3, max = 0.6, delay = 0 }: {
  cx: string; cy: string; r: number; color: string; periodMs?: number; min?: number; max?: number; delay?: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: periodMs, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => cancelAnimation(t);
  }, [t, periodMs, delay]);
  const aStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [min, max]),
    transform: [{ scale: interpolate(t.value, [0, 1], [0.9, 1.15]) }],
  }));
  const gid = useBgId('glow');
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', left: cx as any, top: cy as any, width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r },
      aStyle,
    ]}>
      <Svg width={r * 2} height={r * 2} viewBox={`0 0 ${r * 2} ${r * 2}`}>
        <Defs>
          <RadialGradient id={gid} cx={r} cy={r} r={r} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={color} stopOpacity="0.7" />
            <Stop offset="0.5" stopColor={color} stopOpacity="0.25" />
            <Stop offset="1" stopColor={color} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${gid})`} />
      </Svg>
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND
// ═══════════════════════════════════════════════════════════════════════════

// Cheap, ZERO-driver static representation of each background, for places that
// render MANY at once (the locker grid, season-pass tiers). Animating ~20 full
// backgrounds simultaneously backs up the UI thread; a static swatch reads the
// same at thumbnail size for a fraction of the cost.
const STATIC_BG: Record<string, { colors: string[]; diag?: boolean; accent?: string }> = {
  flag:        { colors: ['#b22234', '#dddddd', '#3c3b6e'], diag: true },
  storm:       { colors: ['#0a0f1c', '#26304a'], accent: '#cad9ff' },
  pulse:       { colors: ['#0a0f1c', '#26304a'], accent: '#cad9ff' },
  aurora:      { colors: ['#04161e', '#0a3a4a', '#06202e'], accent: '#00ff9d' },
  stars:       { colors: ['#040515', '#1a0a3a'], accent: '#7a3ab5' },
  cosmic:      { colors: ['#040515', '#1a0a3a'], accent: '#7a3ab5' },
  flame:       { colors: ['#160503', '#5e1a14', '#ffb14a'] },
  fire:        { colors: ['#160503', '#5e1a14', '#ffb14a'] },
  holographic: { colors: ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a'], diag: true },
  cyber:       { colors: ['#02060e', '#0a1e2e'], accent: '#00ffd5' },
  solar:       { colors: ['#2a0d05', '#0a0204'], accent: '#ffb14a' },
  ocean:       { colors: ['#0a1e3a', '#3d8bbf', '#041d33'] },
  sakura:      { colors: ['#3a1a2a', '#7a3a55'], accent: '#ffc4d1' },
  liquid:      { colors: ['#140f0a', '#d4a93f', '#241a0e'] },
  synthwave:   { colors: ['#16042e', '#a3155e'], accent: '#ff2d95' },
  eclipse:     { colors: ['#05060d', '#0a0d18'], accent: '#ffdf8a' },
  matrix:      { colors: ['#010a04', '#04220e'], accent: '#00ff41' },
  dusk:        { colors: ['#1c1440', '#c2542e', '#ffb14a'] },
  thunder:     { colors: ['#0b0918', '#2a2440'], accent: '#dcd2ff' },
  nebula:      { colors: ['#070314', '#13042a'], accent: '#b14ad9' },
  embers:      { colors: ['#0a0f0a', '#04140e'], accent: '#ffcf7a' },
  meteor:      { colors: ['#060814', '#0e1430'], accent: '#cfe0ff' },
  plasma:      { colors: ['#0b0518', '#04030f'], accent: '#7a2ad9' },
  blizzard:    { colors: ['#1a2a3e', '#0a1420'], accent: '#cfe6ff' },
  prism:       { colors: ['#0a0a14', '#141020'], accent: '#ff6b9d' },
};

function StaticBg({ v, style, children }: BgProps) {
  const styleId = v.style as string | undefined;
  // An image background is already cheap (one static texture, no drivers), so
  // the "static" grid variant just renders the real thing.
  if (styleId === 'image') return <ImageBg v={v} style={style}>{children}</ImageBg>;
  const def = (styleId && STATIC_BG[styleId]) || { colors: [v.from ?? C.bg, v.to ?? '#1a1a1a'] } as { colors: string[]; diag?: boolean; accent?: string };
  const base = def.colors.length >= 2 ? def.colors : [def.colors[0], def.colors[0]];
  const colors = base as readonly string[] as readonly [string, string, ...string[]];
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }} end={def.diag ? { x: 1, y: 1 } : { x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {def.accent ? (
        <View pointerEvents="none" style={{
          position: 'absolute', top: '24%', left: '26%', width: '60%', height: '60%',
          borderRadius: 999, backgroundColor: def.accent, opacity: 0.3,
        }} />
      ) : null}
      {children}
    </View>
  );
}

// Bundled background images. Drop a file in mobile/assets/backgrounds/ and add
// its key here, then a cosmetic can use {"style":"image","asset":"<key>"}.
// Remote images use {"style":"image","uri":"https://…"} and need NO entry here
// (and no app rebuild — they're data-driven straight from the DB row).
const BG_ASSETS: Record<string, any> = {
  america: require('../assets/backgrounds/america.jpg'),
};

/**
 * Photo / illustration background — for when a cosmetic is a real rendered
 * image (e.g. an AI poster) rather than generated vector art. Cover-crops to
 * fill the frame; a soft vignette keeps foreground text legible (disable with
 * "dim":false). Source resolves from visual_data:
 *   {"style":"image","uri":"https://…"}   → remote, no rebuild, ships via DB
 *   {"style":"image","asset":"america"}    → bundled, needs a BG_ASSETS entry
 */
function ImageBg({ v, style, children }: BgProps) {
  const src = typeof v.uri === 'string' ? { uri: v.uri }
            : (typeof v.asset === 'string' && BG_ASSETS[v.asset]) ? BG_ASSETS[v.asset]
            : null;
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: C.card }, style]}>
      {src && <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" />}
      {v.dim !== false && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.14)' }]} />
      )}
      {children}
    </View>
  );
}

export function CosmeticBackground({
  visual, style, children, animated = true,
}: {
  visual: VisualData;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  /** false → render a cheap static swatch (no animation drivers). Use in grids
   *  that show many backgrounds at once. Defaults to true (full animation). */
  animated?: boolean;
}) {
  const v = visual ?? {};
  const styleId = v.style as string | undefined;

  if (!animated) return <StaticBg v={v} style={style}>{children}</StaticBg>;

  switch (styleId) {
    case 'gradient':    return <GradientBg     v={v} style={style}>{children}</GradientBg>;
    case 'image':       return <ImageBg        v={v} style={style}>{children}</ImageBg>;
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
    case 'nebula':      return <NebulaBg       v={v} style={style}>{children}</NebulaBg>;
    case 'embers':      return <EmbersBg       v={v} style={style}>{children}</EmbersBg>;
    case 'meteor':      return <MeteorBg       v={v} style={style}>{children}</MeteorBg>;
    case 'plasma':      return <PlasmaBg       v={v} style={style}>{children}</PlasmaBg>;
    case 'blizzard':
    case 'snow':        return <BlizzardBg     v={v} style={style}>{children}</BlizzardBg>;
    case 'prism':       return <PrismBg        v={v} style={style}>{children}</PrismBg>;
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
  const from = v.from ?? '#000';
  const to = v.to ?? '#222';
  // 3-stop grade: a slightly lifted mid and a darker floor give the flat
  // gradient body instead of a single linear ramp.
  const mid = shade(to, -0.08);
  const accent = v.accent ?? C.gold;
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[from, mid, shade(to, -0.12)] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Two large radial blooms breathing out of phase add depth + life. */}
      <BreathingGlow cx="22%" cy="26%" r={150} color={accent} periodMs={9000} min={0.08} max={0.2} />
      <BreathingGlow cx="82%" cy="78%" r={170} color={shade(accent, 0.1)} periodMs={11000} min={0.06} max={0.16} delay={1400} />
      {/* A slow diagonal sheen sweeping across so it never reads as static. */}
      <SheenSweep color={`${accent}`} durationMs={8000} opacity={0.12} />
      {/* A few drifting motes for foreground life. */}
      <SparkleField count={10} color={shade(accent, 0.2)} durationMs={3200} />
      <Vignette opacity={0.42} />
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

/** Cloth wave shape — used ONLY at bake time now (plain JS, not a worklet).
 *  Amplitude grows toward the fly, like real cloth pinned at the hoist. */
function flagWaveOffset(x: number, t: number): number {
  const fx = x / FLAG_VB_W;
  const amp = (0.25 + 0.75 * fx) * 17;
  return amp * (0.72 * Math.sin(fx * Math.PI * 2 * 1.3 - t) + 0.28 * Math.sin(fx * Math.PI * 2 * 2.7 - t * 1.7));
}

// ── Flag static-geometry bake ────────────────────────────────────────────────
// PERF REWRITE: the flag used to animate 15 SVG path `d` strings per frame
// (13 stripes + canton + one 50-star path ≈ 1,500 toFixed calls and ~15KB of
// path text per frame), and every update forced react-native-svg to re-parse
// the paths and re-rasterize the WHOLE SVG on the CPU at 60fps — the heaviest
// background in the catalog, and it visibly lagged the profile page.
//
// The remake bakes the cloth curvature into STATIC paths once at module load
// (the flag is frozen mid-wave, so it's never a flat rectangle), and creates
// all motion with GPU-composited transforms instead: fold shadow + sheen bands
// drifting across the curved cloth, plus a gentle whole-flag bob/roll. The SVG
// rasterizes once and is then composited as a cached texture — zero per-frame
// path work, zero re-rasters, nothing runs on the JS or UI thread per frame
// beyond four native-driver transform loops.
const FLAG_STRIPE_STEPS = 14;
const FLAG_STRIPE_XS: number[] = Array.from({ length: FLAG_STRIPE_STEPS + 1 }, (_, s) => (s / FLAG_STRIPE_STEPS) * FLAG_VB_W);
const FLAG_STAR_UNIT: { fx: number; fy: number }[] = (() => {
  const arr: { fx: number; fy: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const f = i % 2 === 0 ? 1 : 0.42;
    arr.push({ fx: f * Math.cos(ang), fy: f * Math.sin(ang) });
  }
  return arr;
})();
/** Trig-free 5-point star (vertices precomputed in FLAG_STAR_UNIT). */
function flagStarPath(cx: number, cy: number, r: number): string {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const u = FLAG_STAR_UNIT[i];
    d += `${i === 0 ? 'M' : 'L'}${(cx + u.fx * r).toFixed(2)} ${(cy + u.fy * r).toFixed(2)} `;
  }
  return d + 'Z ';
}

// The phase the cloth is frozen at. Chosen so the flag shows a classic S-curve
// with a slight curl at the fly — reads as "caught mid-wave", not sagging.
const FLAG_BAKE_T = 2.1;

/** All flag geometry, baked once at import: 13 stripe bands, the canton, and
 *  the 50 stars, every edge bent along the SAME wave so it reads as one sheet. */
const FLAG_STATIC: { stripes: string[]; canton: string; stars: string } = (() => {
  const t = FLAG_BAKE_T;
  const overscan = 24;
  const stripes: string[] = [];
  for (let i = 0; i < 13; i++) {
    const top = i === 0 ? -overscan : i * FLAG_STRIPE_H;
    const bot = i === 12 ? FLAG_VB_H + overscan : (i + 1) * FLAG_STRIPE_H;
    let d = '';
    for (let s = 0; s <= FLAG_STRIPE_STEPS; s++) {
      d += `${s === 0 ? 'M' : 'L'}${FLAG_STRIPE_XS[s].toFixed(1)} ${(top + flagWaveOffset(FLAG_STRIPE_XS[s], t)).toFixed(2)} `;
    }
    for (let s = FLAG_STRIPE_STEPS; s >= 0; s--) {
      d += `L${FLAG_STRIPE_XS[s].toFixed(1)} ${(bot + flagWaveOffset(FLAG_STRIPE_XS[s], t)).toFixed(2)} `;
    }
    stripes.push(d + 'Z');
  }
  // Canton: same wave, sampled on its own x-range; bottom dips 3 units past the
  // 7-stripe line so a stripe edge can never poke up through the blue.
  let canton = '';
  {
    const x0 = -overscan, x1 = FLAG_CANTON_W;
    const top = -overscan, bot = FLAG_CANTON_H + 3;
    const steps = 16;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (s / steps) * (x1 - x0);
      canton += `${s === 0 ? 'M' : 'L'}${x.toFixed(1)} ${(top + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    for (let s = steps; s >= 0; s--) {
      const x = x0 + (s / steps) * (x1 - x0);
      canton += `L${x.toFixed(1)} ${(bot + flagWaveOffset(x, t)).toFixed(2)} `;
    }
    canton += 'Z';
  }
  // Stars: each displaced by the wave at its own x so the grid curves with the
  // cloth instead of sitting on a flat block.
  let stars = '';
  for (const p of FLAG_STAR_POS) {
    stars += flagStarPath(p.cx, p.cy + flagWaveOffset(p.cx, t), FLAG_STAR_R);
  }
  return { stripes, canton, stars };
})();

// ── Americana overlay (the "loaded" 4th-of-July flag) ───────────────────────
// A drifting field of patriotic icons + a B-2 flyover, layered OVER the baked
// flag. Perf: every piece is a static glyph/SVG moved by a native-driver
// transform — same discipline as the flag itself, zero per-frame path work. The
// grid views (locker/season-pass) never hit this: they render the static swatch
// via animated={false}, so the icons only animate for the single equipped flag.

// B-2 Spirit silhouette: swept flying-wing with the signature double-W sawtooth
// trailing edge. viewBox extends left of the craft so the two vapour trails can
// stream out behind it. Drawn once, flown across the "sky" by one transform.
const B2_VIEWBOX = '-90 0 200 40';
const B2_PATH =
  'M50 7 L8 25 L18 33 L30 27 L42 33 L50 29 L58 33 L70 27 L82 33 L92 25 Z';

/** The B-2 makes a slow pass across the top of the flag every ~11s. */
function B2Flyover() {
  const { width } = useWindowDimensions();
  const fly = useSharedValue(0);
  useEffect(() => {
    fly.value = withRepeat(withTiming(1, { duration: 11000, easing: Easing.inOut(Easing.quad) }), -1, false);
    return () => cancelAnimation(fly);
  }, [fly]);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(fly.value, [0, 0.06, 0.9, 1], [0, 1, 1, 0]),
    transform: [
      { translateX: interpolate(fly.value, [0, 1], [-130, width + 130]) },
      { translateY: interpolate(fly.value, [0, 0.5, 1], [0, -7, 0]) },   // gentle porpoise
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: '13%', left: 0, width: 96, height: 34 }, st]}>
      <Svg width={96} height={34} viewBox={B2_VIEWBOX}>
        {/* vapour trails streaming behind the engines */}
        <Line x1={34} y1={30} x2={-90} y2={26} stroke="#ffffff" strokeWidth={1.4} strokeOpacity={0.16} strokeLinecap="round" />
        <Line x1={62} y1={30} x2={-90} y2={34} stroke="#ffffff" strokeWidth={1.4} strokeOpacity={0.16} strokeLinecap="round" />
        <Path d={B2_PATH} fill="#12131a" />
        {/* faint centre-body highlight so it reads as a solid craft, not a hole */}
        <Path d="M50 10 L34 22 L50 20 L66 22 Z" fill="#262838" fillOpacity={0.9} />
      </Svg>
    </Animated.View>
  );
}

// THE SCENE — a full composed "4th of July poster" over the flag, not floating
// icons: a muscular bald eagle front-and-centre hoisting a giant cheeseburger
// and a raised golf driver (the gun from the reference art would bump the App
// Store age rating; an eagle swinging a driver is also the better golf joke),
// Statues of Liberty flanking both edges, fireworks blooming in a darkened sky,
// ember glow at the base. All of it hand-built SVG in a shared 360x250 stage,
// bottom-anchored with slice-cropping so the hero survives any container shape.
// Same perf rules as the cloth: every group rasterizes ONCE; only transforms
// and opacity animate.
const SCENE_VB = '0 0 360 250';

// Firework spoke unit-vectors, precomputed once (12 rays).
const FW_DIRS: { x: number; y: number }[] = Array.from({ length: 12 }, (_, i) => {
  const a = (Math.PI * 2 * i) / 12 - Math.PI / 2;
  return { x: Math.cos(a), y: Math.sin(a) };
});

/** One firework: a static spoke burst that blooms (scale up + fade) on its own
 *  staggered loop. Pure transform/opacity — the burst SVG never re-renders. */
function FireworkBurst({ left, top, size, color, dur, delay }: {
  left: number; top: number; size: number; color: string; dur: number; delay: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    // One-way bloom: t sweeps 0→1 across the whole life (scale up, fade out),
    // then snaps back in a frame while opacity is 0. A symmetric up-then-down
    // sequence would visibly REPLAY the burst in reverse on the way down
    // (shrinking inward while re-brightening) — fireworks don't do that.
    t.value = withRepeat(
      withSequence(
        withDelay(delay, withTiming(1, { duration: dur, easing: Easing.out(Easing.quad) })),
        withTiming(0, { duration: 16 }),
      ), -1, false);
    return () => cancelAnimation(t);
  }, [t, dur, delay]);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.15, 0.8, 1], [0, 1, 0.8, 0]),
    transform: [{ scale: interpolate(t.value, [0, 1], [0.3, 1]) }],
  }));
  const r = size / 2;
  const inner = r * 0.34, outer = r * 0.86;
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: `${left}%`, top: `${top}%`, width: size, height: size, marginLeft: -r, marginTop: -r }, st]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {FW_DIRS.map((d, i) => (
          <Line key={i}
            x1={r + d.x * inner} y1={r + d.y * inner}
            x2={r + d.x * outer} y2={r + d.y * outer}
            stroke={color} strokeWidth={2} strokeLinecap="round" strokeOpacity={0.9} />
        ))}
        {FW_DIRS.map((d, i) => (
          <Circle key={`t${i}`} cx={r + d.x * outer} cy={r + d.y * outer} r={2.2} fill="#ffffff" fillOpacity={0.9} />
        ))}
        <Circle cx={r} cy={r} r={inner * 0.5} fill={color} fillOpacity={0.55} />
      </Svg>
    </Animated.View>
  );
}

/** Static supporting cast: the two Statues of Liberty (patina silhouettes with
 *  lit torches) on the flanks. One SVG, rasterized once, zero drivers. */
function AmericaStatues() {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox={SCENE_VB} preserveAspectRatio="xMidYMax slice">
      {/* Left statue (large) */}
      <G>
        <Rect x={6} y={190} width={48} height={8} rx={2} fill="#565b63" />
        <Rect x={10} y={196} width={40} height={54} fill="#6a6f76" />
        <Rect x={10} y={196} width={40} height={6} fill="#7d828a" />
        <Path d="M16 192 L24 102 C24 88 40 88 40 102 L46 192 Z" fill="#4f8f7c" />
        <Path d="M16 192 L24 102 C24 96 28 92 32 92 L30 192 Z" fill="#3a6c5e" />
        <Rect x={12} y={118} width={9} height={17} rx={2} fill="#3f7767" />
        <Path d="M32 106 L45 71 L48 72 L37 108 Z" fill="#4f8f7c" />
        <Rect x={42} y={62} width={9} height={7} rx={2} fill="#c9a24a" />
        <Circle cx={46.5} cy={56} r={9} fill="#ffd76a" opacity={0.28} />
        <Path d="M46.5 48 C50 53 50 58 46.5 61 C43 58 43 53 46.5 48 Z" fill="#ffd76a" />
        <Circle cx={30} cy={92} r={7.5} fill="#4f8f7c" />
        {[-40, -20, 0, 20, 40].map((deg) => {
          const rad = ((deg - 90) * Math.PI) / 180;
          return <Line key={deg} x1={30 + Math.cos(rad) * 7} y1={92 + Math.sin(rad) * 7}
                       x2={30 + Math.cos(rad) * 13} y2={92 + Math.sin(rad) * 13}
                       stroke="#4f8f7c" strokeWidth={2.4} strokeLinecap="round" />;
        })}
      </G>
      {/* Right statue (smaller, mirrored) */}
      <G>
        <Rect x={309} y={204} width={42} height={7} rx={2} fill="#565b63" />
        <Rect x={313} y={210} width={34} height={40} fill="#6a6f76" />
        <Path d="M317 206 L323 140 C323 130 334 130 334 140 L339 206 Z" fill="#4f8f7c" />
        <Path d="M337 206 L334 140 C334 136 331 133 328 133 L330 206 Z" fill="#3a6c5e" />
        <Path d="M326 143 L315 118 L312.5 119.5 L322 145 Z" fill="#4f8f7c" />
        <Rect x={309} y={110} width={7.5} height={6} rx={2} fill="#c9a24a" />
        <Circle cx={312.5} cy={105} r={7} fill="#ffd76a" opacity={0.28} />
        <Path d="M312.5 98 C315.5 102.5 315.5 106.5 312.5 109 C309.5 106.5 309.5 102.5 312.5 98 Z" fill="#ffd76a" />
        <Circle cx={329} cy={132} r={5.5} fill="#4f8f7c" />
        {[-40, -20, 0, 20, 40].map((deg) => {
          const rad = ((deg - 90) * Math.PI) / 180;
          return <Line key={deg} x1={329 + Math.cos(rad) * 5} y1={132 + Math.sin(rad) * 5}
                       x2={329 + Math.cos(rad) * 9.5} y2={132 + Math.sin(rad) * 9.5}
                       stroke="#4f8f7c" strokeWidth={2} strokeLinecap="round" />;
        })}
      </G>
    </Svg>
  );
}

/** The hero: jacked bald eagle, giant cheeseburger, raised golf driver, jeans.
 *  One static SVG on a slow 1.2% breathe so he reads alive without ever
 *  re-rendering. Cartoon-poster styling: bold shapes, dark outlines. */
function AmericaEagle() {
  const torsoId = useBgId('eagleTorso');
  const bunId = useBgId('eagleBun');
  const breathe = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(breathe);
  }, [breathe]);
  const st = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(breathe.value, [0, 1], [1, 1.012]) }],
  }));
  const OUT = '#241708';   // cartoon outline
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      <Svg style={StyleSheet.absoluteFill} viewBox={SCENE_VB} preserveAspectRatio="xMidYMax slice">
        <Defs>
          <SvgLinearGradient id={torsoId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#6b4a30" />
            <Stop offset="1" stopColor="#3a2415" />
          </SvgLinearGradient>
          <SvgLinearGradient id={bunId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#eebc6d" />
            <Stop offset="1" stopColor="#d0964a" />
          </SvgLinearGradient>
        </Defs>

        {/* ── golf driver, raised in the right fist ── */}
        <Line x1={272} y1={64} x2={326} y2={18} stroke="#20180e" strokeWidth={7} strokeLinecap="round" />
        <Line x1={272} y1={64} x2={326} y2={18} stroke="#cdd2da" strokeWidth={4} strokeLinecap="round" />
        <Path d="M320 8 C334 4 344 12 342 22 C340 30 328 32 320 26 C314 21 314 12 320 8 Z"
              fill="#aeb6c2" stroke={OUT} strokeWidth={2} />
        <Path d="M322 11 C330 8 337 12 337 17" stroke="#eef2f7" strokeWidth={2} strokeLinecap="round" fill="none" />

        {/* ── torso + shoulders ── */}
        <Path d="M96 250 L96 162 C96 124 124 104 180 104 C236 104 264 124 264 162 L264 250 Z"
              fill={`url(#${torsoId})`} stroke={OUT} strokeWidth={2.5} />
        <Circle cx={106} cy={142} r={26} fill={`url(#${torsoId})`} stroke={OUT} strokeWidth={2.5} />
        <Circle cx={254} cy={142} r={26} fill={`url(#${torsoId})`} stroke={OUT} strokeWidth={2.5} />
        {/* pecs + chest feathering */}
        <Ellipse cx={150} cy={168} rx={27} ry={18} fill="#7a563a" opacity={0.75} />
        <Ellipse cx={212} cy={168} rx={27} ry={18} fill="#7a563a" opacity={0.75} />
        <Path d="M168 196 L180 208 L192 196" stroke="#2e1d10" strokeWidth={3} strokeLinecap="round" fill="none" opacity={0.6} />
        <Path d="M158 214 L172 226 L186 214" stroke="#2e1d10" strokeWidth={3} strokeLinecap="round" fill="none" opacity={0.45} />

        {/* ── right arm hoisting the club ── */}
        <Line x1={252} y1={148} x2={282} y2={112} stroke={OUT} strokeWidth={24} strokeLinecap="round" />
        <Line x1={252} y1={148} x2={282} y2={112} stroke="#5a3d26" strokeWidth={19} strokeLinecap="round" />
        <Line x1={282} y1={112} x2={268} y2={74} stroke={OUT} strokeWidth={20} strokeLinecap="round" />
        <Line x1={282} y1={112} x2={268} y2={74} stroke="#5a3d26" strokeWidth={15} strokeLinecap="round" />
        <Circle cx={266} cy={68} r={13} fill="#5a3d26" stroke={OUT} strokeWidth={2.5} />
        <Path d="M256 62 C253 58 255 53 260 53 L262 60 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />
        <Path d="M262 56 C261 51 265 48 269 50 L269 58 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />
        <Path d="M270 55 C271 50 276 50 278 54 L274 60 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />

        {/* ── left arm under the burger ── */}
        <Line x1={104} y1={168} x2={148} y2={206} stroke={OUT} strokeWidth={26} strokeLinecap="round" />
        <Line x1={104} y1={168} x2={148} y2={206} stroke="#5a3d26" strokeWidth={21} strokeLinecap="round" />

        {/* ── THE BURGER ── */}
        <Ellipse cx={140} cy={214} rx={50} ry={13} fill={`url(#${bunId})`} stroke={OUT} strokeWidth={2.5} />
        <Ellipse cx={140} cy={201} rx={52} ry={11} fill="#55301e" stroke={OUT} strokeWidth={2} />
        <Ellipse cx={122} cy={199} rx={5} ry={2.4} fill="#3c2013" />
        <Ellipse cx={152} cy={202} rx={5} ry={2.4} fill="#3c2013" />
        <Rect x={92} y={185} width={96} height={14} rx={7} fill="#f2b53a" stroke={OUT} strokeWidth={2} />
        <Rect x={100} y={194} width={9} height={13} rx={4.5} fill="#f2b53a" stroke={OUT} strokeWidth={1.5} />
        <Rect x={133} y={196} width={9} height={15} rx={4.5} fill="#f2b53a" stroke={OUT} strokeWidth={1.5} />
        <Rect x={164} y={194} width={9} height={12} rx={4.5} fill="#f2b53a" stroke={OUT} strokeWidth={1.5} />
        <Ellipse cx={140} cy={185} rx={50} ry={10} fill="#66381f" stroke={OUT} strokeWidth={2} />
        <Path d="M88 182 Q96 170 104 180 Q112 169 120 179 Q128 168 136 179 Q144 169 152 179 Q160 168 168 179 Q176 170 184 181 Q188 184 184 187 L92 187 Q86 186 88 182 Z"
              fill="#7fbf5a" stroke={OUT} strokeWidth={2} />
        <Path d="M92 176 C92 148 116 140 140 140 C164 140 188 148 188 176 Q140 186 92 176 Z"
              fill={`url(#${bunId})`} stroke={OUT} strokeWidth={2.5} />
        <Path d="M104 154 C112 147 128 143 140 143" stroke="#f7d9a0" strokeWidth={3.5} strokeLinecap="round" fill="none" opacity={0.8} />
        {[[112, 158], [128, 151], [146, 149], [162, 154], [174, 162], [120, 168], [152, 163]].map(([x, y], i) => (
          <Ellipse key={i} cx={x} cy={y} rx={2.6} ry={1.7} fill="#fdf3dd" transform={`rotate(-12 ${x} ${y})`} />
        ))}
        {/* talons gripping the top bun */}
        <Path d="M176 146 C182 142 188 145 187 151 L179 154 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />
        <Path d="M182 156 C189 154 193 159 190 164 L182 164 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />
        <Path d="M184 168 C191 168 193 174 189 177 L182 174 Z" fill="#d9a441" stroke={OUT} strokeWidth={1.5} />

        {/* ── neck ruff + head ── */}
        <Path d="M142 118 L152 104 L162 118 L172 104 L182 118 L192 104 L202 118 L212 106 L218 120 L218 96 L142 96 Z"
              fill="#f3f0e8" stroke={OUT} strokeWidth={2} transform="translate(-1 0)" />
        <Path d="M148 100 C144 52 158 30 180 28 C202 30 216 52 212 100 C202 110 158 110 148 100 Z"
              fill="#f3f0e8" stroke={OUT} strokeWidth={2.5} />
        <Path d="M206 56 C210 70 210 88 208 99 C213 96 214 70 211 55 Z" fill="#d8d2c4" opacity={0.9} />
        {/* angry brows */}
        <Line x1={152} y1={46} x2={173} y2={56} stroke={OUT} strokeWidth={6} strokeLinecap="round" />
        <Line x1={208} y1={46} x2={187} y2={56} stroke={OUT} strokeWidth={6} strokeLinecap="round" />
        {/* eyes: gold iris, keyed pupil */}
        <Circle cx={168} cy={61} r={5} fill="#e8b23a" stroke={OUT} strokeWidth={1.5} />
        <Circle cx={168} cy={61} r={2.2} fill="#141009" />
        <Circle cx={169} cy={60} r={0.9} fill="#ffffff" />
        <Circle cx={192} cy={61} r={5} fill="#e8b23a" stroke={OUT} strokeWidth={1.5} />
        <Circle cx={192} cy={61} r={2.2} fill="#141009" />
        <Circle cx={193} cy={60} r={0.9} fill="#ffffff" />
        {/* hooked beak */}
        <Path d="M166 66 C166 54 194 54 194 66 C194 80 188 92 180 98 C172 92 166 80 166 66 Z"
              fill="#e8b23a" stroke={OUT} strokeWidth={2.5} />
        <Path d="M180 98 C186 90 190 80 191 70 C191 82 187 93 181 98 Z" fill="#c68e26" />
        <Circle cx={174} cy={64} r={1.4} fill="#8a6218" />
        <Circle cx={186} cy={64} r={1.4} fill="#8a6218" />

        {/* ── jeans + belt at the crop line ── */}
        <Rect x={112} y={222} width={136} height={9} fill="#452c18" stroke={OUT} strokeWidth={2} />
        <Rect x={170} y={221} width={18} height={11} rx={2} fill="#d9c06a" stroke={OUT} strokeWidth={1.5} />
        <Rect x={112} y={231} width={136} height={19} fill="#3d5f8c" stroke={OUT} strokeWidth={2} />
        <Line x1={180} y1={233} x2={180} y2={250} stroke="#2c4568" strokeWidth={3} />
      </Svg>
    </Animated.View>
  );
}

/**
 * Stars & Stripes. The cloth curvature is BAKED into the static paths
 * (FLAG_STATIC — the flag is frozen mid-wave, never a flat rectangle), and all
 * the motion is GPU-composited transforms layered on top: two fold shadows and
 * a sheen drifting across the curves, a narrow fast ripple highlight, and a
 * gentle bob/roll of the whole sheet. The SVG rasterizes once and is then just
 * a cached texture — nothing rebuilds paths per frame (see the perf note above
 * FLAG_STATIC for what the old version cost).
 *
 * On top of the cloth rides THE SCENE (see SCENE_VB block above): fireworks
 * over a darkened sky, a B-2 flyover, flanking Statues of Liberty, base ember
 * glow, and the burger-and-driver eagle hero. Toggle-able via visual_data
 * `americana:false` for a plain flag, on by default.
 */
function FlagBg({ v, style, children }: BgProps) {
  const stripes: string[] = v.stripes ?? [];
  const RED = v.red ?? stripes[0] ?? '#b22234';
  const WHITE = v.white ?? stripes[1] ?? '#ffffff';
  const CANTON = v.canton ?? '#3c3b6e';
  const redId = useBgId('flagRed');     // per-instance ids (avoid collisions)
  const whiteId = useBgId('flagWhite');
  const blueId = useBgId('flagBlue');

  const foldA = useSharedValue(0);
  const foldB = useSharedValue(0);
  const ripple = useSharedValue(0);
  const bob = useSharedValue(0);
  useEffect(() => {
    foldA.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.linear }), -1, false);
    foldB.value = withRepeat(withTiming(1, { duration: 3500, easing: Easing.linear }), -1, false);
    ripple.value = withRepeat(withTiming(1, { duration: 1700, easing: Easing.linear }), -1, false);
    bob.value = withRepeat(withTiming(1, { duration: 3600, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { [foldA, foldB, ripple, bob].forEach(cancelAnimation); };
  }, [foldA, foldB, ripple, bob]);

  // The whole sheet bobs and rolls slightly — cheap whole-layer transform that
  // sells "cloth in wind" over the baked curves. Scale overscans a touch so the
  // rotation can never expose the container edges.
  const cloth = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(bob.value, [0, 1], [-3, 3]) },
      { rotate: `${interpolate(bob.value, [0, 1], [-0.5, 0.5])}deg` },
      { scale: interpolate(bob.value, [0, 0.5, 1], [1.03, 1.045, 1.03]) },
    ],
  }));

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
  // Narrow, faster highlight chasing across the cloth — the "gust" pass that
  // keeps the flag feeling alive between the slow fold cycles.
  const rippleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ripple.value, [0, 0.12, 0.88, 1], [0, 1, 1, 0]),
    transform: [
      { translateX: interpolate(ripple.value, [0, 1], [-340, 360]) },
      { translateY: interpolate(ripple.value, [0, 0.5, 1], [4, -4, 4]) },
    ],
  }));

  return (
    <View style={[{ overflow: 'hidden', backgroundColor: shade(RED, -0.3) }, style]}>
      {/* Static SVG (rasterized once): stripes + canton + stars, pre-bent along
          one shared wave so the whole flag reads as a single sheet of cloth. */}
      <Animated.View style={[StyleSheet.absoluteFill, cloth]}>
        <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${FLAG_VB_W} ${FLAG_VB_H}`} preserveAspectRatio="none">
          <Defs>
            <SvgLinearGradient id={redId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={shade(RED, -0.26)} />
              <Stop offset="0.5" stopColor={RED} />
              <Stop offset="1" stopColor={shade(RED, -0.4)} />
            </SvgLinearGradient>
            <SvgLinearGradient id={whiteId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={shade(WHITE, -0.14)} />
              <Stop offset="0.5" stopColor={WHITE} />
              <Stop offset="1" stopColor={shade(WHITE, -0.22)} />
            </SvgLinearGradient>
            <SvgLinearGradient id={blueId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={shade(CANTON, 0.12)} />
              <Stop offset="0.55" stopColor={CANTON} />
              <Stop offset="1" stopColor={shade(CANTON, -0.24)} />
            </SvgLinearGradient>
          </Defs>
          {FLAG_STATIC.stripes.map((d, i) => (
            <Path key={i} d={d} fill={i % 2 === 0 ? `url(#${redId})` : `url(#${whiteId})`} />
          ))}
          <Path d={FLAG_STATIC.canton} fill={`url(#${blueId})`} />
          <Path d={FLAG_STATIC.stars} fill="#ffffff" />
        </Svg>
      </Animated.View>

      {/* Drifting fold shadows + highlights for 3-D cloth depth — these moving
          light bands over the static curves are what create the waving. */}
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
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, rippleStyle]}>
        <LinearGradient
          colors={['transparent', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.16)', 'rgba(255,255,255,0.05)', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ width: '14%', height: '100%' }}
        />
      </Animated.View>

      {/* THE SCENE: darkened firework sky, B-2 pass, flanking Statues of
          Liberty, ember glow, and the burger-hoisting eagle up front. */}
      {v.americana !== false && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {/* Night falls over the top of the flag so the fireworks read. */}
          <LinearGradient
            colors={['rgba(6,10,30,0.78)', 'rgba(6,10,30,0.35)', 'transparent'] as const as readonly [string, string, ...string[]]}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '48%' }}
          />
          <B2Flyover />
          <FireworkBurst left={18} top={14} size={84} color="#ffd76a" dur={3600} delay={0} />
          <FireworkBurst left={50} top={9}  size={96} color="#ff6a5c" dur={4200} delay={1400} />
          <FireworkBurst left={83} top={16} size={78} color="#9ec2ff" dur={3300} delay={800} />
          <FireworkBurst left={33} top={24} size={58} color="#ff9d5c" dur={2900} delay={2300} />
          <AmericaStatues />
          {/* Firelight rising from the base, like the reference art. */}
          <LinearGradient
            colors={['transparent', 'rgba(255,110,26,0.16)', 'rgba(255,110,26,0.34)'] as const as readonly [string, string, ...string[]]}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '30%' }}
          />
          <AmericaEagle />
        </View>
      )}

      {/* Vignette so the flag doesn't fight foreground text */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.14)' }]} />
      {children}
    </View>
  );
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
    opacity: interpolate(flash.value, [0, 1], [0, 0.5]),
  }));
  // The ground glow is COUPLED to the same flash driver so the floor lights up
  // in sync with the strike (it used to be an independent wash).
  const groundStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flash.value, [0, 1], [0, 0.42]),
  }));
  const boltAProps = useAnimatedProps(() => ({ opacity: bolt1.value }));
  const boltBProps = useAnimatedProps(() => ({ opacity: bolt2.value }));

  // Forked bolts (main channel + a branch each, as subpaths of one path).
  const BOLT_A = 'M30 0 L25 60 L35 70 L20 130 L32 140 L18 200 M25 62 L13 96 M20 132 L31 158';
  const BOLT_B = 'M72 10 L68 50 L78 58 L65 110 L75 120 L62 180 M68 52 L82 84';
  const rim = v.flash ?? '#7a96d9';

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a0f1c', '#161c30', v.to ?? '#26304a'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Roiling storm clouds drifting across (parallax) */}
      <DriftingCloud top="5%"  width={160} dur={42000} delay={0}    color="rgba(120,140,180,0.18)" />
      <DriftingCloud top="15%" width={115} dur={32000} delay={6000} color="rgba(150,168,200,0.14)" />
      {/* Driving rain, two staggered layers */}
      <RainLayer dur={900}  delay={0}   opacity={0.26} />
      <RainLayer dur={1250} delay={400} opacity={0.16} />
      {/* Lightning bolts — a fat soft-blue glow underlay under a crisp bright core */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 200">
        <AnimatedPath d={BOLT_A} stroke="#6f86ff" strokeWidth="4.5" strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" fill="none" animatedProps={boltAProps} />
        <AnimatedPath d={BOLT_A} stroke="#eaf0ff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" animatedProps={boltAProps} />
        <AnimatedPath d={BOLT_B} stroke="#6f86ff" strokeWidth="4"   strokeOpacity={0.32} strokeLinecap="round" strokeLinejoin="round" fill="none" animatedProps={boltBProps} />
        <AnimatedPath d={BOLT_B} stroke="#e4ecff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" animatedProps={boltBProps} />
      </Svg>
      {/* Ground glow rising on each strike */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, groundStyle]}>
        <LinearGradient
          colors={['transparent', 'transparent', `${rim}aa`] as const as readonly [string, string, ...string[]]}
          locations={[0, 0.62, 1]}
          start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* Sheet-lightning wash */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, flashStyle, { backgroundColor: v.flash ?? '#cad9ff' }]} />
      <Vignette opacity={0.4} />
      {children}
    </View>
  );
}

// ── 4. Aurora (drifting bands) ──────────────────────────────────────────────

function AuroraBg({ v, style, children }: BgProps) {
  const layers: string[] = v.layers ?? ['#00ff9d', '#7fa2ff', '#c779ff'];
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#04161e', '#06202e', '#020a12'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Starfield behind the curtains */}
      <SparkleField count={16} color="#cfe6ff" durationMs={2600} />
      {/* Hanging aurora curtains with undulating tops */}
      {layers.map((c, i) => <AuroraCurtain key={i} color={c} index={i} total={layers.length} />)}
      {/* Faint reflection of the aurora glow on the ground haze */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', `${layers[0]}1f`] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.7 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

/** Builds the wavy top edge of a hanging aurora curtain (filled to the bottom).
 *  Worklet-safe so it can be rebuilt per frame inside useAnimatedProps. */
function auroraCurtainPath(t: number, W: number, baseTop: number, amp: number): string {
  'worklet';
  const steps = 8;
  const phase = t * Math.PI * 2;
  let d = `M0 100 L0 ${(baseTop + Math.sin(phase) * amp).toFixed(1)} `;
  for (let i = 1; i <= steps; i++) {
    const x = (W * i) / steps;
    const y = baseTop + Math.sin(phase + (i / steps) * Math.PI * 3) * amp;
    d += `L${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return d + `L${W} 100 Z`;
}

function AuroraCurtain({ color, index, total }: { color: string; index: number; total: number }) {
  const wave = useSharedValue(0);
  const drift = useSharedValue(0);
  useEffect(() => {
    wave.value = withRepeat(withTiming(1, { duration: 7000 + index * 1500, easing: Easing.inOut(Easing.sin) }), -1, true);
    drift.value = withRepeat(withTiming(1, { duration: 9000 + index * 2000, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(wave); cancelAnimation(drift); };
  }, [wave, drift, index]);

  const W = 70;
  const baseTop = 16 + index * 7;
  const amp = 10;
  const gid = useBgId('aurc');
  const pathProps = useAnimatedProps(() => ({ d: auroraCurtainPath(wave.value, W, baseTop, amp) }));
  const driftStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(drift.value, [0, 1], [-24, 24]) }],
    opacity: interpolate(wave.value, [0, 0.5, 1], [0.4, 0.72, 0.4]),
  }));

  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', left: `${(index / total) * 70}%` as any, top: 0, bottom: 0, width: `${W}%` as any },
      driftStyle,
    ]}>
      <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${W} 100`} preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity="0" />
            <Stop offset="0.15" stopColor={color} stopOpacity="0.85" />
            <Stop offset="0.6" stopColor={color} stopOpacity="0.3" />
            <Stop offset="1" stopColor={color} stopOpacity="0" />
          </SvgLinearGradient>
        </Defs>
        <AnimatedPath animatedProps={pathProps as any} fill={`url(#${gid})`} />
        {/* Inner vertical ray slivers shimmering within the curtain */}
        {[0.2, 0.4, 0.6, 0.8].map((fx, i) => (
          <Line key={i} x1={W * fx} y1={baseTop} x2={W * fx} y2={100} stroke={color} strokeOpacity={0.16} strokeWidth={0.5} />
        ))}
      </Svg>
    </Animated.View>
  );
}

// ── 5. Cosmic (twinkling stars + nebula) ────────────────────────────────────

function StarsBg({ v, style, children }: BgProps) {
  // Two depth layers: small dim far stars + larger bright near stars, with a
  // touch of colour temperature variety.
  const far = useMemo(() => Array.from({ length: 40 }, () => ({
    cx: Math.random() * 100, cy: Math.random() * 100, r: Math.random() * 0.7 + 0.2,
    delay: Math.random() * 2500, duration: TIMING.star + Math.random() * 1800,
  })), []);
  const near = useMemo(() => Array.from({ length: 70 }, () => ({
    cx: Math.random() * 100, cy: Math.random() * 100, r: Math.random() * 1.3 + 0.5,
    delay: Math.random() * 2000, duration: TIMING.star + Math.random() * 1200,
    color: Math.random() < 0.18 ? (Math.random() < 0.5 ? '#ffd9c4' : '#cfe0ff') : '#ffffff',
  })), []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#040515', '#0a0828', v.to ?? '#1a0a3a'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Faint Milky-Way band cutting diagonally across */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', 'rgba(150,130,210,0.12)', 'transparent'] as const as readonly [string, string, ...string[]]}
        locations={[0.3, 0.5, 0.7]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Soft drifting nebulae with real radial falloff (was two flat coins) */}
      <BreathingGlow cx="20%" cy="24%" r={130} color="#7a3ab5" periodMs={9000} min={0.12} max={0.24} />
      <BreathingGlow cx="82%" cy="74%" r={110} color="#3a6bb5" periodMs={11000} min={0.12} max={0.22} delay={1500} />
      <BreathingGlow cx="60%" cy="40%" r={90} color="#b53a7a" periodMs={13000} min={0.06} max={0.14} delay={3000} />
      {/* Far + near star layers */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {far.map((s, i) => <TwinklingStar key={`f${i}`} {...s} color="#bcd0ff" />)}
        {near.map((s, i) => <TwinklingStar key={`n${i}`} {...s} />)}
      </Svg>
      {/* Occasional shooting stars */}
      <Meteor top={12} left={70} delay={2000} dur={1100} len={90} color="#dfeaff" scale={1.1} />
      <Meteor top={30} left={88} delay={6500} dur={1300} len={70} color="#ffe9c4" scale={0.9} />
      {children}
    </View>
  );
}

function TwinklingStar({ cx, cy, r, delay, duration, color = '#ffffff' }: {
  cx: number; cy: number; r: number; delay: number; duration: number; color?: string;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration }), -1, true));
    return () => cancelAnimation(t);
  }, [t, delay, duration]);
  const animatedProps = useAnimatedProps(() => ({
    opacity: interpolate(t.value, [0, 1], [0.25, 1]),
    r: interpolate(t.value, [0, 1], [r * 0.6, r * 1.2]),
  }));
  return <AnimatedCircle cx={cx} cy={cy} r={r} fill={color} animatedProps={animatedProps} />;
}

// ── 6. Flame / Fire (rising wisps) ──────────────────────────────────────────

function FlameBg({ v, style, children }: BgProps) {
  const accent = v.accent ?? '#ffb14a';
  const ember = useSharedValue(0);
  useEffect(() => {
    ember.value = withRepeat(withTiming(1, { duration: 600, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(ember);
  }, [ember]);
  const emberStyle = useAnimatedStyle(() => ({ opacity: interpolate(ember.value, [0, 1], [0.4, 0.62]) }));
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#160503', '#3a0c08', v.to ?? '#5e1a14'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Two-tone fire body glowing up from the base */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', `${accent}33`, `${accent}66`] as const as readonly [string, string, ...string[]]}
        locations={[0.4, 0.75, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Flickering bottom ember glow */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, emberStyle]}>
        <LinearGradient
          colors={['transparent', accent] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0.55 }} end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* Flame tongues that lick and waver */}
      {Array.from({ length: 8 }).map((_, i) => <FlameTongue key={i} index={i} accent={accent} hot="#ffd27a" />)}
      {/* Rising ember sparks */}
      {Array.from({ length: 14 }).map((_, i) => <EmberSpark key={i} index={i} color="#ffcf7a" />)}
      <Vignette color="#1a0402" opacity={0.5} />
      {children}
    </View>
  );
}

/** A teardrop flame shape in a w×h box, tip at top centre wavering by `sway`.
 *  Worklet-safe (rebuilt per frame for the flicker). */
function flamePath(sway: number, h: number, w: number): string {
  'worklet';
  const cx = w / 2;
  const tipX = cx + sway;
  return `M${cx} ${h} `
    + `C${(cx - w * 0.5).toFixed(1)} ${(h * 0.7).toFixed(1)} ${(cx - w * 0.4).toFixed(1)} ${(h * 0.3).toFixed(1)} ${tipX.toFixed(1)} 0 `
    + `C${(cx + w * 0.4).toFixed(1)} ${(h * 0.3).toFixed(1)} ${(cx + w * 0.5).toFixed(1)} ${(h * 0.7).toFixed(1)} ${cx} ${h} Z`;
}

function FlameTongue({ index, accent, hot }: { index: number; accent: string; hot: string }) {
  const rise = useSharedValue(0);
  const flick = useSharedValue(0);
  const left = useMemo(() => `${8 + index * 11 + Math.random() * 5}%`, [index]);
  const w = useMemo(() => 30 + Math.random() * 20, []);
  const h = useMemo(() => 60 + Math.random() * 40, []);
  const dur = useMemo(() => 1500 + Math.random() * 1100, []);
  const flickDur = useMemo(() => 280 + Math.random() * 180, []);
  const gid = useBgId('flame');
  useEffect(() => {
    rise.value = withDelay(index * 180, withRepeat(withTiming(1, { duration: dur, easing: Easing.out(Easing.quad) }), -1, false));
    flick.value = withRepeat(withTiming(1, { duration: flickDur, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(rise); cancelAnimation(flick); };
  }, [rise, flick, index, dur, flickDur]);
  const wrapStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(rise.value, [0, 1], [40, -150]) },
      { scale: interpolate(rise.value, [0, 0.35, 1], [0.4, 1, 0.55]) },
    ],
    opacity: interpolate(rise.value, [0, 0.12, 0.75, 1], [0, 0.95, 0.55, 0]),
  }));
  const pathProps = useAnimatedProps(() => ({ d: flamePath(Math.sin(flick.value * Math.PI * 2) * (w * 0.14), h, w) }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: 0, left: left as any, width: w, height: h }, wrapStyle]}>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <Defs>
          <SvgLinearGradient id={gid} x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor={accent} stopOpacity="0.95" />
            <Stop offset="0.55" stopColor={hot} stopOpacity="0.85" />
            <Stop offset="1" stopColor="#fff2c2" stopOpacity="0.4" />
          </SvgLinearGradient>
        </Defs>
        <AnimatedPath animatedProps={pathProps as any} fill={`url(#${gid})`} />
      </Svg>
    </Animated.View>
  );
}

function EmberSpark({ index, color }: { index: number; color: string }) {
  const t = useSharedValue(0);
  const left = useMemo(() => 5 + Math.random() * 90, []);
  const size = useMemo(() => 1.5 + Math.random() * 2.5, []);
  const dur = useMemo(() => 2600 + Math.random() * 2200, []);
  const sway = useMemo(() => (Math.random() - 0.5) * 40, []);
  useEffect(() => {
    t.value = withDelay(index * 220, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, index, dur]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [20, -200]) },
      { translateX: interpolate(t.value, [0, 0.5, 1], [0, sway, 0]) },
    ],
    opacity: interpolate(t.value, [0, 0.2, 0.8, 1], [0, 0.9, 0.6, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', bottom: -6, left: `${left}%`, width: size, height: size, borderRadius: size / 2, backgroundColor: color, shadowColor: color, shadowOpacity: 0.9, shadowRadius: size * 1.8 },
      aStyle,
    ]} />
  );
}

// ── 7. Holographic (rainbow shimmer) ────────────────────────────────────────

function HolographicBg({ v, style, children }: BgProps) {
  const colors = (v.colors ?? ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a', '#ff6b9d']) as readonly [string, string, ...string[]];
  const reversed = [...colors].reverse() as unknown as readonly [string, string, ...string[]];
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: TIMING.holographic }), -1, true);
    b.value = withRepeat(withTiming(1, { duration: TIMING.holographic * 1.45 }), -1, true);
    return () => { cancelAnimation(a); cancelAnimation(b); };
  }, [a, b]);

  // Two rainbow layers drift on INDEPENDENT drivers in opposite directions so
  // the spectrum shears and churns instead of sliding as one flat sheet.
  const layerA = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(a.value, [0, 1], [-34, 34]) },
      { translateY: interpolate(a.value, [0, 1], [-18, 18]) },
      { scale: interpolate(a.value, [0, 0.5, 1], [1.1, 1.25, 1.1]) },
    ],
  }));
  const layerB = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(b.value, [0, 1], [30, -30]) },
      { translateY: interpolate(b.value, [0, 1], [20, -20]) },
    ],
    opacity: interpolate(b.value, [0, 0.5, 1], [0.3, 0.5, 0.3]),
  }));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a0a14' }]} />
      <Animated.View style={[StyleSheet.absoluteFill, layerA]}>
        <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { opacity: 0.55 }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, layerB]}>
        <LinearGradient colors={reversed} start={{ x: 1, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      {/* Bright specular streak sweeping across — the foil "tilt" highlight. */}
      <SheenSweep color="rgba(255,255,255,0.6)" durationMs={2600} angle={22} opacity={0.4} />
      {/* Scattered glints catching the light. */}
      <SparkleField count={7} color="#ffffff" durationMs={2200} />
      <Vignette opacity={0.4} />
      {children}
    </View>
  );
}

// ── 8. Cyber (grid + scan line) ─────────────────────────────────────────────

const CYBER_FLOOR_H = 240;
const CYBER_CELL = 26;

function CyberBg({ v, style, children }: BgProps) {
  const scan = useSharedValue(0);
  const scan2 = useSharedValue(0);
  const floor = useSharedValue(0);
  const horizon = useSharedValue(0);
  useEffect(() => {
    scan.value = withRepeat(withTiming(1, { duration: 3000, easing: Easing.linear }), -1, false);
    scan2.value = withRepeat(withTiming(1, { duration: 1700, easing: Easing.linear }), -1, false);
    floor.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.linear }), -1, false);
    horizon.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(scan); cancelAnimation(scan2); cancelAnimation(floor); cancelAnimation(horizon); };
  }, [scan, scan2, floor, horizon]);
  const scanStyle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(scan.value, [0, 1], [0, 400]) }] }));
  const scan2Style = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(scan2.value, [0, 1], [0, 400]) }] }));
  // The near floor flows toward the viewer: a uniform line set translating one
  // cell then wrapping (seamless because the spacing is uniform).
  const floorStyle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(floor.value, [0, 1], [0, CYBER_CELL]) }] }));
  const horizonStyle = useAnimatedStyle(() => ({ opacity: interpolate(horizon.value, [0, 1], [0.5, 1]) }));

  const accent = v.accent ?? '#00ffd5';
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#02060e', '#061320', v.to ?? '#0a1e2e'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Sky: faint vertical grid in the upper half */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {Array.from({ length: 10 }).map((_, i) => (
          <Line key={`v${i}`} x1={i * 10} y1={0} x2={i * 10} y2={50} stroke={accent} strokeOpacity="0.1" strokeWidth="0.2" />
        ))}
        {/* Perspective floor verticals fanning from the vanishing point */}
        {[-70, -34, -12, 6, 22, 40, 64, 112, 134, 170].map((endX, i) => (
          <Line key={`p${i}`} x1={50} y1={50} x2={endX} y2={100} stroke={accent} strokeOpacity="0.22" strokeWidth="0.25" />
        ))}
      </Svg>
      {/* Near floor: uniform horizontal lines flowing toward the viewer */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: CYBER_FLOOR_H, overflow: 'hidden' }}>
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, height: CYBER_FLOOR_H + CYBER_CELL }, floorStyle]}>
          {Array.from({ length: Math.ceil(CYBER_FLOOR_H / CYBER_CELL) + 2 }).map((_, i) => (
            <View key={i} style={{ position: 'absolute', left: 0, right: 0, top: i * CYBER_CELL, height: 1, backgroundColor: accent, opacity: 0.16 }} />
          ))}
        </Animated.View>
      </View>
      {/* Depth fog over the far floor for distance */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', `${accent}14`, 'transparent'] as const as readonly [string, string, ...string[]]}
        locations={[0.5, 0.72, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Horizon glow bar */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: '50%', height: 2, marginTop: -1, backgroundColor: accent, shadowColor: accent, shadowOpacity: 0.9, shadowRadius: 8 }, horizonStyle]} />
      {/* Two scan lines (slow wide + fast thin) */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, height: 60, top: -60 }, scanStyle]}>
        <LinearGradient colors={['transparent', accent + '40', 'transparent'] as const as readonly [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, height: 22, top: -22 }, scan2Style]}>
        <LinearGradient colors={['transparent', accent + '2a', 'transparent'] as const as readonly [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      {/* Rising data motes */}
      <SparkleField count={9} color={accent} durationMs={2400} />
      {children}
    </View>
  );
}

// ── 9. Solar Flare (pulsing sun core + counter-rotating rays + prominences) ──

function SolarBg({ v, style, children }: BgProps) {
  const coreId = useBgId('solarCore');   // per-instance gradient id (avoid collisions)
  const rot   = useSharedValue(0);   // outer long rays
  const rot2  = useSharedValue(0);   // inner rays (counter-rotating)
  const pulse = useSharedValue(0);   // sun core flare / breathe
  const flare = useSharedValue(0);   // prominence flicker
  useEffect(() => {
    rot.value   = withRepeat(withTiming(1, { duration: 26000, easing: Easing.linear }), -1, false);
    rot2.value  = withRepeat(withTiming(1, { duration: 17000, easing: Easing.linear }), -1, false);
    pulse.value = withRepeat(withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }), -1, true);
    flare.value = withRepeat(withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(rot); cancelAnimation(rot2); cancelAnimation(pulse); cancelAnimation(flare); };
  }, [rot, rot2, pulse, flare]);

  const raysOutStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${interpolate(rot.value,  [0, 1], [0, 360])}deg` }] }));
  const raysInStyle  = useAnimatedStyle(() => ({ transform: [{ rotate: `${interpolate(rot2.value, [0, 1], [360, 0])}deg` }] }));
  // The sun itself now lives — it breathes (scale) and brightens (opacity).
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 1.09]) }],
    opacity: interpolate(pulse.value, [0, 1], [0.88, 1]),
  }));
  // Prominences flicker and slowly rotate with the sun.
  const promStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flare.value, [0, 1], [0.3, 0.85]),
    transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }],
  }));

  const accent = v.accent ?? '#ffb14a';
  const core   = v.core   ?? '#fff3a8';

  // Solar prominences — bright loops erupting off the rim. Static geometry,
  // memoised; animated via promStyle so it never re-rolls on render.
  const proms = useMemo(() => {
    const rad = (d: number) => (d * Math.PI) / 180;
    return [25, 120, 205, 300].map((a) => {
      const w = 13, r0 = 17, r1 = 31;
      const p1x = Math.cos(rad(a - w)) * r0, p1y = Math.sin(rad(a - w)) * r0;
      const p2x = Math.cos(rad(a + w)) * r0, p2y = Math.sin(rad(a + w)) * r0;
      const cx  = Math.cos(rad(a)) * r1,     cy  = Math.sin(rad(a)) * r1;
      return `M ${p1x.toFixed(2)} ${p1y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${p2x.toFixed(2)} ${p2y.toFixed(2)}`;
    });
  }, []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#2a0d05', v.to ?? '#0a0204'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Outer long rays — slow rotation */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, raysOutStyle]}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 24 }).map((_, i) => {
            const ang = (i * (360 / 24)) * (Math.PI / 180);
            return <Line key={i}
              x1={Math.cos(ang) * 16} y1={Math.sin(ang) * 16}
              x2={Math.cos(ang) * 60} y2={Math.sin(ang) * 60}
              stroke={accent} strokeOpacity="0.3" strokeWidth="0.8" strokeLinecap="round" />;
          })}
        </Svg>
      </Animated.View>

      {/* Inner short rays — faster counter-rotation, brighter */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, raysInStyle]}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 16 }).map((_, i) => {
            const ang = ((i + 0.5) * (360 / 16)) * (Math.PI / 180);
            return <Line key={i}
              x1={Math.cos(ang) * 14} y1={Math.sin(ang) * 14}
              x2={Math.cos(ang) * 34} y2={Math.sin(ang) * 34}
              stroke={core} strokeOpacity="0.45" strokeWidth="1.1" strokeLinecap="round" />;
          })}
        </Svg>
      </Animated.View>

      {/* Pulsing sun core — hot white center flaring out to the accent */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, coreStyle]}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          <Defs>
            {/* userSpaceOnUse: coords are viewBox units (objectBoundingBox
                would wash the gradient out). */}
            <RadialGradient id={coreId} cx="0" cy="0" r="34" fx="0" fy="0" gradientUnits="userSpaceOnUse">
              <Stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
              <Stop offset="20%"  stopColor={core}    stopOpacity="0.95" />
              <Stop offset="52%"  stopColor={accent}  stopOpacity="0.6" />
              <Stop offset="100%" stopColor={accent}  stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={0} cy={0} r={50} fill={`url(#${coreId})`} />
        </Svg>
      </Animated.View>

      {/* Solar prominences — flickering loops off the rim */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, promStyle]}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          {proms.map((d, i) => (
            <Path key={i} d={d} fill="none" stroke={core} strokeOpacity="0.8" strokeWidth="1.4" strokeLinecap="round" />
          ))}
        </Svg>
      </Animated.View>

      {children}
    </View>
  );
}

// ── 10. Ocean (rolling waves) ────────────────────────────────────────────────

// One rolling wave band. The wave path has period 300; translating by exactly
// ±300 (one period) and wrapping makes the drift seamless (no pop), and a
// gentle vertical bob on a separate driver gives it swell.
function WaveLayer({ bottom, height, color, opacity, dur, dir, bobDur, amp }: {
  bottom: any; height: number; color: string; opacity: number; dur: number; dir: number; bobDur: number; amp: number;
}) {
  const t = useSharedValue(0);
  const bob = useSharedValue(0);
  useEffect(() => {
    // YOYO + sine easing: the band laps left and back with the velocity easing
    // to zero at each extreme, so there is NO snap-back seam (a one-directional
    // wrap can't be seamless here because the px translate and the stretched
    // viewBox period don't match).
    t.value = withRepeat(withTiming(1, { duration: dur, easing: Easing.inOut(Easing.sin) }), -1, true);
    bob.value = withRepeat(withTiming(1, { duration: bobDur, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(t); cancelAnimation(bob); };
  }, [t, bob, dur, bobDur]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(t.value, [0, 1], [dir * -150, dir * 150]) },
      { translateY: interpolate(bob.value, [0, 0.5, 1], [0, amp, 0]) },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom, left: -260, right: -260, height }, aStyle]}>
      <Svg viewBox="0 0 600 80" width="100%" height={height} preserveAspectRatio="none">
        {/* Periodic crest/trough profile (period 150) reads as rolling swell. */}
        <Path d="M0 40 Q75 20 150 40 T300 40 T450 40 T600 40 V80 H0 Z" fill={color} opacity={opacity} />
      </Svg>
    </Animated.View>
  );
}

function OceanBg({ v, style, children }: BgProps) {
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a1e3a', '#0a2742', v.to ?? '#041d33'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* God-rays slanting down from the surface */}
      <LinearGradient
        pointerEvents="none"
        colors={[`${v.accent ?? '#5aacd9'}22`, 'transparent'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0.3, y: 0 }} end={{ x: 0.7, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.7 }]}
      />
      {/* Surface caustic shimmer */}
      <SparkleField count={10} color="#bfe7fb" durationMs={2800} />
      {/* Four parallax wave bands, dark + slow at the back to light + quick up front */}
      <WaveLayer bottom="40%" height={70} color="#2a6a99" opacity={0.35} dur={11000} dir={-1} bobDur={5000} amp={5} />
      <WaveLayer bottom="30%" height={80} color={v.accent ?? '#3d8bbf'} opacity={0.45} dur={9000} dir={1} bobDur={4200} amp={6} />
      <WaveLayer bottom="17%" height={90} color={v.accent ?? '#5aacd9'} opacity={0.55} dur={7000} dir={-1} bobDur={3600} amp={7} />
      <WaveLayer bottom="11%" height={64} color="#9fd8f0" opacity={0.4} dur={6000} dir={1} bobDur={3000} amp={4} />
      {/* Deep fog at the floor */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', 'rgba(2,12,24,0.6)'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.6 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

// ── 11. Sakura (falling petals) ─────────────────────────────────────────────

const SAKURA_PINKS = ['#ffc4d1', '#ffd9e2', '#ff9fc0', '#ffe0ec'];

function SakuraBg({ v, style, children }: BgProps) {
  const near = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
    left: `${(i * 7.3 + Math.random() * 6) % 100}%`,
    delay: Math.random() * 4000, dur: 4500 + Math.random() * 3500,
    size: 7 + Math.random() * 6, drift: (Math.random() - 0.5) * 60,
    color: SAKURA_PINKS[Math.floor(Math.random() * SAKURA_PINKS.length)], far: false,
  })), []);
  const far = useMemo(() => Array.from({ length: 10 }, (_, i) => ({
    left: `${(i * 11 + Math.random() * 6) % 100}%`,
    delay: Math.random() * 5000, dur: 6500 + Math.random() * 4000,
    size: 4 + Math.random() * 3, drift: (Math.random() - 0.5) * 40,
    color: '#ffd0dc', far: true,
  })), []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#3a1a2a', '#5e2a44', v.to ?? '#7a3a55'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Soft warm sky bloom */}
      <BreathingGlow cx="74%" cy="22%" r={110} color="#ffb6c9" periodMs={8000} min={0.12} max={0.22} />
      {/* Far petals drift slower for parallax */}
      {far.map((p, i) => <Petal key={`f${i}`} {...p} />)}
      {/* Blossom branch reaching in from the top-left */}
      <Svg pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: '60%', height: '34%' }} viewBox="0 0 100 60" preserveAspectRatio="none">
        <Path d="M0 6 Q 22 10 38 4 Q 50 0 62 8" stroke="#2a1018" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <Path d="M30 6 Q 36 16 30 24" stroke="#2a1018" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        {[[12, 6], [26, 5], [40, 4], [33, 20], [55, 8]].map(([cx, cy], i) => (
          <Circle key={i} cx={cx} cy={cy} r={2.2} fill="#ffd0dc" opacity={0.9} />
        ))}
      </Svg>
      {/* Near petals */}
      {near.map((p, i) => <Petal key={`n${i}`} {...p} />)}
      {/* Ground mist */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', '#ffd9e233'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.8 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

function Petal({ left, delay, dur, size, drift, color = '#ffc4d1', far = false }: {
  left: any; delay: number; dur: number; size: number; drift: number; color?: string; far?: boolean;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay, dur]);
  const peak = far ? 0.6 : 1;
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [-30, 600]) },
      { translateX: interpolate(t.value, [0, 0.5, 1], [0, drift, drift * 2]) },
      { rotate: `${interpolate(t.value, [0, 1], [0, 540])}deg` },
      { scaleX: Math.cos(interpolate(t.value, [0, 1], [0, Math.PI * 2 * 3])) }, // twist edge-on
    ],
    opacity: interpolate(t.value, [0, 0.1, 0.9, 1], [0, peak, peak, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', top: 0, left, width: size, height: size, backgroundColor: color, borderRadius: size / 2, borderTopLeftRadius: 1 },
      animStyle,
    ]} />
  );
}

// ── 12. Liquid Gold (shifting molten gradient) ──────────────────────────────

function LiquidGoldBg({ v, style, children }: BgProps) {
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  const hot = useSharedValue(0);
  const hotId = useBgId('liqhot');
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: 6500, easing: Easing.inOut(Easing.sin) }), -1, true);
    b.value = withRepeat(withTiming(1, { duration: 8200, easing: Easing.inOut(Easing.sin) }), -1, true);
    hot.value = withRepeat(withTiming(1, { duration: 7000, easing: Easing.linear }), -1, false);
    return () => { cancelAnimation(a); cancelAnimation(b); cancelAnimation(hot); };
  }, [a, b, hot]);
  // Primary molten band: bigger travel + a slow rotate + a vertical breathe.
  const bandA = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(a.value, [0, 1], [-30, 60]) },
      { rotate: `${interpolate(a.value, [0, 1], [-6, 6])}deg` },
      { scaleY: interpolate(a.value, [0, 0.5, 1], [1, 1.18, 1]) },
    ],
  }));
  // Counter-moving second band at a different angle, so the two streams cross
  // and interfere like real molten metal instead of one stripe sliding.
  const bandB = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(b.value, [0, 1], [70, -40]) },
      { translateX: interpolate(b.value, [0, 1], [-30, 30]) },
      { rotate: '32deg' },
    ],
    opacity: interpolate(b.value, [0, 0.5, 1], [0.35, 0.6, 0.35]),
  }));
  // A bright specular hotspot roaming a Lissajous path across the surface.
  const hotStyle = useAnimatedStyle(() => {
    const sx = Math.sin(hot.value * Math.PI * 2);
    const sy = Math.sin(hot.value * Math.PI * 2 * 1.4 + 1);
    return { transform: [{ translateX: sx * 80 }, { translateY: sy * 90 }] };
  });
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={['#140f0a', '#3a2a14', '#241a0e'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={[StyleSheet.absoluteFill, bandA]}>
        <LinearGradient
          colors={['transparent', '#d4a93f', '#ffe9a8', '#d4a93f', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.72 }]}
        />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, bandB]}>
        <LinearGradient
          colors={['transparent', '#b58a2c', '#ffd970', 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
        />
      </Animated.View>
      {/* Roaming specular hotspot */}
      <Animated.View pointerEvents="none" style={[
        { position: 'absolute', left: '50%', top: '50%', width: 120, height: 120, marginLeft: -60, marginTop: -60 },
        hotStyle,
      ]}>
        <Svg width={120} height={120} viewBox="0 0 120 120">
          <Defs>
            <RadialGradient id={hotId} cx="60" cy="60" r="60" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#fff6cf" stopOpacity="0.85" />
              <Stop offset="0.5" stopColor="#ffe9a8" stopOpacity="0.25" />
              <Stop offset="1" stopColor="#ffe9a8" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="60" cy="60" r="60" fill={`url(#${hotId})`} />
        </Svg>
      </Animated.View>
      {/* Polished floor seam */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.45)'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.5 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Gold spark motes catching the light */}
      <SparkleField count={6} color="#ffe9a8" durationMs={2600} />
      {children}
    </View>
  );
}

// ── 13. Synthwave (retro sun + perspective grid) ────────────────────────────

function SynthwaveBg({ v, style, children }: BgProps) {
  const sunGradId = useBgId('synthSun');   // per-instance ids; mask collisions render unmasked
  const sunMaskId = useBgId('sunBands');
  const scan = useSharedValue(0);
  const glow = useSharedValue(0);
  const sun = useSharedValue(0);
  useEffect(() => {
    scan.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.linear }), -1, false);
    glow.value = withRepeat(withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }), -1, true);
    sun.value = withRepeat(withTiming(1, { duration: 5000, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(scan); cancelAnimation(glow); cancelAnimation(sun); };
  }, [scan, glow, sun]);
  const scanStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(scan.value, [0, 1], [0, 320]) }],
  }));
  // The sun now breathes AND bobs gently on the horizon.
  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.6, 0.98]),
    transform: [{ translateY: interpolate(sun.value, [0, 1], [-3, 5]) }],
  }));
  const reflectStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.3, 0.6]),
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
      {/* Twinkling sky stars */}
      <SparkleField count={12} color="#ffd9ec" durationMs={2600} />
      {/* Horizon bloom under the sun */}
      <BreathingGlow cx="50%" cy="58%" r={90} color={pink} periodMs={2800} min={0.18} max={0.34} />
      {/* Sun reflection streak shimmering down the floor */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: '58%', alignSelf: 'center', width: 44, height: '40%' }, reflectStyle]}>
        <LinearGradient
          colors={[`${pink}66`, 'transparent'] as const as readonly [string, string, ...string[]]}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* Banded retro sun, dropped behind the grid horizon */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: '16%', alignSelf: 'center', width: 150, height: 150 }, glowStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <SvgLinearGradient id={sunGradId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%"  stopColor="#ffe28a" />
              <Stop offset="55%" stopColor="#ff9a3a" />
              <Stop offset="100%" stopColor={pink} />
            </SvgLinearGradient>
            <Mask id={sunMaskId}>
              <Circle cx="50" cy="50" r="42" fill="#ffffff" />
              {/* Horizontal slices get thicker toward the bottom of the disc */}
              <Rect x="0" y="58" width="100" height="2.5" fill="#000000" />
              <Rect x="0" y="66" width="100" height="3.5" fill="#000000" />
              <Rect x="0" y="75" width="100" height="4.5" fill="#000000" />
              <Rect x="0" y="85" width="100" height="5.5" fill="#000000" />
            </Mask>
          </Defs>
          <Circle cx="50" cy="50" r="42" fill={`url(#${sunGradId})`} mask={`url(#${sunMaskId})`} />
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

// ── 14. Total Eclipse (corona streamers + moon disc + diamond-ring glint) ────

function EclipseBg({ v, style, children }: BgProps) {
  const coronaId = useBgId('eclipseCorona');   // per-instance gradient ids (avoid collisions)
  const rimId = useBgId('eclipseRim');
  const diamondId = useBgId('diamondGlow');
  const breathe = useSharedValue(0);
  const rot     = useSharedValue(0);
  const rim     = useSharedValue(0);
  const diamond = useSharedValue(0);   // the diamond-ring shimmer
  useEffect(() => {
    breathe.value = withRepeat(withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.sin) }), -1, true);
    rot.value     = withRepeat(withTiming(1, { duration: 44000, easing: Easing.linear }), -1, false);
    rim.value     = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    diamond.value = withRepeat(withTiming(1, { duration: 1700, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(breathe); cancelAnimation(rot); cancelAnimation(rim); cancelAnimation(diamond); };
  }, [breathe, rot, rim, diamond]);

  const coronaStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(breathe.value, [0, 1], [1, 1.08]) }],
    opacity: interpolate(breathe.value, [0, 1], [0.78, 1]),
  }));
  const rayStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${interpolate(rot.value, [0, 1], [0, 360])}deg` }] }));
  const rimStyle = useAnimatedStyle(() => ({ opacity: interpolate(rim.value, [0, 1], [0.5, 1]) }));
  const diamondStyle = useAnimatedStyle(() => ({
    opacity: interpolate(diamond.value, [0, 1], [0.55, 1]),
    transform: [{ scale: interpolate(diamond.value, [0, 1], [0.78, 1.2]) }],
  }));

  const corona = v.accent ?? '#ffdf8a';
  const stars = useMemo(() => Array.from({ length: 40 }, () => ({
    cx: Math.random() * 100,
    cy: Math.random() * 100,
    r: Math.random() * 1.1 + 0.25,
    delay: Math.random() * 2500,
    duration: TIMING.star + Math.random() * 1500,
  })), []);

  // Corona streamers — long, irregular spokes of varied length/opacity, like a
  // real eclipse corona rather than an even sunburst. Memoised geometry.
  const streamers = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    a: i * (360 / 22) + (Math.random() * 6 - 3),
    len: 50 + Math.random() * 16,
    op: 0.1 + Math.random() * 0.18,
    w: 0.8 + Math.random() * 1.0,
  })), []);

  // Geometry for the disc + the diamond-ring glint that sits on its rim.
  const DISC_R = 43;
  const dAng = (-52 * Math.PI) / 180;   // upper-right rim
  const dx = 50 + Math.cos(dAng) * DISC_R;
  const dy = 50 + Math.sin(dAng) * DISC_R;
  const box: ViewStyle = { position: 'absolute', top: '22%', alignSelf: 'center', width: 190, height: 190 };

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
      <Animated.View pointerEvents="none" style={[box, coronaStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id={coronaId} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
              <Stop offset="0%"  stopColor="#fff8e0" stopOpacity="0.95" />
              <Stop offset="34%" stopColor={corona} stopOpacity="0.5" />
              <Stop offset="100%" stopColor={corona} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="50" r="50" fill={`url(#${coronaId})`} />
        </Svg>
      </Animated.View>

      {/* Slow-rotating corona streamers */}
      <Animated.View pointerEvents="none" style={[box, rayStyle]}>
        <Svg width="100%" height="100%" viewBox="-50 -50 100 100">
          {streamers.map((s, i) => {
            const ang = (s.a * Math.PI) / 180;
            return <Line key={i}
              x1={Math.cos(ang) * 24} y1={Math.sin(ang) * 24}
              x2={Math.cos(ang) * s.len} y2={Math.sin(ang) * s.len}
              stroke={corona} strokeOpacity={s.op} strokeWidth={s.w} strokeLinecap="round" />;
          })}
        </Svg>
      </Animated.View>

      {/* Moon disc + glowing rim + Bailey's beads (rim opacity breathes) */}
      <Animated.View pointerEvents="none" style={[box, rimStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id={rimId} cx="50" cy="50" r="46" gradientUnits="userSpaceOnUse">
              <Stop offset="88%"  stopColor="#fff8e0" stopOpacity="0" />
              <Stop offset="95%"  stopColor="#fff8e0" stopOpacity="0.5" />
              <Stop offset="100%" stopColor="#fff8e0" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="50" r="46" fill={`url(#${rimId})`} />
          <Circle cx="50" cy="50" r={DISC_R} fill="#04050c" />
          <Circle cx="50" cy="50" r={DISC_R} fill="none" stroke="#fff8e0" strokeOpacity="0.85" strokeWidth="0.9" />
          {/* Bailey's beads — bright spots along the rim near the diamond */}
          {[-34, -68, -16].map((deg, i) => {
            const a = (deg * Math.PI) / 180;
            return <Circle key={i}
              cx={50 + Math.cos(a) * DISC_R} cy={50 + Math.sin(a) * DISC_R}
              r={i === 0 ? 1.0 : 0.7} fill="#fff8e0" fillOpacity="0.85" />;
          })}
        </Svg>
      </Animated.View>

      {/* Diamond ring — the brilliant glint on the rim, shimmering */}
      <Animated.View pointerEvents="none" style={[box, diamondStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id={diamondId} cx={dx} cy={dy} r="13" gradientUnits="userSpaceOnUse">
              <Stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
              <Stop offset="30%"  stopColor="#fff8e0" stopOpacity="0.7" />
              <Stop offset="100%" stopColor="#fff8e0" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={dx} cy={dy} r="12" fill={`url(#${diamondId})`} />
          <Line x1={dx - 11} y1={dy} x2={dx + 11} y2={dy} stroke="#ffffff" strokeOpacity="0.9" strokeWidth="0.8" strokeLinecap="round" />
          <Line x1={dx} y1={dy - 11} x2={dx} y2={dy + 11} stroke="#ffffff" strokeOpacity="0.9" strokeWidth="0.8" strokeLinecap="round" />
          <Circle cx={dx} cy={dy} r="2.6" fill="#ffffff" />
        </Svg>
      </Animated.View>

      {children}
    </View>
  );
}

// ── 15. Matrix (digital rain) ───────────────────────────────────────────────

const MATRIX_GLYPHS = 'アイウエオカキクケコサシスセソタチツテト0123456789Φ$#';

function MatrixBg({ v, style, children }: BgProps) {
  const color = v.color ?? '#00ff41';
  const columns = useMemo(() => Array.from({ length: 13 }, (_, i) => {
    const fontSize = 10 + Math.round(Math.random() * 5);   // 10-15
    return {
      left: `${(i / 13) * 100 + 1}%`,
      glyphs: Array.from({ length: 22 }, () => MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)]).join('\n'),
      headGlyphs: Array.from({ length: 2 }, () => MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)]).join('\n'),
      dur: 4400 - fontSize * 150 + Math.random() * 1200,   // bigger glyphs fall faster (parallax)
      delay: Math.random() * 2200,
      opacity: 0.4 + Math.random() * 0.5,
      fontSize,
    };
  }), []);

  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#010a04' }, style]}>
      {columns.map((c, i) => <MatrixColumn key={i} {...c} color={color} />)}
      {/* CRT scanlines */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
        {Array.from({ length: 50 }).map((_, i) => (
          <Line key={i} x1={0} y1={i * 2} x2={100} y2={i * 2} stroke="#000000" strokeOpacity="0.18" strokeWidth="0.5" />
        ))}
      </Svg>
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

function MatrixColumn({ left, glyphs, headGlyphs, dur, delay, opacity, color, fontSize }: {
  left: any; glyphs: string; headGlyphs: string; dur: number; delay: number; opacity: number; color: string; fontSize: number;
}) {
  // Two stacked copies translate down in a seamless wrap. A bright white-green
  // "head" rides the leading (bottom) edge of each copy, the classic effect.
  const lineH = Math.round(fontSize * 1.25);
  const COPY_H = 22 * lineH;
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, dur, delay]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(t.value, [0, 1], [-COPY_H, 0]) }],
  }));
  const bodyStyle = {
    color, fontSize, lineHeight: lineH, fontWeight: '600' as const,
    textShadowColor: color, textShadowRadius: 5, textShadowOffset: { width: 0, height: 0 },
  };
  const headStyle = {
    color: '#d8ffe0', fontSize, lineHeight: lineH, fontWeight: '800' as const,
    textShadowColor: '#ffffff', textShadowRadius: 7, textShadowOffset: { width: 0, height: 0 },
  };
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left, opacity }, animStyle]}>
      <Text style={bodyStyle}>{glyphs}</Text>
      <Text style={bodyStyle}>{glyphs}</Text>
      {/* Bright heads at the leading edge of each copy */}
      <Text style={[headStyle, { position: 'absolute', left: 0, top: COPY_H - lineH * 2 }]}>{headGlyphs}</Text>
      <Text style={[headStyle, { position: 'absolute', left: 0, top: COPY_H * 2 - lineH * 2 }]}>{headGlyphs}</Text>
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
      {/* Big soft sun halo (real radial bloom, extends well past the disc) */}
      <BreathingGlow cx="28%" cy="56%" r={120} color="#ff9a3a" periodMs={3600} min={0.3} max={0.5} />
      {/* Crepuscular rays fanning up from the sun */}
      <DuskRays />
      {/* Warm haze band sitting on the horizon */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', '#ffcf7a55', 'transparent'] as const as readonly [string, string, ...string[]]}
        locations={[0.55, 0.66, 0.78]}
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
      {/* Floating pollen motes catching the light */}
      <SparkleField count={9} color="#ffe9a8" durationMs={3200} />
      {/* Course silhouette: three layered hills + flagstick */}
      <Svg pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%' }} viewBox="0 0 100 40" preserveAspectRatio="none">
        {/* Far ridge */}
        <Path d="M0 20 Q 18 12 36 18 T 70 16 Q 85 13 100 18 V40 H0 Z" fill="#2e1430" opacity="0.7" />
        {/* Mid ridge */}
        <Path d="M0 26 Q 30 18 60 24 T 100 22 V40 H0 Z" fill="#241024" opacity="0.9" />
        {/* Near fairway hill */}
        <Path d="M0 32 Q 25 23 55 29 T 100 28 V40 H0 Z" fill="#120816" />
        {/* Flagstick + flag on the near hill */}
        <Line x1={62} y1={28.5} x2={62} y2={16} stroke="#0a050c" strokeWidth="0.7" />
        <Path d="M62 16 L69.5 18.6 L62 21.2 Z" fill="#0a050c" />
      </Svg>
      {/* Warm top vignette */}
      <Vignette color="#0a0418" opacity={0.4} />
      {children}
    </View>
  );
}

/** Slow shimmering god-ray fan rising from the setting sun. */
function DuskRays() {
  const shim = useSharedValue(0);
  useEffect(() => {
    shim.value = withRepeat(withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(shim);
  }, [shim]);
  const aStyle = useAnimatedStyle(() => ({ opacity: interpolate(shim.value, [0, 1], [0.1, 0.22]) }));
  // Rays emanate from the sun (~28%, 56% of the frame) upward and outward.
  const sx = 28, sy = 56;
  const rays = [-40, -22, -8, 6, 22, 44];
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, aStyle]}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {rays.map((dx, i) => (
          <Line key={i} x1={sx} y1={sy} x2={sx + dx} y2={sy - 70} stroke="#ffd27a" strokeOpacity={0.5} strokeWidth={1.6} strokeLinecap="round" />
        ))}
      </Svg>
    </Animated.View>
  );
}

function DriftingCloud({ top, width, dur, delay, color = 'rgba(255, 206, 150, 0.20)' }: {
  top: any; width: number; dur: number; delay: number; color?: string;
}) {
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
        backgroundColor: color,
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
  const glowAId = useBgId('thA');
  const glowBId = useBgId('thB');
  const BOLT1 = 'M28 0 L24 42 L33 50 L20 98 L30 106 L17 160 M25 52 L14 76 M27 102 L38 128';
  const BOLT2 = 'M74 8 L70 46 L79 54 L66 104 L76 112 L63 172 M71 58 L84 84';

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0b0918', '#171232', v.to ?? '#2a2440'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Roiling storm clouds up top */}
      <DriftingCloud top="2%"  width={170} dur={40000} delay={0}    color="rgba(90,84,130,0.22)" />
      <DriftingCloud top="12%" width={120} dur={30000} delay={5000} color="rgba(120,112,160,0.16)" />
      {/* Three parallax rain layers (denser + randomized) */}
      <RainLayer dur={780}  delay={0}   opacity={0.34} count={14} slant={15} />
      <RainLayer dur={1050} delay={300} opacity={0.22} count={11} slant={17} />
      <RainLayer dur={1500} delay={600} opacity={0.12} count={8}  slant={13} color="#9aa4d9" />
      {/* Forked bolts: a wide faint halo under a crisp core, plus a localized
          flash bloom at the strike origin coupled to the same bolt driver. */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 200">
        <Defs>
          <RadialGradient id={glowAId} cx="28" cy="2" r="16" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#eae4ff" stopOpacity="0.9" />
            <Stop offset="1" stopColor="#eae4ff" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id={glowBId} cx="74" cy="8" r="14" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#d8ccff" stopOpacity="0.9" />
            <Stop offset="1" stopColor="#d8ccff" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <AnimatedPath d={BOLT1} stroke="#7a6fd9" strokeWidth="4" strokeOpacity={0.3} fill="none" strokeLinejoin="round" strokeLinecap="round" animatedProps={b1Props} />
        <AnimatedPath d={BOLT1} stroke="#eae4ff" strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" animatedProps={b1Props} />
        <AnimatedCircle cx="28" cy="2" r="16" fill={`url(#${glowAId})`} animatedProps={b1Props} />
        <AnimatedPath d={BOLT2} stroke="#6a5fc9" strokeWidth="3.5" strokeOpacity={0.28} fill="none" strokeLinejoin="round" strokeLinecap="round" animatedProps={b2Props} />
        <AnimatedPath d={BOLT2} stroke="#d8ccff" strokeWidth="1.1" fill="none" strokeLinejoin="round" strokeLinecap="round" animatedProps={b2Props} />
        <AnimatedCircle cx="74" cy="8" r="14" fill={`url(#${glowBId})`} animatedProps={b2Props} />
      </Svg>
      {/* Sheet-lightning wash */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, flashStyle, { backgroundColor: '#cfc4ff' }]} />
      <Vignette opacity={0.42} />
      {children}
    </View>
  );
}

function RainLayer({ dur, delay, opacity, count = 12, slant = 16, color = '#bec8ff' }: {
  dur: number; delay: number; opacity: number; count?: number; slant?: number; color?: string;
}) {
  const streaks = useMemo(() => Array.from({ length: count }, () => ({
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 90}%`,
    h: 20 + Math.random() * 14,
  })), [count]);
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
          width: 1.5, height: s.h, borderRadius: 1,
          backgroundColor: color,
          transform: [{ rotate: `${slant}deg` }],
        }} />
      ))}
    </Animated.View>
  );
}

// ── 18. Nebula (swirling cosmic gas clouds + drifting stars) ────────────────
//
// Distinct from `stars`: that one is twinkling pinpoints on a flat gradient.
// This paints big soft radial gas clouds that slowly rotate AND breathe as one
// sheet, with a separate (non-rotating) star field floating on top — so the
// galaxy turns behind a still sky.

type NebBlob = { cx: number; cy: number; rx: number; ry: number; color: string };

function NebulaPlane({ blobs, spinMs, reverse, breatheMs, baseOpacity }: {
  blobs: NebBlob[]; spinMs: number; reverse: boolean; breatheMs: number; baseOpacity: number;
}) {
  const spin = useSharedValue(0);
  const breathe = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: spinMs, easing: Easing.linear }), -1, false);
    breathe.value = withRepeat(withTiming(1, { duration: breatheMs, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(spin); cancelAnimation(breathe); };
  }, [spin, breathe, spinMs, breatheMs]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(spin.value, [0, 1], reverse ? [360, 0] : [0, 360])}deg` },
      { scale: interpolate(breathe.value, [0, 1], [1, 1.08]) },
    ],
    opacity: interpolate(breathe.value, [0, 1], [baseOpacity * 0.7, baseOpacity]),
  }));
  const prefix = useBgId('neb');
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, spinStyle]}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          {blobs.map((b, i) => (
            <RadialGradient key={i} id={`${prefix}_${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={b.color} stopOpacity="0.6" />
              <Stop offset="0.6" stopColor={b.color} stopOpacity="0.2" />
              <Stop offset="1" stopColor={b.color} stopOpacity="0" />
            </RadialGradient>
          ))}
        </Defs>
        {blobs.map((b, i) => <Ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={`url(#${prefix}_${i})`} />)}
      </Svg>
    </Animated.View>
  );
}

function NebulaBg({ v, style, children }: BgProps) {
  const raw: string[] = v.clouds ?? ['#b14ad9', '#4a6bd9', '#d94a8a'];
  const c0 = raw[0] ?? '#b14ad9', c1 = raw[1] ?? '#4a6bd9', c2 = raw[2] ?? '#d94a8a';
  const back: NebBlob[] = [
    { cx: 34, cy: 42, rx: 50, ry: 36, color: c1 },
    { cx: 70, cy: 60, rx: 44, ry: 34, color: c0 },
    { cx: 54, cy: 26, rx: 36, ry: 28, color: c2 },
  ];
  const front: NebBlob[] = [
    { cx: 28, cy: 64, rx: 30, ry: 22, color: c2 },
    { cx: 76, cy: 36, rx: 28, ry: 24, color: c1 },
    { cx: 50, cy: 50, rx: 24, ry: 20, color: c0 },
    { cx: 62, cy: 78, rx: 22, ry: 18, color: '#7a3ab5' },
  ];
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#070314', '#0a041e', v.to ?? '#13042a'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Two counter-drifting gas planes give real parallax instead of one
          rigid turntable spin. */}
      <NebulaPlane blobs={back} spinMs={60000} reverse={false} breatheMs={9000} baseOpacity={0.7} />
      <NebulaPlane blobs={front} spinMs={38000} reverse breatheMs={6500} baseOpacity={0.85} />
      {/* Hot cores */}
      <BreathingGlow cx="34%" cy="42%" r={60} color="#ffd9f2" periodMs={5000} min={0.2} max={0.4} />
      <BreathingGlow cx="72%" cy="58%" r={50} color="#cfe0ff" periodMs={6200} min={0.15} max={0.35} delay={1500} />
      {/* Parallax star layers */}
      <SparkleField count={20} color="#ffffff" durationMs={2400} />
      <SparkleField count={12} color="#cfa8ff" durationMs={3400} />
      {children}
    </View>
  );
}

// ── 19. Embers (magical glowing motes rising + swaying) ─────────────────────
//
// Calmer cousin of `flame`: instead of aggressive wisps it floats soft glowing
// fireflies up the screen with a gentle horizontal sway, each fading in and out.

const EMBER_RAMP = ['#ffe39a', '#ffcf7a', '#ff9d4a', '#ff6a3a'];

function EmbersBg({ v, style, children }: BgProps) {
  const color = v.accent ?? '#ffcf7a';
  const motes = useMemo(() => Array.from({ length: 22 }, () => ({
    left: Math.random() * 100,
    size: 2 + Math.random() * 4,
    delay: Math.random() * 5000,
    dur: 5000 + Math.random() * 4500,
    sway: (Math.random() * 2 - 1) * 34,
    color: EMBER_RAMP[Math.floor(Math.random() * EMBER_RAMP.length)],
  })), []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a0f0a', '#07120c', v.to ?? '#04140e'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Warm ground glow, plus a soft bloom over the embers' source */}
      <LinearGradient
        colors={['transparent', `${color}33`] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.6 }]}
      />
      <BreathingGlow cx="50%" cy="96%" r={150} color={color} periodMs={5000} min={0.12} max={0.24} />
      {motes.map((m, i) => <EmberMote key={i} {...m} />)}
      <Vignette color="#02110a" opacity={0.4} />
      {children}
    </View>
  );
}

function EmberMote({ left, size, delay, dur, sway, color }: {
  left: number; size: number; delay: number; dur: number; sway: number; color: string;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay, dur]);
  const aStyle = useAnimatedStyle(() => {
    // Base rise/fade envelope, modulated by a fast flicker so each ember
    // glimmers as it climbs (no extra driver — folded into the one timeline).
    const env = interpolate(t.value, [0, 0.15, 0.75, 1], [0, 0.9, 0.7, 0]);
    const flicker = 0.82 + 0.18 * Math.sin(t.value * Math.PI * 22);
    return {
      transform: [
        { translateY: interpolate(t.value, [0, 1], [40, -260]) },
        { translateX: interpolate(t.value, [0, 0.5, 1], [0, sway, 0]) },
        { scale:      interpolate(t.value, [0, 0.2, 0.8, 1], [0.4, 1, 1, 0.5]) },
      ],
      opacity: env * flicker,
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[
      {
        position: 'absolute', bottom: -10, left: `${left}%`,
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: color,
        shadowColor: color, shadowOpacity: 0.9, shadowRadius: size * 1.7, shadowOffset: { width: 0, height: 0 },
      },
      aStyle,
    ]} />
  );
}

// ── 20. Meteor Shower (twinkling sky + streaking meteors with tails) ────────

function MeteorBg({ v, style, children }: BgProps) {
  const color = v.accent ?? '#cfe0ff';
  const stars = useMemo(() => Array.from({ length: 44 }, () => ({
    cx: Math.random() * 100, cy: Math.random() * 65,
    r: Math.random() * 1.1 + 0.25,
    delay: Math.random() * 2000,
    duration: 1800 + Math.random() * 1500,
  })), []);
  const meteors = useMemo(() => Array.from({ length: 6 }, (_, i) => ({
    top: Math.random() * 38,
    left: 38 + Math.random() * 60,
    delay: i * 1200 + Math.random() * 1000,
    dur: 1000 + Math.random() * 700,
    len: 60 + Math.random() * 70,
    // First couple are bright "hero" meteors; the rest are thin and faint.
    scale: i < 2 ? 1.5 + Math.random() * 0.4 : 0.7 + Math.random() * 0.4,
  })), []);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#060814', '#0a0e22', v.to ?? '#0e1430'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Low nebula haze for depth under the horizon */}
      <BreathingGlow cx="22%" cy="78%" r={120} color="#3a4a8a" periodMs={9000} min={0.1} max={0.22} />
      <BreathingGlow cx="80%" cy="70%" r={100} color="#6a3a8a" periodMs={11000} min={0.08} max={0.18} delay={1800} />
      {/* Far star haze (parallax) behind the near twinkles */}
      <SparkleField count={14} color="#9fb8e0" durationMs={3200} />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        {stars.map((s, i) => <TwinklingStar key={i} {...s} />)}
      </Svg>
      {meteors.map((m, i) => <Meteor key={i} {...m} color={color} />)}
      {children}
    </View>
  );
}

function Meteor({ top, left, delay, dur, len, color, scale }: {
  top: number; left: number; delay: number; dur: number; len: number; color: string; scale: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    // One streak, then a dark gap before the next, so the sky isn't a constant
    // rain of meteors — they arrive in occasional flashes.
    t.value = withDelay(delay, withRepeat(
      withSequence(
        withTiming(1, { duration: dur, easing: Easing.in(Easing.quad) }),
        withDelay(2400 + Math.random() * 1800, withTiming(1, { duration: 0 })),
        withTiming(0, { duration: 0 }),
      ), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay, dur]);
  const aStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
    transform: [
      { translateX: interpolate(t.value, [0, 1], [0, -230]) },
      { translateY: interpolate(t.value, [0, 1], [0, 230]) },
      { rotate: '135deg' },
    ],
  }));
  const thick = 3 * scale;
  const headSize = 5 * scale;
  return (
    <Animated.View pointerEvents="none" style={[
      { position: 'absolute', top: `${top}%`, left: `${left}%`, width: len, height: thick },
      aStyle,
    ]}>
      {/* Soft tapered tail (wide faint halo brightening into the head) */}
      <LinearGradient
        colors={['transparent', `${color}66`, color] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.7, 1]}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={[StyleSheet.absoluteFill, { borderRadius: thick }]}
      />
      {/* Glowing fireball head */}
      <View style={{
        position: 'absolute', right: -headSize * 0.4, top: (thick - headSize) / 2,
        width: headSize, height: headSize, borderRadius: headSize / 2,
        backgroundColor: '#ffffff',
        shadowColor: color, shadowOpacity: 1, shadowRadius: 7 * scale, shadowOffset: { width: 0, height: 0 },
      }} />
    </Animated.View>
  );
}

// ── 21. Plasma (lava-lamp morphing colour blobs) ────────────────────────────
//
// Soft radial blobs drift, swell and shrink on slow out-of-phase sine loops so
// they merge and split like a lava lamp. SVG RadialGradient gives true soft
// falloff (cross-platform, unlike shadow-only blur).

function PlasmaBg({ v, style, children }: BgProps) {
  const cols: string[] = v.colors ?? ['#7a2ad9', '#2a6bd9', '#d92a8a', '#2ad9c4', '#c98a2a'];
  const prefix = useBgId('plasma');   // per-instance so two plasma cards never collide
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0b0518', '#0a0420', v.to ?? '#04030f'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          {cols.map((c, i) => (
            <RadialGradient key={i} id={`${prefix}_${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={c} stopOpacity="0.9" />
              <Stop offset="0.5" stopColor={c} stopOpacity="0.4" />
              <Stop offset="1" stopColor={c} stopOpacity="0" />
            </RadialGradient>
          ))}
        </Defs>
        {cols.map((_, i) => <PlasmaBlob key={i} index={i} total={cols.length} gradId={`${prefix}_${i}`} />)}
      </Svg>
      {/* Rising motes for foreground life */}
      <SparkleField count={7} color="#d9b6ff" durationMs={3000} />
      <Vignette opacity={0.45} />
      {children}
    </View>
  );
}

function PlasmaBlob({ index, total, gradId }: { index: number; total: number; gradId: string }) {
  // Three INDEPENDENT drivers (cx / cy / r) so the blob traces a Lissajous
  // wander instead of pulsing in lockstep.
  const cxD = useSharedValue(0);
  const cyD = useSharedValue(0);
  const rD = useSharedValue(0);
  useEffect(() => {
    cxD.value = withDelay(index * 300, withRepeat(withTiming(1, { duration: 9000 + index * 900, easing: Easing.inOut(Easing.sin) }), -1, true));
    cyD.value = withDelay(index * 500, withRepeat(withTiming(1, { duration: 13000 + index * 700, easing: Easing.inOut(Easing.sin) }), -1, true));
    rD.value  = withDelay(index * 200, withRepeat(withTiming(1, { duration: 7000 + index * 600, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => { cancelAnimation(cxD); cancelAnimation(cyD); cancelAnimation(rD); };
  }, [cxD, cyD, rD, index]);
  const baseCx = (index / total) * 70 + 15;
  const baseCy = ((index * 41) % 60) + 20;
  const ampX = index % 2 === 0 ? 34 : -34;
  const ampY = index % 3 === 0 ? 30 : -28;
  const aProps = useAnimatedProps(() => ({
    cx: baseCx + interpolate(cxD.value, [0, 1], [-ampX, ampX]),
    cy: baseCy + interpolate(cyD.value, [0, 1], [-ampY, ampY]),
    r:  interpolate(rD.value, [0, 1], [32, 50]),
  }));
  return <AnimatedCircle animatedProps={aProps} cx={baseCx} cy={baseCy} r={40} fill={`url(#${gradId})`} />;
}

// ── 22. Blizzard (parallax snowfall over an icy gradient) ────────────────────

function BlizzardBg({ v, style, children }: BgProps) {
  const accent = v.accent ?? '#cfe6ff';
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#1a2a3e', '#122236', v.to ?? '#0a1420'] as const as readonly [string, string, ...string[]]}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Cold top bloom */}
      <LinearGradient
        colors={[`${accent}22`, 'transparent'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.7 }]}
      />
      {/* Four parallax depth layers: glowing close flakes down to a faint far haze */}
      <SnowLayer count={14} size={3.5} dur={6500}  drift={26} opacity={0.95} glow />
      <SnowLayer count={18} size={2.5} dur={9000}  drift={18} opacity={0.7} />
      <SnowLayer count={22} size={1.6} dur={12000} drift={12} opacity={0.5} />
      <SnowLayer count={20} size={1.0} dur={15000} drift={8}  opacity={0.32} color="#9fc0e6" />
      {/* Drifted ground fog */}
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', `${accent}33`] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0.78 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

function SnowLayer({ count, size, dur, drift, opacity, glow = false, color = '#ffffff' }: {
  count: number; size: number; dur: number; drift: number; opacity: number; glow?: boolean; color?: string;
}) {
  const flakes = useMemo(() => Array.from({ length: count }, () => ({
    left: Math.random() * 100,
    delay: Math.random() * dur,
  })), [count, dur]);
  return (
    <>
      {flakes.map((f, i) => (
        <Snowflake key={i} left={f.left} delay={f.delay} size={size} dur={dur} drift={drift} opacity={opacity} glow={glow} color={color} />
      ))}
    </>
  );
}

function Snowflake({ left, delay, size, dur, drift, opacity, glow = false, color = '#ffffff' }: {
  left: number; delay: number; size: number; dur: number; drift: number; opacity: number; glow?: boolean; color?: string;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t, delay, dur]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(t.value, [0, 1], [-20, 320]) },
      { translateX: interpolate(t.value, [0, 0.5, 1], [0, drift, 0]) },
    ],
    opacity: interpolate(t.value, [0, 0.1, 0.9, 1], [0, opacity, opacity, 0]),
  }));
  return (
    <Animated.View pointerEvents="none" style={[
      {
        position: 'absolute', left: `${left}%`, top: -10,
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: color,
        ...(glow ? { shadowColor: '#eaf3ff', shadowOpacity: 0.9, shadowRadius: size * 1.4, shadowOffset: { width: 0, height: 0 } } : null),
      },
      aStyle,
    ]} />
  );
}

// ── 23. Prism (prismatic light shafts radiating from a bright core) ─────────
//
// A bright central source breathes while two counter-rotating layers of soft
// colour shafts fan out from it over the full 360, each shaft jittered in
// width/length/opacity so it reads as refracted light, not a rigid wheel.

function PrismLayer({ cols, spinMs, reverse, half, len, baseOpacity, angleOffset }: {
  cols: string[]; spinMs: number; reverse: boolean; half: number; len: number; baseOpacity: number; angleOffset: number;
}) {
  const spin = useSharedValue(0);
  const shimmer = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: spinMs, easing: Easing.linear }), -1, false);
    shimmer.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => { cancelAnimation(spin); cancelAnimation(shimmer); };
  }, [spin, shimmer, spinMs]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(spin.value, [0, 1], reverse ? [360, 0] : [0, 360])}deg` }],
    opacity: interpolate(shimmer.value, [0, 1], [baseOpacity * 0.6, baseOpacity]),
  }));
  const prefix = useBgId('prism');
  const n = cols.length;
  // Each shaft spans -l..+l so a single rect covers two opposite directions;
  // n shafts therefore cover the full 360.
  const beams = useMemo(() => cols.map((c, i) => ({
    color: c,
    angle: (i * 360) / n + angleOffset,
    w: half * (0.7 + Math.random() * 0.7),
    l: len * (0.75 + Math.random() * 0.4),
    op: 0.6 + Math.random() * 0.4,
  })), [cols, n, half, len, angleOffset]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, spinStyle]}>
      <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
        <Defs>
          {beams.map((b, i) => (
            <SvgLinearGradient key={i} id={`${prefix}_${i}`} x1="0" y1={-b.l} x2="0" y2={b.l} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={b.color} stopOpacity="0" />
              <Stop offset="0.5" stopColor={b.color} stopOpacity={b.op} />
              <Stop offset="1" stopColor={b.color} stopOpacity="0" />
            </SvgLinearGradient>
          ))}
        </Defs>
        {beams.map((b, i) => (
          <G key={i} rotation={b.angle} origin="0, 0">
            <Rect x={-b.w} y={-b.l} width={b.w * 2} height={b.l * 2} fill={`url(#${prefix}_${i})`} />
          </G>
        ))}
      </Svg>
    </Animated.View>
  );
}

function PrismBg({ v, style, children }: BgProps) {
  const cols: string[] = v.colors ?? ['#ff6b9d', '#ffd166', '#5ad9c4', '#74a8ff', '#c779ff'];
  const near = useMemo(() => [...cols].reverse(), [cols]);
  const coreId = useBgId('prismcore');
  const breathe = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(withTiming(1, { duration: 4000, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(breathe);
  }, [breathe]);
  const coreProps = useAnimatedProps(() => ({
    r: interpolate(breathe.value, [0, 1], [10, 16]),
    opacity: interpolate(breathe.value, [0, 1], [0.6, 1]),
  }));
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={[v.from ?? '#0a0a14', v.to ?? '#141020'] as const as readonly [string, string, ...string[]]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Far + near counter-rotating shaft layers (parallax depth) */}
      <PrismLayer cols={cols} spinMs={34000} reverse={false} half={6} len={62} baseOpacity={0.4} angleOffset={0} />
      <PrismLayer cols={near} spinMs={20000} reverse half={4} len={70} baseOpacity={0.55} angleOffset={36} />
      {/* Bright central source the shafts emanate from */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg style={StyleSheet.absoluteFill} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice">
          <Defs>
            <RadialGradient id={coreId} cx="0" cy="0" r="18" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
              <Stop offset="0.4" stopColor="#ffe9f5" stopOpacity="0.5" />
              <Stop offset="1" stopColor="#ffe9f5" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <AnimatedCircle cx={0} cy={0} r={14} fill={`url(#${coreId})`} animatedProps={coreProps} />
        </Svg>
      </View>
      {/* Iridescent motes */}
      <SparkleField count={6} color="#ffffff" durationMs={2400} />
      {children}
    </View>
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
