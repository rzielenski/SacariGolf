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
        rec.setProgressUpdateInterval(80);
        rec.setOnRecordingStatusUpdate((status) => {
          if (!status.isRecording || status.metering == null) return;
          // metering is dBFS (~-160 silence .. 0 max). Higher sensitivity →
          // lower (easier-to-cross) threshold. Putts are quiet, so the slider
          // matters most there.
          const threshold = -3 - sensRef.current * 30; // sens 0 → -3dB, sens 1 → -33dB
          const now = Date.now();
          if (muteUntilRef && now < muteUntilRef.current) return;     // skip the metronome click
          if (status.metering > threshold && now - lastHitRef.current > 350) {
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
