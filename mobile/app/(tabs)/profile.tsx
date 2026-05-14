import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  Image, Modal, ActivityIndicator, TextInput, FlatList, Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../lib/auth';
import { api, API_BASE } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { router } from 'expo-router';
import { isPremium } from '../../lib/premium';
import { ThemeSongPicker, ThemeTrack } from '../../components/ThemeSongPicker';
import type { Course } from '../../types';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { OrnamentTitle, Divider } from '../../components/Flourish';

function EloRank(elo: number): { label: string; color: string; next: number } {
  if (elo >= 2000) return { label: 'Diamond', color: '#a8d8f0', next: 9999 };
  if (elo >= 1800) return { label: 'Platinum', color: '#c0c0d0', next: 2000 };
  if (elo >= 1600) return { label: 'Gold', color: C.gold, next: 1800 };
  if (elo >= 1400) return { label: 'Silver', color: '#c0c0c0', next: 1600 };
  return { label: 'Bronze', color: '#cd7f32', next: 1400 };
}

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

  // Load notification count badge — must be before any early return
  useEffect(() => {
    if (!user) return;
    api.users.notifications()
      .then((res) => setNotifCount(res.unread_count ?? 0))
      .catch(() => { });
  }, [user?.user_id]);

  // Load recent rounds + best round (rich profile data)
  useEffect(() => {
    if (!user) return;
    api.users.get(user.user_id)
      .then((data) => {
        setRecentRounds(data.recent_rounds ?? []);
        setBestRound(data.best_round ?? null);
      })
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
    // Persist "seen" state on the server so the badge stays cleared across reloads.
    // BUT — chat unreads aren't cleared by the bell tap; they only drop when the
    // user opens the chat itself. So we re-fetch right after marking seen to
    // pull back any chat-driven unread count.
    api.users.markNotificationsSeen().catch(() => { });
    try {
      const res = await api.users.notifications();
      setNotifications(res.notifications ?? []);
      setNotifCount(res.chat_unread_count ?? 0);
    } catch {
      setNotifCount(0);
    } finally {
      setLoadingNotifs(false);
    }
  }, []);

  if (!user) return null;

  const rank = EloRank(user.elo);
  const winRate = user.total_matches > 0
    ? Math.round((user.total_wins / user.total_matches) * 100)
    : 0;

  const rankBase = rank.label === 'Bronze' ? 1000 : rank.label === 'Silver' ? 1400 : rank.label === 'Gold' ? 1600 : rank.label === 'Platinum' ? 1800 : 2000;
  const rankProgress = rank.next < 9999 ? user.elo - rankBase : 0;
  const rankTotal = rank.next < 9999 ? rank.next - rankBase : 1;

  const handleLogout = () => {
    Alert.alert('Log out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: logout },
    ]);
  };

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
    }
    // friend_request and clan_invite handled in social tab
  };

  const notifIcon = (type: string) => {
    if (type === 'friend_request') return 'FR';
    if (type === 'match_invite') return 'MA';
    if (type === 'clan_invite') return 'CL';
    if (type === 'match_result') return 'RS';
    return '·';
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
          style={[styles.avatar, { borderColor: rank.color }]}
          onPress={changeAvatar}
          disabled={uploadingAvatar}
          activeOpacity={0.8}
        >
          {uploadingAvatar ? (
            <ActivityIndicator color={C.gold} />
          ) : user.avatar_url ? (
            <Image
              source={{ uri: `${API_BASE}${user.avatar_url}` }}
              style={styles.avatarImage}
            />
          ) : (
            <Text style={styles.avatarText}>{user.username?.[0]?.toUpperCase() ?? '?'}</Text>
          )}
          <View style={styles.avatarEditBadge}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>✎</Text>
          </View>
        </TouchableOpacity>
        <Text style={styles.username}>{user.username}</Text>
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
        {/* Open-beta note — small enough not to compete with the rank badge.
            Shown only while is_premium = true via the server-side OPEN_BETA
            override (premium_plan === 'open_beta'). Disappears automatically
            once we flip the flag off in backend/src/utils/openBeta.ts. */}
        {(user as any)?.premium_plan === 'open_beta' && (
          <Text style={styles.openBetaNote}>
            ★ Premium is free for everyone while we collect course data — thanks for testing.
          </Text>
        )}
      </View>

      {/* Bio */}
      <TouchableOpacity style={styles.editableCard} onPress={openBioModal}>
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>BIO</Text>
          <Text style={styles.editableValue}>
            {(user as any)?.bio || 'Tap to add a short bio'}
          </Text>
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* Home Course */}
      <TouchableOpacity style={styles.editableCard} onPress={() => setHomeCourseModalVisible(true)}>
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>HOME COURSE</Text>
          <Text style={styles.editableValue}>
            {(user as any)?.home_course_name || 'Tap to set your home course'}
          </Text>
          {(user as any)?.home_course_city && (
            <Text style={styles.editableSub}>
              {[(user as any).home_course_city, (user as any).home_course_state].filter(Boolean).join(', ')}
            </Text>
          )}
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* Calculated Handicap */}
      <TouchableOpacity style={styles.editableCard} onPress={() => setHcapModalVisible(true)}>
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>HANDICAP INDEX</Text>
          <Text style={styles.editableValue}>
            {handicap?.handicap_index != null
              ? handicap.handicap_index.toFixed(1)
              : 'Need 3+ rated rounds'}
          </Text>
          <Text style={styles.editableSub}>
            {handicap?.num_rounds_used
              ? `Best ${handicap.num_rounds_used} of last ${handicap.total_rated_rounds} rounds · Tap for breakdown`
              : `${handicap?.total_rated_rounds ?? 0} rated rounds played`}
          </Text>
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* Manual handicap override — drives the SG baseline before the user
          has enough rated rounds for the WHS auto-calc to populate the
          column. Moved from the home tab during the home/feed restructure. */}
      <TouchableOpacity
        style={styles.editableCard}
        onPress={() => { setManualHcapInput(user.handicap_index?.toString() ?? ''); setManualHcapModal(true); }}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>STARTING HANDICAP</Text>
          <Text style={styles.editableValue}>
            {user.handicap_index != null ? user.handicap_index.toFixed(1) : 'Set'}
          </Text>
          <Text style={styles.editableSub}>
            Manual baseline used for strokes-gained until you've played enough rated rounds
          </Text>
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* My Bag — the in-round club picker and auto-suggest both filter to
          this subset on every shot, so it's worth keeping current. Moved
          from the home tab during the home/feed restructure. */}
      <TouchableOpacity style={styles.editableCard} onPress={() => router.push('/bag' as any)}>
        <View style={{ flex: 1 }}>
          <Text style={styles.editableLabel}>MY BAG</Text>
          <Text style={styles.editableValue}>
            {Array.isArray((user as any).clubs_in_bag) && (user as any).clubs_in_bag.length > 0
              ? `${(user as any).clubs_in_bag.length} club${(user as any).clubs_in_bag.length === 1 ? '' : 's'}`
              : 'Edit'}
          </Text>
          <Text style={styles.editableSub}>
            Pick which clubs you actually carry — drives the picker and auto-suggest
          </Text>
        </View>
        <Text style={styles.editChev}>›</Text>
      </TouchableOpacity>

      {/* ELO Progress */}
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={styles.eloNum}>{user.elo}</Text>
          <Text style={styles.eloLabel}>ELO</Text>
        </View>
        {rank.next < 9999 && (
          <>
            <ProgressBar value={rankProgress} max={rankTotal} color={rank.color} />
            <Text style={styles.progressText}>{user.elo} / {rank.next} → next rank</Text>
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

      {/* Premium upgrade entry point */}
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

      {/* Best Round */}
      {bestRound && (
        <>
          <OrnamentTitle title="Best Round" />

          <TouchableOpacity
            style={[styles.roundCard, { borderColor: C.gold }]}
            onPress={() => bestRound.hole_scores?.length
              ? openScorecard(bestRound)
              : bestRound.course_id && router.push(`/course/${bestRound.course_id}` as any)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.roundCourseName}>{bestRound.course_name ?? 'Unknown course'}</Text>
              <Text style={styles.roundMeta}>
                {bestRound.teebox_name} · {bestRound.num_holes} holes · Par {bestRound.teebox_par}
              </Text>
              <Text style={styles.roundDate}>
                {new Date(bestRound.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.roundScoreBox}>
              <Text style={[styles.roundScore, { color: C.gold }]}>{bestRound.total_score}</Text>
              <Text style={[styles.roundToPar, { color: bestRound.to_par <= 0 ? C.green : C.red }]}>
                {bestRound.to_par > 0 ? `+${bestRound.to_par}` : bestRound.to_par === 0 ? 'E' : bestRound.to_par}
              </Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {/* Recent Rounds */}
      {recentRounds.length > 0 && (
        <>
          <OrnamentTitle title="Recent Rounds" />

          {recentRounds.map((r: any) => (
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
                  {r.teebox_name ?? '—'} · {r.num_holes ?? r.hole_scores?.length ?? '?'} holes
                  {r.format === 'scramble' ? ' · Scramble' : ''}
                </Text>
                <Text style={styles.roundDate}>
                  {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <View style={styles.roundScoreBox}>
                <Text style={styles.roundScore}>{r.total_score}</Text>
                {r.teebox_par != null && (
                  <Text style={[styles.roundToPar, {
                    color: r.total_score - r.teebox_par < 0 ? C.green :
                           r.total_score - r.teebox_par > 0 ? C.red : C.text,
                  }]}>
                    {r.total_score - r.teebox_par > 0 ? `+${r.total_score - r.teebox_par}` :
                     r.total_score - r.teebox_par === 0 ? 'E' : r.total_score - r.teebox_par}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
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
        <View style={styles.notifContainer}>
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
        </View>
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
            contentContainerStyle={{ padding: 20 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.searchResRow} onPress={() => setHomeCourse(item)}>
                <Text style={styles.searchResName}>{item.course_name}</Text>
                <Text style={styles.searchResLoc}>
                  {[item.city, item.state].filter(Boolean).join(', ')}
                </Text>
              </TouchableOpacity>
            )}
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
                {handicap?.handicap_index != null ? handicap.handicap_index.toFixed(1) : '—'}
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

      {/* Personal theme picker — iTunes search */}
      <ThemeSongPicker
        visible={themePickerVisible}
        onClose={() => setThemePickerVisible(false)}
        onPick={setUserTheme}
      />

      {/* Manual handicap edit modal — moved from home tab. Validates the
          USGA 0–54 range and writes to users.handicap_index via PATCH. */}
      <Modal
        visible={manualHcapModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setManualHcapModal(false)}
      >
        <View style={styles.manualHcapContainer}>
          <View style={styles.manualHcapHeader}>
            <TouchableOpacity onPress={() => setManualHcapModal(false)}>
              <Text style={styles.manualHcapCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.manualHcapTitle}>Starting Handicap</Text>
            <TouchableOpacity onPress={async () => {
              const val = manualHcapInput.trim() === '' ? null : parseFloat(manualHcapInput);
              if (val !== null && (isNaN(val) || val < 0 || val > 54)) {
                Alert.alert('Invalid', 'Enter a number between 0 and 54.');
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
              Your USGA/WHS handicap index (0–54). Drives the strokes-gained
              baseline until you've played 3+ rated rounds for the auto-calc
              to take over. Leave blank to clear.
            </Text>
            <TextInput
              style={styles.manualHcapInput}
              value={manualHcapInput}
              onChangeText={setManualHcapInput}
              placeholder="e.g. 14.2"
              placeholderTextColor={C.textMuted}
              keyboardType="decimal-pad"
              maxLength={5}
            />
          </View>
        </View>
      </Modal>
    </ScrollView>
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
  premiumBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 6,
    marginTop: 0, marginBottom: 16,
  },
  premiumBtnLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },

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
  avatarEditBadge: {
    position: 'absolute', bottom: 0, right: 0,
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
  eloNum: { fontSize: 44, fontWeight: '900', color: C.gold },
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
