/**
 * Rank crest — decorative frame around a user's avatar that scales in
 * elaborateness with ELO tier.
 *
 *   <RankCrest elo={user.elo} size={96}>
 *     <Image source={...} />
 *   </RankCrest>
 *
 *   // Or pass username/avatarUrl directly and we'll compose a UserAvatar inside.
 *   <RankCrest elo={1850} size={64} username={u.username} avatarUrl={u.avatar_url} />
 *
 * Five tiers, progressively cooler:
 *   • Bronze   (<1400)  — modest single ring
 *   • Silver   (1400–1599) — double ring + accent chevron
 *   • Gold     (1600–1799) — laurel star + side dots
 *   • Platinum (1800–1999) — full perimeter constellation + soft glow
 *   • Diamond  (2000+)   — triple ring + crown + animated sparkle pulse
 *
 * All decorations are Unicode glyphs positioned on a circle around the
 * avatar — no image assets, no SVG library dependency. The component
 * draws into a container sized 1.4× the inner avatar so there's room
 * for the ornament ring without crowding adjacent UI.
 *
 * The Animated pulse on Diamond runs as a long-lived loop; it's
 * deliberately slow (1.8s cycle) so it reads as "shimmer" not "blink".
 */

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, ViewStyle, Easing } from 'react-native';
import { UserAvatar } from './UserAvatar';
import { C } from '../lib/colors';

type Tier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

function tierFromElo(elo: number): Tier {
  if (elo >= 2000) return 'diamond';
  if (elo >= 1800) return 'platinum';
  if (elo >= 1600) return 'gold';
  if (elo >= 1400) return 'silver';
  return 'bronze';
}

const TIER_COLOR: Record<Tier, string> = {
  bronze:   '#cd7f32',
  silver:   '#c8c8d4',
  gold:     C.gold,
  platinum: '#dde3ea',
  diamond:  '#a8d8f0',
};

/** Secondary accent (inner ring) per tier. Diamond uses gold-on-blue for
 *  that "ice with warm glint" look that high-tier league badges go for. */
const TIER_ACCENT: Record<Tier, string> = {
  bronze:   '#cd7f32',
  silver:   '#9090a0',
  gold:     C.goldLight,
  platinum: C.goldLight,
  diamond:  C.goldLight,
};

interface RankCrestProps {
  elo: number;
  /** Inner avatar diameter. The crest extends 0.2 × size beyond on all
   *  sides — for a 96px avatar the total footprint is ~134px. */
  size?: number;
  /** Pass through to UserAvatar if you want this component to compose one
   *  internally. Skip both if you're providing children. */
  username?: string | null;
  avatarUrl?: string | null;
  children?: React.ReactNode;
  /** Override the rendered avatar's borderRadius. Defaults to circle. */
  avatarBorderRadius?: number;
  style?: ViewStyle;
}

export function RankCrest({
  elo, size = 96, username, avatarUrl, children, avatarBorderRadius, style,
}: RankCrestProps) {
  const tier = tierFromElo(elo);
  const color = TIER_COLOR[tier];
  const accent = TIER_ACCENT[tier];

  // Total container is 1.4× to leave room for the ornament ring.
  const total = Math.round(size * 1.4);
  // Decorations sit on a perimeter circle of this radius from container center.
  // Just outside the avatar (size/2) plus a small breathing gap.
  const perim = size / 2 + size * 0.11;

  // Diamond shimmer — slow opacity + tiny scale pulse on the crown and
  // sparkle gems. Started once on mount; ref so HMR doesn't double-fire.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (tier !== 'diamond') return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [tier, pulse]);

  /** Place a decoration node centered at angle θ on the perimeter circle.
   *  Angles are degrees from 12-o'clock, clockwise — so 0=top, 90=right,
   *  180=bottom, 270=left. */
  const placeAt = (angleDeg: number, elementSize: number): ViewStyle => {
    const rad = (angleDeg - 90) * Math.PI / 180;
    const cx = total / 2 + perim * Math.cos(rad);
    const cy = total / 2 + perim * Math.sin(rad);
    return {
      position: 'absolute',
      left: cx - elementSize / 2,
      top: cy - elementSize / 2,
      width: elementSize,
      height: elementSize,
      alignItems: 'center',
      justifyContent: 'center',
    };
  };

  /** Inner ring sized to sit just outside the avatar. */
  const ringStyle = (inset: number, ringColor: string, width: number): ViewStyle => ({
    position: 'absolute',
    left: (total - size) / 2 - inset,
    top: (total - size) / 2 - inset,
    width: size + inset * 2,
    height: size + inset * 2,
    borderRadius: (size + inset * 2) / 2,
    borderWidth: width,
    borderColor: ringColor,
  });

  // Pre-computed shadow style for the higher tiers — adds a halo so the
  // crest reads as "lit from within" against the dark theme.
  const glow: ViewStyle =
    tier === 'diamond' ? { shadowColor: color, shadowOpacity: 0.85, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } }
    : tier === 'platinum' ? { shadowColor: color, shadowOpacity: 0.5, shadowRadius: 9, shadowOffset: { width: 0, height: 0 } }
    : tier === 'gold' ? { shadowColor: color, shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }
    : {};

  // The avatar element — either children passthrough or composed UserAvatar.
  const avatar = children ? (
    <View
      style={{
        width: size, height: size,
        borderRadius: avatarBorderRadius ?? size / 2,
        overflow: 'hidden',
      }}
    >{children}</View>
  ) : (
    <UserAvatar
      username={username}
      avatarUrl={avatarUrl}
      size={size}
      borderRadius={avatarBorderRadius ?? size / 2}
    />
  );

  // ── Per-tier decoration sets ────────────────────────────────────────
  // Each tier strictly adds to the previous one (additive composition is
  // what makes a higher tier feel like a "promotion"). Sizes scale with
  // the avatar size so the crest looks proportional at 32, 64, 96, 120px.
  // Helpers to size glyphs proportionally to the avatar.
  const big = Math.round(size * 0.22);
  const mid = Math.round(size * 0.16);
  const sm  = Math.round(size * 0.11);

  return (
    <View style={[{ width: total, height: total, alignItems: 'center', justifyContent: 'center' }, glow, style]}>
      {/* Outer ring — every tier */}
      <View style={ringStyle(4, color, tier === 'diamond' || tier === 'platinum' ? 3 : tier === 'gold' ? 2.5 : 2)} />

      {/* Inner accent ring — silver and above */}
      {tier !== 'bronze' && (
        <View style={ringStyle(1, accent, tier === 'diamond' ? 1.5 : 1)} />
      )}

      {/* Third ring for Diamond — gives the faceted "ice" look */}
      {tier === 'diamond' && (
        <View style={ringStyle(8, accent, 1)} />
      )}

      {avatar}

      {/* ── Silver tier: single chevron at 12 ─────────────────────── */}
      {(tier === 'silver' || tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
        <View style={placeAt(0, big)}>
          <Text style={[styles.glyph, { fontSize: big, color: tier === 'diamond' ? C.gold : color, lineHeight: big }]}>
            {tier === 'diamond' ? '♛' : tier === 'silver' ? '✦' : '★'}
          </Text>
        </View>
      )}

      {/* ── Gold tier+: laurel/sparkle at 3 and 9 o'clock ─────────── */}
      {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
        <>
          <View style={placeAt(90, mid)}>
            <Text style={[styles.glyph, { fontSize: mid, color: accent, lineHeight: mid }]}>
              {tier === 'diamond' ? '◆' : '✦'}
            </Text>
          </View>
          <View style={placeAt(270, mid)}>
            <Text style={[styles.glyph, { fontSize: mid, color: accent, lineHeight: mid }]}>
              {tier === 'diamond' ? '◆' : '✦'}
            </Text>
          </View>
        </>
      )}

      {/* ── Platinum tier+: extra star at 6 o'clock ───────────────── */}
      {(tier === 'platinum' || tier === 'diamond') && (
        <View style={placeAt(180, mid)}>
          <Text style={[styles.glyph, { fontSize: mid, color: color, lineHeight: mid }]}>★</Text>
        </View>
      )}

      {/* ── Diamond tier: four corner gems with animated shimmer ──── */}
      {tier === 'diamond' && (
        <>
          {[45, 135, 225, 315].map((angle) => (
            <Animated.View
              key={`gem-${angle}`}
              style={[
                placeAt(angle, sm),
                {
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
                  transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.1] }) }],
                },
              ]}
            >
              <Text style={[styles.glyph, { fontSize: sm, color: C.goldLight, lineHeight: sm }]}>✦</Text>
            </Animated.View>
          ))}
        </>
      )}

      {/* ── Platinum tier: static small gems at 4 corners (lower sparkle) ── */}
      {tier === 'platinum' && (
        <>
          {[45, 135, 225, 315].map((angle) => (
            <View key={`pgem-${angle}`} style={placeAt(angle, sm)}>
              <Text style={[styles.glyph, { fontSize: sm, color: accent, lineHeight: sm }]}>✦</Text>
            </View>
          ))}
        </>
      )}

      {/* ── Gold tier: pair of small dots at 4:30 and 7:30 ────────── */}
      {tier === 'gold' && (
        <>
          <View style={placeAt(135, sm)}>
            <Text style={[styles.glyph, { fontSize: sm, color: accent, lineHeight: sm }]}>•</Text>
          </View>
          <View style={placeAt(225, sm)}>
            <Text style={[styles.glyph, { fontSize: sm, color: accent, lineHeight: sm }]}>•</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: {
    fontWeight: '900',
    textAlign: 'center',
    // Slight text shadow so glyphs read against the dark surface without
    // a hard outline. Tiny shadow only — over-styling makes it look like
    // a participation trophy.
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
