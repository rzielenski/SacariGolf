import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  Image, Modal, ActivityIndicator, TextInput, FlatList,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../lib/auth';
import { api, API_BASE } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { router } from 'expo-router';
import type { Course } from '../../types';
import { ScorecardModal, ScorecardEntry } from '../../components/Scorecard';

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
  track: { height: 6, backgroundColor: '#2a3a2a', borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});

export default function ProfileScreen() {
  const { user, logout, refreshUser } = useAuth();
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
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);
  const [handicap, setHandicap] = useState<{ handicap_index: number | null; num_rounds_used: number; total_rated_rounds: number } | null>(null);
  const [hcapModalVisible, setHcapModalVisible] = useState(false);
  const [hcapDifferentials, setHcapDifferentials] = useState<any[]>([]);

  const openScorecard = (round: any) => {
    if (!user) return;
    setScorecardEntry({
      username: user.username,
      user_id: user.user_id,
      teebox_name: round.teebox_name,
      hole_scores: round.hole_scores,
      course_id: round.course_id,
      course_name: round.course_name,
      teebox_id: round.teebox_id,
      total_score: round.total_score,
      created_at: round.created_at,
      teebox_par: round.teebox_par,
    });
  };

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
    // Persist "seen" state on the server so the badge stays cleared across reloads
    api.users.markNotificationsSeen().catch(() => { });
    setNotifCount(0);
    try {
      const res = await api.users.notifications();
      setNotifications(res.notifications ?? []);
    } catch { /* silent */ } finally {
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
    if (type === 'friend_request') return '👤';
    if (type === 'match_invite') return '⛳';
    if (type === 'clan_invite') return '🏆';
    if (type === 'match_result') return '🏅';
    return '🔔';
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Bell */}
      <TouchableOpacity style={styles.bellBtn} onPress={openNotifications}>
        <Text style={styles.bellIcon}>🔔</Text>
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
            <Text style={styles.avatarText}>{user.username[0].toUpperCase()}</Text>
          )}
          <View style={styles.avatarEditBadge}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>✎</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.usernameRow}>
          <Text style={styles.username}>{user.username}</Text>
          <TouchableOpacity onPress={changeUsername} style={styles.editUsernameBtn}>
            <Text style={styles.editUsernameBtnText}>Edit</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.email}>{user.email}</Text>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rank.label}</Text>
        </View>
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

      {/* Best Round */}
      {bestRound && (
        <>
          <Text style={styles.profSectionTitle}>BEST ROUND</Text>
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
          <Text style={styles.profSectionTitle}>RECENT ROUNDS</Text>
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

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
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
    </ScrollView>
  );
}

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

  bellBtn: {
    position: 'absolute', top: 60, right: 20, zIndex: 10,
    width: 40, height: 40, justifyContent: 'center', alignItems: 'center',
  },
  bellIcon: { fontSize: 22 },
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
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  username: { color: C.text, fontSize: 24, fontWeight: '900' },
  editUsernameBtn: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.gold + '88' },
  editUsernameBtnText: { color: C.gold, fontSize: 11, fontWeight: '700' },
  email: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 5, marginTop: 10 },
  rankLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

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
  statBox: {
    flex: 1, minWidth: '45%', backgroundColor: C.card, borderRadius: 14,
    padding: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  statValue: { fontSize: 26, fontWeight: '900', color: C.text },
  statLabel: { color: C.textMuted, fontSize: 12, marginTop: 4 },

  joinedText: { color: C.textMuted, textAlign: 'center', fontSize: 13, marginBottom: 24 },
  logoutBtn: { borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.red + '66' },
  logoutText: { color: C.red, fontWeight: '700', fontSize: 15 },

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
});
