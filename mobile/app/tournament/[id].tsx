import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Share, Alert, RefreshControl, Modal, TextInput, Switch,
} from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Divider, OrnamentTitle } from '../../components/Flourish';
import { UserAvatar } from '../../components/UserAvatar';
import { useCensor } from '../../lib/censor';

/** "+N" / "E" / "-N" from an 18-hole-equivalent to-par. */
function toParLabel(v: number | null | undefined): string {
  if (v == null) return '—';
  const n = Math.round(Number(v));
  return n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`;
}

/**
 * Tournament detail + leaderboard. Shows the standings, the player roster,
 * and (for owners) the share-code box. Player rows are tappable into the
 * public profile.
 */
export default function TournamentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const c = useCensor();
  const [t, setT] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [tab, setTab] = useState<'leaderboard' | 'feed'>('leaderboard');
  const [feed, setFeed] = useState<any[] | null>(null);
  const [feedText, setFeedText] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try { setT(await api.tournaments.get(id)); }
    catch (e: any) { Alert.alert('Could not load', e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const loadFeed = useCallback(async () => {
    try { setFeed(await api.tournaments.feed(id)); } catch { setFeed([]); }
  }, [id]);
  useEffect(() => { if (tab === 'feed' && feed === null) loadFeed(); }, [tab, feed, loadFeed]);

  if (loading) return <View style={s.center}><ActivityIndicator color={C.gold} size="large" /></View>;
  if (!t) return <View style={s.center}><Text style={{ color: C.textMuted }}>Tournament not found</Text></View>;

  const isOwner = t.owner_id === user?.user_id;
  const isMember = (t.players ?? []).some((p: any) => p.user_id === user?.user_id);
  const isActive = t.status === 'active';
  const isFinished = t.status === 'finished';
  const winnerName = (t.players ?? []).find((p: any) => p.user_id === t.winner_id)?.username
    ?? (t.leaderboard ?? [])[0]?.username ?? null;
  const isCreatorLeague = !!t.is_creator_league;
  const accent = isCreatorLeague ? (t.accent_color || C.gold) : C.gold;
  const myRow = (t.leaderboard ?? []).find((r: any) => r.user_id === user?.user_id);
  const iBeat = !!myRow?.beat_creator;

  const toggleAutoPost = async (next: boolean) => {
    try { await api.tournaments.autoPost(t.tournament_id, next); load(); }
    catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again.'); }
  };
  const postToFeed = async () => {
    const body = feedText.trim();
    if (!body) return;
    setPosting(true);
    try { await api.tournaments.postFeed(t.tournament_id, body); setFeedText(''); await loadFeed(); }
    catch (e: any) { Alert.alert('Could not post', e?.message ?? 'Try again.'); }
    finally { setPosting(false); }
  };
  const changeResetPeriod = (rp: 'none' | 'weekly' | 'monthly') => {
    if (rp === t.reset_period) return;
    Alert.alert(
      'Change season cadence?',
      rp === 'none'
        ? 'The league will no longer auto-crown a champion or reset.'
        : `The league will auto-crown a champion and reset every ${rp === 'weekly' ? 'week' : 'month'}, starting now.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Set', onPress: async () => {
          try { await api.tournaments.settings(t.tournament_id, { resetPeriod: rp }); load(); }
          catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again.'); }
        } },
      ],
    );
  };

  const shareCode = async () => {
    if (!t.join_code) return;
    await Share.share({
      message: `Join my Sacari Golf tournament "${t.name}" with code ${t.join_code}.`,
    });
  };

  const handleJoin = async () => {
    try { await api.tournaments.join(t.tournament_id); load(); }
    catch (e: any) { Alert.alert('Could not join', e.message); }
  };
  const handleLeave = async () => {
    Alert.alert('Leave tournament?', 'You\'ll drop off the leaderboard.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        try { await api.tournaments.leave(t.tournament_id); router.back(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };
  const handleDelete = async () => {
    Alert.alert('Delete tournament?', 'This wipes the leaderboard for everyone. Cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await api.tournaments.delete(t.tournament_id); router.back(); }
        catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };
  const handleFinalize = () => {
    Alert.alert(
      'Finalize tournament?',
      'This locks the standings, crowns the leaderboard winner, and awards the Champion border. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Finalize', style: 'destructive', onPress: async () => {
          try {
            const r = await api.tournaments.finalize(t.tournament_id);
            await load();
            Alert.alert('Tournament finished', r.winner_id
              ? 'Champion crowned and the prize awarded.'
              : 'No rounds were played, so no winner was crowned.');
          } catch (e: any) { Alert.alert('Could not finalize', e.message); }
        }},
      ],
    );
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />}
    >
      <Stack.Screen options={{ title: '', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold, headerShadowVisible: false }} />

      {isCreatorLeague ? (
        <View style={[s.creatorHeader, { borderColor: accent + '66' }]}>
          <View style={[s.accentStripe, { backgroundColor: accent }]} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <UserAvatar username={t.owner_username} avatarUrl={t.owner_avatar_url} size={50} borderRadius={8} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{c(t.name)}</Text>
              <Text style={s.meta}>
                by {c(t.owner_username)} · {(t.players ?? []).length} player{(t.players ?? []).length === 1 ? '' : 's'}
              </Text>
            </View>
          </View>
          {t.tagline ? <Text style={[s.desc, { marginTop: 10 }]}>{c(t.tagline)}</Text> : null}
        </View>
      ) : (
        <>
          <Text style={s.title}>{c(t.name)}</Text>
          {t.description ? <Text style={s.desc}>{c(t.description)}</Text> : null}
          <Text style={s.meta}>
            {label('scoring', t.scoring)} · {label('format', t.format)}
            {t.course_name ? ` · ${t.course_name}` : ''}
            {t.ends_at ? ` · ends ${new Date(t.ends_at).toLocaleDateString()}` : ''}
          </Text>
          <Text style={s.meta}>Hosted by {c(t.owner_username)}</Text>
        </>
      )}
      <Divider style={{ marginTop: 14, marginBottom: 14 }} />

      {/* Beat the creator */}
      {isCreatorLeague && t.target_to_par != null && (
        <View style={[s.beatBanner, { backgroundColor: accent + '14', borderColor: accent }]}>
          <Text style={[s.beatBannerLabel, { color: accent }]}>🎯 BEAT THE CREATOR</Text>
          <Text style={s.beatBannerScore}>
            {toParLabel(t.target_to_par)}{t.target_label ? `  ·  ${c(t.target_label)}` : ''}
          </Text>
          <Text style={s.beatBannerSub}>
            {iBeat
              ? 'You beat it. ✓'
              : `${t.beaten_count ?? 0} player${(t.beaten_count ?? 0) === 1 ? ' has' : 's have'} done it. Post a better round to join them.`}
          </Text>
        </View>
      )}

      {isFinished && (
        <View style={s.winnerBanner}>
          <Text style={s.winnerLabel}>🏆 CHAMPION</Text>
          <Text style={s.winnerName}>{winnerName ? c(winnerName) : 'No winner'}</Text>
        </View>
      )}

      {t.join_code && (isOwner || isMember) && (
        <>
          <TouchableOpacity style={s.codeBox} onPress={shareCode} activeOpacity={0.8}>
            <Text style={s.codeLabel}>JOIN CODE</Text>
            <Text style={s.code}>{t.join_code}</Text>
            <Text style={s.codeShare}>Tap to share →</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.qrBtn, { borderColor: accent }]} onPress={() => setQrOpen(true)} activeOpacity={0.85}>
            <Text style={[s.qrBtnText, { color: accent }]}>▦  Show join QR</Text>
          </TouchableOpacity>
        </>
      )}

      {!isMember && !isOwner && (
        <TouchableOpacity style={s.joinBtn} onPress={handleJoin}>
          <Text style={s.joinBtnText}>Join Tournament</Text>
        </TouchableOpacity>
      )}

      {(isOwner || isMember) && isActive && (
        <TouchableOpacity
          style={s.runBtn}
          onPress={() => router.push(`/play?type=group&tournament=${t.tournament_id}` as any)}
          activeOpacity={0.85}
        >
          <Text style={s.runBtnText}>{isCreatorLeague ? '＋ Play your attempt' : '＋ Run a group round'}</Text>
          <Text style={s.runBtnSub}>
            {isCreatorLeague
              ? 'Play a round that counts toward this league. Post the target score or better to beat the creator.'
              : 'Score your group on one phone. Every player\'s round counts toward this leaderboard.'}
          </Text>
        </TouchableOpacity>
      )}

      {isOwner && isCreatorLeague && isActive && (
        <TouchableOpacity style={[s.setTargetBtn, { borderColor: accent }]} onPress={() => setTargetOpen(true)} activeOpacity={0.85}>
          <Text style={[s.setTargetText, { color: accent }]}>
            {t.target_to_par != null ? `🎯 Target: ${toParLabel(t.target_to_par)} — tap to change` : '🎯 Set the score to beat'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Last season champion (recurring leagues) */}
      {isCreatorLeague && t.last_champion_name && (
        <View style={[s.champStrip, { borderColor: accent + '55' }]}>
          <Text style={s.champStripText}>Last season champion: 🏆 {c(t.last_champion_name)}</Text>
        </View>
      )}

      {/* Leaderboard / Feed tabs + chat (creator leagues only) */}
      {isCreatorLeague && (
        <View style={s.tabBar}>
          <TouchableOpacity style={[s.tabBtn, tab === 'leaderboard' && { borderBottomColor: accent }]} onPress={() => setTab('leaderboard')}>
            <Text style={[s.tabBtnText, tab === 'leaderboard' && { color: accent }]}>Leaderboard</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tabBtn, tab === 'feed' && { borderBottomColor: accent }]} onPress={() => setTab('feed')}>
            <Text style={[s.tabBtnText, tab === 'feed' && { color: accent }]}>Feed</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabChat, { borderColor: accent }]}
            onPress={() => router.push(`/chat/league/${t.tournament_id}?name=${encodeURIComponent(t.name)}` as any)}
          >
            <Text style={[s.tabChatText, { color: accent }]}>💬 Chat</Text>
          </TouchableOpacity>
        </View>
      )}

      {(!isCreatorLeague || tab === 'leaderboard') && (
        <>
          {isCreatorLeague && isMember && (
            <View style={s.settingRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={s.settingLabel}>Auto-post my solo rounds</Text>
                <Text style={s.settingHint}>Finish a solo round and it lands on this leaderboard automatically.</Text>
              </View>
              <Switch
                value={!!t.my_auto_post} onValueChange={toggleAutoPost}
                trackColor={{ true: accent + '88', false: C.border }}
                thumbColor={t.my_auto_post ? accent : C.textMuted}
              />
            </View>
          )}

          {!isCreatorLeague ? <OrnamentTitle title="Leaderboard" /> : <View style={{ height: 8 }} />}
          {(!t.leaderboard || t.leaderboard.length === 0) ? (
            <Text style={s.empty}>No rounds played yet. Standings update automatically as people submit scores.</Text>
          ) : (
            t.leaderboard.map((row: any, i: number) => (
              <TouchableOpacity
                key={row.user_id}
                style={[s.lbRow, row.user_id === user?.user_id && { borderColor: accent }]}
                onPress={() => router.push(`/user/${row.user_id}` as any)}
                activeOpacity={0.7}
              >
                <Text style={[s.rank, { color: i === 0 ? C.gold : i === 1 ? '#c0c0c0' : i === 2 ? '#a1673a' : C.textDim }]}>
                  {i <= 2 ? ['I', 'II', 'III'][i] : `#${i + 1}`}
                </Text>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={s.lbName}>{c(row.username)}</Text>
                    {row.beat_creator ? <Text style={[s.beatTag, { color: accent, borderColor: accent }]}>BEAT ✓</Text> : null}
                  </View>
                  <Text style={s.lbMeta}>
                    {row.rounds_played ?? 0} round{row.rounds_played === 1 ? '' : 's'} played
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.lbScore}>
                    {(() => {
                      if (t.scoring === 'wins') return row.wins ?? 0;
                      const v = t.scoring === 'total_strokes' ? row.total_to_par : row.best_to_par;
                      if (v == null) return '—';
                      return v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`;
                    })()}
                  </Text>
                  <Text style={s.lbUnit}>{t.scoring === 'wins' ? 'wins' : 'to par'}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}

          <OrnamentTitle title="Players" />
          {(t.players ?? []).map((p: any) => (
            <TouchableOpacity
              key={p.user_id}
              style={s.playerRow}
              onPress={() => router.push(`/user/${p.user_id}` as any)}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <UserAvatar username={p.username} avatarUrl={p.avatar_url} size={32} borderRadius={4} />
                <Text style={s.playerName}>{c(p.username)}</Text>
              </View>
              <Text style={s.playerElo}>{p.elo} SR</Text>
            </TouchableOpacity>
          ))}
        </>
      )}

      {/* League feed */}
      {isCreatorLeague && tab === 'feed' && (
        <View style={{ marginTop: 4 }}>
          {(isMember || isOwner) && (
            <View style={s.composer}>
              <TextInput
                style={s.composerInput}
                value={feedText} onChangeText={setFeedText}
                placeholder="Share something with the league…" placeholderTextColor={C.textMuted}
                multiline maxLength={1000}
              />
              <TouchableOpacity
                style={[s.composerBtn, { backgroundColor: accent }, (!feedText.trim() || posting) && { opacity: 0.5 }]}
                disabled={!feedText.trim() || posting} onPress={postToFeed}
              >
                <Text style={s.composerBtnText}>{posting ? '…' : 'Post'}</Text>
              </TouchableOpacity>
            </View>
          )}
          {feed === null ? (
            <ActivityIndicator color={accent} style={{ marginTop: 24 }} />
          ) : feed.length === 0 ? (
            <Text style={s.empty}>No posts yet. Beat the creator or drop the first message.</Text>
          ) : (
            feed.map((p: any) => (
              <View key={p.post_id} style={[s.feedItem, p.kind === 'event' && { borderColor: accent + '55', backgroundColor: accent + '0d' }]}>
                {p.kind === 'event' ? (
                  <Text style={s.feedEvent}>{c(p.body)}</Text>
                ) : (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <UserAvatar username={p.username} avatarUrl={p.avatar_url} size={26} borderRadius={4} />
                      <Text style={s.feedAuthor}>{c(p.username ?? 'Member')}</Text>
                    </View>
                    <Text style={s.feedBody}>{c(p.body)}</Text>
                  </>
                )}
                <Text style={s.feedTime}>{new Date(p.created_at).toLocaleDateString()}</Text>
              </View>
            ))
          )}
        </View>
      )}

      <View style={{ marginTop: 30, gap: 10 }}>
        {isOwner && isCreatorLeague && isActive && (
          <View style={s.seasonBox}>
            <Text style={s.seasonLabel}>SEASON CADENCE</Text>
            <Text style={s.seasonHint}>Auto-crown a champion and reset the leaderboard on a schedule.</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              {(['none', 'weekly', 'monthly'] as const).map((rp) => (
                <TouchableOpacity
                  key={rp}
                  style={[s.seasonChip, t.reset_period === rp && { backgroundColor: accent, borderColor: accent }]}
                  onPress={() => changeResetPeriod(rp)}
                >
                  <Text style={[s.seasonChipText, t.reset_period === rp && { color: '#000' }]}>
                    {rp === 'none' ? 'Off' : rp === 'weekly' ? 'Weekly' : 'Monthly'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {isOwner && isActive && (
          <TouchableOpacity style={s.finalizeBtn} onPress={handleFinalize}>
            <Text style={s.finalizeBtnText}>Finalize &amp; crown the champion</Text>
          </TouchableOpacity>
        )}
        {isOwner ? (
          <TouchableOpacity style={s.dangerBtn} onPress={handleDelete}>
            <Text style={s.dangerBtnText}>Delete Tournament</Text>
          </TouchableOpacity>
        ) : isMember ? (
          <TouchableOpacity style={s.dangerBtn} onPress={handleLeave}>
            <Text style={s.dangerBtnText}>Leave Tournament</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <QrModal visible={qrOpen} onClose={() => setQrOpen(false)} code={t.join_code} name={c(t.name)} accent={accent} />
      <SetTargetModal
        visible={targetOpen}
        onClose={() => setTargetOpen(false)}
        leagueId={t.tournament_id}
        current={t.target_to_par}
        currentLabel={t.target_label}
        accent={accent}
        onSaved={() => { setTargetOpen(false); load(); }}
      />
    </ScrollView>
  );
}

function QrModal({ visible, onClose, code, name, accent }: {
  visible: boolean; onClose: () => void; code: string | null; name: string; accent: string;
}) {
  if (!code) return null;
  // THREE slashes (empty authority) is deliberate. `sacari://join/<code>` parses
  // `join` as the URL host, which doesn't match Expo Router's production deep-link
  // prefix (`sacari:///`), so a scanned QR lands on "unmatched route". With the
  // empty authority, `join` is a real path segment and routes to app/join/[code].
  const link = `sacari:///join/${code}`;
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={s.qrBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={[s.qrSheet, { borderColor: accent }]}>
          <Text style={s.qrTitle} numberOfLines={1}>{name}</Text>
          <View style={s.qrBox}>
            <QRCode value={link} size={216} backgroundColor="#ffffff" color="#000000" />
          </View>
          <Text style={s.qrCodeLabel}>JOIN CODE</Text>
          <Text style={[s.qrCode, { color: accent }]}>{code}</Text>
          <Text style={s.qrHint}>Point a phone camera at the code to jump straight in. Tap anywhere to close.</Text>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function SetTargetModal({ visible, onClose, leagueId, current, currentLabel, accent, onSaved }: {
  visible: boolean; onClose: () => void; leagueId: string;
  current: number | null; currentLabel: string | null; accent: string; onSaved: () => void;
}) {
  const [toPar, setToPar] = useState(current != null ? String(Math.round(current)) : '');
  const [lbl, setLbl] = useState(currentLabel ?? '');
  const [saving, setSaving] = useState(false);
  // Re-sync when reopened against a changed target.
  useEffect(() => {
    if (visible) { setToPar(current != null ? String(Math.round(current)) : ''); setLbl(currentLabel ?? ''); }
  }, [visible, current, currentLabel]);

  const save = async () => {
    const n = parseInt(toPar, 10);
    if (!Number.isFinite(n)) { Alert.alert('Enter a score', 'Use a number to par, like -2, 0, or 5.'); return; }
    setSaving(true);
    try { await api.tournaments.setTarget(leagueId, { toPar: n, label: lbl.trim() || undefined }); onSaved(); }
    catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again.'); }
    finally { setSaving(false); }
  };
  const clear = async () => {
    setSaving(true);
    try { await api.tournaments.setTarget(leagueId, { toPar: null }); onSaved(); }
    catch (e: any) { Alert.alert('Could not clear', e?.message ?? 'Try again.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 20, paddingTop: 28 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.modalTitle}>Set the score to beat</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
        </View>
        <Text style={s.fieldHint}>Your standing score, to par (18-hole equivalent). Anyone who posts this or better has "beaten the creator."</Text>
        <Text style={s.fieldLabel}>Score to par</Text>
        <TextInput style={[s.fieldInput, { fontSize: 22, textAlign: 'center', fontFamily: F.mono }]} value={toPar} onChangeText={setToPar} placeholder="-1" placeholderTextColor={C.textMuted} keyboardType="numbers-and-punctuation" maxLength={4} />
        <Text style={s.fieldLabel}>Label (optional)</Text>
        <TextInput style={s.fieldInput} value={lbl} onChangeText={setLbl} placeholder="e.g. Camroden · 18 holes" placeholderTextColor={C.textMuted} maxLength={80} />
        <TouchableOpacity style={[s.saveBtn, { backgroundColor: accent }, saving && { opacity: 0.6 }]} disabled={saving} onPress={save}>
          {saving ? <ActivityIndicator color="#000" /> : <Text style={s.saveBtnText}>Save target</Text>}
        </TouchableOpacity>
        {current != null && (
          <TouchableOpacity style={s.clearBtn} disabled={saving} onPress={clear}>
            <Text style={s.clearBtnText}>Clear target</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </Modal>
  );
}

function label(kind: 'scoring' | 'format', v: string) {
  if (kind === 'scoring') {
    return v === 'best_round' ? 'Best Round' : v === 'total_strokes' ? 'Total Strokes' : v === 'wins' ? 'Match Wins' : v;
  }
  return v === 'stroke' ? 'Stroke' : v === 'stableford' ? 'Stableford' : v === 'match_play' ? 'Match Play' : v === 'skins' ? 'Skins' : v === 'scramble' ? 'Scramble' : v;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },

  title: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900' },
  desc: { color: C.text, fontSize: 14, marginTop: 8, lineHeight: 20 },
  meta: { color: C.textMuted, fontSize: 12, marginTop: 6 },

  codeBox: {
    backgroundColor: C.card, borderRadius: 12, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: C.gold, alignItems: 'center',
  },
  codeLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  code: { color: C.text, fontFamily: F.mono, fontSize: 30, fontWeight: '900', letterSpacing: 6, marginTop: 4 },
  codeShare: { color: C.textMuted, fontSize: 11, marginTop: 6 },

  joinBtn: { backgroundColor: C.gold, padding: 14, borderRadius: 8, alignItems: 'center', marginBottom: 16 },
  joinBtnText: { color: '#000', fontWeight: '900' },

  empty: { color: C.textMuted, fontSize: 13, padding: 20, textAlign: 'center' },

  lbRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 14, marginBottom: 6,
    borderWidth: 1, borderColor: C.border,
  },
  rank: { width: 36, textAlign: 'center', fontSize: 14, fontFamily: F.serif, fontWeight: '900' },
  lbName: { color: C.text, fontWeight: '800', fontSize: 15 },
  lbMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  lbScore: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  lbUnit: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },

  playerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: C.border + '88',
  },
  playerName: { color: C.text, fontWeight: '700' },
  playerElo: { color: C.textMuted, fontSize: 12 },

  dangerBtn: { paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.red, borderRadius: 8 },
  dangerBtnText: { color: C.red, fontWeight: '700' },

  runBtn: { backgroundColor: C.gold + '18', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: C.gold },
  runBtnText: { color: C.gold, fontWeight: '900', fontSize: 15 },
  runBtnSub: { color: C.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  winnerBanner: { backgroundColor: C.gold + '14', borderColor: C.gold, borderWidth: 1, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 16 },
  winnerLabel: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  winnerName: { color: C.text, fontSize: 22, fontWeight: '900', marginTop: 4 },
  finalizeBtn: { backgroundColor: C.gold, paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  finalizeBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },

  // Creator-league branding
  creatorHeader: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, padding: 14, paddingLeft: 18, overflow: 'hidden' },
  accentStripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 },

  beatBanner: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 16 },
  beatBannerLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  beatBannerScore: { color: C.text, fontFamily: F.serif, fontSize: 26, fontWeight: '900', marginTop: 4 },
  beatBannerSub: { color: C.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },

  beatTag: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden' },

  qrBtn: { paddingVertical: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', marginBottom: 16 },
  qrBtnText: { fontWeight: '900', fontSize: 13, letterSpacing: 0.5 },

  setTargetBtn: { paddingVertical: 13, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  setTargetText: { fontWeight: '900', fontSize: 14 },

  // QR modal
  qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 30 },
  qrSheet: { backgroundColor: C.card, borderRadius: 18, borderWidth: 2, padding: 24, alignItems: 'center', width: '100%', maxWidth: 320 },
  qrTitle: { color: C.text, fontFamily: F.serif, fontSize: 20, fontWeight: '900', marginBottom: 16, textAlign: 'center' },
  qrBox: { backgroundColor: '#ffffff', padding: 14, borderRadius: 10 },
  qrCodeLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginTop: 16 },
  qrCode: { fontFamily: F.mono, fontSize: 28, fontWeight: '900', letterSpacing: 6, marginTop: 2 },
  qrHint: { color: C.textMuted, fontSize: 12, marginTop: 12, textAlign: 'center', lineHeight: 17 },

  // Set-target modal
  modalTitle: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif },
  cancel: { color: C.textMuted, fontSize: 15 },
  fieldHint: { color: C.textMuted, fontSize: 13, lineHeight: 18, marginTop: 12 },
  fieldLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 18, marginBottom: 6 },
  fieldInput: { backgroundColor: C.card, color: C.text, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, borderWidth: 1, borderColor: C.border },
  saveBtn: { marginTop: 28, padding: 14, borderRadius: 8, alignItems: 'center' },
  saveBtnText: { color: '#000', fontWeight: '900', fontSize: 15 },
  clearBtn: { marginTop: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.red, borderRadius: 8 },
  clearBtnText: { color: C.red, fontWeight: '700' },

  // Last-champion strip
  champStrip: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 16, backgroundColor: C.card },
  champStripText: { color: C.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },

  // Tabs + chat
  tabBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, marginTop: 4 },
  tabBtn: { paddingVertical: 10, paddingHorizontal: 6, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnText: { color: C.textMuted, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
  tabChat: { marginLeft: 'auto', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 7, borderWidth: 1 },
  tabChatText: { fontWeight: '900', fontSize: 12 },

  // Member auto-post setting row
  settingRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: C.border,
  },
  settingLabel: { color: C.text, fontWeight: '800', fontSize: 14 },
  settingHint: { color: C.textMuted, fontSize: 12, marginTop: 3, lineHeight: 16 },

  // Feed
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 16 },
  composerInput: {
    flex: 1, backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, borderWidth: 1, borderColor: C.border,
    minHeight: 44, maxHeight: 120, textAlignVertical: 'top',
  },
  composerBtn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  composerBtnText: { color: '#000', fontWeight: '900', fontSize: 13 },
  feedItem: { backgroundColor: C.card, borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  feedEvent: { color: C.text, fontSize: 14, fontWeight: '700', lineHeight: 19 },
  feedAuthor: { color: C.text, fontWeight: '800', fontSize: 13 },
  feedBody: { color: C.text, fontSize: 14, lineHeight: 20 },
  feedTime: { color: C.textDim, fontSize: 10, marginTop: 8 },

  // Creator season cadence
  seasonBox: { backgroundColor: C.card, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: C.border },
  seasonLabel: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  seasonHint: { color: C.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
  seasonChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 7, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  seasonChipText: { color: C.text, fontWeight: '800', fontSize: 13 },
});
