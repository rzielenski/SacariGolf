/**
 * Rank crest — the heraldic frame around a player's avatar, keyed to their SR
 * tier (Wood → Obsidian, see lib/rank.ts).
 *
 *   <RankCrest elo={user.elo} size={96}>
 *     <Image source={...} />
 *   </RankCrest>
 *
 * Rendering:
 *   • If per-tier artwork exists in CREST_IMAGES, the emblem PNG is drawn and
 *     the avatar is composited into the art's medallion well (CREST_MEDALLION).
 *   • Until the art lands, it falls back to a clean tier-colored medallion
 *     frame so the app builds and looks intentional with zero assets.
 *
 * `size` is the avatar diameter; the emblem decoration sizes itself around it.
 */

import { useEffect, useRef } from 'react';
import { Animated, Image, StyleSheet, View, ViewStyle, Easing } from 'react-native';
import { UserAvatar } from './UserAvatar';
import { rankForElo, CREST_IMAGES, medallionFor } from '../lib/rank';

/**
 * The on-screen footprint of a crest for a given avatar `size`. In art mode the
 * emblem is much larger than the avatar (the avatar sits in the emblem's
 * medallion well), so a cosmetic ring drawn around the crest must be sized to
 * THIS, not to `size`, or it disappears behind the emblem. Mirrors the footprint
 * math in RankCrest below.
 */
export function crestFootprint(elo: number, size = 96): number {
  const rank = rankForElo(elo);
  const emblem = CREST_IMAGES[rank.tier.key];
  if (emblem) return Math.round(size / medallionFor(rank.tier.key).diameter);
  return Math.round(size * 1.5);
}

interface RankCrestProps {
  elo: number;
  /** Avatar diameter in px. The crest decoration extends around it. */
  size?: number;
  username?: string | null;
  avatarUrl?: string | null;
  children?: React.ReactNode;
  avatarBorderRadius?: number;
  style?: ViewStyle;
}

export function RankCrest({
  elo, size = 96, username, avatarUrl, children, avatarBorderRadius, style,
}: RankCrestProps) {
  const rank = rankForElo(elo);
  const emblem = CREST_IMAGES[rank.tier.key];
  const radius = avatarBorderRadius ?? size / 2;

  // Subtle ambient pulse for the top tier (works in both art + fallback modes).
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!rank.isObsidian) return;
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [rank.isObsidian, pulse]);

  const avatar = children ? (
    <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden' }}>{children}</View>
  ) : (
    <UserAvatar username={username} avatarUrl={avatarUrl} size={size} borderRadius={radius} />
  );

  // ── Art mode: emblem PNG with the avatar in its medallion well ──────────
  if (emblem) {
    const med = medallionFor(rank.tier.key);
    const footprint = Math.round(size / med.diameter);
    const avLeft = footprint * med.cx - size / 2;
    const avTop = footprint * med.cy - size / 2;
    return (
      <View style={[{ width: footprint, height: footprint, overflow: 'visible' }, style]}>
        <Image
          source={emblem}
          style={{ position: 'absolute', width: footprint, height: footprint }}
          resizeMode="contain"
        />
        <View style={{ position: 'absolute', left: avLeft, top: avTop, width: size, height: size }}>
          {avatar}
          {/* Blend the photo into the medallion: a two-step dark edge vignette
              fades the hard circle into the well, and a faint tier-color wash
              unifies the bright avatar with the crest's palette. */}
          <View pointerEvents="none" style={{
            position: 'absolute', width: size, height: size, borderRadius: radius,
            borderColor: 'rgba(0,0,0,0.22)', borderWidth: Math.max(4, size * 0.14),
          }} />
          <View pointerEvents="none" style={{
            position: 'absolute', width: size, height: size, borderRadius: radius,
            borderColor: 'rgba(0,0,0,0.45)', borderWidth: Math.max(2, size * 0.06),
          }} />
          <View pointerEvents="none" style={{
            position: 'absolute', width: size, height: size, borderRadius: radius,
            backgroundColor: rank.color + '1c',
          }} />
        </View>
      </View>
    );
  }

  // ── Fallback: tier-colored medallion frame ──────────────────────────────
  const tierIndex = Math.max(0, [
    'wood', 'bronze', 'silver', 'gold', 'platinum', 'ruby', 'diamond', 'obsidian',
  ].indexOf(rank.tier.key));
  const total = Math.round(size * 1.5);
  const avOffset = (total - size) / 2;
  const ring = (inset: number, color: string, width: number): ViewStyle => ({
    position: 'absolute',
    left: avOffset - inset, top: avOffset - inset,
    width: size + inset * 2, height: size + inset * 2,
    borderRadius: (size + inset * 2) / 2,
    borderWidth: width, borderColor: color,
  });
  const glow: ViewStyle = tierIndex >= 3
    ? { shadowColor: rank.color, shadowOpacity: tierIndex >= 6 ? 0.85 : 0.5, shadowRadius: tierIndex >= 6 ? 16 : 9, shadowOffset: { width: 0, height: 0 } }
    : {};

  return (
    <Animated.View
      style={[
        { width: total, height: total, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
        glow,
        rank.isObsidian ? { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) } : null,
        style,
      ]}
    >
      <View style={ring(4, rank.color, tierIndex >= 4 ? 3 : tierIndex >= 2 ? 2.5 : 2)} />
      {tierIndex >= 1 && <View style={ring(1, rank.color + 'aa', 1)} />}
      {tierIndex >= 6 && <View style={ring(8, rank.color + '66', 1)} />}
      <View style={{ position: 'absolute', left: avOffset, top: avOffset }}>{avatar}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ __unused: {} });
