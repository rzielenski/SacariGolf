import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Linking, Alert, TextInput, Modal,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { Match } from '../../types';

function EloRank(elo: number): { label: string; color: string } {
  if (elo >= 2000) return { label: 'Diamond', color: '#a8d8f0' };
  if (elo >= 1800) return { label: 'Platinum', color: '#c0c0d0' };
  if (elo >= 1600) return { label: 'Gold', color: C.gold };
  if (elo >= 1400) return { label: 'Silver', color: '#c0c0c0' };
  return { label: 'Bronze', color: '#cd7f32' };
}

export default function HomeScreen() {
  const { user, refreshUser, logout, deleteAccount } = useAuth();
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const eloTapCount = useRef(0);
  const eloTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [handicapModal, setHandicapModal] = useState(false);
  const [handicapInput, setHandicapInput] = useState('');

  const load = useCallback(async () => {
    try {
      const [m] = await Promise.all([api.matches.list(), refreshUser()]);
      setMatches(m.slice(0, 5));
    } catch { /* silent */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshUser]);

  const deleteMatch = useCallback(async (matchId: string) => {
    try {
      await api.matches.cancel(matchId);
      setMatches((prev) => prev.filter((m) => m.match_id !== matchId));
    } catch (e: any) {
      Alert.alert('Could not delete', e.message);
    }
  }, []);

  const confirmDeleteMatch = useCallback((match: Match) => {
    Alert.alert(
      'Delete Match',
      'Remove this match? Only works if no scores have been submitted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteMatch(match.match_id) },
      ]
    );
  }, [deleteMatch]);

  useEffect(() => { load(); }, [load]);

  if (!user) return null;

  const rank = EloRank(user.elo);
  const winRate = user.total_matches > 0
    ? Math.round((user.total_wins / user.total_matches) * 100)
    : 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.gold} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Welcome back,</Text>
          <Text style={styles.username}>{user.username}</Text>
        </View>
        <View style={[styles.rankBadge, { borderColor: rank.color }]}>
          <Text style={[styles.rankLabel, { color: rank.color }]}>{rank.label}</Text>
        </View>
      </View>

      {/* ELO Card — tap ELO number 5× to open Find Ranker */}
      <View style={styles.eloCard}>
        <TouchableOpacity
          style={styles.eloLeft}
          activeOpacity={1}
          onPress={() => {
            eloTapCount.current += 1;
            if (eloTapTimer.current) clearTimeout(eloTapTimer.current);
            if (eloTapCount.current >= 5) {
              eloTapCount.current = 0;
              router.push('/finds' as any);
            } else {
              eloTapTimer.current = setTimeout(() => { eloTapCount.current = 0; }, 2000);
            }
          }}
        >
          <Text style={styles.eloNum}>{user.elo}</Text>
          <Text style={styles.eloLabel}>ELO Rating</Text>
        </TouchableOpacity>
        <View style={styles.eloDivider} />
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{user.total_matches}</Text>
          <Text style={styles.eloStatLabel}>Matches</Text>
        </View>
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{user.total_wins}</Text>
          <Text style={styles.eloStatLabel}>Wins</Text>
        </View>
        <View style={styles.eloStat}>
          <Text style={styles.eloStatNum}>{winRate}%</Text>
          <Text style={styles.eloStatLabel}>Win Rate</Text>
        </View>
      </View>

      {/* Handicap row */}
      <TouchableOpacity style={styles.handicapRow} onPress={() => { setHandicapInput(user.handicap_index?.toString() ?? ''); setHandicapModal(true); }}>
        <Text style={styles.handicapLabel}>Handicap Index</Text>
        <Text style={styles.handicapValue}>
          {user.handicap_index != null ? user.handicap_index.toFixed(1) : 'Set'}
        </Text>
      </TouchableOpacity>

      {/* Quick actions */}
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => router.push('/(tabs)/play')}>
          <Text style={styles.actionMark}>1v1</Text>
          <Text style={styles.actionLabel}>Quick Match</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => router.push('/(tabs)/play')}>
          <Text style={styles.actionMark}>2v2</Text>
          <Text style={styles.actionLabel}>Duo Match</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => router.push('/(tabs)/social')}>
          <Text style={styles.actionMark}>CC</Text>
          <Text style={styles.actionLabel}>Clans</Text>
        </TouchableOpacity>
      </View>

      {/* Leaderboard shortcut */}
      <TouchableOpacity style={styles.leaderboardBtn} onPress={() => router.push('/leaderboard' as any)}>
        <Text style={styles.leaderboardBtnText}>Global Leaderboard</Text>
        <Text style={styles.leaderboardArrow}>→</Text>
      </TouchableOpacity>

      {/* Recent matches */}
      <Text style={styles.sectionTitle}>Recent Matches</Text>
      {loading ? (
        <ActivityIndicator color={C.gold} style={{ marginTop: 24 }} />
      ) : matches.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No matches yet.</Text>
          <Text style={styles.emptySubText}>Hit the fairway and play your first round!</Text>
        </View>
      ) : (
        matches.map((m) => (
          <MatchRow
            key={m.match_id}
            match={m}
            userId={user.user_id}
            onLongPress={!m.completed ? () => confirmDeleteMatch(m) : undefined}
          />
        ))
      )}

      <View style={styles.footerRow}>
        <TouchableOpacity
          onPress={() => Linking.openURL('mailto:rpzielenski@gmail.com?subject=Clash%20of%20Clubs%20Feature%20Suggestion')}
        >
          <Text style={styles.feedbackText}>suggest a feature</Text>
        </TouchableOpacity>
        <Text style={styles.footerDot}>·</Text>
        <TouchableOpacity onPress={() => Alert.alert('Sign Out', 'Sign out of your account?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign Out', onPress: logout },
        ])}>
          <Text style={styles.feedbackText}>sign out</Text>
        </TouchableOpacity>
        <Text style={styles.footerDot}>·</Text>
        <TouchableOpacity onPress={() => Alert.alert(
          'Delete Account',
          'This permanently deletes your account, all match history, and any finds you uploaded. This cannot be undone.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete Forever', style: 'destructive', onPress: deleteAccount },
          ]
        )}>
          <Text style={[styles.feedbackText, { color: '#6b3030' }]}>delete account</Text>
        </TouchableOpacity>
      </View>
      {/* Handicap Modal */}
      <Modal
        visible={handicapModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHandicapModal(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setHandicapModal(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Handicap Index</Text>
            <TouchableOpacity onPress={async () => {
              const val = handicapInput.trim() === '' ? null : parseFloat(handicapInput);
              if (val !== null && (isNaN(val) || val < 0 || val > 54)) {
                Alert.alert('Invalid', 'Enter a number between 0 and 54.');
                return;
              }
              try {
                await api.users.update({ handicapIndex: val });
                await refreshUser();
                setHandicapModal(false);
              } catch (e: any) { Alert.alert('Error', e.message); }
            }}>
              <Text style={styles.modalSave}>Save</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modalBody}>
            <Text style={styles.modalDesc}>
              Your USGA/WHS handicap index (0–54). Used to calculate course handicap for net scoring.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={handicapInput}
              onChangeText={setHandicapInput}
              placeholder="e.g. 14.2"
              placeholderTextColor={C.textMuted}
              keyboardType="decimal-pad"
              maxLength={5}
            />
            {handicapInput.trim() !== '' && !isNaN(parseFloat(handicapInput)) && (
              <View style={styles.modalCalcBox}>
                <Text style={styles.modalCalcLabel}>Course Handicap (example — slope 113, rating 72, par 72)</Text>
                <Text style={styles.modalCalcVal}>
                  {Math.round(parseFloat(handicapInput) * 113 / 113 + (72 - 72))} strokes
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function MatchRow({ match, userId, onLongPress }: { match: Match; userId: string; onLongPress?: () => void }) {
  const won = match.winner_side === match.my_side;
  const didPlay = match.completed && match.my_side != null;
  const typeLabel = match.match_type.charAt(0).toUpperCase() + match.match_type.slice(1);
  const date = new Date(match.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <TouchableOpacity
      style={styles.matchRow}
      onPress={() => router.push(`/match/${match.match_id}` as any)}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      <View style={styles.matchLeft}>
        <Text style={styles.matchType}>{typeLabel}</Text>
        {match.name ? <Text style={styles.matchName}>{match.name}</Text> : null}
        <Text style={styles.matchDate}>{date}</Text>
      </View>
      <View style={styles.matchRight}>
        {!match.completed ? (
          <View style={[styles.statusBadge, { backgroundColor: C.blue + '33' }]}>
            <Text style={[styles.statusText, { color: C.blue }]}>In Progress</Text>
          </View>
        ) : didPlay ? (
          <>
            <View style={[styles.statusBadge, { backgroundColor: (won ? C.green : C.red) + '33' }]}>
              <Text style={[styles.statusText, { color: won ? C.green : C.red }]}>{won ? 'WIN' : 'LOSS'}</Text>
            </View>
            {match.delta_elo != null && (
              <Text style={[styles.eloDelta, { color: won ? C.green : C.red }]}>
                {won ? '+' : '-'}{match.delta_elo} ELO
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.scoreText}>{match.my_strokes ?? '--'} strokes</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  greeting: { color: C.textMuted, fontSize: 14 },
  username: { color: C.text, fontSize: 24, fontWeight: '800' },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 12, paddingVertical: 5 },
  rankLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  eloCard: {
    backgroundColor: C.card,
    borderRadius: 18,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 20,
  },
  eloLeft: { flex: 1 },
  eloNum: { fontFamily: F.serif, fontSize: 42, fontWeight: '700', color: C.gold },
  eloLabel: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  eloDivider: { width: 1, height: 40, backgroundColor: C.border, marginHorizontal: 16 },
  eloStat: { alignItems: 'center', paddingHorizontal: 8 },
  eloStatNum: { fontSize: 18, fontWeight: '800', color: C.text },
  eloStatLabel: { fontSize: 10, color: C.textMuted, marginTop: 2 },

  actionsRow: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  actionBtn: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 6,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  actionMark: { fontFamily: F.serif, fontSize: 16, fontWeight: '700', color: C.gold, marginBottom: 6, letterSpacing: 1 },
  actionLabel: { color: C.textMuted, fontSize: 10, fontWeight: '600', textAlign: 'center', letterSpacing: 0.5, textTransform: 'uppercase' },

  sectionTitle: { color: C.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 },

  matchRow: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  matchLeft: { flex: 1 },
  matchType: { color: C.text, fontWeight: '700', fontSize: 15 },
  matchName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  matchDate: { color: C.textDim, fontSize: 11, marginTop: 4 },
  matchRight: { alignItems: 'flex-end', gap: 4 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  eloDelta: { fontSize: 12, fontWeight: '700' },
  scoreText: { color: C.textMuted, fontSize: 13 },

  emptyCard: { backgroundColor: C.card, borderRadius: 14, padding: 28, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  emptyText: { color: C.text, fontSize: 16, fontWeight: '700' },
  emptySubText: { color: C.textMuted, fontSize: 13, marginTop: 6, textAlign: 'center' },

  feedbackBtn: { alignItems: 'center', paddingVertical: 24 },
  feedbackText: { color: C.textDim, fontSize: 11, letterSpacing: 0.5 },

  footerRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 24, gap: 8 },
  footerDot: { color: C.textDim, fontSize: 11 },

  handicapRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 16,
  },
  handicapLabel: { color: C.textMuted, fontSize: 13, fontWeight: '600' },
  handicapValue: { color: C.gold, fontSize: 15, fontWeight: '800', fontFamily: F.serif },

  leaderboardBtn: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1, borderColor: C.border, marginBottom: 24,
  },
  leaderboardBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },
  leaderboardArrow: { color: C.gold, fontSize: 16, fontWeight: '700' },

  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '900' },
  modalCancel: { color: C.textMuted, fontSize: 15 },
  modalSave: { color: C.gold, fontSize: 15, fontWeight: '700' },
  modalBody: { padding: 20 },
  modalDesc: { color: C.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 20 },
  modalInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 22,
    fontFamily: F.serif, fontWeight: '700', borderWidth: 1, borderColor: C.border,
    textAlign: 'center',
  },
  modalCalcBox: {
    marginTop: 20, backgroundColor: C.card, borderRadius: 6, padding: 16,
    borderWidth: 1, borderColor: C.border, alignItems: 'center',
  },
  modalCalcLabel: { color: C.textMuted, fontSize: 11, textAlign: 'center', marginBottom: 6 },
  modalCalcVal: { color: C.gold, fontFamily: F.serif, fontSize: 28, fontWeight: '700' },
});
