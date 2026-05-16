/**
 * PressableScale — a Pressable that scales down + dims slightly on press.
 *
 *   <PressableScale onPress={...} style={styles.btn}>
 *     <Text>Click me</Text>
 *   </PressableScale>
 *
 * Replaces the bare-TouchableOpacity "activeOpacity={0.7}" pattern with a
 * subtler scale+opacity animation that feels tactile on iOS the way native
 * UIButton does. Spring physics — quick down (180ms), slow back (240ms)
 * with a slight overshoot so it feels alive rather than mechanical.
 *
 * Drop-in replacement: same props as Pressable. Pass `scale` to override
 * the press depth (default 0.96 = 4% smaller).
 */

import { useRef } from 'react';
import {
  Animated, Pressable, PressableProps, StyleProp, ViewStyle, Easing,
} from 'react-native';

interface Props extends PressableProps {
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
    <Pressable
      {...rest}
      onPressIn={(e) => {
        Animated.parallel([
          Animated.timing(s, {
            toValue: scale,
            duration: 110,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(o, {
            toValue: dim,
            duration: 110,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]).start();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        Animated.parallel([
          // Slight overshoot — spring back past 1.0 then settles. Feels
          // like physical button release.
          Animated.spring(s, {
            toValue: 1,
            friction: 4,
            tension: 200,
            useNativeDriver: true,
          }),
          Animated.timing(o, {
            toValue: 1,
            duration: 180,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]).start();
        onPressOut?.(e);
      }}
    >
      <Animated.View
        style={[
          { transform: [{ scale: s }], opacity: o },
          style,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
