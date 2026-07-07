/**
 * Locker Room — cosmetic loadout.
 *
 * Five sections (border / background / username / ball trail / FX),
 * each renders the user's owned items at full opacity + every locked
 * item dimmed with an unlock hint. Tapping an owned item equips it
 * (server-enforced); tapping a locked one pops a modal explaining how
 * to get it.
 *
 * Reads the catalog from /cosmetics/catalog (data-driven, so new items
 * don't require an app release) and the user's owned/equipped state
 * from /users/me/cosmetics.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import {
  CosmeticBackground, CosmeticBorder, CosmeticUsername, CosmeticTrailPreview,
} from '../components/Cosmetics';
import { SkinPicker } from '../components/SkinPicker';

type CatalogItem = {
  cosmetic_id: string;
  kind: 'border' | 'background' | 'username' | 'ball_trail' | 'fx';
  name: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlock_kind: 'free' | 'premium' | 'cup_winner' | 'rank';
  unlock_data: any;
  visual_data: any;
};

const KIND_LABEL: Record<string, string> = {
  border:     'Avatar Border',
  background: 'Profile Background',
  username:   'Username Flair',
  ball_trail: 'Ball Trail',
  fx:         'Celebration FX',
};

const RARITY_COLOR: Record<string, string> = {
  common:    '#aeb6c2',
  rare:      '#4a9eff',
  epic:      '#a89cf0',
  legendary: '#d4a93f',
};

function unlockHint(item: CatalogItem): string {
  switch (item.unlock_kind) {
    case 'free':       return 'Owned by everyone';
    case 'premium':    return 'Unlock with Sacari Premium';
    case 'cup_winner': return `Win the Sacari Cup at place ${item.unlock_data?.place ?? 1}`;
    case 'rank':       return `Reach ${item.unlock_data?.tier ?? 'a high tier'}`;
    default:           return 'Locked';
  }
}

export default function LockerRoomScreen() {
  const { refreshUser } = useAuth();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [equipped, setEquipped] = useState<{
    border: string | null; background: string | null; username: string | null;
    ball_trail: string | null; fx: string | null;
  }>({ border: null, background: null, username: null, ball_trail: null, fx: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, mine] = await Promise.all([api.cosmetics.catalog(), api.cosmetics.mine()]);
      setCatalog(c.items as CatalogItem[]);
      setOwned(new Set(mine.owned));
      setEquipped(mine.equipped);
    } catch (e: any) {
      Alert.alert('Could not load', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onTapItem = useCallback(async (item: CatalogItem) => {
    if (!owned.has(item.cosmetic_id)) {
      Alert.alert(item.name, unlockHint(item));
      return;
    }
    const slotKey = item.kind as keyof typeof equipped;
    const alreadyEquipped = equipped[slotKey] === item.cosmetic_id;
    // Optimistic update
    const next = { ...equipped, [slotKey]: alreadyEquipped ? null : item.cosmetic_id };
    setEquipped(next);
    setBusy(true);
    try {
      await api.cosmetics.equip(item.kind, alreadyEquipped ? null : item.cosmetic_id);
      // Refresh the global user so /profile picks up the new equipped state.
      refreshUser();
    } catch (e: any) {
      setEquipped(equipped); // roll back
      Alert.alert('Could not equip', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [owned, equipped, refreshUser]);

  const grouped = useMemo(() => {
    const out: Record<string, CatalogItem[]> = {
      border: [], background: [], username: [], ball_trail: [], fx: [],
    };
    for (const i of catalog) (out[i.kind] ??= []).push(i);
    return out;
  }, [catalog]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Locker Room',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      {loading ? (
        <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <Text style={s.intro}>
            Pick what shows up on your profile, in feed posts, and on the shot map.
            Win the Sacari Cup or hit the top tiers to unlock the rare ones.
          </Text>

          {/* App theme: re-skins the WHOLE app (iOS). Lives here in the
              customization hub so it's discoverable alongside profile cosmetics. */}
          {Platform.OS === 'ios' && (
            <View style={{ marginBottom: 22 }}>
              <Text style={s.sectionLabel}>APP THEME</Text>
              <Text style={[s.intro, { marginBottom: 10 }]}>
                Re-skin the entire app to match your vibe. Tap a theme to apply it.
              </Text>
              <SkinPicker />
            </View>
          )}

          {(['border', 'background', 'username', 'ball_trail', 'fx'] as const).map((kind) => (
            <View key={kind} style={{ marginBottom: 22 }}>
              <Text style={s.sectionLabel}>{KIND_LABEL[kind]}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
                {(grouped[kind] ?? []).map((item) => {
                  const isOwned = owned.has(item.cosmetic_id);
                  const isEquipped = equipped[kind] === item.cosmetic_id;
                  return (
                    <TouchableOpacity
                      key={item.cosmetic_id}
                      style={[
                        s.tile,
                        { borderColor: isEquipped ? C.gold : (isOwned ? RARITY_COLOR[item.rarity] ?? C.border : C.border) },
                        !isOwned && { opacity: 0.5 },
                      ]}
                      onPress={() => onTapItem(item)}
                      disabled={busy}
                      activeOpacity={0.75}
                    >
                      <CosmeticPreview item={item} />
                      <Text style={s.tileName} numberOfLines={1}>{item.name}</Text>
                      <Text style={[s.tileRarity, { color: RARITY_COLOR[item.rarity] ?? C.textMuted }]}>
                        {item.rarity.toUpperCase()}
                      </Text>
                      {isEquipped && <Text style={s.tileEquipped}>EQUIPPED</Text>}
                      {!isOwned && <Text style={s.tileLocked}>🔒 {item.unlock_kind === 'premium' ? 'Premium' : item.unlock_kind === 'cup_winner' ? 'Cup' : 'Rank'}</Text>}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ))}

          <TouchableOpacity style={s.cupCta} onPress={() => router.push('/sacari-cup' as any)} activeOpacity={0.8}>
            <Text style={s.cupCtaText}>★  See this week's Sacari Cup leaderboard  ★</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

/** Real preview — uses the same components that render the cosmetic on the
 *  profile screen / shot map, but EVERY kind renders in static mode here
 *  (animated={false}). The grid shows the whole catalog at once, and mounting
 *  dozens of live animated backgrounds/borders/usernames/trails together backs
 *  up the UI thread and over-subscribes react-native-svg — a native-signature
 *  force-close that hit this screen hardest. Static previews use plain View /
 *  LinearGradient / Text (no SVG, no reanimated); the full animation plays once
 *  the item is equipped (one at a time) on the profile. */
function CosmeticPreview({ item }: { item: CatalogItem }) {
  const v = item.visual_data ?? {};

  if (item.kind === 'background') {
    // Static swatch: the grid shows the whole catalog at once, so animating
    // every background here backs up the UI thread. The full animation plays
    // once the background is equipped (one at a time) on the profile.
    return (
      <View style={s.preview}>
        <CosmeticBackground visual={v} style={StyleSheet.absoluteFill} animated={false} />
      </View>
    );
  }
  if (item.kind === 'username') {
    return (
      <View style={s.preview}>
        <CosmeticUsername visual={v} animated={false} style={{ fontSize: 20, fontWeight: '900', fontFamily: F.serif }}>
          Aa
        </CosmeticUsername>
      </View>
    );
  }
  if (item.kind === 'border') {
    return (
      <View style={[s.preview, { backgroundColor: 'transparent' }]}>
        <CosmeticBorder visual={v} size={32} animated={false}>
          <View style={{
            width: 32, height: 32, borderRadius: 16, backgroundColor: C.cardAlt,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: C.textMuted, fontSize: 12, fontWeight: '700' }}>·</Text>
          </View>
        </CosmeticBorder>
      </View>
    );
  }
  if (item.kind === 'ball_trail') {
    return (
      <View style={[s.preview, { padding: 6 }]}>
        <CosmeticTrailPreview visual={v} animated={false} />
      </View>
    );
  }
  return <View style={[s.preview, { backgroundColor: C.cardAlt }]} />;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  intro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  sectionLabel: {
    color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.5,
    marginBottom: 10,
  },
  tile: {
    width: 110, padding: 10, borderRadius: 10, borderWidth: 2,
    backgroundColor: C.card, alignItems: 'center', gap: 4,
  },
  preview: {
    width: 56, height: 56, borderRadius: 28, marginBottom: 4,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.cardAlt,
    overflow: 'hidden',
  },
  tileName: { color: C.text, fontSize: 12, fontWeight: '700' },
  tileRarity: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  tileEquipped: {
    color: C.gold, fontSize: 9, fontWeight: '900', letterSpacing: 1, marginTop: 2,
  },
  tileLocked: {
    color: C.textMuted, fontSize: 9, fontWeight: '700', marginTop: 2,
  },
  cupCta: {
    marginTop: 14, backgroundColor: C.gold + '22', borderColor: C.gold, borderWidth: 1,
    borderRadius: 8, paddingVertical: 14, alignItems: 'center',
  },
  cupCtaText: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 1 },
});
