/**
 * Bounty badge — the "target on your back" flag for a player on a hot win
 * streak (>= 5 ranked wins, matching the backend BOUNTY_THRESHOLD). The API
 * attaches `bounty` + `win_streak` to leaderboard rows and profiles; this just
 * renders them. Beating a bountied player earns the "Giant Slayer" title.
 */
import { View, Text, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { C } from '../lib/colors';

export function BountyBadge({ streak, compact, style }: {
  streak: number;
  /** compact = just "🎯 7" (list rows); full = "🎯 7-WIN BOUNTY" (profiles). */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.text}>
        {compact ? `🎯 ${streak}` : `🎯 ${streak}-WIN BOUNTY`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: C.red + '22', borderColor: C.red, borderWidth: 1,
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2,
  },
  text: { color: C.red, fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
});
