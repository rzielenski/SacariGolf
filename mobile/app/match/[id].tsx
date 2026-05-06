import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Share, Modal, FlatList,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Match, MatchPlayer } from '../../types';
import { ScorecardCard, ScorecardModal, ScorecardEntry } from '../../components/Scorecard';
import { OrnamentTitle, Divider } from '../../components/Flourish';

export default function MatchLobbyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [friends, setFriends] = useState<any[]>([]);
  const [invitingSending, setInvitingSending] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [scorecardEntry, setScorecardEntry] = useState<ScorecardEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.matches.get(id);
      setMatch(data);
      // Check for locally-saved in-progress round (per-user key so accounts
      // on the same device don't see each other's saved progress).
      // Also confirm against the server: if THIS user already submitted scores
      // OR has a teebox set, there's no point showing "Continue Match" — they'd
      // just be re-entering scoring on data the server already has.
      try {
        const saved = await AsyncStorage.getItem(`scores_${user?.user_id ?? 'anon'}_${id}`);
        const me = data.players?.find((p: any) => p.user_id === user?.user_id);
        const hasServerProgress = !!(me?.teebox_id) || (me?.hole_scores?.length ?? 0) > 0;
        setHasSavedProgress(!!saved || hasServerProgress);
      } catch { /* ignore */ }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, [id, user?.user_id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.gold} />
      </View>
    );
  }

  if (!match) return null;

  const myPlayer = match.players?.find((p) => p.user_id === user?.user_id);
  const opponents = match.players?.filter((p) => p.user_id !== user?.user_id) ?? [];
  const allReady = match.players && match.players.length >= 2;
  const isCompleted = match.completed;

  const typeLabel = match.match_type.charAt(0).toUpperCase() + match.match_type.slice(1);
  const isPractice = match.is_practice;

  const handleStartScoring = () => {
    const holeCount = match.num_holes ?? 18;
    router.push(`/match/scoring/${id}?holes=${holeCount}` as any);
  };

  const handleShare = async () => {
    await Share.share({ message: `Join my Sacari Golf match! Match ID: ${id}` });
  };

  const openInvite = async () => {
    setInviteVisible(true);
    if (!friends.length) {
      try {
        const f = await api.users.friends();
        setFriends(f);
      } catch { /* silent */ }
    }
  };

  const handleCancelMatch = () => {
    Alert.alert(
      'Cancel Match',
      'This match will be deleted with no ELO penalty for anyone. Continue?',
      [
        { text: 'Keep Match', style: 'cancel' },
        {
          text: 'Delete Match',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            try {
              await api.matches.cancel(id);
              try { await AsyncStorage.removeItem(`scores_${user?.user_id ?? 'anon'}_${id}`); } catch { }
              router.replace('/(tabs)/' as any);
            } catch (e: any) {
              Alert.alert('Error', e.message);
            } finally {
              setCancelling(false);
            }
          },
        },
      ]
    );
  };

  const sendInvite = async (friendId: string) => {
    setInvitingSending(friendId);
    try {
      await api.invites.send(id, friendId);
      Alert.alert('Invited!', 'They\'ll get a notification.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setInvitingSending(null);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>

      {/* Match header */}
      <View style={styles.header}>
        <View style={[styles.typeBadge, isPractice && { borderColor: C.textMuted }]}>
          <Text style={[styles.typeText, isPractice && { color: C.textMuted }]}>{typeLabel}</Text>
        </View>
        <Text style={styles.matchTitle}>{match.name || `${typeLabel} Match`}</Text>
        <Text style={styles.matchId}>ID: {id.slice(0, 8).toUpperCase()}</Text>
      </View>

      {/* Result (if completed) */}
      {isCompleted && match.result && (() => {
        const tied = match.result.winner_side == null;
        const won = !tied && match.result.winner_side === myPlayer?.side;
        const myDelta = match.my_delta_elo ?? (won ? match.result.delta_elo : -(match.result.delta_elo ?? 0));
        const color = tied ? C.gold : (won ? C.green : C.red);
        const label = tied ? 'DRAW' : (won ? 'VICTORY' : 'DEFEAT');
        const myPerk: any = (match as any).my_perk;
        return (
          <View style={[styles.resultCard, { borderColor: color }]}>
            <Text style={[styles.resultText, { color }]}>{label}</Text>
            {!isPractice && (
              <Text style={styles.eloChange}>
                {myDelta > 0 ? '+' : ''}{myDelta} ELO
              </Text>
            )}
            {myPerk && (
              <Text style={styles.perkAppliedLine}>
                Lucky Round perk applied — {myPerk.original < 0
                  ? `loss of ${Math.abs(myPerk.original)} ELO prevented`
                  : myPerk.original > 0
                    ? `${myPerk.original} ELO doubled to ${myPerk.adjusted}`
                    : 'perk consumed'}
              </Text>
            )}
            <View style={styles.diffRow}>
              <Text style={styles.diffLabel}>Your differential: {(myPlayer?.side === 1 ? match.result.side1_score_differential : match.result.side2_score_differential)?.toFixed(1)}</Text>
              <Text style={styles.diffLabel}>Opponent: {(myPlayer?.side === 1 ? match.result.side2_score_differential : match.result.side1_score_differential)?.toFixed(1)}</Text>
            </View>
          </View>
        );
      })()}

      {/* Players */}
      <OrnamentTitle title="Players" />

      {match.players?.map((p) => (
        <PlayerCard
          key={p.user_id}
          player={p}
          isMe={p.user_id === user?.user_id}
          matchCompleted={isCompleted}
          onPress={() => router.push(`/user/${p.user_id}` as any)}
        />
      ))}

      {/* Duo: waiting for teammate/opponent to join via ID */}
      {!isCompleted && match.match_type === 'duo' && (match.players?.length ?? 0) < 2 && !myPlayer?.completed && (
        <View style={styles.waitingCard}>
          <Text style={styles.waitingText}>Invite your duo partner</Text>
          <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
            <Text style={styles.shareBtnText}>Share Match ID</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Solo: finding opponent via matchmaking pool */}
      {!isCompleted && myPlayer?.completed && match.match_type !== 'practice' && (
        <View style={styles.waitingCard}>
          <ActivityIndicator color={C.gold} size="small" style={{ marginBottom: 8 }} />
          <Text style={styles.waitingText}>Finding your opponent...</Text>
          <Text style={styles.waitingSubText}>You'll be matched to the closest ELO player in the queue</Text>
        </View>
      )}

      {/* Start scoring (or continue if there's saved progress) */}
      {!isCompleted && myPlayer && !myPlayer.completed && (
        <TouchableOpacity style={styles.startBtn} onPress={handleStartScoring}>
          <Text style={styles.startBtnText}>
            {hasSavedProgress ? 'Continue Match' : 'Start Scoring'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Invite Friends */}
      {!isCompleted && (
        <TouchableOpacity style={styles.inviteBtn} onPress={openInvite}>
          <Text style={styles.inviteBtnText}>Invite Friends</Text>
        </TouchableOpacity>
      )}

      {/* Auto-rendered scorecards once the match is completed */}
      {isCompleted && match.players?.some((p) => p.hole_scores?.length) && (
        <>
          <Divider style={{ marginTop: 24 }} />
          <OrnamentTitle title="Scorecards" align="center" />
          {match.players?.filter((p) => p.hole_scores?.length).map((p) => {
            const entry: ScorecardEntry = {
              username: p.username,
              user_id: p.user_id,
              teebox_name: p.teebox_name,
              hole_scores: p.hole_scores,
              course_id: p.course_id,
              course_name: p.course_name ?? null,
              teebox_id: p.teebox_id,
              match_id: id,
              round_id: p.round_id,
            };
            return (
              <ScorecardCard
                key={p.user_id}
                entry={entry}
                highlight={p.user_id === user?.user_id}
                onPress={() => setScorecardEntry(entry)}
              />
            );
          })}
        </>
      )}

      {/* Match Chat */}
      <TouchableOpacity
        style={styles.chatBtn}
        onPress={() => router.push(`/chat/match/${id}` as any)}
      >
        <Text style={styles.chatBtnText}>Match Chat</Text>
      </TouchableOpacity>

      {/* Cancel Match — only when no player has submitted scores */}
      {!isCompleted && !(match.players?.some((p) => p.completed)) && (
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={handleCancelMatch}
          disabled={cancelling}
        >
          {cancelling
            ? <ActivityIndicator color={C.red} size="small" />
            : <Text style={styles.cancelBtnText}>Cancel Match</Text>}
        </TouchableOpacity>
      )}

      {/* Invite Modal */}
      <Modal
        visible={inviteVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setInviteVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Invite Friends</Text>
            <TouchableOpacity onPress={() => setInviteVisible(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>
          {friends.length === 0 ? (
            <View style={styles.centered}>
              <ActivityIndicator color={C.gold} />
              <Text style={[styles.sectionTitle, { marginTop: 16 }]}>No friends yet</Text>
            </View>
          ) : (
            <FlatList
              data={friends}
              keyExtractor={(f) => f.user_id}
              contentContainerStyle={{ padding: 20 }}
              renderItem={({ item }) => (
                <View style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{item.username[0].toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.friendName}>{item.username}</Text>
                    <Text style={styles.friendElo}>{item.elo} ELO</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.inviteSendBtn}
                    onPress={() => sendInvite(item.user_id)}
                    disabled={invitingSending === item.user_id}
                  >
                    {invitingSending === item.user_id
                      ? <ActivityIndicator color={C.gold} size="small" />
                      : <Text style={styles.inviteSendBtnText}>Invite</Text>}
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
        </View>
      </Modal>

      {/* Per-player scorecard modal — also lists tracked shot maps for this match */}
      <ScorecardModal
        visible={!!scorecardEntry}
        entry={scorecardEntry}
        onClose={() => setScorecardEntry(null)}
        onViewProfile={() => {
          const userId = scorecardEntry?.user_id;
          setScorecardEntry(null);
          if (userId) router.push(`/user/${userId}` as any);
        }}
      />
    </ScrollView>
  );
}

function PlayerCard({ player, isMe, matchCompleted, onPress }: {
  player: MatchPlayer; isMe: boolean; matchCompleted: boolean; onPress: () => void;
}) {
  // Anti-cheat: only show stroke totals for me OR when the match is fully completed
  const canSeeStrokes = isMe || matchCompleted;

  return (
    <TouchableOpacity
      style={[styles.playerCard, isMe && { borderColor: C.gold }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.playerAvatar}>
        <Text style={styles.playerAvatarText}>{player.username[0].toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.playerName}>
          {player.username} {isMe && <Text style={{ color: C.gold }}>(You)</Text>}
        </Text>
        <Text style={styles.playerElo}>{player.elo} ELO · Side {player.side}</Text>
        {player.teebox_name ? (
          <Text style={styles.playerTeebox} numberOfLines={1}>
            {player.course_name ? `${player.course_name} · ` : ''}
            {player.teebox_name} tees
            {player.num_holes ? ` · ${player.num_holes}h` : ''}
          </Text>
        ) : (
          <Text style={[styles.playerTeebox, { color: C.textDim }]}>Picking course…</Text>
        )}
      </View>
      <View style={styles.playerStatus}>
        {player.completed ? (
          <>
            <Text style={[styles.statusDot, { color: C.green }]}>●</Text>
            <Text style={styles.playerStrokes}>
              {canSeeStrokes ? `${player.strokes} strokes` : 'Done'}
            </Text>
          </>
        ) : (
          <Text style={[styles.statusDot, { color: C.textDim }]}>○</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  backBtn: { marginBottom: 12 },
  backBtnText: { color: C.gold, fontSize: 16 },

  header: { marginBottom: 24 },
  typeBadge: { alignSelf: 'flex-start', borderRadius: 8, borderWidth: 1.5, borderColor: C.gold, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 },
  typeText: { color: C.gold, fontWeight: '700', fontSize: 12, letterSpacing: 1 },
  matchTitle: { color: C.text, fontSize: 26, fontWeight: '900' },
  matchId: { color: C.textMuted, fontSize: 12, marginTop: 4 },

  resultCard: {
    borderRadius: 16, borderWidth: 2, padding: 20, marginBottom: 20, alignItems: 'center',
    backgroundColor: C.card,
  },
  resultText: { fontFamily: F.serif, fontSize: 26, fontWeight: '700', letterSpacing: 3 },
  eloChange: { fontSize: 20, fontWeight: '800', color: C.gold, marginTop: 4 },
  perkAppliedLine: {
    color: C.gold, fontSize: 11, marginTop: 6, textAlign: 'center',
    fontWeight: '700', letterSpacing: 0.3,
  },
  diffRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  diffLabel: { color: C.textMuted, fontSize: 12 },

  sectionTitle: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 },

  scGrid: { flexDirection: 'row', alignItems: 'center', minHeight: 22 },
  scLabel: { width: 38, color: C.textDim, fontSize: 10, fontWeight: '700' },
  scNum: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center', fontWeight: '700' },
  scParCell: { flex: 1, color: C.textMuted, fontSize: 11, textAlign: 'center' },
  scScoreCell: { flex: 1, fontSize: 12, textAlign: 'center', fontWeight: '700' },
  scTotal: { width: 36, color: C.gold, fontSize: 11, textAlign: 'center', fontWeight: '800' },

  playerCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  playerAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold + '22', justifyContent: 'center', alignItems: 'center' },
  playerAvatarText: { color: C.gold, fontWeight: '900', fontSize: 18 },
  playerName: { color: C.text, fontWeight: '700', fontSize: 15 },
  playerElo: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  playerTeebox: { color: C.gold, fontSize: 11, marginTop: 2 },
  playerStatus: { alignItems: 'center' },
  statusDot: { fontSize: 16 },
  playerStrokes: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  waitingCard: { backgroundColor: C.card, borderRadius: 14, padding: 18, alignItems: 'center', marginVertical: 12, borderWidth: 1, borderColor: C.border },
  waitingText: { color: C.text, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  waitingSubText: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6 },
  shareBtn: { marginTop: 12, backgroundColor: C.gold + '22', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: C.gold },
  shareBtnText: { color: C.gold, fontWeight: '700' },

  startBtn: { backgroundColor: C.gold, borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 16 },
  startBtnText: { color: '#000', fontWeight: '900', fontSize: 17 },

  chatBtn: {
    marginTop: 12, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  chatBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },

  cancelBtn: {
    marginTop: 24, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.red + '66',
  },
  cancelBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },

  inviteBtn: {
    marginTop: 12, borderRadius: 6, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '22',
  },
  inviteBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },

  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  modalSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  modalClose: { color: C.gold, fontSize: 15, fontWeight: '700' },

  scorecardHint: { color: C.textDim, fontSize: 11, textAlign: 'center', marginTop: 6, fontStyle: 'italic' },

  totalsCard: {
    flexDirection: 'row', backgroundColor: C.card, borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 6,
  },
  totalCell: { flex: 1, alignItems: 'center' },
  totalLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  totalValue: { color: C.text, fontFamily: F.serif, fontSize: 24, fontWeight: '700', marginTop: 4 },

  viewProfileBtn: {
    marginTop: 24, borderRadius: 8, paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold, backgroundColor: C.gold + '22',
  },
  viewProfileBtnText: { color: C.gold, fontWeight: '700', fontSize: 14 },

  friendRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 6, padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
  friendAvatar: { width: 40, height: 40, borderRadius: 4, backgroundColor: C.gold + '33', justifyContent: 'center', alignItems: 'center' },
  friendAvatarText: { color: C.gold, fontWeight: '800', fontSize: 16 },
  friendName: { color: C.text, fontWeight: '700', fontSize: 15 },
  friendElo: { color: C.textMuted, fontSize: 12 },
  inviteSendBtn: { borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  inviteSendBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },
});
