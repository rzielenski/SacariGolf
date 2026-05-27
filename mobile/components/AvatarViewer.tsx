/**
 * Full-screen avatar viewer. Mirrors the Find image viewer (see
 * app/(tabs)/finds.tsx → FindViewer): a dark backdrop with the photo
 * scaled to fit, dismissed by swiping in either direction or tapping
 * anywhere. Pass `uri = null` to keep it hidden.
 *
 *   <AvatarViewer uri={open ? url : null} username={name} onClose={...} />
 */
import React, { useEffect, useRef } from 'react';
import {
  Modal, Animated, Image, Text, TouchableOpacity, PanResponder, Dimensions,
} from 'react-native';
import { C } from '../lib/colors';

const { height: H } = Dimensions.get('window');

export function AvatarViewer({
  uri, username, onClose,
}: {
  uri: string | null;
  username?: string | null;
  onClose: () => void;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  // Reset the animation values each time a new image is shown.
  useEffect(() => {
    if (uri) {
      translateY.setValue(0);
      opacity.setValue(1);
    }
  }, [uri]);

  const dismiss = (direction: 1 | -1) => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: direction * H, duration: 220, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderMove: (_, { dy }) => {
        translateY.setValue(dy);
        opacity.setValue(1 - Math.min(Math.abs(dy) / 400, 0.6));
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        if (Math.abs(dy) > 100 || Math.abs(vy) > 0.6) {
          dismiss(dy >= 0 ? 1 : -1);
        } else if (Math.abs(dy) < 6) {
          // Near-zero movement = a tap → dismiss
          dismiss(1);
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
            Animated.spring(opacity, { toValue: 1, useNativeDriver: true, friction: 8 }),
          ]).start();
        }
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <Animated.View
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', opacity }}
        {...panResponder.panHandlers}
      >
        <Animated.View
          pointerEvents="box-none"
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center', transform: [{ translateY }] }}
        >
          <TouchableOpacity
            style={{ position: 'absolute', top: 56, right: 20, zIndex: 10, padding: 12 }}
            onPress={onClose}
          >
            <Text style={{ color: '#fff', fontSize: 28, fontWeight: '300' }}>✕</Text>
          </TouchableOpacity>
          {uri && (
            <>
              {/* No pointerEvents prop: the parent PanResponder uses capture
                  handlers, so it already owns every touch (swipe + tap-to-
                  dismiss). Setting it on Image also trips a type error in RN. */}
              <Image
                source={{ uri }}
                style={{ width: '100%', height: '70%' }}
                resizeMode="contain"
              />
              {username ? (
                <Text style={{ color: C.gold, fontSize: 14, fontWeight: '700', marginTop: 14 }} pointerEvents="none">
                  {username}
                </Text>
              ) : null}
              <Text style={{ color: '#888', fontSize: 11, marginTop: 16 }} pointerEvents="none">
                Swipe or tap anywhere to dismiss
              </Text>
            </>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}
