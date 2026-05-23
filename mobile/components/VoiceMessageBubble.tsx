/**
 * Inline play/pause control for a voice message in chat. Loads the audio
 * lazily — first tap fetches + decodes; subsequent taps just resume.
 *
 * Renders as a horizontal pill: ▶︎ ━━━━●─── 0:12
 *   • Play/pause icon on the left
 *   • A bar that fills as the clip plays
 *   • Duration text on the right
 *
 * Uses expo-av's Audio.Sound. One sound per bubble; pausing pauses just
 * this clip. Multiple bubbles playing at once is allowed (matches WhatsApp
 * behaviour where you can scroll past playing audio).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { API_BASE } from '../lib/api';
import { C, F } from '../lib/colors';

interface Props {
  /** Server-relative URL like `/uploads/voice/abc.m4a`. Prefixed with
   *  API_BASE for the actual fetch. */
  url: string;
  /** Total clip length in ms — shown when paused. Falls back to the
   *  sound's reported duration once it's loaded. */
  durationMs?: number | null;
  /** Bubble tint — passed in by the parent so mine vs theirs styling stays
   *  consistent with text bubbles. */
  tint?: 'self' | 'other';
}

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceMessageBubble({ url, durationMs, tint = 'other' }: Props) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [loadedDurationMs, setLoadedDurationMs] = useState<number | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Unload on unmount so backgrounding / chat-screen-leave doesn't leave
  // audio playing or hogging the playback session.
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => { });
        soundRef.current = null;
      }
    };
  }, []);

  const onStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    setPositionMs(status.positionMillis);
    if (status.durationMillis) setLoadedDurationMs(status.durationMillis);
    setPlaying(status.isPlaying);
    if (status.didJustFinish) {
      setPlaying(false);
      setPositionMs(0);
      // Rewind so a second tap starts from 0 instead of "finished".
      soundRef.current?.setPositionAsync(0).catch(() => { });
    }
  };

  const togglePlay = async () => {
    try {
      if (!soundRef.current) {
        setLoading(true);
        // playsInSilentModeIOS so iPhones on silent (everyone on a golf
        // course) can still play voice messages.
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
        const { sound } = await Audio.Sound.createAsync(
          { uri: fullUrl },
          { shouldPlay: true, volume: 1.0, progressUpdateIntervalMillis: 150 },
          onStatus,
        );
        soundRef.current = sound;
        setLoading(false);
        return;
      }
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;
      if (status.isPlaying) {
        await soundRef.current.pauseAsync();
      } else {
        await soundRef.current.playAsync();
      }
    } catch {
      setLoading(false);
      // Surfaces as a stuck "loading" state — user can tap again. Common
      // cause: bad network. The OfflineBanner already covers that case.
    }
  };

  const total = loadedDurationMs ?? durationMs ?? 0;
  const progress = total > 0 ? Math.min(1, positionMs / total) : 0;
  // Show position while playing, total when paused — matches WhatsApp.
  const displayMs = playing ? positionMs : (total || 0);

  const palette = tint === 'self' ? selfStyles : otherStyles;

  return (
    <View style={[s.wrap, palette.wrap]}>
      <TouchableOpacity
        onPress={togglePlay}
        style={[s.btn, palette.btn]}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
      >
        {loading
          ? <ActivityIndicator size="small" color={palette.icon.color} />
          : <Text style={[s.icon, palette.icon]}>{playing ? '❙❙' : '▶'}</Text>}
      </TouchableOpacity>
      <View style={[s.track, palette.track]}>
        <View style={[s.fill, palette.fill, { width: `${progress * 100}%` }]} />
      </View>
      <Text style={[s.dur, palette.dur]}>{fmtMs(displayMs)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    minWidth: 180,
  },
  btn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  icon: { fontSize: 14, fontWeight: '900' },
  track: {
    flex: 1, height: 4, borderRadius: 2, overflow: 'hidden',
  },
  fill: { height: '100%' },
  dur: { fontFamily: F.serif, fontSize: 12, fontWeight: '700', minWidth: 32, textAlign: 'right' },
});

const selfStyles = StyleSheet.create({
  wrap: { backgroundColor: C.gold + '33', borderWidth: 1, borderColor: C.gold + '66' },
  btn: { backgroundColor: C.gold },
  icon: { color: C.bg },
  track: { backgroundColor: C.gold + '33' },
  fill: { backgroundColor: C.gold },
  dur: { color: C.gold },
});

const otherStyles = StyleSheet.create({
  wrap: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  btn: { backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold },
  icon: { color: C.gold },
  track: { backgroundColor: C.border },
  fill: { backgroundColor: C.gold },
  dur: { color: C.text },
});
