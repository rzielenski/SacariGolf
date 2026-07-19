/**
 * App-theme picker — a horizontal row of skin swatches. Tapping one re-skins
 * the WHOLE app (see lib/skins.ts). iOS only (the skin is read synchronously
 * from NSUserDefaults at boot, which Android has no equivalent for), so this
 * renders nothing on Android.
 *
 * Used in the Locker Room (the customization hub) and in Settings > Appearance.
 */
import React, { useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { C } from '../lib/colors';
import { ACTIVE_SKIN_ID } from '../lib/colors';
import { SKINS, applySkin, Skin, DEFAULT_SKIN_ID } from '../lib/skins';
import { useAuth } from '../lib/auth';
import { isPremium } from '../lib/premium';

export function SkinPicker() {
  // Hooks must precede any early return (rules-of-hooks).
  const { user } = useAuth();
  const premium = isPremium(user as any);
  const onPick = useCallback((sk: Skin) => {
    if (sk.id === ACTIVE_SKIN_ID) return;
    // App themes are Premium (only the default Sacari Classic is free). Route
    // free users to the upgrade screen instead of applying the theme.
    if (sk.id !== DEFAULT_SKIN_ID && !premium) {
      Alert.alert(
        'Premium theme',
        `${sk.name} is a Premium app theme. Unlock every theme — plus animated backgrounds, avatar borders, username flair, and ball trails — with Sacari Premium.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'See Premium', onPress: () => router.push('/premium' as any) },
        ],
      );
      return;
    }
    Alert.alert(
      `Switch to ${sk.name}?`,
      'The app reloads once to repaint every screen in the new theme. Saved data like matches and drafts is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Apply',
          onPress: async () => {
            const reloaded = await applySkin(sk.id);
            // If reloadAsync wasn't available (dev / Expo Go) the choice is saved
            // but the screen is still here, so tell the user it lands next launch.
            if (!reloaded) Alert.alert('Theme saved', `${sk.name} applies the next time you open the app.`);
          },
        },
      ],
    );
  }, [premium]);

  // Skins are iOS-only (synchronous boot read has no Android equivalent).
  if (Platform.OS !== 'ios') return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 10, paddingRight: 6 }}
    >
      {SKINS.map((sk) => {
        const active = sk.id === ACTIVE_SKIN_ID;
        const locked = sk.id !== DEFAULT_SKIN_ID && !premium;
        return (
          <TouchableOpacity
            key={sk.id}
            style={[s.chip, active && s.chipActive, locked && s.chipLocked]}
            onPress={() => onPick(sk)}
            activeOpacity={0.85}
          >
            <View style={s.swatch}>
              {sk.swatch.map((c, i) => <View key={i} style={{ flex: 1, backgroundColor: c }} />)}
            </View>
            <Text style={s.name} numberOfLines={1}>{sk.name}</Text>
            <Text style={[s.tag, locked && s.tagLocked, !(active || locked) && { opacity: 0 }]}>
              {locked ? '🔒 PREMIUM' : 'ACTIVE'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  chip: {
    width: 92, padding: 8, borderRadius: 10, borderWidth: 2,
    backgroundColor: C.card, borderColor: C.border, alignItems: 'center', gap: 4,
  },
  chipActive: { borderColor: C.gold },
  chipLocked: { opacity: 0.6 },
  tagLocked: { color: C.textMuted },
  swatch: {
    width: '100%', height: 44, borderRadius: 8, overflow: 'hidden',
    flexDirection: 'row', borderWidth: 1, borderColor: C.border,
  },
  name: { color: C.text, fontWeight: '800', fontSize: 12 },
  tag: { color: C.gold, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
});
