import React, { useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, Image, TouchableOpacity, Easing, Modal,
} from 'react-native';
import * as themePlayer from '../lib/themePlayer';
import { C, F } from '../lib/colors';
import { API_BASE } from '../lib/api';
import { RankCrest } from './RankCrest';
import { ShimmerButton } from './ui/ShimmerButton';
import { useCensor } from '../lib/censor';

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
  // Per-user theme — used when no team theme is set (solos use this).
  user_theme_title?: string | null;
  user_theme_artist?: string | null;
  user_theme_artwork?: string | null;
  user_theme_preview?: string | null;
  // Team attribution. Takes priority over per-user theme when present.
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
  matchType,         // 'solo' | 'duo' | 'squad' — controls banner + theme source
  meSide,            // which side (1 or 2) belongs to the viewer
  side1Players,
  side2Players,
  onDismiss,
}: {
  visible: boolean;
  matchType: string;
  meSide: 1 | 2;
  side1Players: SidePlayer[];
  side2Players: SidePlayer[];
  onDismiss: () => void;
}) {
  // Solo matches always show individual identity (avatar / username /
  // personal theme). Team matches (duo, squad, anything else with multiple
  // players per side) show the team banner + team theme. We branch on
  // match type so a solo player who happens to be in a duo doesn't get
  // their duo's banner pasted onto a 1v1 match.
  const isTeamMatch = matchType !== 'solo';
  const c = useCensor();
  const fadeIn = useRef(new Animated.Value(0)).current;
  const leftSlide = useRef(new Animated.Value(-300)).current;
  const rightSlide = useRef(new Animated.Value(300)).current;
  const versusScale = useRef(new Animated.Value(0)).current;

  // Pick the OPPONENT side's theme preview based on match type:
  //   • solo → opponent's personal theme only
  //   • duo / squad → opponent's team theme only (no falling back to a
  //     teammate's personal theme — if the team hasn't set one, we go silent)
  //
  // Memoized so the audio useEffect below doesn't get re-fired if the parent
  // re-renders with the same data — its deps are `[visible, opponentTheme]`
  // and unstable references would unload/reload the sound mid-playback.
  const { opponentTheme, opponentThemeTitle } = useMemo(() => {
    const opponentPlayers = meSide === 1 ? side2Players : side1Players;
    if (isTeamMatch) {
      const withClanTheme = opponentPlayers.find((p) => p.clan_theme_preview);
      return {
        opponentTheme: withClanTheme?.clan_theme_preview ?? null,
        opponentThemeTitle: withClanTheme?.clan_theme_title ?? null,
      };
    }
    const withUserTheme = opponentPlayers.find((p) => p.user_theme_preview);
    return {
      opponentTheme: withUserTheme?.user_theme_preview ?? null,
      opponentThemeTitle: withUserTheme?.user_theme_title ?? null,
    };
  }, [isTeamMatch, meSide, side1Players, side2Players]);

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

  // Hand the opponent's theme off to the singleton player. The Sound is
  // owned at the module level so it KEEPS playing after this modal
  // dismisses — the previous version stopped after ~2.5s when the intro
  // closed, cutting off 28s of a 30s preview. We never call stop() here
  // because the user explicitly asked for the full preview to ride past
  // the animation. The player self-unloads on didJustFinish.
  useEffect(() => {
    if (!visible || !opponentTheme) return;
    themePlayer.play(opponentTheme);
  }, [visible, opponentTheme]);

  // Don't early-return on !visible — the Modal handles that itself. Bailing
  // out here would unmount the Animated.Value refs and reset the animation
  // each time the parent re-renders, defeating the whole purpose.

  const renderSide = (
    players: SidePlayer[],
    isMe: boolean,
    slide: Animated.Value,
  ) => {
    // SOLO — show JUST the player. No clan banner, no member list, the
    // player IS the side. Theme pill (when this is the opponent) shows
    // the opponent's personal anthem.
    if (!isTeamMatch) {
      const p = players[0];
      const avatar = p?.avatar_url ? `${API_BASE}${p.avatar_url}` : null;
      const name = p?.username ? c(p.username) : '—';
      const elo = p?.elo ?? null;
      return (
        <Animated.View
          style={[
            s.sideCol,
            isMe ? s.sideMe : s.sideOpponent,
            { transform: [{ translateX: slide }] },
          ]}
        >
          <Text style={s.sideTag}>{isMe ? 'YOU' : 'OPPONENT'}</Text>
          <RankCrest elo={elo ?? 0} size={72} avatarBorderRadius={8} style={s.crestSpacer}>
            {avatar ? (
              <Image source={{ uri: avatar }} style={s.clanAvatarInner} />
            ) : (
              <View style={[s.clanAvatarInner, s.clanAvatarFallback]}>
                <Text style={s.clanAvatarFallbackText}>
                  {name[0]?.toUpperCase()}
                </Text>
              </View>
            )}
          </RankCrest>
          <Text style={s.clanName} numberOfLines={1}>{name}</Text>
          {elo != null && <Text style={s.clanElo}>{elo} SR</Text>}
          {!isMe && opponentTheme && opponentThemeTitle && (
            <View style={s.themePill}>
              <Text style={s.themePillLabel}>♫ ANTHEM</Text>
              <Text style={s.themePillTitle} numberOfLines={1}>
                {opponentThemeTitle}
              </Text>
            </View>
          )}
        </Animated.View>
      );
    }

    // TEAM (duo / squad) — show the clan banner up top, then list every
    // player underneath. Falls back to the first player's identity only if
    // none of the players on this side actually have a clan attached
    // (defensive — pairing should already require it for team matches).
    const lead = players.find((p) => p.clan_name) ?? players[0];
    const clanAvatar = lead?.clan_avatar_url ? `${API_BASE}${lead.clan_avatar_url}` : null;
    const rawClanName = lead?.clan_name ?? lead?.username ?? '—';
    const clanName = c(rawClanName);
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
        {/* Crest wraps the clan emblem and ranks by the clan's SR so the
            tier symbolises team strength, not any single member's grind. */}
        <RankCrest elo={clanElo ?? 0} size={72} avatarBorderRadius={8} style={s.crestSpacer}>
          {clanAvatar ? (
            <Image source={{ uri: clanAvatar }} style={s.clanAvatarInner} />
          ) : (
            <View style={[s.clanAvatarInner, s.clanAvatarFallback]}>
              <Text style={s.clanAvatarFallbackText}>{clanName[0]?.toUpperCase()}</Text>
            </View>
          )}
        </RankCrest>
        <Text style={s.clanName} numberOfLines={1}>{clanName}</Text>
        {clanElo != null && <Text style={s.clanElo}>{clanElo} SR</Text>}
        <View style={s.memberList}>
          {players.map((p) => (
            <View key={p.user_id} style={s.memberRow}>
              {p.avatar_url ? (
                <Image source={{ uri: `${API_BASE}${p.avatar_url}` }} style={s.memberAvatar} />
              ) : (
                <View style={[s.memberAvatar, s.memberAvatarFallback]}>
                  <Text style={s.memberAvatarText}>{c(p.username)[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.memberName} numberOfLines={1}>{c(p.username)}</Text>
                <Text style={s.memberElo}>{p.elo ?? '—'} SR</Text>
              </View>
            </View>
          ))}
        </View>
        {!isMe && opponentTheme && opponentThemeTitle && (
          <View style={s.themePill}>
            <Text style={s.themePillLabel}>♫ ANTHEM</Text>
            <Text style={s.themePillTitle} numberOfLines={1}>
              {opponentThemeTitle}
            </Text>
          </View>
        )}
      </Animated.View>
    );
  };

  // Wrapping in <Modal transparent> so the overlay floats above EVERY screen
  // regardless of where MatchFoundWatcher sits in the layout tree. Without
  // this, an absolute-positioned View can be drawn UNDER the Stack navigator
  // (later siblings paint on top), making the intro invisible until you
  // navigate.
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <Animated.View style={[s.backdrop, { opacity: fadeIn }]} pointerEvents="auto">
        <View style={s.row}>
          {renderSide(side1Players, meSide === 1, leftSlide)}

          <Animated.View style={[s.versusBadge, { transform: [{ scale: versusScale }] }]}>
            <Text style={s.versusText}>VS</Text>
          </Animated.View>

          {renderSide(side2Players, meSide === 2, rightSlide)}
        </View>

        {/* Dismiss button uses ShimmerButton so a subtle gold-light highlight
            sweeps across every ~4 seconds — draws the eye to the action
            without being a constant motion distraction. */}
        <ShimmerButton
          onPress={onDismiss}
          background={C.gold}
          style={s.dismissBtn}
        >
          <Text style={s.dismissText}>TAP TO START</Text>
        </ShimmerButton>
      </Animated.View>
    </Modal>
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

  // Inner avatar (sits inside the RankCrest, which provides the outer ring).
  // No marginBottom — the crest container's own size + crestSpacer below
  // give the breathing room.
  clanAvatarInner: { width: 72, height: 72, borderRadius: 8 },
  clanAvatarFallback: { backgroundColor: C.gold + '22', justifyContent: 'center', alignItems: 'center' },
  clanAvatarFallbackText: { color: C.gold, fontFamily: F.serif, fontSize: 32, fontWeight: '900' },
  crestSpacer: { marginBottom: 6 },
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
    borderRadius: 6,
  },
  // Text now sits on a filled-gold ShimmerButton; flip color to bg
  // (black) so the contrast reads cleanly.
  dismissText: { color: C.bg, fontWeight: '900', fontSize: 13, letterSpacing: 1.5 },
});
