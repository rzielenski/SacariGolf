/**
 * Range Session — analysis screen.
 *
 * Three sections, vertically stacked:
 *   1. VIDEO + OVERLAYS — the recorded swing playing back with a body-pose
 *      skeleton overlay (toggleable: address / top / impact / follow-through)
 *      and a clubhead trace that draws itself in sync with playback.
 *   2. SHOT METRICS — clubhead speed, ball speed, smash factor, launch,
 *      spin, carry. Each compared to pro + amateur baselines for the
 *      chosen club, with a one-line "interpretation" line beneath.
 *   3. BODY METRICS — tempo, hip turn, shoulder turn, X-factor, lateral
 *      hip shift, wrist hinge, spine angle, head movement. Same comparison
 *      treatment.
 *
 * Reads the swing from AsyncStorage via the swing_id query param. Falls back
 * to a "not found" view if the swing was deleted or doesn't exist.
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
import {
  CLUB_LABELS, SWING_REF, interpretDelta,
} from '../../lib/proSwingStats';
import {
  RangeSwing, loadSwings, saveSwing, SwingAnalysis, PoseFrame, Point, CameraAngle,
  Stroke, normalizePoseFrame, interpolatePoseFrames,
} from '../../lib/rangeSession';
// POSE STUDIO disabled — joint-tracking has been hidden pending revisit
// per user request. SwingPoseOverlay import is kept so the (commented-out)
// PoseStudio block below still compiles when re-enabled. Linter dead-code
// warnings are intentionally tolerated here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SwingPoseOverlay } from '../../components/SwingPoseOverlay';
import { ClubheadTracer } from '../../components/ClubheadTracer';
import { SwingAnnotator } from '../../components/SwingAnnotator';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_W } = Dimensions.get('window');

/** ms → m:ss for the scrubber readout. */
function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type Keyframe = 'address' | 'top' | 'impact' | 'followThrough';
const KEYFRAME_LABELS: Record<Keyframe, string> = {
  address: 'ADDRESS',
  top: 'TOP',
  impact: 'IMPACT',
  followThrough: 'FOLLOW-THROUGH',
};

// POSE STUDIO is hidden — the joint-tracking lens is commented out for now.
// Leaving the type so the disabled JSX block below remains valid TS when
// it's revisited.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ViewMode = 'tracer';

/** Slow-motion playback presets. Drives expo-av's `rate` prop —
 *  values < 1.0 stretch the playback over a longer real-time window, which
 *  is what makes a 30fps recording readable for swing analysis. */
const PLAYBACK_RATES: { label: string; rate: number }[] = [
  { label: '1×',    rate: 1.0  },
  { label: '½×',    rate: 0.5  },
  { label: '¼×',    rate: 0.25 },
  { label: '⅛×',    rate: 0.125 },
];

/** Pen color palette for the annotation tool. Tuned to read against
 *  satellite-tile / grass / sky backgrounds — every color is high-saturation
 *  with a built-in shadow on the segments. */
const PEN_COLORS = ['#ffd60a', '#e63946', '#4a9eff', '#7aab78', '#ffffff'];

export default function RangeAnalyze() {
  const { user } = useAuth();
  const { swing: swingId } = useLocalSearchParams<{ swing: string }>();
  const [swing, setSwing] = useState<RangeSwing | null | undefined>(undefined);
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const videoRef = useRef<Video>(null);

  // ── Slo-mo playback ────────────────────────────────────────────────
  // Controls the `rate` prop on the Video element. Persisted only in
  // component state — a session-scoped preference. expo-av treats rate
  // < 1.0 as slow-motion, pitch-correcting the audio track (we have no
  // audio that matters so this just slows the frames).
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  // Custom playback controls (native controls reset rate to 1× on play, which
  // is why slo-mo did nothing). We drive play/pause + seek ourselves.
  const [isPlaying, setIsPlaying] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const scrubWidthRef = useRef(1);

  // ── Drawing / annotation ──────────────────────────────────────────
  // Strokes are kept in component state during the session and persisted
  // to the saved RangeSwing whenever they change so a reload restores
  // the drawing.
  const [drawingMode, setDrawingMode] = useState<'pen' | 'eraser' | 'line' | 'circle'>('pen');
  const [drawingEnabled, setDrawingEnabled] = useState(false);
  const [penColor, setPenColor] = useState<string>(PEN_COLORS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  // Load the swing from storage. `undefined` = still loading, `null` = not found.
  useEffect(() => {
    if (!user?.user_id || !swingId) return;
    (async () => {
      const all = await loadSwings(user.user_id);
      const found = all.find((s) => s.swing_id === swingId) ?? null;
      setSwing(found);
      // Seed annotations from the saved record. Defaults to empty so
      // pre-existing swings (no annotations field) start with a clean
      // canvas.
      setStrokes(found?.annotations ?? []);
    })();
  }, [user?.user_id, swingId]);

  /** Persist a stroke change immediately — the user expects their
   *  marks to survive a navigate-away → navigate-back. We update local
   *  state synchronously for instant render, then fire-and-forget the
   *  AsyncStorage write. */
  const persistStrokes = useCallback((next: Stroke[]) => {
    setStrokes(next);
    if (!user?.user_id || !swing) return;
    const updated: RangeSwing = { ...swing, annotations: next };
    setSwing(updated);
    saveSwing(user.user_id, updated).catch(() => { });
  }, [user?.user_id, swing]);

  // Apply the slo-mo rate to the Video element imperatively. expo-av
  // takes a `rate` prop but recreating the player on every rate change
  // would interrupt playback; this hits the running player instead.
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.setRateAsync(playbackRate, true).catch(() => { });
  }, [playbackRate]);

  // Track video playback time so the clubhead tracer can animate in sync.
  // We sample at iOS's natural ~60Hz status callback rate; if the user
  // scrubs, the tracer follows.
  const onPlaybackStatusUpdate = (s: AVPlaybackStatus) => {
    if (!s.isLoaded) return;
    setPlaybackTimeSec(s.positionMillis / 1000);
    setPositionMs(s.positionMillis);
    setIsPlaying(s.isPlaying);
    if (s.durationMillis != null) setDurationMs(s.durationMillis);
    // expo-av resets the playback rate to 1.0 on every loop, so re-apply the
    // chosen slo-mo rate. The guard makes this a no-op once it already matches.
    if (s.isPlaying && Math.abs((s.rate ?? 1) - playbackRate) > 0.01) {
      videoRef.current?.setRateAsync(playbackRate, true).catch(() => { });
    }
  };

  // Custom play/pause — enforces the slo-mo rate right after play so it sticks
  // (native controls would resume at 1×, which is why slo-mo "did nothing").
  const togglePlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) { await v.pauseAsync().catch(() => { }); return; }
    await v.playAsync().catch(() => { });
    await v.setRateAsync(playbackRate, true).catch(() => { });
  }, [isPlaying, playbackRate]);

  // Scrubber: map a touch x within the track to a seek position.
  const seekToX = useCallback((x: number) => {
    if (durationMs <= 0) return;
    const frac = Math.max(0, Math.min(1, x / (scrubWidthRef.current || 1)));
    videoRef.current?.setPositionAsync(frac * durationMs).catch(() => { });
  }, [durationMs]);
  const scrubPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => seekToX(e.nativeEvent.locationX),
    onPanResponderMove: (e) => seekToX(e.nativeEvent.locationX),
  }), [seekToX]);

  if (swing === undefined) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={C.gold} />
      </View>
    );
  }
  if (swing === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Swing not found' }} />
        <Text style={styles.notFoundText}>This swing is no longer available.</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back to Range</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{
        title: CLUB_LABELS[swing.club] ?? swing.club,
        headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text,
      }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        // Scroll is locked while the user is drawing — otherwise a stroke
        // gesture is interpreted as a scroll and the annotation never
        // registers. Toggled off when the drawing layer is disabled.
        scrollEnabled={!drawingEnabled}
      >
        {/* ── VIDEO + OVERLAYS ─────────────────────────────────────────
            Stack: native Video player at the bottom, ClubheadTracer above
            (purely visual, no touch capture), SwingAnnotator on top
            (captures touch when drawing is enabled, otherwise transparent
            to touches). POSE STUDIO was previously a separate full-screen
            lens; it's been hidden pending revisit. */}
        <View style={styles.videoFrame}>
          <Video
            ref={videoRef}
            source={{ uri: swing.video_uri }}
            style={styles.video}
            // Custom controls below: native controls reset the rate to 1× on
            // play (defeating slo-mo), so we drive play/pause + seek ourselves.
            useNativeControls={false}
            resizeMode={ResizeMode.CONTAIN}
            isLooping
            rate={playbackRate}
            onPlaybackStatusUpdate={onPlaybackStatusUpdate}
          />
          {swing.status === 'complete' && swing.result && (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <ClubheadTracer
                trace={swing.result.clubheadTrace}
                width={SCREEN_W - 40}
                height={(SCREEN_W - 40) * (16 / 9)}
                currentTimeSec={playbackTimeSec}
                impactTimeSec={swing.result.impactTimeSec}
              />
            </View>
          )}
          <SwingAnnotator
            width={SCREEN_W - 40}
            height={(SCREEN_W - 40) * (16 / 9)}
            strokes={strokes}
            drawing={drawingEnabled}
            mode={drawingMode}
            penColor={penColor}
            onStrokesChange={persistStrokes}
          />
        </View>

        {/* Custom playback bar — play/pause enforces the slo-mo rate, and the
            scrubber seeks. Replaces native controls so slo-mo actually sticks. */}
        <View style={styles.playbar}>
          <TouchableOpacity style={styles.playBtn} onPress={togglePlay} activeOpacity={0.8}>
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={20} color={C.bg} />
          </TouchableOpacity>
          <View
            style={styles.scrubTrack}
            onLayout={(e) => { scrubWidthRef.current = e.nativeEvent.layout.width || 1; }}
            {...scrubPan.panHandlers}
          >
            <View style={styles.scrubRail}>
              <View style={[styles.scrubFill, { width: `${durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0}%` }]} />
            </View>
          </View>
          <Text style={styles.timeText}>{fmtTime(positionMs)} / {fmtTime(durationMs)}</Text>
        </View>

        {/* ── Slo-mo playback chips ────────────────────────────────────
            Lets the player slow ANY recording down for analysis — the
            iOS system camera offers 120/240fps slo-mo at record time
            (swipe to SLO-MO before tapping record), but those high-fps
            recordings still play at 30fps unless slowed here. */}
        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>SPEED</Text>
          <View style={styles.toolbarChips}>
            {PLAYBACK_RATES.map((p) => (
              <TouchableOpacity
                key={p.label}
                style={[
                  styles.rateChip,
                  playbackRate === p.rate && styles.rateChipActive,
                ]}
                onPress={() => setPlaybackRate(p.rate)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.rateChipLabel,
                    playbackRate === p.rate && styles.rateChipLabelActive,
                  ]}
                >
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Drawing toolbar ──────────────────────────────────────────
            Enable + tool toggles. Pen / Eraser are exclusive (radio).
            Color row only appears in pen mode. Clear all wipes every
            stroke; the persist callback fires immediately so the save
            survives a screen leave. */}
        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>DRAW</Text>
          <View style={styles.toolbarChips}>
            <TouchableOpacity
              style={[
                styles.toolBtn,
                drawingEnabled && drawingMode === 'pen' && styles.toolBtnActive,
              ]}
              onPress={() => {
                if (!drawingEnabled) setDrawingEnabled(true);
                setDrawingMode('pen');
              }}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.toolBtnLabel,
                drawingEnabled && drawingMode === 'pen' && styles.toolBtnLabelActive,
              ]}>✎ Pen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.toolBtn,
                drawingEnabled && drawingMode === 'eraser' && styles.toolBtnActive,
              ]}
              onPress={() => {
                if (!drawingEnabled) setDrawingEnabled(true);
                setDrawingMode('eraser');
              }}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.toolBtnLabel,
                drawingEnabled && drawingMode === 'eraser' && styles.toolBtnLabelActive,
              ]}>⌫ Erase</Text>
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
            {/* The Pen / Erase chips above implicitly enable drawing —
                this button only appears once drawing is on, as the
                explicit off-switch (also re-enables scroll). */}
            {drawingEnabled && (
              <TouchableOpacity
                style={styles.toolBtn}
                onPress={() => setDrawingEnabled(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.toolBtnLabel}>Done</Text>
              </TouchableOpacity>
            )}
            {strokes.length > 0 && (
              <TouchableOpacity
                style={[styles.toolBtn, { borderColor: C.red + '88' }]}
                onPress={() => persistStrokes([])}
                activeOpacity={0.7}
              >
                <Text style={[styles.toolBtnLabel, { color: C.red }]}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Color picker — only in pen mode. Five high-saturation colors
            tuned to read against grass / sky / netting backgrounds. */}
        {drawingEnabled && drawingMode !== 'eraser' && (
          <View style={styles.colorRow}>
            {PEN_COLORS.map((c) => (
              <TouchableOpacity
                key={c}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: c },
                  penColor === c && styles.colorSwatchActive,
                ]}
                onPress={() => setPenColor(c)}
                activeOpacity={0.7}
              />
            ))}
          </View>
        )}

        {drawingEnabled && (
          <Text style={styles.drawHint}>
            Drawing mode — scroll is locked. Tap Done to scroll the page.
          </Text>
        )}

        {/* ── POSE STUDIO — commented out pending revisit ─────────────
            The pose-studio lens (animated skeleton over a black canvas)
            is hidden while body-joint tracking is being reworked. The
            block below stays as reference for re-enabling later.

        {swing.status === 'complete' && swing.result && (() => {
          const angle = swing.cameraAngle ?? 'face_on';
          const ball = swing.result.ballPosition
            ?? (angle === 'down_the_line' ? { x: 0.62, y: 0.66 } : { x: 0.50, y: 0.68 });
          return (
            <PoseStudio
              keyframes={swing.result.poseKeyframes}
              ball={ball}
              cameraAngle={angle}
            />
          );
        })()}
        ── end pose studio block ─────────────────────────────────────── */}

        {/* Camera-angle label so the user always sees what perspective
            their swing was filmed from. */}
        <Text style={styles.angleNote}>
          {swing.cameraAngle === 'down_the_line' ? 'DOWN-THE-LINE' : 'FACE-ON'} ·
          {' '}{CLUB_LABELS[swing.club] ?? swing.club}
        </Text>

        {/* All automated metrics (clubhead speed, ball speed, smash, launch,
            spin, carry, body mechanics) were removed — they were not real
            measurements (no launch monitor + no scale calibration), so the
            numbers were misleading. The video, slo-mo playback, clubhead
            tracer, and drawing tools remain — those are observed signals,
            not derived metrics. Metrics will return when there's a real
            launch monitor / pose-derived measurement pipeline to back
            them up. */}
      </ScrollView>
    </View>
  );
}

// ─── Pose Studio ────────────────────────────────────────────────────────
//
// Animated standalone "studio" view: black canvas, skeleton + ball + ground
// line, with auto-looping playback through the four keyframes. The
// skeleton animates between (address → top → impact → follow-through)
// using linear interpolation per joint. Keyframe chips at the bottom
// act as scrubber-jump points; tapping one pauses playback and jumps to
// that pose. A play/pause button toggles auto-play.
//
// Keyframe time mapping (matches the clubhead trace's u→t map):
//   • Address       at t = 0
//   • Top           at t = 0.50  (50% of total swing time)
//   • Impact        at t = 0.75  (downswing takes 1/3 the time of backswing)
//   • Follow-through at t = 1.00
// Total visible swing time is slowed 1.6× vs the real values so the
// user can actually watch each phase rather than blink and miss it.

const KEYFRAME_T: Record<Keyframe, number> = {
  address: 0,
  top: 0.50,
  impact: 0.75,
  followThrough: 1.0,
};

function PoseStudio({
  keyframes, ball, cameraAngle,
}: {
  keyframes: SwingAnalysis['poseKeyframes'];
  ball: Point;
  cameraAngle: CameraAngle;
}) {
  const W = SCREEN_W - 40;
  const H = W * (16 / 9);

  // Normalize each keyframe at component-mount time so old saved swings
  // (single-hip, no-feet schema) get upgraded to the SportsBox shape
  // before they hit the interpolator. Memoised so we don't re-normalize
  // on every render tick.
  const normalized = useMemo(() => ({
    address:       normalizePoseFrame(keyframes.address),
    top:           normalizePoseFrame(keyframes.top),
    impact:        normalizePoseFrame(keyframes.impact),
    followThrough: normalizePoseFrame(keyframes.followThrough),
  }), [keyframes]);

  // Playback state — `time` is normalized 0..1 across the swing. Playback
  // updates it 30× per second via requestAnimationFrame when playing.
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Track width — measured via onLayout, used by the drag-to-scrub
  // PanResponder to convert touch x → normalized time.
  const [trackWidth, setTrackWidth] = useState(1);
  // Total duration the loop takes to play once, in seconds. Slowed enough
  // to be readable but not so slow it feels lethargic.
  const LOOP_SEC = 2.4;

  // Drag-to-scrub gesture on the timeline track. Pauses playback the
  // moment a touch lands, then lets the user drag the thumb left/right
  // to step through the swing at their own pace. Releasing the touch
  // leaves playback paused — the user explicitly presses play to resume.
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      setPlaying(false);
      const x = e.nativeEvent.locationX;
      setTime(Math.max(0, Math.min(1, x / trackWidth)));
    },
    onPanResponderMove: (e) => {
      const x = e.nativeEvent.locationX;
      setTime(Math.max(0, Math.min(1, x / trackWidth)));
    },
  }), [trackWidth]);

  useEffect(() => {
    if (!playing) return;
    let raf: number;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = (now - last) / 1000 / LOOP_SEC;
      last = now;
      setTime((t) => (t + dt) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Pick the two keyframes the current time falls between + how far along
  // we are within that segment. The 4 keyframes split the loop into 3
  // segments of unequal length, matching real swing tempo (backswing slow,
  // downswing fast, follow-through medium).
  const interpolated: PoseFrame = useMemo(() => {
    const segments: [number, number, PoseFrame, PoseFrame][] = [
      [0,    0.50, normalized.address,       normalized.top],
      [0.50, 0.75, normalized.top,           normalized.impact],
      [0.75, 1.0,  normalized.impact,        normalized.followThrough],
    ];
    for (const [from, to, fromF, toF] of segments) {
      if (time >= from && time <= to) {
        const segT = (time - from) / (to - from);
        // Smooth in-out ease — the body doesn't change direction
        // instantaneously at keyframes.
        const eased = segT * segT * (3 - 2 * segT);
        return interpolatePoseFrames(fromF, toF, eased);
      }
    }
    return normalized.followThrough;
  }, [time, normalized]);

  // Which keyframe is "active" — for the scrubber-chip highlight. We pick
  // whichever keyframe is closest to the current playback time.
  const activeKeyframe: Keyframe = useMemo(() => {
    const candidates: [Keyframe, number][] = [
      ['address', KEYFRAME_T.address],
      ['top', KEYFRAME_T.top],
      ['impact', KEYFRAME_T.impact],
      ['followThrough', KEYFRAME_T.followThrough],
    ];
    return candidates.reduce(
      (best, [k, t]) => Math.abs(t - time) < Math.abs(KEYFRAME_T[best] - time) ? k : best,
      'address' as Keyframe,
    );
  }, [time]);

  const jumpToKeyframe = (k: Keyframe) => {
    setPlaying(false);
    setTime(KEYFRAME_T[k]);
  };

  return (
    <View>
      <View style={[styles.videoFrame, { backgroundColor: '#000' }]}>
        {/* Ground line — physical reference. */}
        <View pointerEvents="none" style={[studio.ground, { top: H * 0.86, width: W }]} />

        {/* Camera-angle tag — top-left. */}
        <View style={studio.angleTag}>
          <Text style={studio.angleTagText}>
            {cameraAngle === 'down_the_line' ? 'DOWN-THE-LINE' : 'FACE-ON'}
          </Text>
        </View>

        {/* Target-line indicator (DTL only). */}
        {cameraAngle === 'down_the_line' && (
          <View pointerEvents="none" style={[studio.targetLine, { top: H * 0.86, width: W * 0.5, left: 0 }]} />
        )}

        {/* Skeleton — interpolated pose at the current playback time. */}
        <SwingPoseOverlay
          frame={interpolated}
          width={W}
          height={H}
          accent={C.gold}
          jointSize={11}
          lineWidth={3}
        />

        {/* Ball marker. */}
        <View
          pointerEvents="none"
          style={[
            studio.ball,
            { left: ball.x * W - 7, top: ball.y * H - 7 },
          ]}
        />

        {/* Live phase label — top-right of the canvas, shows what part
            of the swing the current frame is in. */}
        <View style={studio.phaseTag}>
          <Text style={studio.phaseTagText}>{KEYFRAME_LABELS[activeKeyframe]}</Text>
        </View>
      </View>

      {/* Playback controls — play/pause + scrubber track with keyframe
          jump-chips. Sits directly below the canvas so the user's eye
          flows from figure → controls without a seek. */}
      <View style={studio.controls}>
        <TouchableOpacity
          style={studio.playBtn}
          onPress={() => setPlaying((p) => !p)}
          activeOpacity={0.75}
        >
          <Text style={studio.playBtnText}>{playing ? '⏸' : '▶'}</Text>
        </TouchableOpacity>

        {/* Track is drag-aware — wider hit area + a visible thumb that
            follows the playback time. Tapping anywhere on the track or
            dragging the thumb pauses playback and jumps to that point. */}
        <View
          style={studio.scrubHit}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          {...panResponder.panHandlers}
        >
          <View style={studio.scrubTrack}>
            {/* Filled bar showing playback position. */}
            <View style={[studio.scrubFill, { width: `${time * 100}%` }]} />
            {/* Keyframe markers — tiny gold ticks along the track. */}
            {(['address', 'top', 'impact', 'followThrough'] as Keyframe[]).map((k) => (
              <View
                key={`mark-${k}`}
                style={[studio.scrubMark, { left: `${KEYFRAME_T[k] * 100}%` }]}
              />
            ))}
          </View>
          {/* Draggable thumb — big enough to feel under the thumb (44px
              touch target), centered on the current time. */}
          <View
            pointerEvents="none"
            style={[
              studio.scrubThumb,
              { left: `${time * 100}%` },
            ]}
          />
        </View>
      </View>

      {/* Keyframe scrubber chips — tap any to jump there and pause. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 4 }}
        style={styles.keyframeRow}
      >
        {(['address', 'top', 'impact', 'followThrough'] as Keyframe[]).map((k) => (
          <TouchableOpacity
            key={k}
            style={[styles.keyframeChip, activeKeyframe === k && styles.keyframeChipActive]}
            onPress={() => jumpToKeyframe(k)}
          >
            <Text style={[styles.keyframeLabel, activeKeyframe === k && styles.keyframeLabelActive]}>
              {KEYFRAME_LABELS[k]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const studio = StyleSheet.create({
  ground: {
    position: 'absolute',
    left: 0,
    height: 1,
    backgroundColor: C.textDim,
    opacity: 0.45,
  },
  targetLine: {
    position: 'absolute',
    height: 1,
    backgroundColor: C.gold,
    opacity: 0.35,
  },
  angleTag: {
    position: 'absolute',
    top: 10,
    left: 10,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderColor: C.gold + '88',
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  angleTagText: {
    color: C.gold,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  ball: {
    position: 'absolute',
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: C.gold,
    shadowColor: '#fff',
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  phaseTag: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderColor: C.gold,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  phaseTagText: {
    color: C.gold,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  // Playback row — play/pause button + scrubber track with keyframe ticks.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
    marginBottom: 10,
  },
  playBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  playBtnText: { color: C.bg, fontSize: 18, fontWeight: '900' },
  // The hit area wraps the visible track + thumb so the whole row (44px
  // tall, full-width) is touchable. Without this the track itself is
  // only 6px tall — impossible to grab with a thumb.
  scrubHit: {
    flex: 1,
    height: 44,
    justifyContent: 'center',
    position: 'relative',
  },
  scrubTrack: {
    height: 6,
    backgroundColor: C.cardAlt,
    borderRadius: 3,
    position: 'relative',
    overflow: 'visible',
  },
  // Draggable thumb — large filled circle, gold border, sits on top of
  // the track centered on the current time. `marginLeft: -10` so the
  // thumb's center (not its left edge) lines up with the time position.
  scrubThumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    top: 12,
    marginLeft: -10,
    backgroundColor: C.gold,
    borderWidth: 2,
    borderColor: C.bg,
    shadowColor: C.gold,
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  scrubFill: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    backgroundColor: C.gold,
    borderRadius: 3,
  },
  scrubMark: {
    position: 'absolute',
    width: 2,
    height: 12,
    top: -3,
    marginLeft: -1,
    backgroundColor: C.goldLight,
    opacity: 0.85,
  },
});

// ─── Metrics section — REMOVED ─────────────────────────────────────────
// SwingMetrics + MetricRow + their styles used to render clubhead speed,
// ball speed, smash, launch, spin, carry, and the body-mechanic rows
// (tempo, turn angles, X-factor, lateral shift, wrist hinge, spine,
// head movement) with pro / amateur reference bars. All of it was fed
// by the template mock (numbers from club + handicap, not the video)
// or by the Vision conversion that returned null for every value that
// actually requires a launch monitor. The bars on screen were
// misleading either way, so the whole section was deleted.
//
// The video + slo-mo + clubhead tracer + drawing tool remain — those
// are observed signals, not derived metrics. Metrics will return when
// there's a real measurement pipeline backing them. The legacy block
// below is kept as a non-rendered reference for that future work.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _legacy_SwingMetrics({ analysis, club }: { analysis: SwingAnalysis; club: string }) {
  const ref = SWING_REF[club] ?? SWING_REF['7iron'];

  // Ballistic stats (driver carry, smash factor, etc.) come first because
  // they're the headline numbers a golfer wants to see. Body mechanics
  // come second — they explain WHY those numbers are what they are.
  return (
    <>
      <Text style={styles.metricsHeader}>SHOT METRICS</Text>
      <MetricRow
        label="Clubhead speed"
        value={analysis.club.clubheadSpeedMph}
        unit=" mph"
        proValue={ref.pro.clubheadSpeedMph}
        amaValue={ref.amateur.clubheadSpeedMph}
      />
      <MetricRow
        label="Ball speed"
        value={analysis.club.ballSpeedMph}
        unit=" mph"
        proValue={ref.pro.ballSpeedMph}
        amaValue={ref.amateur.ballSpeedMph}
      />
      <MetricRow
        label="Smash factor"
        value={analysis.club.smashFactor}
        unit=""
        proValue={ref.pro.smashFactor}
        amaValue={ref.amateur.smashFactor}
        format={(v) => v.toFixed(2)}
      />
      <MetricRow
        label="Launch angle"
        value={analysis.club.launchAngleDeg}
        unit="°"
        proValue={ref.pro.launchAngleDeg}
        amaValue={ref.amateur.launchAngleDeg}
        higherIsBetter={false}
      />
      <MetricRow
        label="Spin"
        value={analysis.club.spinRpm}
        unit=" rpm"
        proValue={ref.pro.spinRpm}
        amaValue={ref.amateur.spinRpm}
        higherIsBetter={false}
      />
      <MetricRow
        label="Carry"
        value={analysis.club.carryYds}
        unit=" yds"
        proValue={ref.pro.carryYds}
        amaValue={ref.amateur.carryYds}
      />

      <Text style={[styles.metricsHeader, { marginTop: 22 }]}>BODY MECHANICS</Text>
      <MetricRow
        label="Tempo ratio"
        value={analysis.body.tempoRatio}
        unit=":1"
        proValue={ref.pro.tempoRatio}
        amaValue={ref.amateur.tempoRatio}
        format={(v) => v.toFixed(2)}
        hint="Backswing:downswing time. Pros average exactly 3:1."
      />
      <MetricRow
        label="Backswing time"
        value={analysis.body.backswingSec}
        unit=" s"
        proValue={ref.pro.backswingSec}
        amaValue={ref.amateur.backswingSec}
        format={(v) => v.toFixed(2)}
        higherIsBetter={false}
      />
      <MetricRow
        label="Downswing time"
        value={analysis.body.downswingSec}
        unit=" s"
        proValue={ref.pro.downswingSec}
        amaValue={ref.amateur.downswingSec}
        format={(v) => v.toFixed(2)}
        higherIsBetter={false}
      />
      <MetricRow
        label="Hip turn (top)"
        value={analysis.body.hipTurnDeg}
        unit="°"
        proValue={ref.pro.hipTurnDeg}
        amaValue={ref.amateur.hipTurnDeg}
      />
      <MetricRow
        label="Shoulder turn (top)"
        value={analysis.body.shoulderTurnDeg}
        unit="°"
        proValue={ref.pro.shoulderTurnDeg}
        amaValue={ref.amateur.shoulderTurnDeg}
      />
      <MetricRow
        label="X-factor (shoulder − hip)"
        value={analysis.body.xFactorDeg}
        unit="°"
        proValue={ref.pro.xFactorDeg}
        amaValue={ref.amateur.xFactorDeg}
        hint="Torsion stored at the top. More = more power potential."
      />
      <MetricRow
        label="Lateral hip shift"
        value={analysis.body.lateralHipShiftIn}
        unit='"'
        proValue={ref.pro.lateralHipShiftIn}
        amaValue={ref.amateur.lateralHipShiftIn}
      />
      <MetricRow
        label="Lead wrist hinge"
        value={analysis.body.leadWristHingeDeg}
        unit="°"
        proValue={ref.pro.leadWristHingeDeg}
        amaValue={ref.amateur.leadWristHingeDeg}
      />
      <MetricRow
        label="Spine angle"
        value={analysis.body.spineAngleDeg}
        unit="°"
        proValue={ref.pro.spineAngleDeg}
        amaValue={ref.amateur.spineAngleDeg}
      />
      <MetricRow
        label="Head movement"
        value={analysis.body.headMovementIn}
        unit='"'
        proValue={ref.pro.headMovementIn}
        amaValue={ref.amateur.headMovementIn}
        higherIsBetter={false}
        hint="Vertical bob during swing. Pros stay within 2 inches."
      />

      <Text style={styles.footnote}>
        Pro references are PGA Tour averages from Trackman / FlightScope.
        Rec-player references are the average 14-handicap male golfer.
      </Text>
    </>
  );
}

// ─── Metric row ──────────────────────────────────────────────────────────

interface MetricRowProps {
  label: string;
  /** null = we don't have a real measurement for this. Renders as "—". */
  value: number | null;
  unit: string;
  proValue: number;
  amaValue: number;
  /** True if "more is better" for this metric. Affects color coding. */
  higherIsBetter?: boolean;
  /** Custom value formatter (rounding etc.). */
  format?: (v: number) => string;
  /** Optional one-line explanation shown below the bar. */
  hint?: string;
}

function MetricRow({
  label, value, unit, proValue, amaValue,
  higherIsBetter = true, format, hint,
}: MetricRowProps) {
  const fmt = format ?? ((v: number) => String(v));

  // No real measurement — render a dim "—" row that still shows the
  // pro/amateur reference so the user sees what range this metric lives in,
  // without any pretense that we know their number.
  if (value == null) {
    return (
      <View style={styles.row}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={[styles.rowValue, { color: C.textDim }]}>—</Text>
        </View>
        <View style={styles.refRow}>
          <Text style={styles.refText}>Amateur · {fmt(amaValue)}{unit}</Text>
          <Text style={styles.refTextPro}>Pro · {fmt(proValue)}{unit}</Text>
        </View>
        <Text style={styles.notMeasured}>
          Not measured — requires launch monitor or scale calibration.
        </Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
    );
  }

  const interp = interpretDelta(value, proValue, amaValue, unit, higherIsBetter);
  const TONE_COLOR: Record<string, string> = {
    great: '#7aab78',
    good:  C.gold,
    fair:  C.goldLight,
    work:  '#b03434',
  };
  const tone = TONE_COLOR[interp.tone];

  // Slider position math — the bar spans amateur → pro, with the user's
  // value plotted somewhere along (or past) that range.
  const minVal = Math.min(amaValue, proValue);
  const maxVal = Math.max(amaValue, proValue);
  const span = maxVal - minVal;
  const pct = span > 0
    ? Math.max(-0.2, Math.min(1.2, (value - minVal) / span))
    : 0.5;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, { color: tone }]}>
          {fmt(value)}{unit}
        </Text>
      </View>

      <View style={styles.barTrack}>
        {/* Amateur reference marker (left tick) */}
        <View style={[styles.refTick, { left: '0%', backgroundColor: C.textMuted }]} />
        {/* Pro reference marker (right tick) */}
        <View style={[styles.refTick, { left: '100%', backgroundColor: C.gold }]} />
        {/* User value marker */}
        <View
          style={[
            styles.userMarker,
            {
              left: `${Math.max(0, Math.min(100, pct * 100))}%`,
              backgroundColor: tone,
              shadowColor: tone,
            },
          ]}
        />
      </View>
      <View style={styles.refRow}>
        <Text style={styles.refText}>Amateur · {fmt(amaValue)}{unit}</Text>
        <Text style={styles.refTextPro}>Pro · {fmt(proValue)}{unit}</Text>
      </View>

      <Text style={[styles.interp, { color: tone }]}>{interp.text}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  scroll: { padding: 20, paddingBottom: 60 },

  notFoundText: { color: C.text, fontSize: 14, textAlign: 'center', marginBottom: 16 },
  backBtn: { paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: C.gold, borderRadius: 6 },
  backBtnText: { color: C.gold, fontWeight: '700' },

  videoFrame: {
    width: '100%',
    aspectRatio: 9 / 16,
    backgroundColor: '#000',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 12,
  },
  video: { width: '100%', height: '100%' },

  // ── Toolbar (slo-mo + drawing controls) ───────────────────────────
  // Both rows share this shape: a leading label-chip on the left, then
  // a horizontally-scrollable cluster of action chips on the right.
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  toolbarLabel: {
    color: C.textMuted, fontSize: 10, fontWeight: '900',
    letterSpacing: 1.4, width: 54,
  },
  toolbarChips: {
    flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6,
  },
  rateChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    minWidth: 44, alignItems: 'center',
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
  playbar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  playBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' },
  scrubTrack: { flex: 1, height: 28, justifyContent: 'center' },
  scrubRail: { height: 6, borderRadius: 3, backgroundColor: C.border, overflow: 'hidden' },
  scrubFill: { height: 6, borderRadius: 3, backgroundColor: C.gold },
  timeText: { color: C.textMuted, fontSize: 11, fontWeight: '700', minWidth: 78, textAlign: 'right' },

  colorRow: {
    flexDirection: 'row', gap: 10,
    paddingLeft: 62,
    marginBottom: 8,
  },
  colorSwatch: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, borderColor: 'transparent',
  },
  colorSwatchActive: { borderColor: C.text },
  drawHint: {
    color: C.gold, fontSize: 11, fontStyle: 'italic',
    marginTop: 2, marginBottom: 8, paddingLeft: 62,
  },

  // View-mode tabs (kept for reference — pose mode is currently hidden).
  // eslint-disable-next-line
  viewModeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  viewModeTab: {
    flex: 1,
    paddingVertical: 11,
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 6,
    alignItems: 'center',
  },
  viewModeTabActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  viewModeLabel: { color: C.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  viewModeLabelActive: { color: C.gold },

  angleNote: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 4,
    marginBottom: 10,
    textAlign: 'center',
  },

  // Analysis-source banners — surfaces whether the player is looking at real
  // Vision-framework output or the template fallback. Two visual treatments
  // so the user can see at a glance which one they got.
  sourceBanner: {
    backgroundColor: '#b0343422',  // muted red — "be careful, this is mocked"
    borderColor: C.red,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  sourceBannerTitle: { color: C.red, fontWeight: '900', fontSize: 11, letterSpacing: 1.3 },
  sourceBannerBody:  { color: C.text, fontSize: 12, marginTop: 4, lineHeight: 17 },

  visionBanner: {
    backgroundColor: C.green + '22',
    borderColor: C.green,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  visionBannerTitle: { color: C.green, fontWeight: '900', fontSize: 11, letterSpacing: 1.3 },
  visionBannerBody:  { color: C.text, fontSize: 12, marginTop: 4, lineHeight: 17 },

  keyframeRow: { marginBottom: 16 },
  keyframeChip: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 6,
  },
  keyframeChipActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  keyframeLabel: { color: C.textMuted, fontWeight: '800', fontSize: 10, letterSpacing: 1 },
  keyframeLabelActive: { color: C.gold },

  analyzingBanner: {
    backgroundColor: C.gold + '14',
    borderColor: C.gold + '88',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  analyzingText: { color: C.text, fontSize: 13, flex: 1 },

  failedBanner: {
    backgroundColor: '#b0343422',
    borderColor: C.red,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  failedText: { color: C.red, fontWeight: '700', fontSize: 13 },

  metricsHeader: {
    color: C.gold,
    fontFamily: F.serif,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 1.5,
    marginBottom: 10,
    marginTop: 6,
  },

  row: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
  rowLabel: { color: C.text, fontSize: 13, fontWeight: '700' },
  rowValue: { fontFamily: F.serif, fontSize: 20, fontWeight: '900' },

  barTrack: {
    height: 6,
    backgroundColor: C.cardAlt,
    borderRadius: 3,
    position: 'relative',
    marginHorizontal: 6,
  },
  refTick: {
    position: 'absolute',
    width: 2,
    height: 12,
    top: -3,
    marginLeft: -1,
  },
  userMarker: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    top: -4,
    marginLeft: -7,
    borderWidth: 1.5,
    borderColor: C.bg,
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  refRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  refText: { color: C.textMuted, fontSize: 10 },
  refTextPro: { color: C.gold, fontSize: 10, fontWeight: '700' },

  interp: { fontSize: 12, marginTop: 8, lineHeight: 17 },
  hint: { color: C.textDim, fontSize: 10, marginTop: 3, fontStyle: 'italic' },
  notMeasured: { color: C.textMuted, fontSize: 11, marginTop: 8, fontStyle: 'italic' },

  footnote: {
    color: C.textDim,
    fontSize: 10,
    marginTop: 18,
    lineHeight: 15,
    fontStyle: 'italic',
  },
});
