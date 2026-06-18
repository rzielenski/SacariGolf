import React, { useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, Image, Modal, Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay, withRepeat,
  withSequence, withSpring, interpolate, Easing, cancelAnimation, Extrapolation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as themePlayer from '../lib/themePlayer';
import { C, F } from '../lib/colors';
import { API_BASE } from '../lib/api';
import { RankCrest } from './RankCrest';
import { ShimmerButton } from './ui/ShimmerButton';
import { useCensor } from '../lib/censor';
import { GlowPulse, ShockwaveRing, ParticleBurst, SparkleField } from './vfx';

/**
 * Match-found intro — a cinematic reveal of both sides, then a clash where they
 * meet and the VS badge ignites. While the modal is up, the OPPONENT's theme
 * song plays. First-render only (caller tracks "have I shown this" per match).
 *
 * Rebuilt on reanimated worklets + the shared VFX primitives so the entrance
 * has weight: sides slam in on a heavy decel curve, collide with a shockwave +
 * spark burst at the badge, and the VS badge springs in with a halo and a
 * recurring light sweep. Drop-in: same props, Modal, theme handoff, dismiss.
 */
export type SidePlayer = {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  elo?: number | null;
  user_theme_title?: string | null;
  user_theme_artist?: string | null;
  user_theme_artwork?: string | null;
  user_theme_preview?: string | null;
  clan_name?: string | null;
  clan_elo?: number | null;
  clan_avatar_url?: string | null;
  clan_theme_title?: string | null;
  clan_theme_artist?: string | null;
  clan_theme_artwork?: string | null;
  clan_theme_preview?: string | null;
};

const { width: SCREEN_W } = Dimensions.get('window');
const E_OUT = Easing.out(Easing.cubic);
const E_SIN = Easing.inOut(Easing.sin);
const SLAM  = Easing.bezier(0.16, 1, 0.3, 1); // heavy late decel

// VS badge VFX field — larger than the badge and centred on it so the clash
// shockwave + ignition sparks fan out past it into the gap between the cards.
const BADGE = 60;
const VS_FIELD = 176;
const VS_OFFSET = (BADGE - VS_FIELD) / 2;

export function MatchFoundIntro({
  visible, matchType, meSide, side1Players, side2Players, onDismiss,
}: {
  visible: boolean;
  matchType: string;
  meSide: 1 | 2;
  side1Players: SidePlayer[];
  side2Players: SidePlayer[];
  onDismiss: () => void;
}) {
  const isTeamMatch = matchType !== 'solo';
  const c = useCensor();

  // ── Drivers ─────────────────────────────────────────────────────────────
  const fade   = useSharedValue(0);
  const slam   = useSharedValue(0);
  const clash  = useSharedValue(0);
  const ignite = useSharedValue(0);
  const sweep  = useSharedValue(0);
  const cta    = useSharedValue(0);

  // Pick the OPPONENT side's theme (solo = personal, team = clan only).
  const { opponentTheme, opponentThemeTitle } = useMemo(() => {
    const opponentPlayers = meSide === 1 ? side2Players : side1Players;
    if (isTeamMatch) {
      const withClanTheme = opponentPlayers.find((p) => p.clan_theme_preview);
      return {
        opponentTheme: withClanTheme?.clan_theme_preview ?? null,
        opponentThemeTitle: withClanTheme?.clan_theme_title ?? null,
      };
    }
    const withUserTheme = opponentPlayers.find((p) => p.user_theme_preview);
    return {
      opponentTheme: withUserTheme?.user_theme_preview ?? null,
      opponentThemeTitle: withUserTheme?.user_theme_title ?? null,
    };
  }, [isTeamMatch, meSide, side1Players, side2Players]);

  // Run the entrance timeline when the modal becomes visible.
  useEffect(() => {
    if (!visible) return;
    fade.value = 0; slam.value = 0; clash.value = 0; ignite.value = 0; sweep.value = 0; cta.value = 0;

    fade.value = withTiming(1, { duration: 260, easing: E_OUT });
    slam.value = withDelay(120, withTiming(1, { duration: 460, easing: SLAM }));
    clash.value = withDelay(470, withSequence(
      withTiming(1, { duration: 90, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 380, easing: Easing.in(Easing.quad) }),
    ));
    ignite.value = withDelay(520, withSpring(1, { mass: 0.9, damping: 11, stiffness: 170 }));
    cta.value = withDelay(720, withTiming(1, { duration: 320, easing: E_OUT }));
    sweep.value = withDelay(1000, withRepeat(withSequence(
      withTiming(1, { duration: 560, easing: Easing.inOut(Easing.quad) }),
      withDelay(3200, withTiming(1, { duration: 0 })),
      withTiming(0, { duration: 0 }),
    ), -1, false));

    return () => { [fade, slam, clash, ignite, sweep, cta].forEach(cancelAnimation); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Hand the opponent's theme to the singleton player (rides past dismiss).
  useEffect(() => {
    if (!visible || !opponentTheme) return;
    themePlayer.play(opponentTheme);
  }, [visible, opponentTheme]);

  // Do NOT early-return on !visible — the Modal gates visibility; bailing here
  // would reset the shared values on every parent re-render.

  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const leftStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(slam.value, [0, 1], [-SCREEN_W * 0.62, 0]) + interpolate(clash.value, [0, 1], [0, -6]) }],
  }));
  const rightStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(slam.value, [0, 1], [SCREEN_W * 0.62, 0]) + interpolate(clash.value, [0, 1], [0, 6]) }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ignite.value, [0, 0.2], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: ignite.value }],
  }));
  const sweepStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sweep.value, [0, 0.2, 0.8, 1], [0, 0.75, 0.75, 0], Extrapolation.CLAMP),
    transform: [{ translateX: interpolate(sweep.value, [0, 1], [-BADGE, BADGE]) }, { rotate: '22deg' }],
  }));
  const ctaStyle = useAnimatedStyle(() => ({
    opacity: cta.value,
    transform: [{ translateY: interpolate(cta.value, [0, 1], [16, 0]) }],
  }));

  const renderSide = (players: SidePlayer[], isMe: boolean, animStyle: any) => {
    // SOLO — the player IS the side.
    if (!isTeamMatch) {
      const p = players[0];
      const avatar = p?.avatar_url ? `${API_BASE}${p.avatar_url}` : null;
      const name = p?.username ? c(p.username) : '—';
      const elo = p?.elo ?? null;
      return (
        <Animated.View style={[s.sideCol, isMe ? s.sideMe : s.sideOpponent, animStyle]}>
          <Text style={s.sideTag}>{isMe ? 'YOU' : 'OPPONENT'}</Text>
          <RankCrest elo={elo ?? 0} size={72} avatarBorderRadius={8} style={s.crestSpacer}>
            {avatar ? (
              <Image source={{ uri: avatar }} style={s.clanAvatarInner} />
            ) : (
              <View style={[s.clanAvatarInner, s.clanAvatarFallback]}>
                <Text style={s.clanAvatarFallbackText}>{name[0]?.toUpperCase()}</Text>
              </View>
            )}
          </RankCrest>
          <Text style={s.clanName} numberOfLines={1}>{name}</Text>
          {elo != null && <Text style={s.clanElo}>{elo} SR</Text>}
          {!isMe && opponentTheme && opponentThemeTitle && (
            <View style={s.themePill}>
              <Text style={s.themePillLabel}>♫ ANTHEM</Text>
              <Text style={s.themePillTitle} numberOfLines={1}>{opponentThemeTitle}</Text>
            </View>
          )}
        </Animated.View>
      );
    }

    // TEAM (duo / squad) — clan banner + member roster.
    const lead = players.find((p) => p.clan_name) ?? players[0];
    const clanAvatar = lead?.clan_avatar_url ? `${API_BASE}${lead.clan_avatar_url}` : null;
    const rawClanName = lead?.clan_name ?? lead?.username ?? '—';
    const clanName = c(rawClanName);
    const clanElo = lead?.clan_elo ?? lead?.elo ?? null;
    return (
      <Animated.View style={[s.sideCol, isMe ? s.sideMe : s.sideOpponent, animStyle]}>
        <Text style={s.sideTag}>{isMe ? 'YOU' : 'OPPONENT'}</Text>
        <RankCrest elo={clanElo ?? 0} size={72} avatarBorderRadius={8} style={s.crestSpacer}>
          {clanAvatar ? (
            <Image source={{ uri: clanAvatar }} style={s.clanAvatarInner} />
          ) : (
            <View style={[s.clanAvatarInner, s.clanAvatarFallback]}>
              <Text style={s.clanAvatarFallbackText}>{clanName[0]?.toUpperCase()}</Text>
            </View>
          )}
        </RankCrest>
        <Text style={s.clanName} numberOfLines={1}>{clanName}</Text>
        {clanElo != null && <Text style={s.clanElo}>{clanElo} SR</Text>}
        <View style={s.memberList}>
          {players.map((p) => (
            <View key={p.user_id} style={s.memberRow}>
              {p.avatar_url ? (
                <Image source={{ uri: `${API_BASE}${p.avatar_url}` }} style={s.memberAvatar} />
              ) : (
                <View style={[s.memberAvatar, s.memberAvatarFallback]}>
                  <Text style={s.memberAvatarText}>{c(p.username)[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.memberName} numberOfLines={1}>{c(p.username)}</Text>
                <Text style={s.memberElo}>{p.elo ?? '—'} SR</Text>
              </View>
            </View>
          ))}
        </View>
        {!isMe && opponentTheme && opponentThemeTitle && (
          <View style={s.themePill}>
            <Text style={s.themePillLabel}>♫ ANTHEM</Text>
            <Text style={s.themePillTitle} numberOfLines={1}>{opponentThemeTitle}</Text>
          </View>
        )}
      </Animated.View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onDismiss} statusBarTranslucent>
      <Animated.View style={[s.backdrop, backdropStyle]} pointerEvents="auto">
        {/* Energy backdrop: a gold-vs-red conflict wash meeting at the centre,
            plus a faint gold sparkle drift. Reads as charged, not flat black. */}
        <LinearGradient
          pointerEvents="none"
          colors={[C.gold + '22', 'transparent', C.red + '22']}
          start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <SparkleField count={14} color={C.goldLight} active={visible} durationMs={2600} />

        <View style={s.row}>
          {renderSide(side1Players, meSide === 1, leftStyle)}

          <View style={s.versusZone}>
            {/* Halo behind the badge */}
            <View pointerEvents="none" style={s.vsField}>
              <GlowPulse size={VS_FIELD} color={C.gold} maxOpacity={0.42} periodMs={1900} active={visible} />
            </View>
            {/* Clash shockwave + spark burst, timed to the moment the sides meet */}
            <View pointerEvents="none" style={s.vsField}>
              <ShockwaveRing size={VS_FIELD} color={C.goldLight} rings={2} durationMs={560} delay={470} active={visible} replayKey={visible} />
            </View>

            {/* The badge itself */}
            <Animated.View style={[s.versusBadge, badgeStyle]}>
              <Text style={s.versusText}>VS</Text>
              <Animated.View pointerEvents="none" style={[s.sweepBar, sweepStyle]} />
            </Animated.View>

            {/* Ignition sparks fly over the badge */}
            <View pointerEvents="none" style={s.vsField}>
              <ParticleBurst size={VS_FIELD} count={14} color={C.goldLight} color2={C.text} particleR={2.6} durationMs={640} delay={500} active={visible} replayKey={visible} />
            </View>
          </View>

          {renderSide(side2Players, meSide === 2, rightStyle)}
        </View>

        <Animated.View style={[s.ctaWrap, ctaStyle]}>
          <ShimmerButton onPress={onDismiss} background={C.gold} style={s.dismissBtn}>
            <Text style={s.dismissText}>TAP TO START</Text>
          </ShimmerButton>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
    zIndex: 100,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },

  sideCol: {
    flex: 1, alignItems: 'center',
    backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 2,
  },
  sideMe:       { borderColor: C.gold },
  sideOpponent: { borderColor: C.red },
  sideTag: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8 },

  clanAvatarInner: { width: 72, height: 72, borderRadius: 8 },
  clanAvatarFallback: { backgroundColor: C.gold + '22', justifyContent: 'center', alignItems: 'center' },
  clanAvatarFallbackText: { color: C.gold, fontFamily: F.serif, fontSize: 32, fontWeight: '900' },
  crestSpacer: { marginBottom: 6 },
  clanName: { color: C.text, fontFamily: F.serif, fontWeight: '900', fontSize: 16, textAlign: 'center' },
  clanElo: { color: C.gold, fontWeight: '900', fontSize: 12, marginTop: 2 },

  memberList: { width: '100%', marginTop: 10, gap: 6 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberAvatar: { width: 26, height: 26, borderRadius: 13 },
  memberAvatarFallback: { backgroundColor: C.cardAlt, justifyContent: 'center', alignItems: 'center' },
  memberAvatarText: { color: C.textMuted, fontWeight: '900', fontSize: 11 },
  memberName: { color: C.text, fontSize: 12, fontWeight: '700' },
  memberElo: { color: C.textMuted, fontSize: 10 },

  themePill: {
    marginTop: 10, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 4, borderWidth: 1, borderColor: C.gold,
    backgroundColor: C.gold + '11', maxWidth: '100%',
  },
  themePillLabel: { color: C.gold, fontSize: 8, fontWeight: '900', letterSpacing: 1, textAlign: 'center' },
  themePillTitle: { color: C.text, fontSize: 10, fontWeight: '700', marginTop: 2, textAlign: 'center' },

  // The middle column. The badge sizes the box; the VFX fields are absolute and
  // centred on it, overflowing into the gap between the two side cards.
  versusZone: { width: BADGE, height: BADGE, alignItems: 'center', justifyContent: 'center' },
  vsField: {
    position: 'absolute', top: VS_OFFSET, left: VS_OFFSET, width: VS_FIELD, height: VS_FIELD,
    alignItems: 'center', justifyContent: 'center',
  },
  versusBadge: {
    width: BADGE, height: BADGE, borderRadius: BADGE / 2,
    backgroundColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
    shadowColor: C.gold, shadowOpacity: 0.8, shadowRadius: 20,
  },
  versusText: { color: C.bg, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  // Light-sweep glint inside the badge.
  sweepBar: {
    position: 'absolute', top: -BADGE * 0.3, width: 14, height: BADGE * 1.6,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },

  ctaWrap: { position: 'absolute', bottom: 60, alignSelf: 'center' },
  dismissBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 6 },
  dismissText: { color: C.bg, fontWeight: '900', fontSize: 13, letterSpacing: 1.5 },
});
