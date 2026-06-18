/**
 * Dev-only VFX preview. Navigate to `/dev/vfx-preview` to see, on a real device:
 *   • Every animated profile background rendered as a live tile
 *   • Buttons to fire each celebration (birdie / eagle / ace / albatross)
 *   • A button to play the match-found "VS" intro
 *
 * Gated behind the URL path (no user lands here organically), kept in the build
 * so the VFX can be checked without shooting a real birdie or finding a match.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, Dimensions } from 'react-native';
import { Stack } from 'expo-router';
import { CosmeticBackground } from '../../components/Cosmetics';
import { HoleScoreCelebration, CelebrationEvent, CelebrationKind } from '../../components/HoleScoreCelebration';
import { MatchFoundIntro, SidePlayer } from '../../components/MatchFoundIntro';
import { C, F } from '../../lib/colors';

const BACKGROUNDS: { style: string; name: string }[] = [
  { style: 'gradient', name: 'Gradient' },
  { style: 'aurora', name: 'Aurora' },
  { style: 'stars', name: 'Cosmic' },
  { style: 'nebula', name: 'Nebula' },
  { style: 'meteor', name: 'Meteor Shower' },
  { style: 'plasma', name: 'Plasma' },
  { style: 'prism', name: 'Prism' },
  { style: 'flame', name: 'Flame' },
  { style: 'embers', name: 'Fireflies' },
  { style: 'solar', name: 'Solar Flare' },
  { style: 'holographic', name: 'Holographic' },
  { style: 'liquid', name: 'Liquid Gold' },
  { style: 'cyber', name: 'Cyber Grid' },
  { style: 'synthwave', name: 'Synthwave' },
  { style: 'matrix', name: 'Digital Rain' },
  { style: 'eclipse', name: 'Eclipse' },
  { style: 'storm', name: 'Storm' },
  { style: 'thunder', name: 'Tempest' },
  { style: 'ocean', name: 'Ocean' },
  { style: 'blizzard', name: 'Blizzard' },
  { style: 'sakura', name: 'Sakura' },
  { style: 'dusk', name: 'Golden Hour' },
  { style: 'flag', name: 'Old Glory' },
];

// Score/par that lands each tier at the right kind.
const CELEB: Record<CelebrationKind, { hole: number; score: number; par: number }> = {
  birdie:    { hole: 4, score: 3, par: 4 },
  eagle:     { hole: 7, score: 3, par: 5 },
  ace:       { hole: 12, score: 1, par: 3 },
  albatross: { hole: 15, score: 2, par: 5 },
};

const SCREEN_W = Dimensions.get('window').width;
const TILE_W = (SCREEN_W - 18 * 2 - 10) / 2;

export default function VfxPreview() {
  const [celeb, setCeleb] = useState<CelebrationKind | null>(null);
  const [introVisible, setIntroVisible] = useState(false);

  const event: CelebrationEvent | null = celeb
    ? { kind: celeb, username: 'RickyBobbyFairways', elo: 1850, themePreview: null, themeTitle: null, ...CELEB[celeb] }
    : null;

  const me: SidePlayer = { user_id: 'me', username: 'You', elo: 1850 };
  const opp: SidePlayer = { user_id: 'opp', username: 'Challenger', elo: 1880 };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'VFX Preview', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>

        <Text style={s.section}>EVENT ANIMATIONS</Text>
        <View style={s.btnRow}>
          {(['birdie', 'eagle', 'ace', 'albatross'] as CelebrationKind[]).map((k) => (
            <TouchableOpacity key={k} style={s.btn} onPress={() => setCeleb(k)} activeOpacity={0.85}>
              <Text style={s.btnText}>{k.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={[s.btn, s.btnWide]} onPress={() => setIntroVisible(true)} activeOpacity={0.85}>
          <Text style={s.btnText}>PLAY MATCH-FOUND INTRO</Text>
        </TouchableOpacity>

        <Text style={s.section}>BACKGROUNDS</Text>
        <View style={s.grid}>
          {BACKGROUNDS.map((b) => (
            <View key={b.style} style={s.tile}>
              <CosmeticBackground visual={{ style: b.style }} style={StyleSheet.absoluteFill} />
              <View style={s.tileLabelWrap}>
                <Text style={s.tileLabel}>{b.name}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      <HoleScoreCelebration event={event} onDismiss={() => setCeleb(null)} />
      <MatchFoundIntro
        visible={introVisible}
        matchType="solo"
        meSide={1}
        side1Players={[me]}
        side2Players={[opp]}
        onDismiss={() => setIntroVisible(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  section: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.5, marginTop: 18, marginBottom: 10 },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8,
    paddingVertical: 12, paddingHorizontal: 14, flexGrow: 1, alignItems: 'center',
  },
  btnWide: { marginTop: 8 },
  btnText: { color: C.gold, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    width: TILE_W, height: 130, borderRadius: 10, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border, justifyContent: 'flex-end',
  },
  tileLabelWrap: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 8, paddingVertical: 5 },
  tileLabel: { color: '#ffffff', fontFamily: F.serif, fontSize: 12, fontWeight: '700' },
});
