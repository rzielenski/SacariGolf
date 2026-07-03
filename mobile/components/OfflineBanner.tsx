import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { subscribeConn } from '../lib/api';
import { AppConfig, subscribeAppConfig, updateRequired } from '../lib/appConfig';
import { UPDATE_BANNER_HEIGHT } from './UpdateBanner';
import { C } from '../lib/colors';

// Where the offline banner sits when the update banner is NOT shown.
const TOP_BASE = 54; // below the system status bar

/**
 * Slim top-of-app banner that surfaces when we believe the device is offline.
 * Mirrors connectivity state from the api.ts singleton (which infers offline
 * from consecutive fetch failures — see api.ts for the heuristic).
 *
 * Mounted once at the root layout, sits below the status bar at low z-index
 * priority so it's visible everywhere without intercepting taps.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  // Track the same app config that drives the update banner so we can drop
  // BELOW it when it's visible instead of painting over its text (both
  // banners mount side-by-side at the root; the update banner is in normal
  // flow, this one is absolutely positioned).
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Fade-in/fade-out so the banner doesn't flicker on a single failed request
  // that happens to clear before the connection ticks back.
  const opacity = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return subscribeConn((s) => setOffline(s === 'offline'));
  }, []);

  useEffect(() => subscribeAppConfig(setConfig), []);

  // When the update banner is showing it occupies the top of the app, so
  // shift down past it; otherwise sit at the normal status-bar offset.
  const top = updateRequired(config) ? TOP_BASE + UPDATE_BANNER_HEIGHT : TOP_BASE;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: offline ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [offline, opacity]);

  // pointerEvents='none' lets taps fall through to whatever's underneath —
  // the banner is read-only signal, not an interactive surface.
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.wrap, { top, opacity }]}
    >
      <View style={s.dot} />
      <Text style={s.text}>OFFLINE · Saving locally, will sync when you're back</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    // `top` is applied inline — it depends on whether the update banner is
    // showing (see TOP_BASE / UPDATE_BANNER_HEIGHT above).
    left: 8, right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: '#1a1a1aee',
    borderWidth: 1, borderColor: C.gold + '88',
    borderRadius: 6,
    zIndex: 999,
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: C.red,
  },
  text: {
    color: C.text, fontSize: 11, fontWeight: '700',
    letterSpacing: 0.4, flex: 1,
  },
});
