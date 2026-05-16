/**
 * Reusable circular/square user avatar with image-or-letter fallback.
 *
 *   <UserAvatar username={u.username} avatarUrl={u.avatar_url} size={40} />
 *
 * Single source of truth for the "show a profile pic next to a name"
 * pattern. Resolves the avatar_url against API_BASE (server stores relative
 * paths like /uploads/avatar/abc.jpg), and falls back to a gold-tinted
 * tile with the username's first initial when no image is set or the image
 * fails to load.
 *
 * Use this anywhere a username appears in a list — friends list, search
 * results, friend requests, post cards, message threads, leaderboard rows,
 * clan members, etc. Centralising means a future change (e.g. switching
 * to CDN-served avatars or adding a presence ring) only needs to land here.
 */

import { useState } from 'react';
import { Image, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { API_BASE } from '../lib/api';
import { C } from '../lib/colors';

interface UserAvatarProps {
  username?: string | null;
  /** Server-relative path like /uploads/avatar/xyz.jpg, or null. */
  avatarUrl?: string | null;
  size?: number;
  /** Border radius. Default = size/2 (perfect circle). Pass `4` for a rounded
   *  square (matches the existing square-tile look in social.tsx). */
  borderRadius?: number;
  /** Optional override for the fallback tile background. Defaults to gold@33. */
  tintColor?: string;
  style?: ViewStyle;
}

export function UserAvatar({
  username,
  avatarUrl,
  size = 40,
  borderRadius,
  tintColor,
  style,
}: UserAvatarProps) {
  // Track whether the <Image> load failed so we can fall back to the letter
  // tile instead of showing a broken-image placeholder.
  const [errored, setErrored] = useState(false);

  const radius = borderRadius ?? size / 2;
  const bg = tintColor ?? C.gold + '33';
  const initial = username?.[0]?.toUpperCase() ?? '?';

  const baseStyle: ViewStyle = {
    width: size, height: size, borderRadius: radius,
    backgroundColor: bg,
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
  };

  if (avatarUrl && !errored) {
    return (
      <View style={[baseStyle, style]}>
        <Image
          source={{ uri: `${API_BASE}${avatarUrl}` }}
          style={{ width: size, height: size }}
          onError={() => setErrored(true)}
        />
      </View>
    );
  }

  return (
    <View style={[baseStyle, style]}>
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.42) }]}>
        {initial}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  letter: { color: C.gold, fontWeight: '800' },
});
