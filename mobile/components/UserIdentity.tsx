/**
 * UserIdentity — render ANY user's avatar + username with their equipped
 * cosmetics, anywhere in the app.
 *
 *   <IdentityAvatar visual={row.equipped_visual} username={row.username}
 *                   avatarUrl={row.avatar_url} size={40} />
 *   <IdentityName visual={row.equipped_visual} style={s.name}>
 *     {row.username}
 *   </IdentityName>
 *
 * `visual` is the server's `equipped_visual` blob:
 *   { border, background, username, ball_trail }  (each visual_data | null)
 * Every public endpoint that returns users now includes it (feed,
 * leaderboard, friends, chat, match players, public profile, cup), so a
 * new surface only needs these two components — and any future cosmetic
 * automatically shows up everywhere once the renderer knows its style.
 *
 * Perf contract: `animated` defaults to FALSE. Lists (feed, leaderboard,
 * friends, chat) render dozens of identities; running looped Reanimated
 * drivers per row would blow the simultaneous-animation budget. Static
 * mode draws the cosmetic's signature look (ring color, glow, name color)
 * with zero animation work. Pass animated={true} only on focused surfaces
 * with a handful of identities: public profile, match lobby, champion
 * banner.
 */

import React from 'react';
import { Text, View, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { UserAvatar } from './UserAvatar';
import { CosmeticBorder, CosmeticUsername } from './Cosmetics';

type EquippedVisual = {
  border?: any;
  background?: any;
  username?: any;
  ball_trail?: any;
} | null | undefined;

/** First defined color in a visual_data blob — the cosmetic's signature
 *  hue for static rendering. */
function primaryColor(v: any): string | null {
  if (!v) return null;
  if (typeof v.color === 'string') return v.color;
  const list = v.colors ?? v.gradient ?? v.layers;
  if (Array.isArray(list) && typeof list[0] === 'string') return list[0];
  if (typeof v.accent === 'string') return v.accent;
  return null;
}

export function IdentityAvatar({
  visual, username, avatarUrl, size = 40, borderRadius, animated = false, style,
}: {
  visual: EquippedVisual;
  username?: string | null;
  avatarUrl?: string | null;
  size?: number;
  /** Default = size/2 (circle), matching UserAvatar. */
  borderRadius?: number;
  animated?: boolean;
  style?: ViewStyle;
}) {
  const border = visual?.border;
  if (!border) {
    return (
      <UserAvatar username={username} avatarUrl={avatarUrl} size={size} borderRadius={borderRadius} style={style} />
    );
  }

  if (animated) {
    return (
      <CosmeticBorder visual={border} size={size}>
        <UserAvatar username={username} avatarUrl={avatarUrl} size={size} borderRadius={borderRadius} style={style} />
      </CosmeticBorder>
    );
  }

  // Static ring: signature color + soft glow, no animation drivers. Close
  // enough that the owner is recognizable in lists; the full effect plays
  // on profile/lobby surfaces.
  const color = primaryColor(border) ?? '#d4a93f';
  const ringWidth = Math.max(2, Math.round((border.width ?? 3) * 0.75));
  const pad = ringWidth + 2;
  return (
    <View style={[{
      width: size + pad * 2, height: size + pad * 2,
      borderRadius: (size + pad * 2) / 2,
      borderWidth: ringWidth, borderColor: color,
      alignItems: 'center', justifyContent: 'center',
      shadowColor: color, shadowOpacity: 0.6, shadowRadius: 6,
      shadowOffset: { width: 0, height: 0 },
    }, style]}>
      <UserAvatar username={username} avatarUrl={avatarUrl} size={size} borderRadius={borderRadius} />
    </View>
  );
}

export function IdentityName({
  visual, children, style, animated = false, numberOfLines,
}: {
  visual: EquippedVisual;
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  animated?: boolean;
  numberOfLines?: number;
}) {
  const flair = visual?.username;
  if (!flair) {
    return <Text style={style} numberOfLines={numberOfLines}>{children}</Text>;
  }
  if (animated) {
    return <CosmeticUsername visual={flair} style={style}>{children}</CosmeticUsername>;
  }
  // Static flair: signature color + optional glow. No MaskedView, no
  // animation — list-safe.
  const color = primaryColor(flair) ?? '#ffffff';
  const glow = flair.glow || flair.style === 'neon' ? {
    textShadowColor: color,
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 0 },
  } : null;
  return (
    <Text style={[style, { color }, glow]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}
