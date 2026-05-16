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
    headTop:        { x: 0.50, y: 0.14 },
    headBottom:     { x: 0.50, y: 0.23 },
    leftShoulder:   { x: 0.43, y: 0.28 },
    rightShoulder:  { x: 0.57, y: 0.28 },
    leftElbow:      { x: 0.42, y: 0.41 },
    rightElbow:     { x: 0.58, y: 0.41 },
    leftWrist:      { x: 0.48, y: 0.54 },
    rightWrist:     { x: 0.52, y: 0.54 },
    leftHip:        { x: 0.46, y: 0.55 },
    rightHip:       { x: 0.54, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.72 },
    rightKnee:      { x: 0.55, y: 0.72 },
    leftFoot:       { x: 0.43, y: 0.88 },
    rightFoot:      { x: 0.57, y: 0.88 },
  };
  // Top of backswing — shoulders rotated ~95° from address, hips ~45°.
  // Skill affects rotation amount: pros get fuller turn.
  const turnK = 0.85 + skill * 0.15; // 0.85 (amateur) ... 1.0 (pro)
  const top: PoseFrame = {
    headTop:        { x: 0.49, y: 0.14 },
    headBottom:     { x: 0.49, y: 0.23 },
    leftShoulder:   { x: 0.39 - 0.04 * turnK, y: 0.32 },
    rightShoulder:  { x: 0.55 + 0.03 * turnK, y: 0.25 },
    leftElbow:      { x: 0.50, y: 0.30 },
    rightElbow:     { x: 0.70, y: 0.22 },
    leftWrist:      { x: 0.62, y: 0.13 },
    rightWrist:     { x: 0.65, y: 0.13 },
    leftHip:        { x: 0.47 + 0.01 * turnK, y: 0.55 },
    rightHip:       { x: 0.55 + 0.02 * turnK, y: 0.55 },
    leftKnee:       { x: 0.44, y: 0.72 },
    rightKnee:      { x: 0.56, y: 0.72 },
    leftFoot:       { x: 0.43, y: 0.88 },
    rightFoot:      { x: 0.57, y: 0.88 },
  };
  // Impact — body slightly ahead of the ball, hands at hip height,
  // hips opened toward target (screen-right for righty face-on view).
  const impact: PoseFrame = {
    headTop:        { x: 0.48, y: 0.14 },
    headBottom:     { x: 0.48, y: 0.23 },
    leftShoulder:   { x: 0.44, y: 0.28 },
    rightShoulder:  { x: 0.55, y: 0.30 },
    leftElbow:      { x: 0.41, y: 0.42 },
    rightElbow:     { x: 0.55, y: 0.42 },
    leftWrist:      { x: 0.46, y: 0.55 },
    rightWrist:     { x: 0.50, y: 0.55 },
    leftHip:        { x: 0.47, y: 0.55 },
    rightHip:       { x: 0.55, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.72 },
    rightKnee:      { x: 0.55, y: 0.72 },
    leftFoot:       { x: 0.43, y: 0.88 },
    rightFoot:      { x: 0.57, y: 0.88 },
  };
  // Follow-through — fully rotated, hands high-left, weight on lead leg.
  // Trail foot (right for righty) lifted slightly on toe — visible by
  // moving its y up vs the planted lead foot.
  const ft: PoseFrame = {
    headTop:        { x: 0.51, y: 0.14 },
    headBottom:     { x: 0.51, y: 0.23 },
    leftShoulder:   { x: 0.58, y: 0.30 },
    rightShoulder:  { x: 0.43, y: 0.25 },
    leftElbow:      { x: 0.55, y: 0.20 },
    rightElbow:     { x: 0.38, y: 0.18 },
    leftWrist:      { x: 0.40, y: 0.10 },
    rightWrist:     { x: 0.37, y: 0.10 },
    leftHip:        { x: 0.49, y: 0.55 },
    rightHip:       { x: 0.55, y: 0.55 },
    leftKnee:       { x: 0.47, y: 0.72 },
    rightKnee:      { x: 0.55, y: 0.74 },
    leftFoot:       { x: 0.43, y: 0.88 },  // planted
    rightFoot:      { x: 0.57, y: 0.84 },  // lifted onto toe
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
  // Note: in the DTL view we see the side of the body, so leftHip and
  // rightHip mostly stack vertically rather than separating horizontally
  // like they do in face-on. Same for the feet.
  const address: PoseFrame = {
    headTop:        { x: 0.42, y: 0.14 },
    headBottom:     { x: 0.42, y: 0.23 },
    leftShoulder:   { x: 0.46, y: 0.29 },  // target-near (forward)
    rightShoulder:  { x: 0.38, y: 0.30 },  // camera-near (back)
    leftElbow:      { x: 0.52, y: 0.42 },
    rightElbow:     { x: 0.46, y: 0.43 },
    leftWrist:      { x: 0.56, y: 0.55 },  // hands extend forward to ball
    rightWrist:     { x: 0.54, y: 0.56 },
    leftHip:        { x: 0.44, y: 0.55 },  // forward (target-ward) hip
    rightHip:       { x: 0.40, y: 0.55 },  // back hip
    leftKnee:       { x: 0.45, y: 0.72 },
    rightKnee:      { x: 0.39, y: 0.72 },
    leftFoot:       { x: 0.46, y: 0.88 },
    rightFoot:      { x: 0.38, y: 0.88 },
  };
  // Top of backswing — club up behind the right shoulder. Skill affects
  // how high + how shallow/upright the plane is.
  const planeK = 0.85 + skill * 0.15;
  const top: PoseFrame = {
    headTop:        { x: 0.42, y: 0.14 },
    headBottom:     { x: 0.42, y: 0.24 },
    leftShoulder:   { x: 0.45, y: 0.34 },  // shoulders rotated toward back
    rightShoulder:  { x: 0.36, y: 0.27 },
    leftElbow:      { x: 0.40, y: 0.28 },
    rightElbow:     { x: 0.33, y: 0.22 },
    leftWrist:      { x: 0.28 * planeK + 0.34 * (1 - planeK), y: 0.16 },
    rightWrist:     { x: 0.26 * planeK + 0.33 * (1 - planeK), y: 0.17 },
    leftHip:        { x: 0.44, y: 0.55 },  // small hip turn
    rightHip:       { x: 0.40, y: 0.55 },
    leftKnee:       { x: 0.45, y: 0.72 },
    rightKnee:      { x: 0.39, y: 0.72 },
    leftFoot:       { x: 0.46, y: 0.88 },
    rightFoot:      { x: 0.38, y: 0.88 },
  };
  // Impact — back to address-like position; weight shifted forward (left).
  const impact: PoseFrame = {
    headTop:        { x: 0.42, y: 0.14 },
    headBottom:     { x: 0.43, y: 0.23 },
    leftShoulder:   { x: 0.47, y: 0.29 },
    rightShoulder:  { x: 0.39, y: 0.30 },
    leftElbow:      { x: 0.52, y: 0.42 },
    rightElbow:     { x: 0.46, y: 0.43 },
    leftWrist:      { x: 0.56, y: 0.55 },
    rightWrist:     { x: 0.54, y: 0.56 },
    leftHip:        { x: 0.46, y: 0.55 },  // hip slid slightly forward
    rightHip:       { x: 0.41, y: 0.55 },
    leftKnee:       { x: 0.46, y: 0.72 },
    rightKnee:      { x: 0.39, y: 0.73 },
    leftFoot:       { x: 0.46, y: 0.88 },  // planted
    rightFoot:      { x: 0.38, y: 0.88 },
  };
  // Follow-through — club out front-left, body rotated to face target.
  // Trail (right for righty) foot rotated onto toe.
  const ft: PoseFrame = {
    headTop:        { x: 0.42, y: 0.15 },
    headBottom:     { x: 0.43, y: 0.24 },
    leftShoulder:   { x: 0.50, y: 0.27 },  // shoulders rotated open
    rightShoulder:  { x: 0.40, y: 0.32 },
    leftElbow:      { x: 0.62, y: 0.22 },
    rightElbow:     { x: 0.56, y: 0.20 },
    leftWrist:      { x: 0.72, y: 0.14 },  // hands high in front-left
    rightWrist:     { x: 0.70, y: 0.16 },
    leftHip:        { x: 0.47, y: 0.55 },
    rightHip:       { x: 0.43, y: 0.55 },
    leftKnee:       { x: 0.46, y: 0.72 },
    rightKnee:      { x: 0.40, y: 0.74 },
    leftFoot:       { x: 0.46, y: 0.88 },  // planted
    rightFoot:      { x: 0.39, y: 0.84 },  // lifted onto toe
  };
  return { address, top, impact, followThrough: ft };
}

// ── Clubhead trace generators ───────────────────────────────────────────
// Two angle-specific variants. Both produce a list of ~60 (x, y, t) points
// describing the clubhead's path through the swing.

/** Face-on swing-plane trace — three Bezier segments forming the canonical
 *  "C up, mirrored C down, finish high opposite side" shape that golf
 *  instruction videos use to teach swing plane.
 *
 *  Segments (each a quadratic Bezier):
 *    1. Backswing (u 0 → 0.5):   ball-low-center → mid-back → top-back-high
 *    2. Downswing (u 0.5 → 0.75): top-back-high → mid-back → impact-low
 *    3. Follow-through (0.75 → 1): impact-low → mid-front → top-front-high
 *
 *  Previous angle-based implementation had its angle convention inverted
 *  (screen-y grows down but standard math sin/cos assume y-up), so the
 *  generated trace started at the TOP of the screen and arced wrong.
 *  Explicit Bezier waypoints eliminate the convention issue. */
function generateClubheadTraceFaceOn(totalSec: number): SwingAnalysis['clubheadTrace'] {
  const samples = 60;
  const pts: SwingAnalysis['clubheadTrace'] = [];
  // Waypoints, all in normalized 0-1 screen coords (y grows down).
  // Right-handed golfer filmed face-on: club goes up on golfer's right
  // (screen-LEFT) on the backswing, exits high on screen-right on
  // follow-through.
  const ball       = { x: 0.50, y: 0.70 };  // address / impact position
  const backMid    = { x: 0.30, y: 0.42 };  // mid-backswing
  const topBack    = { x: 0.20, y: 0.20 };  // top of backswing
  const downMid    = { x: 0.32, y: 0.50 };  // mid-downswing (slightly inside)
  const ftMid      = { x: 0.70, y: 0.40 };  // mid-follow-through
  const ftHigh     = { x: 0.82, y: 0.20 };  // finish high

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let x: number, y: number;
    if (u < 0.5) {
      // Backswing — ball → top-back via mid-back control point.
      const v = u / 0.5;
      const oneMinus = 1 - v;
      x = oneMinus * oneMinus * ball.x + 2 * oneMinus * v * backMid.x + v * v * topBack.x;
      y = oneMinus * oneMinus * ball.y + 2 * oneMinus * v * backMid.y + v * v * topBack.y;
    } else if (u < 0.75) {
      // Downswing — top-back → impact via downswing control point.
      const v = (u - 0.5) / 0.25;
      const oneMinus = 1 - v;
      x = oneMinus * oneMinus * topBack.x + 2 * oneMinus * v * downMid.x + v * v * ball.x;
      y = oneMinus * oneMinus * topBack.y + 2 * oneMinus * v * downMid.y + v * v * ball.y;
    } else {
      // Follow-through — impact → high-front via ft control point.
      const v = (u - 0.75) / 0.25;
      const oneMinus = 1 - v;
      x = oneMinus * oneMinus * ball.x + 2 * oneMinus * v * ftMid.x + v * v * ftHigh.x;
      y = oneMinus * oneMinus * ball.y + 2 * oneMinus * v * ftMid.y + v * v * ftHigh.y;
    }
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
