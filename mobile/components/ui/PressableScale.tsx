/**
 * PressableScale — a Pressable that scales down + dims slightly on press.
 *
 *   <PressableScale onPress={...} style={styles.btn}>
 *     <Text>Click me</Text>
 *   </PressableScale>
 *
 * Replaces the bare-TouchableOpacity "activeOpacity={0.7}" pattern with a
 * subtler scale+opacity animation that feels tactile on iOS the way native
 * UIButton does. Spring physics — quick down (110ms), spring back with a
 * slight overshoot.
 *
 * IMPLEMENTATION NOTE: we wrap Pressable with Animated.createAnimatedComponent
 * so the transform + style apply to the OUTER pressable as a single layout
 * unit. Earlier the style was applied only to an inner Animated.View, which
 * meant `style={{flex: 1}}` had no effect on the actual layout — the outer
 * Pressable would shrink to its content size. Now the whole component
 * receives the layout style (flex, width, height, padding, background) and
 * the animation applies to the same node, so the visible card scales as a
 * single unit on press.
 */

import { useRef } from 'react';
import {
  Animated, Pressable, PressableProps, StyleProp, ViewStyle,
} from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Props extends Omit<PressableProps, 'style'> {
  scale?: number;       // press depth — default 0.96
  dim?: number;         // opacity on press — default 0.88
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function PressableScale({
  scale = 0.96, dim = 0.88, style, children, onPressIn, onPressOut, ...rest
}: Props) {
  const s = useRef(new Animated.Value(1)).current;
  const o = useRef(new Animated.Value(1)).current;

  return (
    <AnimatedPressable
      {...rest}
      // Style merges: the user's passed `style` (which carries flex,
      // background, padding, etc.) AND the animation values (scale +
      // opacity). Applied to the OUTER component so the whole thing
      // scales together AND the layout properties actually take effect.
      style={[
        style as any,
        { transform: [{ scale: s }], opacity: o },
      ] as any}
      onPressIn={(e) => {
        Animated.parallel([
          Animated.timing(s, { toValue: scale, duration: 110, useNativeDriver: true }),
          Animated.timing(o, { toValue: dim,   duration: 110, useNativeDriver: true }),
        ]).start();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        Animated.parallel([
          Animated.spring(s, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }),
          Animated.timing(o, { toValue: 1, duration: 180, useNativeDriver: true }),
        ]).start();
        onPressOut?.(e);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}
