import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity,
  FlatList, ActivityIndicator, Image, Alert,
} from 'react-native';
import { Audio } from 'expo-av';
import { C, F } from '../lib/colors';

/**
 * Searches Apple's iTunes catalog (no auth required) and lets the user pick
 * a track. The selected track's metadata + 30-second CDN preview URL is
 * passed back via onPick. The modal manages its own audio session so any
 * playing preview is stopped when the modal closes or a different track is
 * tapped.
 */
export type ThemeTrack = {
  trackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl: string;
};

type ITunesResult = {
  trackId: number;
  trackName: string;
  artistName: string;
  artworkUrl100?: string;
  previewUrl?: string;
};

export function ThemeSongPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (track: ThemeTrack) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ITunesResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Debounced search — wait 350ms after typing stops before hitting iTunes.
  useEffect(() => {
    if (!visible) return;
    const q = query.trim();
    if (!q) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `https://itunes.apple.com/search?media=music&entity=song&limit=20&term=${encodeURIComponent(q)}`;
        const resp = await fetch(url);
        const data = await resp.json();
        // Filter to results that have an actual preview (a few don't).
        const cleaned: ITunesResult[] = (data?.results ?? []).filter((r: any) => r?.previewUrl);
        setResults(cleaned);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [query, visible]);

  // Tear down audio whenever the modal closes.
  useEffect(() => {
    if (!visible) {
      stopPreview();
      setQuery('');
      setResults([]);
    }
  }, [visible]);

  // Configure the iOS audio session to play through the speaker even when
  // the device is on silent (otherwise no sound at all on a muted phone).
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => { });
    return () => { stopPreview(); };
  }, []);

  const stopPreview = async () => {
    if (soundRef.current) {
      try { await soundRef.current.stopAsync(); } catch { }
      try { await soundRef.current.unloadAsync(); } catch { }
      soundRef.current = null;
    }
    setPlayingId(null);
  };

  const togglePreview = async (track: ITunesResult) => {
    if (!track.previewUrl) return;
    if (playingId === track.trackId) {
      await stopPreview();
      return;
    }
    await stopPreview();
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: track.previewUrl },
        { shouldPlay: true, volume: 1.0 },
      );
      soundRef.current = sound;
      setPlayingId(track.trackId);
      sound.setOnPlaybackStatusUpdate((s: any) => {
        if (s?.didJustFinish) stopPreview();
      });
    } catch (err: any) {
      Alert.alert('Preview error', err?.message ?? 'Could not play preview.');
      setPlayingId(null);
    }
  };

  const pick = async (track: ITunesResult) => {
    if (!track.previewUrl) return;
    await stopPreview();
    onPick({
      trackId: String(track.trackId),
      title: track.trackName,
      artist: track.artistName,
      artworkUrl: track.artworkUrl100,
      previewUrl: track.previewUrl,
    });
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.title}>Pick a Theme Song</Text>
          <TouchableOpacity onPress={onClose} style={s.closeBtn}>
            <Text style={s.closeText}>Close</Text>
          </TouchableOpacity>
        </View>

        <TextInput
          style={s.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Song title, artist, or both"
          placeholderTextColor={C.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />

        {loading && (
          <View style={s.loadingRow}>
            <ActivityIndicator color={C.gold} size="small" />
            <Text style={s.loadingText}>Searching…</Text>
          </View>
        )}

        <FlatList
          data={results}
          keyExtractor={(r) => String(r.trackId)}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const playing = playingId === item.trackId;
            return (
              <View style={s.row}>
                {item.artworkUrl100 ? (
                  <Image source={{ uri: item.artworkUrl100 }} style={s.art} />
                ) : (
                  <View style={[s.art, { backgroundColor: C.cardAlt }]} />
                )}
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.trackName} numberOfLines={1}>{item.trackName}</Text>
                  <Text style={s.artistName} numberOfLines={1}>{item.artistName}</Text>
                </View>
                <TouchableOpacity onPress={() => togglePreview(item)} style={s.playBtn}>
                  <Text style={s.playBtnText}>{playing ? '■' : '▶'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => pick(item)} style={s.pickBtn}>
                  <Text style={s.pickBtnText}>SET</Text>
                </TouchableOpacity>
              </View>
            );
          }}
          ListEmptyComponent={
            !loading && query.trim() ? (
              <Text style={s.emptyText}>No results — try a different search.</Text>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  closeBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  closeText: { color: C.gold, fontWeight: '900', fontSize: 14 },
  input: {
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingVertical: 12, paddingHorizontal: 14, color: C.text, fontSize: 15,
    backgroundColor: C.card, marginBottom: 12,
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  loadingText: { color: C.textMuted, fontSize: 12 },
  emptyText: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  art: { width: 50, height: 50, borderRadius: 4 },
  trackName: { color: C.text, fontWeight: '700', fontSize: 14 },
  artistName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  playBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: C.gold,
    justifyContent: 'center', alignItems: 'center', marginLeft: 8,
  },
  playBtnText: { color: C.gold, fontSize: 14, fontWeight: '900' },
  pickBtn: {
    backgroundColor: C.gold, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8,
    marginLeft: 8,
  },
  pickBtnText: { color: C.bg, fontWeight: '900', fontSize: 11, letterSpacing: 0.6 },
});
