/**
 * "Update required" strip, driven by server config (app_config.min_version
 * vs this binary's version). Sits in the root layout next to the offline
 * banner: visible on every screen, dismiss-proof, but non-blocking — the
 * point is steady pressure to update, not a ransom wall.
 */

import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity } from 'react-native';
import {
  AppConfig, subscribeAppConfig, updateRequired,
} from '../lib/appConfig';
import { C } from '../lib/colors';

export function UpdateBanner() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => subscribeAppConfig(setConfig), []);

  if (!updateRequired(config)) return null;

  return (
    <TouchableOpacity
      style={styles.banner}
      activeOpacity={0.85}
      // App Store deep link by bundle search; falls back silently if the
      // store can't be opened (simulator).
      onPress={() => Linking.openURL('itms-apps://apps.apple.com/app/sacari').catch(() => { })}
    >
      <Text style={styles.text}>
        A new version of Sacari is required. Tap to update in the App Store.
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: C.gold,
    paddingTop: 52,
    paddingBottom: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: { color: '#000', fontWeight: '800', fontSize: 12, textAlign: 'center' },
});
