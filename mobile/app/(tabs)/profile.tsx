import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { C } from '../../lib/colors';

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
  const { user, logout } = useAuth();
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
          Alert.alert('Done!', 'Username updated. Please log out and back in to see the change.');
        } catch (e: any) {
          Alert.alert('Error', e.message);
        }
      },
      'plain-text',
      user.username
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={[styles.avatar, { borderColor: rank.color }]}>
          <Text style={styles.avatarText}>{user.username[0].toUpperCase()}</Text>
        </View>
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
        <StatBox label="Losses" value={user.total_matches - user.total_wins} />
        <StatBox label="Win Rate" value={`${winRate}%`} />
      </View>

      {/* Joined */}
      <Text style={styles.joinedText}>
        Joined {new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
      </Text>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>
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
  avatarSection: { alignItems: 'center', marginBottom: 28 },
  avatar: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 3, marginBottom: 12,
  },
  avatarText: { fontSize: 40, color: C.gold, fontWeight: '900' },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  username: { color: C.text, fontSize: 24, fontWeight: '900' },
  editUsernameBtn: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.gold + '88' },
  editUsernameBtnText: { color: C.gold, fontSize: 11, fontWeight: '700' },
  email: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  rankBadge: { borderRadius: 20, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 5, marginTop: 10 },
  rankLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  card: { backgroundColor: C.card, borderRadius: 16, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: C.border, gap: 10 },
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
});
