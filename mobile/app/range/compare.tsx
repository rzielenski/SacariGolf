/**
 * Range Session — side-by-side compare screen.
 *
 * Two swings, picked from Review Sesh history (?a=<swingId>&b=<swingId>).
 *
 *   • Playback — each panel has its own small play/pause button (play A
 *     alone, or B alone), PLUS one big shared button that plays/pauses BOTH
 *     together. Speed and the scrub bar stay shared: speed applies to both
 *     clips, and the scrub seeks each clip to the SAME FRACTION of its own
 *     duration (not the same absolute time) — the simplest sync model that
 *     doesn't require hand-aligning an impact frame on each clip, and it's
 *     useful for lining the two up even when only one is actually playing.
 *   • Drawing — no "which panel" mode to set. Both canvases are always live
 *     together; whichever panel you touch is the one that gets the mark
 *     (native touch dispatch already resolves that — no routing needed).
 *     Tool/color are shared (pen vs. eraser vs. line vs. circle, and which
 *     color), same as picking up one pen and using it on either drawing.
 *     Undo/Clear are per-panel (shown right under that panel) since there's
 *     no single "current" panel anymore.
 *
 * Compare annotations are SESSION-ONLY (not persisted back to the swing
 * record) — this is a scratchpad for a side-by-side look, not a saved
 * drawing. The single-swing Review Sesh (/range/analyze) still persists
 * its own annotations as before.
 */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Dimensions, PanResponder,
} from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { CLUB_LABELS } from '../../lib/proSwingStats';
import { RangeSwing, loadSwings, Stroke } from '../../lib/rangeSession';
import { ClubheadTracer } from '../../components/ClubheadTracer';
import { SwingAnnotator } from '../../components/SwingAnnotator';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_W } = Dimensions.get('window');
const H_PADDING = 20;      // matches the review/analyze screens' scroll padding
const PANEL_GAP = 10;
const PANEL_W = (SCREEN_W - H_PADDING * 2 - PANEL_GAP) / 2;
const PANEL_H = PANEL_W * (16 / 9);

/** Same presets as /range/analyze — kept identical so slo-mo behavior reads
 *  the same across both screens. */
const PLAYBACK_RATES: { label: string; rate: number }[] = [
  { label: '1×',   rate: 1.0 },
  { label: '½×',   rate: 0.5 },
  { label: '¼×',   rate: 0.25 },
  { label: '⅛×',   rate: 0.125 },
];
const PEN_COLORS = ['#ffd60a', '#e63946', '#4a9eff', '#7aab78', '#ffffff'];

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function RangeCompare() {
  const { user } = useAuth();
  const { a: idA, b: idB } = useLocalSearchParams<{ a: string; b: string }>();
  const [swingA, setSwingA] = useState<RangeSwing | null | undefined>(undefined);
  const [swingB, setSwingB] = useState<RangeSwing | null | undefined>(undefined);

  useEffect(() => {
    if (!user?.user_id || !idA || !idB) return;
    (async () => {
      const all = await loadSwings(user.user_id);
      setSwingA(all.find((s) => s.swing_id === idA) ?? null);
      setSwingB(all.find((s) => s.swing_id === idB) ?? null);
    })();
  }, [user?.user_id, idA, idB]);

  const videoARef = useRef<Video>(null);
  const videoBRef = useRef<Video>(null);

  // ── Shared transport ────────────────────────────────────────────────
  // isPlaying(A/B) are derived from each side's own status — needed both for
  // the per-panel play buttons AND so a broken/unloaded A can't wedge the
  // shared "play both" button's read of overall state (see fracProgress
  // fallback below for the matching scrub-bar case).
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPlayingA, setIsPlayingA] = useState(false);
  const [isPlayingB, setIsPlayingB] = useState(false);
  const anyPlaying = isPlayingA || isPlayingB;
  const [durationMsA, setDurationMsA] = useState(0);
  const [positionMsA, setPositionMsA] = useState(0);
  const [durationMsB, setDurationMsB] = useState(0);
  const [positionMsB, setPositionMsB] = useState(0);
  const scrubWidthRef = useRef(1);

  useEffect(() => {
    videoARef.current?.setRateAsync(playbackRate, true).catch(() => { });
    videoBRef.current?.setRateAsync(playbackRate, true).catch(() => { });
  }, [playbackRate]);

  const onStatusA = useCallback((s: AVPlaybackStatus) => {
    if (!s.isLoaded) return;
    setPositionMsA(s.positionMillis);
    if (s.durationMillis != null) setDurationMsA(s.durationMillis);
    setIsPlayingA(s.isPlaying);
    // expo-av resets rate to 1x on every loop restart — re-apply so slo-mo sticks.
    if (s.isPlaying && Math.abs((s.rate ?? 1) - playbackRate) > 0.01) {
      videoARef.current?.setRateAsync(playbackRate, true).catch(() => { });
    }
  }, [playbackRate]);
  const onStatusB = useCallback((s: AVPlaybackStatus) => {
    if (!s.isLoaded) return;
    setPositionMsB(s.positionMillis);
    if (s.durationMillis != null) setDurationMsB(s.durationMillis);
    setIsPlayingB(s.isPlaying);
    if (s.isPlaying && Math.abs((s.rate ?? 1) - playbackRate) > 0.01) {
      videoBRef.current?.setRateAsync(playbackRate, true).catch(() => { });
    }
  }, [playbackRate]);

  /** Start/stop a single video, re-applying the shared rate on play (same
   *  expo-av quirk the shared transport already works around). */
  const togglePlayOne = useCallback(async (ref: React.RefObject<Video | null>, playing: boolean) => {
    if (playing) { await ref.current?.pauseAsync().catch(() => { }); return; }
    await ref.current?.playAsync().catch(() => { });
    await ref.current?.setRateAsync(playbackRate, true).catch(() => { });
  }, [playbackRate]);
  const togglePlayA = useCallback(() => togglePlayOne(videoARef, isPlayingA), [togglePlayOne, isPlayingA]);
  const togglePlayB = useCallback(() => togglePlayOne(videoBRef, isPlayingB), [togglePlayOne, isPlayingB]);

  // "Play both" — if either is currently playing, stop everything; if
  // neither is, start both. Lets one button act as a master control on top
  // of the two independent per-panel ones.
  const togglePlayBoth = useCallback(async () => {
    if (anyPlaying) {
      await Promise.all([
        videoARef.current?.pauseAsync().catch(() => { }),
        videoBRef.current?.pauseAsync().catch(() => { }),
      ]);
      return;
    }
    await Promise.all([
      videoARef.current?.playAsync().catch(() => { }),
      videoBRef.current?.playAsync().catch(() => { }),
    ]);
    await Promise.all([
      videoARef.current?.setRateAsync(playbackRate, true).catch(() => { }),
      videoBRef.current?.setRateAsync(playbackRate, true).catch(() => { }),
    ]);
  }, [anyPlaying, playbackRate]);

  // Seek both clips to the SAME FRACTION of their own duration — each video
  // keeps its own timeline, so "50%" means each clip's own halfway point.
  // Still applies to both regardless of which is playing — useful for lining
  // the two up even when only one is actively running.
  const seekToFrac = useCallback((frac: number) => {
    const f = Math.max(0, Math.min(1, frac));
    if (durationMsA > 0) videoARef.current?.setPositionAsync(f * durationMsA).catch(() => { });
    if (durationMsB > 0) videoBRef.current?.setPositionAsync(f * durationMsB).catch(() => { });
  }, [durationMsA, durationMsB]);
  const seekToX = useCallback((x: number) => {
    seekToFrac(x / (scrubWidthRef.current || 1));
  }, [seekToFrac]);
  const scrubPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekToX(e.nativeEvent.locationX),
    onPanResponderMove: (e) => seekToX(e.nativeEvent.locationX),
  }), [seekToX]);

  // Fall back to B's fraction when A has no duration yet (or never loads) —
  // otherwise a broken A permanently pins the shared scrub bar at 0%.
  const fracProgress = durationMsA > 0 ? positionMsA / durationMsA
    : durationMsB > 0 ? positionMsB / durationMsB : 0;

  // ── Drawing — shared tool/color, but both canvases are always live ──────
  const [drawingMode, setDrawingMode] = useState<'pen' | 'eraser' | 'line' | 'circle'>('pen');
  const [drawingEnabled, setDrawingEnabled] = useState(false);
  const [penColor, setPenColor] = useState<string>(PEN_COLORS[0]);
  const [strokesA, setStrokesA] = useState<Stroke[]>([]);
  const [strokesB, setStrokesB] = useState<Stroke[]>([]);

  if (swingA === undefined || swingB === undefined) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={C.gold} />
      </View>
    );
  }
  if (!idA || !idB || swingA === null || swingB === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Compare Swings' }} />
        <Text style={styles.notFoundText}>
          One or both swings are no longer available.
        </Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back to Review Sesh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{
        title: 'Compare Swings', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text,
      }} />
      <ScrollView contentContainerStyle={styles.scroll} scrollEnabled={!drawingEnabled}>
        <View style={styles.panelRow}>
          <SwingPanel
            label="A" swing={swingA} videoRef={videoARef} onStatus={onStatusA}
            playbackRate={playbackRate} positionMs={positionMsA} durationMs={durationMsA}
            isPlaying={isPlayingA} onTogglePlay={togglePlayA}
            strokes={strokesA} drawing={drawingEnabled}
            mode={drawingMode} penColor={penColor} onStrokesChange={setStrokesA}
          />
          <SwingPanel
            label="B" swing={swingB} videoRef={videoBRef} onStatus={onStatusB}
            playbackRate={playbackRate} positionMs={positionMsB} durationMs={durationMsB}
            isPlaying={isPlayingB} onTogglePlay={togglePlayB}
            strokes={strokesB} drawing={drawingEnabled}
            mode={drawingMode} penColor={penColor} onStrokesChange={setStrokesB}
          />
        </View>
        <TouchableOpacity style={styles.changeLink} onPress={() => router.back()}>
          <Text style={styles.changeLinkText}>‹ Change swings</Text>
        </TouchableOpacity>

        {/* Shared playback bar — plays/pauses BOTH; one scrub drives both by fraction. */}
        <View style={styles.playbar}>
          <TouchableOpacity style={styles.playBtn} onPress={togglePlayBoth} activeOpacity={0.8}>
            <Ionicons name={anyPlaying ? 'pause' : 'play'} size={20} color={C.bg} />
          </TouchableOpacity>
          <View
            style={styles.scrubTrack}
            onLayout={(e) => { scrubWidthRef.current = e.nativeEvent.layout.width || 1; }}
            {...scrubPan.panHandlers}
          >
            <View style={styles.scrubRail}>
              <View style={[styles.scrubFill, { width: `${Math.min(100, Math.max(0, fracProgress * 100))}%` }]} />
            </View>
          </View>
        </View>
        <Text style={styles.playBothHint}>Play Both</Text>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>A {fmtTime(positionMsA)} / {fmtTime(durationMsA)}</Text>
          <Text style={styles.timeText}>B {fmtTime(positionMsB)} / {fmtTime(durationMsB)}</Text>
        </View>

        {/* Speed — applies to both clips. */}
        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>SPEED</Text>
          <View style={styles.toolbarChips}>
            {PLAYBACK_RATES.map((p) => (
              <TouchableOpacity
                key={p.label}
                style={[styles.rateChip, playbackRate === p.rate && styles.rateChipActive]}
                onPress={() => setPlaybackRate(p.rate)}
                activeOpacity={0.7}
              >
                <Text style={[styles.rateChipLabel, playbackRate === p.rate && styles.rateChipLabelActive]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>DRAW</Text>
          <View style={styles.toolbarChips}>
            <TouchableOpacity
              style={[styles.toolBtn, drawingEnabled && drawingMode === 'pen' && styles.toolBtnActive]}
              onPress={() => { if (!drawingEnabled) setDrawingEnabled(true); setDrawingMode('pen'); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.toolBtnLabel, drawingEnabled && drawingMode === 'pen' && styles.toolBtnLabelActive]}>✎ Pen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolBtn, drawingEnabled && drawingMode === 'eraser' && styles.toolBtnActive]}
              onPress={() => { if (!drawingEnabled) setDrawingEnabled(true); setDrawingMode('eraser'); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.toolBtnLabel, drawingEnabled && drawingMode === 'eraser' && styles.toolBtnLabelActive]}>⌫ Erase</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolBtn, drawingEnabled && drawingMode === 'line' && styles.toolBtnActive]}
              onPress={() => { if (!drawingEnabled) setDrawingEnabled(true); setDrawingMode('line'); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.toolBtnLabel, drawingEnabled && drawingMode === 'line' && styles.toolBtnLabelActive]}>╱ Line</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolBtn, drawingEnabled && drawingMode === 'circle' && styles.toolBtnActive]}
              onPress={() => { if (!drawingEnabled) setDrawingEnabled(true); setDrawingMode('circle'); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.toolBtnLabel, drawingEnabled && drawingMode === 'circle' && styles.toolBtnLabelActive]}>○ Circle</Text>
            </TouchableOpacity>
            {drawingEnabled && (
              <TouchableOpacity style={styles.toolBtn} onPress={() => setDrawingEnabled(false)} activeOpacity={0.7}>
                <Text style={styles.toolBtnLabel}>Done</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {drawingEnabled && drawingMode !== 'eraser' && (
          <View style={styles.colorRow}>
            {PEN_COLORS.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.colorSwatch, { backgroundColor: c }, penColor === c && styles.colorSwatchActive]}
                onPress={() => setPenColor(c)}
                activeOpacity={0.7}
              />
            ))}
          </View>
        )}

        {drawingEnabled && (
          <Text style={styles.drawHint}>
            Drawing — draw directly on either video. Scroll is locked; tap Done to scroll the page.
          </Text>
        )}

        <Text style={styles.note}>
          Comparison drawings are a scratchpad — they aren't saved. Open a swing on its own
          from Review Sesh to keep annotations.
        </Text>
      </ScrollView>
    </View>
  );
}

function SwingPanel({
  label, swing, videoRef, onStatus, playbackRate, positionMs, durationMs, isPlaying, onTogglePlay,
  strokes, drawing, mode, penColor, onStrokesChange,
}: {
  label: string;
  swing: RangeSwing;
  videoRef: React.RefObject<Video | null>;
  onStatus: (s: AVPlaybackStatus) => void;
  playbackRate: number;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  strokes: Stroke[];
  drawing: boolean;
  mode: 'pen' | 'eraser' | 'line' | 'circle';
  penColor: string;
  onStrokesChange: (next: Stroke[]) => void;
}) {
  // Same normalization as /range/analyze: the clubhead trace's `t` values span
  // the swing duration (0..traceTotalT), not the recorded clip length, so map
  // playback progress proportionally onto the trace timeline instead of feeding
  // absolute video time. Otherwise the trace fully draws in the first ~second
  // and then sits, out of sync with the on-screen swing.
  const trace = swing.result?.clubheadTrace;
  const traceTotalT = trace && trace.length > 0 ? trace[trace.length - 1].t : 0;
  const traceCurrentTimeSec = durationMs > 0
    ? (positionMs / durationMs) * traceTotalT
    : 0;
  return (
    <View style={styles.panel}>
      <Text style={styles.panelLabel} numberOfLines={1}>
        {label} · {CLUB_LABELS[swing.club] ?? swing.club}
      </Text>
      <View style={styles.videoFrame}>
        <Video
          ref={videoRef}
          source={{ uri: swing.video_uri }}
          style={styles.video}
          useNativeControls={false}
          resizeMode={ResizeMode.CONTAIN}
          isLooping
          rate={playbackRate}
          onPlaybackStatusUpdate={onStatus}
        />
        {swing.status === 'complete' && swing.result && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ClubheadTracer
              trace={swing.result.clubheadTrace}
              width={PANEL_W}
              height={PANEL_H}
              currentTimeSec={traceCurrentTimeSec}
              impactTimeSec={swing.result.impactTimeSec}
              lineWidth={2.5}
            />
          </View>
        )}
        {/* Drawing is always live on both panels — whichever canvas the
            finger is actually on is the one that gets the mark, so there's
            no "which panel" mode to pick first. */}
        <SwingAnnotator
          width={PANEL_W}
          height={PANEL_H}
          strokes={strokes}
          drawing={drawing}
          mode={mode}
          penColor={penColor}
          penWidth={3}
          onStrokesChange={onStrokesChange}
        />
      </View>

      {/* Per-panel play/pause — lets either swing play alone, independent of
          the shared "Play Both" button below. */}
      <TouchableOpacity style={styles.panelPlayBtn} onPress={onTogglePlay} activeOpacity={0.75}>
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={14} color={C.gold} />
        <Text style={styles.panelPlayLabel}>{isPlaying ? 'Pause' : 'Play'} {label}</Text>
      </TouchableOpacity>

      {/* Per-panel Undo/Clear — there's no single "current" panel anymore,
          so these act directly on the panel they're under. */}
      {strokes.length > 0 && (
        <View style={styles.panelStrokeRow}>
          <TouchableOpacity onPress={() => onStrokesChange(strokes.slice(0, -1))} activeOpacity={0.7}>
            <Text style={styles.panelStrokeBtn}>Undo</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onStrokesChange([])} activeOpacity={0.7}>
            <Text style={[styles.panelStrokeBtn, { color: C.red }]}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  scroll: { padding: H_PADDING, paddingBottom: 60 },

  notFoundText: { color: C.text, fontSize: 14, textAlign: 'center', marginBottom: 16 },
  backBtn: { paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: C.gold, borderRadius: 6 },
  backBtnText: { color: C.gold, fontWeight: '700' },

  panelRow: { flexDirection: 'row', gap: PANEL_GAP },
  panel: { width: PANEL_W },
  panelLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', marginBottom: 6 },
  videoFrame: {
    width: PANEL_W, height: PANEL_H,
    backgroundColor: '#000', borderRadius: 8, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border,
  },
  video: { width: '100%', height: '100%' },

  panelPlayBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    marginTop: 8, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  panelPlayLabel: { color: C.gold, fontSize: 11, fontWeight: '800' },
  panelStrokeRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 6 },
  panelStrokeBtn: { color: C.textMuted, fontSize: 11, fontWeight: '700' },

  changeLink: { alignSelf: 'flex-start', marginTop: 10, marginBottom: 4 },
  changeLinkText: { color: C.gold, fontSize: 12, fontWeight: '700' },

  playbar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  playBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' },
  playBothHint: { color: C.textDim, fontSize: 10, marginTop: 4, marginLeft: 56 },
  scrubTrack: { flex: 1, height: 28, justifyContent: 'center' },
  scrubRail: { height: 6, borderRadius: 3, backgroundColor: C.border, overflow: 'hidden' },
  scrubFill: { height: 6, borderRadius: 3, backgroundColor: C.gold },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  timeText: { color: C.textMuted, fontSize: 11, fontWeight: '700' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  toolbarLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, width: 62 },
  toolbarChips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rateChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    minWidth: 40, alignItems: 'center',
  },
  rateChipActive: { backgroundColor: C.gold, borderColor: C.gold },
  rateChipLabel: { color: C.textMuted, fontSize: 12, fontWeight: '800' },
  rateChipLabelActive: { color: C.bg },

  toolBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  toolBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  toolBtnLabel: { color: C.textMuted, fontSize: 12, fontWeight: '800' },
  toolBtnLabelActive: { color: C.bg },

  colorRow: { flexDirection: 'row', gap: 10, paddingLeft: 70, marginTop: 8 },
  colorSwatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  colorSwatchActive: { borderColor: C.text },
  drawHint: { color: C.gold, fontSize: 11, fontStyle: 'italic', marginTop: 8, paddingLeft: 70 },

  note: { color: C.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 22, lineHeight: 14 },
});
