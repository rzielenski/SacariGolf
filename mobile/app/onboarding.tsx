import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, useWindowDimensions, NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C, F } from '../lib/colors';
import { Diamond, Divider } from '../components/Flourish';

/**
 * First-launch onboarding. Four swipeable cards introducing the app's core
 * loop. Shown once per device — gates on AsyncStorage('sacari.onboarded') so
 * we don't spam returning users.
 *
 * Mark complete via the button on the final card OR a "Skip" link in the
 * header. Either path writes the flag and replaces with the home tab.
 */
export const ONBOARDING_KEY = 'sacari.onboarded.v1';

const SLIDES: { mark: string; title: string; body: string }[] = [
  {
    mark: 'I',
    title: 'Play Real Rounds',
    body: 'Solo, duo, or full-team matches with ranked ELO. Pick a course, drop your tee, and your strokes flow into your handicap, club stats, and match history automatically.',
  },
  {
    mark: 'II',
    title: 'Track Every Shot',
    body: 'Tap CLUB on the live map to log each swing — distance, club, direction. Premium unlocks per-club dispersion heatmaps and weather-adjusted plays-like distances.',
  },
  {
    mark: 'III',
    title: 'Improve & Compare',
    body: 'See your scoring averages by par, your hardest hole, and your trend over the last 10 rounds. Compare against friends or join a clan ladder.',
  },
  {
    mark: 'IV',
    title: 'Drop Pins, Earn Perks',
    body: 'When you finish a hole, tap DROP PIN at the cup. Contribute on most of your holes in a round and you earn a Lucky Round perk — protects a loss or doubles a win.',
  },
];

export default function OnboardingScreen() {
  const { width: W } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const finish = async () => {
    try { await AsyncStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* non-fatal */ }
    router.replace('/(tabs)/' as any);
  };

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / W);
    setPage(Math.max(0, Math.min(SLIDES.length - 1, idx)));
  };

  const next = () => {
    if (page >= SLIDES.length - 1) { finish(); return; }
    scrollRef.current?.scrollTo({ x: (page + 1) * W, animated: true });
  };

  return (
    <View style={s.container}>
      {/* Skip — top-right, dim so it's available but doesn't compete */}
      <TouchableOpacity style={s.skipBtn} onPress={finish}>
        <Text style={s.skipText}>Skip</Text>
      </TouchableOpacity>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        style={{ flex: 1 }}
      >
        {SLIDES.map((slide, i) => (
          <View key={i} style={[s.slide, { width: W }]}>
            <View style={s.markBadge}>
              <Text style={s.markText}>{slide.mark}</Text>
            </View>
            <Divider style={{ marginTop: 8, width: 220 }} />
            <Text style={s.title}>{slide.title}</Text>
            <Text style={s.body}>{slide.body}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Page dots */}
      <View style={s.dots}>
        {SLIDES.map((_, i) => (
          <Diamond
            key={i}
            size={i === page ? 9 : 6}
            color={i === page ? C.gold : C.textDim}
            filled={i === page}
            style={{ marginHorizontal: 4 }}
          />
        ))}
      </View>

      <TouchableOpacity style={s.nextBtn} onPress={next} activeOpacity={0.85}>
        <Text style={s.nextText}>{page >= SLIDES.length - 1 ? 'Start Playing' : 'Next →'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 60, paddingBottom: 40 },

  skipBtn: { position: 'absolute', top: 60, right: 20, padding: 8, zIndex: 10 },
  skipText: { color: C.textMuted, fontSize: 14, fontWeight: '600' },

  slide: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  markBadge: {
    width: 92, height: 92, borderRadius: 46,
    borderWidth: 2, borderColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.card,
    shadowColor: C.gold, shadowOpacity: 0.4, shadowRadius: 18,
  },
  markText: { color: C.gold, fontFamily: F.serif, fontSize: 38, fontWeight: '900' },
  title: { color: C.text, fontFamily: F.serif, fontSize: 28, fontWeight: '900', marginTop: 18, textAlign: 'center' },
  body:  { color: C.textMuted, fontSize: 15, lineHeight: 22, marginTop: 14, textAlign: 'center' },

  dots: { flexDirection: 'row', justifyContent: 'center', marginVertical: 24, alignItems: 'center', minHeight: 14 },

  nextBtn: {
    marginHorizontal: 32, paddingVertical: 16, borderRadius: 14,
    backgroundColor: C.gold, alignItems: 'center',
  },
  nextText: { color: '#000', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 },
});
