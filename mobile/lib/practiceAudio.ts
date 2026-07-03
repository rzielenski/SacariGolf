import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Audio } from 'expo-av';

const CLICK = require('../assets/sounds/click.wav');

/**
 * Practice-mode audio: a metronome and a mic-based shot detector. Both run in
 * "The Grind" Range / Putting screens. expo-av is already a dependency (voice
 * messages), so this ships over-the-air — no new native module.
 *
 * NOTE: the metering thresholds and audio routing below are sensible defaults
 * but want on-device tuning — a loud range crack vs a quiet putt vs how the
 * earpiece-vs-speaker routing behaves while recording all vary by phone.
 */

/** Put the audio session into a play-AND-record mode so the metronome can
 *  click while the mic is listening, and audio isn't muted by the ringer. */
async function ensurePracticeAudioMode() {
  try {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  } catch { /* best effort */ }
}

/** Restore the default playback audio session after listening stops. Recording
 *  mode routes iOS playback to the quiet earpiece, so once the shot detector
 *  stops we flip `allowsRecordingIOS` back off — otherwise swing video, the
 *  theme song and voice messages all come out the earpiece until something
 *  else happens to reset the mode. */
export async function resetPracticeAudioMode() {
  try {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
  } catch { /* best effort */ }
}

/**
 * Metronome. Plays a click each beat at `bpm`, drift-corrected against an
 * absolute start time so it doesn't slowly fall behind. `onTick` fires on each
 * beat — the screen uses it to briefly mute the shot detector so the click
 * isn't counted as a shot.
 */
export function useMetronome(initialBpm: number, onTick?: () => void) {
  const [bpm, setBpm] = useState(initialBpm);
  const [running, setRunning] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensurePracticeAudioMode();
        const { sound } = await Audio.Sound.createAsync(CLICK, { shouldPlay: false });
        if (alive) soundRef.current = sound;
        else await sound.unloadAsync();
      } catch { /* metronome just won't click; UI still works */ }
    })();
    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      soundRef.current?.unloadAsync().catch(() => { });
      soundRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    setRunning(false);
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const start = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setRunning(true);
    const begin = Date.now();
    let beat = 0;
    const tick = () => {
      onTickRef.current?.();
      soundRef.current?.replayAsync().catch(() => { });
      beat += 1;
      const interval = 60000 / Math.max(20, Math.min(400, bpmRef.current));
      timerRef.current = setTimeout(tick, Math.max(0, begin + beat * interval - Date.now()));
    };
    tick();
  }, []);

  const toggle = useCallback(() => { if (running) stop(); else start(); }, [running, start, stop]);

  return { bpm, setBpm, running, start, stop, toggle };
}

/** In-flight `stopAndUnloadAsync()` for the shot detector's Recording. iOS
 *  allows only one prepared Recording at a time, so a fast off→on must wait for
 *  the previous teardown to resolve before preparing a new one — otherwise
 *  prepare throws 'Only one Recording object can be prepared at a given time'
 *  and auto-count silently dies for the session. Module-scoped because the
 *  effect that owns the old recorder has already been torn down by the time the
 *  next effect runs. */
let teardownPromise: Promise<unknown> | null = null;

/** After a felt swing, the mic relaxes its thresholds for this long. An
 *  in-pocket strike is muffled by cloth, and at a loud range it can miss the
 *  normal prominence bar — but WITHIN a beat of the wearer's own swing, weaker
 *  audio evidence is enough (the IMU already supplied the strong evidence). */
const SWING_BOOST_MS = 700;

/**
 * Mic shot detector. Records (audio discarded) with metering on, and fires
 * `onHit` when a loud transient crosses a sensitivity-derived threshold, with a
 * refractory window so one strike counts once. `muteUntilRef` lets the caller
 * suppress detection right after a metronome click.
 *
 * ONE HIT PER ACOUSTIC EVENT: a hit dis-ARMS the detector, and it only re-arms
 * once the level falls back near the ambient floor. Without this, a loud sound
 * that LASTS — the ball rattling down a sim screen's return, a dropped bag, a
 * mower — sits far above the slowly-adapting floor and re-fires on every 50ms
 * metering frame, bounded only by the refractory: one event became 2-3 counts.
 * That was the core "one shot registers as 3" bug in mic-only mode.
 */
export function useShotDetector(opts: {
  enabled: boolean;
  sensitivity: number;           // 0 (only very loud) .. 1 (very sensitive)
  onHit: () => void;
  muteUntilRef?: MutableRefObject<number>;
  /** Min gap between counted hits (ms). Range uses a wider lock so the
   *  ball-hits-the-screen echo collapses into one shot; putting keeps the
   *  default 320 so rapid putts still register. */
  refractoryMs?: number;
  /** Timestamp (Date.now) of the most recent IMU-felt swing. When a transient
   *  arrives within SWING_BOOST_MS of it, thresholds relax so a pocket-muffled
   *  strike still registers. Stays 0 in mic-only mode (no boost). */
  swingBoostRef?: MutableRefObject<number>;
}) {
  const { enabled, sensitivity, onHit, muteUntilRef, refractoryMs = 320, swingBoostRef } = opts;
  const recRef = useRef<Audio.Recording | null>(null);
  const lastHitRef = useRef(0);
  const onHitRef = useRef(onHit);
  onHitRef.current = onHit;
  const sensRef = useRef(sensitivity);
  sensRef.current = sensitivity;
  const refractoryRef = useRef(refractoryMs);
  refractoryRef.current = refractoryMs;
  // Rolling ambient floor + previous sample, for adaptive transient detection.
  const bgRef = useRef(-55);
  const prevRef = useRef(-60);
  // Schmitt-trigger arm state: hits fire only while armed; re-arms near floor.
  const armedRef = useRef(true);
  const [permission, setPermission] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const perm = await Audio.requestPermissionsAsync();
        if (!perm.granted) { setPermission(false); return; }
        setPermission(true);
        // Wait for any previous recorder's teardown to finish before preparing
        // a new one — iOS only allows one prepared Recording at a time, so a
        // fast off→on would otherwise throw and kill auto-count for the session.
        await teardownPromise?.catch(() => { });
        if (!alive) return;
        await ensurePracticeAudioMode();
        armedRef.current = true;   // fresh session starts armed
        const rec = new Audio.Recording();
        await rec.prepareToRecordAsync({
          ...Audio.RecordingOptionsPresets.LOW_QUALITY,
          isMeteringEnabled: true,
        });
        rec.setProgressUpdateInterval(50);
        rec.setOnRecordingStatusUpdate((status) => {
          if (!status.isRecording || status.metering == null) return;
          const m = status.metering;            // dBFS (~-160 silence .. 0 max)
          const now = Date.now();
          const prev = prevRef.current;
          const bg = bgRef.current;
          const prominence = m - bg;            // how far above the ambient floor
          const rise = m - prev;                // onset sharpness vs the last frame
          // Update trackers for next frame. The ambient floor eases UP slowly
          // (so a strike isn't absorbed before we spot it) and DOWN fast (so it
          // tracks real quiet). Sustained noise — talking, wind, a mower —
          // gradually lifts the floor and stops crossing the prominence gate, so
          // only sudden impulses fire. Everything is RELATIVE to ambient, which
          // is why a muffled in-pocket strike still counts where a fixed dB
          // threshold missed it.
          prevRef.current = m;
          bgRef.current = bg + (m > bg ? 0.04 : 0.30) * (m - bg);
          // Re-arm once the level has fallen back near the ambient floor. A
          // sustained loud event (screen-return rattle, mower) keeps prominence
          // high, so it stays dis-armed and can never fire twice; genuine
          // silence between strikes re-arms within a frame or two.
          if (!armedRef.current && prominence < 4) armedRef.current = true;
          if (muteUntilRef && now < muteUntilRef.current) return;   // skip the metronome click
          const sens = sensRef.current;
          // Within a beat of a felt swing the IMU has already supplied strong
          // evidence this is OUR strike, so the audio bar drops: a pocket-
          // muffled crack that misses the normal thresholds still corroborates.
          const boosted = swingBoostRef != null && swingBoostRef.current > 0
            && now - swingBoostRef.current <= SWING_BOOST_MS;
          const needProm = (12 - sens * 7) - (boosted ? 3 : 0);  // sens 0 → 12 dB above floor, sens 1 → 5 dB
          const needRise = (9 - sens * 5) - (boosted ? 2 : 0);   // sens 0 → 9 dB jump, sens 1 → 4 dB
          const absFloor = boosted ? -64 : -58;
          // A real strike is a sharp impulse: well above ambient AND a fast
          // onset. The OR-path (a clearly prominent spike with a softer onset)
          // catches muffled, in-pocket strikes whose crisp transient is damped
          // by cloth. The absolute gate ignores noise-floor jitter.
          const hit = (prominence > needProm && rise > needRise) || prominence > needProm + 6;
          if (m > absFloor && hit && armedRef.current && now - lastHitRef.current > refractoryRef.current) {
            armedRef.current = false;           // one hit per acoustic event
            lastHitRef.current = now;
            onHitRef.current();
          }
        });
        await rec.startAsync();
        if (alive) recRef.current = rec;
        else {
          // Disabled mid-startup: tear this recorder down and track the promise
          // so a re-enable still waits for it (avoids the one-Recording race).
          teardownPromise = rec.stopAndUnloadAsync().catch(() => { });
        }
      } catch { /* mic unavailable — manual +/- still works */ }
    })();
    return () => {
      alive = false;
      const rec = recRef.current;
      recRef.current = null;
      // Track this teardown so the next enable waits for it (see teardownPromise
      // above), and restore normal playback routing once the mic is released so
      // audio doesn't stay stuck on the earpiece after a Range Sesh.
      const done = (rec?.stopAndUnloadAsync() ?? Promise.resolve()).catch(() => { });
      teardownPromise = done;
      done.then(() => {
        // Only heal the audio session if nothing has re-armed the recorder in
        // the meantime (rapid off→on), so we don't fight an active listener.
        if (teardownPromise === done && recRef.current == null) resetPracticeAudioMode();
      });
    };
  }, [enabled]);

  return { permission };
}
