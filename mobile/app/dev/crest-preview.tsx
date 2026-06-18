/**
 * Dev-only preview screen for the rank crests + celebration animations.
 *
 * Navigate to `/dev/crest-preview` to see:
 *   • All 5 rank tiers at three sizes (32 / 64 / 96 px) side by side
 *   • Four buttons to trigger Birdie / Eagle / Ace / Albatross celebrations
 *     so the animation timing and theme music can be tested without
 *     having to actually shoot a birdie in a live match
 *
 * Keep this in the prod build — it's gated behind the URL path, no users
 * will land on it organically, and it's invaluable for design iteration.
 * Could be moved behind an admin gate later if it ever leaks.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { RankCrest } from '../../components/RankCrest';
import {
  HoleScoreCelebration, CelebrationEvent, CelebrationKind,
} from '../../components/HoleScoreCelebration';
import { C, F } from '../../lib/colors';

// SR that lands squarely in each tier (per RankCrest's tierFromElo logic):
//   Bronze   < 1400
//   Silver   1400–1599
//   Gold     1600–1799
//   Platinum 1800–1999
//   Diamond  2000+
const TIERS: { label: string; elo: number; floor: number }[] = [
  { label: 'Bronze',   elo: 1200, floor: 0 },
  { label: 'Silver',   elo: 1500, floor: 1400 },
  { label: 'Gold',     elo: 1700, floor: 1600 },
  { label: 'Platinum', elo: 1900, floor: 1800 },
  { label: 'Diamond',  elo: 2200, floor: 2000 },
];

const KINDS: { kind: CelebrationKind; label: string }[] = [
  { kind: 'birdie',    label: 'BIRDIE'      },
  { kind: 'eagle',     label: 'EAGLE'       },
  { kind: 'ace',       label: 'HOLE IN ONE' },
  { kind: 'albatross', label: 'ALBATROSS'   },
];

export default function CrestPreviewScreen() {
  const [event, setEvent] = useState<CelebrationEvent | null>(null);
  // Which crest tier the triggered celebration uses for its avatar ring.
  // Letting you preview "Diamond player aces hole" — the most extreme combo.
  const [previewElo, setPreviewElo] = useState(2200);

  const fire = (kind: CelebrationKind) => {
    setEvent({
      kind,
      username: 'rich1468',
      avatarUrl: null,
      elo: previewElo,
      hole: 7,
      score: kind === 'ace' ? 1 : kind === 'albatross' ? 1 : kind === 'eagle' ? 3 : 3,
      par: kind === 'ace' ? 3 : kind === 'albatross' ? 4 : kind === 'eagle' ? 5 : 4,
      themePreview: null,    // no audio in preview — skip to focus on visuals
      themeTitle: 'Eye of the Tiger',
    });
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Crest + Celebration Preview' }} />
      <ScrollView contentContainerStyle={s.scroll}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backBtnText}>← Back</Text>
        </TouchableOpacity>

        <Text style={s.h1}>Rank Crests</Text>
        <Text style={s.sub}>
          Each tier rendered at 32 / 64 / 96 px. The decoration set strictly
          adds as you climb — Bronze is a single ring, Diamond is triple-ring
          + crown + animated sparkle pulse.
        </Text>

        {TIERS.map((t) => (
          <View key={t.label} style={s.tierRow}>
            <View style={s.tierMeta}>
              <Text style={s.tierLabel}>{t.label}</Text>
              <Text style={s.tierElo}>{t.floor === 0 ? `< ${1400}` : `${t.floor}+`} SR</Text>
            </View>
            <View style={s.crestRow}>
              <View style={s.crestSlot}>
                <RankCrest elo={t.elo} size={32} username="r" />
                <Text style={s.sizeLabel}>32</Text>
              </View>
              <View style={s.crestSlot}>
                <RankCrest elo={t.elo} size={64} username="r" />
                <Text style={s.sizeLabel}>64</Text>
              </View>
              <View style={s.crestSlot}>
                <RankCrest elo={t.elo} size={96} username="r" />
                <Text style={s.sizeLabel}>96</Text>
              </View>
            </View>
          </View>
        ))}

        <Text style={[s.h1, { marginTop: 32 }]}>Celebrations</Text>
        <Text style={s.sub}>
          Tap to fire each animation. The avatar in the burst uses the
          currently-selected tier crest below, so you can preview combinations
          like "Diamond player aces hole" (triple-ring crest pulses inside
          the storm of sparkles).
        </Text>

        {/* Tier picker for the celebration avatar */}
        <Text style={s.label}>Crest tier for celebration:</Text>
        <View style={s.tierPicker}>
          {TIERS.map((t) => {
            const isActive = previewElo >= t.floor && (t.floor === 0 || previewElo < (TIERS[TIERS.indexOf(t) + 1]?.floor ?? 99999));
            return (
              <TouchableOpacity
                key={t.label}
                style={[s.tierPickerBtn, isActive && s.tierPickerBtnActive]}
                onPress={() => setPreviewElo(t.elo)}
              >
                <Text style={[s.tierPickerLabel, isActive && s.tierPickerLabelActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Trigger buttons */}
        <View style={s.kindGrid}>
          {KINDS.map((k) => (
            <TouchableOpacity key={k.kind} style={s.kindBtn} onPress={() => fire(k.kind)}>
              <Text style={s.kindBtnLabel}>{k.label}</Text>
              <Text style={s.kindBtnSub}>
                {k.kind === 'birdie' ? '5.5s · gold burst'
                : k.kind === 'eagle' ? '7.5s · sage + green'
                : k.kind === 'ace'   ? '9.5s · sparkle storm'
                                     : '9.5s · diamond-blue storm'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.note}>
          Preview fires WITHOUT audio so you can replay rapidly. Real
          celebrations in-match play the scoring player's clan theme
          (team match) or personal theme (solo match) at 0.8 volume.
        </Text>
      </ScrollView>

      <HoleScoreCelebration event={event} onDismiss={() => setEvent(null)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingTop: 60, paddingBottom: 60 },

  backBtn: { alignSelf: 'flex-start', marginBottom: 16 },
  backBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },

  h1: {
    color: C.text, fontFamily: F.serif, fontSize: 28, fontWeight: '900',
    marginBottom: 8,
  },
  sub: { color: C.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 18 },
  label: { color: C.textMuted, fontWeight: '800', fontSize: 10, letterSpacing: 1.2, marginBottom: 8 },

  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginBottom: 10,
    gap: 12,
  },
  tierMeta: { width: 90 },
  tierLabel: { color: C.text, fontFamily: F.serif, fontSize: 18, fontWeight: '900' },
  tierElo:   { color: C.gold, fontSize: 11, fontWeight: '700', marginTop: 2 },
  crestRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end' },
  crestSlot: { alignItems: 'center', gap: 4 },
  sizeLabel: { color: C.textMuted, fontSize: 9, fontWeight: '700' },

  tierPicker: { flexDirection: 'row', gap: 6, marginBottom: 16 },
  tierPickerBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    alignItems: 'center',
  },
  tierPickerBtnActive: { borderColor: C.gold, backgroundColor: C.gold + '22' },
  tierPickerLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800' },
  tierPickerLabelActive: { color: C.gold },

  kindGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kindBtn: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: C.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.gold + '88',
    paddingVertical: 18,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  kindBtnLabel: { color: C.gold, fontFamily: F.serif, fontSize: 18, fontWeight: '900' },
  kindBtnSub: { color: C.textMuted, fontSize: 10, marginTop: 4 },

  note: { color: C.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 24, lineHeight: 15 },
});
