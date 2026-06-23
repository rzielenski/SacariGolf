/**
 * Settings hub. One place to manage the toggles + jump-off links that
 * used to be scattered through the Profile screen. The profile screen
 * keeps its identity sections (avatar, bio, home course, premium banner)
 * but anything that's a SETTING (a toggle, a destructive action, a
 * deep-link into a sub-flow) lands here.
 *
 * Sections, in order:
 *   1. Audio  — theme song picker, max-volume toggle, stop-preview
 *   2. Content — censor toggle
 *   3. Account — notifications, blocked users, manual handicap
 *   4. Danger  — delete account
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { SkinPicker } from '../components/SkinPicker';
import { ThemeSongPicker } from '../components/ThemeSongPicker';
import * as themePlayer from '../lib/themePlayer';

export default function SettingsScreen() {
  const { user, refreshUser } = useAuth();
  const [themePickerVisible, setThemePickerVisible] = useState(false);
  const [savingMaxVol, setSavingMaxVol] = useState(false);
  const [savingCensor, setSavingCensor] = useState(false);

  const themeTitle = (user as any)?.theme_track_title as string | null | undefined;
  const themeArtist = (user as any)?.theme_track_artist as string | null | undefined;
  const themePreview = (user as any)?.theme_track_preview as string | null | undefined;
  const themeIsVoice = (user as any)?.theme_track_id === '__voice__';
  const maxVolume = !!(user as any)?.theme_song_max_volume;
  const censor = (user as any)?.censor_offensive_language !== false; // default on

  const onToggleMaxVolume = useCallback(async (next: boolean) => {
    setSavingMaxVol(true);
    try {
      await api.users.update({ themeSongMaxVolume: next });
      themePlayer.setThemeMaxVolume(next);
      await refreshUser();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSavingMaxVol(false);
    }
  }, [refreshUser]);

  const onToggleCensor = useCallback(async (next: boolean) => {
    setSavingCensor(true);
    try {
      await api.users.update({ censorOffensiveLanguage: next });
      await refreshUser();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSavingCensor(false);
    }
  }, [refreshUser]);

  // Partial-swing entry mode (percentage vs clock). Drives which preset chips
  // appear in the in-round club picker. Defaults to percentage.
  const partialMode: 'percentage' | 'clock' =
    (user as any)?.partial_swing_mode === 'clock' ? 'clock' : 'percentage';
  const [savingPartial, setSavingPartial] = useState(false);
  const onSetPartialMode = useCallback(async (next: 'percentage' | 'clock') => {
    setSavingPartial(true);
    try {
      await api.users.update({ partialSwingMode: next });
      await refreshUser();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSavingPartial(false);
    }
  }, [refreshUser]);

  const onClearTheme = useCallback(() => {
    Alert.alert(
      'Clear theme song?',
      themeIsVoice
        ? 'Your voice memo will be removed and no theme will play during your match intro.'
        : `Remove ${themeTitle ?? 'your theme song'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.users.update({ theme: null });
              await refreshUser();
            } catch (e: any) {
              Alert.alert('Could not clear', e?.message ?? 'Try again.');
            }
          },
        },
      ],
    );
  }, [themeIsVoice, themeTitle, refreshUser]);

  const previewTheme = useCallback(async () => {
    if (!themePreview) return;
    // Use the same singleton player the match intro uses, so the toggle
    // reflects the real-world loud / quiet behaviour.
    await themePlayer.play(themePreview);
  }, [themePreview]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Settings',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>
        {/* ── Audio ────────────────────────────────────────────────── */}
        <SectionLabel>AUDIO</SectionLabel>

        <View style={s.card}>
          <Text style={s.cardLabel}>THEME SONG</Text>
          {themePreview ? (
            <>
              <Text style={s.themeTitle} numberOfLines={1}>
                {themeIsVoice ? '🎤 Your voice memo' : (themeTitle || 'Untitled')}
              </Text>
              {!themeIsVoice && themeArtist ? (
                <Text style={s.themeSub} numberOfLines={1}>{themeArtist}</Text>
              ) : null}
              <View style={s.themeActions}>
                <TouchableOpacity style={s.themeBtn} onPress={previewTheme}>
                  <Text style={s.themeBtnText}>▶ Preview</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.themeBtn} onPress={() => setThemePickerVisible(true)}>
                  <Text style={s.themeBtnText}>↻ Change</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.themeBtn, s.themeBtnDestructive]} onPress={onClearTheme}>
                  <Text style={[s.themeBtnText, { color: C.red }]}>✕ Clear</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={s.themeSub}>None set yet. Plays during your match-found intro.</Text>
              <TouchableOpacity style={s.bigBtn} onPress={() => setThemePickerVisible(true)}>
                <Text style={s.bigBtnText}>PICK A SONG OR RECORD A VOICE MEMO</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <ToggleRow
          label="Force theme songs to play loud"
          hint="Overrides your phone's silent switch when a theme is about to play. iOS doesn't let third-party apps change system volume — this is the loudest the app can produce."
          value={maxVolume}
          onChange={onToggleMaxVolume}
          busy={savingMaxVol}
        />

        {/* ── Appearance ───────────────────────────────────────────── */}
        {Platform.OS === 'ios' ? (
          <>
            <SectionLabel>APPEARANCE</SectionLabel>
            <View style={s.card}>
              <Text style={s.cardLabel}>APP THEME</Text>
              <Text style={s.themeSub}>
                Re-skin the whole app. Picking a theme reloads it once to repaint every screen.
              </Text>
              <View style={{ marginTop: 12 }}>
                <SkinPicker />
              </View>
            </View>
          </>
        ) : null}

        {/* ── Content ──────────────────────────────────────────────── */}
        <SectionLabel>CONTENT</SectionLabel>

        <ToggleRow
          label="Filter offensive language"
          hint="When on, slurs and profanity are blocked across feeds, chats, names, and post bodies."
          value={censor}
          onChange={onToggleCensor}
          busy={savingCensor}
        />

        {/* ── Shot tracking ────────────────────────────────────────── */}
        <SectionLabel>SHOT TRACKING</SectionLabel>

        <SegmentRow
          label="Partial swing entry"
          hint="How the in-round club picker labels less-than-full shots. Percent shows 90% / 80% / 70%; Clock shows 10:30 / 9:00 / 7:30."
          value={partialMode}
          options={[{ value: 'percentage', label: 'Percent' }, { value: 'clock', label: 'Clock' }]}
          onChange={(v) => onSetPartialMode(v as 'percentage' | 'clock')}
          busy={savingPartial}
        />

        {/* ── Account ──────────────────────────────────────────────── */}
        <SectionLabel>ACCOUNT</SectionLabel>

        <LinkRow
          label="Notifications"
          hint="Friend requests, match invites, mentions"
          onPress={() => router.push('/(tabs)/profile' as any)}
        />
        <LinkRow
          label="Blocked users"
          hint="Manage who you've hidden"
          onPress={() => router.push('/blocked-users' as any)}
        />
        <LinkRow
          label="My bag"
          hint="The clubs you actually carry"
          onPress={() => router.push('/bag' as any)}
        />
        <LinkRow
          label="Manual handicap"
          hint="USGA index override"
          onPress={() => router.push('/(tabs)/profile' as any)}
        />
        <LinkRow
          label="Invite Friends"
          hint="Share your code, earn perks"
          onPress={() => router.push('/invite' as any)}
        />

        {/* ── Danger ───────────────────────────────────────────────── */}
        <SectionLabel>DANGER ZONE</SectionLabel>
        <LinkRow
          label="Delete account"
          hint="Permanently remove your data"
          destructive
          onPress={() => router.push('/(tabs)/profile' as any)}
        />

        <Text style={s.fineprint}>
          Build: Sacari Golf {' '} · Settings v1
        </Text>
      </ScrollView>

      <ThemeSongPicker
        visible={themePickerVisible}
        onClose={() => setThemePickerVisible(false)}
        onPick={async (track) => {
          try {
            await api.users.update({ theme: track });
            await refreshUser();
          } catch (e: any) {
            Alert.alert('Could not save', e?.message ?? 'Try again.');
          }
        }}
        onPickVoice={refreshUser}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

function ToggleRow({
  label, hint, value, onChange, busy,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
}) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowHint}>{hint}</Text>
      </View>
      {busy
        ? <ActivityIndicator color={C.gold} />
        : <Switch
            value={value}
            onValueChange={onChange}
            trackColor={{ false: C.border, true: C.gold + '88' }}
            thumbColor={value ? C.gold : C.textMuted}
          />}
    </View>
  );
}

function SegmentRow({
  label, hint, value, options, onChange, busy,
}: {
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  busy?: boolean;
}) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowHint}>{hint}</Text>
      </View>
      {busy
        ? <ActivityIndicator color={C.gold} />
        : <View style={s.segment}>
            {options.map((o) => {
              const active = o.value === value;
              return (
                <TouchableOpacity
                  key={o.value}
                  style={[s.segmentBtn, active && s.segmentBtnActive]}
                  onPress={() => onChange(o.value)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.segmentText, active && { color: C.bg }]}>{o.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>}
    </View>
  );
}

function LinkRow({
  label, hint, onPress, destructive,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.7}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={[s.rowLabel, destructive && { color: C.red }]}>{label}</Text>
        <Text style={s.rowHint}>{hint}</Text>
      </View>
      <Text style={s.chevron}>›</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  sectionLabel: {
    color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.5,
    marginTop: 18, marginBottom: 8, paddingHorizontal: 4,
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 8,
    paddingVertical: 14, paddingHorizontal: 14,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  rowLabel: { color: C.text, fontWeight: '700', fontSize: 14 },
  rowHint: { color: C.textMuted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  chevron: { color: C.textMuted, fontSize: 22 },
  segment: {
    flexDirection: 'row', borderRadius: 8, borderWidth: 1,
    borderColor: C.border, overflow: 'hidden',
  },
  segmentBtn: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: C.bg },
  segmentBtnActive: { backgroundColor: C.gold },
  segmentText: { color: C.text, fontWeight: '800', fontSize: 12 },

  card: {
    backgroundColor: C.card, borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  cardLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 6 },
  themeTitle: { color: C.text, fontWeight: '900', fontSize: 15 },
  themeSub: { color: C.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  themeActions: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  themeBtn: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  themeBtnDestructive: { borderColor: C.red + '88' },
  themeBtnText: { color: C.gold, fontWeight: '700', fontSize: 12 },

  bigBtn: {
    marginTop: 10, backgroundColor: C.gold, borderRadius: 8,
    paddingVertical: 12, alignItems: 'center',
  },
  bigBtnText: { color: C.bg, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },

  fineprint: {
    color: C.textDim, fontFamily: F.serif, fontSize: 11,
    textAlign: 'center', marginTop: 28,
  },
});
