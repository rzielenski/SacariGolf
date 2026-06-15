import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  Image, Modal, ActivityIndicator, TextInput, FlatList, Linking,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../../lib/auth';
import { api, API_BASE } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { router } from 'expo-router';
import { isPremium } from '../../lib/premium';
import { fmtHandicap, parForHolesPlayed, toParForHolesPlayed, fmtToPar } from '../../lib/golfMath';
import { useCensor } from '../../lib/censor';
import { ThemeSongPicker, ThemeTrack } from '../../components/ThemeSongPicker';
import type { Course } from '../../types';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { OrnamentTitle, Divider } from '../../components/Flourish';
import { RankCrest, crestFootprint } from '../../components/RankCrest';
import { rankForElo } from '../../lib/rank';
import { PuttingApproachStats } from '../../components/PuttingApproachStats';
import { PressableScale } from '../../components/ui/PressableScale';
import { CosmeticBackground, CosmeticBorder, CosmeticUsername } from '../../components/Cosmetics';
import { GlowCard } from '../../components/ui/GlowCard';

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(value / max, 1);
  return (
    <View style={pb.track}>
      <View style={[pb.fill, { width: `${pct * 100}%`, backgroundColor: color }]} />
    </View>
  );
}
const pb = StyleSheet.create({
  track: { height: 6, backgroundColor: C.cardAlt, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});

export default function ProfileScreen() {
  const { user, logout, refreshUser, deleteAccount } = useAuth();
  const censor = useCensor();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [notifVisible, setNotifVisible] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const [notifCount, setNotifCount] = useState(0);
  const [bioModalVisible, setBioModalVisible] = useState(false);
  const [bioInput, setBioInput] = useState('');
  const [savingBio, setSavingBio] = useState(false);
  const [homeCourseModalVisible, setHomeCourseModalVisible] = useState(false);
  const [homeCourseQuery, setHomeCourseQuery] = useState('');
  const [homeCourseResults, setHomeCourseResults] = useState<Course[]>([]);
  const [searchingHomeCourse, setSearchingHomeCourse] = useState(false);
  const [recentRounds, setRecentRounds] = useState<any[]>([]);
  const [bestRound, setBestRound] = useState<any | null>(null);
  const [followingCount, setFollowingCount] = useState(0);
  const [followersCount, setFollowersCount] = useState(0);
  // Lifetime "drinks drunk" — a private stat (you + friends) the user bumps
  // by hand with the +/- on the profile tile. `drinksBusy` debounces taps
  // so a fast double-tap can't race two writes out of order.
  const [drinks, setDrinks] = useState(0);
  const drinksBusy = useRef(false);
  // The user's teams (clans). Surfaced on the profile so the Teams sub-tab
  // didn't have to keep haunting the Social area after that tab was
  // refocused on chats only.
  const [myTeams, setMyTeams] = useState<any[]>([]);
  const [stats, setStats] = useState<any | null>(null);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [handicap, setHandicap] = useState<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number } | null>(null);
  const [hcapModalVisible, setHcapModalVisible] = useState(false);
  const [hcapDifferentials, setHcapDifferentials] = useState<any[]>([]);
  const [themePickerVisible, setThemePickerVisible] = useState(false);
  // Manual-handicap override editor — used as a starting baseline before
  // the user has enough rated rounds for the WHS auto-calc to take over.
  // Writes to users.handicap_index, which the SG calculation reads as the
  // "your skill" baseline. Moved here from the home tab during the home/feed
  // restructure.
  const [manualHcapModal, setManualHcapModal] = useState(false);
  const [manualHcapInput, setManualHcapInput] = useState('');

  const setUserTheme = async (track: ThemeTrack) => {
    try {
      await api.users.update({ theme: track });
      await refreshUser?.();
    } catch (e: any) {
      Alert.alert('Could not save theme', e.message ?? 'Try again.');
    }
  };
  const clearUserTheme = async () => {
    try {
      await api.users.update({ theme: null });
      await refreshUser?.();
    } catch (e: any) {
      Alert.alert('Could not clear theme', e.message ?? 'Try again.');
    }
  };

  const openScorecard = (round: any) => {
    if (!user) return;
    setScorecardEntry({
      username: user.username,
      user_id: user.user_id,
      teebox_name: round.teebox_name,
      hole_scores: round.hole_scores,
      hole_stats: round.hole_stats,
      course_id: round.course_id,
      course_name: round.course_name,
      teebox_id: round.teebox_id,
      total_score: round.total_score,
      created_at: round.created_at,
      teebox_par: round.teebox_par,
      match_id: round.match_id,
      round_id: round.round_id,
    });
  };

  // Refresh cached user object on mount — pulls latest is_premium / verification
  // state without forcing a re-login. Only runs when we have a logged-in user.
  useEffect(() => {
    if (!user) return;
    refreshUser?.().catch(() => { });
  // Run once per mount; we don't want this looping on every user change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Notification bell counter ───────────────────────────────────────
  // Local counter, persisted in AsyncStorage. The server's `unread_count`
  // has been unreliable — it kept landing on "1" no matter what — so the
  // bell now ignores it and counts received pushes directly. The rule is
  // simple: every push the device sees while we're listening increments,
  // tapping the bell resets to 0. State outlasts app reloads via the
  // persisted key. (Pushes that arrive while the app is fully killed are
  // not counted — the OS shows them in the system tray but our listener
  // can't fire; that's an OK trade for not staring at a stuck "1" badge.)
  const NOTIF_BELL_KEY = `notif_bell_count_${user?.user_id ?? 'anon'}`;
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    AsyncStorage.getItem(NOTIF_BELL_KEY)
      .then((raw) => {
        if (cancelled) return;
        const n = raw ? parseInt(raw, 10) : 0;
        setNotifCount(Number.isFinite(n) && n >= 0 ? n : 0);
      })
      .catch(() => { });
    const sub = Notifications.addNotificationReceivedListener(() => {
      setNotifCount((prev) => {
        const next = prev + 1;
        AsyncStorage.setItem(NOTIF_BELL_KEY, String(next)).catch(() => { });
        return next;
      });
    });
    return () => { cancelled = true; sub.remove(); };
  // NOTIF_BELL_KEY is derived from user.user_id so re-keying happens via
  // the dep array; safe to depend on user_id alone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_id]);

  // Load recent rounds + best round (rich profile data)
  useEffect(() => {
    if (!user) return;
    api.users.get(user.user_id)
      .then((data) => {
        setRecentRounds(data.recent_rounds ?? []);
        setBestRound(data.best_round ?? null);
        setFollowingCount(data.following_count ?? 0);
        setFollowersCount(data.followers_count ?? 0);
        setDrinks(data.drinks ?? 0);
      })
      .catch(() => { });
    // Teams the user belongs to. Cheap call, runs alongside the profile
    // hydrate so the My Teams section is populated by the time the user
    // scrolls down to it.
    api.clans.mine()
      .then((teams) => setMyTeams(Array.isArray(teams) ? teams : []))
      .catch(() => { });
  }, [user?.user_id]);

  // Aggregated GIR / FW% / putts / strokes-gained from completed rounds
  useEffect(() => {
    if (!user) return;
    api.users.stats(user.user_id).then(setStats).catch(() => { });
  }, [user?.user_id]);

  // Load calculated handicap
  useEffect(() => {
    if (!user) return;
    api.users.handicap(user.user_id)
      .then((data) => {
        setHandicap(data);
        setHcapDifferentials(data.differentials ?? []);
      })
      .catch(() => { });
  }, [user?.user_id]);

  const openNotifications = useCallback(async () => {
    setNotifVisible(true);
    setLoadingNotifs(true);
    // Reset the bell counter immediately — the user asked for this exact
    // semantic: increment per received push, zero out on tap. We persist
    // 0 so the badge stays cleared across reloads even if the server's
    // /notifications fetch errors or comes back with stale unread_count.
    setNotifCount(0);
    AsyncStorage.setItem(NOTIF_BELL_KEY, '0').catch(() => { });
    // Fire-and-forget server-side mark-seen so any other surface that
    // reads from unread_count (and the device's system tray badge) stays
    // in sync. We no longer depend on the value it returns.
    api.users.markNotificationsSeen().catch(() => { });
    try {
      const res = await api.users.notifications();
      setNotifications(res.notifications ?? []);
    } catch {
      /* silent — bell is already cleared locally */
    } finally {
      setLoadingNotifs(false);
    }
  }, [NOTIF_BELL_KEY]);

  if (!user) return null;

  const rank = rankForElo(user.elo);
  const winRate = user.total_matches > 0
    ? Math.round((user.total_wins / user.total_matches) * 100)
    : 0;

  const handleLogout = () => {
    Alert.alert('Log out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: logout },
    ]);
  };

  // Bump the lifetime drinks tally. Optimistic — update the number instantly,
  // then reconcile with the server's clamped value. A short busy-gate keeps
  // rapid taps from racing two writes; the count never goes below 0.
  const adjustDrinks = useCallback(async (delta: 1 | -1) => {
    if (drinksBusy.current) return;
    if (delta < 0 && drinks <= 0) return;
    drinksBusy.current = true;
    setDrinks((d) => Math.max(0, d + delta));
    try {
      const { drinks: server } = await api.users.adjustDrinks(delta);
      setDrinks(server);
    } catch {
      // Roll back the optimistic change on failure.
      setDrinks((d) => Math.max(0, d - delta));
    } finally {
      drinksBusy.current = false;
    }
  }, [drinks]);

  const changeUsername = () => {
    Alert.prompt(
      'Change Username',
      'Enter a new username (3-20 chars, letters/numbers/underscores)',
      async (newUsername) => {
        if (!newUsername) return;
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(newUsername.trim())) {
          Alert.alert('Invalid', 'Use 3–20 characters: letters, numbers, or underscores.');
          return;
        }
        try {
          await api.users.update({ username: newUsername.trim() });
          await refreshUser();
          Alert.alert('Done!', 'Username updated.');
        } catch (e: any) {
          Alert.alert('Error', e.message);
        }
      },
      'plain-text',
      user.username
    );
  };

  const changeAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to change your profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.6,
      base64: true,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    setUploadingAvatar(true);
    try {
      await api.users.uploadAvatar(asset.base64!, asset.mimeType ?? 'image/jpeg');
      await refreshUser();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const openBioModal = () => {
    setBioInput((user as any)?.bio ?? '');
    setBioModalVisible(true);
  };

  const saveBio = async () => {
    setSavingBio(true);
    try {
      await api.users.update({ bio: bioInput.trim() || null });
      await refreshUser();
      setBioModalVisible(false);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSavingBio(false);
    }
  };

  const searchHomeCourses = async (q: string) => {
    setHomeCourseQuery(q);
    if (q.length < 2) { setHomeCourseResults([]); return; }
    setSearchingHomeCourse(true);
    try {
      const r = await api.courses.search(q);
      setHomeCourseResults(r);
    } finally { setSearchingHomeCourse(false); }
  };

  const setHomeCourse = async (course: Course | null) => {
    try {
      await api.users.update({ homeCourseId: course?.course_id ?? null });
      await refreshUser();
      setHomeCourseModalVisible(false);
      setHomeCourseQuery('');
      setHomeCourseResults([]);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const handleNotifPress = (notif: any) => {
    setNotifVisible(false);
    if (notif.type === 'match_result' || notif.type === 'match_invite') {
      router.push(`/match/${notif.data.matchId}` as any);
    } else if (notif.type === 'mention') {
      // Tagged in a post → open the feed (home tab). No per-post screen.
      router.push('/(tabs)/' as any);
    }
    // friend_request and clan_invite handled in social tab
  };

  const notifIcon = (type: string) => {
    if (type === 'friend_request') return 'FR';
    if (type === 'match_invite') return 'MA';
    if (type === 'clan_invite') return 'CL';
    if (type === 'match_result') return 'RS';
    if (type === 'mention') return '@';
    return '·';
  };

  // Equipped cosmetics — visual_data resolved by the server's
  // equipped_visual blob. The renderers in components/Cosmetics interpret
  // each style (gradient | flag | pulse | aurora | stars | holographic |
  // pulse-border | glow-border | gradient-text). All three fields fall
  // back to no-op when nothing is equipped — the existing static styling
  // keeps the screen looking normal.
  const equipped = (user as any).equipped_visual ?? {};
  const bgVisual = equipped.background ?? null;
  const borderVisual = equipped.border ?? null;
  const usernameVisual = equipped.username ?? null;

  return (
    <View style={[styles.container, bgVisual && { backgroundColor: 'transparent' }]}>
      {/* Animated/styled background lives BEHIND the scroll content so
          the stars / aurora / flag patterns can paint full-bleed without
          interfering with scroll. Both the outer View AND the ScrollView
          have to be transparent when a cosmetic background is equipped —
          otherwise styles.container's backgroundColor: C.bg paints over
          the cosmetic and the player sees no change. */}
      {bgVisual && (
        <CosmeticBackground
          visual={bgVisual}
          style={StyleSheet.absoluteFillObject}
        />
      )}
    <ScrollView
      style={[styles.container, bgVisual && { backgroundColor: 'transparent' }]}
      contentContainerStyle={styles.content}
    >
      {/* Bell — old gothic, cracked */}
      <TouchableOpacity style={styles.bellBtn} onPress={openNotifications} activeOpacity={0.7}>
        <View style={styles.bellWrap}>
          <Text style={styles.bellGlyph}>🔔</Text>
          {/* Jagged crack — three short segments offset to look fractured */}
          <View style={[styles.crackSeg, { top: 10, left: 17, width: 6, transform: [{ rotate: '70deg' }] }]} />
          <View style={[styles.crackSeg, { top: 15, left: 14, width: 7, transform: [{ rotate: '110deg' }] }]} />
          <View style={[styles.crackSeg, { top: 21, left: 17, width: 5, transform: [{ rotate: '75deg' }] }]} />
          {/* Chipped rim notch */}
          <View style={styles.chipNotch} />
        </View>
        {notifCount > 0 && (
          <View style={styles.bellBadge}>
            <Text style={styles.bellBadgeText}>{notifCount > 9 ? '9+' : notifCount}</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Avatar */}
      <View style={styles.avatarSection}>
        <TouchableOpacity
          onPress={changeAvatar}
          disabled={uploadingAvatar}
          activeOpacity={0.8}
          style={{ marginBottom: 12 }}
        >
        <CosmeticBorder visual={borderVisual} size={crestFootprint(user.elo, 96)}>
          <RankCrest elo={user.elo} size={96}>
            {uploadingAvatar ? (
              <View style={styles.avatarLoader}><ActivityIndicator color={C.gold} /></View>
            ) : user.avatar_url ? (
              <Image
                source={{ uri: `${API_BASE}${user.avatar_url}` }}
                style={styles.avatarImage}
              />
            ) : (
              <View style={styles.avatarLetterBg}>
                <Text style={styles.avatarText}>{censor(user.username)[0]?.toUpperCase() ?? '?'}</Text>
              </View>
            )}
          </RankCrest>
        </CosmeticBorder>
          <View style={styles.avatarEditBadge}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>✎</Text>
          </View>
        </TouchableOpacity>
        <CosmeticUsername visual={usernameVisual} style={styles.username}>
          {censor(user.username)}
        </CosmeticUsername>
        <View style={styles.usernameSubRow}>
          {isPremium(user as any) && (
            <View style={styles.premiumPill}>
              <Text style={styles.premiumPillText}>👑 PREMIUM</Text>
            </View>
          )}
          <TouchableOpacity onPress={changeUsername} style={styles.editUsernameBtn}>
            <Text style={styles.editUsernameBtnText}>Edit username</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.email}>{user.email}</Text>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rank.label}</Text>
        </View>

        {/* Following / Followers strip — opens the swipeable Friends hub
            (Followers · Following · Add Friends) at the tapped tab. */}
        <View style={styles.followRow}>
          <TouchableOpacity
            style={styles.followCol}
            onPress={() => router.push('/friends?tab=following' as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.followNum}>{followingCount}</Text>
            <Text style={styles.followLabel}>Following</Text>
          </TouchableOpacity>
          <View style={styles.followDivider} />
          <TouchableOpacity
            style={styles.followCol}
            onPress={() => router.push('/friends?tab=followers' as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.followNum}>{followersCount}</Text>
            <Text style={styles.followLabel}>Followers</Text>
          </TouchableOpacity>
          <View style={styles.followDivider} />
          <TouchableOpacity
            style={styles.followCol}
            onPress={() => router.push('/friends?tab=add' as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.followNum}>+</Text>
            <Text style={styles.followLabel}>Add</Text>
          </TouchableOpacity>
        </View>
        {/* Open-beta note — small enough not to compete with the rank badge.
            Shown only while is_premium = true via the server-side OPEN_BETA
            override (premium_plan === 'open_beta'). Disappears automatically
            once we flip the flag off in backend/src/utils/openBeta.ts. */}
        {(user as any)?.premium_plan === 'open_beta' && (
          <Text style={styles.openBetaNote}>
            ★ Premium is on the house for our first 100 users. Enjoy.
          </Text>
        )}
      </View>

      {/* Bio */}
      <TouchableOpacity style={styles.editableCard} onPress={openBioModal}>
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>BIO</Text>
          <Text style={styles.editableValue}>
            {(user as any)?.bio ? censor((user as any).bio) : 'Tap to add a short bio'}
          </Text>
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* 2×2 grid of profile shortcuts, split into two explicit rows so
          each tile is guaranteed `flex: 1` of the row width minus the
          gap. The previous flexWrap + flexBasis approach left
          sub-percentage rounding gaps on some phone widths; this layout
          is pixel-perfect on every device. */}
      <View style={styles.miniRow}>
        <PressableScale onPress={() => setHomeCourseModalVisible(true)} style={styles.miniCard}>
          <Text style={styles.miniLabel}>HOME COURSE</Text>
          <Text style={styles.miniValue} numberOfLines={1}>
            {(user as any)?.home_course_name || 'Tap to set'}
          </Text>
        </PressableScale>

        <PressableScale onPress={() => setHcapModalVisible(true)} style={styles.miniCard}>
          <Text style={styles.miniLabel}>HANDICAP</Text>
          <Text style={styles.miniValue} numberOfLines={1}>
            {fmtHandicap(handicap?.handicap_index ?? null, 'Need 3+ rounds')}
          </Text>
        </PressableScale>
      </View>

      <View style={styles.miniRow}>
        {/* Drinks Drunk — a lifetime tally the user bumps by hand with the
            +/- buttons. Replaced the per-round map counter (and the old
            "Starting HCP" tile). Private stat: only you + friends see it. */}
        <View style={styles.miniCard}>
          <Text style={styles.miniLabel}>🍺 DRINKS DRUNK</Text>
          <View style={styles.drinksRow}>
            <TouchableOpacity
              style={[styles.drinksBtn, drinks <= 0 && styles.drinksBtnDisabled]}
              onPress={() => adjustDrinks(-1)}
              disabled={drinks <= 0}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.drinksBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.drinksValue} numberOfLines={1}>{drinks}</Text>
            <TouchableOpacity
              style={styles.drinksBtn}
              onPress={() => adjustDrinks(1)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.drinksBtnText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <PressableScale onPress={() => router.push('/bag' as any)} style={styles.miniCard}>
          <Text style={styles.miniLabel}>MY BAG</Text>
          <Text style={styles.miniValue} numberOfLines={1}>
            {Array.isArray((user as any).clubs_in_bag) && (user as any).clubs_in_bag.length > 0
              ? `${(user as any).clubs_in_bag.length} clubs`
              : 'Edit'}
          </Text>
        </PressableScale>
      </View>

      {/* Range Session — single prominent CTA. Improvement features (swing
          capture, pose analysis, pro-comparison) get their own surface
          rather than being buried in the mini-grid. Tap → /range.
          GlowCard pulse + PressableScale press feedback. */}
      <PressableScale onPress={() => router.push('/range' as any)} style={{ marginBottom: 14 }}>
        <GlowCard color={C.gold} style={styles.rangeCta}>
          <View style={styles.rangeCtaIcon}>
            <Text style={styles.rangeCtaIconText}>⛳︎</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rangeCtaLabel}>RANGE SESSION</Text>
            <Text style={styles.rangeCtaBody}>
              Record a swing — body-pose analysis, clubhead trace, full
              comparison to pro and rec-player baselines.
            </Text>
          </View>
          <Text style={styles.rangeCtaChev}>›</Text>
        </GlowCard>
      </PressableScale>

      {/* Rank progress — rank + division and total ELO on the left, the big
          number is your ELO within the current division (LP). */}
      <View style={styles.card}>
        <View style={styles.eloHeaderRow}>
          <View style={{ flexShrink: 1 }}>
            <Text style={[styles.rankNameBig, { color: rank.color }]} numberOfLines={1}>{rank.label}</Text>
            <Text style={styles.eloLabel}>
              {rank.isObsidian ? 'Top tier · no divisions' : `${user.elo} total ELO`}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.eloNum}>{rank.isObsidian ? user.elo : rank.lp}</Text>
            <Text style={styles.eloLabel}>{rank.isObsidian ? 'ELO' : `/ ${rank.lpNeeded} LP`}</Text>
          </View>
        </View>
        {!rank.isObsidian && rank.next && (
          <>
            <ProgressBar value={rank.lp} max={rank.lpNeeded ?? 50} color={rank.color} />
            <Text style={styles.progressText}>{rank.lpToNext} LP → {rank.next.label}</Text>
          </>
        )}
      </View>

      {/* Stats */}
      <View style={styles.statsGrid}>
        <StatBox label="Matches" value={user.total_matches} />
        <StatBox label="Wins" value={user.total_wins} />
        <StatBox label="Losses" value={user.total_matches - user.total_wins - (user.total_ties ?? 0)} />
        <StatBox label="Ties" value={user.total_ties ?? 0} />
        <StatBox label="Win Rate" value={`${winRate}%`} />
      </View>

      {/* Full stats screen entry point — handicap, SG, normalized averages */}
      <TouchableOpacity
        style={styles.statsBtn}
        onPress={() => router.push('/stats' as any)}
        activeOpacity={0.7}
      >
        <Text style={styles.statsBtnLabel}>VIEW STATS</Text>
        <Text style={styles.statsBtnArrow}>›</Text>
      </TouchableOpacity>

      {/* My Teams — replaces the old Social → Teams sub-tab.
          The header row has a "Browse / + New" affordance so finding
          teams to join is one tap from the profile. Empty state used
          to be a single line of text; now it's a prominent CTA card
          since "I can't figure out how to join a team" was real
          feedback. */}
      <View style={styles.teamsHeader}>
        <Text style={styles.sectionHeader}>MY TEAMS</Text>
        <TouchableOpacity
          style={styles.browseBtn}
          onPress={() => router.push('/teams' as any)}
          activeOpacity={0.7}
        >
          <Text style={styles.browseBtnText}>Browse / + New</Text>
        </TouchableOpacity>
      </View>
      {myTeams.length === 0 ? (
        <TouchableOpacity
          style={styles.teamsEmptyCta}
          onPress={() => router.push('/teams' as any)}
          activeOpacity={0.85}
        >
          <Text style={styles.teamsEmptyCtaTitle}>Find or start a team</Text>
          <Text style={styles.teamsEmptyCtaBody}>
            Join up to 2 duos and 2 squads free.
            Premium uncaps it.
          </Text>
          <Text style={styles.teamsEmptyCtaArrow}>Browse public teams →</Text>
        </TouchableOpacity>
      ) : (
        myTeams.map((t: any) => (
          <TouchableOpacity
            key={t.clan_id}
            style={styles.teamRow}
            onPress={() => router.push(`/clan/${t.clan_id}` as any)}
            activeOpacity={0.7}
          >
            <View style={styles.teamIcon}>
              <Text style={styles.teamIconText}>{censor(t.name)[0]?.toUpperCase() ?? '?'}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.teamName} numberOfLines={1}>{censor(t.name)}</Text>
              <Text style={styles.teamMeta} numberOfLines={1}>
                {String(t.clan_mode ?? '').toUpperCase()} · {t.member_count} members
              </Text>
            </View>
            <Text style={styles.statsBtnArrow}>›</Text>
          </TouchableOpacity>
        ))
      )}

      {/* ── COMPETE ─────────────────────────────────────────────────
          Every competitive surface in one labeled block. Season Ladder
          and Ball Count used to be reachable ONLY through banners inside
          the Leaderboard screen; now they're first-class rows. */}
      <Text style={[styles.sectionHeader, styles.menuHeader]}>COMPETE</Text>
      <MenuRow label="⚑  MY MATCHES" onPress={() => router.push('/matches' as any)} />
      <MenuRow label="★  LEADERBOARD" onPress={() => router.push('/leaderboard' as any)} />
      <MenuRow label="♛  TOURNAMENTS" onPress={() => router.push('/tournaments' as any)} />
      <MenuRow label="🏆  SACARI CUP · THIS WEEK" onPress={() => router.push('/sacari-cup' as any)} />
      <MenuRow label="▲  SEASON LADDER · DIVISIONS" onPress={() => router.push('/seasons' as any)} />
      <MenuRow label="◉  BALL COUNT · FOUND VS LOST" onPress={() => router.push('/balls' as any)} />

      {/* ── STYLE ──────────────────────────────────────────────────── */}
      <Text style={[styles.sectionHeader, styles.menuHeader]}>STYLE</Text>
      <MenuRow label="✦  LOCKER ROOM · COSMETICS" onPress={() => router.push('/locker-room' as any)} />
      <MenuRow label="▼  SEASON PASS · CLAIM REWARDS" onPress={() => router.push('/season-pass' as any)} />

      {/* Personal theme song — plays during the match-found VS animation
          when no team theme is set. Solo players use this. */}
      <TouchableOpacity
        style={styles.themeBtn}
        onPress={() => setThemePickerVisible(true)}
        onLongPress={() => (user as any)?.theme_track_title && Alert.alert(
          'Clear theme song?',
          `Remove "${(user as any).theme_track_title}"?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: clearUserTheme },
          ],
        )}
        activeOpacity={0.7}
      >
        {(user as any)?.theme_track_artwork ? (
          <Image source={{ uri: (user as any).theme_track_artwork }} style={styles.themeBtnArt} />
        ) : (
          <View style={[styles.themeBtnArt, { backgroundColor: C.cardAlt, justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={{ color: C.textMuted, fontSize: 16 }}>♫</Text>
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.themeBtnLabel}>MY ANTHEM</Text>
          {(user as any)?.theme_track_title ? (
            <>
              <Text style={styles.themeBtnTitle} numberOfLines={1}>{(user as any).theme_track_title}</Text>
              <Text style={styles.themeBtnArtist} numberOfLines={1}>{(user as any).theme_track_artist}</Text>
            </>
          ) : (
            <Text style={styles.themeBtnArtist}>Tap to pick a song</Text>
          )}
        </View>
        <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>
      </TouchableOpacity>

      {/* ── ACCOUNT ────────────────────────────────────────────────── */}
      <Text style={[styles.sectionHeader, styles.menuHeader]}>ACCOUNT</Text>
      <MenuRow label="✦  INVITE FRIENDS · EARN PERKS" onPress={() => router.push('/invite' as any)} />
      <TouchableOpacity
        style={styles.premiumBtn}
        onPress={() => router.push('/premium' as any)}
        activeOpacity={0.7}
      >
        <Text style={styles.premiumBtnLabel}>
          {isPremium(user as any) ? '👑 PREMIUM · MANAGE' : '👑 GO PREMIUM'}
        </Text>
        <Text style={styles.statsBtnArrow}>›</Text>
      </TouchableOpacity>
      <MenuRow label="⚙  SETTINGS" onPress={() => router.push('/settings' as any)} />

      {/* Aggregated round stats — only shown once user has any tracked data */}
      {stats && (stats.gir_eligible > 0 || stats.fw_eligible > 0) && (
        <>
          <OrnamentTitle title="Performance" />
          <View style={styles.perfGrid}>
            <StatBox
              label="GIR"
              value={stats.gir_pct != null ? `${stats.gir_pct}%` : '—'}
            />
            <StatBox
              label="Fairways"
              value={stats.fw_pct != null ? `${stats.fw_pct}%` : (stats.fw_hit_pct != null ? `${stats.fw_hit_pct}%` : '—')}
            />
            <StatBox
              label="Putts/Round"
              value={stats.avg_putts_per_round != null ? stats.avg_putts_per_round.toFixed(1) : '—'}
            />
            <StatBox
              label="Up-and-Down"
              value={stats.up_and_down_pct != null ? `${stats.up_and_down_pct}%` : '—'}
            />
            <StatBox label="3-putts" value={stats.three_putt_count ?? 0} />
            <StatBox
              label="Avg/Hole"
              value={stats.avg_strokes_per_hole != null ? stats.avg_strokes_per_hole.toFixed(2) : '—'}
            />
          </View>

          {/* Strokes gained — needs at least one hole with both putts and chips tracked */}
          {stats.sg_per_round && stats.sg_holes > 0 && (
            <>
              <Text style={styles.sgSubtitle}>STROKES GAINED PER ROUND  ·  positive = better than scratch baseline</Text>
              <View style={styles.sgRow}>
                <SGCell label="Off-Tee" value={stats.sg_per_round.off_tee} />
                <SGCell label="Approach" value={stats.sg_per_round.approach} />
                <SGCell label="Around" value={stats.sg_per_round.around_green} />
                <SGCell label="Putt" value={stats.sg_per_round.putting} />
                <SGCell label="Total" value={stats.sg_per_round.total} highlight />
              </View>
            </>
          )}
        </>
      )}

      {/* Premium-only: putting + approach bucketed by distance, with PGA
          scratch baselines. Component handles its own loading + 403 (non-
          premium) state, so we can render it unconditionally and let it
          self-suppress when the user isn't eligible. */}
      {user && isPremium(user as any) && (
        <PuttingApproachStats userId={user.user_id} />
      )}

      {/* Best Round */}
      {bestRound && (
        <>
          <OrnamentTitle title="Best Round" />

          {(() => {
            // Pro-rate par + to-par to the holes actually played (a 9-hole
            // round of an 18-hole teebox compares against ~36, not 72). The
            // 3rd arg is the teebox's num_holes from the API (t.num_holes);
            // omitting it used to default to 18 and broke 9-hole teeboxes.
            const played = bestRound.hole_scores?.length ?? bestRound.num_holes ?? null;
            const effPar = parForHolesPlayed(bestRound.teebox_par, played, bestRound.num_holes);
            const toPar  = toParForHolesPlayed(bestRound.total_score, bestRound.teebox_par, played, bestRound.num_holes);
            return (
              <TouchableOpacity
                style={[styles.roundCard, { borderColor: C.gold }]}
                onPress={() => bestRound.hole_scores?.length
                  ? openScorecard(bestRound)
                  : bestRound.course_id && router.push(`/course/${bestRound.course_id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.roundCourseName}>{bestRound.course_name ?? 'Unknown course'}</Text>
                  <Text style={styles.roundMeta}>
                    {bestRound.teebox_name} · {played ?? bestRound.num_holes} holes · Par {effPar ?? bestRound.teebox_par}
                  </Text>
                  <Text style={styles.roundDate}>
                    {new Date(bestRound.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                </View>
                <View style={styles.roundScoreBox}>
                  <Text style={[styles.roundScore, { color: C.gold }]}>{bestRound.total_score}</Text>
                  <Text style={[styles.roundToPar, { color: (toPar ?? 0) <= 0 ? C.green : C.red }]}>
                    {fmtToPar(toPar)}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })()}
        </>
      )}

      {/* Recent Rounds */}
      {recentRounds.length > 0 && (
        <>
          <OrnamentTitle title="Recent Rounds" />

          {recentRounds.map((r: any) => {
            // Pro-rate par to the holes actually played; never compare a 9-hole
            // round's total directly to the 18-hole teebox par. `r.num_holes`
            // is the teebox's num_holes (t.num_holes) and is required since
            // the helper no longer defaults to 18.
            const played = r.hole_scores?.length ?? r.num_holes ?? null;
            const toPar  = toParForHolesPlayed(r.total_score, r.teebox_par, played, r.num_holes);
            return (
              <TouchableOpacity
                key={r.round_id}
                style={styles.roundCard}
                onPress={() => r.hole_scores?.length
                  ? openScorecard(r)
                  : r.course_id && router.push(`/course/${r.course_id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.roundCourseName}>{r.course_name ?? 'Unknown'}</Text>
                  <Text style={styles.roundMeta}>
                    {r.teebox_name ?? '—'} · {played ?? '?'} holes
                    {r.format === 'scramble' ? ' · Scramble' : ''}
                  </Text>
                  <Text style={styles.roundDate}>
                    {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
                <View style={styles.roundScoreBox}>
                  <Text style={styles.roundScore}>{r.total_score}</Text>
                  {toPar != null && (
                    <Text style={[styles.roundToPar, {
                      color: toPar < 0 ? C.green : toPar > 0 ? C.red : C.text,
                    }]}>
                      {fmtToPar(toPar)}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </>
      )}

      {/* Joined */}
      <Text style={styles.joinedText}>
        Joined {new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
      </Text>

      {/* Account section — discoverable Log Out / Blocked Users / Delete.
          Apple expects the deletion flow to live somewhere obvious like a
          settings screen, not a tiny footer link. */}
      <Text style={[styles.editableLabel, { marginTop: 24, marginBottom: 8 }]}>ACCOUNT</Text>

      {/* Profanity / slur censor toggle. ON by default for new accounts
          (App Review expectation for any UGC app) — the user can flip
          it OFF here if they want unfiltered chat / posts / DMs. The
          server-stored flag drives censorText() everywhere text from
          another user is rendered. */}
      <TouchableOpacity
        style={styles.acctRow}
        onPress={async () => {
          const next = (user as any)?.censor_offensive_language === false;
          try {
            await api.users.update({ censorOffensiveLanguage: next });
            await refreshUser?.();
          } catch (e: any) {
            Alert.alert('Could not update', e?.message ?? 'Try again.');
          }
        }}
        activeOpacity={0.7}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.acctRowText}>Censor offensive language</Text>
          <Text style={[styles.acctRowText, { fontSize: 11, color: C.textMuted, marginTop: 2, fontWeight: '500' }]}>
            {(user as any)?.censor_offensive_language === false
              ? 'OFF — slurs and curse words shown as written'
              : 'ON — slurs and curse words shown as ***'}
          </Text>
        </View>
        <View style={[
          styles.toggleTrack,
          (user as any)?.censor_offensive_language !== false && styles.toggleTrackOn,
        ]}>
          <View style={[
            styles.toggleThumb,
            (user as any)?.censor_offensive_language !== false && styles.toggleThumbOn,
          ]} />
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.acctRow}
        onPress={() => router.push('/blocked-users' as any)}
        activeOpacity={0.7}
      >
        <Text style={styles.acctRowText}>Blocked Users</Text>
        <Text style={styles.acctRowChev}>›</Text>
      </TouchableOpacity>

      {/* Feature suggestions — emails Richard directly. Moved from home tab. */}
      <TouchableOpacity
        style={styles.acctRow}
        onPress={() => Linking.openURL('mailto:rpzielenski@gmail.com?subject=Sacari%20Golf%20Feature%20Suggestion')}
        activeOpacity={0.7}
      >
        <Text style={styles.acctRowText}>Suggest a Feature</Text>
        <Text style={styles.acctRowChev}>›</Text>
      </TouchableOpacity>

      {/* Privacy policy — Apple expects an in-app link, not just the App
          Store Connect metadata field. Opens the hosted GitHub Pages doc. */}
      <TouchableOpacity
        style={styles.acctRow}
        onPress={() => Linking.openURL('https://rzielenski.github.io/sacari-privacy/')}
        activeOpacity={0.7}
      >
        <Text style={styles.acctRowText}>Privacy Policy</Text>
        <Text style={styles.acctRowChev}>›</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.acctRow} onPress={handleLogout} activeOpacity={0.7}>
        <Text style={[styles.acctRowText, { color: C.text }]}>Log Out</Text>
        <Text style={styles.acctRowChev}>›</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.acctRow, { borderColor: C.red + '55' }]}
        onPress={() => Alert.alert(
          'Delete Account',
          'This permanently deletes your account, all match history, finds, and any data we have on you. This cannot be undone.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete Forever', style: 'destructive', onPress: deleteAccount },
          ]
        )}
        activeOpacity={0.7}
      >
        <Text style={[styles.acctRowText, { color: C.red }]}>Delete Account</Text>
        <Text style={[styles.acctRowChev, { color: C.red }]}>›</Text>
      </TouchableOpacity>

      {/* Notifications Modal */}
      <Modal
        visible={notifVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setNotifVisible(false)}
      >
        <View style={styles.notifContainer}>
          <View style={styles.notifHeader}>
            <Text style={styles.notifTitle}>Notifications</Text>
            <TouchableOpacity onPress={() => setNotifVisible(false)} style={styles.notifClose}>
              <Text style={styles.notifCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          {loadingNotifs ? (
            <View style={styles.notifEmpty}>
              <ActivityIndicator color={C.gold} size="large" />
            </View>
          ) : notifications.length === 0 ? (
            <View style={styles.notifEmpty}>
              <Text style={styles.notifEmptyText}>All caught up!</Text>
              <Text style={styles.notifEmptySub}>No new notifications.</Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }}>
              {notifications.map((n, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.notifRow}
                  onPress={() => handleNotifPress(n)}
                  activeOpacity={n.type === 'match_result' || n.type === 'match_invite' ? 0.7 : 1}
                >
                  <Text style={styles.notifRowIcon}>{notifIcon(n.type)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.notifRowTitle, n.won === false && { color: C.red }, n.won === true && { color: C.green }]}>
                      {n.title}
                    </Text>
                    <Text style={styles.notifRowBody}>{n.body}</Text>
                    <Text style={styles.notifRowTime}>
                      {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </Text>
                  </View>
                  {(n.type === 'match_result' || n.type === 'match_invite') && (
                    <Text style={{ color: C.gold, fontSize: 16 }}>›</Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* Bio Modal */}
      <Modal
        visible={bioModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setBioModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.notifContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.notifHeader}>
            <TouchableOpacity onPress={() => setBioModalVisible(false)}>
              <Text style={{ color: C.textMuted, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.notifTitle}>Edit Bio</Text>
            <TouchableOpacity onPress={saveBio} disabled={savingBio} style={styles.notifClose}>
              {savingBio
                ? <ActivityIndicator color="#000" size="small" />
                : <Text style={styles.notifCloseText}>Save</Text>}
            </TouchableOpacity>
          </View>
          <View style={{ padding: 20 }}>
            <Text style={{ color: C.textMuted, fontSize: 12, marginBottom: 8 }}>
              {bioInput.length}/280
            </Text>
            <TextInput
              style={styles.bioInput}
              value={bioInput}
              onChangeText={(t) => setBioInput(t.slice(0, 280))}
              placeholder="Tell other golfers about yourself..."
              placeholderTextColor={C.textMuted}
              multiline
              autoFocus
              maxLength={280}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Home Course Modal */}
      <Modal
        visible={homeCourseModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHomeCourseModalVisible(false)}
      >
        <View style={styles.notifContainer}>
          <View style={styles.notifHeader}>
            <TouchableOpacity onPress={() => setHomeCourseModalVisible(false)}>
              <Text style={{ color: C.textMuted, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.notifTitle}>Home Course</Text>
            <View style={{ width: 60 }} />
          </View>
          <View style={{ padding: 20, paddingBottom: 0 }}>
            <TextInput
              style={styles.searchInputProf}
              value={homeCourseQuery}
              onChangeText={searchHomeCourses}
              placeholder="Search course, club, city..."
              placeholderTextColor={C.textMuted}
              autoFocus
              autoCorrect={false}
            />
            {(user as any)?.home_course_id && (
              <TouchableOpacity
                onPress={() => setHomeCourse(null)}
                style={{ paddingVertical: 10, alignItems: 'center' }}
              >
                <Text style={{ color: C.red, fontSize: 13 }}>Clear current home course</Text>
              </TouchableOpacity>
            )}
          </View>
          {searchingHomeCourse && <ActivityIndicator color={C.gold} style={{ marginTop: 16 }} />}
          <FlatList
            data={homeCourseResults}
            keyExtractor={(c) => c.course_id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.searchResRow} onPress={() => setHomeCourse(item)}>
                <Text style={styles.searchResName}>{item.course_name}</Text>
                <Text style={styles.searchResLoc}>
                  {[item.city, item.state].filter(Boolean).join(', ')}
                </Text>
              </TouchableOpacity>
            )}
            ListFooterComponent={
              <TouchableOpacity
                style={{ paddingVertical: 18, alignItems: 'center' }}
                onPress={() => {
                  setHomeCourseModalVisible(false);
                  // Tiny delay so the sheet has time to dismiss before the next
                  // route push (otherwise the navigation can drop on iOS).
                  setTimeout(() => router.push('/course-request' as any), 250);
                }}
              >
                <Text style={{ color: C.gold, fontSize: 13, fontWeight: '700' }}>
                  Don&apos;t see your course? Request it →
                </Text>
              </TouchableOpacity>
            }
          />
        </View>
      </Modal>

      {/* Scorecard Modal */}
      <ScorecardModal
        visible={!!scorecardEntry}
        entry={scorecardEntry}
        onClose={() => setScorecardEntry(null)}
      />

      {/* Handicap breakdown modal */}
      <Modal
        visible={hcapModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHcapModalVisible(false)}
      >
        <View style={styles.notifContainer}>
          <View style={styles.notifHeader}>
            <View style={{ width: 60 }} />
            <Text style={styles.notifTitle}>Handicap Index</Text>
            <TouchableOpacity onPress={() => setHcapModalVisible(false)} style={styles.notifClose}>
              <Text style={styles.notifCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <View style={styles.hcapHero}>
              <Text style={styles.hcapBigNum}>
                {fmtHandicap(handicap?.handicap_index ?? null)}
              </Text>
              <Text style={styles.hcapBigLabel}>
                {handicap?.num_rounds_used
                  ? `Best ${handicap.num_rounds_used} of last ${handicap.total_rated_rounds} rounds`
                  : 'Play 3+ rated rounds for an index'}
              </Text>
            </View>
            <Text style={styles.hcapExplain}>
              World Handicap System: differential = (113 / slope) × (gross − course rating).
              Your index is the average of your best differentials.
            </Text>
            <Text style={styles.profSectionTitle}>RATED ROUNDS</Text>
            {hcapDifferentials.length === 0 ? (
              <Text style={{ color: C.textMuted, fontSize: 13 }}>
                No rated rounds yet. Play a course with rating + slope data.
              </Text>
            ) : (
              hcapDifferentials.map((d) => (
                <View key={d.round_id} style={styles.hcapRow}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ color: C.text, fontWeight: '700', fontSize: 13 }}>
                        {d.course_name ?? 'Unknown'}
                      </Text>
                      {d.is_nine_hole && (
                        <View style={{ backgroundColor: C.gold + '33', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 }}>
                          <Text style={{ color: C.gold, fontSize: 9, fontWeight: '800' }}>9H</Text>
                        </View>
                      )}
                    </View>
                    <Text style={{ color: C.textMuted, fontSize: 11 }}>
                      {d.teebox_name} · {d.holes_played} holes · CR {d.course_rating_used} / SL {d.slope_used} · {new Date(d.created_at).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{d.total_score}</Text>
                    <Text style={{ color: C.gold, fontSize: 12, fontFamily: F.serif }}>
                      {d.differential > 0 ? `+${d.differential}` : d.differential}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Personal theme picker — iTunes search or voice memo */}
      <ThemeSongPicker
        visible={themePickerVisible}
        onClose={() => setThemePickerVisible(false)}
        onPick={setUserTheme}
        onPickVoice={refreshUser}
      />

      {/* Manual handicap edit modal — moved from home tab. Validates the
          USGA 0–54 range and writes to users.handicap_index via PATCH. */}
      <Modal
        visible={manualHcapModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setManualHcapModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.manualHcapContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.manualHcapHeader}>
            <TouchableOpacity onPress={() => setManualHcapModal(false)}>
              <Text style={styles.manualHcapCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.manualHcapTitle}>Starting Handicap</Text>
            <TouchableOpacity onPress={async () => {
              // "Plus handicap" parsing: a player better than scratch enters
              // their index with a leading "+" (e.g. "+2.4"). USGA stores
              // these as NEGATIVE numbers (-2.4), so we flip the sign on
              // any explicit "+" prefix before sending to the server.
              const raw = manualHcapInput.trim();
              let val: number | null;
              if (raw === '') {
                val = null;
              } else if (raw.startsWith('+')) {
                val = -parseFloat(raw.slice(1));
              } else {
                val = parseFloat(raw);
              }
              if (val !== null && (isNaN(val) || val < -10 || val > 54)) {
                Alert.alert('Invalid', 'Enter a handicap between +10 and 54. Plus handicaps use a leading "+", e.g. "+2.4".');
                return;
              }
              try {
                await api.users.update({ handicapIndex: val });
                await refreshUser();
                setManualHcapModal(false);
              } catch (e: any) { Alert.alert('Error', e.message); }
            }}>
              <Text style={styles.manualHcapSave}>Save</Text>
            </TouchableOpacity>
          </View>
          <View style={{ padding: 20 }}>
            <Text style={styles.manualHcapDesc}>
              Your USGA/WHS handicap index. Drives the strokes-gained
              baseline until you've played 3+ rated rounds for the auto-calc
              to take over. Better than scratch? Enter a plus handicap as
              "+2.4". Leave blank to clear.
            </Text>
            <TextInput
              style={styles.manualHcapInput}
              value={manualHcapInput}
              onChangeText={setManualHcapInput}
              placeholder="e.g. 14.2 or +2.4"
              placeholderTextColor={C.textMuted}
              // numbers-and-punctuation includes "+", which decimal-pad
              // doesn't. Required so a player can enter "+2.4" without
              // having to switch keyboards.
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
    </View>
  );
}

function SGCell({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  // Format with explicit sign + 1 decimal. Color reflects sign: green = saving
  // strokes vs scratch baseline, red = losing them.
  const sign = value > 0 ? '+' : '';
  const color = value > 0 ? C.green : value < 0 ? C.red : C.textMuted;
  return (
    <View style={[
      stylesSG.cell,
      highlight && { borderColor: C.gold },
    ]}>
      <Text style={stylesSG.label}>{label.toUpperCase()}</Text>
      <Text style={[stylesSG.value, { color }]}>{sign}{value.toFixed(1)}</Text>
    </View>
  );
}
const stylesSG = StyleSheet.create({
  cell: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    backgroundColor: C.card, borderRadius: 6, borderWidth: 1, borderColor: C.border,
  },
  label: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  value: { fontSize: 18, fontWeight: '900', marginTop: 2, fontFamily: F.serif },
});

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** One navigation row in the profile menu. All destination rows share
 *  this so the COMPETE / STYLE / ACCOUNT sections read as one system. */
function MenuRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.inviteBtn} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.inviteBtnLabel}>{label}</Text>
      <Text style={styles.statsBtnArrow}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  statsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '88',
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 6,
    marginTop: 4, marginBottom: 12,
  },
  statsBtnLabel: { color: C.gold, fontWeight: '800', fontSize: 13, letterSpacing: 0.6 },
  statsBtnArrow: { color: C.gold, fontSize: 22 },
  // ── My Teams ───────────────────────────────────────────────────────────
  sectionHeader: {
    color: C.gold, fontSize: 11, fontWeight: '900',
    letterSpacing: 1.4, marginTop: 14, marginBottom: 8,
  },
  // Extra breathing room above the COMPETE / STYLE / ACCOUNT menu groups
  // so each section reads as its own block in the long profile scroll.
  menuHeader: { marginTop: 22 },
  teamsEmpty: {
    color: C.textMuted, fontSize: 12, fontStyle: 'italic',
    marginBottom: 12, lineHeight: 17,
  },
  // Header row above the team list with a Browse / +New affordance so
  // joining/creating is one tap from the profile.
  teamsHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, marginBottom: 8,
  },
  browseBtn: {
    backgroundColor: C.gold + '22', borderColor: C.gold, borderWidth: 1,
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5,
  },
  browseBtnText: { color: C.gold, fontWeight: '900', fontSize: 10, letterSpacing: 0.8 },
  // Empty-state CTA card — big, gold-bordered, unmissable. Replaces the
  // single italic line that was easy to skim past.
  teamsEmptyCta: {
    backgroundColor: C.gold + '11',
    borderColor: C.gold, borderWidth: 1,
    borderRadius: 10, padding: 14, marginBottom: 12,
    gap: 4,
  },
  teamsEmptyCtaTitle: { color: C.gold, fontSize: 14, fontWeight: '900' },
  teamsEmptyCtaBody:  { color: C.text, fontSize: 12, lineHeight: 17 },
  teamsEmptyCtaArrow: { color: C.gold, fontSize: 12, fontWeight: '800', marginTop: 4 },
  teamRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 6,
  },
  teamIcon: {
    width: 36, height: 36, borderRadius: 4,
    backgroundColor: C.gold + '22',
    alignItems: 'center', justifyContent: 'center',
  },
  teamIconText: { color: C.gold, fontWeight: '900', fontSize: 15 },
  teamName: { color: C.text, fontSize: 14, fontWeight: '700' },
  teamMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  premiumBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 6,
    marginTop: 0, marginBottom: 16,
  },
  premiumBtnLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },

  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '88',
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 6,
    marginBottom: 16,
  },
  inviteBtnLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },

  themeBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 10, marginBottom: 16,
  },
  themeBtnArt: { width: 48, height: 48, borderRadius: 4 },
  themeBtnLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  themeBtnTitle: { color: C.text, fontWeight: '700', fontSize: 14, marginTop: 2 },
  themeBtnArtist: { color: C.textMuted, fontSize: 12, marginTop: 1 },
  premiumPill: {
    backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3,
  },
  premiumPillText: { color: C.gold, fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },

  bellBtn: {
    position: 'absolute', top: 60, right: 20, zIndex: 10,
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 1, borderColor: C.gold + '88',
    backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center',
  },
  bellWrap: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  bellGlyph: {
    fontSize: 22, color: C.gold,
    // Aged, slightly desaturated tone via subtle shadow
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  crackSeg: {
    position: 'absolute', height: 1.5, backgroundColor: '#1a0a08',
    borderRadius: 0.5,
  },
  chipNotch: {
    position: 'absolute', bottom: 4, left: 8, width: 4, height: 3,
    backgroundColor: C.bg, borderTopLeftRadius: 2, borderTopRightRadius: 2,
    transform: [{ rotate: '12deg' }],
  },
  bellBadge: {
    position: 'absolute', top: 0, right: 0,
    backgroundColor: C.red, borderRadius: 8,
    minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 3,
  },
  bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '900' },

  avatarSection: { alignItems: 'center', marginBottom: 28, marginTop: 8 },
  avatar: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 3, marginBottom: 12,
    overflow: 'hidden',
  },
  avatarImage: { width: 96, height: 96, borderRadius: 48 },
  avatarText: { fontSize: 40, color: C.gold, fontWeight: '900' },
  avatarLoader: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetterBg: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    alignItems: 'center', justifyContent: 'center',
  },
  // Edit pencil sits at the bottom-right of the avatar (inside the crest
  // ring), not the bottom-right of the wider crest footprint. Inset math
  // for size=96 with the heraldic 1.5× container (144×144):
  //   • horizontal inset = (144 − 96) / 2 = 24
  //   • vertical inset = (144 − 96) / 2 + verticalBias(≈6) ≈ 18  (avatar
  //     is biased down inside the container to leave room for the crown)
  avatarEditBadge: {
    position: 'absolute', bottom: 18, right: 24,
    backgroundColor: C.gold, width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: C.bg,
  },
  username: { color: C.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
  usernameSubRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 6, marginBottom: 4,
  },
  editUsernameBtn: { borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: C.gold + '88' },
  editUsernameBtnText: { color: C.gold, fontSize: 11, fontWeight: '700' },
  email: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 5, marginTop: 10 },
  rankLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  followRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 14, marginBottom: 4, gap: 8,
  },
  followCol: { alignItems: 'center', paddingHorizontal: 18, paddingVertical: 6 },
  followNum: { color: C.text, fontSize: 18, fontWeight: '900', fontFamily: F.serif },
  followLabel: { color: C.textMuted, fontSize: 11, marginTop: 1, letterSpacing: 0.5 },
  followDivider: { width: 1, height: 30, backgroundColor: C.border },
  openBetaNote: {
    color: C.gold, fontSize: 10, marginTop: 10, textAlign: 'center',
    paddingHorizontal: 24, lineHeight: 14, fontStyle: 'italic', opacity: 0.85,
  },

  card: { backgroundColor: C.card, borderRadius: 16, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: C.border, gap: 10 },

  editableCard: {
    backgroundColor: C.card, borderRadius: 12, padding: 14,
    flexDirection: 'row', alignItems: 'center', marginBottom: 10,
    borderWidth: 1, borderColor: C.border,
  },
  editableLabel: { color: C.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 4 },
  editableValue: { color: C.text, fontSize: 14, fontWeight: '600' },
  editableSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  editChev: { color: C.textDim, fontSize: 22, marginLeft: 8 },

  // Two explicit rows, each with `flex: 1` cards. This is the only RN
  // layout pattern that guarantees pixel-perfect 50/50 splits on every
  // device width — flexBasis + flexWrap can leave sub-percentage gaps
  // on phones where the math doesn't round cleanly.
  miniRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  miniCard: {
    flex: 1,                       // each card takes exactly half the row
    backgroundColor: C.card,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: C.border,
    minHeight: 64,
    justifyContent: 'center',
  },
  miniLabel: { color: C.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  miniValue: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 4 },

  // Drinks-drunk stepper: − [count] + laid out across the tile.
  drinksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  drinksBtn: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: C.gold + '22',
    borderWidth: 1, borderColor: C.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  drinksBtnDisabled: { opacity: 0.35 },
  drinksBtnText: { color: C.gold, fontSize: 18, fontWeight: '900', lineHeight: 20 },
  drinksValue: { color: C.text, fontSize: 20, fontWeight: '800', minWidth: 32, textAlign: 'center' },

  // Range Session CTA — wrapped in GlowCard which handles the pulsing
  // border + halo glow itself. We only set inner layout here (padding,
  // flex direction, gap). Background tint is a light gold wash applied
  // INSIDE the GlowCard's border layers so the surface still reads as
  // gold-tinted at rest.
  rangeCta: {
    backgroundColor: C.gold + '11',
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 10,
  },
  rangeCtaIcon: {
    width: 42, height: 42, borderRadius: 8,
    backgroundColor: C.gold + '33',
    borderWidth: 1, borderColor: C.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  rangeCtaIconText: { color: C.gold, fontSize: 22, fontWeight: '900' },
  rangeCtaLabel: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.4, marginBottom: 3 },
  rangeCtaBody: { color: C.text, fontSize: 12, lineHeight: 16 },
  rangeCtaChev: { color: C.gold, fontSize: 24, fontWeight: '700' },

  bioInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    padding: 14, fontSize: 15, borderWidth: 1, borderColor: C.border,
    minHeight: 120, textAlignVertical: 'top',
  },
  searchInputProf: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  searchResRow: {
    backgroundColor: C.card, borderRadius: 8, padding: 14,
    marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  searchResName: { color: C.text, fontWeight: '700', fontSize: 15 },
  searchResLoc: { color: C.gold, fontSize: 12, marginTop: 3 },

  profSectionTitle: {
    color: C.textMuted, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.5, marginBottom: 8, marginTop: 16,
  },
  roundCard: {
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  roundCourseName: { color: C.text, fontWeight: '700', fontSize: 14 },
  roundMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  roundDate: { color: C.textDim, fontSize: 11, marginTop: 4 },
  roundScoreBox: { alignItems: 'flex-end', minWidth: 50 },
  roundScore: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '700' },
  roundToPar: { fontSize: 12, fontWeight: '700', marginTop: 1 },

  hcapHero: { alignItems: 'center', paddingVertical: 24, marginBottom: 8 },
  hcapBigNum: { fontFamily: F.serif, fontSize: 64, fontWeight: '700', color: C.gold },
  hcapBigLabel: { color: C.textMuted, fontSize: 13, marginTop: 6 },
  hcapExplain: { color: C.textDim, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  hcapRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  cardRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  eloHeaderRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  rankNameBig: { fontSize: 26, fontWeight: '900', letterSpacing: 0.3 },
  eloNum: { fontSize: 40, fontWeight: '900', color: C.gold },
  eloLabel: { fontSize: 14, color: C.textMuted },
  progressText: { color: C.textMuted, fontSize: 11, marginTop: 4 },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  perfGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  sgSubtitle: { color: C.textDim, fontSize: 10, letterSpacing: 1, fontWeight: '700', marginTop: 4, marginBottom: 6 },
  sgRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  statBox: {
    flex: 1, minWidth: '45%', backgroundColor: C.card, borderRadius: 14,
    padding: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  statValue: { fontSize: 26, fontWeight: '900', color: C.text },
  statLabel: { color: C.textMuted, fontSize: 12, marginTop: 4 },

  joinedText: { color: C.textMuted, textAlign: 'center', fontSize: 13, marginBottom: 24 },
  logoutBtn: { borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.red + '66' },
  logoutText: { color: C.red, fontWeight: '700', fontSize: 15 },
  acctRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderRadius: 8,
    paddingVertical: 14, paddingHorizontal: 16,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  acctRowText: { color: C.text, fontWeight: '600', fontSize: 14 },
  acctRowChev: { color: C.textDim, fontSize: 18 },
  // iOS-style switch track + thumb. Custom rather than RN <Switch> so the
  // colors match the gold/dark theme without per-platform fiddling.
  toggleTrack: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: C.cardAlt,
    borderWidth: 1, borderColor: C.border,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  toggleTrackOn: { backgroundColor: C.gold + '88', borderColor: C.gold },
  toggleThumb: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: C.textMuted,
  },
  toggleThumbOn: { backgroundColor: C.gold, transform: [{ translateX: 18 }] },

  // Notifications modal
  notifContainer: { flex: 1, backgroundColor: C.bg },
  notifHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  notifTitle: { color: C.text, fontSize: 20, fontWeight: '900' },
  notifClose: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  notifCloseText: { color: '#000', fontWeight: '800', fontSize: 14 },
  notifEmpty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  notifEmptyText: { color: C.text, fontSize: 18, fontWeight: '700' },
  notifEmptySub: { color: C.textMuted, fontSize: 14 },
  notifRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: C.border + '55',
  },
  notifRowIcon: { fontSize: 24 },
  notifRowTitle: { color: C.text, fontWeight: '700', fontSize: 14, marginBottom: 2 },
  notifRowBody: { color: C.textMuted, fontSize: 13 },
  notifRowTime: { color: C.textDim, fontSize: 11, marginTop: 3 },

  // Manual-handicap edit modal — moved from home tab.
  manualHcapContainer: { flex: 1, backgroundColor: C.bg },
  manualHcapHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  manualHcapTitle: { color: C.text, fontWeight: '900', fontSize: 16 },
  manualHcapCancel: { color: C.textMuted, fontSize: 14 },
  manualHcapSave: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
  manualHcapDesc: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  manualHcapInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 24, fontWeight: '800',
    borderWidth: 1, borderColor: C.border, textAlign: 'center',
  },
});
