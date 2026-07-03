/**
 * Hold-to-record voice message hook. Wraps expo-av Audio.Recording with a
 * tiny lifecycle: idle → recording → finished/cancelled. Exposes the elapsed
 * duration for the UI to show a "00:08" pill while the user holds the mic.
 *
 *   const r = useVoiceRecorder(60_000);
 *   r.start();                         // call when finger goes down
 *   const clip = await r.stopAndGet(); // call when finger comes up
 *   r.cancel();                        // call on slide-to-cancel
 *
 * On success `stopAndGet()` returns `{ base64, mime, durationMs }` ready to
 * POST. Permission requests are inline — fail-fast returns null if the user
 * declines the mic prompt.
 *
 * The 60s cap auto-stops recording so the user can't hold past the server's
 * limit and get a 400 on send. When the cap fires while the finger is still
 * down, the hook stops+reads the clip itself and delivers it via the optional
 * `onMaxDuration` callback (the consumer sends it just like a manual finger-up).
 * The cap is parameterised but the server silently clamps too.
 */

import { useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import { File } from 'expo-file-system';

export interface VoiceClip {
  base64: string;
  mime: string;
  durationMs: number;
}

export interface VoiceRecorder {
  /** True while a Recording instance is live. */
  recording: boolean;
  /** Milliseconds elapsed since start() was called. Updated every 100ms. */
  elapsedMs: number;
  /** Begin a new recording. No-op if one is already running. */
  start: () => Promise<boolean>;
  /** Stop the current recording and return the audio bytes. null on
   *  permission failure or if no recording was active. */
  stopAndGet: () => Promise<VoiceClip | null>;
  /** Abandon the current recording without returning a clip. Frees the file. */
  cancel: () => Promise<void>;
}

/**
 * @param maxDurationMs  Hard cap; recording auto-stops when reached.
 * @param onMaxDuration  Optional. Invoked with the finished clip when the cap
 *   auto-stops the recording (so the consumer can send it just as it would on
 *   a manual finger-up). Not called on user-triggered stop/cancel.
 */
export function useVoiceRecorder(
  maxDurationMs = 60_000,
  onMaxDuration?: (clip: VoiceClip) => void,
): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recRef = useRef<Audio.Recording | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latch so the auto-stop on max-duration doesn't double-fire alongside
  // a user-triggered stop.
  const autoStoppingRef = useRef(false);
  // Keep the latest onMaxDuration in a ref so the tick (bound once per
  // recording) always calls the current callback without re-binding.
  const onMaxDurationRef = useRef(onMaxDuration);
  onMaxDurationRef.current = onMaxDuration;

  // Cleanup on unmount — if the user navigates away mid-record, drop the
  // Recording so the OS releases the mic. Best-effort; if it fails the
  // recording object is already partially finalised and will GC.
  useEffect(() => {
    return () => {
      if (recRef.current) {
        recRef.current.stopAndUnloadAsync().catch(() => { });
        recRef.current = null;
      }
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  const start = async () => {
    if (recRef.current) return true; // already recording — idempotent
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (perm.status !== 'granted') return false;
      // Allow recording even when the device is on silent mode (iOS default
      // is to deny mic access in silent). Players will mute their phones
      // on the course; this lets them record anyway.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new Audio.Recording();
      // High-quality preset — AAC m4a on iOS, AAC m4a on Android. Server
      // expects audio/m4a or audio/mp4 mime; this matches.
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
      setElapsedMs(0);
      autoStoppingRef.current = false;
      // Tick for the elapsed-time UI + auto-stop guard.
      tickRef.current = setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsedMs(ms);
        if (ms >= maxDurationMs && !autoStoppingRef.current) {
          autoStoppingRef.current = true;
          // Actually terminate the recording at the cap so the file bytes
          // stop growing and the reported duration stays honest. Stop the
          // tick first, finalise, then hand the clip to the consumer's
          // callback so it sends exactly as it would on finger-up.
          if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
          finalize().then((clip) => {
            if (clip) onMaxDurationRef.current?.(clip);
          });
        }
      }, 100);
      return true;
    } catch {
      // Recorder failed to start — permissions denied, hardware busy, etc.
      return false;
    }
  };

  const teardown = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    recRef.current = null;
    setRecording(false);
    setElapsedMs(0);
  };

  // Stop the live recording and read its bytes. Idempotent: claims recRef up
  // front so a second caller (e.g. the finger-release stopAndGet racing the
  // max-duration auto-stop) returns null instead of double-stopping.
  const finalize = async (): Promise<VoiceClip | null> => {
    const rec = recRef.current;
    if (!rec) return null;
    recRef.current = null; // claim immediately so a concurrent call bails
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      const durationMs = Math.min(Date.now() - startedAtRef.current, maxDurationMs);
      teardown();
      if (!uri) return null;
      // Read the local file into base64 for upload. The avatar upload uses
      // the same pattern — keeps the API surface uniform and avoids
      // multipart/form-data complications with our minimal fetch wrapper.
      const base64 = await new File(uri).base64();
      return { base64, mime: 'audio/m4a', durationMs };
    } catch {
      teardown();
      return null;
    }
  };

  const stopAndGet = async (): Promise<VoiceClip | null> => finalize();

  const cancel = async () => {
    const rec = recRef.current;
    if (!rec) return;
    try { await rec.stopAndUnloadAsync(); } catch { /* ignore */ }
    teardown();
  };

  return { recording, elapsedMs, start, stopAndGet, cancel };
}
