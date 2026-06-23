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

/**
 * Mic shot detector. Records (audio discarded) with metering on, and fires
 * `onHit` when a loud transient crosses a sensitivity-derived threshold, with a
 * refractory window so one strike counts once. `muteUntilRef` lets the caller
 * suppress detection right after a metronome click.
 */
export function useShotDetector(opts: {
  enabled: boolean;
  sensitivity: number;           // 0 (only very loud) .. 1 (very sensitive)
  onHit: () => void;
  muteUntilRef?: MutableRefObject<number>;
}) {
  const { enabled, sensitivity, onHit, muteUntilRef } = opts;
  const recRef = useRef<Audio.Recording | null>(null);
  const lastHitRef = useRef(0);
  const onHitRef = useRef(onHit);
  onHitRef.current = onHit;
  const sensRef = useRef(sensitivity);
  sensRef.current = sensitivity;
  // Rolling ambient floor + previous sample, for adaptive transient detection.
  const bgRef = useRef(-55);
  const prevRef = useRef(-60);
  const [permission, setPermission] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const perm = await Audio.requestPermissionsAsync();
        if (!perm.granted) { setPermission(false); return; }
        setPermission(true);
        await ensurePracticeAudioMode();
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
          if (muteUntilRef && now < muteUntilRef.current) return;   // skip the metronome click
          const sens = sensRef.current;
          const needProm = 12 - sens * 7;       // sens 0 → 12 dB above floor, sens 1 → 5 dB
          const needRise = 9 - sens * 5;        // sens 0 → 9 dB jump, sens 1 → 4 dB
          // A real strike is a sharp impulse: well above ambient AND a fast
          // onset. The OR-path (a clearly prominent spike with a softer onset)
          // catches muffled, in-pocket strikes whose crisp transient is damped
          // by cloth. The absolute gate ignores noise-floor jitter.
          const hit = (prominence > needProm && rise > needRise) || prominence > needProm + 6;
          if (m > -58 && hit && now - lastHitRef.current > 320) {
            lastHitRef.current = now;
            onHitRef.current();
          }
        });
        await rec.startAsync();
        if (alive) recRef.current = rec;
        else await rec.stopAndUnloadAsync().catch(() => { });
      } catch { /* mic unavailable — manual +/- still works */ }
    })();
    return () => {
      alive = false;
      const rec = recRef.current;
      recRef.current = null;
      rec?.stopAndUnloadAsync().catch(() => { });
    };
  }, [enabled]);

  return { permission };
}
