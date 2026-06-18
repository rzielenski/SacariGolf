/**
 * Home tab — stats up top, feed below. Restructured so the screen scrolls as
 * one surface (the SocialFeed's FlatList) with the stats + navigation
 * shortcuts living in its ListHeaderComponent.
 *
 * What's here:
 *   • Greeting + rank badge
 *   • SR card (rating / matches / wins / win %)
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
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { SocialFeed } from '../../components/SocialFeed';
import { PressableScale } from '../../components/ui/PressableScale';
import { GlowCard } from '../../components/ui/GlowCard';
import { IdentityName } from '../../components/UserIdentity';
import { useCensor } from '../../lib/censor';
import { rankForElo } from '../../lib/rank';

export default function HomeScreen() {
  const { user, refreshUser } = useAuth();
  const censor = useCensor();
  const eloTapCount = useRef(0);
  const eloTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [perkCount, setPerkCount] = useState(0);
  // Count of in-progress matches (not completed, not cancelled). The chip
  // routes the user to the Resume picker when there's more than one, or
  // straight into the match when there's exactly one. We don't gate on
  // local AsyncStorage progress any more — a match created on this device
  // but never opened, or accepted on another device, is still resumable.
  const [resumeCount, setResumeCount] = useState(0);
  const [singleResumeId, setSingleResumeId] = useState<string | null>(null);
  // Most recent Sacari Cup champion — drives the banner near the top
  // of the home tab. Refetched alongside the rest of the home data so a
  // pull-to-refresh on Monday morning picks up the new champion crisply.
  const [lastChampion, setLastChampion] = useState<
    { username: string; avatar_url: string | null; best_to_par: number; week_starts_at: string } | null
  >(null);

  const loadHomeData = useCallback(async () => {
    try {
      await refreshUser();
    } catch { /* silent */ }
    try {
      const matches = await api.matches.list();
      const list = Array.isArray(matches) ? matches : [];
      const actives = list.filter((m: any) => !m.completed && !m.cancelled);
      setResumeCount(actives.length);
      setSingleResumeId(actives.length === 1 ? actives[0].match_id : null);
    } catch { /* silent */ }
    try {
      const rows = await api.users.perks();
      setPerkCount(Array.isArray(rows) ? rows.length : 0);
    } catch { /* silent */ }
    try {
      const ch = await api.weeklyCup.lastChampion();
      setLastChampion(ch.champion ?? null);
    } catch { /* silent */ }
  }, [refreshUser, user?.user_id]);

  useEffect(() => { loadHomeData(); }, [loadHomeData]);

  // Clean up the SR-tap timer if the component unmounts mid-sequence so we
  // don't fire setState on an unmounted screen.
  useEffect(() => {
    return () => { if (eloTapTimer.current) clearTimeout(eloTapTimer.current); };
  }, []);

  if (!user) return null;

  const rank = rankForElo(user.elo);
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

      {/* Last week's Sacari Cup champion — gold trophy banner. Hidden
          until a cup actually resolves (fresh DB / first-ever week). */}
      {lastChampion && (
        <TouchableOpacity
          style={styles.champBanner}
          onPress={() => router.push('/sacari-cup' as any)}
          activeOpacity={0.85}
        >
          <Text style={styles.champTrophy}>🏆</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.champLabel}>LAST WEEK'S CHAMPION</Text>
            {/* Champion's equipped name flair, fully animated — the banner
                is the reward, so let it shine. */}
            <IdentityName
              visual={(lastChampion as any).equipped_visual}
              style={styles.champName}
              animated
            >
              {censor(lastChampion.username)}
            </IdentityName>
            <Text style={styles.champMeta}>
              {lastChampion.best_to_par > 0
                ? `+${lastChampion.best_to_par}`
                : lastChampion.best_to_par === 0 ? 'E' : lastChampion.best_to_par}
              {' '}· week of {new Date(lastChampion.week_starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </Text>
          </View>
          <Text style={styles.champChev}>›</Text>
        </TouchableOpacity>
      )}

      {/* SR card — tap SR number 5× to open Find Ranker (existing easter egg) */}
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
          <Text style={[styles.eloNum, { color: rank.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
            {rank.label}
          </Text>
          <Text style={styles.eloLabel}>
            {rank.isObsidian
              ? `${user.elo} SR`
              : `${rank.lp}/${rank.lpNeeded} SR · ${rank.lpToNext} to ${rank.next?.label ?? 'next'}`}
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

      {/* Lucky Round — thin pulsing strip that hugs the bottom of the SR
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

      {/* Resume-round chip — visible whenever the user has any open match.
          With one in progress we deep-link straight into it; with several
          we route to the Resume picker so they can pick the right one. */}
      {resumeCount > 0 && (
        <View style={styles.statusRow}>
          <PressableScale
            onPress={() => router.push((singleResumeId
              ? `/match/${singleResumeId}`
              : '/resume') as any)}
            style={{ flex: 1 }}
          >
            <GlowCard color={C.gold} style={[styles.statusChip, styles.statusChipGold]}>
              <View style={styles.statusChipDot} />
              <Text style={styles.statusChipLabel} numberOfLines={1}>
                {resumeCount > 1 ? `RESUME ROUND (${resumeCount})` : 'RESUME ROUND'}
              </Text>
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
            As a thanks for being in our first 100 users, premium is on the house. Tap to see what's included.
          </Text>
        </TouchableOpacity>
      )}

      {/* Quick-access hub: the home tab doubles as the app's map. Every
          marquee surface is one tap from here, so features stop being
          "buried somewhere in Profile". 3-wide compact tiles. */}
      <View style={styles.hubGrid}>
        {([
          { mark: '★', label: 'Leaderboard', to: '/leaderboard' },
          { mark: '♛', label: 'Tournaments', to: '/tournaments' },
          { mark: '🏆', label: 'Sacari Cup', to: '/sacari-cup' },
          { mark: '▼', label: 'Season Pass', to: '/season-pass' },
          { mark: '✦', label: 'Locker Room', to: '/locker-room' },
          { mark: '⛳︎', label: 'Range', to: '/range' },
        ] as const).map((t) => (
          <PressableScale
            key={t.to}
            onPress={() => router.push(t.to as any)}
            style={styles.hubTile}
          >
            <Text style={styles.hubTileMark}>{t.mark}</Text>
            <Text style={styles.hubTileLabel} numberOfLines={1}>{t.label}</Text>
          </PressableScale>
        ))}
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
  // of the SR card (via the negative top margin on the wrapping
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

  champBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.gold + '18', borderRadius: 12, padding: 14, marginBottom: 14,
    borderWidth: 2, borderColor: C.gold,
  },
  champTrophy: { fontSize: 34 },
  champLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  champName: { color: C.gold, fontFamily: F.serif, fontSize: 18, fontWeight: '900', marginTop: 2 },
  champMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  champChev: { color: C.gold, fontSize: 22, fontWeight: '700' },

  // 2-wide nav grid (replaces the stacked Leaderboard / Tournaments buttons).
  // Each tile uses PressableScale for tactile press feedback. Slight
  // gold-tinted background wash makes the cards lift against the true-black
  // page background with the refined palette.
  hubGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10,
    marginTop: 4, marginBottom: 24,
  },
  hubTile: {
    // Three per row: (100% - 2 gaps of 10) / 3. flexBasis + grow keeps
    // rows balanced if the list isn't a multiple of three.
    flexBasis: '30%', flexGrow: 1,
    backgroundColor: C.card, borderRadius: 10,
    paddingVertical: 12, paddingHorizontal: 8,
    borderWidth: 1, borderColor: C.gold + '55', alignItems: 'center',
    shadowColor: C.gold, shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
  },
  hubTileMark: { color: C.gold, fontFamily: F.serif, fontSize: 20, fontWeight: '900' },
  hubTileLabel: { color: C.text, fontSize: 12, fontWeight: '800', marginTop: 5 },

  feedHeader: {
    color: C.textMuted, fontSize: 11, fontWeight: '700',
    letterSpacing: 1.5, marginBottom: 4, marginLeft: -4,
  },
});
