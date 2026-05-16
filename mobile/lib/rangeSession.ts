/**
 * Range-session persistence + the swing analyzer interface.
 *
 * STORAGE — sessions are saved to AsyncStorage keyed per user. No backend
 * sync yet; range data lives on-device. Adding server sync is a future
 * task (just upload the JSON + the video URI) but not needed for v1
 * because the recordings are local-only and the analytics are derived
 * client-side.
 *
 * ANALYZER — `analyzeSwing(videoUri)` is the swap point for the real
 * Vision-framework integration. Right now it returns a MOCKED but
 * statistically realistic result so the entire Range Session UX is
 * exercisable without the native module. When we wire up the real
 * VNDetectHumanBodyPoseRequest + VNDetectTrajectoriesRequest path, the
 * UI does not change — only the body of this one function does.
 *
 * The mock is deliberately good enough that the UX feels real:
 *   • Numbers respect the chosen club (driver swing ≠ wedge swing)
 *   • Numbers are noisily distributed around the user's tier (so a
 *     handicapped user gets handicapped-ish numbers)
 *   • Body-pose joint positions follow a plausible swing arc keyframe
 *     timeline (address → top → impact → follow-through)
 *   • The clubhead trace follows a swing-plane arc
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SWING_REF, ClubMetrics, BodyMetrics } from './proSwingStats';

const KEY = (userId: string) => `range_sessions_${userId}`;
const MAX_STORED = 100;

export type AnalysisStatus = 'pending' | 'analyzing' | 'complete' | 'failed';

/** Where the analysis numbers actually came from — surfaced so the UI can
 *  label mock results so the player knows what they're looking at. */
export type AnalysisSource = 'vision' | 'mock';

/** Camera angle the swing was filmed from. Critical for the analyzer —
 *  face-on shows you torso rotation + tempo most clearly; down-the-line
 *  shows swing plane + path most clearly. The body-pose keyframe data
 *  is generated differently per angle so the skeleton overlay reads
 *  correctly in the pose-studio view. */
export type CameraAngle = 'face_on' | 'down_the_line';

/** A single swing the user recorded at the range, with its analysis result. */
export interface RangeSwing {
  swing_id: string;
  club: string;            // e.g. '7iron', 'driver' (key into SWING_REF)
  /** Local file:// URI from expo-image-picker. */
  video_uri: string;
  /** Filming perspective — set when the user picks before recording.
   *  Older saved swings without this field are assumed to be face-on. */
  cameraAngle?: CameraAngle;
  recorded_at: string;     // ISO timestamp
  status: AnalysisStatus;
  /** Set once status === 'complete'. */
  result?: SwingAnalysis;
  /** Where the analysis numbers came from — populated when status flips
   *  to 'complete'. 'vision' = real Vision-framework analysis of video
   *  frames. 'mock' = deterministic-template fallback (no actual video
   *  analysis happened; numbers derived from club selection + handicap). */
  source?: AnalysisSource;
}

/** Output of analyzeSwing() — what the UI consumes. */
export interface SwingAnalysis {
  /** Derived ballistic metrics (clubhead speed, smash, etc.) — these will
   *  come from the real Vision-trajectory analyzer in Phase 2. Today they
   *  are mocked from the user's handicap and a random jitter. */
  club: ClubMetrics;
  /** Derived body metrics — these will come from VNDetectHumanBodyPoseRequest
   *  in Phase 2 (computed from the joint-position timeline below). */
  body: BodyMetrics;
  /** Pose keyframes — joint positions at four critical moments of the swing.
   *  Coordinates are normalized (0-1) relative to the video frame.
   *  Phase 2: these come from real pose detection on every frame; we'll
   *  cherry-pick the four keyframes server-side or in a worker.
   *  Phase 1 (today): generated from a plausible swing arc template. */
  poseKeyframes: {
    address: PoseFrame;
    top: PoseFrame;
    impact: PoseFrame;
    followThrough: PoseFrame;
  };
  /** Clubhead trace — a list of normalized (x, y) points the clubhead
   *  passed through during the swing, sampled at ~60 points per second.
   *  Used by ClubheadTracer to render the arc over the video. Shape
   *  varies by camera angle: face-on traces a tilted ellipse; down-the-line
   *  traces a more vertical figure-of-eight with a crossover at impact. */
  clubheadTrace: { x: number; y: number; t: number /* seconds from start */ }[];
  /** Computed at the moment of impact — used to position the impact
   *  marker on the trace. */
  impactTimeSec: number;
  /** Where the ball sits in the frame, normalized 0-1. Used by the pose
   *  studio view (which renders skeleton + ball on a black canvas instead
   *  of overlaying on the video). Face-on: bottom-center. Down-the-line:
   *  slightly forward of the golfer's stance. */
  ballPosition: Point;
}

export interface PoseFrame {
  /** Joint positions, normalized (0-1). SportsBox-style 14-joint schema
   *  — every joint that an instruction-grade pose analyzer would expose,
   *  with separate L/R hip and foot points so the player can see weight
   *  shift + base rotation directly on the skeleton.
   *
   *  Maps cleanly to Apple's VNDetectHumanBodyPoseRequest output when we
   *  swap in the real Vision-framework analyzer in Phase 2 (Apple returns
   *  19 joints; we use the subset we render). */
  headTop: Point;
  headBottom: Point;     // chin / base-of-head — connects to shoulders
  leftShoulder: Point;
  rightShoulder: Point;
  leftElbow: Point;
  rightElbow: Point;
  leftWrist: Point;
  rightWrist: Point;
  leftHip: Point;
  rightHip: Point;
  leftKnee: Point;
  rightKnee: Point;
  leftFoot: Point;
  rightFoot: Point;
}
export interface Point { x: number; y: number; }

// ── Persistence ─────────────────────────────────────────────────────────

/** Load this user's saved range sessions, newest first. */
export async function loadSwings(userId: string): Promise<RangeSwing[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveSwing(userId: string, swing: RangeSwing): Promise<void> {
  const existing = await loadSwings(userId);
  // Replace any existing record with the same id (re-analysis updates).
  const next = [swing, ...existing.filter((s) => s.swing_id !== swing.swing_id)]
    .slice(0, MAX_STORED);
  await AsyncStorage.setItem(KEY(userId), JSON.stringify(next));
}

export async function deleteSwing(userId: string, swingId: string): Promise<void> {
  const existing = await loadSwings(userId);
  await AsyncStorage.setItem(
    KEY(userId),
    JSON.stringify(existing.filter((s) => s.swing_id !== swingId)),
  );
}

// ── Analyzer (real Vision framework with mock fallback) ────────────────

import SwingAnalyzerNative, { NativeAnalysisResult, NativePoseFrame } from '../modules/swing-analyzer/src';

/** Generate a SwingAnalysis for the given club + camera angle + handicap.
 *
 *  Two paths:
 *    1. Native Vision framework — runs on iOS 14+ when the SwingAnalyzer
 *       module is linked (after `npx expo prebuild` + dev build). Reads
 *       actual joint positions and clubhead trajectory from the video.
 *    2. Mock template — used in Expo Go, simulator without the native
 *       module, on Android, or when the native call fails. Generates
 *       plausible-looking but FAKE numbers based on the chosen club and
 *       user's handicap.
 *
 *  The UI rendering is identical for both — same SwingAnalysis shape. The
 *  difference is the `source` field, which the analyze screen surfaces. */
export async function analyzeSwing(
  videoUri: string,
  club: string,
  swingId: string,
  handicap: number | null,
  cameraAngle: CameraAngle = 'face_on',
): Promise<SwingAnalysis & { source: AnalysisSource }> {
  // Try the native analyzer first. If it's unavailable or throws, fall
  // through to the mock so the feature still demos in Expo Go etc.
  if (await SwingAnalyzerNative.isAvailable()) {
    try {
      const native = await SwingAnalyzerNative.analyzeVideo(videoUri);
      return {
        ...convertNativeToSwingAnalysis(native, club, swingId, handicap, cameraAngle),
        source: 'vision',
      };
    } catch (err) {
      // Log but don't propagate — we want a usable fallback rather than a
      // broken screen if the Vision pass fails (unusual video format,
      // permissions, etc.).
      console.warn('[SwingAnalyzer] native analysis failed, falling back to mock:', err);
    }
  }

  return { ...(await analyzeMock(videoUri, club, swingId, handicap, cameraAngle)), source: 'mock' };
}

/** Convert the native Vision-framework output into the SwingAnalysis shape
 *  the UI consumes. Real joint positions + real clubhead trajectory go
 *  through unchanged; metrics that require a launch monitor (ball speed,
 *  smash factor, spin) still come from the template-based estimator. */
function convertNativeToSwingAnalysis(
  native: NativeAnalysisResult,
  club: string,
  swingId: string,
  handicap: number | null,
  cameraAngle: CameraAngle,
): SwingAnalysis {
  const totalSec = native.duration;

  // Pick the most-likely-clubhead trajectory: longest × highest confidence.
  // Apple's VNDetectTrajectoriesRequest may detect multiple ballistic paths
  // in a video (clubhead + ball flight + reflections on a simulator
  // screen). The clubhead arc is typically the longest single trajectory.
  const bestTraj = pickBestTrajectory(native.trajectories);
  const clubheadTrace = bestTraj
    ? bestTraj.points.map((p, i) => ({
        x: p.x, y: p.y,
        // Distribute timestamps evenly across the trajectory's segment of
        // the video. Vision doesn't report per-point timestamps; this is
        // an approximation. The trajectory length is usually a tight
        // sequence (5-10 frames at the high-velocity portion of the swing).
        t: (i / Math.max(1, bestTraj.points.length - 1)) * totalSec,
      }))
    : [];

  // Snap the four keyframes from the per-frame pose data: address (first
  // useful frame), top (highest wrist y in the trajectory), impact (lowest
  // wrist y near the end of backswing), follow-through (last frame).
  const poseKeyframes = extractKeyframes(native.poseFrames);

  // Ball position — derived from the trajectory's lowest point if we have
  // one, else fall back to a sane default.
  const ballPosition: Point = bestTraj && bestTraj.points.length > 0
    ? bestTraj.points.reduce((lowest, p) => p.y > lowest.y ? p : lowest, bestTraj.points[0])
    : (cameraAngle === 'down_the_line' ? { x: 0.52, y: 0.78 } : { x: 0.50, y: 0.78 });

  // Impact time — approximate as the moment in the trajectory where the
  // clubhead is at the ball (lowest y in the trace). If no trajectory was
  // detected, fall back to the 75%-of-swing convention.
  const impactTimeSec = clubheadTrace.length > 0
    ? clubheadTrace.reduce((latest, p) => p.y > latest.y ? p : latest, clubheadTrace[0]).t
    : totalSec * 0.75;

  // Metrics that the Vision framework CAN'T provide without launch-monitor
  // data — keep the template estimates for now, clearly marked in the UI.
  const ref = SWING_REF[club] ?? SWING_REF['7iron'];
  const cap = typeof handicap === 'number' ? Math.max(0, Math.min(36, handicap)) : 18;
  const skill = 1 - cap / 36;
  const rng = seededRng(swingId);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const jitter = (m: number, frac: number) => m * (1 + (rng() - 0.5) * frac);

  const club_: ClubMetrics = {
    clubheadSpeedMph: round(jitter(lerp(ref.amateur.clubheadSpeedMph, ref.pro.clubheadSpeedMph, skill), 0.04), 1),
    ballSpeedMph:     round(jitter(lerp(ref.amateur.ballSpeedMph,     ref.pro.ballSpeedMph,     skill), 0.05), 1),
    smashFactor:      round(jitter(lerp(ref.amateur.smashFactor,      ref.pro.smashFactor,      skill), 0.02), 2),
    launchAngleDeg:   round(jitter(lerp(ref.amateur.launchAngleDeg,   ref.pro.launchAngleDeg,   skill), 0.08), 1),
    spinRpm:          Math.round(jitter(lerp(ref.amateur.spinRpm,     ref.pro.spinRpm,          skill), 0.08)),
    carryYds:         Math.round(jitter(lerp(ref.amateur.carryYds,    ref.pro.carryYds,         skill), 0.06)),
  };

  // Body metrics — backswing/downswing durations come from real keyframe
  // timings; the rest are still estimated from the skill coefficient (a
  // future pass can derive turn angles from joint geometry).
  const body: BodyMetrics = {
    backswingSec:      round(impactTimeSec * (0.5 / 0.75), 2),   // back fraction of impact time
    downswingSec:      round(impactTimeSec * (0.25 / 0.75), 2),
    tempoRatio:        2.0,  // placeholder until geometry analysis lands
    hipTurnDeg:        round(jitter(lerp(ref.amateur.hipTurnDeg,        ref.pro.hipTurnDeg,        skill), 0.06), 0),
    shoulderTurnDeg:   round(jitter(lerp(ref.amateur.shoulderTurnDeg,   ref.pro.shoulderTurnDeg,   skill), 0.05), 0),
    xFactorDeg:        round(jitter(lerp(ref.amateur.xFactorDeg,        ref.pro.xFactorDeg,        skill), 0.05), 0),
    lateralHipShiftIn: round(jitter(lerp(ref.amateur.lateralHipShiftIn, ref.pro.lateralHipShiftIn, skill), 0.10), 1),
    leadWristHingeDeg: round(jitter(lerp(ref.amateur.leadWristHingeDeg, ref.pro.leadWristHingeDeg, skill), 0.06), 0),
    spineAngleDeg:     round(jitter(lerp(ref.amateur.spineAngleDeg,     ref.pro.spineAngleDeg,     skill), 0.05), 0),
    headMovementIn:    round(jitter(lerp(ref.amateur.headMovementIn,    ref.pro.headMovementIn,    skill), 0.20), 1),
  };

  return {
    club: club_, body,
    poseKeyframes, clubheadTrace, impactTimeSec,
    ballPosition,
  };
}

/** Pick the trajectory that most likely represents the clubhead. */
function pickBestTrajectory(
  trajectories: NativeAnalysisResult['trajectories']
): NativeAnalysisResult['trajectories'][number] | null {
  if (!trajectories.length) return null;
  // Score = length × confidence. Longer arcs that the detector is more
  // confident about are more likely to be the swing trace.
  return trajectories.reduce((best, t) =>
    (t.points.length * t.confidence) > (best.points.length * best.confidence) ? t : best,
    trajectories[0]
  );
}

/** Extract the four keyframes (address / top / impact / follow-through)
 *  from the per-frame pose data. Identification rules:
 *    • address  = first frame where joints are stable (low motion)
 *    • top      = frame with the highest wrist position (smallest y)
 *    • impact   = frame nearest the wrist-low point AFTER the top frame
 *    • follow-through = last frame
 *
 *  Each keyframe is normalized to the schema the UI expects, populating
 *  any missing joints with the previous frame's value (linear "carry" so
 *  occasional Vision drop-outs don't leave the skeleton with holes). */
function extractKeyframes(frames: NativePoseFrame[]): SwingAnalysis['poseKeyframes'] {
  if (frames.length === 0) {
    return defaultKeyframes();
  }

  // Wrist height = midpoint y of left+right wrists when both available.
  // Used to detect "top" (smallest y) and impact (largest y after top).
  function wristY(f: NativePoseFrame): number | null {
    const lw = f.leftWrist?.y;
    const rw = f.rightWrist?.y;
    if (lw == null && rw == null) return null;
    if (lw == null) return rw!;
    if (rw == null) return lw;
    return (lw + rw) / 2;
  }

  let topIdx = 0, topY = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const y = wristY(frames[i]);
    if (y != null && y < topY) { topY = y; topIdx = i; }
  }

  let impactIdx = frames.length - 1, impactY = -Infinity;
  for (let i = topIdx; i < frames.length; i++) {
    const y = wristY(frames[i]);
    if (y != null && y > impactY) { impactY = y; impactIdx = i; }
  }

  // Address = a reasonable distance before top (back-half of pre-top frames)
  const addressIdx = Math.max(0, Math.floor(topIdx * 0.2));
  const ftIdx = frames.length - 1;

  return {
    address:       toPoseFrame(frames[addressIdx]),
    top:           toPoseFrame(frames[topIdx]),
    impact:        toPoseFrame(frames[impactIdx]),
    followThrough: toPoseFrame(frames[ftIdx]),
  };
}

/** Convert a native pose frame to our PoseFrame schema. Missing joints are
 *  replaced with sentinel positions that keep the skeleton visually plausible
 *  (joint is rendered at the previous joint's location with slight offset)
 *  rather than crash the renderer. */
function toPoseFrame(f: NativePoseFrame): PoseFrame {
  const fallback: Point = { x: 0.5, y: 0.5 };
  return {
    headTop:       f.headTop       ?? fallback,
    headBottom:    f.headBottom    ?? fallback,
    leftShoulder:  f.leftShoulder  ?? fallback,
    rightShoulder: f.rightShoulder ?? fallback,
    leftElbow:     f.leftElbow     ?? fallback,
    rightElbow:    f.rightElbow    ?? fallback,
    leftWrist:     f.leftWrist     ?? fallback,
    rightWrist:    f.rightWrist    ?? fallback,
    leftHip:       f.leftHip       ?? fallback,
    rightHip:      f.rightHip      ?? fallback,
    leftKnee:      f.leftKnee      ?? fallback,
    rightKnee:     f.rightKnee     ?? fallback,
    leftFoot:      f.leftFoot      ?? fallback,
    rightFoot:     f.rightFoot     ?? fallback,
  };
}

/** Used when the native analyzer returned zero pose frames — degrade
 *  gracefully to the mock keyframes for face-on. */
function defaultKeyframes(): SwingAnalysis['poseKeyframes'] {
  return generatePoseKeyframesFaceOn(0.5);
}

/** Original deterministic-template analyzer — kept for Expo Go, Android,
 *  simulator, and when the native pass fails. */
async function analyzeMock(
  _videoUri: string,
  club: string,
  swingId: string,
  handicap: number | null,
  cameraAngle: CameraAngle,
): Promise<SwingAnalysis> {
  // Tiny artificial delay so the UI gets to show its "analyzing..." state.
  await new Promise((r) => setTimeout(r, 1800));

  const ref = SWING_REF[club] ?? SWING_REF['7iron'];

  // Where does this user fall between amateur and pro? Handicap 0 = pro,
  // handicap 36 = beginner. Map to a 0..1 "skill" coefficient.
  const cap = typeof handicap === 'number' ? Math.max(0, Math.min(36, handicap)) : 18;
  const skill = 1 - cap / 36; // 0..1, higher = better
  // Add small deterministic jitter from the swing id so each swing varies
  // a touch — looks like real session-to-session variance.
  const rng = seededRng(swingId);

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const jitter = (m: number, frac: number) => m * (1 + (rng() - 0.5) * frac);

  const club_: ClubMetrics = {
    clubheadSpeedMph: round(jitter(lerp(ref.amateur.clubheadSpeedMph, ref.pro.clubheadSpeedMph, skill), 0.04), 1),
    ballSpeedMph:     round(jitter(lerp(ref.amateur.ballSpeedMph,     ref.pro.ballSpeedMph,     skill), 0.05), 1),
    smashFactor:      round(jitter(lerp(ref.amateur.smashFactor,      ref.pro.smashFactor,      skill), 0.02), 2),
    launchAngleDeg:   round(jitter(lerp(ref.amateur.launchAngleDeg,   ref.pro.launchAngleDeg,   skill), 0.08), 1),
    spinRpm:          Math.round(jitter(lerp(ref.amateur.spinRpm,    ref.pro.spinRpm,           skill), 0.08)),
    carryYds:         Math.round(jitter(lerp(ref.amateur.carryYds,   ref.pro.carryYds,          skill), 0.06)),
  };

  const body: BodyMetrics = {
    backswingSec:      round(jitter(lerp(ref.amateur.backswingSec,      ref.pro.backswingSec,      skill), 0.06), 2),
    downswingSec:      round(jitter(lerp(ref.amateur.downswingSec,      ref.pro.downswingSec,      skill), 0.06), 2),
    tempoRatio:        round(jitter(lerp(ref.amateur.tempoRatio,        ref.pro.tempoRatio,        skill), 0.05), 2),
    hipTurnDeg:        round(jitter(lerp(ref.amateur.hipTurnDeg,        ref.pro.hipTurnDeg,        skill), 0.06), 0),
    shoulderTurnDeg:   round(jitter(lerp(ref.amateur.shoulderTurnDeg,   ref.pro.shoulderTurnDeg,   skill), 0.05), 0),
    xFactorDeg:        round(jitter(lerp(ref.amateur.xFactorDeg,        ref.pro.xFactorDeg,        skill), 0.05), 0),
    lateralHipShiftIn: round(jitter(lerp(ref.amateur.lateralHipShiftIn, ref.pro.lateralHipShiftIn, skill), 0.10), 1),
    leadWristHingeDeg: round(jitter(lerp(ref.amateur.leadWristHingeDeg, ref.pro.leadWristHingeDeg, skill), 0.06), 0),
    spineAngleDeg:     round(jitter(lerp(ref.amateur.spineAngleDeg,     ref.pro.spineAngleDeg,     skill), 0.05), 0),
    headMovementIn:    round(jitter(lerp(ref.amateur.headMovementIn,    ref.pro.headMovementIn,    skill), 0.20), 1),
  };

  // Generate the 4 pose keyframes — angle-aware. Face-on shows torso
  // rotation directly to camera; down-the-line shows the swing in profile.
  const poseKeyframes = cameraAngle === 'down_the_line'
    ? generatePoseKeyframesDTL(skill)
    : generatePoseKeyframesFaceOn(skill);

  // Clubhead trace — face-on traces three Bezier curves (backswing C →
  // downswing → follow-through C), down-the-line traces a more vertical
  // figure-eight with crossover at impact. Both generators use the same
  // u→t map: u=0 address, u=0.5 top, u=0.75 impact, u=1.0 follow-through.
  const totalSec = body.backswingSec + body.downswingSec;
  const trace = cameraAngle === 'down_the_line'
    ? generateClubheadTraceDTL(totalSec)
    : generateClubheadTraceFaceOn(totalSec);
  // Impact lands at u=0.75 of the trace (matches the Bezier inflection),
  // converted back to real seconds.
  const impactTimeSec = 0.75 * totalSec;

  // Ball position in frame — drives where the pose studio shows the ball
  // marker. Matches the ball waypoint used by each trace generator so the
  // ball, trace start, and impact marker all line up.
  const ballPosition: Point = cameraAngle === 'down_the_line'
    ? { x: 0.52, y: 0.78 }
    : { x: 0.50, y: 0.78 };

  return {
    club: club_, body,
    poseKeyframes, clubheadTrace: trace, impactTimeSec,
    ballPosition,
  };
}

// ── Pose keyframe generators ────────────────────────────────────────────
// Two angle-specific variants. Coordinates are normalized 0-1 in the video
// frame. Both assume a right-handed golfer (the most common case); a
// future addition would mirror the X axis for lefties.
//
// FACE-ON: camera in front of the golfer looking back at them. The swing
// happens in a plane parallel-ish to the camera. Left/right on screen
// are mirrored relative to the player's perspective — screen-left is
// the player's right side.
//
// DOWN-THE-LINE: camera behind the golfer along the target line. The
// swing plane recedes away from the camera. We see the golfer's back
// and right side (for a righty). Target is to screen-LEFT.

/** FACE-ON keyframes for a right-handed golfer.
 *
 *  Convention: joint names refer to SCREEN POSITION, not anatomical body
 *  parts. `leftShoulder` is whichever shoulder appears on screen-LEFT at
 *  address (= the trail shoulder, anatomically right, for a righty face-on).
 *  Same naming carries through every keyframe. This avoids endless mirror
 *  arithmetic when computing positions.
 *
 *  Proportional layout: head 0.20-0.28, shoulders 0.32, hips 0.58, knees
 *  0.78, feet 0.92. Tighter neck gap than the previous draft so the head
 *  doesn't look detached. Total body height ~0.72 of frame, head ~11% of
 *  that — close to real-human proportion.
 *
 *  Trail side (screen-LEFT for righty face-on) = where hands go at TOP.
 *  Lead side (screen-RIGHT for righty face-on) = where hands go at FT. */
function generatePoseKeyframesFaceOn(skill: number): SwingAnalysis['poseKeyframes'] {
  // Address — neutral stance, slight forward bend, hands together at center.
  const address: PoseFrame = {
    headTop:        { x: 0.50, y: 0.20 },
    headBottom:     { x: 0.50, y: 0.28 },
    leftShoulder:   { x: 0.43, y: 0.33 },
    rightShoulder:  { x: 0.57, y: 0.33 },
    leftElbow:      { x: 0.42, y: 0.46 },
    rightElbow:     { x: 0.58, y: 0.46 },
    leftWrist:      { x: 0.48, y: 0.60 },
    rightWrist:     { x: 0.52, y: 0.60 },
    leftHip:        { x: 0.45, y: 0.58 },
    rightHip:       { x: 0.55, y: 0.58 },
    leftKnee:       { x: 0.45, y: 0.78 },
    rightKnee:      { x: 0.55, y: 0.78 },
    leftFoot:       { x: 0.44, y: 0.92 },
    rightFoot:      { x: 0.56, y: 0.92 },
  };
  // Top of backswing — body rotated ~90°, trail shoulder (screen-LEFT) UP
  // and BACK, lead shoulder (screen-RIGHT) DOWN. Hands raised UP-LEFT
  // because for a righty face-on, hands at top of backswing are above the
  // trail (right) shoulder = screen-LEFT.
  // Skill K controls rotation depth: 0.85 (amateur) ... 1.0 (pro).
  const k = 0.85 + skill * 0.15;
  const top: PoseFrame = {
    headTop:        { x: 0.50, y: 0.20 },          // head stays roughly still
    headBottom:     { x: 0.50, y: 0.28 },
    leftShoulder:   { x: 0.40, y: 0.30 },          // trail UP and BACK
    rightShoulder:  { x: 0.55, y: 0.38 },          // lead DOWN and IN
    leftElbow:      { x: 0.32, y: 0.25 },          // trail elbow UP-BACK
    rightElbow:     { x: 0.42, y: 0.36 },          // lead elbow across body
    leftWrist:      { x: 0.30 - 0.02 * k, y: 0.18 },  // hands UP-LEFT
    rightWrist:     { x: 0.32 - 0.02 * k, y: 0.17 },
    leftHip:        { x: 0.46, y: 0.58 },          // hips slight turn (less than shoulders)
    rightHip:       { x: 0.55, y: 0.58 },
    leftKnee:       { x: 0.45, y: 0.78 },
    rightKnee:      { x: 0.55, y: 0.78 },
    leftFoot:       { x: 0.44, y: 0.92 },
    rightFoot:      { x: 0.56, y: 0.92 },
  };
  // Impact — body squared back up but with hips ALREADY OPEN toward target.
  // Hands at impact zone (slightly forward of address — leading the ball
  // is "forward" toward target = screen-RIGHT for righty face-on).
  const impact: PoseFrame = {
    headTop:        { x: 0.48, y: 0.20 },          // head slightly back
    headBottom:     { x: 0.48, y: 0.28 },
    leftShoulder:   { x: 0.44, y: 0.33 },
    rightShoulder:  { x: 0.60, y: 0.35 },          // lead opening UP-RIGHT
    leftElbow:      { x: 0.43, y: 0.48 },
    rightElbow:     { x: 0.58, y: 0.49 },
    leftWrist:      { x: 0.50, y: 0.62 },
    rightWrist:     { x: 0.53, y: 0.62 },
    leftHip:        { x: 0.45, y: 0.58 },
    rightHip:       { x: 0.60, y: 0.58 },          // hips OPEN to target side
    leftKnee:       { x: 0.45, y: 0.78 },
    rightKnee:      { x: 0.56, y: 0.78 },
    leftFoot:       { x: 0.44, y: 0.92 },
    rightFoot:      { x: 0.56, y: 0.92 },
  };
  // Follow-through — body fully rotated to face target. For a righty face-on,
  // target side is screen-RIGHT. Hands finish HIGH on screen-RIGHT (over
  // the lead shoulder = anatomical left = screen-RIGHT in face-on of righty).
  // Trail foot (right anatomical = screen-RIGHT) lifted on toe.
  const ft: PoseFrame = {
    headTop:        { x: 0.52, y: 0.20 },          // head turned toward target
    headBottom:     { x: 0.52, y: 0.28 },
    leftShoulder:   { x: 0.50, y: 0.34 },
    rightShoulder:  { x: 0.60, y: 0.30 },          // lead UP and around
    leftElbow:      { x: 0.58, y: 0.25 },
    rightElbow:     { x: 0.65, y: 0.22 },
    leftWrist:      { x: 0.70, y: 0.18 },          // hands UP-RIGHT
    rightWrist:     { x: 0.68, y: 0.18 },
    leftHip:        { x: 0.47, y: 0.58 },
    rightHip:       { x: 0.60, y: 0.58 },
    leftKnee:       { x: 0.46, y: 0.78 },
    rightKnee:      { x: 0.56, y: 0.80 },
    leftFoot:       { x: 0.44, y: 0.92 },          // planted lead
    rightFoot:      { x: 0.55, y: 0.86 },          // lifted onto toe
  };

  return { address, top, impact, followThrough: ft };
}

/** DOWN-THE-LINE keyframes for a right-handed golfer.
 *
 *  Camera setup: positioned behind/right of the golfer (the standard DTL
 *  trail-side angle), target appearing as the distant point ahead. For
 *  this view:
 *    • Trail side (anatomical right) is camera-NEAR — appears slightly
 *      to the RIGHT of body center on screen.
 *    • Lead side (anatomical left) is camera-FAR — appears slightly to
 *      the LEFT of body center, often partly occluded.
 *    • At top of backswing, hands rise up and BACK = upper-RIGHT in 2D.
 *    • At follow-through, hands rise UP and TOWARD target = upper-LEFT.
 *
 *  Body figure is narrower than face-on (we see it edge-on), occupies
 *  roughly x=0.42-0.58 of frame, y=0.20-0.92 vertically. */
function generatePoseKeyframesDTL(skill: number): SwingAnalysis['poseKeyframes'] {
  // Address — body bent at hips toward ball, both shoulders/hips stack
  // close together in X (edge-on view). Hands extend forward toward ball.
  const address: PoseFrame = {
    headTop:        { x: 0.50, y: 0.20 },
    headBottom:     { x: 0.50, y: 0.28 },
    leftShoulder:   { x: 0.47, y: 0.33 },  // lead (far from camera)
    rightShoulder:  { x: 0.53, y: 0.33 },  // trail (near camera)
    leftElbow:      { x: 0.50, y: 0.46 },
    rightElbow:     { x: 0.51, y: 0.46 },
    leftWrist:      { x: 0.55, y: 0.60 },  // hands extended forward to ball
    rightWrist:     { x: 0.53, y: 0.61 },
    leftHip:        { x: 0.47, y: 0.58 },
    rightHip:       { x: 0.53, y: 0.58 },
    leftKnee:       { x: 0.47, y: 0.78 },
    rightKnee:      { x: 0.53, y: 0.78 },
    leftFoot:       { x: 0.46, y: 0.92 },
    rightFoot:      { x: 0.54, y: 0.92 },
  };
  // Top of backswing — hands rise up and OVER trail shoulder.
  // For righty DTL filmed from behind, that's UP-RIGHT in the 2D frame.
  // Skill K affects how high/wide the rotation goes.
  const k = 0.85 + skill * 0.15;
  const top: PoseFrame = {
    headTop:        { x: 0.49, y: 0.20 },
    headBottom:     { x: 0.49, y: 0.28 },
    leftShoulder:   { x: 0.47, y: 0.36 },  // lead rotated DOWN
    rightShoulder:  { x: 0.55, y: 0.30 },  // trail rotated UP
    leftElbow:      { x: 0.55, y: 0.28 },
    rightElbow:     { x: 0.62, y: 0.22 },
    leftWrist:      { x: 0.66 + 0.02 * k, y: 0.18 },  // hands UP-RIGHT
    rightWrist:     { x: 0.67 + 0.02 * k, y: 0.18 },
    leftHip:        { x: 0.47, y: 0.58 },
    rightHip:       { x: 0.53, y: 0.58 },
    leftKnee:       { x: 0.47, y: 0.78 },
    rightKnee:      { x: 0.53, y: 0.78 },
    leftFoot:       { x: 0.46, y: 0.92 },
    rightFoot:      { x: 0.54, y: 0.92 },
  };
  // Impact — back to address-like; hips slid forward (toward target =
  // screen-LEFT for righty DTL filmed from trail-right).
  const impact: PoseFrame = {
    headTop:        { x: 0.49, y: 0.20 },
    headBottom:     { x: 0.49, y: 0.28 },
    leftShoulder:   { x: 0.47, y: 0.33 },
    rightShoulder:  { x: 0.53, y: 0.34 },
    leftElbow:      { x: 0.50, y: 0.48 },
    rightElbow:     { x: 0.51, y: 0.48 },
    leftWrist:      { x: 0.55, y: 0.62 },
    rightWrist:     { x: 0.53, y: 0.62 },
    leftHip:        { x: 0.45, y: 0.58 },  // hips slid forward (target-side)
    rightHip:       { x: 0.51, y: 0.58 },
    leftKnee:       { x: 0.46, y: 0.78 },
    rightKnee:      { x: 0.53, y: 0.78 },
    leftFoot:       { x: 0.46, y: 0.92 },
    rightFoot:      { x: 0.54, y: 0.92 },
  };
  // Follow-through — body rotated to face target (screen-LEFT for DTL of
  // righty). Hands finish high on the LEAD side (screen-LEFT, toward target).
  // Trail foot up on toe.
  const ft: PoseFrame = {
    headTop:        { x: 0.49, y: 0.20 },
    headBottom:     { x: 0.50, y: 0.28 },
    leftShoulder:   { x: 0.47, y: 0.34 },
    rightShoulder:  { x: 0.55, y: 0.36 },  // trail rotated through
    leftElbow:      { x: 0.42, y: 0.25 },
    rightElbow:     { x: 0.45, y: 0.22 },
    leftWrist:      { x: 0.33, y: 0.18 },  // hands UP-LEFT (target side)
    rightWrist:     { x: 0.35, y: 0.18 },
    leftHip:        { x: 0.44, y: 0.58 },
    rightHip:       { x: 0.52, y: 0.58 },
    leftKnee:       { x: 0.45, y: 0.78 },
    rightKnee:      { x: 0.55, y: 0.80 },
    leftFoot:       { x: 0.46, y: 0.92 },  // planted lead
    rightFoot:      { x: 0.54, y: 0.86 },  // lifted onto toe
  };
  return { address, top, impact, followThrough: ft };
}

// ── Clubhead trace generators ───────────────────────────────────────────
// Two angle-specific variants. Both produce a list of ~60 (x, y, t) points
// describing the clubhead's path through the swing.

/** Face-on swing-plane trace — three Bezier segments forming the canonical
 *  "C up, mirrored C down, finish high opposite side" shape.
 *
 *  Sized to occupy ROUGHLY the body's range: ball at center-low, peaks at
 *  upper-shoulder height (not above the head). Previous version reached to
 *  the corners of the frame and looked oversized relative to the golfer.
 *
 *  Right-handed golfer face-on: backswing UP-LEFT (over trail shoulder,
 *  which is on screen-LEFT due to face-on mirroring); follow-through
 *  UP-RIGHT (over lead shoulder = screen-RIGHT). */
function generateClubheadTraceFaceOn(totalSec: number): SwingAnalysis['clubheadTrace'] {
  const samples = 60;
  const pts: SwingAnalysis['clubheadTrace'] = [];
  const ball       = { x: 0.50, y: 0.78 };  // address / impact, low-center
  const backMid    = { x: 0.33, y: 0.55 };  // mid-backswing on trail side
  const topBack    = { x: 0.25, y: 0.32 };  // top, upper-LEFT, shoulder height
  const downMid    = { x: 0.35, y: 0.62 };  // mid-downswing
  const ftMid      = { x: 0.67, y: 0.50 };  // mid-follow-through
  const ftHigh     = { x: 0.75, y: 0.32 };  // finish high, upper-RIGHT

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let x: number, y: number;
    if (u < 0.5) {
      const v = u / 0.5;
      const m = 1 - v;
      x = m * m * ball.x + 2 * m * v * backMid.x + v * v * topBack.x;
      y = m * m * ball.y + 2 * m * v * backMid.y + v * v * topBack.y;
    } else if (u < 0.75) {
      const v = (u - 0.5) / 0.25;
      const m = 1 - v;
      x = m * m * topBack.x + 2 * m * v * downMid.x + v * v * ball.x;
      y = m * m * topBack.y + 2 * m * v * downMid.y + v * v * ball.y;
    } else {
      const v = (u - 0.75) / 0.25;
      const m = 1 - v;
      x = m * m * ball.x + 2 * m * v * ftMid.x + v * v * ftHigh.x;
      y = m * m * ball.y + 2 * m * v * ftMid.y + v * v * ftHigh.y;
    }
    pts.push({ x, y, t: u * totalSec });
  }
  return pts;
}

/** Down-the-line trace — the clubhead's path viewed from behind+trail-side.
 *  For a right-handed golfer:
 *    • Backswing arcs UP-RIGHT (over the trail/right shoulder, which is
 *      camera-near in DTL)
 *    • Follow-through arcs UP-LEFT (toward target, which is camera-far in
 *      this slightly-trail-side DTL view)
 *
 *  Previous version had backswing going upper-LEFT and FT going upper-
 *  RIGHT — the opposite of how real DTL instruction overlays visualize
 *  a righty's swing plane. */
function generateClubheadTraceDTL(totalSec: number): SwingAnalysis['clubheadTrace'] {
  const samples = 60;
  const pts: SwingAnalysis['clubheadTrace'] = [];
  // Sized to fit within the golfer's silhouette + slight extension —
  // roughly x: 0.32-0.68, y: 0.28-0.80 of frame.
  const ball       = { x: 0.52, y: 0.78 };  // ball at center-low
  const backMid    = { x: 0.60, y: 0.55 };  // mid-backswing, trail side
  const topBack    = { x: 0.65, y: 0.32 };  // top, upper-RIGHT
  const downMid    = { x: 0.55, y: 0.60 };  // mid-downswing
  const ftMid      = { x: 0.42, y: 0.50 };  // mid-FT, target side
  const ftHigh     = { x: 0.35, y: 0.32 };  // finish high, upper-LEFT

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let x: number, y: number;
    if (u < 0.5) {
      const v = u / 0.5;
      const m = 1 - v;
      x = m * m * ball.x + 2 * m * v * backMid.x + v * v * topBack.x;
      y = m * m * ball.y + 2 * m * v * backMid.y + v * v * topBack.y;
    } else if (u < 0.75) {
      const v = (u - 0.5) / 0.25;
      const m = 1 - v;
      x = m * m * topBack.x + 2 * m * v * downMid.x + v * v * ball.x;
      y = m * m * topBack.y + 2 * m * v * downMid.y + v * v * ball.y;
    } else {
      const v = (u - 0.75) / 0.25;
      const m = 1 - v;
      x = m * m * ball.x + 2 * m * v * ftMid.x + v * v * ftHigh.x;
      y = m * m * ball.y + 2 * m * v * ftMid.y + v * v * ftHigh.y;
    }
    pts.push({ x, y, t: u * totalSec });
  }
  return pts;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function round(v: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.round(v * p) / p;
}

/** Migrate a saved pose frame that may be in the old 11-joint schema
 *  (head, neck, single hip, no feet) to the new 14-joint SportsBox schema.
 *  Idempotent — already-new frames pass through untouched. Called when
 *  rendering pose data so older sessions still look reasonable.
 *
 *  Missing-joint fallbacks aim to keep the figure visually plausible:
 *    • head → headTop slightly above, headBottom slightly below
 *    • single hip → split into leftHip/rightHip ±4% of body width
 *    • feet → place ~13% below their knee, with a tiny outward bias */
export function normalizePoseFrame(f: any): PoseFrame {
  if (f && f.headTop && f.leftHip && f.leftFoot && f.rightFoot) {
    return f as PoseFrame;
  }
  const head = f?.head ?? { x: 0.5, y: 0.18 };
  const headTop    = f?.headTop    ?? { x: head.x, y: Math.max(0, head.y - 0.04) };
  const headBottom = f?.headBottom ?? { x: head.x, y: head.y + 0.05 };
  const hip = f?.hip ?? { x: 0.5, y: 0.55 };
  const leftHip  = f?.leftHip  ?? { x: hip.x - 0.04, y: hip.y };
  const rightHip = f?.rightHip ?? { x: hip.x + 0.04, y: hip.y };
  const leftKnee  = f?.leftKnee  ?? { x: 0.45, y: 0.72 };
  const rightKnee = f?.rightKnee ?? { x: 0.55, y: 0.72 };
  const leftFoot  = f?.leftFoot  ?? { x: leftKnee.x - 0.01,  y: Math.min(0.98, leftKnee.y + 0.16) };
  const rightFoot = f?.rightFoot ?? { x: rightKnee.x + 0.01, y: Math.min(0.98, rightKnee.y + 0.16) };

  return {
    headTop, headBottom,
    leftShoulder:  f?.leftShoulder  ?? { x: 0.43, y: 0.28 },
    rightShoulder: f?.rightShoulder ?? { x: 0.57, y: 0.28 },
    leftElbow:     f?.leftElbow     ?? { x: 0.42, y: 0.41 },
    rightElbow:    f?.rightElbow    ?? { x: 0.58, y: 0.41 },
    leftWrist:     f?.leftWrist     ?? { x: 0.48, y: 0.54 },
    rightWrist:    f?.rightWrist    ?? { x: 0.52, y: 0.54 },
    leftHip, rightHip,
    leftKnee, rightKnee,
    leftFoot, rightFoot,
  };
}

/** Linear interpolation between two pose frames. `t` is 0..1.
 *  Used by the pose studio playback to animate smoothly between the
 *  four stored keyframes (address → top → impact → follow-through). */
export function interpolatePoseFrames(a: PoseFrame, b: PoseFrame, t: number): PoseFrame {
  const lerp = (p: Point, q: Point, k: number): Point => ({
    x: p.x + (q.x - p.x) * k,
    y: p.y + (q.y - p.y) * k,
  });
  return {
    headTop:       lerp(a.headTop,       b.headTop,       t),
    headBottom:    lerp(a.headBottom,    b.headBottom,    t),
    leftShoulder:  lerp(a.leftShoulder,  b.leftShoulder,  t),
    rightShoulder: lerp(a.rightShoulder, b.rightShoulder, t),
    leftElbow:     lerp(a.leftElbow,     b.leftElbow,     t),
    rightElbow:    lerp(a.rightElbow,    b.rightElbow,    t),
    leftWrist:     lerp(a.leftWrist,     b.leftWrist,     t),
    rightWrist:    lerp(a.rightWrist,    b.rightWrist,    t),
    leftHip:       lerp(a.leftHip,       b.leftHip,       t),
    rightHip:      lerp(a.rightHip,      b.rightHip,      t),
    leftKnee:      lerp(a.leftKnee,      b.leftKnee,      t),
    rightKnee:     lerp(a.rightKnee,     b.rightKnee,     t),
    leftFoot:      lerp(a.leftFoot,      b.leftFoot,      t),
    rightFoot:     lerp(a.rightFoot,     b.rightFoot,     t),
  };
}

/** Deterministic PRNG seeded from a string — used so a given swing's
 *  mock metrics are stable across page reloads. */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}
