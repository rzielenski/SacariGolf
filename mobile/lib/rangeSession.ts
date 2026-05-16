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
  /** Joint positions, normalized (0-1). 19 joints to match Apple's
   *  VNDetectHumanBodyPoseRequest output, but we use a simpler 11-joint
   *  schema since that's all the UI overlay needs. */
  head: Point;
  neck: Point;
  leftShoulder: Point;
  rightShoulder: Point;
  leftElbow: Point;
  rightElbow: Point;
  leftWrist: Point;
  rightWrist: Point;
  hip: Point;       // center of pelvis
  leftKnee: Point;
  rightKnee: Point;
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

// ── Mock analyzer (Phase 1) ─────────────────────────────────────────────

/** Generate a SwingAnalysis for the given club + camera angle + handicap.
 *  Deterministic per (club, swingId, handicap, angle) so re-opening a
 *  session shows the same numbers — important for the "improvement over
 *  time" comparison. */
export async function analyzeSwing(
  videoUri: string,
  club: string,
  swingId: string,
  handicap: number | null,
  cameraAngle: CameraAngle = 'face_on',
): Promise<SwingAnalysis> {
  // Tiny artificial delay so the UI gets to show its "analyzing..." state.
  // The real Vision-framework pass takes ~2-4 seconds on an iPhone 12 for
  // a 5-second 240fps video, so this matches the eventual real timing.
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

  // Clubhead trace — face-on traces a tilted ellipse swing plane, down-the-line
  // traces a more vertical arc with a slight forward bias on follow-through.
  const totalSec = body.backswingSec + body.downswingSec;
  const trace = cameraAngle === 'down_the_line'
    ? generateClubheadTraceDTL(totalSec)
    : generateClubheadTraceFaceOn(totalSec);
  const impactTimeSec = body.backswingSec;

  // Ball position in frame — drives where the pose studio shows the ball
  // marker. Face-on: low-center-front. Down-the-line: forward of stance.
  const ballPosition: Point = cameraAngle === 'down_the_line'
    ? { x: 0.62, y: 0.66 }
    : { x: 0.50, y: 0.68 };

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

function generatePoseKeyframesFaceOn(skill: number): SwingAnalysis['poseKeyframes'] {
  // Address — neutral stance, slight forward bend, hands at center.
  const address: PoseFrame = {
    head:           { x: 0.50, y: 0.18 },
    neck:           { x: 0.50, y: 0.25 },
    leftShoulder:   { x: 0.43, y: 0.28 },
    rightShoulder:  { x: 0.57, y: 0.28 },
    leftElbow:      { x: 0.42, y: 0.41 },
    rightElbow:     { x: 0.58, y: 0.41 },
    leftWrist:      { x: 0.48, y: 0.54 },
    rightWrist:     { x: 0.52, y: 0.54 },
    hip:            { x: 0.50, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.75 },
    rightKnee:      { x: 0.55, y: 0.75 },
  };
  // Top of backswing — shoulders rotated ~95° from address, hips ~45°.
  // Skill affects rotation amount: pros get fuller turn.
  const turnK = 0.85 + skill * 0.15; // 0.85 (amateur) ... 1.0 (pro)
  const top: PoseFrame = {
    head:           { x: 0.49, y: 0.18 },
    neck:           { x: 0.50, y: 0.25 },
    leftShoulder:   { x: 0.39 - 0.04 * turnK, y: 0.32 },
    rightShoulder:  { x: 0.55 + 0.03 * turnK, y: 0.25 },
    leftElbow:      { x: 0.50, y: 0.30 },
    rightElbow:     { x: 0.70, y: 0.22 },
    leftWrist:      { x: 0.62, y: 0.13 },
    rightWrist:     { x: 0.65, y: 0.13 },
    hip:            { x: 0.50 + 0.02 * turnK, y: 0.55 },
    leftKnee:       { x: 0.44, y: 0.75 },
    rightKnee:      { x: 0.56, y: 0.75 },
  };
  // Impact — body slightly ahead of the ball, hands at hip height.
  const impact: PoseFrame = {
    head:           { x: 0.48, y: 0.18 },
    neck:           { x: 0.48, y: 0.25 },
    leftShoulder:   { x: 0.44, y: 0.28 },
    rightShoulder:  { x: 0.55, y: 0.30 },
    leftElbow:      { x: 0.41, y: 0.42 },
    rightElbow:     { x: 0.55, y: 0.42 },
    leftWrist:      { x: 0.46, y: 0.55 },
    rightWrist:     { x: 0.50, y: 0.55 },
    hip:            { x: 0.51, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.75 },
    rightKnee:      { x: 0.55, y: 0.75 },
  };
  // Follow-through — fully rotated, hands high-left, weight on lead leg.
  const ft: PoseFrame = {
    head:           { x: 0.51, y: 0.18 },
    neck:           { x: 0.51, y: 0.25 },
    leftShoulder:   { x: 0.58, y: 0.30 },
    rightShoulder:  { x: 0.43, y: 0.25 },
    leftElbow:      { x: 0.55, y: 0.20 },
    rightElbow:     { x: 0.38, y: 0.18 },
    leftWrist:      { x: 0.40, y: 0.10 },
    rightWrist:     { x: 0.37, y: 0.10 },
    hip:            { x: 0.51, y: 0.55 },
    leftKnee:       { x: 0.47, y: 0.75 },
    rightKnee:      { x: 0.55, y: 0.78 },
  };

  return { address, top, impact, followThrough: ft };
}

/** Down-the-line keyframes — camera behind the golfer along the target line.
 *  Target is to the LEFT of the screen for a right-handed golfer; the
 *  golfer's back faces the camera. The arms extend FORWARD (toward target,
 *  i.e. screen-left at address) and the club arcs up over the right
 *  shoulder at the top. */
function generatePoseKeyframesDTL(skill: number): SwingAnalysis['poseKeyframes'] {
  // Address — golfer's back to camera, slightly side-on. Right shoulder
  // (camera-near) at screen-right; left shoulder (target-near) at center.
  const address: PoseFrame = {
    head:           { x: 0.42, y: 0.18 },
    neck:           { x: 0.42, y: 0.25 },
    leftShoulder:   { x: 0.46, y: 0.29 },  // forward, slightly target-ward
    rightShoulder:  { x: 0.38, y: 0.30 },  // closer to camera
    leftElbow:      { x: 0.52, y: 0.42 },
    rightElbow:     { x: 0.46, y: 0.43 },
    leftWrist:      { x: 0.56, y: 0.55 },  // hands extend forward to ball
    rightWrist:     { x: 0.54, y: 0.56 },
    hip:            { x: 0.42, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.75 },
    rightKnee:      { x: 0.39, y: 0.75 },
  };
  // Top of backswing — club up behind the right shoulder. Skill affects
  // how high + how shallow/upright the plane is.
  const planeK = 0.85 + skill * 0.15;
  const top: PoseFrame = {
    head:           { x: 0.42, y: 0.18 },
    neck:           { x: 0.42, y: 0.26 },
    leftShoulder:   { x: 0.45, y: 0.34 },  // shoulders rotated toward back
    rightShoulder:  { x: 0.36, y: 0.27 },
    leftElbow:      { x: 0.40, y: 0.28 },
    rightElbow:     { x: 0.33, y: 0.22 },
    leftWrist:      { x: 0.28 * planeK + 0.34 * (1 - planeK), y: 0.16 },
    rightWrist:     { x: 0.26 * planeK + 0.33 * (1 - planeK), y: 0.17 },
    hip:            { x: 0.43, y: 0.55 },  // small hip turn
    leftKnee:       { x: 0.45, y: 0.75 },
    rightKnee:      { x: 0.39, y: 0.75 },
  };
  // Impact — back to address-like position; weight shifted forward (left).
  const impact: PoseFrame = {
    head:           { x: 0.42, y: 0.18 },
    neck:           { x: 0.43, y: 0.25 },
    leftShoulder:   { x: 0.47, y: 0.29 },
    rightShoulder:  { x: 0.39, y: 0.30 },
    leftElbow:      { x: 0.52, y: 0.42 },
    rightElbow:     { x: 0.46, y: 0.43 },
    leftWrist:      { x: 0.56, y: 0.55 },
    rightWrist:     { x: 0.54, y: 0.56 },
    hip:            { x: 0.44, y: 0.55 },  // hip slid slightly forward
    leftKnee:       { x: 0.46, y: 0.75 },
    rightKnee:      { x: 0.39, y: 0.76 },
  };
  // Follow-through — club out front-left, body rotated to face target.
  const ft: PoseFrame = {
    head:           { x: 0.42, y: 0.19 },
    neck:           { x: 0.43, y: 0.26 },
    leftShoulder:   { x: 0.50, y: 0.27 },  // shoulders rotated open
    rightShoulder:  { x: 0.40, y: 0.32 },
    leftElbow:      { x: 0.62, y: 0.22 },
    rightElbow:     { x: 0.56, y: 0.20 },
    leftWrist:      { x: 0.72, y: 0.14 },  // hands high in front-left
    rightWrist:     { x: 0.70, y: 0.16 },
    hip:            { x: 0.45, y: 0.55 },
    leftKnee:       { x: 0.46, y: 0.75 },
    rightKnee:      { x: 0.40, y: 0.78 },
  };
  return { address, top, impact, followThrough: ft };
}

// ── Clubhead trace generators ───────────────────────────────────────────
// Two angle-specific variants. Both produce a list of ~60 (x, y, t) points
// describing the clubhead's path through the swing.

/** Face-on swing-plane trace — the canonical tilted ellipse view.
 *  Address bottom-right → top upper-left → impact bottom-center →
 *  follow-through upper-right. */
function generateClubheadTraceFaceOn(totalSec: number): SwingAnalysis['clubheadTrace'] {
  const samples = 60;
  const pts: SwingAnalysis['clubheadTrace'] = [];
  const cx = 0.50, cy = 0.50;
  const rx = 0.40, ry = 0.40;
  const tilt = -0.35; // radians — swing-plane tilt angle
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let angle: number;
    if (u < 0.5) {
      angle = -Math.PI / 2 + (u / 0.5) * Math.PI;
    } else {
      const v = (u - 0.5) / 0.5;
      angle = Math.PI / 2 - v * Math.PI;
    }
    const px = Math.cos(angle) * rx;
    const py = Math.sin(angle) * ry;
    const x = cx + (px * Math.cos(tilt) - py * Math.sin(tilt));
    const y = cy + (px * Math.sin(tilt) + py * Math.cos(tilt));
    pts.push({ x, y, t: u * totalSec });
  }
  return pts;
}

/** Down-the-line trace — the clubhead's path viewed from behind. Reads as
 *  a more vertical arc that goes up behind the right shoulder, comes back
 *  down through the ball, and exits high forward-left. Slight bias to the
 *  back-side on the backswing portion mimics the canonical "on plane"
 *  shape that golf instruction videos use. */
function generateClubheadTraceDTL(totalSec: number): SwingAnalysis['clubheadTrace'] {
  const samples = 60;
  const pts: SwingAnalysis['clubheadTrace'] = [];
  // Ball is at (0.62, 0.66) — see ballPosition above.
  // Backswing peak: roughly (0.18, 0.16) — high above right shoulder.
  // Follow-through peak: (0.78, 0.18) — high in front-left.
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let x: number, y: number;
    if (u < 0.5) {
      // Backswing — quadratic Bezier from ball through mid (0.30, 0.42)
      // to top (0.18, 0.16). Reads as a clean upward arc behind the
      // shoulder line.
      const v = u / 0.5;
      const oneMinus = 1 - v;
      x = oneMinus * oneMinus * 0.62 + 2 * oneMinus * v * 0.30 + v * v * 0.18;
      y = oneMinus * oneMinus * 0.66 + 2 * oneMinus * v * 0.42 + v * v * 0.16;
    } else {
      // Downswing + follow-through — Bezier from top through ball at
      // (0.62, 0.66) to high-front-left (0.78, 0.18). Crossover at impact.
      const v = (u - 0.5) / 0.5;
      if (v < 0.55) {
        // Top → impact
        const w = v / 0.55;
        const oneMinus = 1 - w;
        x = oneMinus * oneMinus * 0.18 + 2 * oneMinus * w * 0.35 + w * w * 0.62;
        y = oneMinus * oneMinus * 0.16 + 2 * oneMinus * w * 0.55 + w * w * 0.66;
      } else {
        // Impact → high-forward follow-through
        const w = (v - 0.55) / 0.45;
        const oneMinus = 1 - w;
        x = oneMinus * oneMinus * 0.62 + 2 * oneMinus * w * 0.74 + w * w * 0.78;
        y = oneMinus * oneMinus * 0.66 + 2 * oneMinus * w * 0.42 + w * w * 0.18;
      }
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
