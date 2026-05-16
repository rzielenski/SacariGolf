/**
 * GlowCard — a card-shaped container whose border + halo glow gently
 * pulse, drawing the eye without the loud animation of a shimmer sweep.
 *
 *   <GlowCard color={C.gold} style={...}>
 *     <Text>Important content</Text>
 *   </GlowCard>
 *
 * Reserve for the highest-importance cards on a screen — the resume-round
 * banner, the lucky-round chip, the active-tournament card. Overuse kills
 * the effect.
 *
 * Animation: a single Animated.Value loops between 0 and 1 on a 2.6s cycle,
 * mapped to both border opacity (0.6 ↔ 1.0) and shadow opacity (0.25 ↔ 0.55).
 * Native-driver compatible — opacity transforms run on the UI thread.
 */

import { useEffect, useRef } from 'react';
import {
  Animated, StyleSheet, StyleProp, ViewStyle, Easing, View,
} from 'react-native';
import { C } from '../../lib/colors';

interface Props {
  /** Accent color for the border + glow. Defaults to gold. */
  color?: string;
  /** Pulse period in ms — full breath cycle. Default 2600. */
  periodMs?: number;
  /** Override the resting border opacity. Higher = always-visible border. */
  minBorderOpacity?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function GlowCard({
  color = C.gold,
  periodMs = 2600,
  minBorderOpacity = 0.55,
  style,
  children,
}: Props) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: periodMs / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: periodMs / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, periodMs]);

  // The outer Animated.View carries the shadow + the animated border opacity.
  // We layer a slightly-translucent inner glow ring on top of that to
  // amplify the "lit border" effect — single-border alone reads as flat
  // when the surface beneath is true black.
  return (
    <Animated.View
      style={[
        styles.card,
        {
          shadowColor: color,
          shadowOpacity: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [0.22, 0.55],
          }),
        },
        style,
      ]}
    >
      {/* Static dim border underneath — keeps the shape visible at the
          dimmer end of the pulse. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.borderLayer, {
          borderColor: color,
          opacity: minBorderOpacity,
        }]}
      />
      {/* Animated bright border on top — fades up to opacity 1 at the peak. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.borderLayer, {
          borderColor: color,
          opacity: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 1 - minBorderOpacity],
          }),
        }]}
      />
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    backgroundColor: C.card,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    // Border is rendered via the two overlaid layers, not via borderWidth
    // here — having borderWidth on the outer breaks the absoluteFill math.
    padding: 1,        // gives the border layers a single-pixel rim of space
  },
  borderLayer: {
    borderRadius: 10,
    borderWidth: 1.5,
  },
});
