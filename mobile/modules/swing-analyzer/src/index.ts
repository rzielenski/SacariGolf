/**
 * TypeScript bridge for the SwingAnalyzer native module.
 *
 * The native module runs Apple Vision-framework requests over a recorded
 * video file and returns per-frame body-pose joint positions + detected
 * clubhead trajectory points. See ios/SwingAnalyzerModule.swift.
 *
 *   const available = await SwingAnalyzer.isAvailable();
 *   const result = await SwingAnalyzer.analyzeVideo(videoUri);
 *
 * The TS types here mirror the dictionary shape the Swift side resolves
 * with — keep them in sync if you change either side.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

/** A single point in normalized 0-1 video coords. y=0 is the TOP of the
 *  frame (we flip Vision's bottom-origin coordinates on the Swift side). */
export interface NativePoint {
  x: number;
  y: number;
}

/** One frame's worth of body-pose joints. Any joint Vision couldn't detect
 *  with sufficient confidence (~0.3) is OMITTED from the object — the
 *  consumer must handle missing joints rather than expect a full set. */
export interface NativePoseFrame {
  /** Video timestamp in seconds at the moment this frame was captured. */
  time: number;
  headTop?: NativePoint;
  headBottom?: NativePoint;     // approximated from the neck joint
  leftShoulder?: NativePoint;
  rightShoulder?: NativePoint;
  leftElbow?: NativePoint;
  rightElbow?: NativePoint;
  leftWrist?: NativePoint;
  rightWrist?: NativePoint;
  leftHip?: NativePoint;
  rightHip?: NativePoint;
  leftKnee?: NativePoint;
  rightKnee?: NativePoint;
  leftFoot?: NativePoint;       // mapped from Vision's leftAnkle joint
  rightFoot?: NativePoint;
}

/** A single ballistic trajectory observation from VNDetectTrajectoriesRequest.
 *  Each observation is a chain of points + a parabolic fit. The clubhead
 *  arc is typically the longest / highest-confidence trajectory in a
 *  golf swing video. */
export interface NativeTrajectoryObservation {
  uuid: string;
  /** Time-ordered points the object passed through. */
  points: NativePoint[];
  /** Parabolic fit: a + b·x + c·x². */
  equationCoefficients: { a: number; b: number; c: number };
  /** Vision's confidence in this being a coherent trajectory (0-1). */
  confidence: number;
}

export interface NativeAnalysisResult {
  /** Video duration in seconds. */
  duration: number;
  /** Number of frames the analyzer iterated. */
  frameCount: number;
  /** Body-pose joints per frame, time-ordered. */
  poseFrames: NativePoseFrame[];
  /** Every ballistic trajectory the analyzer detected through the video.
   *  Could be 0 (no ball/clubhead motion detected), 1 (clubhead arc), or
   *  multiple (clubhead + ball flight + reflections in a simulator screen).
   *  The consumer should pick the most-likely-clubhead trajectory by
   *  length × confidence. */
  trajectories: NativeTrajectoryObservation[];
}

export interface NativeAvailability {
  available: boolean;
  iosVersion: string;
  reason?: string;
}

interface SwingAnalyzerNativeModule {
  isAvailable(): Promise<NativeAvailability>;
  analyzeVideo(videoUri: string): Promise<NativeAnalysisResult>;
}

// requireOptionalNativeModule returns null when the native module isn't
// available (e.g., running in Expo Go, on Android, or before the dev build
// has been rebuilt). Callers should check the return value and fall back.
const nativeModule = requireOptionalNativeModule<SwingAnalyzerNativeModule>('SwingAnalyzer');

/** True iff the native module is linked into the current binary AND iOS
 *  version supports Vision-framework requests (14.0+). Two checks combined:
 *  the JS side knows whether the module loaded, the native side reports
 *  whether the OS version is high enough. */
export async function isAvailable(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    const result = await nativeModule.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

/** Run the analyzer on a recorded video file. Throws if the module isn't
 *  available — callers should check `isAvailable()` first or wrap in a
 *  try/catch and fall back to the mock analyzer. */
export async function analyzeVideo(videoUri: string): Promise<NativeAnalysisResult> {
  if (!nativeModule) {
    throw new Error('SwingAnalyzer native module is not available. Rebuild the iOS app with the module linked.');
  }
  return nativeModule.analyzeVideo(videoUri);
}

export default { isAvailable, analyzeVideo };
