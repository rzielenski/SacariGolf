/**
 * Season Pass — current month's progression.
 *
 * Layout (Fortnite / LoL style):
 *
 *   [header card]
 *     SEASON NAME  ·  X days left  ·  XP X / 10
 *     ▓▓▓▓▓░░░░░  (progress bar)
 *
 *   [tier ladder — horizontal scroll]
 *     ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ …
 *     │ T1  │ │ T2  │ │ T3  │ │ T4  │ │ T5  │
 *     │ 🎁  │ │ 🔒  │ │ 🔒  │ │ 🔒  │ │ 🔒  │
 *     │CLAIM│ │ 1xp │ │ 2xp │ │ 3xp │ │ 4xp │
 *     └─────┘ └─────┘ └─────┘ └─────┘ └─────┘
 *
 *   Each tier card uses the actual CosmeticBackground / Border / Trail
 *   renderer so the user sees the real reward styled correctly.
 *
 * XP rule: +1 per completed ranked round. 10 tiers = 10 rounds.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import {
  CosmeticBackground, CosmeticBorder, CosmeticUsername, CosmeticTrailPreview,
} from '../components/Cosmetics';

type Tier = Awaited<ReturnType<typeof api.seasonPass.current>>['tiers'][number];

const RARITY_COLOR: Record<string, string> = {
  common:    '#aeb6c2',
  rare:      '#4a9eff',
  epic:      '#a89cf0',
  legendary: '#d4a93f',
};

function fmtDaysLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'Season ending';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 1) return `${days}d ${hours}h left`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${mins}m left`;
}

export default function SeasonPassScreen() {
  const { refreshUser } = useAuth();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.seasonPass.current>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [claiming, setClaiming] = useState<number | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try { setData(await api.seasonPass.current()); }
    catch (e: any) { Alert.alert('Could not load', e?.message ?? 'Try again.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onClaim = useCallback(async (tier: number) => {
    setClaiming(tier);
    try {
      await api.seasonPass.claim(tier);
      await load();          // re-pull progression so the tier flips claimed
      await refreshUser();   // refresh equipped pointers (in case user equips later)
    } catch (e: any) {
      Alert.alert('Claim failed', e?.message ?? 'Try again.');
    } finally {
      setClaiming(null);
    }
  }, [load, refreshUser]);

  if (loading || !data) {
    return (
      <View style={s.centered}>
        <Stack.Screen options={{ title: 'Season Pass', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
        <ActivityIndicator color={C.gold} size="large" />
      </View>
    );
  }

  const xpTotal = 10;
  const xpPct = Math.min(1, data.xp / xpTotal);
  const seasonName = data.season?.name ?? 'Off-Season';
  const daysLeft = data.season ? fmtDaysLeft(data.season.ends_at) : '—';

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Season Pass',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
      >
        {/* ─── Hero ─────────────────────────────────────────────────── */}
        <View style={s.hero}>
          <Text style={s.heroLabel}>SEASON PASS</Text>
          <Text style={s.heroTitle}>{seasonName}</Text>
          <Text style={s.heroSub}>{daysLeft}</Text>
          <View style={s.xpBar}>
            <View style={[s.xpFill, { width: `${xpPct * 100}%` }]} />
          </View>
          <Text style={s.xpText}>
            {data.xp} / {xpTotal} rounds  ·  {data.xp >= xpTotal ? 'FULL PASS UNLOCKED' : `${xpTotal - data.xp} to go`}
          </Text>
          <Text style={s.heroRule}>
            Earn 1 XP per ranked round. Each tier you reach unlocks the cosmetic. No paid skips.
          </Text>
        </View>

        {/* ─── Tier ladder ─────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>REWARD LADDER</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        >
          {data.tiers.map((tier) => (
            <TierCard
              key={tier.tier}
              tier={tier}
              currentXp={data.xp}
              busy={claiming === tier.tier}
              onClaim={() => onClaim(tier.tier)}
            />
          ))}
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function TierCard({
  tier, currentXp, busy, onClaim,
}: { tier: Tier; currentXp: number; busy: boolean; onClaim: () => void }) {
  const canClaim = tier.reached && !tier.claimed;
  const isLocked = !tier.reached;
  const visual = tier.visual_data;
  const rarityColor = RARITY_COLOR[tier.rarity ?? 'common'] ?? C.border;

  return (
    <View style={[
      s.tierCard,
      { borderColor: tier.claimed ? C.gold : rarityColor },
      isLocked && { opacity: 0.6 },
    ]}>
      <Text style={s.tierNum}>TIER {tier.tier}</Text>
      <View style={s.tierPreview}>
        <TierVisual kind={tier.kind} visual={visual} />
      </View>
      <Text style={s.tierName} numberOfLines={1}>
        {tier.cosmetic_name ?? '—'}
      </Text>
      <Text style={[s.tierRarity, { color: rarityColor }]}>
        {(tier.rarity ?? '').toUpperCase()}
      </Text>

      {tier.claimed ? (
        <View style={s.claimedBadge}>
          <Text style={s.claimedText}>✓ CLAIMED</Text>
        </View>
      ) : canClaim ? (
        <TouchableOpacity style={s.claimBtn} onPress={onClaim} disabled={busy}>
          {busy
            ? <ActivityIndicator color={C.bg} size="small" />
            : <Text style={s.claimBtnText}>CLAIM</Text>}
        </TouchableOpacity>
      ) : (
        <View style={s.lockedBadge}>
          <Text style={s.lockedText}>
            🔒 {tier.xp_required - currentXp} more
          </Text>
        </View>
      )}
    </View>
  );
}

function TierVisual({ kind, visual }: { kind: string | null; visual: any }) {
  if (!visual) return <View style={s.tierEmpty}><Text style={{ color: C.textMuted, fontSize: 11 }}>No reward</Text></View>;
  if (kind === 'background') {
    return <CosmeticBackground visual={visual} style={s.tierBgPreview} />;
  }
  if (kind === 'border') {
    return (
      <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
        <CosmeticBorder visual={visual} size={42}>
          <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: C.card }} />
        </CosmeticBorder>
      </View>
    );
  }
  if (kind === 'username') {
    return (
      <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1, backgroundColor: C.card }}>
        <CosmeticUsername visual={visual} style={{ fontFamily: F.serif, fontSize: 28, fontWeight: '900' }}>
          Aa
        </CosmeticUsername>
      </View>
    );
  }
  if (kind === 'ball_trail') {
    return (
      <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1, backgroundColor: C.card }}>
        <CosmeticTrailPreview visual={visual} />
      </View>
    );
  }
  return <View style={s.tierEmpty} />;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: C.bg },

  hero: {
    margin: 16, padding: 20, borderRadius: 14,
    backgroundColor: C.card, borderWidth: 2, borderColor: C.gold,
    alignItems: 'center',
  },
  heroLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  heroTitle: { color: C.gold, fontFamily: F.serif, fontSize: 28, fontWeight: '900', marginTop: 4 },
  heroSub: { color: C.text, fontSize: 13, fontWeight: '700', marginTop: 4 },
  xpBar: {
    width: '100%', height: 12, borderRadius: 6,
    backgroundColor: C.cardAlt ?? C.border, marginTop: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border,
  },
  xpFill: { height: '100%', backgroundColor: C.gold },
  xpText: { color: C.text, fontWeight: '900', marginTop: 8 },
  heroRule: { color: C.textMuted, fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 17 },

  sectionLabel: {
    color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.5,
    marginHorizontal: 16, marginBottom: 12, marginTop: 6,
  },

  tierCard: {
    width: 150, padding: 12, borderRadius: 12, borderWidth: 2,
    backgroundColor: C.card, alignItems: 'center', gap: 6,
  },
  tierNum: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  tierPreview: {
    width: '100%', height: 90, borderRadius: 8,
    backgroundColor: C.cardAlt ?? '#222', overflow: 'hidden',
    marginVertical: 4,
  },
  tierBgPreview: { width: '100%', height: '100%' },
  tierEmpty: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  tierName: { color: C.text, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  tierRarity: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  claimBtn: {
    backgroundColor: C.gold, paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 6, marginTop: 4,
  },
  claimBtnText: { color: C.bg, fontWeight: '900', letterSpacing: 1, fontSize: 11 },
  claimedBadge: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, marginTop: 4 },
  claimedText: { color: C.gold, fontWeight: '900', fontSize: 10, letterSpacing: 1 },
  lockedBadge: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, marginTop: 4,
    borderWidth: 1, borderColor: C.border,
  },
  lockedText: { color: C.textMuted, fontWeight: '700', fontSize: 10 },
});
