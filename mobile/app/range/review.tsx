/**
 * Range Session — main screen.
 *
 * Two surfaces:
 *   1. Quick-launch row at the top: pick a club, record-or-pick a swing video.
 *      ImagePicker.launchCameraAsync covers both (iOS users can swipe to
 *      SLO-MO inside the system camera UI before recording, which is what
 *      we want for the body-pose / clubhead-trace analysis later).
 *   2. Session history below: every swing the user has captured on this
 *      device, with its analyzed metrics summarized. Tap → analysis screen.
 *
 * Premium-gated. Free users get the same UI but with a soft paywall when
 * they try to record. Existing recordings remain viewable if they were
 * captured under a previous premium period.
 *
 * Phase 1 analyzer is mocked but produces stable, club-aware, handicap-aware
 * results — see lib/rangeSession.ts. When we wire in the real Vision
 * framework path, only `analyzeSwing()` changes.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  ActivityIndicator, Image,
} from 'react-native';
import { router, Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import Constants from 'expo-constants';
import { useAuth } from '../../lib/auth';

/** True when the JS is running inside Expo Go (the public app from the
 *  App Store / Play Store) rather than our custom dev-client / production
 *  build. Expo Go can't link native modules like react-native-vision-camera,
 *  so we have to fall back to the system camera (ImagePicker) when this
 *  is true — otherwise the in-app camera screen crashes at import time. */
const isExpoGo = Constants.appOwnership === 'expo';
import { isPremium } from '../../lib/premium';
import { C, F } from '../../lib/colors';
import { CLUB_LABELS } from '../../lib/proSwingStats';
import {
  RangeSwing, CameraAngle, loadSwings, saveSwing, deleteSwing, analyzeSwing,
} from '../../lib/rangeSession';

const PICKABLE_CLUBS: { key: string; label: string }[] = [
  { key: 'driver', label: 'DRV' },
  { key: '3wood',  label: '3W' },
  { key: '5wood',  label: '5W' },
  { key: 'hybrid', label: 'HY' },
  { key: '4iron',  label: '4i' },
  { key: '5iron',  label: '5i' },
  { key: '6iron',  label: '6i' },
  { key: '7iron',  label: '7i' },
  { key: '8iron',  label: '8i' },
  { key: '9iron',  label: '9i' },
  { key: 'pw',     label: 'PW' },
  { key: 'gw',     label: 'GW' },
  { key: 'sw',     label: 'SW' },
  { key: 'lw',     label: 'LW' },
];

export default function ReviewSesh() {
  const { user } = useAuth();
  const userIsPremium = isPremium(user as any);
  const [swings, setSwings] = useState<RangeSwing[]>([]);
  const [club, setClub] = useState<string>('7iron');
  const [cameraAngle, setCameraAngle] = useState<CameraAngle>('face_on');
  const [busy, setBusy] = useState(false);

  // Load history on mount + whenever we navigate back.
  const reload = useCallback(async () => {
    if (!user?.user_id) return;
    setSwings(await loadSwings(user.user_id));
  }, [user?.user_id]);
  useEffect(() => { reload(); }, [reload]);

  const startSwing = async (sourceCamera: boolean) => {
    if (!user?.user_id) return;
    if (!userIsPremium) {
      Alert.alert(
        'Premium feature',
        'Range Session is a premium feature. Upgrade to capture swing analysis with body-pose, clubhead trace, and pro-comparison stats.',
        [{ text: 'OK' }, { text: 'Upgrade', onPress: () => router.push('/premium' as any) }],
      );
      return;
    }

    // Camera path → in-app vision-camera screen (real SLO-MO support via
    // AVCaptureSession). That screen handles permission, fps selection,
    // record/stop, save, analyze, and the final navigation to
    // /range/analyze — so we just hand off and let it drive.
    //
    // Expo Go fallback: vision-camera needs a dev build, so when we're
    // running in the public Expo Go app we fall through to the
    // ImagePicker.launchCameraAsync flow below (which uses iOS's stock
    // UIImagePickerController — no SLO-MO chips, but the app stays
    // functional until the user installs a dev build).
    if (sourceCamera && !isExpoGo) {
      const swingId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      router.push(
        `/range/camera?club=${encodeURIComponent(club)}` +
        `&angle=${cameraAngle}&swingId=${swingId}` as any,
      );
      return;
    }

    // Either:
    //   • Upload-existing path (sourceCamera = false), OR
    //   • Expo Go fallback for the record path (sourceCamera = true, but
    //     isExpoGo) — vision-camera unavailable, so use the OS camera UI
    //     via ImagePicker. No SLO-MO chips in this fallback path; that's
    //     the cost of Expo Go.
    const perm = sourceCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert(
        'Permission needed',
        `Sacari needs ${sourceCamera ? 'camera' : 'photo library'} access to import your swing.`,
      );
      return;
    }

    setBusy(true);
    try {
      const result = sourceCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Videos,
            videoMaxDuration: 15,
            quality: 1,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Videos,
            quality: 1,
            videoMaxDuration: 15,
          });
      if (result.canceled || !result.assets?.[0]?.uri) {
        setBusy(false);
        return;
      }
      const videoUri = result.assets[0].uri;
      const swingId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

      const pending: RangeSwing = {
        swing_id: swingId,
        club,
        cameraAngle,
        video_uri: videoUri,
        recorded_at: new Date().toISOString(),
        status: 'analyzing',
      };
      await saveSwing(user.user_id, pending);
      await reload();

      try {
        const { source, ...result } = await analyzeSwing(
          videoUri, club, swingId, user.handicap_index ?? null, cameraAngle
        );
        const complete: RangeSwing = { ...pending, status: 'complete', result, source };
        await saveSwing(user.user_id, complete);
        await reload();
        router.push(`/range/analyze?swing=${swingId}` as any);
      } catch {
        const failed: RangeSwing = { ...pending, status: 'failed' };
        await saveSwing(user.user_id, failed);
        await reload();
        Alert.alert('Analysis failed', 'We couldn\'t analyze that swing. Try recording another.');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (swing: RangeSwing) => {
    Alert.alert(
      'Delete swing?',
      `Remove this ${CLUB_LABELS[swing.club] ?? swing.club} swing from ${new Date(swing.recorded_at).toLocaleString()}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            if (!user?.user_id) return;
            await deleteSwing(user.user_id, swing.swing_id);
            await reload();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Review Sesh', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Review Sesh</Text>
        <Text style={styles.sub}>
          Record a swing, see your body-pose breakdown + clubhead path, and
          compare every metric to pro and rec-player baselines.
        </Text>

        {!userIsPremium && (
          <View style={styles.paywall}>
            <Text style={styles.paywallLabel}>PREMIUM</Text>
            <Text style={styles.paywallBody}>
              Range Session is a premium feature. Captured swings remain
              viewable if you've ever subscribed, but recording new ones
              requires an active subscription.
            </Text>
            <TouchableOpacity style={styles.paywallBtn} onPress={() => router.push('/premium' as any)}>
              <Text style={styles.paywallBtnText}>See premium</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Club picker — horizontal scrollable strip of club chips. */}
        <Text style={styles.sectionLabel}>CLUB</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.clubRow}
          contentContainerStyle={{ paddingHorizontal: 4 }}
        >
          {PICKABLE_CLUBS.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[styles.clubChip, club === c.key && styles.clubChipActive]}
              onPress={() => setClub(c.key)}
            >
              <Text style={[styles.clubChipLabel, club === c.key && styles.clubChipLabelActive]}>
                {c.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <Text style={styles.clubFullName}>{CLUB_LABELS[club]}</Text>

        {/* Camera angle picker — controls how the analyzer interprets the
            recording. Face-on shows torso rotation + tempo most clearly;
            down-the-line shows swing plane + path most clearly. Save this
            on the swing record so the analyzer + pose studio can use the
            right keyframe set. */}
        <Text style={styles.sectionLabel}>CAMERA ANGLE</Text>
        <View style={styles.angleRow}>
          {(['face_on', 'down_the_line'] as CameraAngle[]).map((a) => (
            <TouchableOpacity
              key={a}
              style={[styles.angleChip, cameraAngle === a && styles.angleChipActive]}
              onPress={() => setCameraAngle(a)}
              activeOpacity={0.85}
            >
              <Text style={[styles.angleLabel, cameraAngle === a && styles.angleLabelActive]}>
                {a === 'face_on' ? 'FACE-ON' : 'DOWN-THE-LINE'}
              </Text>
              <Text style={[styles.angleSub, cameraAngle === a && styles.angleSubActive]}>
                {a === 'face_on'
                  ? 'Camera in front — best for tempo + body rotation'
                  : 'Camera behind, along target line — best for swing plane'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── In-app SLO-MO camera explainer ─────────────────────────
            Tap "Record swing" → in-app camera with FPS chips
            (30 / 60 / SLO 120 / SLO 240). We probe the device for what
            it can deliver and grey-out anything the hardware doesn't
            support. Playback in the analyzer can ALSO be slowed via
            the SPEED chips, so a 30fps recording still gets useful
            slow-motion analysis. */}
        <View style={styles.slomoHint}>
          <Text style={styles.slomoHintIcon}>◐</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.slomoHintTitle}>SLO-MO recording — in-app</Text>
            <Text style={styles.slomoHintBody}>
              The record button opens our in-app camera with a SLO-MO
              toggle (120 / 240 fps where your phone supports it). After
              recording, you can slow playback further on the analyzer.
            </Text>
          </View>
        </View>

        {/* Capture row */}
        <View style={styles.captureRow}>
          <TouchableOpacity
            style={[styles.captureBtn, styles.captureBtnPrimary, busy && { opacity: 0.5 }]}
            onPress={() => startSwing(true)}
            disabled={busy}
          >
            {busy ? <ActivityIndicator color={C.bg} /> : <>
              <Text style={styles.captureBtnIcon}>●</Text>
              <Text style={styles.captureBtnLabel}>Record swing</Text>
              <Text style={styles.captureBtnSub}>In-app camera with SLO-MO 120/240</Text>
            </>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.captureBtn, busy && { opacity: 0.5 }]}
            onPress={() => startSwing(false)}
            disabled={busy}
          >
            <Text style={styles.captureBtnIconAlt}>⇪</Text>
            <Text style={styles.captureBtnLabelAlt}>Upload existing</Text>
            <Text style={styles.captureBtnSubAlt}>Pick a video from your library</Text>
          </TouchableOpacity>
        </View>

        {/* Session history */}
        <Text style={[styles.sectionLabel, { marginTop: 28 }]}>HISTORY</Text>
        {swings.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No swings recorded yet.</Text>
            <Text style={styles.emptySub}>
              Record one above. Once analyzed it lands here for comparison
              against future swings.
            </Text>
          </View>
        ) : (
          swings.map((s) => (
            <TouchableOpacity
              key={s.swing_id}
              style={styles.swingRow}
              onPress={() => router.push(`/range/analyze?swing=${s.swing_id}` as any)}
              onLongPress={() => confirmDelete(s)}
              activeOpacity={0.75}
              disabled={s.status === 'analyzing'}
            >
              <View style={styles.swingThumb}>
                <Text style={styles.swingThumbText}>
                  {CLUB_LABELS[s.club]?.split(' ').map((w) => w[0]).join('') ?? s.club}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.swingClub}>{CLUB_LABELS[s.club] ?? s.club}</Text>
                <Text style={styles.swingMeta}>
                  {new Date(s.recorded_at).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                  {s.status === 'complete' && s.result && (
                    <Text style={styles.swingMetric}>
                      {'  ·  '}{s.result.club.clubheadSpeedMph} mph
                      {'  ·  '}{s.result.club.carryYds} yds
                    </Text>
                  )}
                </Text>
              </View>
              {s.status === 'analyzing' && <ActivityIndicator color={C.gold} />}
              {s.status === 'complete' && <Text style={styles.swingChev}>›</Text>}
              {s.status === 'failed' && <Text style={styles.swingFailed}>FAILED</Text>}
            </TouchableOpacity>
          ))
        )}

        <Text style={styles.note}>
          Long-press a swing to delete. Videos are stored on this device only —
          no cloud upload.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  title: { color: C.text, fontFamily: F.serif, fontSize: 28, fontWeight: '900', marginBottom: 6 },
  sub: { color: C.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 22 },

  paywall: {
    backgroundColor: C.gold + '11',
    borderColor: C.gold,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 18,
  },
  paywallLabel: { color: C.gold, fontWeight: '900', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 },
  paywallBody: { color: C.text, fontSize: 13, lineHeight: 17 },
  paywallBtn: {
    alignSelf: 'flex-start',
    marginTop: 10,
    backgroundColor: C.gold,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  paywallBtnText: { color: C.bg, fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },

  sectionLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 10 },

  clubRow: { marginBottom: 4 },
  clubChip: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 6,
    minWidth: 48,
    alignItems: 'center',
  },
  clubChipActive: { backgroundColor: C.gold + '22', borderColor: C.gold },
  clubChipLabel: { color: C.textMuted, fontWeight: '900', fontSize: 12, letterSpacing: 0.5 },
  clubChipLabelActive: { color: C.gold },
  clubFullName: { color: C.text, fontSize: 12, marginTop: 6, marginBottom: 16, fontWeight: '700' },

  angleRow: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  angleChip: {
    flex: 1,
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  angleChipActive: { backgroundColor: C.gold + '14', borderColor: C.gold },
  angleLabel:     { color: C.textMuted, fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  angleLabelActive: { color: C.gold },
  angleSub:       { color: C.textDim, fontSize: 10, marginTop: 4, lineHeight: 13 },
  angleSubActive: { color: C.text },


  slomoHint: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: C.card,
    borderColor: C.gold + '66',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    alignItems: 'flex-start',
  },
  slomoHintIcon: { color: C.gold, fontSize: 22, lineHeight: 22, marginTop: 1 },
  slomoHintTitle: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, marginBottom: 4 },
  slomoHintBody: { color: C.text, fontSize: 12, lineHeight: 17 },

  captureRow: { flexDirection: 'row', gap: 10 },
  captureBtn: {
    flex: 1,
    backgroundColor: C.card,
    borderColor: C.gold,
    borderWidth: 1,
    borderRadius: 10,
    padding: 16,
    alignItems: 'flex-start',
  },
  captureBtnPrimary: { backgroundColor: C.gold },
  captureBtnIcon: { color: C.red, fontSize: 22, fontWeight: '900' },
  captureBtnIconAlt: { color: C.gold, fontSize: 22, fontWeight: '900' },
  captureBtnLabel: { color: C.bg, fontSize: 15, fontWeight: '900', marginTop: 6 },
  captureBtnLabelAlt: { color: C.text, fontSize: 15, fontWeight: '900', marginTop: 6 },
  captureBtnSub: { color: 'rgba(0,0,0,0.6)', fontSize: 10, marginTop: 3 },
  captureBtnSubAlt: { color: C.textMuted, fontSize: 10, marginTop: 3 },

  emptyBox: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 18,
    alignItems: 'center',
    gap: 6,
  },
  emptyText: { color: C.text, fontWeight: '700' },
  emptySub: { color: C.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  swingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    gap: 12,
  },
  swingThumb: {
    width: 44, height: 44, borderRadius: 6,
    backgroundColor: C.gold + '22',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.gold + '66',
  },
  swingThumbText: { color: C.gold, fontWeight: '900', fontSize: 14 },
  swingClub: { color: C.text, fontSize: 14, fontWeight: '800' },
  swingMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  swingMetric: { color: C.gold, fontWeight: '700' },
  swingChev: { color: C.textDim, fontSize: 22 },
  swingFailed: { color: C.red, fontWeight: '900', fontSize: 10 },

  note: { color: C.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 22 },
});
