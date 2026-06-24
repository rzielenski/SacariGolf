import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';

/**
 * IMU swing detection for "The Grind" Range Sesh — the structural fix for the
 * sim-bay false triggers (claps, a neighboring bay's shot, the ball smacking
 * the screen). The mic alone can't solve those: they all sound similar, and a
 * neighbor's crack is acoustically identical to yours. The ONE signal that says
 * "*your* body swung" is motion on the phone you're wearing. So we detect the
 * wearer's downswing from the phone's motion sensors and use it to GATE the mic
 * — a loud transient only counts as a shot if a felt swing just happened.
 *
 *   clap / neighbor / cheer  → loud mic, zero motion on this phone → dropped
 *   ball hits the screen     → second bang has no new swing + is inside the
 *                              refractory lock → swallowed (one swing = one count)
 *   air practice swing       → real arc but no contact spike → not counted
 *
 * UNITS — verified against the installed expo-sensors 15 types
 * (node_modules/expo-sensors/build/DeviceMotion.d.ts):
 *   • DeviceMotion.rotationRate is DEGREES per second (deg/s), and NULLABLE.
 *   • DeviceMotion.acceleration is m/s^2 with gravity already removed, NULLABLE.
 * Both are guarded every frame; all thresholds below are in those units.
 *
 * iOS ONLY (as pure OTA): iOS honors ~50Hz sensor updates. Android throttles to
 * ~5Hz without the HIGH_SAMPLING_RATE_SENSORS manifest permission (which needs a
 * native build) — far too slow to catch a ~200ms downswing. So the gate is
 * scoped to iOS and the caller falls back to mic-only elsewhere.
 *
 * SELF-CALIBRATING: thresholds vary by hip-vs-thigh pocket, swing speed, and
 * phone, so instead of hardcoding them the user taps Calibrate and hits ~5
 * balls; we measure their actual peak rotation + contact spike and derive the
 * thresholds from it. Stored on-device via AsyncStorage.
 */

export type SwingCalibration = {
  /** Arm a swing arc when gyro magnitude (deg/s) crosses this on the way up. */
  peakGyro: number;
  /** Gyro must fall back below this (deg/s) to confirm the swing ended. */
  releaseGyro: number;
  /** Linear-accel spike (m/s^2) near the gyro peak that marks ball contact —
   *  an air practice swing decelerates smoothly and never produces it. */
  impactAccel: number;
  /** Whether a contact spike was actually measurable at the pocket during
   *  calibration. When false, the IMU-only "muffled shot" rescue is disabled
   *  and a count requires audio corroboration. */
  impactReliable: boolean;
  /** Median peak gyro seen during calibration (deg/s) — surfaced for display. */
  measuredPeakGyro: number;
};

/**
 * Conservative defaults if the user never calibrates. Anchored to the watch
 * reference (watch/SacariGolfWatch/Swing/MotionMonitor.swift sees a full wrist
 * swing peak ~20-30 rad/s ≈ 1150-1720 deg/s; a pocket is damped to perhaps a
 * third) and kept deliberately loose so real swings still arm pre-calibration.
 * impactReliable is false until calibrated, so before calibration the gate only
 * corroborates audio (never invents counts from motion alone).
 */
export const DEFAULT_CALIBRATION: SwingCalibration = {
  peakGyro: 300,
  releaseGyro: 90,
  impactAccel: 9999,       // sentinel: never trips, so uncalibrated counting needs audio
  impactReliable: false,
  measuredPeakGyro: 600,
};

const STORE_KEY = 'sacari.swing_calibration.v1';
// Detector: a real downswing arc is ~200ms, so this stops one swing from
// double-arming on follow-through jitter while still letting a genuinely
// separate second shot re-arm and stamp its own timestamp. Deliberately NOT
// wide enough to swallow a second real shot — echo collapse lives on the mic
// side (useShotDetector refractoryMs) and in the swing-driven dedupe.
const ARM_REFRACTORY_MS = 400;
// Calibration: deliberate practice shots are seconds apart, so a wide window
// keeps one swing's follow-through from being captured as a second sample.
const CAL_REFRACTORY_MS = 900;
const IMPACT_WINDOW_MS = 300;  // a contact spike must land within this of the peak
const STUCK_MS = 1500;         // bail out of a rising arc that never falls back
const CRACK_MATCH_MS = 400;    // a crack this close to a swing peak corroborates it
// Drop a crack arriving this soon after a counted swing — it's that shot's own
// lag / screen echo, not a new shot. Kept below ARM_REFRACTORY_MS so a genuine
// second shot's crack (which can't arrive sooner than a re-arm) is never eaten.
const CRACK_CONSUME_MS = 300;
// Hard floor between counted shots. You can't physically hit two golf shots this
// close together, so this is a simple, robust backstop: no matter how many
// spikes one motion makes — or how many stray listeners are firing — a count can
// only land once per this window. Tunable.
const COUNT_MIN_INTERVAL_MS = 3000;
// Same idea for calibration captures, but shorter so a brisk calibration pace
// still registers every swing (the duplicate-spike problem is sub-second).
const CAL_MIN_INTERVAL_MS = 1500;

/** True where the IMU gate can run as pure OTA (50Hz sensors). */
export const swingGateAvailable = Platform.OS === 'ios';

export async function loadSwingCalibration(): Promise<SwingCalibration> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.peakGyro === 'number') return { ...DEFAULT_CALIBRATION, ...v };
    }
  } catch { /* corrupt / absent — defaults below */ }
  return DEFAULT_CALIBRATION;
}

export async function saveSwingCalibration(c: SwingCalibration): Promise<void> {
  try { await AsyncStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch { /* best effort */ }
}

function gyroMag(d: DeviceMotionMeasurement): number | null {
  const r = d.rotationRate;
  if (!r) return null;
  return Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
}
function accelMag(d: DeviceMotionMeasurement): number | null {
  const a = d.acceleration;
  if (!a) return null;
  return Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
}

export type SwingEvent = {
  /** Timestamp of the rotation peak (≈ impact). */
  at: number;
  /** A contact-like accel spike accompanied this swing. */
  impact: boolean;
  /** Peak gyro magnitude reached (deg/s) — for tuning/debug. */
  peakGyro: number;
};

/**
 * Subscribe to DeviceMotion and detect the wearer's swing as a rotation arc:
 * a gyro magnitude that crosses `peakGyro` on the way up (we ARM at that
 * instant, since it's ~impact) then falls back below `releaseGyro`. We
 * deliberately do NOT require a quiet settling period before the swing — that
 * starves on a rake-and-hit range cadence — using a falling edge + refractory
 * instead. Orientation-invariant (magnitude), so pocket placement and
 * handedness don't matter.
 *
 * `swingAtRef.current` is stamped (Date.now) at the arm instant so the caller's
 * mic gate can compare a transient against the most recent felt swing.
 */
export function useSwingDetector(opts: {
  enabled: boolean;
  calibration: SwingCalibration;
  swingAtRef: MutableRefObject<number>;
  onSwing?: (e: SwingEvent) => void;
  /** Live magnitudes for an optional debug overlay (fires every frame). */
  onSample?: (gyro: number, accel: number) => void;
}) {
  const { enabled, calibration, swingAtRef, onSwing, onSample } = opts;
  const calRef = useRef(calibration); calRef.current = calibration;
  const onSwingRef = useRef(onSwing); onSwingRef.current = onSwing;
  const onSampleRef = useRef(onSample); onSampleRef.current = onSample;
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled || !swingGateAvailable) return;
    let alive = true;
    let sub: { remove: () => void } | null = null;
    let phase: 'idle' | 'rising' = 'idle';
    let peakGyro = 0, peakAt = 0, sawImpact = false, lastFire = 0;

    (async () => {
      let ok = false;
      try { ok = await DeviceMotion.isAvailableAsync(); } catch { ok = false; }
      if (!alive) return;
      setAvailable(ok);
      if (!ok) return;
      DeviceMotion.setUpdateInterval(20);   // ~50Hz on iOS
      const s = DeviceMotion.addListener((d) => {
        const g = gyroMag(d);
        if (g == null) return;               // gyro unavailable this frame
        const a = accelMag(d);
        const now = Date.now();
        onSampleRef.current?.(g, a ?? 0);
        const cal = calRef.current;
        if (phase === 'idle') {
          if (g >= cal.peakGyro && now - lastFire > ARM_REFRACTORY_MS) {
            phase = 'rising';
            peakGyro = g; peakAt = now; sawImpact = false;
            lastFire = now;
            swingAtRef.current = now;          // ARM at the peak crossing (≈ impact)
          }
        } else {
          if (g > peakGyro) { peakGyro = g; peakAt = now; }
          if (a != null && a >= cal.impactAccel && now - peakAt <= IMPACT_WINDOW_MS) sawImpact = true;
          if (g < cal.releaseGyro || now - peakAt > STUCK_MS) {
            phase = 'idle';
            onSwingRef.current?.({ at: peakAt, impact: sawImpact, peakGyro });
          }
        }
      });
      if (!alive) { s.remove(); return; }     // resolved after cleanup — don't leak
      sub = s;
    })();

    return () => { alive = false; sub?.remove(); };
  }, [enabled, swingAtRef]);

  return { available };
}

/**
 * Swing-gated shot counter. Counting is SWING-DRIVEN: only a felt swing can add
 * to the count, and the mic is a passive corroboration signal that never counts
 * on its own. A swing counts when it carried a real contact spike OR a loud
 * crack lands within CRACK_MATCH_MS of its peak. Crack matching is REACTIVE — a
 * crack credits a waiting swing the instant it arrives — so nothing depends on a
 * one-shot timer firing at exactly the right moment.
 *
 * Caller wires the mic: in gated mode the mic's onHit calls `reportCrack()`
 * (and counts nothing itself). All gate state is reset and any pending timer is
 * cancelled whenever `enabled` goes false or the component unmounts, so the
 * count can never move after the user stops listening.
 */
export function useSwingShotGate(opts: {
  enabled: boolean;
  calibration: SwingCalibration;
  onCount: () => void;
}) {
  const { enabled, calibration, onCount } = opts;
  const onCountRef = useRef(onCount); onCountRef.current = onCount;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;

  const swingAtRef = useRef(0);
  const lastCrackRef = useRef(0);                 // ms of the last prominent mic transient
  const resolvedRef = useRef(0);                  // peak time already counted (dedupe)
  const resolvedAtRef = useRef(0);                // ms the count actually fired (echo-consume anchor)
  const lastCountAtRef = useRef(0);               // ms of the last actual count (hard min-interval floor)
  const pendingRef = useRef<{ at: number } | null>(null);  // swing awaiting a late crack
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastSwing, setLastSwing] = useState<{ peak: number; impact: boolean } | null>(null);

  const clearPendingTimer = () => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
  };

  // Count a swing once, consuming its crack so it can't credit another swing.
  const credit = (peakAt: number) => {
    if (!enabledRef.current || resolvedRef.current === peakAt) return;
    const now = Date.now();
    if (now - lastCountAtRef.current < COUNT_MIN_INTERVAL_MS) return;  // hard floor: one shot per window
    lastCountAtRef.current = now;
    resolvedRef.current = peakAt;
    resolvedAtRef.current = now;          // anchor the echo-consume window to the count, not the peak
    lastCrackRef.current = 0;
    pendingRef.current = null;
    clearPendingTimer();
    onCountRef.current();
  };

  // A crack is only corroborating if it is recent (not a stale orphan) AND near
  // the swing peak.
  const freshCrackMatches = (peakAt: number) => {
    const c = lastCrackRef.current;
    if (c <= 0) return false;
    const now = Date.now();
    return now - c <= CRACK_MATCH_MS && Math.abs(c - peakAt) <= CRACK_MATCH_MS;
  };

  useSwingDetector({
    enabled,
    calibration,
    swingAtRef,
    onSwing: (e) => {
      setLastSwing({ peak: Math.round(e.peakGyro), impact: e.impact });
      if (e.impact || freshCrackMatches(e.at)) { credit(e.at); return; }
      // No corroboration yet. Hold the swing pending so a crack arriving within
      // the match window (via reportCrack) credits it; expire it otherwise (it
      // was an air practice swing).
      pendingRef.current = { at: e.at };
      clearPendingTimer();
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        pendingRef.current = null;
      }, CRACK_MATCH_MS + 80);
    },
  });

  // Mic heard a prominent transient (gated mode). Record it and reactively
  // credit a swing already waiting on it.
  const reportCrack = useCallback(() => {
    if (!enabledRef.current) return;
    const now = Date.now();
    // Ignore the late crack of a shot we just counted (its own lag / the ball
    // hitting the screen) so it can't linger and corroborate a later air swing.
    // Measured from when the count FIRED (falling edge), not the earlier peak,
    // or the window would be short by the peak-to-release gap.
    if (resolvedAtRef.current > 0 && now - resolvedAtRef.current <= CRACK_CONSUME_MS) return;
    lastCrackRef.current = now;
    const p = pendingRef.current;
    if (p && Math.abs(now - p.at) <= CRACK_MATCH_MS) credit(p.at);
  }, []);

  // Reset on stop / unmount: cancel the pending timer and clear all state so no
  // orphaned timer or stale crack can ever move the count after listening ends.
  useEffect(() => {
    if (enabled) return;
    clearPendingTimer();
    swingAtRef.current = 0; lastCrackRef.current = 0; resolvedRef.current = 0;
    resolvedAtRef.current = 0; lastCountAtRef.current = 0; pendingRef.current = null;
  }, [enabled]);
  useEffect(() => () => clearPendingTimer(), []);

  return { reportCrack, lastSwing };
}

export type CalibratorState = {
  active: boolean;
  captured: number;
  needed: number;
  /** True after a run ended without enough swings detected — the UI prompts a retry. */
  failed: boolean;
  start: () => void;
  cancel: () => void;
};

/**
 * Calibration flow: the user pockets the phone and takes ~`needed` swings. We
 * record each swing's peak gyro + peak contact accel, then derive personal
 * thresholds from the medians.
 *
 * Only a DISCRETE SWING is captured. A real swing is preceded by stillness
 * (addressing the ball) and ramps from still to a high peak FAST. Handling the
 * phone — pulling it out, dropping it in a pocket, adjusting it — is continuous
 * motion that never settles, and it must NOT be captured (that was the bug that
 * exited calibration after a single real shot: pocketing logged the other four).
 * So a capture requires: a startup grace (to pocket the phone), a prior-quiet
 * settle, then a peak past a swing-grade floor. A stall escape hatch ends the
 * run rather than hang if swings never register.
 */
export function useSwingCalibrator(opts: {
  needed?: number;
  onDone: (c: SwingCalibration) => void;
}): CalibratorState {
  const needed = opts.needed ?? 5;
  const onDoneRef = useRef(opts.onDone); onDoneRef.current = opts.onDone;
  const [active, setActive] = useState(false);
  const [captured, setCaptured] = useState(0);
  const [failed, setFailed] = useState(false);
  const peaksRef = useRef<{ gyro: number; accel: number }[]>([]);
  const lastCaptureAtRef = useRef(0);   // shared hard-floor anchor (across any listeners)

  useEffect(() => {
    if (!active || !swingGateAvailable) return;
    let alive = true;
    let sub: { remove: () => void } | null = null;
    const BOOT_FLOOR = 200;      // deg/s — a real pocket swing clears this; most hand motion doesn't.
                                 // Kept modest so a gentle / heavily-damped swing still arms.
    const BOOT_RELEASE = 80;
    const QUIET_GYRO = 60;       // deg/s — "standing still" addressing the ball
    const MIN_QUIET_MS = 350;    // must be this still before a capture can arm
    const STALL_MS = 15000;      // no new swing in this long → stop (don't hang) and prompt a retry
    const startAt = Date.now() + 1200;   // grace so pocketing right after the tap isn't captured
    let phase: 'idle' | 'rising' = 'idle';
    let peakGyro = 0, peakAt = 0, peakAccel = 0, lastFire = 0;
    let quietSince = 0, readyToArm = false, finished = false;
    let lastProgressAt = startAt;        // for the stall escape hatch

    (async () => {
      let ok = false;
      try { ok = await DeviceMotion.isAvailableAsync(); } catch { ok = false; }
      if (!alive || !ok) return;
      DeviceMotion.setUpdateInterval(20);
      const s = DeviceMotion.addListener((d) => {
        if (finished) return;
        const g = gyroMag(d);
        if (g == null) return;
        const a = accelMag(d);
        const now = Date.now();
        if (now < startAt) return;                 // startup grace — pocket the phone
        // Escape hatch: if no swing has registered in a long while, stop rather
        // than hang. Finish with whatever we caught if it's enough to be useful,
        // otherwise flag a retry so the UI can prompt instead of spinning.
        if (phase === 'idle' && now - lastProgressAt > STALL_MS) {
          finished = true;
          if (peaksRef.current.length >= 2) onDoneRef.current(deriveCalibration(peaksRef.current));
          else setFailed(true);
          setActive(false);
          return;
        }
        // A capture must be a DISCRETE swing: armed only after a brief stillness
        // (addressing the ball). Continuous handling never settles, so it stays
        // disarmed. Crucially we do NOT disarm once stillness has armed us — a
        // golf swing is ~1s of sub-floor backswing motion before the downswing
        // spike, so disarming on mid-swing motion would miss every real swing.
        if (g < QUIET_GYRO) {
          if (!quietSince) quietSince = now;
          if (now - quietSince >= MIN_QUIET_MS) readyToArm = true;
        } else {
          quietSince = 0;
        }
        if (phase === 'idle') {
          if (readyToArm && g >= BOOT_FLOOR && now - lastFire > CAL_REFRACTORY_MS) {
            phase = 'rising'; peakGyro = g; peakAt = now; peakAccel = a ?? 0; lastFire = now;
            readyToArm = false; quietSince = 0;
          }
        } else {
          if (g > peakGyro) { peakGyro = g; peakAt = now; }
          if (a != null && a > peakAccel && now - peakAt <= IMPACT_WINDOW_MS) peakAccel = a;
          if (g < BOOT_RELEASE || now - peakAt > STUCK_MS) {
            phase = 'idle';
            // Shared hard floor: at most one capture per window, no matter how
            // many spikes one motion makes or how many listeners are firing.
            if (now - lastCaptureAtRef.current >= CAL_MIN_INTERVAL_MS) {
              lastCaptureAtRef.current = now;
              peaksRef.current.push({ gyro: peakGyro, accel: peakAccel });
              lastProgressAt = now;
              const n = peaksRef.current.length;
              setCaptured(n);
              if (n >= needed) {
                finished = true;
                onDoneRef.current(deriveCalibration(peaksRef.current));
                setActive(false);
              }
            }
          }
        }
      });
      if (!alive) { s.remove(); return; }
      sub = s;
    })();

    return () => { alive = false; sub?.remove(); };
  }, [active, needed]);

  const start = useCallback(() => {
    peaksRef.current = []; lastCaptureAtRef.current = 0; setCaptured(0); setFailed(false); setActive(true);
  }, []);
  const cancel = useCallback(() => {
    setActive(false); peaksRef.current = []; lastCaptureAtRef.current = 0; setCaptured(0); setFailed(false);
  }, []);

  return { active, captured, needed, failed, start, cancel };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Turn the captured swing peaks into thresholds. Arm below the median so a
 *  weaker real swing still fires, but well above walking/fidget. Only trust the
 *  IMU-only "felt a real impact" rescue if a crisp contact spike actually
 *  reached the pocket during calibration. */
export function deriveCalibration(peaks: { gyro: number; accel: number }[]): SwingCalibration {
  const gyroMed = median(peaks.map((p) => p.gyro));
  const accelMed = median(peaks.map((p) => p.accel));
  const peakGyro = Math.max(150, Math.round(gyroMed * 0.55));
  const releaseGyro = Math.max(40, Math.round(gyroMed * 0.22));
  const impactReliable = accelMed >= 14;   // m/s^2 — a real contact felt at the pocket
  // Big finite sentinel when impact isn't trustworthy (JSON.stringify turns
  // Infinity into null, which would corrupt the stored threshold) — no real
  // accel reaches it, so the contact spike never trips and we require audio.
  const impactAccel = impactReliable ? Math.max(12, Math.round(accelMed * 0.5)) : 9999;
  return { peakGyro, releaseGyro, impactAccel, impactReliable, measuredPeakGyro: Math.round(gyroMed) };
}
