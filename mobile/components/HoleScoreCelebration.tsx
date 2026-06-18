/**
 * Birdie / eagle / hole-in-one / albatross celebration overlay.
 *
 *   <HoleScoreCelebration event={{ kind, username, avatarUrl, elo, hole, score,
 *     par, themePreview, themeTitle }} onDismiss={() => setEvent(null)} />
 *
 * Modal overlay shown on the scoring player's screen AND every opponent's screen
 * the instant a sub-par hole lands. The scorer's theme song plays in the
 * background (clan theme for team matches, personal theme for solos; the caller
 * picks which preview to pass).
 *
 * Four escalating tiers, each with a distinct identity, all built on the shared
 * reanimated + svg VFX primitives in ./vfx (real particle systems, no emoji):
 *   - birdie    — gold sparkle burst + soft halo, quick and tasteful
 *   - eagle     — bigger gold burst + shockwave + confetti + slow god-rays
 *   - albatross — icy platinum crystal shards + prismatic rays, slow and majestic
 *   - ace       — full takeover: god-rays, falling confetti, fireworks, screen flash
 *
 * Auto-dismisses after the tier hold (tap anywhere to skip). Audio is handed to
 * the singleton themePlayer and rides past the overlay's dismiss (the player
 * self-unloads on finish); we never stop it here.
 */

import { useEffect } from 'react';
import {
  View, Text, StyleSheet, Image, Pressable, Modal, Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, interpolate, Easing,
  cancelAnimation, Extrapolation,
} from 'react-native-reanimated';
import * as themePlayer from '../lib/themePlayer';
import { C, F } from '../lib/colors';
import { API_BASE } from '../lib/api';
import { RankCrest } from './RankCrest';
import { useCensor } from '../lib/censor';
import {
  ScreenFlash, ShockwaveRing, ParticleBurst, Confetti, RadialRays,
  SparkleField, GlowPulse, ImpactText, GradStop,
} from './vfx';

export type CelebrationKind = 'birdie' | 'eagle' | 'ace' | 'albatross';

export interface CelebrationEvent {
  kind: CelebrationKind;
  username: string;
  avatarUrl?: string | null;
  elo?: number | null;
  hole: number;
  score: number;
  par: number;
  /** Audio preview URL — clan_theme_preview for team matches, user_theme_preview
   *  for solo. Null = silent celebration. */
  themePreview?: string | null;
  themeTitle?: string | null;
}

interface Props {
  event: CelebrationEvent | null;
  onDismiss: () => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Tier accent palette (cool flair tints; gold stays the metal in every burst).
const ICE    = '#a8d8f0';
const ICE_HI = '#dff3ff';
const AMBER  = '#e8a23a';
const VIOLET = '#7a96b8';
const ACE_HI = '#fff3c4';

const E_OUT   = Easing.out(Easing.cubic);
const E_QUINT = Easing.out(Easing.poly(5));

// Avatar VFX field: a 260px square centred on the 132px crest holder, so the
// burst + rings + halo fan out past the avatar and over the card. Offset is
// (HOLDER - FIELD) / 2 so the field centre lands on the holder centre.
const HOLDER = 132;
const AV = 260;
const AV_OFFSET = (HOLDER - AV) / 2;

// Screen-centred god-ray fan, sized to overspill the longest screen edge.
const RAYS = Math.round(Math.max(SCREEN_W, SCREEN_H) * 1.15);

interface TierCfg {
  hold: number;
  introDur: number;
  introQuint?: boolean;
  label: string;
  accent: string;                                   // label + card rim
  burst: { count: number; color: string; color2: string; dur: number; shape: 'dot' | 'shard'; gravity?: number };
  rings: { count: number; color: string; dur: number } | null;
  confetti: { count: number; colors: string[] } | null;
  sparkles: { count: number; color: string };
  rays: { count: number; color: string; opacity: number; spin: number; gradient?: GradStop[] } | null;
  glow: { color: string; maxOpacity: number };
  flash: { color: string; peak: number } | null;
  fireworks: boolean;
}

const TIER: Record<CelebrationKind, TierCfg> = {
  birdie: {
    hold: 5500, introDur: 340, label: 'BIRDIE', accent: C.gold,
    burst: { count: 18, color: C.gold, color2: C.text, dur: 820, shape: 'dot' },
    rings: null,
    confetti: null,
    sparkles: { count: 8, color: C.goldLight },
    rays: null,
    glow: { color: C.gold, maxOpacity: 0.3 },
    flash: null,
    fireworks: false,
  },
  eagle: {
    hold: 7500, introDur: 360, label: 'EAGLE', accent: C.green,
    burst: { count: 28, color: C.goldLight, color2: AMBER, dur: 900, shape: 'dot' },
    rings: { count: 2, color: C.goldLight, dur: 720 },
    confetti: { count: 26, colors: [C.goldLight, C.gold, C.text, C.green] },
    sparkles: { count: 12, color: C.goldLight },
    rays: { count: 12, color: C.gold, opacity: 0.16, spin: 16000 },
    glow: { color: C.goldLight, maxOpacity: 0.34 },
    flash: null,
    fireworks: false,
  },
  ace: {
    hold: 9500, introDur: 380, label: 'HOLE IN ONE!', accent: C.goldLight,
    burst: { count: 22, color: C.goldLight, color2: ACE_HI, dur: 950, shape: 'dot' },
    rings: { count: 3, color: C.goldLight, dur: 1000 },
    confetti: { count: 40, colors: [C.goldLight, C.gold, C.text, C.green, ACE_HI] },
    sparkles: { count: 22, color: C.goldLight },
    rays: { count: 16, color: C.gold, opacity: 0.24, spin: 14000 },
    glow: { color: C.goldLight, maxOpacity: 0.4 },
    flash: { color: '#fff6da', peak: 0.6 },
    fireworks: true,
  },
  albatross: {
    hold: 9500, introDur: 480, introQuint: true, label: 'ALBATROSS', accent: ICE,
    burst: { count: 18, color: ICE, color2: C.goldLight, dur: 1300, shape: 'shard' },
    rings: { count: 2, color: ICE, dur: 820 },
    confetti: { count: 20, colors: [ICE, ICE_HI, C.text] },
    sparkles: { count: 16, color: ICE },
    rays: {
      count: 14, color: VIOLET, opacity: 0.2, spin: 20000,
      gradient: [
        { offset: 0, color: '#ffffff', opacity: 0 },
        { offset: 0.5, color: ICE, opacity: 0.5 },
        { offset: 1, color: VIOLET, opacity: 0 },
      ],
    },
    glow: { color: ICE, maxOpacity: 0.36 },
    flash: null,
    fireworks: false,
  },
};

export function HoleScoreCelebration({ event, onDismiss }: Props) {
  const c = useCensor();
  const kind: CelebrationKind = event?.kind ?? 'birdie';
  const cfg = TIER[kind];
  const active = !!event;

  // ── Entrance + auto-dismiss, re-fired on each fresh event identity ──────
  const intro = useSharedValue(0);
  useEffect(() => {
    if (!event) return;
    intro.value = 0;
    intro.value = withTiming(1, { duration: cfg.introDur, easing: cfg.introQuint ? E_QUINT : E_OUT });
    const timer = setTimeout(onDismiss, cfg.hold);
    return () => clearTimeout(timer);
    // Keyed on event identity so back-to-back celebrations replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  // ── Audio: hand to the singleton player; it rides past dismiss and
  //    self-unloads on finish. Keyed on the URL so the same anthem doesn't
  //    restart on a same-preview back-to-back event (intended).
  useEffect(() => {
    if (!event?.themePreview) return;
    themePlayer.play(event.themePreview);
  }, [event?.themePreview]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(intro.value, [0, 0.5], [0, 1], Extrapolation.CLAMP),
  }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: interpolate(intro.value, [0, 0.45], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(intro.value, [0, 1], [44, 0], Extrapolation.CLAMP) },
      { scale: interpolate(intro.value, [0, 1], [0.9, 1], Extrapolation.CLAMP) },
    ],
  }));

  if (!event) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onDismiss} statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss}>
        <Animated.View style={[s.backdrop, backdropStyle]}>

          {/* Screen-centred god-rays behind the card */}
          {cfg.rays && (
            <View pointerEvents="none" style={s.raysWrap}>
              <RadialRays
                size={RAYS} count={cfg.rays.count} color={cfg.rays.color}
                opacity={cfg.rays.opacity} spinMs={cfg.rays.spin}
                gradientStops={cfg.rays.gradient} active={active}
              />
            </View>
          )}

          {/* Ambient twinkle */}
          <SparkleField count={cfg.sparkles.count} color={cfg.sparkles.color} active={active} />

          {/* Card */}
          <Animated.View style={[s.card, { borderColor: cfg.accent }, cardStyle]}>
            <ImpactText active={active} replayKey={event} delay={Math.round(cfg.introDur * 0.4)} style={s.labelWrap}>
              <Text style={[s.bigLabel, { color: cfg.accent }]} numberOfLines={1} adjustsFontSizeToFit>
                {cfg.label}
              </Text>
            </ImpactText>

            <View style={s.avatarBurstHolder}>
              {/* Halo behind the avatar */}
              <View pointerEvents="none" style={s.avField}>
                <GlowPulse size={AV} color={cfg.glow.color} maxOpacity={cfg.glow.maxOpacity} active={active} />
              </View>

              {/* Crested avatar (focal point) */}
              <RankCrest elo={event.elo ?? 0} size={88}>
                {event.avatarUrl ? (
                  <Image source={{ uri: `${API_BASE}${event.avatarUrl}` }} style={{ width: 88, height: 88, borderRadius: 44 }} />
                ) : (
                  <View style={s.avatarLetterFallback}>
                    <Text style={s.avatarLetterText}>{c(event.username)[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                )}
              </RankCrest>

              {/* Shockwave + burst in front of the avatar */}
              {cfg.rings && (
                <View pointerEvents="none" style={s.avField}>
                  <ShockwaveRing size={AV} color={cfg.rings.color} rings={cfg.rings.count} durationMs={cfg.rings.dur} active={active} replayKey={event} />
                </View>
              )}
              <View pointerEvents="none" style={s.avField}>
                <ParticleBurst
                  size={AV} count={cfg.burst.count} color={cfg.burst.color} color2={cfg.burst.color2}
                  durationMs={cfg.burst.dur} shape={cfg.burst.shape} gravity={cfg.burst.gravity ?? 0}
                  active={active} replayKey={event}
                />
              </View>
            </View>

            <Text style={s.username} numberOfLines={1}>{c(event.username)}</Text>
            <Text style={s.holeLine}>HOLE {event.hole} · PAR {event.par} · SCORE {event.score}</Text>

            {event.themeTitle && (
              <View style={[s.themePill, { borderColor: cfg.accent }]}>
                <Text style={[s.themePillLabel, { color: cfg.accent }]}>♫ ANTHEM</Text>
                <Text style={s.themePillTitle} numberOfLines={1}>{event.themeTitle}</Text>
              </View>
            )}

            <Text style={s.dismissHint}>tap anywhere to dismiss</Text>
          </Animated.View>

          {/* Falling confetti over the whole scene */}
          {cfg.confetti && (
            <Confetti
              size={SCREEN_W} count={cfg.confetti.count} colors={cfg.confetti.colors}
              origin={{ x: 0.5, y: 0.08 }} gravity={SCREEN_H * 1.5} durationMs={2400}
              active={active} replayKey={event}
            />
          )}

          {/* Ace fireworks */}
          {cfg.fireworks && <FireworkShow active={active} replayKey={event} />}

          {/* Topmost flash (ace opening) */}
          {cfg.flash && (
            <ScreenFlash active={active} color={cfg.flash.color} peak={cfg.flash.peak} durationMs={520} replayKey={event} />
          )}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

/** Ace-only: a finite show of offset bursts staggered across the hold. Each
 *  burst is a one-shot (fires at its delay, never loops) so nothing leaks. */
function FireworkShow({ active, replayKey }: { active: boolean; replayKey: unknown }) {
  const F = 150;
  const shots = [
    { x: 0.22, y: 0.30, delay: 300,  color: C.goldLight },
    { x: 0.78, y: 0.26, delay: 700,  color: ACE_HI },
    { x: 0.50, y: 0.16, delay: 1100, color: C.gold },
    { x: 0.30, y: 0.24, delay: 2700, color: ACE_HI },
    { x: 0.72, y: 0.34, delay: 3100, color: C.goldLight },
    { x: 0.50, y: 0.20, delay: 3500, color: C.gold },
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {shots.map((sh, i) => (
        <View key={i} style={{ position: 'absolute', left: sh.x * SCREEN_W - F / 2, top: sh.y * SCREEN_H - F / 2, width: F, height: F }}>
          <ParticleBurst
            size={F} count={12} color={sh.color} color2={C.text} particleR={2.4}
            durationMs={780} delay={sh.delay} gravity={F * 0.5} active={active} replayKey={replayKey}
          />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.93)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  raysWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
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
  labelWrap: { marginBottom: 18, alignItems: 'center' },
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
  avatarBurstHolder: {
    // 88px avatar × 1.5 to fit the RankCrest crown/scroll. The avatar VFX
    // fields (s.avField) are larger and centred on this box, overflowing it
    // by design so particles spill out over the card.
    width: HOLDER,
    height: HOLDER,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  avField: {
    position: 'absolute',
    top: AV_OFFSET,
    left: AV_OFFSET,
    width: AV,
    height: AV,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetterFallback: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: C.cardAlt,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetterText: { color: C.gold, fontFamily: F.serif, fontSize: 36, fontWeight: '900' },
  username: {
    color: C.text, fontFamily: F.serif, fontWeight: '900', fontSize: 22, marginTop: 14, textAlign: 'center',
  },
  holeLine: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, marginTop: 4 },
  themePill: {
    marginTop: 18, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 5, borderWidth: 1, maxWidth: '100%',
  },
  themePillLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2, textAlign: 'center' },
  themePillTitle: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  dismissHint: { color: C.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginTop: 20 },
});
