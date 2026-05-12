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
 * limit and get a 400 on send. The cap is parameterised but the server
 * silently clamps too, so this is just UX courtesy.
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

export function useVoiceRecorder(maxDurationMs = 60_000): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recRef = useRef<Audio.Recording | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latch so the auto-stop on max-duration doesn't double-fire alongside
  // a user-triggered stop.
  const autoStoppingRef = useRef(false);

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
          // Let the consumer pick up the clip via their own stopAndGet.
          // No-op here — the next stopAndGet call resolves naturally with
          // the recording up to this moment.
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

  const stopAndGet = async (): Promise<VoiceClip | null> => {
    const rec = recRef.current;
    if (!rec) return null;
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

  const cancel = async () => {
    const rec = recRef.current;
    if (!rec) return;
    try { await rec.stopAndUnloadAsync(); } catch { /* ignore */ }
    teardown();
  };

  return { recording, elapsedMs, start, stopAndGet, cancel };
}
