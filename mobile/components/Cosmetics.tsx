/**
 * Cosmetic renderers — pure React Native components that consume the
 * server's visual_data blob and paint the corresponding effect.
 *
 * Five styles supported (matching the cosmetics.catalog_v2 seed):
 *
 *   • gradient      — two-tone vertical gradient
 *   • flag          — striped background with optional starred canton
 *                     (the Stars & Stripes background)
 *   • pulse         — solid color with animated opacity (storm flash)
 *   • aurora        — multi-layer translucent gradient bands (animated)
 *   • stars         — solid color with sprinkled star dots
 *   • holographic   — animated hue-cycling border / text
 *   • crackle       — segmented animated polyline (for ball trails; the
 *                     shot-map integration is deferred — preview-only)
 *   • solid         — flat color (default fallback)
 *
 * Components:
 *   <CosmeticBackground visual={…} style={…} />     full-bleed background
 *   <CosmeticBorder visual={…} size={…}>{child}</…> wraps an avatar
 *   <CosmeticUsername visual={…}>username</…>       colored / gradient text
 *   <CosmeticTrailPreview visual={…} />             small trail preview
 *
 * The animated styles use a single Animated.Value driven by Animated.loop
 * at component mount; cleanup stops the loop on unmount.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, Animated, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { C } from '../lib/colors';

type VisualData = Record<string, any> | null | undefined;

// ─── BACKGROUND ──────────────────────────────────────────────────────────────

export function CosmeticBackground({
  visual, style, children,
}: {
  visual: VisualData;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const v = visual ?? {};
  const baseStyle: StyleProp<ViewStyle> = [{ backgroundColor: v.from ?? C.bg }, style];

  switch (v.style) {
    case 'gradient':
      return <GradientBg v={v} style={baseStyle}>{children}</GradientBg>;
    case 'flag':
      return <FlagBg v={v} style={baseStyle}>{children}</FlagBg>;
    case 'pulse':
      return <PulseBg v={v} style={baseStyle}>{children}</PulseBg>;
    case 'aurora':
      return <AuroraBg v={v} style={baseStyle}>{children}</AuroraBg>;
    case 'stars':
      return <StarsBg v={v} style={baseStyle}>{children}</StarsBg>;
    default:
      return <View style={baseStyle}>{children}</View>;
  }
}

/** Two-tone vertical: top half from, bottom half to. Faked without
 *  expo-linear-gradient by stacking two equal halves with a soft border. */
function GradientBg({ v, style, children }: { v: any; style: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.from ?? '#000' }]} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.to ?? '#222', opacity: 0.7, top: '50%' }]} />
      {v.accent ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: v.accent, opacity: 0.08 }]} />
      ) : null}
      {children}
    </View>
  );
}

/** American flag — 7 alternating stripes + a blue canton with a grid
 *  of dot "stars" in the upper-left. Static visual. Not literal — the
 *  effect lands as a stylised, scrollable header. */
function FlagBg({ v, style, children }: { v: any; style: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const stripes: string[] = v.stripes ?? ['#bf0a30', '#ffffff'];
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      {Array.from({ length: 13 }).map((_, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: stripes[i % stripes.length] }} />
      ))}
      <View pointerEvents="none" style={{
        position: 'absolute', top: 0, left: 0,
        width: '40%', height: '54%', backgroundColor: v.canton ?? '#002868',
      }}>
        {Array.from({ length: 9 }).map((_, row) => (
          <View key={row} style={{ flexDirection: 'row', flex: 1, justifyContent: 'space-around', alignItems: 'center' }}>
            {Array.from({ length: 5 }).map((__, col) => (
              <View key={col} style={{
                width: 4, height: 4, borderRadius: 2,
                backgroundColor: '#ffffff', opacity: 0.92,
              }} />
            ))}
          </View>
        ))}
      </View>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.25)' }]} />
      {children}
    </View>
  );
}

/** Storm — solid dark base with a periodic white "flash" overlay. */
function PulseBg({ v, style, children }: { v: any; style: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const flash = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1800 + Math.random() * 1200),
      Animated.timing(flash, { toValue: 1, duration: 80, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0.4, duration: 110, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0.9, duration: 60, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [flash]);
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.from ?? '#0a0f1c' }]} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.to ?? '#3a4060', opacity: 0.6 }]} />
      <Animated.View pointerEvents="none" style={[
        StyleSheet.absoluteFill, { backgroundColor: v.flash ?? '#cad9ff', opacity: flash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }) },
      ]} />
      {children}
    </View>
  );
}

/** Aurora — three soft-edged horizontal bands of color, slowly drifting. */
function AuroraBg({ v, style, children }: { v: any; style: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(drift, { toValue: 1, duration: 6000, useNativeDriver: true }),
      Animated.timing(drift, { toValue: 0, duration: 6000, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [drift]);
  const layers: string[] = v.layers ?? ['#00ff9d', '#7fa2ff', '#c779ff'];
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.from ?? '#04161e' }]} />
      {layers.map((c, i) => {
        const offset = (i - 1) * 30;
        const translateY = drift.interpolate({
          inputRange: [0, 1],
          outputRange: [offset - 20, offset + 20],
        });
        return (
          <Animated.View key={i} pointerEvents="none" style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: c, opacity: 0.18,
              transform: [{ translateY }],
              top: `${20 + i * 25}%`, height: '40%',
              borderRadius: 200,
            },
          ]} />
        );
      })}
      {children}
    </View>
  );
}

/** Cosmic — deep gradient + ~80 randomly-placed star dots. */
function StarsBg({ v, style, children }: { v: any; style: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const stars = useMemo(() => {
    const n = v.stars ?? 60;
    return Array.from({ length: n }, () => ({
      left:  Math.random() * 100,
      top:   Math.random() * 100,
      size:  Math.random() * 2.4 + 0.6,
      alpha: Math.random() * 0.7 + 0.3,
    }));
  }, [v.stars]);
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.from ?? '#040515' }]} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: v.to ?? '#1a0a3a', opacity: 0.55, top: '40%' }]} />
      {stars.map((s, i) => (
        <View key={i} style={{
          position: 'absolute',
          left: `${s.left}%`, top: `${s.top}%`,
          width: s.size, height: s.size, borderRadius: s.size / 2,
          backgroundColor: '#ffffff', opacity: s.alpha,
        }} />
      ))}
      {children}
    </View>
  );
}

// ─── BORDER (wraps an avatar / crest) ────────────────────────────────────────

export function CosmeticBorder({
  visual, size = 96, children,
}: { visual: VisualData; size?: number; children?: React.ReactNode }) {
  const v = visual ?? {};
  const hue = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!v.animated && v.style !== 'holographic') return;
    const loop = Animated.loop(Animated.timing(hue, {
      toValue: 1, duration: v.style === 'holographic' ? 4000 : 1800, useNativeDriver: false,
    }));
    loop.start();
    return () => loop.stop();
  }, [v.animated, v.style, hue]);

  const width = v.width ?? 2;
  const padded = size + width * 2 + 6;

  if (v.style === 'holographic') {
    const colors: string[] = v.colors ?? ['#ff6b9d', '#74e0ff', '#a89cf0', '#ffe28a'];
    const cycle = hue.interpolate({
      inputRange: colors.map((_, i) => i / (colors.length - 1)),
      outputRange: colors,
    });
    return (
      <Animated.View style={{
        width: padded, height: padded, borderRadius: padded / 2,
        borderWidth: width, borderColor: cycle as any,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#74e0ff', shadowOpacity: 0.65, shadowRadius: 12,
      }}>
        {children}
      </Animated.View>
    );
  }
  if (v.style === 'pulse') {
    const opacity = hue.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
    return (
      <Animated.View style={{
        width: padded, height: padded, borderRadius: padded / 2,
        borderWidth: width, borderColor: v.color ?? C.gold, opacity,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: v.color ?? C.gold, shadowOpacity: 0.65, shadowRadius: 10,
      }}>
        {children}
      </Animated.View>
    );
  }
  if (v.style === 'glow') {
    return (
      <View style={{
        width: padded, height: padded, borderRadius: padded / 2,
        borderWidth: width, borderColor: v.color ?? C.gold,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: v.color ?? C.gold, shadowOpacity: 0.9, shadowRadius: 14,
      }}>
        {children}
      </View>
    );
  }
  if (!v.color) return <>{children}</>;
  return (
    <View style={{
      width: padded, height: padded, borderRadius: padded / 2,
      borderWidth: width, borderColor: v.color,
      alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </View>
  );
}

// ─── USERNAME ────────────────────────────────────────────────────────────────

export function CosmeticUsername({
  visual, children, style,
}: { visual: VisualData; children: React.ReactNode; style?: any }) {
  const v = visual ?? {};
  const hue = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!v.animated) return;
    const loop = Animated.loop(Animated.timing(hue, { toValue: 1, duration: 3000, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [v.animated, hue]);

  if (v.style === 'gradient' && Array.isArray(v.gradient)) {
    const cycle = v.animated
      ? hue.interpolate({
          inputRange: v.gradient.map((_: string, i: number) => i / (v.gradient.length - 1)),
          outputRange: v.gradient,
        })
      : v.gradient[0];
    return <Animated.Text style={[style, { color: cycle as any }]}>{children}</Animated.Text>;
  }
  if (v.style === 'solid') {
    const glow = v.glow ? { textShadowColor: v.color, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } } : null;
    return <Text style={[style, { color: v.color ?? '#fff' }, glow]}>{children}</Text>;
  }
  return <Text style={[style, { color: v.color ?? '#fff' }]}>{children}</Text>;
}

// ─── BALL TRAIL PREVIEW (locker-room tile + season-pass card) ─────────────────

export function CosmeticTrailPreview({ visual }: { visual: VisualData }) {
  const v = visual ?? {};
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!v.animated) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v.animated, pulse]);

  if (v.style === 'crackle') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, width: '70%' }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Animated.View key={i} style={{
            flex: 1, height: v.width ?? 3,
            backgroundColor: i % 2 ? v.color ?? '#74e0ff' : v.accent ?? '#ffffff',
            transform: [{ translateY: i % 2 ? 0 : -2 }],
            opacity: v.animated ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) : 1,
            shadowColor: v.color ?? '#74e0ff', shadowOpacity: v.glow ? 0.9 : 0, shadowRadius: 4,
          }} />
        ))}
      </View>
    );
  }
  const opacity = v.animated ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) : 1;
  return (
    <Animated.View style={{
      width: '70%', height: v.width ?? 2,
      backgroundColor: v.color ?? '#ffffff',
      borderRadius: 2, opacity,
      shadowColor: v.color ?? '#fff',
      shadowOpacity: v.glow ? 0.9 : 0, shadowRadius: 4,
    }} />
  );
}
