import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  Alert, ActivityIndicator, TextInput, Modal, RefreshControl, Switch,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, router } from 'expo-router';
import { api, API_BASE } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Clan, ClanMember } from '../../types';
import { ThemeSongPicker, ThemeTrack } from '../../components/ThemeSongPicker';

function rankBadge(elo: number) {
  if (elo >= 2000) return { label: 'Diamond', color: '#5b9cf6' };
  if (elo >= 1600) return { label: 'Platinum', color: '#4fc3c3' };
  if (elo >= 1400) return { label: 'Gold', color: C.gold };
  if (elo >= 1200) return { label: 'Silver', color: '#b0bec5' };
  return { label: 'Bronze', color: '#a1673a' };
}

/** Renames the legacy "clan" concept to its size-specific user-facing term:
 *  Duo (2 players) or Squad (3+). The internal `clan_mode` column drives this. */
const groupLabel = (mode?: string) => (mode === 'duo' ? 'Duo' : 'Squad');

export default function ClanDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [clan, setClan] = useState<Clan | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Edit state
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPublic, setEditPublic] = useState(true);
  const [saving, setSaving] = useState(false);

  // Invite state
  const [inviteVisible, setInviteVisible] = useState(false);
  const [friends, setFriends] = useState<any[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);

  // Avatar / theme state
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [themePickerVisible, setThemePickerVisible] = useState(false);

  const changeAvatar = async () => {
    if (uploadingAvatar) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to set a clan avatar.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    setUploadingAvatar(true);
    try {
      const asset = result.assets[0];
      const mime = asset.mimeType ?? 'image/jpeg';
      const { avatar_url } = await api.clans.uploadAvatar(id, asset.base64!, mime);
      // Cache-bust the URL so the new image shows immediately.
      setClan((prev) => prev ? { ...prev, avatar_url: `${avatar_url}?t=${Date.now()}` } as any : prev);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message ?? 'Try again.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const setTheme = async (track: ThemeTrack) => {
    try {
      await api.clans.update(id, { theme: track });
      setClan((prev) => prev ? {
        ...prev,
        theme_track_id: track.trackId,
        theme_track_title: track.title,
        theme_track_artist: track.artist,
        theme_track_artwork: track.artworkUrl,
        theme_track_preview: track.previewUrl,
      } as any : prev);
    } catch (e: any) {
      Alert.alert('Could not save theme', e.message ?? 'Try again.');
    }
  };

  const clearTheme = async () => {
    try {
      await api.clans.update(id, { theme: null });
      setClan((prev) => prev ? {
        ...prev,
        theme_track_id: null, theme_track_title: null,
        theme_track_artist: null, theme_track_artwork: null,
        theme_track_preview: null,
      } as any : prev);
    } catch (e: any) {
      Alert.alert('Could not clear theme', e.message ?? 'Try again.');
    }
  };

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const data = await api.clans.get(id);
      setClan(data);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const myMember = clan?.members?.find((m) => m.user_id === user?.user_id);
  const isLeader = myMember?.role === 'leader';
  const isMember = !!myMember;

  const openEdit = () => {
    setEditName(clan?.name ?? '');
    setEditPublic(clan?.is_public ?? true);
    setEditVisible(true);
  };

  const saveEdit = async () => {
    if (!editName.trim()) { Alert.alert('Name required'); return; }
    setSaving(true);
    try {
      const updated = await api.clans.update(id, { name: editName.trim(), isPublic: editPublic });
      setClan((prev) => prev ? { ...prev, ...updated } : prev);
      setEditVisible(false);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  const kickMember = (member: ClanMember) => {
    Alert.alert(
      `Kick ${member.username}?`,
      'They will be removed from the clan.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kick', style: 'destructive',
          onPress: async () => {
            try {
              await api.clans.kick(id, member.user_id);
              load();
            } catch (e: any) { Alert.alert('Error', e.message); }
          },
        },
      ]
    );
  };

  const transferLeadership = (member: ClanMember) => {
    Alert.alert(
      `Make ${member.username} leader?`,
      'You will become a regular member.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Transfer', style: 'destructive',
          onPress: async () => {
            try {
              await api.clans.transfer(id, member.user_id);
              load();
            } catch (e: any) { Alert.alert('Error', e.message); }
          },
        },
      ]
    );
  };

  const leaveClan = () => {
    Alert.alert(
      'Leave team?',
      isLeader ? 'Leadership will transfer to the longest-tenured member, or the team disbands if you\'re the last one.' : "You'll need to rejoin to get back in.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave', style: 'destructive',
          onPress: async () => {
            try {
              await api.clans.leave(id, user!.user_id);
              router.back();
            } catch (e: any) { Alert.alert('Error', e.message); }
          },
        },
      ]
    );
  };

  const openInvite = async () => {
    setInviteVisible(true);
    setLoadingFriends(true);
    try {
      const memberIds = new Set((clan?.members ?? []).map((m) => m.user_id));
      const all = await api.users.friends();
      setFriends((all as any[]).filter((f: any) => !memberIds.has(f.user_id)));
    } catch { setFriends([]); } finally { setLoadingFriends(false); }
  };

  const inviteFriend = async (friendId: string, friendName: string) => {
    try {
      await api.clans.invite(id, friendId);
      Alert.alert('Invite sent!', `${friendName} has been invited to the ${groupLabel(clan?.clan_mode).toLowerCase()}.`);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const joinClan = async () => {
    try {
      await api.clans.join(id);
      load();
      Alert.alert('Joined!');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  if (!clan) {
    return (
      <View style={styles.centered}>
        <Text style={{ color: C.textMuted }}>Clan not found</Text>
      </View>
    );
  }

  const winRate = clan.total_matches > 0
    ? Math.round((clan.total_wins / clan.total_matches) * 100)
    : 0;
  const rank = rankBadge(clan.elo);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        {isLeader && (
          <TouchableOpacity style={styles.editBtn} onPress={openEdit}>
            <Text style={styles.editBtnText}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
      >
        {/* Clan identity */}
        <View style={styles.clanHero}>
          <TouchableOpacity
            onPress={isLeader ? changeAvatar : undefined}
            disabled={!isLeader || uploadingAvatar}
            activeOpacity={isLeader ? 0.8 : 1}
          >
            {(clan as any).avatar_url ? (
              <Image
                source={{ uri: `${API_BASE}${(clan as any).avatar_url}` }}
                style={styles.clanAvatar}
              />
            ) : (
              <View style={styles.clanIcon}>
                <Text style={styles.clanIconText}>{clan.name[0].toUpperCase()}</Text>
              </View>
            )}
            {isLeader && (
              <View style={styles.clanAvatarEditBadge}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>
                  {uploadingAvatar ? '…' : '✎'}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.clanName}>{clan.name}</Text>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { borderColor: rank.color }]}>
              <Text style={[styles.badgeText, { color: rank.color }]}>{rank.label}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{clan.clan_mode.toUpperCase()}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{clan.is_public ? 'Public' : 'Private'}</Text>
            </View>
          </View>
        </View>

        {/* Anthem row — ALWAYS rendered so the section is discoverable
            regardless of clan size, mode, or member-loading race. Tap opens
            the iTunes search (leader only); long-press clears. */}
        <TouchableOpacity
          style={styles.themeRow}
          onPress={() => isLeader && setThemePickerVisible(true)}
          onLongPress={() => isLeader && (clan as any).theme_track_title && Alert.alert(
            'Clear theme song?',
            `Remove "${(clan as any).theme_track_title}"?`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: clearTheme },
            ],
          )}
          disabled={!isLeader}
          activeOpacity={isLeader ? 0.7 : 1}
        >
          {(clan as any).theme_track_artwork ? (
            <Image source={{ uri: (clan as any).theme_track_artwork }} style={styles.themeArt} />
          ) : (
            <View style={[styles.themeArt, { backgroundColor: C.cardAlt, justifyContent: 'center', alignItems: 'center' }]}>
              <Text style={{ color: C.textMuted, fontSize: 18 }}>♫</Text>
            </View>
          )}
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.themeLabel}>TEAM ANTHEM</Text>
            {(clan as any).theme_track_title ? (
              <>
                <Text style={styles.themeTitle} numberOfLines={1}>{(clan as any).theme_track_title}</Text>
                <Text style={styles.themeArtist} numberOfLines={1}>{(clan as any).theme_track_artist}</Text>
              </>
            ) : (
              <Text style={styles.themeArtist}>
                {isLeader ? 'Tap to pick a theme song' : 'No anthem set'}
              </Text>
            )}
          </View>
          {isLeader && <Text style={{ color: C.gold, fontSize: 22 }}>›</Text>}
        </TouchableOpacity>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{clan.elo}</Text>
            <Text style={styles.statLabel}>ELO</Text>
          </View>
          <View style={[styles.statBox, styles.statBoxMid]}>
            <Text style={styles.statNum}>{clan.total_matches}</Text>
            <Text style={styles.statLabel}>Matches</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: winRate >= 50 ? C.green : C.red }]}>
              {winRate}%
            </Text>
            <Text style={styles.statLabel}>Win Rate</Text>
          </View>
        </View>

        {/* Members */}
        <Text style={styles.sectionTitle}>
          Members — {clan.members?.length ?? 0}/{clan.max_players}
        </Text>

        {(clan.members ?? []).map((member) => (
          <MemberRow
            key={member.user_id}
            member={member}
            isLeader={isLeader}
            isSelf={member.user_id === user?.user_id}
            onKick={() => kickMember(member)}
            onTransfer={() => transferLeadership(member)}
          />
        ))}

        {/* Action buttons */}
        <View style={styles.actions}>
          {isMember && (
            <TouchableOpacity
              style={styles.chatBtn}
              onPress={() => router.push(`/chat/clan/${id}` as any)}
            >
              <Text style={styles.chatBtnText}>Team Chat</Text>
            </TouchableOpacity>
          )}
          {isLeader && clan.member_count < clan.max_players && (
            <TouchableOpacity style={styles.inviteBtn} onPress={openInvite}>
              <Text style={styles.inviteBtnText}>+ Invite Friend</Text>
            </TouchableOpacity>
          )}
          {!isMember && clan.member_count < clan.max_players && (
            <TouchableOpacity style={styles.joinBtn} onPress={joinClan}>
              <Text style={styles.joinBtnText}>Join Team</Text>
            </TouchableOpacity>
          )}
          {!isMember && clan.member_count >= clan.max_players && (
            <View style={styles.fullBadge}>
              <Text style={styles.fullBadgeText}>Clan is Full</Text>
            </View>
          )}
          {isMember && (
            <TouchableOpacity style={styles.leaveBtn} onPress={leaveClan}>
              <Text style={styles.leaveBtnText}>Leave Team</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Invite Friend Modal */}
      <Modal
        visible={inviteVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setInviteVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Invite a Friend</Text>
            <TouchableOpacity onPress={() => setInviteVisible(false)}>
              <Text style={styles.modalCancel}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody}>
            {loadingFriends
              ? <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
              : friends.length === 0
                ? <Text style={{ color: C.textMuted, textAlign: 'center', marginTop: 40 }}>
                    No friends available to invite
                  </Text>
                : friends.map((f) => (
                  <View key={f.user_id} style={styles.friendInviteRow}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>{f.username[0].toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{f.username}</Text>
                      <Text style={styles.memberMeta}>{f.elo} ELO</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.inviteBtn}
                      onPress={() => inviteFriend(f.user_id, f.username)}
                    >
                      <Text style={styles.inviteBtnText}>Invite</Text>
                    </TouchableOpacity>
                  </View>
                ))
            }
          </ScrollView>
        </View>
      </Modal>

      {/* Edit Modal */}
      <Modal
        visible={editVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Team</Text>
            <TouchableOpacity onPress={() => setEditVisible(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody}>
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={editName}
              onChangeText={setEditName}
              placeholder="Team name..."
              placeholderTextColor={C.textMuted}
              maxLength={32}
            />

            <View style={styles.toggleRow}>
              <View>
                <Text style={styles.fieldLabel}>Public</Text>
                <Text style={styles.fieldSub}>Public groups appear in the browse list</Text>
              </View>
              <Switch
                value={editPublic}
                onValueChange={setEditPublic}
                trackColor={{ false: C.border, true: C.gold + '88' }}
                thumbColor={editPublic ? C.gold : C.textMuted}
              />
            </View>

            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={saveEdit}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator color="#000" />
                : <Text style={styles.saveBtnText}>Save Changes</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Theme song picker — iTunes Search modal */}
      <ThemeSongPicker
        visible={themePickerVisible}
        onClose={() => setThemePickerVisible(false)}
        onPick={setTheme}
      />
    </View>
  );
}

function MemberRow({
  member, isLeader, isSelf, onKick, onTransfer,
}: {
  member: ClanMember;
  isLeader: boolean;
  isSelf: boolean;
  onKick: () => void;
  onTransfer: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rank = rankBadge(member.elo);
  const winRate = member.total_matches > 0
    ? Math.round((member.total_wins / member.total_matches) * 100)
    : 0;

  return (
    <View style={styles.memberCard}>
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarText}>{member.username[0].toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.memberNameRow}>
          <Text style={styles.memberName}>{member.username}</Text>
          {member.role === 'leader' && (
            <View style={styles.leaderBadge}>
              <Text style={styles.leaderBadgeText}>Leader</Text>
            </View>
          )}
          {isSelf && (
            <View style={[styles.leaderBadge, { backgroundColor: C.blue + '22', borderColor: C.blue }]}>
              <Text style={[styles.leaderBadgeText, { color: C.blue }]}>You</Text>
            </View>
          )}
        </View>
        <Text style={styles.memberMeta}>
          <Text style={{ color: rank.color }}>{member.elo} ELO</Text>
          {'  ·  '}
          {member.total_matches}M · {winRate}% WR
        </Text>
      </View>

      {/* Leader controls for non-self, non-leader members */}
      {isLeader && !isSelf && member.role !== 'leader' && (
        <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(!menuOpen)}>
          <Text style={styles.menuBtnText}>⋯</Text>
        </TouchableOpacity>
      )}

      {menuOpen && (
        <View style={styles.menuDropdown}>
          <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onTransfer(); }}>
            <Text style={styles.menuItemText}>Make Leader</Text>
          </TouchableOpacity>
          <View style={styles.menuDivider} />
          <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onKick(); }}>
            <Text style={[styles.menuItemText, { color: C.red }]}>Kick</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 60, paddingHorizontal: 20, paddingBottom: 8,
  },
  backBtn: { padding: 4 },
  backText: { color: C.gold, fontSize: 16, fontWeight: '600' },
  editBtn: {
    backgroundColor: C.card, borderRadius: 4, paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: C.border,
  },
  editBtnText: { color: C.text, fontWeight: '700', fontSize: 13 },

  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingTop: 8, paddingBottom: 60 },

  clanHero: { alignItems: 'center', paddingVertical: 24 },
  clanIcon: {
    width: 80, height: 80, borderRadius: 8, backgroundColor: C.gold + '22',
    justifyContent: 'center', alignItems: 'center', marginBottom: 12,
    borderWidth: 2, borderColor: C.gold,
  },
  clanIconText: { fontFamily: F.serif, color: C.gold, fontSize: 36, fontWeight: '700' },
  clanAvatar: {
    width: 80, height: 80, borderRadius: 8, marginBottom: 12,
    borderWidth: 2, borderColor: C.gold,
  },
  clanAvatarEditBadge: {
    position: 'absolute', bottom: 12, right: -2,
    backgroundColor: C.gold, width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: C.bg,
  },
  themeRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 10, marginBottom: 12,
  },
  themeArt: { width: 48, height: 48, borderRadius: 4 },
  themeLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  themeTitle: { color: C.text, fontWeight: '700', fontSize: 14, marginTop: 2 },
  themeArtist: { color: C.textMuted, fontSize: 12, marginTop: 1 },
  clanName: { fontFamily: F.serif, color: C.text, fontSize: 26, fontWeight: '700', marginBottom: 10 },
  badgeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  badge: {
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  badgeText: { color: C.textMuted, fontWeight: '700', fontSize: 11, letterSpacing: 0.5 },

  statsRow: {
    flexDirection: 'row', backgroundColor: C.card, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, marginBottom: 24,
  },
  statBox: { flex: 1, alignItems: 'center', paddingVertical: 16 },
  statBoxMid: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: C.border },
  statNum: { fontFamily: F.serif, color: C.text, fontSize: 22, fontWeight: '700' },
  statLabel: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  sectionTitle: {
    color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', marginBottom: 10,
  },

  memberCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border, position: 'relative',
  },
  memberAvatar: {
    width: 44, height: 44, borderRadius: 4, backgroundColor: C.gold + '22',
    justifyContent: 'center', alignItems: 'center',
  },
  memberAvatarText: { color: C.gold, fontWeight: '800', fontSize: 18 },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  memberName: { color: C.text, fontWeight: '700', fontSize: 15 },
  leaderBadge: {
    backgroundColor: C.gold + '22', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
    borderWidth: 1, borderColor: C.gold,
  },
  leaderBadgeText: { color: C.gold, fontWeight: '700', fontSize: 10 },
  memberMeta: { color: C.textMuted, fontSize: 12 },

  menuBtn: {
    width: 32, height: 32, justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 4, borderWidth: 1, borderColor: C.border,
  },
  menuBtnText: { color: C.text, fontSize: 18, lineHeight: 20 },
  menuDropdown: {
    position: 'absolute', right: 12, top: 50, backgroundColor: C.card,
    borderRadius: 6, borderWidth: 1, borderColor: C.border,
    zIndex: 10, minWidth: 130, shadowColor: '#000', shadowOpacity: 0.4,
    shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  menuItem: { padding: 12 },
  menuItemText: { color: C.text, fontWeight: '600', fontSize: 14 },
  menuDivider: { height: 1, backgroundColor: C.border },

  actions: { marginTop: 24, gap: 10 },
  joinBtn: { backgroundColor: C.gold, borderRadius: 6, padding: 15, alignItems: 'center' },
  joinBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
  fullBadge: { backgroundColor: C.card, borderRadius: 6, padding: 15, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  fullBadgeText: { color: C.textMuted, fontWeight: '700' },
  leaveBtn: { borderRadius: 6, padding: 15, alignItems: 'center', borderWidth: 1, borderColor: C.red + '66' },
  leaveBtnText: { color: C.red, fontWeight: '700', fontSize: 15 },
  chatBtn: { backgroundColor: C.card, borderRadius: 6, padding: 15, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  chatBtnText: { color: C.text, fontWeight: '700', fontSize: 15 },

  // Edit modal
  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  modalCancel: { color: C.textMuted, fontSize: 15 },
  modalBody: { flex: 1, padding: 20 },

  fieldLabel: { color: C.text, fontWeight: '700', fontSize: 14, marginBottom: 8, marginTop: 16 },
  fieldSub: { color: C.textMuted, fontSize: 12, marginBottom: 0, marginTop: -4 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 6, padding: 14, marginTop: 12,
    borderWidth: 1, borderColor: C.border,
  },
  saveBtn: { backgroundColor: C.gold, borderRadius: 6, padding: 15, alignItems: 'center', marginTop: 24 },
  saveBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },

  inviteBtn: { backgroundColor: C.gold + '22', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: C.gold },
  inviteBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },
  friendInviteRow: {
    backgroundColor: C.card, borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
  },
});
