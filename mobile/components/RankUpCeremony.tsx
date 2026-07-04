/**
 * Rank-up ceremony — the cinematic that fires when a player climbs into a new
 * TIER (a new metal: Wood → Bronze → … → Obsidian), not just a division. It
 * reuses the whole VFX kit (screen flash, shockwave, particle burst, radial
 * rays, impact text) plus the real RankCrest, so a promotion finally feels like
 * the moment it is instead of a silent LP tick.
 *
 *   • RankUpCeremony — the overlay itself. Fire it with the player's post-
 *     promotion elo; it renders the NEW tier's crest slamming in.
 *   • RankUpWatcher — a global, mount-once detector (sits in the root layout
 *     next to MatchFoundWatcher). It remembers the last tier it saw per user in
 *     AsyncStorage; when `user.elo` crosses UP into a higher metal, it fires the
 *     ceremony. Demotions update the marker silently. The very first observation
 *     ever seeds the marker without firing, so a fresh install / first login
 *     doesn't set off fireworks for a rank you already had.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Dimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence,
  cancelAnimation, interpolate, Extrapolation, Easing,
} from 'react-native-reanimated';
import { RankCrest } from './RankCrest';
import {
  ScreenFlash, ShockwaveRing, ParticleBurst, RadialRays, GlowPulse, ImpactText,
} from './vfx';
import { rankForElo, tierByKey, TIERS, type TierKey } from '../lib/rank';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';

const { width: SCREEN_W } = Dimensions.get('window');
const AVATAR = 118;                       // avatar diameter inside the crest
const FX = Math.min(SCREEN_W * 1.1, 480); // footprint of the burst/shockwave layers

function tierIndex(key: TierKey): number {
  return Math.max(0, TIERS.findIndex((t) => t.key === key));
}

const centeredFill = [StyleSheet.absoluteFill, { alignItems: 'center' as const, justifyContent: 'center' as const }];

export function RankUpCeremony({
  elo, fromTierName, username, avatarUrl, onDismiss,
}: {
  elo: number;
  fromTierName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  onDismiss: () => void;
}) {
  const rank = rankForElo(elo);
  const color = rank.color;

  // Fire the one-shot bursts a beat after mount so the modal is on screen first.
  const [active, setActive] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setActive(true), 60);
    return () => clearTimeout(id);
  }, []);

  // The crest slams in: fade + overshoot scale, then settle.
  const slam = useSharedValue(0);
  useEffect(() => {
    slam.value = withDelay(140, withSequence(
      withTiming(1.14, { duration: 380, easing: Easing.out(Easing.back(1.6)) }),
      withTiming(1, { duration: 220, easing: Easing.inOut(Easing.quad) }),
    ));
    return () => cancelAnimation(slam);
  }, [slam]);
  const crestStyle = useAnimatedStyle(() => ({
    opacity: interpolate(slam.value, [0, 0.25], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(slam.value, [0, 1], [0.2, 1], Extrapolation.CLAMP) }],
  }));

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tier-tinted wash so the whole scene reads in the metal's color. */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.08 }]} />

        {/* Ambient spinning rays + bloom behind the crest. */}
        <View pointerEvents="none" style={centeredFill}>
          <RadialRays size={FX * 1.25} color={color} opacity={0.2} spinMs={16000} />
        </View>
        <View pointerEvents="none" style={centeredFill}>
          <GlowPulse size={FX * 0.9} color={color} maxOpacity={0.4} />
        </View>

        {/* One-shot impact stack, centered on the crest. */}
        <ScreenFlash active={active} color={color} peak={0.5} durationMs={520} />
        <View pointerEvents="none" style={centeredFill}>
          <ShockwaveRing active={active} size={FX} color={color} thickness={5} rings={3} delay={160} durationMs={820} />
        </View>
        <View pointerEvents="none" style={centeredFill}>
          <ParticleBurst active={active} size={FX} color={color} color2="#ffffff" count={34} particleR={3.4} durationMs={1000} delay={180} />
        </View>

        {/* Content column. */}
        <View style={styles.content}>
          <ImpactText active={active} delay={120}>
            <Text style={[styles.eyebrow, { color }]}>RANK UP</Text>
          </ImpactText>

          <Animated.View style={[styles.crestWrap, crestStyle]}>
            <RankCrest elo={elo} size={AVATAR} username={username} avatarUrl={avatarUrl} />
          </Animated.View>

          <ImpactText active={active} delay={420}>
            <Text style={[styles.tier, { color }]}>{rank.label.toUpperCase()}</Text>
          </ImpactText>
          {fromTierName ? (
            <Text style={styles.fromTo}>{fromTierName} → {rank.tier.name}</Text>
          ) : (
            <Text style={styles.fromTo}>Welcome to {rank.tier.name}</Text>
          )}
        </View>

        <TouchableOpacity style={[styles.cta, { borderColor: color }]} onPress={onDismiss} activeOpacity={0.85}>
          <Text style={[styles.ctaText, { color }]}>Continue</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const RANKUP_KEY = (userId: string) => `rankup_last_tier_v1_${userId}`;

export function RankUpWatcher() {
  const { user } = useAuth();
  const [ceremony, setCeremony] = useState<{ elo: number; fromTierName: string } | null>(null);
  // Guard so a single promotion fires once even as elo/user re-render.
  const firingRef = useRef(false);

  useEffect(() => {
    if (!user?.user_id) return;
    let cancelled = false;
    (async () => {
      try {
        const elo = user.elo ?? 100;
        const rank = rankForElo(elo);
        const curIdx = tierIndex(rank.tier.key);
        const key = RANKUP_KEY(user.user_id);
        const raw = await AsyncStorage.getItem(key);
        if (cancelled) return;

        if (raw == null) {
          // First time we've ever seen this account — seed silently.
          await AsyncStorage.setItem(key, JSON.stringify({ idx: curIdx, key: rank.tier.key }));
          return;
        }
        const prev = JSON.parse(raw) as { idx: number; key: TierKey };
        // Persist the new tier FIRST (both up and down) so we never re-fire the
        // same promotion, even if the ceremony is dismissed and elo re-emits.
        await AsyncStorage.setItem(key, JSON.stringify({ idx: curIdx, key: rank.tier.key }));
        if (curIdx > prev.idx && !firingRef.current) {
          firingRef.current = true;
          setCeremony({ elo, fromTierName: tierByKey(prev.key).name });
        }
      } catch { /* best-effort — a missing marker just means no ceremony */ }
    })();
    return () => { cancelled = true; };
  }, [user?.user_id, user?.elo]);

  if (!ceremony) return null;
  return (
    <RankUpCeremony
      elo={ceremony.elo}
      fromTierName={ceremony.fromTierName}
      username={user?.username}
      avatarUrl={user?.avatar_url}
      onDismiss={() => { setCeremony(null); firingRef.current = false; }}
    />
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(4,4,6,0.92)', alignItems: 'center', justifyContent: 'center' },
  content: { alignItems: 'center', paddingHorizontal: 24 },
  eyebrow: { fontSize: 15, fontWeight: '900', letterSpacing: 6, marginBottom: 18 },
  crestWrap: { alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  tier: { fontSize: 40, fontWeight: '900', fontFamily: F.serif, letterSpacing: 1, marginTop: 18, textAlign: 'center' },
  fromTo: { color: C.textMuted, fontSize: 14, fontWeight: '700', marginTop: 8, letterSpacing: 0.5 },
  cta: {
    position: 'absolute', bottom: 64, alignSelf: 'center',
    borderWidth: 1.5, borderRadius: 999, paddingVertical: 13, paddingHorizontal: 44,
  },
  ctaText: { fontSize: 15, fontWeight: '900', letterSpacing: 2 },
});
