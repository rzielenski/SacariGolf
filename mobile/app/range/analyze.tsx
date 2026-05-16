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

import { useEffect, useMemo, useState, useRef } from 'react';
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
  RangeSwing, loadSwings, SwingAnalysis, PoseFrame, Point, CameraAngle,
  normalizePoseFrame, interpolatePoseFrames,
} from '../../lib/rangeSession';
import { SwingPoseOverlay } from '../../components/SwingPoseOverlay';
import { ClubheadTracer } from '../../components/ClubheadTracer';

const { width: SCREEN_W } = Dimensions.get('window');

type Keyframe = 'address' | 'top' | 'impact' | 'followThrough';
const KEYFRAME_LABELS: Record<Keyframe, string> = {
  address: 'ADDRESS',
  top: 'TOP',
  impact: 'IMPACT',
  followThrough: 'FOLLOW-THROUGH',
};

type ViewMode = 'tracer' | 'pose';

export default function RangeAnalyze() {
  const { user } = useAuth();
  const { swing: swingId } = useLocalSearchParams<{ swing: string }>();
  const [swing, setSwing] = useState<RangeSwing | null | undefined>(undefined);
  // View mode is mutually exclusive — either you're watching the video
  // with the clubhead tracer overlay, OR you're in the pose studio
  // (black canvas, skeleton + ball, no video). Two distinct lenses on
  // the same swing data; the user picks via the tab row.
  const [viewMode, setViewMode] = useState<ViewMode>('tracer');
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const videoRef = useRef<Video>(null);

  // Load the swing from storage. `undefined` = still loading, `null` = not found.
  useEffect(() => {
    if (!user?.user_id || !swingId) return;
    (async () => {
      const all = await loadSwings(user.user_id);
      setSwing(all.find((s) => s.swing_id === swingId) ?? null);
    })();
  }, [user?.user_id, swingId]);

  // Track video playback time so the clubhead tracer can animate in sync.
  // We sample at iOS's natural ~60Hz status callback rate; if the user
  // scrubs, the tracer follows.
  const onPlaybackStatusUpdate = (s: AVPlaybackStatus) => {
    if (!s.isLoaded) return;
    setPlaybackTimeSec(s.positionMillis / 1000);
  };

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
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* ── View mode tabs ──────────────────────────────────────────
            Two distinct lenses: tracer view OVER the video, pose studio
            on its own black canvas. Mutually exclusive — one rendered
            at a time. */}
        <View style={styles.viewModeRow}>
          <TouchableOpacity
            style={[styles.viewModeTab, viewMode === 'tracer' && styles.viewModeTabActive]}
            onPress={() => setViewMode('tracer')}
          >
            <Text style={[styles.viewModeLabel, viewMode === 'tracer' && styles.viewModeLabelActive]}>
              VIDEO + TRACER
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.viewModeTab, viewMode === 'pose' && styles.viewModeTabActive]}
            onPress={() => setViewMode('pose')}
          >
            <Text style={[styles.viewModeLabel, viewMode === 'pose' && styles.viewModeLabelActive]}>
              POSE STUDIO
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── TRACER VIEW: actual video with clubhead trace overlay ── */}
        {viewMode === 'tracer' && (
          <View style={styles.videoFrame}>
            <Video
              ref={videoRef}
              source={{ uri: swing.video_uri }}
              style={styles.video}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              isLooping
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
          </View>
        )}

        {/* ── POSE STUDIO: animated black canvas, skeleton + ball + ground.
            Keyframe scrubber + play/pause live INSIDE the studio component
            so they sit directly under the canvas. */}
        {viewMode === 'pose' && swing.status === 'complete' && swing.result && (() => {
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

        {/* Camera-angle label so the user always sees what perspective
            their swing was filmed from. */}
        <Text style={styles.angleNote}>
          {swing.cameraAngle === 'down_the_line' ? 'DOWN-THE-LINE' : 'FACE-ON'} ·
          {' '}{CLUB_LABELS[swing.club] ?? swing.club}
        </Text>

        {/* Analysis-source banner — tells the user whether the numbers + skeleton
            + tracer are derived from real Vision-framework analysis of their
            video, or from the template fallback. Hidden when 'vision' to keep
            the surface clean; loud and clear when 'mock' so they don't think
            the template numbers are measurements. */}
        {swing.source === 'mock' && (
          <View style={styles.sourceBanner}>
            <Text style={styles.sourceBannerTitle}>BETA · TEMPLATE ANALYSIS</Text>
            <Text style={styles.sourceBannerBody}>
              Skeleton, tracer, and numbers below are SCHEMATIC — generated from
              your club + handicap, not from analysing the video. Vision-framework
              analysis requires a development build with the SwingAnalyzer
              module linked.
            </Text>
          </View>
        )}
        {swing.source === 'vision' && (
          <View style={styles.visionBanner}>
            <Text style={styles.visionBannerTitle}>VISION ANALYSIS</Text>
            <Text style={styles.visionBannerBody}>
              Skeleton and tracer derived from your actual video frames using
              Apple Vision framework. Speed / spin / carry numbers below are
              still estimates — those require a launch monitor.
            </Text>
          </View>
        )}

        {/* ── Analysis status banner ──────────────────────────────── */}
        {swing.status === 'analyzing' && (
          <View style={styles.analyzingBanner}>
            <ActivityIndicator color={C.gold} />
            <Text style={styles.analyzingText}>Analyzing swing — this takes a couple of seconds.</Text>
          </View>
        )}
        {swing.status === 'failed' && (
          <View style={styles.failedBanner}>
            <Text style={styles.failedText}>Analysis failed. Record the swing again to retry.</Text>
          </View>
        )}

        {/* ── Metrics ──────────────────────────────────────────────── */}
        {swing.status === 'complete' && swing.result && (
          <SwingMetrics analysis={swing.result} club={swing.club} />
        )}
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

// ─── Metrics section ─────────────────────────────────────────────────────

function SwingMetrics({ analysis, club }: { analysis: SwingAnalysis; club: string }) {
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
  value: number;
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
  const interp = interpretDelta(value, proValue, amaValue, unit, higherIsBetter);
  const fmt = format ?? ((v: number) => String(v));

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

  // View-mode tabs (Tracer ↔ Pose Studio). Sit above the visual area
  // because the user's first decision is "what lens am I looking through."
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

  footnote: {
    color: C.textDim,
    fontSize: 10,
    marginTop: 18,
    lineHeight: 15,
    fontStyle: 'italic',
  },
});
