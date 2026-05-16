/**
 * ShimmerButton — primary CTA button with a subtle highlight sweep that
 * passes across the surface every few seconds. The shimmer is what makes
 * it feel premium without being loud; it draws the eye without screaming.
 *
 *   <ShimmerButton onPress={...}>
 *     <Text style={{ color: '#000', fontWeight: '900' }}>UPGRADE</Text>
 *   </ShimmerButton>
 *
 * The sweep is a single thin Animated.View (translucent white-gold) that
 * translateX'es from one edge to the other on a long loop. It clips to the
 * button via overflow:hidden so the highlight slides across, then dwells
 * off-screen for the bulk of the cycle (no constant motion, just an
 * occasional glint).
 *
 * Pair this with PressableScale-style press feedback — the button itself
 * uses the same scale-on-press treatment so it feels tactile when tapped.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Animated, Pressable, StyleProp, StyleSheet, ViewStyle, Easing,
  LayoutChangeEvent,
} from 'react-native';
import { C } from '../../lib/colors';

interface Props {
  onPress?: () => void;
  /** Disable interaction + dim the surface. */
  disabled?: boolean;
  /** Background color. Default = gold. Pass `'transparent'` and a border
   *  if you want a ghost-button style with the same shimmer treatment. */
  background?: string;
  /** Sweep highlight color — defaults to a white-tinted gold-light. */
  shimmerColor?: string;
  /** Sweep period — full cycle in ms. Default 3.8s (sweep ~600ms + idle gap). */
  cycleMs?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function ShimmerButton({
  onPress, disabled,
  background = C.gold,
  shimmerColor = 'rgba(255,235,180,0.45)',
  cycleMs = 3800,
  style, children,
}: Props) {
  // The shimmer sweep needs to know the rendered button width. We measure
  // via onLayout and stash in state — re-renders only once on first layout.
  const [w, setW] = useState(0);

  // Sweep position — animated 0 → 1, mapped to translateX across the button.
  const t = useRef(new Animated.Value(0)).current;
  // Press feedback
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (disabled) return;
    // The sweep takes ~14% of the cycle; the rest is dwell at the
    // off-screen end so the highlight feels like an occasional glint
    // rather than a constant scrolling band.
    const sweepFrac = 0.14;
    const sweepMs = cycleMs * sweepFrac;
    const dwellMs = cycleMs - sweepMs;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: sweepMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(dwellMs),
        Animated.timing(t, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [t, cycleMs, disabled]);

  const onLayout = (e: LayoutChangeEvent) => {
    const measured = e.nativeEvent.layout.width;
    if (measured && measured !== w) setW(measured);
  };

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={() => {
        if (disabled) return;
        Animated.parallel([
          Animated.timing(scale,   { toValue: 0.96, duration: 110, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.88, duration: 110, useNativeDriver: true }),
        ]).start();
      }}
      onPressOut={() => {
        if (disabled) return;
        Animated.parallel([
          Animated.spring(scale,   { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        ]).start();
      }}
      onLayout={onLayout}
      style={({ pressed: _pressed }) => [
        styles.outer,
        { backgroundColor: background, opacity: disabled ? 0.5 : 1 },
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.inner,
          { transform: [{ scale }], opacity },
        ]}
        pointerEvents="box-none"
      >
        {children}
        {/* The sweep — sits absolutely positioned, clipped to the button
            via parent overflow:hidden. Slides from left of the button
            (-w) across to the right (+w * 1.1, slightly past so it
            exits cleanly) each cycle. */}
        {w > 0 && !disabled && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.sweep,
              {
                backgroundColor: shimmerColor,
                width: w * 0.4,
                transform: [
                  {
                    translateX: t.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-w * 0.5, w * 1.1],
                    }),
                  },
                  { skewX: '-22deg' },
                ],
              },
            ]}
          />
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  inner: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sweep: {
    position: 'absolute',
    top: -20,
    bottom: -20,
    left: 0,
  },
});
