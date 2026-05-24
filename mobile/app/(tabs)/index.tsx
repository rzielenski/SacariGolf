/**
 * Home tab — stats up top, feed below. Restructured so the screen scrolls as
 * one surface (the SocialFeed's FlatList) with the stats + navigation
 * shortcuts living in its ListHeaderComponent.
 *
 * What's here:
 *   • Greeting + rank badge
 *   • ELO card (rating / matches / wins / win %)
 *   • Resume / verify / open-beta / perk banners
 *   • Leaderboard + Tournaments shortcuts (2-wide grid)
 *   • Friend feed (auto-posted rounds + user posts, w/ FoF mixing)
 *
 * What moved elsewhere:
 *   • Handicap row, My Bag row → profile tab
 *   • Quick-action match buttons → live in the Play tab
 *   • Recent matches list, footer (sign-out / delete) → profile tab
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { Match } from '../../types';
import { SocialFeed } from '../../components/SocialFeed';
import { PressableScale } from '../../components/ui/PressableScale';
import { GlowCard } from '../../components/ui/GlowCard';
import { useCensor } from '../../lib/censor';
import { rankForElo } from '../../lib/rank';

function EloRank(elo: number): { label: string; color: string } {
  if (elo >= 2000) return { label: 'Diamond', color: '#a8d8f0' };
  if (elo >= 1800) return { label: 'Platinum', color: '#c0c0d0' };
  if (elo >= 1600) return { label: 'Gold', color: C.gold };
  if (elo >= 1400) return { label: 'Silver', color: '#c0c0c0' };
  return { label: 'Bronze', color: '#cd7f32' };
}

export default function HomeScreen() {
  const { user, refreshUser } = useAuth();
  const censor = useCensor();
  const eloTapCount = useRef(0);
  const eloTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [perkCount, setPerkCount] = useState(0);
  // Resumable round: an in-progress match where the player has saved local
  // scoring progress (via "Save & Leave") but hasn't submitted yet. Showing
  // a top-of-home banner makes coming back to it a single tap.
  const [resumable, setResumable] = useState<Match | null>(null);

  const loadHomeData = useCallback(async () => {
    try {
      await refreshUser();
    } catch { /* silent */ }
    try {
      const matches = await api.matches.list();
      const list = Array.isArray(matches) ? matches : [];
      // Find any not-yet-completed match the user has local progress for.
      // The scoring screen writes `scores_${userId}_${matchId}` on Save & Leave.
      try {
        const keys = await AsyncStorage.getAllKeys();
        const myPrefix = `scores_${user?.user_id ?? ''}_`;
        const ids = keys.filter((k) => k.startsWith(myPrefix)).map((k) => k.slice(myPrefix.length));
        const candidates = list.filter((m: any) => !m.completed && ids.includes(m.match_id));
        setResumable(candidates[0] ?? null);
      } catch { setResumable(null); }
    } catch { /* silent */ }
    try {
      const rows = await api.users.perks();
      setPerkCount(Array.isArray(rows) ? rows.length : 0);
    } catch { /* silent */ }
  }, [refreshUser, user?.user_id]);

  useEffect(() => { loadHomeData(); }, [loadHomeData]);

  // Clean up the ELO-tap timer if the component unmounts mid-sequence so we
  // don't fire setState on an unmounted screen.
  useEffect(() => {
    return () => { if (eloTapTimer.current) clearTimeout(eloTapTimer.current); };
  }, []);

  if (!user) return null;

  const rank = EloRank(user.elo);
  const winRate = user.total_matches > 0
    ? Math.round((user.total_wins / user.total_matches) * 100)
    : 0;

  /** Everything above the feed renders inside the SocialFeed FlatList's
   *  ListHeaderComponent so the whole screen scrolls as one surface. */
  const header = (
    <View style={styles.header}>
      {/* Greeting + rank badge */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Welcome back,</Text>
          <Text style={styles.username}>{censor(user.username)}</Text>
        </View>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rank.label}</Text>
        </View>
      </View>

      {/* ELO card — tap ELO number 5× to open Find Ranker (existing easter egg) */}
      <View style={styles.eloCard}>
        <TouchableOpacity
          style={styles.eloLeft}
          activeOpacity={1}
          onPress={() => {
            eloTapCount.current += 1;
            if (eloTapTimer.current) clearTimeout(eloTapTimer.current);
            if (eloTapCount.current >= 5) {
              eloTapCount.current = 0;
              router.push('/finds' as any);
            } else {
              eloTapTimer.current = setTimeout(() => { eloTapCount.current = 0; }, 2000);
            }
          }}
        >
          <Text style={styles.eloNum}>{rankForElo(user.elo).label}</Text>
          <Text style={styles.eloLabel}>
            {rankForElo(user.elo).isObsidian ? `${user.elo} ELO` : `${rankForElo(user.elo).lp} LP`}
          </Text>
        </TouchableOpacity>
        <View style={styles.eloDivider} />
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{user.total_matches}</Text>
          <Text style={styles.eloStatLabel}>Matches</Text>
        </View>
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{user.total_wins}</Text>
          <Text style={styles.eloStatLabel}>Wins</Text>
        </View>
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{winRate}%</Text>
          <Text style={styles.eloStatLabel}>Win Rate</Text>
        </View>
      </View>

      {/* Lucky Round — thin pulsing strip that hugs the bottom of the ELO
          card. Reads as an "active perk tag" on your rating rather than a
          separate banner. Tap → alert explaining how it cashes in. */}
      {perkCount > 0 && (
        <PressableScale
          onPress={() =>
            Alert.alert(
              'Lucky Round',
              perkCount > 1
                ? `You have ${perkCount} Lucky Round perks. Each one will double your next ranked-match win or cancel a loss — whichever happens first.`
                : 'Your next ranked match will count double on a win, or cancel a loss — whichever happens first.',
            )
          }
          style={{ marginTop: -8, marginBottom: 14 }}
        >
          <GlowCard color={C.green} style={styles.luckyBar} minBorderOpacity={0.75} periodMs={2400}>
            <Text style={styles.luckyBarMark}>★</Text>
            <Text style={styles.luckyBarLabel} numberOfLines={1}>
              {perkCount > 1 ? `${perkCount}× LUCKY ROUND ACTIVE` : 'LUCKY ROUND ACTIVE'}
            </Text>
          </GlowCard>
        </PressableScale>
      )}

      {/* Resume-round chip — sole occupant of the status row now that
          lucky perks have been promoted to the ELO card. Full-width when
          present so it reads as the unmissable "finish what you started"
          banner above the feed. */}
      {resumable && (
        <View style={styles.statusRow}>
          <PressableScale
            onPress={() => router.push(`/match/${resumable.match_id}` as any)}
            style={{ flex: 1 }}
          >
            <GlowCard color={C.gold} style={[styles.statusChip, styles.statusChipGold]}>
              <View style={styles.statusChipDot} />
              <Text style={styles.statusChipLabel} numberOfLines={1}>RESUME ROUND</Text>
              <Text style={styles.statusChipChev}>›</Text>
            </GlowCard>
          </PressableScale>
        </View>
      )}

      {/* Email-verification banner — only while user hasn't confirmed yet */}
      {user.email_verified === false && (
        <TouchableOpacity
          style={styles.verifyBanner}
          onPress={() => router.push('/verify-email' as any)}
          activeOpacity={0.7}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.verifyBannerLabel}>VERIFY YOUR EMAIL</Text>
            <Text style={styles.verifyBannerMsg}>
              Tap to enter the 6-digit code we sent to {user.email}.
            </Text>
          </View>
          <Text style={styles.verifyBannerChev}>›</Text>
        </TouchableOpacity>
      )}

      {/* Open-beta premium banner — visible while OPEN_BETA_PREMIUM is on
          server-side (server stamps premium_plan = 'open_beta'). */}
      {(user as any)?.premium_plan === 'open_beta' && (
        <TouchableOpacity
          style={styles.openBetaBanner}
          onPress={() => router.push('/premium' as any)}
          activeOpacity={0.85}
        >
          <Text style={styles.openBetaLabel}>★  PREMIUM UNLOCKED  ★</Text>
          <Text style={styles.openBetaMsg}>
            Every paid feature is free for you during open beta — a gift from Richard while we collect course data. Tap to see what's included.
          </Text>
        </TouchableOpacity>
      )}

      {/* 2-wide nav grid: Leaderboard + Tournaments. PressableScale gives
          tactile press feedback (subtle scale + opacity) on each tile. */}
      <View style={styles.navGrid}>
        <PressableScale
          onPress={() => router.push('/leaderboard' as any)}
          style={styles.navTile}
        >
          <Text style={styles.navTileMark}>★</Text>
          <Text style={styles.navTileLabel}>Leaderboard</Text>
          <Text style={styles.navTileSub}>See where you rank globally</Text>
        </PressableScale>
        <PressableScale
          onPress={() => router.push('/tournaments' as any)}
          style={styles.navTile}
        >
          <Text style={styles.navTileMark}>♛</Text>
          <Text style={styles.navTileLabel}>Tournaments</Text>
          <Text style={styles.navTileSub}>Leagues + bracketed events</Text>
        </PressableScale>
      </View>

      <Text style={styles.feedHeader}>FEED</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <SocialFeed headerComponent={header} onRefreshExtra={loadHomeData} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { padding: 20, paddingTop: 60 },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  greeting: { color: C.textMuted, fontSize: 14 },
  username: { color: C.text, fontSize: 24, fontWeight: '800' },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 12, paddingVertical: 5 },
  rankLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  eloCard: {
    backgroundColor: C.card, borderRadius: 18, padding: 20,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
    marginBottom: 20,
  },
  eloLeft: { flex: 1 },
  eloNum: { fontFamily: F.serif, fontSize: 42, fontWeight: '700', color: C.gold },
  eloLabel: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  eloDivider: { width: 1, height: 40, backgroundColor: C.border, marginHorizontal: 16 },
  eloStat: { alignItems: 'center', paddingHorizontal: 8 },
  eloStatNum: { fontSize: 18, fontWeight: '800', color: C.text },
  eloStatLabel: { fontSize: 10, color: C.textMuted, marginTop: 2 },

  // Compact status row — resume-round and lucky-round share one line.
  // Chips are wrapped in GlowCard which provides the pulsing border + halo
  // glow itself, so we only set the inner layout (padding + flex) here.
  statusRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
  },
  statusChipGold:  { backgroundColor: C.gold + '22' },
  statusChipGreen: { backgroundColor: C.green + '22' },
  statusChipDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: C.gold },
  statusChipMark:  { color: C.green, fontSize: 13, fontWeight: '900' },
  statusChipLabel: { color: C.text, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, flex: 1 },
  statusChipChev:  { color: C.gold, fontSize: 16, fontWeight: '700' },

  // Lucky Round strip — slim green bar that visually attaches to the bottom
  // of the ELO card (via the negative top margin on the wrapping
  // PressableScale). Designed to read as a "perk tag" on the rating rather
  // than a separate banner. Roughly half the visual weight of a status chip.
  luckyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: C.green + '1c',
  },
  luckyBarMark:  { color: C.green, fontSize: 11, fontWeight: '900' },
  luckyBarLabel: { color: C.green, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },

  verifyBanner: {
    backgroundColor: '#ffa50022', borderRadius: 10, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: '#ffa500',
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  verifyBannerLabel: { color: '#ffa500', fontWeight: '900', fontSize: 11, letterSpacing: 1.2 },
  verifyBannerMsg: { color: C.text, fontSize: 13, marginTop: 3 },
  verifyBannerChev: { color: '#ffa500', fontSize: 22, fontWeight: '700' },

  openBetaBanner: {
    backgroundColor: C.gold + '14', borderRadius: 10, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: C.gold + '88',
  },
  openBetaLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 1.5, textAlign: 'center' },
  openBetaMsg: { color: C.text, fontSize: 12, marginTop: 6, lineHeight: 17, textAlign: 'center' },

  // 2-wide nav grid (replaces the stacked Leaderboard / Tournaments buttons).
  // Each tile uses PressableScale for tactile press feedback. Slight
  // gold-tinted background wash makes the cards lift against the true-black
  // page background with the refined palette.
  navGrid: { flexDirection: 'row', gap: 10, marginTop: 4, marginBottom: 24 },
  navTile: {
    flex: 1, backgroundColor: C.card, borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: C.gold + '55', alignItems: 'flex-start',
    shadowColor: C.gold, shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
  },
  navTileMark: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  navTileLabel: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 6 },
  navTileSub: { color: C.textMuted, fontSize: 11, marginTop: 3 },

  feedHeader: {
    color: C.textMuted, fontSize: 11, fontWeight: '700',
    letterSpacing: 1.5, marginBottom: 4, marginLeft: -4,
  },
});
