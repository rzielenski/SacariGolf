/**
 * In-app SLO-MO camera for range-session swing recording.
 *
 * Replaces the previous `ImagePicker.launchCameraAsync()` flow which used
 * iOS's UIImagePickerController — that surface is locked to basic
 * Photo / Video tabs and never exposes SLO-MO regardless of what hardware
 * the device supports. This screen drives an AVCaptureSession directly
 * via react-native-vision-camera so we can request 120 fps / 240 fps
 * recording on capable devices.
 *
 *   router.push(`/range/camera?club=7iron&angle=face_on&swingId=…`)
 *
 * On record-stop we save the swing record (status='analyzing') and
 * router.replace into /range/analyze so the user lands on the playback
 * surface — same final destination as the old ImagePicker flow.
 *
 * Notes on slo-mo support:
 *   • iPhone X / Xs / 11 / 12 / 13 / 14 / 15 / 16: 120 fps and 240 fps
 *     both supported at 1080p. Older devices may only support 120 fps.
 *   • We query `device.formats` and pick the highest-fps format that
 *     covers the requested resolution. If the requested fps isn't
 *     supported the chip is disabled with a "not on this device" note.
 *   • Playback in /range/analyze can ALSO be slowed via the SPEED chips
 *     — so 30 fps recordings still get useful slow-motion analysis.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Linking, Platform, AppState,
} from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

// ── react-native-vision-camera, guarded ─────────────────────────────────
// The library throws an unhandled error AT IMPORT TIME when it can't find
// its native TurboModule — which happens in Expo Go and in any build
// where the native code hasn't been linked yet. That throw cascades up,
// kills route registration for this file ("No route named 'range/camera'
// exists in nested children"), and breaks the rest of the app.
//
// `require()` inside a try/catch lets the file load successfully on
// every environment. When the import succeeds we use the real Camera /
// hooks; when it fails we render a fallback screen telling the user to
// run a dev build. Either way, the route registers and the rest of the
// app stays alive.
let VisionCamera: any = null;
let visionCameraLoadError: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  VisionCamera = require('react-native-vision-camera');
} catch (err: any) {
  visionCameraLoadError = String(err?.message ?? err);
}
// Convenience aliases — pulled off the module ref so we don't have to
// repeat the `VisionCamera?.X` dance every time. Typed as `any` because
// the real types only resolve when the package is installed AND linked
// (dev build); leaving as any keeps TS quiet in Expo Go too.
const Camera: any              = VisionCamera?.Camera;
const useCameraDevice: any     = VisionCamera?.useCameraDevice     ?? (() => null);
const useCameraFormat: any     = VisionCamera?.useCameraFormat     ?? (() => undefined);
const useCameraPermission: any = VisionCamera?.useCameraPermission ?? (() => ({
  hasPermission: false,
  requestPermission: async () => false,
}));
type CameraDevice = any;
type CameraDeviceFormat = any;

import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { CameraAngle, RangeSwing, saveSwing, analyzeSwing } from '../../lib/rangeSession';

/** FPS presets shown in the speed-mode chip row. 30 is the standard
 *  "Video" mode; 60 is iPhone's enhanced video; 120 and 240 are the two
 *  SLO-MO tiers in iOS's stock Camera app and the ones a golfer would
 *  actually want for swing analysis. We probe device support up front
 *  and grey-out anything the hardware can't deliver. */
const FPS_PRESETS: { label: string; fps: number; slomo: boolean }[] = [
  { label: '30',  fps: 30,  slomo: false },
  { label: '60',  fps: 60,  slomo: false },
  { label: '120', fps: 120, slomo: true  },
  { label: '240', fps: 240, slomo: true  },
];

/** Pick the best format the device offers for the requested fps. Vision
 *  Camera ranks formats by AVCaptureSession's metadata; we want the
 *  largest video size whose maxFps covers what we asked for. */
function pickFormat(device: CameraDevice | undefined, fps: number): CameraDeviceFormat | undefined {
  if (!device?.formats?.length) return undefined;
  const usable = device.formats.filter((f: any) => f.maxFps >= fps && f.minFps <= fps);
  if (!usable.length) return undefined;
  usable.sort((a: any, b: any) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  return usable.find((f: any) => f.videoWidth <= 1920 && f.videoHeight <= 1920) ?? usable[0];
}

/** Highest fps any of the device's formats can hit — used to grey out
 *  the chip row for anything the device can't deliver. */
function deviceMaxFps(device: CameraDevice | undefined): number {
  if (!device?.formats?.length) return 30;
  return device.formats.reduce((max: number, f: any) => Math.max(max, f.maxFps), 0);
}

export default function RangeCameraScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    club?: string;
    angle?: string;
    swingId?: string;
  }>();
  const club = params.club ?? '7iron';
  const cameraAngle: CameraAngle = params.angle === 'down_the_line' ? 'down_the_line' : 'face_on';
  const swingId = params.swingId ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const { hasPermission, requestPermission } = useCameraPermission();
  // Default to back camera — face-on / down-the-line both want the rear
  // lens. Front-camera flip is available via the button in the toolbar.
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const device = useCameraDevice(facing);
  const [fps, setFps] = useState<number>(120);
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1920, height: 1080 } },
    { fps },
  ]) ?? pickFormat(device, fps);

  // Recording state — `recording` flips when startRecording succeeds,
  // `elapsedMs` ticks via a 100ms interval so the on-screen timer reads
  // tenths of a second (useful for "did I get the whole swing").
  // Ref typed as `any` because the Camera class only resolves at runtime
  // (via require() under try/catch above). Using `typeof Camera` would
  // also work but yields `any` here anyway since Camera is itself `any`.
  const cameraRef = useRef<any>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [saving, setSaving] = useState(false);

  // Release the capture session when the app leaves the foreground or this
  // screen loses focus (e.g. we push to the analyze screen after a take). The
  // AVCaptureSession + its frame buffers are heavy; without this the camera
  // stayed live the entire time the screen was mounted, even backgrounded.
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  // Permission flow — ask once on first mount. If denied, surface a
  // settings-jump alert; without camera we have nothing to do here.
  useEffect(() => {
    if (hasPermission) return;
    (async () => {
      const granted = await requestPermission();
      if (!granted) {
        Alert.alert(
          'Camera access needed',
          'Sacari needs the camera to record your swing. You can enable it in Settings.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => router.back() },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      }
    })();
  }, [hasPermission, requestPermission]);

  // Tick the elapsed counter while recording. Caps the recording at 15s
  // (same cap the previous ImagePicker flow used) so a forgotten record
  // doesn't fill the disk.
  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const dt = Date.now() - startedAt;
      setElapsedMs(dt);
      if (dt > 15_000) stopRecording();
    }, 100);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const maxFps = useMemo(() => deviceMaxFps(device), [device]);

  /** Save the recorded clip + kick off analysis, then hop to the
   *  analyze screen. Mirrors the post-record flow from the old
   *  ImagePicker path so the rest of the app doesn't care which
   *  capture surface produced the video. */
  const finishWithVideo = useCallback(async (videoUri: string) => {
    if (!user?.user_id) return;
    setSaving(true);
    const pending: RangeSwing = {
      swing_id: swingId,
      club,
      cameraAngle,
      video_uri: videoUri,
      recorded_at: new Date().toISOString(),
      status: 'analyzing',
    };
    try {
      await saveSwing(user.user_id, pending);
      // Pop into the analyze screen IMMEDIATELY so the user sees their
      // recording — the analyzer runs in the background and updates the
      // record when it finishes (same pattern the index screen uses).
      router.replace(`/range/analyze?swing=${swingId}` as any);

      const result = await analyzeSwing(videoUri, club, swingId, user.handicap_index ?? null, cameraAngle);
      const { source, ...payload } = result;
      const complete: RangeSwing = { ...pending, status: 'complete', result: payload, source };
      await saveSwing(user.user_id, complete);
    } catch {
      const failed: RangeSwing = { ...pending, status: 'failed' };
      await saveSwing(user.user_id, failed);
    } finally {
      setSaving(false);
    }
  }, [user?.user_id, club, cameraAngle, swingId]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    try {
      setElapsedMs(0);
      cameraRef.current.startRecording({
        fileType: 'mp4',
        onRecordingFinished: (video: any) => {
          setRecording(false);
          // The video.path comes back as an absolute file:// URI on iOS.
          const uri = video.path.startsWith('file://') ? video.path : `file://${video.path}`;
          finishWithVideo(uri);
        },
        onRecordingError: (error: any) => {
          setRecording(false);
          Alert.alert('Recording failed', String(error?.message ?? error));
        },
      });
      setRecording(true);
    } catch (e: any) {
      Alert.alert('Could not start recording', e?.message ?? 'Unknown error');
    }
  }, [recording, finishWithVideo]);

  const stopRecording = useCallback(async () => {
    if (!cameraRef.current || !recording) return;
    try {
      await cameraRef.current.stopRecording();
    } catch (e: any) {
      Alert.alert('Could not stop recording', e?.message ?? 'Unknown error');
    }
  }, [recording]);

  // ── Render ────────────────────────────────────────────────────────────

  // Expo Go / non-dev-build fallback. vision-camera failed to load — we
  // can't render the camera at all, so show a clear message + an escape
  // hatch back to the range home. Routing the user to the system
  // ImagePicker isn't useful here because they already know the camera
  // path; they need to install a dev build.
  if (!VisionCamera || !Camera) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{
          title: 'Camera unavailable',
          headerStyle: { backgroundColor: '#000' },
          headerTintColor: C.text,
        }} />
        <Text style={[styles.permissionText, { color: C.gold, fontWeight: '900' }]}>
          SLO-MO camera needs a dev build
        </Text>
        <Text style={styles.permissionText}>
          The in-app camera uses react-native-vision-camera which isn&apos;t
          available in Expo Go. Run{' '}
          <Text style={{ fontFamily: 'Courier', color: C.gold }}>npx expo run:ios</Text>
          {' '}to install a dev build that includes it.
        </Text>
        {visionCameraLoadError && (
          <Text style={[styles.permissionText, { color: C.textMuted, fontSize: 11 }]}>
            {visionCameraLoadError}
          </Text>
        )}
        <TouchableOpacity
          style={[styles.cancelBtn, { marginTop: 12 }]}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.cancelBtnText}>← Back to Range</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Camera', headerStyle: { backgroundColor: '#000' }, headerTintColor: C.text }} />
        <ActivityIndicator color={C.gold} />
        <Text style={styles.permissionText}>Waiting on camera permission…</Text>
      </View>
    );
  }
  if (!device) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Camera', headerStyle: { backgroundColor: '#000' }, headerTintColor: C.text }} />
        <Text style={styles.permissionText}>No camera available on this device.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{
        title: 'Record Swing',
        headerStyle: { backgroundColor: '#000' },
        headerTintColor: C.text,
      }} />

      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        format={format}
        // `fps` only takes effect when `format` includes that fps in its
        // supported range. We picked the format to satisfy this — see
        // useCameraFormat call above.
        fps={fps}
        // Mute audio entirely — we don't need it for swing recording and
        // it lets us declare microphone permission as not required in
        // app.json (one fewer privacy prompt for the user).
        audio={false}
        video
        isActive={appActive && isFocused && !saving}
      />

      {/* ── Top status pill ──────────────────────────────────────────── */}
      <View style={styles.topRow}>
        <View style={styles.statusPill}>
          <Text style={styles.statusPillText}>
            {fps >= 120 ? `SLO-MO · ${fps} FPS` : `${fps} FPS`}
            {' · '}
            {cameraAngle === 'down_the_line' ? 'DOWN-THE-LINE' : 'FACE-ON'}
          </Text>
        </View>
        {recording && (
          <View style={styles.recPill}>
            <View style={styles.recDot} />
            <Text style={styles.recPillText}>
              REC {(elapsedMs / 1000).toFixed(1)}s
            </Text>
          </View>
        )}
      </View>

      {/* ── Speed mode chips ─────────────────────────────────────────── */}
      <View style={styles.fpsRow}>
        {FPS_PRESETS.map((p) => {
          const supported = p.fps <= maxFps;
          const active = fps === p.fps;
          return (
            <TouchableOpacity
              key={p.label}
              style={[
                styles.fpsChip,
                active && styles.fpsChipActive,
                !supported && styles.fpsChipDisabled,
              ]}
              disabled={!supported || recording}
              onPress={() => setFps(p.fps)}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.fpsChipLabel,
                active && styles.fpsChipLabelActive,
                !supported && styles.fpsChipLabelDisabled,
              ]}>
                {p.slomo ? 'SLO ' : ''}{p.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Bottom controls — flip / record / done ─────────────────── */}
      <View style={styles.bottomRow}>
        <TouchableOpacity
          style={styles.flipBtn}
          disabled={recording}
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          activeOpacity={0.7}
        >
          <Text style={styles.flipBtnText}>↻</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.recordBtnOuter, recording && styles.recordBtnOuterRec]}
          onPress={recording ? stopRecording : startRecording}
          disabled={saving}
          activeOpacity={0.7}
        >
          <View style={[styles.recordBtnInner, recording && styles.recordBtnInnerRec]} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelBtn}
          disabled={recording}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {saving && (
        <View style={styles.savingOverlay}>
          <ActivityIndicator color={C.gold} size="large" />
          <Text style={styles.savingText}>Saving recording…</Text>
        </View>
      )}

      {/* Platform note — vision-camera works on Android too, but our
          fps-format probing assumes iOS-style AVCaptureSession behavior.
          Surface a friendly note on Android. */}
      {Platform.OS === 'android' && fps >= 120 && (
        <View style={styles.androidNote}>
          <Text style={styles.androidNoteText}>
            High-fps SLO-MO support varies on Android — the recording will
            fall back to the highest available rate if 120/240 isn&apos;t
            supported on this device.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 30, gap: 12 },
  permissionText: { color: C.text, fontSize: 13, textAlign: 'center' },

  // Top status pill — sits below the navigation header.
  topRow: {
    position: 'absolute',
    top: 80,
    left: 16, right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  statusPill: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderColor: C.gold,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusPillText: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  recPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderColor: C.red, borderWidth: 1.5, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.red },
  recPillText: { color: C.red, fontSize: 11, fontWeight: '900', letterSpacing: 1 },

  // FPS / SLO-MO chip row — directly above the bottom controls so they
  // fall under the thumb.
  fpsRow: {
    position: 'absolute',
    bottom: 140,
    left: 0, right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  fpsChip: {
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 16,
    borderColor: C.border, borderWidth: 1,
    minWidth: 56, alignItems: 'center',
  },
  fpsChipActive: { backgroundColor: C.gold, borderColor: C.gold },
  fpsChipDisabled: { opacity: 0.35 },
  fpsChipLabel: { color: C.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  fpsChipLabelActive: { color: '#000' },
  fpsChipLabelDisabled: { color: C.textMuted },

  // Bottom row — flip / record / cancel.
  bottomRow: {
    position: 'absolute',
    bottom: 36,
    left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 30,
  },
  flipBtn: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderColor: C.border, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  flipBtnText: { color: C.text, fontSize: 22, fontWeight: '900' },
  cancelBtn: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)', borderColor: C.border, borderWidth: 1,
  },
  cancelBtnText: { color: C.text, fontSize: 13, fontWeight: '800' },

  // Big circular record button — outer ring + inner disc that morphs
  // from filled circle (idle) to square (recording).
  recordBtnOuter: {
    width: 78, height: 78, borderRadius: 39,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  recordBtnOuterRec: { borderColor: C.red },
  recordBtnInner: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: C.red,
  },
  recordBtnInnerRec: {
    width: 30, height: 30, borderRadius: 4,
    backgroundColor: C.red,
  },

  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center', justifyContent: 'center',
    gap: 12,
  },
  savingText: { color: C.text, fontSize: 14, fontFamily: F.serif, fontWeight: '700' },

  androidNote: {
    position: 'absolute',
    top: 130, left: 16, right: 16,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderColor: C.gold + '88', borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  androidNoteText: { color: C.text, fontSize: 11, lineHeight: 15 },
});
