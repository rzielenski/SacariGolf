/**
 * Golfer avatar builder — customize a Bitmoji-style character (skin, build,
 * hair, clothes, hat, shoes, extras) with a live preview, then save it as your
 * avatar. Backed by lib/avatar.ts (catalog) + components/GolfAvatar.tsx
 * (renderer) + PATCH /users/me { avatarConfig, avatarType }.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert, ActivityIndicator,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { GolfAvatar } from '../components/GolfAvatar';
import {
  type AvatarConfig, normalizeAvatar,
  SKIN_TONES, BUILDS, HAIR_STYLES, HAIR_COLORS, FACIAL_HAIR,
  SHIRT_STYLES, CLOTHING_COLORS, BOTTOMS, HATS, ACCESSORIES,
} from '../lib/avatar';

type CatKind = 'skin' | 'color' | 'style';
type Category = { key: keyof AvatarConfig; label: string; kind: CatKind; options: { key: string; label: string; hex?: string }[] };

const CATEGORIES: Category[] = [
  { key: 'skin',        label: 'Skin',     kind: 'skin',  options: SKIN_TONES },
  { key: 'build',       label: 'Build',    kind: 'style', options: BUILDS },
  { key: 'hair',        label: 'Hair',     kind: 'style', options: HAIR_STYLES },
  { key: 'hairColor',   label: 'Hair Color', kind: 'color', options: HAIR_COLORS },
  { key: 'facialHair',  label: 'Beard',    kind: 'style', options: FACIAL_HAIR },
  { key: 'shirt',       label: 'Shirt',    kind: 'style', options: SHIRT_STYLES },
  { key: 'shirtColor',  label: 'Shirt Color', kind: 'color', options: CLOTHING_COLORS },
  { key: 'bottom',      label: 'Bottoms',  kind: 'style', options: BOTTOMS },
  { key: 'bottomColor', label: 'Bottom Color', kind: 'color', options: CLOTHING_COLORS },
  { key: 'shoeColor',   label: 'Shoes',    kind: 'color', options: CLOTHING_COLORS },
  { key: 'hat',         label: 'Hat',      kind: 'style', options: HATS },
  { key: 'hatColor',    label: 'Hat Color', kind: 'color', options: CLOTHING_COLORS },
  { key: 'accessory',   label: 'Extras',   kind: 'style', options: ACCESSORIES },
];

function randPick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)]; }

export default function AvatarBuilder() {
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useAuth();
  const [cfg, setCfg] = useState<AvatarConfig>(() => normalizeAvatar((user as any)?.avatar_config));
  const [useAsAvatar, setUseAsAvatar] = useState((user as any)?.avatar_type === 'character');
  const [saving, setSaving] = useState(false);
  const [activeCat, setActiveCat] = useState<keyof AvatarConfig>('skin');

  const category = useMemo(() => CATEGORIES.find((c) => c.key === activeCat)!, [activeCat]);

  const set = (key: keyof AvatarConfig, value: string) => setCfg((c) => ({ ...c, [key]: value }));
  const randomize = () => {
    const next: AvatarConfig = { ...cfg };
    for (const c of CATEGORIES) (next as any)[c.key] = randPick(c.options).key;
    // Keep a hat on more often than pure-random would; bald+no-hat is fine too.
    setCfg(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.users.update({ avatarConfig: cfg as any, avatarType: useAsAvatar ? 'character' : 'photo' });
      await refreshUser();
      router.back();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Your Golfer', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />

      {/* Live preview */}
      <View style={s.preview}>
        <GolfAvatar config={cfg} size={230} />
        <TouchableOpacity style={s.randomBtn} onPress={randomize} activeOpacity={0.85}>
          <Text style={s.randomText}>🎲  Randomize</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push('/dev/avatar-lab' as any)} style={{ marginTop: 8 }}>
          <Text style={s.artLink}>Preview other art styles →</Text>
        </TouchableOpacity>
      </View>

      {/* Category tabs */}
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.catRow}>
          {CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[s.catChip, activeCat === c.key && s.catChipOn]}
              onPress={() => setActiveCat(c.key)}
            >
              <Text style={[s.catChipText, activeCat === c.key && s.catChipTextOn]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Options for the active category */}
      <ScrollView contentContainerStyle={s.optionsWrap}>
        <View style={s.optionsGrid}>
          {category.options.map((opt) => {
            const selected = (cfg as any)[category.key] === opt.key;
            if (category.kind === 'style') {
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[s.stylePill, selected && s.stylePillOn]}
                  onPress={() => set(category.key, opt.key)}
                >
                  <Text style={[s.stylePillText, selected && s.stylePillTextOn]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            }
            // color / skin swatch
            return (
              <TouchableOpacity key={opt.key} style={s.swatchWrap} onPress={() => set(category.key, opt.key)}>
                <View style={[s.swatch, { backgroundColor: opt.hex }, selected && s.swatchOn]} />
                <Text style={[s.swatchLabel, selected && { color: C.gold }]} numberOfLines={1}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* Use-as-avatar toggle + Save */}
      <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
        <View style={s.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Use my golfer as my avatar</Text>
            <Text style={s.toggleHint}>Shows in place of your photo across the app.</Text>
          </View>
          <Switch value={useAsAvatar} onValueChange={setUseAsAvatar} trackColor={{ true: C.gold, false: C.border }} thumbColor="#fff" />
        </View>
        <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} activeOpacity={0.85}>
          {saving ? <ActivityIndicator color={C.bg} /> : <Text style={s.saveText}>Save Golfer</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  preview: {
    alignItems: 'center', paddingTop: 8, paddingBottom: 4,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  randomBtn: {
    marginTop: -6, backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8,
  },
  randomText: { color: C.gold, fontWeight: '800', fontSize: 13 },
  artLink: { color: C.textMuted, fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' },

  catRow: { gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  catChip: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  catChipOn: { backgroundColor: C.gold, borderColor: C.gold },
  catChipText: { color: C.textMuted, fontWeight: '800', fontSize: 12.5 },
  catChipTextOn: { color: C.bg },

  optionsWrap: { padding: 16, paddingTop: 6 },
  optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },

  stylePill: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 12, minWidth: 96, alignItems: 'center',
  },
  stylePillOn: { borderColor: C.gold, backgroundColor: C.gold + '1c' },
  stylePillText: { color: C.text, fontWeight: '700', fontSize: 13 },
  stylePillTextOn: { color: C.gold },

  swatchWrap: { alignItems: 'center', width: 64 },
  swatch: {
    width: 46, height: 46, borderRadius: 23, borderWidth: 2, borderColor: 'rgba(255,255,255,0.12)',
  },
  swatchOn: { borderColor: C.gold, borderWidth: 3 },
  swatchLabel: { color: C.textMuted, fontSize: 10.5, marginTop: 5, fontWeight: '600' },

  footer: { borderTopWidth: 1, borderTopColor: C.border, padding: 16, gap: 12, backgroundColor: C.bg },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { color: C.text, fontWeight: '700', fontSize: 14 },
  toggleHint: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  saveBtn: { backgroundColor: C.gold, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  saveText: { color: C.bg, fontWeight: '900', fontSize: 15, letterSpacing: 0.5 },
});
