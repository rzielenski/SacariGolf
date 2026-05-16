/**
 * Rank crest — medieval heraldic frame around a user's avatar, scaled in
 * elaborateness with ELO tier. Designed to evoke old-LoL Bronze→Diamond
 * crests, themed around Sacari's crossed-dagger / sword-blade iconography.
 *
 *   <RankCrest elo={user.elo} size={96}>
 *     <Image source={...} />
 *   </RankCrest>
 *
 * Visual layout (medieval crest — back to front in z-order):
 *
 *                ⚔             ← crossed swords above the crown
 *            ✦ ♛ ✦              ← crown stack (multi-element peaks)
 *      †── [ AVATAR ] ──†      ← dagger wings flanking the medallion
 *               ⛨               ← shield base with gem
 *               ❖               ← trailing tail accent (diamond only)
 *
 * Five tiers, strictly additive. Climbing visibly stacks ornaments rather
 * than swapping looks — Diamond contains every element Gold has, plus more:
 *
 *   • Bronze   (<1400)   — bare medallion. One ring. The "apprentice."
 *   • Silver   (1400–)   — double ring + a single star peak. The "recruit."
 *   • Gold     (1600–)   — adds crown stack + crossed swords + dagger wings
 *                          + shield base + halo glow. The "knight."
 *   • Platinum (1800–)   — adds 5-element crown + 4 corner sparkles +
 *                          wider banner + stronger halo. The "captain."
 *   • Diamond  (2000+)   — adds triple ring + crown pulse + dagger-tip
 *                          sparkles + trailing tail + ace-grade halo.
 *                          The "champion."
 *
 * Glyphs used:
 *   ♛  ♔  — crowns
 *   ⚔     — crossed swords (above crown)
 *   †     — dagger (rotated 90° / 270° to form wings)
 *   ⛨     — shield (base)
 *   ❖     — four-pointed star (gem accent)
 *   ✦ ✧  — sparkle stars (crown flanks + corner pulse)
 *   ◆ ◇  — diamonds (banner gems)
 *
 * Implementation: pure RN. No SVG, no asset images. All decoration is
 * Unicode glyph Text with absolute positioning + transforms (rotation for
 * the dagger wings, scaleX:-1 for the right-side mirror). The container
 * has overflow:visible so the crown's top point and the dagger tips can
 * extend beyond the layout box. Touch handling stays on the avatar; the
 * ornaments are pointerEvents="none" so they don't intercept clicks.
 */

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, ViewStyle, TextStyle, Easing } from 'react-native';
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

/** Secondary accent — inner ring + side flourishes per tier. Warm gold on
 *  cool primary at the higher tiers, mimicking real-world heraldry (steel
 *  with gold inlay). */
const TIER_ACCENT: Record<Tier, string> = {
  bronze:   '#cd7f32',
  silver:   '#9090a0',
  gold:     C.goldLight,
  platinum: C.goldLight,
  diamond:  C.goldLight,
};

interface RankCrestProps {
  elo: number;
  /** Inner avatar diameter. The crest container extends to size × 1.5
   *  square; ornaments may visually extend further via overflow. For a
   *  96px avatar the layout footprint is 144px. */
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

  // Bounding box — square. The crest exterior (crown + crossed swords on
  // top, shield on bottom, dagger wings on sides) reaches just past this
  // box at higher tiers; we rely on overflow:visible to render those parts.
  const total = Math.round(size * 1.5);
  // Avatar nudged DOWN inside the container so the crown stack and the
  // crossed swords above it have visual room above the ring top.
  const verticalBias = Math.round(size * 0.06);
  const avatarLeft = (total - size) / 2;
  const avatarTop = (total - size) / 2 + verticalBias;
  const avatarCenterX = avatarLeft + size / 2;
  const avatarCenterY = avatarTop + size / 2;
  const avatarBottom = avatarTop + size;

  // Animated shimmer for Diamond's crown + corner sparkles + sword glint.
  // Long-cycle (1.8s) so it reads as ambient shimmer rather than flicker.
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

  /** Ring sized to sit just outside the avatar with a configurable inset. */
  const ringStyle = (inset: number, ringColor: string, width: number): ViewStyle => ({
    position: 'absolute',
    left: avatarLeft - inset,
    top: avatarTop - inset,
    width: size + inset * 2,
    height: size + inset * 2,
    borderRadius: (size + inset * 2) / 2,
    borderWidth: width,
    borderColor: ringColor,
  });

  // Tier-graded halo glow.
  const glow: ViewStyle =
    tier === 'diamond' ? { shadowColor: color, shadowOpacity: 0.95, shadowRadius: 20, shadowOffset: { width: 0, height: 0 } }
    : tier === 'platinum' ? { shadowColor: color, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } }
    : tier === 'gold' ? { shadowColor: color, shadowOpacity: 0.45, shadowRadius: 9, shadowOffset: { width: 0, height: 0 } }
    : {};

  // Sizes scale proportionally with the avatar so the crest looks balanced
  // at every size from 32px (chat bubble) up to 120px+ (intro screens).
  const swordSize  = Math.round(size * 0.28);  // ⚔ above crown
  const crownBig   = Math.round(size * 0.32);  // center crown ♛
  const crownMid   = Math.round(size * 0.22);  // inner flanking ♛/✦ (platinum/diamond crown layer)
  const crownSide  = Math.round(size * 0.17);  // outer flanking ✦
  const wingSize   = Math.round(size * 0.42);  // dagger † wings
  const shieldSize = Math.round(size * 0.30);  // ⛨ base
  const gemSize    = Math.round(size * 0.14);  // ❖ on shield + corner gems
  const tailSize   = Math.round(size * 0.13);  // diamond's trailing accent
  const sparkleSm  = Math.round(size * 0.11);  // diamond corner shimmer

  // The avatar content — composed UserAvatar OR pass-through children.
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

  // Shared shadow for glyphs — small, dark, lifts symbols off the avatar.
  const glyphShadow: TextStyle = {
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  };

  // Dagger wing positions — anchored just outside the ring at the avatar's
  // vertical midline. Rotated 90° / 270° so the cross-guard sits NEAR the
  // medallion and the blade extends OUTWARD horizontally like a wing.
  // Hilt rendered at the inner end via the rotation; blade tips outward.
  const leftWingX = avatarLeft - wingSize * 0.55;
  const rightWingX = avatarLeft + size - wingSize * 0.45;
  const wingY = avatarCenterY - wingSize / 2;

  return (
    <View
      style={[
        {
          width: total, height: total,
          alignItems: 'center', justifyContent: 'flex-start',
          overflow: 'visible',
        },
        glow,
        style,
      ]}
    >
      {/* ─── CROSSED SWORDS (Gold+) ─────────────────────────────────────
          Sits ABOVE the crown — peaks of swords poking above the topmost
          crown peak. Single ⚔ glyph, deliberately oversized so the cross
          point of the swords lines up roughly with the crown's center. */}
      {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
        <Text
          style={[
            {
              position: 'absolute',
              top: avatarTop - crownBig * 1.05 - swordSize * 0.45,
              left: 0,
              right: 0,
              textAlign: 'center',
              color: tier === 'diamond' ? '#f0c95a' : color,
              fontSize: swordSize,
              fontWeight: '900',
              lineHeight: swordSize,
            },
            glyphShadow,
          ]}
          pointerEvents="none"
        >⚔</Text>
      )}

      {/* ─── CROWN STACK (Silver+) ──────────────────────────────────────
          Bronze: no crown. Silver: bare star. Gold: ✦ ♛ ✦ tiara silhouette.
          Platinum: ✦ ♛ ♛ ♛ ✦ five-peak crown for tier punch. Diamond: same
          five-peak crown with the center ♛ pulsing in scale + opacity.
          Bottom of the crown stack touches the ring top so the crown
          reads as peaking out of the medallion. */}
      {tier !== 'bronze' && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: avatarTop - crownBig * 0.95,
            height: crownBig * 1.1,
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: Math.round(size * 0.02),
          }}
          pointerEvents="none"
        >
          {/* Outermost left flank — appears at Gold+ */}
          {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[
                {
                  color: accent,
                  fontSize: crownSide,
                  fontWeight: '900',
                  transform: [{ translateY: crownBig * 0.20 }],
                },
                glyphShadow,
              ]}
            >✦</Text>
          )}

          {/* Inner-left mid-peak — appears at Platinum+ */}
          {(tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[
                {
                  color: color,
                  fontSize: crownMid,
                  fontWeight: '900',
                  transform: [{ translateY: crownBig * 0.08 }],
                },
                glyphShadow,
              ]}
            >♛</Text>
          )}

          {/* Center crown — animated for Diamond. Silver gets a small star
              instead of a crown (no royal equivalent at the recruit tier). */}
          {tier === 'diamond' ? (
            <Animated.Text
              style={[
                {
                  color: '#f0c95a',
                  fontSize: crownBig,
                  fontWeight: '900',
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }),
                  transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.07] }) }],
                },
                glyphShadow,
              ]}
            >♛</Animated.Text>
          ) : tier === 'platinum' || tier === 'gold' ? (
            <Text style={[{ color: color, fontSize: crownBig, fontWeight: '900' }, glyphShadow]}>♛</Text>
          ) : (
            // Silver — modest sparkle star instead of a crown.
            <Text style={[{ color: color, fontSize: crownBig * 0.65, fontWeight: '900' }, glyphShadow]}>✦</Text>
          )}

          {/* Inner-right mid-peak — Platinum+ */}
          {(tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[
                {
                  color: color,
                  fontSize: crownMid,
                  fontWeight: '900',
                  transform: [{ translateY: crownBig * 0.08 }],
                },
                glyphShadow,
              ]}
            >♛</Text>
          )}

          {/* Outermost right flank — Gold+ */}
          {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[
                {
                  color: accent,
                  fontSize: crownSide,
                  fontWeight: '900',
                  transform: [{ translateY: crownBig * 0.20 }],
                },
                glyphShadow,
              ]}
            >✦</Text>
          )}
        </View>
      )}

      {/* ─── DAGGER WINGS (Gold+) ───────────────────────────────────────
          † glyph rotated 90° on the left (hilt near medallion, blade
          extending out-left horizontally) and 270° on the right (mirror).
          This makes the cross-guard read as a small bump near the ring
          and the blade as a horizontal wing tip — Sacari's icon language
          translated to a crest flourish.

          The rotated bounding box of the glyph is taller than wide after
          rotation, so we anchor at the avatar's vertical midline and shift
          horizontally to align the cross-guard near the ring's edge. */}
      {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
        <>
          <Text
            style={[
              {
                position: 'absolute',
                top: wingY,
                left: leftWingX,
                width: wingSize,
                height: wingSize,
                color: accent,
                fontSize: wingSize,
                fontWeight: '900',
                lineHeight: wingSize,
                textAlign: 'center',
                transform: [{ rotate: '90deg' }],
              },
              glyphShadow,
            ]}
            pointerEvents="none"
          >†</Text>
          <Text
            style={[
              {
                position: 'absolute',
                top: wingY,
                left: rightWingX,
                width: wingSize,
                height: wingSize,
                color: accent,
                fontSize: wingSize,
                fontWeight: '900',
                lineHeight: wingSize,
                textAlign: 'center',
                transform: [{ rotate: '270deg' }],
              },
              glyphShadow,
            ]}
            pointerEvents="none"
          >†</Text>
        </>
      )}

      {/* ─── DAGGER-TIP SPARKLES (Diamond only) ─────────────────────────
          Tiny ✦ at the outer tip of each dagger wing, animated to pulse
          with the same shimmer driver as the crown — gives the daggers a
          "lit blade" feel at the highest tier. */}
      {tier === 'diamond' && (
        <>
          <Animated.Text
            style={[
              {
                position: 'absolute',
                top: avatarCenterY - sparkleSm / 2,
                left: leftWingX - sparkleSm * 0.3,
                color: C.goldLight,
                fontSize: sparkleSm,
                fontWeight: '900',
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
              },
              glyphShadow,
            ]}
            pointerEvents="none"
          >✦</Animated.Text>
          <Animated.Text
            style={[
              {
                position: 'absolute',
                top: avatarCenterY - sparkleSm / 2,
                left: rightWingX + wingSize - sparkleSm * 0.7,
                color: C.goldLight,
                fontSize: sparkleSm,
                fontWeight: '900',
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
              },
              glyphShadow,
            ]}
            pointerEvents="none"
          >✦</Animated.Text>
        </>
      )}

      {/* ─── OUTER RING (every tier) ────────────────────────────────── */}
      <View style={ringStyle(4, color, tier === 'diamond' || tier === 'platinum' ? 3 : tier === 'gold' ? 2.5 : 2)} />

      {/* ─── INNER ACCENT RING (Silver+) ────────────────────────────── */}
      {tier !== 'bronze' && (
        <View style={ringStyle(1, accent, tier === 'diamond' ? 1.5 : 1)} />
      )}

      {/* ─── OUTER WIDE RING (Diamond only — faceted-ice halo ring) ─── */}
      {tier === 'diamond' && (
        <View style={ringStyle(8, accent, 1)} />
      )}

      {/* ─── AVATAR (centered horizontally, biased down) ────────────── */}
      <View style={{ position: 'absolute', top: avatarTop, left: avatarLeft }}>
        {avatar}
      </View>

      {/* ─── SHIELD BASE (Gold+) ────────────────────────────────────────
          ⛨ shield glyph sits just below the avatar bottom. At Gold it's a
          small shield with no gem; Platinum/Diamond add ◆ or ❖ gem flanks. */}
      {(tier === 'gold' || tier === 'platinum' || tier === 'diamond') && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: avatarBottom - shieldSize * 0.25,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: Math.round(size * 0.04),
          }}
          pointerEvents="none"
        >
          {(tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[{ color: accent, fontSize: gemSize, fontWeight: '900' }, glyphShadow]}
            >◆</Text>
          )}
          <Text
            style={[
              {
                color: color,
                fontSize: shieldSize,
                fontWeight: '900',
              },
              glyphShadow,
            ]}
          >⛨</Text>
          {(tier === 'platinum' || tier === 'diamond') && (
            <Text
              style={[{ color: accent, fontSize: gemSize, fontWeight: '900' }, glyphShadow]}
            >◆</Text>
          )}
        </View>
      )}

      {/* ─── SHIELD GEM (Platinum+ — single ❖ centered on the shield)
          Subtle but reads as the "jewel set into the shield" at the
          highest tiers. */}
      {(tier === 'platinum' || tier === 'diamond') && (
        <Text
          style={[
            {
              position: 'absolute',
              top: avatarBottom + shieldSize * 0.13,
              left: 0,
              right: 0,
              textAlign: 'center',
              color: tier === 'diamond' ? '#f0c95a' : C.goldLight,
              fontSize: gemSize * 0.9,
              fontWeight: '900',
            },
            glyphShadow,
          ]}
          pointerEvents="none"
        >❖</Text>
      )}

      {/* ─── TRAILING TAIL (Diamond only) ───────────────────────────────
          A small ◇ accent hanging below the shield — gives the crest a
          "banner trailing" feel only seen at the championship tier. */}
      {tier === 'diamond' && (
        <Text
          style={[
            {
              position: 'absolute',
              top: avatarBottom + shieldSize * 0.55,
              left: 0,
              right: 0,
              textAlign: 'center',
              color: accent,
              fontSize: tailSize,
              fontWeight: '900',
            },
            glyphShadow,
          ]}
          pointerEvents="none"
        >◇</Text>
      )}

      {/* ─── DIAMOND CORNER SPARKLES (animated) ─────────────────────────
          Four small ✦ glyphs at the avatar's diagonal corners, pulsing in
          counterphase to the crown so the entire crest feels alive without
          everything peaking at the same instant. */}
      {tier === 'diamond' && (
        <>
          {[
            { x: avatarLeft - sparkleSm * 0.3,         y: avatarTop - sparkleSm * 0.3 },
            { x: avatarLeft + size - sparkleSm * 0.7,  y: avatarTop - sparkleSm * 0.3 },
            { x: avatarLeft - sparkleSm * 0.3,         y: avatarBottom - sparkleSm * 0.7 },
            { x: avatarLeft + size - sparkleSm * 0.7,  y: avatarBottom - sparkleSm * 0.7 },
          ].map((p, i) => (
            <Animated.Text
              key={`spark-${i}`}
              style={[
                {
                  position: 'absolute',
                  top: p.y,
                  left: p.x,
                  color: C.goldLight,
                  fontSize: sparkleSm,
                  fontWeight: '900',
                  // Counterphase from the crown — when the crown is dim,
                  // these sparkles are bright, so something is always lit.
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
                  transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1.15, 0.85] }) }],
                },
                glyphShadow,
              ]}
              pointerEvents="none"
            >✦</Animated.Text>
          ))}
        </>
      )}
    </View>
  );
}

// Unused but kept so module imports of `styles` don't break.
const styles = StyleSheet.create({ __unused: {} });
