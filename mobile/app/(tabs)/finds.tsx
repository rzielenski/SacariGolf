import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView,
  Alert, ActivityIndicator, Animated, Dimensions, RefreshControl, Modal,
  PanResponder,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { compressForUpload } from '../../lib/imageUpload';
import { router } from 'expo-router';
import { api, API_BASE } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { useCensor } from '../../lib/censor';

const { width: W, height: H } = Dimensions.get('window');

type Tab = 'vote' | 'leaderboard' | 'mine';

export default function FindRankerScreen() {
  const [tab, setTab] = useState<Tab>('vote');
  const [selectedFind, setSelectedFind] = useState<any>(null);
  const { user, loading: authLoading } = useAuth();

  // Don't render any API-calling child until auth is confirmed
  if (authLoading) {
    return <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>;
  }
  if (!user) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>Not logged in</Text>
        <Text style={styles.emptySub}>Please log in to view finds.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FindViewer find={selectedFind} onClose={() => setSelectedFind(null)} />
      <View style={styles.header}>
        <View style={{ width: 60 }} />
        <View style={styles.titleBox}>
          <Text style={styles.title}>Find Ranker</Text>
          <Text style={styles.titleSub}>course discoveries, ranked</Text>
        </View>
        <UploadButton />
      </View>

      <View style={styles.tabRow}>
        {(['vote', 'leaderboard', 'mine'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'vote' ? 'Vote' : t === 'leaderboard' ? 'Top Finds' : 'Mine'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'vote' && <VoteTab />}
      {tab === 'leaderboard' && <LeaderboardTab onSelectFind={setSelectedFind} />}
      {tab === 'mine' && <MineTab userId={user?.user_id ?? ''} onSelectFind={setSelectedFind} />}
    </View>
  );
}

// ── Find image viewer (swipe down/up to dismiss) ────────────────────────────
function FindViewer({ find, onClose }: { find: any | null; onClose: () => void }) {
  const c = useCensor();
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  // Reset animation values whenever a new find is shown
  useEffect(() => {
    if (find) {
      translateY.setValue(0);
      opacity.setValue(1);
    }
  }, [find]);

  const dismiss = (direction: 1 | -1) => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: direction * H, duration: 220, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  const panResponder = useRef(
    PanResponder.create({
      // Claim the responder for any touch — this Modal has nothing scrollable
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderMove: (_, { dy }) => {
        translateY.setValue(dy);
        opacity.setValue(1 - Math.min(Math.abs(dy) / 400, 0.6));
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        if (Math.abs(dy) > 100 || Math.abs(vy) > 0.6) {
          dismiss(dy >= 0 ? 1 : -1);
        } else if (Math.abs(dy) < 6) {
          // Treat near-zero movement as a tap → dismiss
          dismiss(1);
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
            Animated.spring(opacity, { toValue: 1, useNativeDriver: true, friction: 8 }),
          ]).start();
        }
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  return (
    <Modal visible={!!find} transparent animationType="fade" onRequestClose={onClose}>
      <Animated.View
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', opacity }}
        {...panResponder.panHandlers}
      >
        <Animated.View
          pointerEvents="box-none"
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center', transform: [{ translateY }] }}
        >
          {/* Close button stays tappable above the pan layer */}
          <TouchableOpacity
            style={{ position: 'absolute', top: 56, right: 20, zIndex: 10, padding: 12 }}
            onPress={onClose}
          >
            <Text style={{ color: '#fff', fontSize: 28, fontWeight: '300' }}>✕</Text>
          </TouchableOpacity>
          {find && (
            <>
              {/* pointerEvents lives on the wrapper: RN's ImageStyle typing
                  rejects it as a style key and Image rejects it as a prop. */}
              <View pointerEvents="none" style={{ width: '100%', height: '70%' }}>
                <Image
                  source={{ uri: `${API_BASE}${find.photo_url}` }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="contain"
                />
              </View>
              {find.description ? <Text style={{ color: '#fff', fontSize: 14, marginTop: 16, paddingHorizontal: 24, textAlign: 'center' }} pointerEvents="none">{c(find.description)}</Text> : null}
              <Text style={{ color: C.gold, fontSize: 13, marginTop: 8 }} pointerEvents="none">by {c(find.username)}  ·  {find.elo} SR</Text>
              <Text style={{ color: '#888', fontSize: 11, marginTop: 18 }} pointerEvents="none">Swipe or tap anywhere to dismiss</Text>
            </>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ── Upload button ───────────────────────────────────────────────────────────
// One-time EULA acceptance for Finds. Required by Apple Guideline 1.2:
// users must agree to content rules before posting UGC. Lives in AsyncStorage
// so each device asks once and remembers forever (or until app reinstall).
const FINDS_EULA_KEY = 'sacari.finds.eula_v1';

async function ensureFindsEulaAccepted(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(FINDS_EULA_KEY);
    if (v === '1') return true;
  } catch { /* fall through and re-ask */ }
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      'Finds Community Rules',
      'By posting a Find you agree NOT to upload:\n\n' +
      '  • Nudity, sexual content, or violence\n' +
      '  • Hate speech, harassment, or threats\n' +
      '  • Illegal content or copyright violations\n' +
      '  • Personal information about other people\n\n' +
      'Reports are reviewed within 24 hours and abusive accounts are removed. ' +
      'You can report any Find from the ··· menu on the viewer.',
      [
        { text: "I don't agree", style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'I agree',
          onPress: async () => {
            try { await AsyncStorage.setItem(FINDS_EULA_KEY, '1'); } catch { /* non-fatal */ }
            resolve(true);
          },
        },
      ],
      { cancelable: false }
    );
  });
}

function UploadButton() {
  const [uploading, setUploading] = useState(false);

  const pick = async () => {
    // Gate: one-time community-rules acceptance.
    const accepted = await ensureFindsEulaAccepted();
    if (!accepted) return;

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to upload a find.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.45,
      base64: true,
      allowsEditing: true,
      aspect: [4, 3],
    });
    if (result.canceled || !result.assets[0]) return;
    const img = await compressForUpload(result.assets[0]);

    Alert.prompt(
      'Describe your find',
      'What did you discover? (optional)',
      async (description) => {
        setUploading(true);
        try {
          await api.finds.upload(
            img.base64,
            img.mime,
            description ?? ''
          );
          Alert.alert('Uploaded!', 'Your find is in the ranker.');
        } catch (e: any) {
          Alert.alert('Upload failed', e.message);
        } finally {
          setUploading(false);
        }
      },
      'plain-text',
      '',
    );
  };

  return (
    <TouchableOpacity style={styles.uploadBtn} onPress={pick} disabled={uploading}>
      {uploading
        ? <ActivityIndicator color={C.gold} size="small" />
        : <Text style={styles.uploadBtnText}>+ Find</Text>}
    </TouchableOpacity>
  );
}

// ── Vote tab ────────────────────────────────────────────────────────────────
function VoteTab() {
  const c = useCensor();
  const [pair, setPair] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [result, setResult] = useState<{ delta: number; winnerId: string } | null>(null);
  // True when every find currently in the pool has already been voted on
  // this session. Renders a dedicated "no more finds" empty state with a
  // "Start over" button rather than silently re-showing a stale matchup.
  const [exhausted, setExhausted] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const loadPair = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setExhausted(false);
    try {
      // Server tracks every matchup the user has been served (via the
      // find_pair_seen table) and only returns pairs they haven't seen
      // yet. We don't need to pass an exclude list anymore — pass empty.
      const p = await api.finds.pair([]);
      if (p.length < 2) {
        setPair([]);
        setExhausted(true);
        return;
      }
      setPair(p);
    } catch (e: any) {
      if (e.message === 'not_enough') {
        // No unseen matchups left for this user (or pool is too small).
        // Wait for new finds to be uploaded — they'll create fresh
        // matchups against the entire existing pool.
        setPair([]);
        setExhausted(true);
      } else if (e.message === 'Missing token' || e.message === 'Invalid token') {
        // Token issue — silently show empty state; AuthGuard will redirect if truly logged out
        setPair([]);
      } else {
        Alert.alert('Error', e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);


  useEffect(() => { loadPair(); }, [loadPair]);

  const vote = async (winnerId: string, loserId: string) => {
    if (voting) return;
    setVoting(true);
    try {
      const r = await api.finds.vote(winnerId, loserId);
      setResult({ delta: r.delta, winnerId });
      // Server-side find_pair_seen already marked this matchup as seen
      // when it was served; the local set we used to maintain is gone.
      // Pause so user sees result, then fade to next pair
      setTimeout(() => {
        Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
          loadPair();
          fadeAnim.setValue(1);
        });
      }, 900);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setVoting(false);
    }
  };

  if (loading) return <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>;

  // "Voted on everything in the pool" — distinct from "pool is empty".
  // No re-vote affordance: each find gets one vote from each viewer per
  // session, so the rotation just ends until new finds are uploaded.
  if (exhausted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>No more finds remaining to rank</Text>
        <Text style={styles.emptySub}>
          You've voted on every find available right now. Check back when more get uploaded.
        </Text>
      </View>
    );
  }

  if (pair.length < 2) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>Not enough finds yet</Text>
        <Text style={styles.emptySub}>Upload some course discoveries and invite friends to do the same — then voting opens up.</Text>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.voteContainer, { opacity: fadeAnim }]}>
      <Text style={styles.votePrompt}>Which find is cooler?</Text>
      {pair.map((find, i) => {
        const isWinner = result?.winnerId === find.find_id;
        const isLoser = result && result.winnerId !== find.find_id;
        return (
          <TouchableOpacity
            key={find.find_id}
            style={[
              styles.findCard,
              isWinner && styles.findCardWin,
              isLoser && styles.findCardLose,
            ]}
            onPress={() => vote(find.find_id, pair[1 - i].find_id)}
            disabled={!!result || voting}
            activeOpacity={0.85}
          >
            <Image
              source={{ uri: `${API_BASE}${find.photo_url}` }}
              style={styles.findImage}
              resizeMode="cover"
            />
            <View style={styles.findOverlay}>
              <View style={styles.findMeta}>
                <Text style={styles.findUser}>{c(find.username)}</Text>
                {find.description ? <Text style={styles.findDesc} numberOfLines={2}>{c(find.description)}</Text> : null}
              </View>
              <View style={styles.findEloBox}>
                <Text style={styles.findElo}>{find.elo}</Text>
                <Text style={styles.findEloLabel}>SR</Text>
              </View>
            </View>
            {isWinner && (
              <View style={styles.winBanner}>
                <Text style={styles.winBannerText}>+{result!.delta}</Text>
              </View>
            )}
            {isLoser && (
              <View style={styles.loseBanner}>
                <Text style={styles.loseBannerText}>−{result!.delta}</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </Animated.View>
  );
}

// ── Leaderboard tab ─────────────────────────────────────────────────────────
function LeaderboardTab({ onSelectFind }: { onSelectFind: (f: any) => void }) {
  const [finds, setFinds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setFinds(await api.finds.leaderboard());
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={styles.centered}><ActivityIndicator color={C.gold} /></View>;

  if (finds.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>No finds yet</Text>
        <Text style={styles.emptySub}>Be the first to upload something cool from the course.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.listScroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      {finds.map((f, i) => (
        <FindRow key={f.find_id} find={f} rank={i + 1} onPress={() => onSelectFind(f)} />
      ))}
    </ScrollView>
  );
}

// ── My finds tab ─────────────────────────────────────────────────────────────
function MineTab({ userId, onSelectFind }: { userId: string; onSelectFind: (f: any) => void }) {
  const [data, setData] = useState<{ finds: any[]; avgElo: number | null }>({ finds: [], avgElo: null });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.finds.mine());
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deletFind = (id: string) => {
    Alert.alert('Delete find?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.finds.delete(id);
            load();
          } catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  if (loading) return <View style={styles.centered}><ActivityIndicator color={C.gold} /></View>;

  return (
    <ScrollView style={styles.listScroll}>
      {data.avgElo !== null && (
        <View style={styles.avgCard}>
          <Text style={styles.avgNum}>{data.avgElo}</Text>
          <Text style={styles.avgLabel}>Average Find SR</Text>
        </View>
      )}
      {data.finds.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No finds yet</Text>
          <Text style={styles.emptySub}>Tap "+ Find" to upload your first course discovery.</Text>
        </View>
      ) : (
        data.finds.map((f, i) => (
          <FindRow key={f.find_id} find={f} rank={i + 1} onPress={() => onSelectFind(f)} onDelete={() => deletFind(f.find_id)} />
        ))
      )}
    </ScrollView>
  );
}

// ── Shared find row ──────────────────────────────────────────────────────────
function FindRow({ find, rank, onDelete, onPress }: { find: any; rank: number; onDelete?: () => void; onPress?: () => void }) {
  const c = useCensor();
  const medalColor = rank === 1 ? C.gold : rank === 2 ? '#b0bec5' : rank === 3 ? '#a1673a' : C.textDim;

  const reportFind = () => {
    Alert.alert('Report Find', 'Why are you reporting this?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Inappropriate content', onPress: () => submitReport('inappropriate') },
      { text: 'Spam', onPress: () => submitReport('spam') },
      { text: 'Off-topic', onPress: () => submitReport('off-topic') },
    ]);
  };

  const submitReport = async (reason: string) => {
    try {
      await api.finds.report(find.find_id, reason);
      Alert.alert('Reported', 'Thanks — our team will review this find.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={onPress ? 0.75 : 1} style={styles.findRow}>
      <Text style={[styles.findRank, { color: medalColor }]}>#{rank}</Text>
      <Image
        source={{ uri: `${API_BASE}${find.photo_url}` }}
        style={styles.findThumb}
        resizeMode="cover"
      />
      <View style={{ flex: 1 }}>
        {find.username && <Text style={styles.findRowUser}>{c(find.username)}</Text>}
        {find.description
          ? <Text style={styles.findRowDesc} numberOfLines={2}>{c(find.description)}</Text>
          : <Text style={styles.findRowDesc}>No description</Text>}
        <Text style={styles.findRowVotes}>{find.total_votes} votes</Text>
      </View>
      <View style={styles.findRowEloBox}>
        <Text style={styles.findRowElo}>{find.elo}</Text>
        <Text style={styles.findRowEloLabel}>SR</Text>
      </View>
      {onDelete ? (
        <TouchableOpacity onPress={onDelete} style={styles.deleteBtn}>
          <Text style={styles.deleteBtnText}>✕</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity onPress={reportFind} style={styles.deleteBtn}>
          <Text style={styles.reportBtnText}>···</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const CARD_H = (H - 240) / 2;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  // backgroundColor is REQUIRED here: the Tabs navigator's default scene is
  // white, so a transparent full-screen state (auth loading / not-logged-in)
  // would show as a blank white page instead of the themed dark.
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: C.bg },

  header: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: { paddingBottom: 2 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  titleBox: { alignItems: 'center' },
  title: { color: C.text, fontSize: 18, fontWeight: '900' },
  titleSub: { color: C.textDim, fontSize: 10, letterSpacing: 0.5 },
  uploadBtn: {
    backgroundColor: C.gold + '22', borderRadius: 4, paddingHorizontal: 12,
    paddingVertical: 6, borderWidth: 1, borderColor: C.gold,
  },
  uploadBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },

  tabRow: { flexDirection: 'row', padding: 12, gap: 8 },
  tabBtn: { flex: 1, paddingVertical: 8, borderRadius: 4, alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  tabBtnActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  tabText: { color: C.textMuted, fontWeight: '600', fontSize: 13 },
  tabTextActive: { color: C.gold },

  // Vote
  voteContainer: { flex: 1, paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
  votePrompt: { color: C.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', textAlign: 'center', marginBottom: 4 },
  findCard: {
    flex: 1, borderRadius: 6, overflow: 'hidden',
    borderWidth: 2, borderColor: C.border, position: 'relative',
  },
  findCardWin: { borderColor: C.green },
  findCardLose: { borderColor: C.red, opacity: 0.6 },
  findImage: { width: '100%', height: '100%' },
  findOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)', flexDirection: 'row',
    alignItems: 'flex-end', padding: 12, gap: 8,
  },
  findMeta: { flex: 1 },
  findUser: { color: C.gold, fontWeight: '700', fontSize: 12 },
  findDesc: { color: '#fff', fontSize: 13, marginTop: 2 },
  findEloBox: { alignItems: 'center' },
  findElo: { color: '#fff', fontSize: 18, fontWeight: '900' },
  findEloLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 9 },

  winBanner: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: C.green, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4,
  },
  winBannerText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  loseBanner: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: C.red, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4,
  },
  loseBannerText: { color: '#fff', fontWeight: '900', fontSize: 13 },

  // Lists
  listScroll: { flex: 1 },
  findRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: 6, marginHorizontal: 12,
    marginBottom: 8, padding: 10, borderWidth: 1, borderColor: C.border,
  },
  findRank: { fontFamily: F.serif, fontSize: 15, fontWeight: '700', width: 28, textAlign: 'center' },
  findThumb: { width: 60, height: 60, borderRadius: 4 },
  findRowUser: { color: C.gold, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  findRowDesc: { color: C.text, fontSize: 13, fontWeight: '500' },
  findRowVotes: { color: C.textDim, fontSize: 11, marginTop: 3 },
  findRowEloBox: { alignItems: 'center', minWidth: 48 },
  findRowElo: { color: C.text, fontSize: 18, fontWeight: '900' },
  findRowEloLabel: { color: C.textDim, fontSize: 9 },
  deleteBtn: { padding: 6 },
  deleteBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },
  reportBtnText: { color: C.textDim, fontWeight: '700', fontSize: 16, letterSpacing: 1 },

  // Mine
  avgCard: {
    backgroundColor: C.card, borderRadius: 6, margin: 12, padding: 20,
    alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  avgNum: { fontFamily: F.serif, color: C.gold, fontSize: 36, fontWeight: '700' },
  avgLabel: { color: C.textMuted, fontSize: 13, marginTop: 4 },

  // Empty
  emptyTitle: { color: C.text, fontWeight: '700', fontSize: 16, marginBottom: 8 },
  emptySub: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 4, lineHeight: 20 },
});
