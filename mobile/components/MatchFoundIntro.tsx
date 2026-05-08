import React, { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, Image, TouchableOpacity, Easing,
} from 'react-native';
import { Audio } from 'expo-av';
import { C, F } from '../lib/colors';
import { API_BASE } from '../lib/api';

/**
 * Match-found intro screen — animated reveal of both teams' clan info,
 * member rosters, and ELOs. While the modal is up, the OPPONENT's clan
 * theme song preview plays in the background. First-render only — once
 * dismissed it doesn't re-show for the same match.
 *
 * Designed to be shown over the match page on first view of a newly-paired
 * match. Caller is responsible for tracking "have I shown this yet" state
 * (typically via AsyncStorage keyed on match_id).
 */
export type SidePlayer = {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  elo?: number | null;
  clan_name?: string | null;
  clan_elo?: number | null;
  clan_avatar_url?: string | null;
  clan_theme_title?: string | null;
  clan_theme_artist?: string | null;
  clan_theme_artwork?: string | null;
  clan_theme_preview?: string | null;
};

export function MatchFoundIntro({
  visible,
  meSide,            // which side (1 or 2) belongs to the viewer
  side1Players,
  side2Players,
  onDismiss,
}: {
  visible: boolean;
  meSide: 1 | 2;
  side1Players: SidePlayer[];
  side2Players: SidePlayer[];
  onDismiss: () => void;
}) {
  const fadeIn = useRef(new Animated.Value(0)).current;
  const leftSlide = useRef(new Animated.Value(-300)).current;
  const rightSlide = useRef(new Animated.Value(300)).current;
  const versusScale = useRef(new Animated.Value(0)).current;
  const soundRef = useRef<Audio.Sound | null>(null);

  // Pick the OPPONENT side's first available theme preview to play.
  const opponentPlayers = meSide === 1 ? side2Players : side1Players;
  const opponentTheme =
    opponentPlayers.find((p) => p.clan_theme_preview)?.clan_theme_preview ?? null;

  // Run animations when the modal becomes visible.
  useEffect(() => {
    if (!visible) return;
    fadeIn.setValue(0);
    leftSlide.setValue(-300);
    rightSlide.setValue(300);
    versusScale.setValue(0);

    Animated.sequence([
      Animated.parallel([
        Animated.timing(fadeIn, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(leftSlide, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(rightSlide, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.spring(versusScale, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start();
  }, [visible]);

  // Play / stop the opponent's theme as the modal opens / closes.
  useEffect(() => {
    if (!visible || !opponentTheme) return;
    let cancelled = false;
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          { uri: opponentTheme },
          { shouldPlay: true, volume: 0.7 },
        );
        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        soundRef.current = sound;
      } catch { /* preview is non-essential */ }
    })();
    return () => {
      cancelled = true;
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => { });
        soundRef.current.unloadAsync().catch(() => { });
        soundRef.current = null;
      }
    };
  }, [visible, opponentTheme]);

  if (!visible) return null;

  const renderSide = (
    players: SidePlayer[],
    isMe: boolean,
    slide: Animated.Value,
  ) => {
    // Pick the most-represented clan on this side as the "team" identity.
    const lead = players.find((p) => p.clan_name) ?? players[0];
    const clanAvatar = lead?.clan_avatar_url ? `${API_BASE}${lead.clan_avatar_url}` : null;
    const clanName = lead?.clan_name ?? lead?.username ?? '—';
    const clanElo = lead?.clan_elo ?? lead?.elo ?? null;
    return (
      <Animated.View
        style={[
          s.sideCol,
          isMe ? s.sideMe : s.sideOpponent,
          { transform: [{ translateX: slide }] },
        ]}
      >
        <Text style={s.sideTag}>{isMe ? 'YOU' : 'OPPONENT'}</Text>
        {clanAvatar ? (
          <Image source={{ uri: clanAvatar }} style={s.clanAvatar} />
        ) : (
          <View style={[s.clanAvatar, s.clanAvatarFallback]}>
            <Text style={s.clanAvatarFallbackText}>{clanName[0]?.toUpperCase()}</Text>
          </View>
        )}
        <Text style={s.clanName} numberOfLines={1}>{clanName}</Text>
        {clanElo != null && <Text style={s.clanElo}>{clanElo} ELO</Text>}
        <View style={s.memberList}>
          {players.map((p) => (
            <View key={p.user_id} style={s.memberRow}>
              {p.avatar_url ? (
                <Image source={{ uri: `${API_BASE}${p.avatar_url}` }} style={s.memberAvatar} />
              ) : (
                <View style={[s.memberAvatar, s.memberAvatarFallback]}>
                  <Text style={s.memberAvatarText}>{p.username[0]?.toUpperCase()}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.memberName} numberOfLines={1}>{p.username}</Text>
                <Text style={s.memberElo}>{p.elo ?? '—'} ELO</Text>
              </View>
            </View>
          ))}
        </View>
        {!isMe && opponentTheme && lead?.clan_theme_title && (
          <View style={s.themePill}>
            <Text style={s.themePillLabel}>♫ ANTHEM</Text>
            <Text style={s.themePillTitle} numberOfLines={1}>
              {lead.clan_theme_title}
            </Text>
          </View>
        )}
      </Animated.View>
    );
  };

  return (
    <Animated.View style={[s.backdrop, { opacity: fadeIn }]} pointerEvents="auto">
      <View style={s.row}>
        {renderSide(side1Players, meSide === 1, leftSlide)}

        <Animated.View style={[s.versusBadge, { transform: [{ scale: versusScale }] }]}>
          <Text style={s.versusText}>VS</Text>
        </Animated.View>

        {renderSide(side2Players, meSide === 2, rightSlide)}
      </View>

      <TouchableOpacity onPress={onDismiss} style={s.dismissBtn} activeOpacity={0.85}>
        <Text style={s.dismissText}>TAP TO START</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center', alignItems: 'center',
    zIndex: 100,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },

  sideCol: {
    flex: 1, alignItems: 'center',
    backgroundColor: C.card, borderRadius: 12, padding: 14,
    borderWidth: 2,
  },
  sideMe:       { borderColor: C.gold },
  sideOpponent: { borderColor: C.red },
  sideTag: {
    color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8,
  },

  clanAvatar: { width: 72, height: 72, borderRadius: 8, marginBottom: 10 },
  clanAvatarFallback: { backgroundColor: C.gold + '22', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: C.gold },
  clanAvatarFallbackText: { color: C.gold, fontFamily: F.serif, fontSize: 32, fontWeight: '900' },
  clanName: { color: C.text, fontFamily: F.serif, fontWeight: '900', fontSize: 16, textAlign: 'center' },
  clanElo: { color: C.gold, fontWeight: '900', fontSize: 12, marginTop: 2 },

  memberList: { width: '100%', marginTop: 10, gap: 6 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberAvatar: { width: 26, height: 26, borderRadius: 13 },
  memberAvatarFallback: { backgroundColor: C.cardAlt, justifyContent: 'center', alignItems: 'center' },
  memberAvatarText: { color: C.textMuted, fontWeight: '900', fontSize: 11 },
  memberName: { color: C.text, fontSize: 12, fontWeight: '700' },
  memberElo: { color: C.textMuted, fontSize: 10 },

  themePill: {
    marginTop: 10, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 4, borderWidth: 1, borderColor: C.gold,
    backgroundColor: C.gold + '11', maxWidth: '100%',
  },
  themePillLabel: { color: C.gold, fontSize: 8, fontWeight: '900', letterSpacing: 1, textAlign: 'center' },
  themePillTitle: { color: C.text, fontSize: 10, fontWeight: '700', marginTop: 2, textAlign: 'center' },

  versusBadge: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: C.gold, shadowOpacity: 0.8, shadowRadius: 20,
  },
  versusText: { color: C.bg, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },

  dismissBtn: {
    position: 'absolute', bottom: 60, alignSelf: 'center',
    paddingHorizontal: 28, paddingVertical: 12,
    borderWidth: 1, borderColor: C.gold, borderRadius: 6,
  },
  dismissText: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 1.5 },
});
