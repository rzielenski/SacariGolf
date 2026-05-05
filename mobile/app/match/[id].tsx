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
  const [holeData, setHoleData] = useState<any[]>([]); // holes from one teebox for par display

  const load = useCallback(async () => {
    try {
      const data = await api.matches.get(id);
      setMatch(data);
      // Check for locally-saved in-progress round
      try {
        const saved = await AsyncStorage.getItem(`scores_${id}`);
        setHasSavedProgress(!!saved);
      } catch { /* ignore */ }

      // If match is completed, fetch course holes for par values (used in scorecards)
      if (data.completed) {
        const playerWithCourse = data.players?.find((p: any) => p.course_id && p.teebox_id);
        if (playerWithCourse) {
          try {
            const course = await api.courses.get(playerWithCourse.course_id);
            const tb = course.teeboxes?.find((t: any) => t.teebox_id === playerWithCourse.teebox_id);
            if (tb?.holes) {
              setHoleData([...tb.holes].sort((a: any, b: any) => a.hole_num - b.hole_num));
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

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
    await Share.share({ message: `Join my Clash of Clubs match! Match ID: ${id}` });
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
              try { await AsyncStorage.removeItem(`scores_${id}`); } catch { }
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
      {isCompleted && match.result && (
        <View style={[styles.resultCard, { borderColor: match.result.winner_side === myPlayer?.side ? C.green : C.red }]}>
          <Text style={[styles.resultText, { color: match.result.winner_side === myPlayer?.side ? C.green : C.red }]}>
            {match.result.winner_side === myPlayer?.side ? 'VICTORY' : 'DEFEAT'}
          </Text>
          {!isPractice && (
            <Text style={styles.eloChange}>
              {match.result.winner_side === myPlayer?.side ? '+' : '-'}{match.result.delta_elo} ELO
            </Text>
          )}
          <View style={styles.diffRow}>
            <Text style={styles.diffLabel}>Your differential: {(myPlayer?.side === 1 ? match.result.side1_score_differential : match.result.side2_score_differential)?.toFixed(1)}</Text>
            <Text style={styles.diffLabel}>Opponent: {(myPlayer?.side === 1 ? match.result.side2_score_differential : match.result.side1_score_differential)?.toFixed(1)}</Text>
          </View>
        </View>
      )}

      {/* Players */}
      <Text style={styles.sectionTitle}>Players</Text>
      {match.players?.map((p) => <PlayerCard key={p.user_id} player={p} isMe={p.user_id === user?.user_id} />)}

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
            {hasSavedProgress ? '▶ Continue Match' : '⛳ Start Scoring'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Invite Friends */}
      {!isCompleted && (
        <TouchableOpacity style={styles.inviteBtn} onPress={openInvite}>
          <Text style={styles.inviteBtnText}>Invite Friends</Text>
        </TouchableOpacity>
      )}

      {/* Scorecards (when match is completed) */}
      {isCompleted && holeData.length > 0 && match.players?.some((p) => p.hole_scores?.length) && (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Scorecards</Text>
          {match.players?.filter((p) => p.hole_scores?.length).map((p) => (
            <ScorecardView
              key={p.user_id}
              player={p}
              holes={holeData}
              isMe={p.user_id === user?.user_id}
            />
          ))}
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
    </ScrollView>
  );
}

function scoreColor(score: number, par: number) {
  const d = score - par;
  if (d <= -2) return '#4CAF50';
  if (d === -1) return '#81C784';
  if (d === 0) return C.text;
  if (d === 1) return '#FF9800';
  return '#F44336';
}

function ScorecardView({ player, holes, isMe }: { player: MatchPlayer; holes: any[]; isMe: boolean }) {
  const scores = player.hole_scores ?? [];
  const playedHoles = holes.slice(0, scores.length);
  const front = playedHoles.slice(0, 9);
  const back = playedHoles.slice(9);
  const frontScores = scores.slice(0, 9);
  const backScores = scores.slice(9);
  const frontPar = front.reduce((a, h) => a + h.par, 0);
  const backPar = back.reduce((a, h) => a + h.par, 0);
  const frontScore = frontScores.reduce((a, b) => a + b, 0);
  const backScore = backScores.reduce((a, b) => a + b, 0);
  const totalPar = frontPar + backPar;
  const totalScore = frontScore + backScore;
  const diff = totalScore - totalPar;

  return (
    <View style={[styles.scorecardCard, isMe && { borderColor: C.gold }]}>
      <View style={styles.scorecardHeader}>
        <Text style={styles.scorecardName}>
          {player.username} {isMe && <Text style={{ color: C.gold }}>(You)</Text>}
        </Text>
        <Text style={styles.scorecardTotal}>
          {totalScore} <Text style={{ color: C.textMuted, fontSize: 12 }}>
            ({diff === 0 ? 'E' : diff > 0 ? `+${diff}` : diff})
          </Text>
        </Text>
      </View>
      <Text style={styles.scorecardSub}>{player.teebox_name} tees · Par {totalPar}</Text>

      {/* Front 9 */}
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Hole</Text>
        {front.map((h) => <Text key={h.hole_id} style={styles.scNum}>{h.hole_num}</Text>)}
        <Text style={styles.scTotal}>OUT</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Par</Text>
        {front.map((h) => <Text key={h.hole_id} style={styles.scParCell}>{h.par}</Text>)}
        <Text style={styles.scTotal}>{frontPar}</Text>
      </View>
      <View style={styles.scGrid}>
        <Text style={styles.scLabel}>Score</Text>
        {front.map((h, i) => (
          <Text key={h.hole_id} style={[styles.scScoreCell, { color: scoreColor(frontScores[i], h.par) }]}>
            {frontScores[i] ?? '-'}
          </Text>
        ))}
        <Text style={[styles.scTotal, { color: frontScore - frontPar < 0 ? C.green : frontScore - frontPar > 0 ? C.red : C.text }]}>
          {frontScore || '-'}
        </Text>
      </View>

      {/* Back 9 */}
      {back.length > 0 && (
        <>
          <View style={[styles.scGrid, { marginTop: 8 }]}>
            <Text style={styles.scLabel}>Hole</Text>
            {back.map((h) => <Text key={h.hole_id} style={styles.scNum}>{h.hole_num}</Text>)}
            <Text style={styles.scTotal}>IN</Text>
          </View>
          <View style={styles.scGrid}>
            <Text style={styles.scLabel}>Par</Text>
            {back.map((h) => <Text key={h.hole_id} style={styles.scParCell}>{h.par}</Text>)}
            <Text style={styles.scTotal}>{backPar}</Text>
          </View>
          <View style={styles.scGrid}>
            <Text style={styles.scLabel}>Score</Text>
            {back.map((h, i) => (
              <Text key={h.hole_id} style={[styles.scScoreCell, { color: scoreColor(backScores[i], h.par) }]}>
                {backScores[i] ?? '-'}
              </Text>
            ))}
            <Text style={[styles.scTotal, { color: backScore - backPar < 0 ? C.green : backScore - backPar > 0 ? C.red : C.text }]}>
              {backScore || '-'}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

function PlayerCard({ player, isMe }: { player: MatchPlayer; isMe: boolean }) {
  return (
    <View style={[styles.playerCard, isMe && { borderColor: C.gold }]}>
      <View style={styles.playerAvatar}>
        <Text style={styles.playerAvatarText}>{player.username[0].toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.playerName}>
          {player.username} {isMe && <Text style={{ color: C.gold }}>(You)</Text>}
        </Text>
        <Text style={styles.playerElo}>{player.elo} ELO · Side {player.side}</Text>
        {player.teebox_name && (
          <Text style={styles.playerTeebox}>{player.teebox_name} tees</Text>
        )}
      </View>
      <View style={styles.playerStatus}>
        {player.completed ? (
          <>
            <Text style={[styles.statusDot, { color: C.green }]}>●</Text>
            <Text style={styles.playerStrokes}>{player.strokes} strokes</Text>
          </>
        ) : (
          <Text style={[styles.statusDot, { color: C.textDim }]}>○</Text>
        )}
      </View>
    </View>
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
  diffRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  diffLabel: { color: C.textMuted, fontSize: 12 },

  sectionTitle: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 },

  scorecardCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 12,
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  scorecardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
  },
  scorecardName: { color: C.text, fontWeight: '800', fontSize: 14 },
  scorecardTotal: { color: C.text, fontFamily: F.serif, fontSize: 20, fontWeight: '700' },
  scorecardSub: { color: C.textMuted, fontSize: 11, marginBottom: 8 },
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
  modalClose: { color: C.gold, fontSize: 15, fontWeight: '700' },

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
