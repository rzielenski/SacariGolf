/**
 * Birdie / eagle / hole-in-one celebration overlay.
 *
 *   <HoleScoreCelebration
 *     event={{
 *       kind: 'eagle',
 *       username: 'rich1468',
 *       avatarUrl: '/uploads/avatar/abc.jpg',
 *       elo: 1820,
 *       hole: 7,
 *       score: 3,
 *       par: 5,
 *       themePreview: 'https://...m4a',
 *       themeTitle: 'Eye of the Tiger',
 *     }}
 *     onDismiss={() => setEvent(null)}
 *   />
 *
 * Modal-overlay shown on both the scoring player's screen and on every
 * opponent's screen the instant a birdie / eagle / hole-in-one lands. The
 * scoring player's theme song plays in the background (their personal
 * theme for solos, clan theme for team matches — caller is responsible
 * for picking which one to pass).
 *
 * Three distinct animation variants, escalating in intensity:
 *   • Birdie    — modest gold burst, single label, brief
 *   • Eagle     — bigger gold + green burst, multi-layered, sustained
 *   • Ace/HIO   — full-screen takeover, sustained sparkle storm, fireworks
 *
 * Auto-dismisses after `holdMs` (default 6.5s for birdie/eagle, 9s for
 * ace) — tap anywhere to skip. The audio stops on dismiss; no fade-out
 * (expo-av's volume ramping is fiddly and the hard cut feels appropriate
 * to the punchy nature of the moment).
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, Image, TouchableOpacity, Easing, Modal,
} from 'react-native';
import { Audio } from 'expo-av';
import { C, F } from '../lib/colors';
import { API_BASE } from '../lib/api';
import { RankCrest } from './RankCrest';

export type CelebrationKind = 'birdie' | 'eagle' | 'ace' | 'albatross';

export interface CelebrationEvent {
  kind: CelebrationKind;
  username: string;
  avatarUrl?: string | null;
  elo?: number | null;
  hole: number;
  score: number;
  par: number;
  /** Audio preview URL — typically the scoring player's clan_theme_preview
   *  for team matches, user_theme_preview for solo. Null = silent celebration. */
  themePreview?: string | null;
  themeTitle?: string | null;
}

interface Props {
  event: CelebrationEvent | null;
  onDismiss: () => void;
}

const HOLD_MS: Record<CelebrationKind, number> = {
  birdie: 5_500,
  eagle: 7_500,
  ace: 9_500,
  albatross: 9_500,
};

const LABEL: Record<CelebrationKind, string> = {
  birdie:    'BIRDIE',
  eagle:     'EAGLE',
  ace:       'HOLE IN ONE!',
  albatross: 'ALBATROSS',
};

const ACCENT: Record<CelebrationKind, string> = {
  birdie:    C.gold,
  eagle:     '#7aab78',  // sage green
  ace:       '#f0c95a',  // bright gold
  albatross: '#a8d8f0',  // diamond ice (rarer than ace, lean cool)
};

export function HoleScoreCelebration({ event, onDismiss }: Props) {
  const kind = event?.kind ?? 'birdie';
  const accent = ACCENT[kind];

  // ── Animation drivers ───────────────────────────────────────────────
  // Birdie/eagle: simpler scale + fade timeline.
  // Ace/albatross: adds a long-running sparkle storm loop.
  const fadeIn = useRef(new Animated.Value(0)).current;
  const labelScale = useRef(new Animated.Value(0)).current;
  const cardSlide = useRef(new Animated.Value(40)).current;
  const burstScale = useRef(new Animated.Value(0)).current;
  const stormPulse = useRef(new Animated.Value(0)).current;

  const soundRef = useRef<Audio.Sound | null>(null);
  // Track the event we last animated. Same kind back-to-back (a player
  // birdies hole 4 then birdies hole 5) should re-fire animation — so we
  // key on the parent passing a fresh event object.
  const lastEventRef = useRef<CelebrationEvent | null>(null);

  useEffect(() => {
    if (!event) {
      lastEventRef.current = null;
      return;
    }
    if (lastEventRef.current === event) return;
    lastEventRef.current = event;

    fadeIn.setValue(0);
    labelScale.setValue(0);
    cardSlide.setValue(40);
    burstScale.setValue(0);
    stormPulse.setValue(0);

    const sequence = Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 240, useNativeDriver: true }),
      Animated.spring(labelScale, { toValue: 1, friction: 4, tension: 80, useNativeDriver: true }),
      Animated.timing(cardSlide, { toValue: 0, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(burstScale, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]);
    sequence.start();

    // Sparkle storm for ace/albatross — sustained loop while overlay is up.
    let stormLoop: Animated.CompositeAnimation | null = null;
    if (kind === 'ace' || kind === 'albatross') {
      stormLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(stormPulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(stormPulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      );
      stormLoop.start();
    }

    // Auto-dismiss after the hold duration. Cleanup clears the timeout if
    // the user taps to skip first.
    const t = setTimeout(onDismiss, HOLD_MS[kind]);

    return () => {
      clearTimeout(t);
      stormLoop?.stop();
    };
  }, [event, kind, fadeIn, labelScale, cardSlide, burstScale, stormPulse, onDismiss]);

  // ── Audio lifecycle ────────────────────────────────────────────────
  // Plays the scoring player's theme for the duration of the overlay.
  // Hard-cut on dismiss (no fade-out — expo-av's volume ramping is fiddly
  // and a hard cut suits the punchy moment).
  useEffect(() => {
    if (!event?.themePreview) return;
    let cancelled = false;
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          { uri: event.themePreview! },
          { shouldPlay: true, volume: 0.8 },
        );
        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        soundRef.current = sound;
      } catch { /* audio is non-essential */ }
    })();
    return () => {
      cancelled = true;
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => { });
        soundRef.current.unloadAsync().catch(() => { });
        soundRef.current = null;
      }
    };
  }, [event?.themePreview]);

  // ── Sparkle ring positions ─────────────────────────────────────────
  // Computed once per kind — bigger tier = more sparkles in the burst.
  const sparkleCount = useMemo(() => {
    if (kind === 'ace' || kind === 'albatross') return 18;
    if (kind === 'eagle') return 12;
    return 8;
  }, [kind]);

  if (!event) return null;

  // Burst ring — sparkles flying outward from the avatar. The transform
  // is a scale on a parent View that the children sit inside at fixed
  // angles, giving a "explosion outward" effect from a single origin.
  const burstRadius = burstScale.interpolate({ inputRange: [0, 1], outputRange: [0, 160] });

  return (
    <Modal
      visible={!!event}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <TouchableOpacity
        style={StyleSheet.absoluteFill}
        activeOpacity={1}
        onPress={onDismiss}
      >
        <Animated.View style={[s.backdrop, { opacity: fadeIn }]}>
          {/* Sparkle storm — only renders for ace/albatross; sits BEHIND the
              main card. Uses absolute-positioned glyphs that pulse via
              stormPulse opacity + scale. */}
          {(kind === 'ace' || kind === 'albatross') && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              {STORM_POSITIONS.map((pos, i) => (
                <Animated.Text
                  key={`storm-${i}`}
                  style={[
                    s.stormGlyph,
                    {
                      left: `${pos.x}%`,
                      top: `${pos.y}%`,
                      color: accent,
                      fontSize: pos.size,
                      opacity: stormPulse.interpolate({
                        // Stagger so they don't all peak together.
                        inputRange: [0, 1],
                        outputRange: [0.15 + (i % 3) * 0.1, 0.7 + (i % 3) * 0.1],
                      }),
                      transform: [{
                        scale: stormPulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.7 + (i % 4) * 0.1, 1.2 + (i % 4) * 0.05],
                        }),
                      }],
                    },
                  ]}
                >
                  {pos.glyph}
                </Animated.Text>
              ))}
            </View>
          )}

          {/* Card with the player + score */}
          <Animated.View
            style={[
              s.card,
              { borderColor: accent, transform: [{ translateY: cardSlide }] },
            ]}
          >
            {/* Big label — BIRDIE / EAGLE / HOLE IN ONE */}
            <Animated.View style={[s.labelWrap, { transform: [{ scale: labelScale }] }]}>
              <Text style={[s.bigLabel, { color: accent }]} numberOfLines={1} adjustsFontSizeToFit>
                {LABEL[kind]}
              </Text>
              {(kind === 'ace' || kind === 'albatross') && (
                <Text style={[s.bigLabel, s.bigLabelEcho, { color: accent }]} numberOfLines={1} adjustsFontSizeToFit>
                  {LABEL[kind]}
                </Text>
              )}
            </Animated.View>

            {/* Burst — sparkles flying outward from the avatar */}
            <View style={s.avatarBurstHolder}>
              {Array.from({ length: sparkleCount }).map((_, i) => {
                const angle = (i / sparkleCount) * 2 * Math.PI;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                return (
                  <Animated.Text
                    key={`burst-${i}`}
                    style={[
                      s.burstGlyph,
                      {
                        color: accent,
                        opacity: burstScale.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 0.4] }),
                        transform: [
                          { translateX: Animated.multiply(burstRadius, cos) },
                          { translateY: Animated.multiply(burstRadius, sin) },
                          { scale: burstScale.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
                        ],
                      },
                    ]}
                  >
                    ✦
                  </Animated.Text>
                );
              })}

              {/* Crested avatar in the center. Falls back to a letter tile
                  inside the crest if the user has no avatar set. */}
              <RankCrest elo={event.elo ?? 0} size={88}>
                {event.avatarUrl ? (
                  <Image
                    source={{ uri: `${API_BASE}${event.avatarUrl}` }}
                    style={{ width: 88, height: 88, borderRadius: 44 }}
                  />
                ) : (
                  <View style={s.avatarLetterFallback}>
                    <Text style={s.avatarLetterText}>
                      {event.username?.[0]?.toUpperCase() ?? '?'}
                    </Text>
                  </View>
                )}
              </RankCrest>
            </View>

            <Text style={s.username} numberOfLines={1}>{event.username}</Text>
            <Text style={s.holeLine}>
              HOLE {event.hole} · PAR {event.par} · SCORE {event.score}
            </Text>

            {event.themeTitle && (
              <View style={[s.themePill, { borderColor: accent }]}>
                <Text style={[s.themePillLabel, { color: accent }]}>♫ ANTHEM</Text>
                <Text style={s.themePillTitle} numberOfLines={1}>{event.themeTitle}</Text>
              </View>
            )}

            <Text style={s.dismissHint}>tap anywhere to dismiss</Text>
          </Animated.View>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

/** Pre-shuffled sparkle positions for the ace/albatross storm. Hand-tuned
 *  rather than random-on-mount so the layout reads the same every time —
 *  no flicker of "different sparkles" each fire. Percentages so it adapts
 *  to phone size. */
const STORM_POSITIONS: { x: number; y: number; size: number; glyph: string }[] = [
  { x: 8,  y: 12, size: 28, glyph: '✦' },
  { x: 88, y: 8,  size: 22, glyph: '✧' },
  { x: 18, y: 28, size: 18, glyph: '✦' },
  { x: 78, y: 22, size: 32, glyph: '✦' },
  { x: 4,  y: 48, size: 24, glyph: '✧' },
  { x: 92, y: 42, size: 28, glyph: '✦' },
  { x: 12, y: 68, size: 22, glyph: '✦' },
  { x: 82, y: 64, size: 18, glyph: '✧' },
  { x: 22, y: 82, size: 30, glyph: '✦' },
  { x: 72, y: 86, size: 22, glyph: '✦' },
  { x: 40, y: 6,  size: 20, glyph: '✧' },
  { x: 56, y: 4,  size: 26, glyph: '✦' },
  { x: 48, y: 92, size: 28, glyph: '✦' },
  { x: 36, y: 84, size: 18, glyph: '✧' },
  { x: 64, y: 80, size: 22, glyph: '✦' },
  { x: 2,  y: 32, size: 16, glyph: '✧' },
  { x: 96, y: 30, size: 20, glyph: '✦' },
  { x: 6,  y: 80, size: 22, glyph: '✦' },
];

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.93)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 2,
    paddingHorizontal: 26,
    paddingVertical: 24,
    alignItems: 'center',
    width: '82%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  labelWrap: {
    marginBottom: 18,
    alignItems: 'center',
  },
  bigLabel: {
    fontFamily: F.serif,
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 1.5,
    textAlign: 'center',
    textShadowColor: 'rgba(255,210,90,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  // Echo label sits behind for ace/albatross — gives a "halo" duplicate
  // that makes the type feel heavier. Absolute over the live label so the
  // primary stays sharp; this just adds bleed.
  bigLabelEcho: {
    position: 'absolute',
    opacity: 0.35,
    transform: [{ scale: 1.1 }],
  },
  avatarBurstHolder: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  burstGlyph: {
    position: 'absolute',
    fontSize: 18,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  avatarLetterFallback: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: C.cardAlt,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetterText: { color: C.gold, fontFamily: F.serif, fontSize: 36, fontWeight: '900' },
  username: {
    color: C.text,
    fontFamily: F.serif,
    fontWeight: '900',
    fontSize: 22,
    marginTop: 14,
    textAlign: 'center',
  },
  holeLine: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginTop: 4,
  },
  themePill: {
    marginTop: 18,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
    borderWidth: 1,
    maxWidth: '100%',
  },
  themePillLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2, textAlign: 'center' },
  themePillTitle: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  dismissHint: {
    color: C.textDim,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 20,
  },

  stormGlyph: {
    position: 'absolute',
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
