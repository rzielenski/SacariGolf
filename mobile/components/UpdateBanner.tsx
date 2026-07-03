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

// Height the banner adds at the top of the app when it's visible. The
// offline banner (absolutely positioned) reads this to sit BELOW us
// instead of painting over our text when both are shown at once.
export const UPDATE_BANNER_HEIGHT = 84; // paddingTop 52 + text + paddingBottom 10

// Store-search fallbacks used when the server hasn't supplied a specific
// App Store URL/id. Lands the user on a page where they can find and
// update Sacari — never a guaranteed-dead slug-only product URL.
const SEARCH_ITMS = 'itms-apps://itunes.apple.com/search?term=sacari%20golf&entity=software';
const SEARCH_HTTPS = 'https://apps.apple.com/us/search?term=sacari%20golf';

/** Open `url`, and if the itms-apps:// scheme can't be handled (e.g. the
 *  iOS Simulator has no App Store), fall back to the https equivalent so
 *  the button always does SOMETHING rather than dying in an empty catch. */
function openStore(url: string, httpsFallback: string) {
  Linking.openURL(url).catch(() => {
    Linking.openURL(httpsFallback).catch(() => { });
  });
}

/** Resolve the best App Store target from server config, with fallbacks:
 *  1. config.ios_store_url — server-provided, correctable without a build.
 *     If it's an https apps.apple.com/...id<number> URL, prefer the
 *     itms-apps:// scheme (opens the App Store app directly) with the
 *     original https URL as the fallback.
 *  2. Otherwise a store SEARCH deep link (itms with https fallback). */
function onPressUpdate(config: AppConfig | null) {
  const url = config?.ios_store_url?.trim();
  if (url) {
    if (/^https?:\/\//i.test(url)) {
      // Transform https://apps.apple.com/...id<number> → itms-apps://...
      // so it opens the native App Store; keep the https as the fallback.
      const itms = url.replace(/^https?:\/\//i, 'itms-apps://');
      openStore(itms, url);
    } else {
      // Already an itms-apps:// (or other) deep link — open as-is, but
      // still fall back to store search if the scheme can't be handled.
      openStore(url, SEARCH_HTTPS);
    }
    return;
  }
  openStore(SEARCH_ITMS, SEARCH_HTTPS);
}

export function UpdateBanner() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => subscribeAppConfig(setConfig), []);

  if (!updateRequired(config)) return null;

  return (
    <TouchableOpacity
      style={styles.banner}
      activeOpacity={0.85}
      onPress={() => onPressUpdate(config)}
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
