/**
 * Range Sesh / Putting Sesh — a live practice counter for "The Grind".
 *
 * One screen, two modes via ?kind=range|putting. The mic listens for ball
 * contact (loud crack) or a putt (quiet tick) and auto-increments; a sensitivity
 * control + manual +/- cover misses. A metronome (default 78 bpm) helps tempo.
 * On finish the session is logged to the server so it counts toward the
 * lifetime total on your profile.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { C, F } from '../../lib/colors';
import { api } from '../../lib/api';
import { useMetronome, useShotDetector } from '../../lib/practiceAudio';
import {
  useSwingShotGate, useSwingCalibrator, loadSwingCalibration, saveSwingCalibration,
  swingGateAvailable, DEFAULT_CALIBRATION, type SwingCalibration,
} from '../../lib/practiceSwing';

const SENS = [
  { label: 'LOW', value: 0.25 },
  { label: 'MED', value: 0.55 },
  { label: 'HIGH', value: 0.9 },
];

export default function PracticeSesh() {
  const { kind: kindParam } = useLocalSearchParams<{ kind?: string }>();
  const kind: 'range' | 'putting' = kindParam === 'putting' ? 'putting' : 'range';
  const isPutting = kind === 'putting';
  const title = isPutting ? 'Putting Sesh' : 'Range Sesh';
  const noun = isPutting ? 'PUTTS' : 'SHOTS';

  const [count, setCount] = useState(0);
  const [listening, setListening] = useState(false);
  // Putts are much quieter, so default them to the most sensitive preset.
  const [sensitivity, setSensitivity] = useState(isPutting ? 0.9 : 0.55);
  const [saving, setSaving] = useState(false);
  const startedAt = useRef(Date.now());
  const muteUntilRef = useRef(0);

  // ── Swing gate (iOS range only) ──────────────────────────────────────────
  // The phone in your pocket physically feels YOUR swing; a clap, a neighbor's
  // bay, and the ball hitting the sim screen don't move it. So counting is
  // SWING-DRIVEN: only a felt swing can add to the count, and the mic is a
  // passive corroboration signal that never counts on its own (see
  // useSwingShotGate). Putting and Android have no usable motion signal, so they
  // stay mic-only.
  const swingGateOn = swingGateAvailable && !isPutting;
  const [calibration, setCalibration] = useState<SwingCalibration>(DEFAULT_CALIBRATION);

  useEffect(() => {
    if (!swingGateOn) return;
    let alive = true;
    loadSwingCalibration().then((c) => { if (alive) setCalibration(c); });
    return () => { alive = false; };
  }, [swingGateOn]);

  const calibrator = useSwingCalibrator({
    onDone: (c) => { setCalibration(c); saveSwingCalibration(c); },
  });

  const gate = useSwingShotGate({
    enabled: listening && swingGateOn && !calibrator.active,
    calibration,
    onCount: () => setCount((c) => c + 1),
  });

  const metro = useMetronome(78, () => { muteUntilRef.current = Date.now() + 140; });
  const detector = useShotDetector({
    enabled: listening && !calibrator.active,
    sensitivity,
    // In gated mode dedupe lives on the swing side, so a short refractory is
    // safe and lets every transient reach the gate; mic-only mode keeps the
    // wide lock to collapse the ball-hits-screen echo into one count.
    refractoryMs: isPutting ? 320 : (swingGateOn ? 200 : 600),
    onHit: () => {
      if (calibrator.active) return;
      if (!swingGateOn) { setCount((c) => c + 1); return; }   // putting / Android: mic-only
      gate.reportCrack();                                      // gated: corroborate a felt swing
    },
    muteUntilRef,
  });

  const finish = async () => {
    if (count <= 0) { router.back(); return; }
    const durationS = Math.round((Date.now() - startedAt.current) / 1000);
    setSaving(true);
    try {
      await api.practice.logSession({ kind, shots: count, durationS, bpm: metro.running ? metro.bpm : null });
    } catch { /* keep it feeling saved even if the network blips */ }
    setSaving(false);
    router.back();
  };

  const bump = (n: number) => metro.setBpm(Math.max(30, Math.min(240, metro.bpm + n)));

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title, headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Live counter */}
        <View style={s.counterCard}>
          <Text style={s.count}>{count}</Text>
          <Text style={s.countLabel}>{noun} THIS SESH</Text>
          <View style={s.manualRow}>
            <TouchableOpacity style={s.manualBtn} onPress={() => setCount((c) => Math.max(0, c - 1))}>
              <Ionicons name="remove" size={26} color={C.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.manualBtn, s.manualBtnPlus]} onPress={() => setCount((c) => c + 1)}>
              <Ionicons name="add" size={26} color={C.bg} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Mic listening */}
        <Text style={s.section}>AUTO-COUNT (MIC)</Text>
        <TouchableOpacity
          style={[s.listenBtn, listening && s.listenBtnOn]}
          onPress={() => setListening((v) => !v)}
          activeOpacity={0.8}
        >
          <Ionicons name={listening ? 'mic' : 'mic-outline'} size={20} color={listening ? C.bg : C.gold} />
          <Text style={[s.listenLabel, listening && { color: C.bg }]}>
            {listening ? `Listening for ${isPutting ? 'putts' : 'contact'}…` : 'Tap to listen'}
          </Text>
        </TouchableOpacity>
        {detector.permission === false && (
          <Text style={s.hint}>Mic access denied — enable it in Settings, or use the +/- buttons.</Text>
        )}
        <View style={s.sensRow}>
          {SENS.map((p) => (
            <TouchableOpacity
              key={p.label}
              style={[s.sensChip, Math.abs(sensitivity - p.value) < 0.01 && s.sensChipOn]}
              onPress={() => setSensitivity(p.value)}
            >
              <Text style={[s.sensLabel, Math.abs(sensitivity - p.value) < 0.01 && { color: C.gold }]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.hint}>
          Sensitivity {isPutting ? 'HIGH suits quiet putts' : 'MED suits range contact'}. Bump it up if shots aren't
          registering, down if it over-counts.
        </Text>

        {/* Swing gate — iOS range only */}
        {swingGateOn && (
          <>
            <Text style={s.section}>SWING GATE</Text>
            <View style={s.gateCard}>
              <Text style={s.gateBlurb}>
                Phone in your pocket. The gate only counts a crack that lines up with your real swing, so claps, the
                next bay over, and the ball hitting the screen are ignored.
              </Text>
              {calibrator.active ? (
                <>
                  <Text style={s.gateBig}>Swing now · {calibrator.captured}/{calibrator.needed}</Text>
                  <Text style={s.hint}>Hit {calibrator.needed} normal shots so it learns your motion.</Text>
                  <TouchableOpacity style={s.gateCancel} onPress={calibrator.cancel}>
                    <Text style={s.gateCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity style={s.gateBtn} onPress={calibrator.start} activeOpacity={0.85}>
                    <Ionicons name="pulse" size={18} color={C.bg} />
                    <Text style={s.gateBtnText}>Calibrate to my swing</Text>
                  </TouchableOpacity>
                  <Text style={s.hint}>
                    {calibration.impactReliable
                      ? `Calibrated · swing peak ~${calibration.measuredPeakGyro}°/s`
                      : 'Using defaults. Calibrate in your bay for best accuracy.'}
                  </Text>
                </>
              )}
              {__DEV__ && gate.lastSwing && (
                <Text style={s.gateDebug}>
                  last swing {gate.lastSwing.peak}°/s · impact {gate.lastSwing.impact ? 'yes' : 'no'}
                </Text>
              )}
            </View>
          </>
        )}

        {/* Metronome */}
        <Text style={s.section}>METRONOME</Text>
        <View style={s.metroCard}>
          <View style={s.metroBpmRow}>
            <TouchableOpacity style={s.bpmBtn} onPress={() => bump(-5)}><Text style={s.bpmBtnText}>−5</Text></TouchableOpacity>
            <TouchableOpacity style={s.bpmBtn} onPress={() => bump(-1)}><Text style={s.bpmBtnText}>−</Text></TouchableOpacity>
            <View style={s.bpmDisplay}>
              <Text style={s.bpmValue}>{metro.bpm}</Text>
              <Text style={s.bpmUnit}>BPM</Text>
            </View>
            <TouchableOpacity style={s.bpmBtn} onPress={() => bump(1)}><Text style={s.bpmBtnText}>+</Text></TouchableOpacity>
            <TouchableOpacity style={s.bpmBtn} onPress={() => bump(5)}><Text style={s.bpmBtnText}>+5</Text></TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[s.metroToggle, metro.running && s.metroToggleOn]}
            onPress={metro.toggle}
            activeOpacity={0.8}
          >
            <Ionicons name={metro.running ? 'stop' : 'play'} size={18} color={metro.running ? C.bg : C.gold} />
            <Text style={[s.metroToggleText, metro.running && { color: C.bg }]}>{metro.running ? 'Stop' : 'Start beat'}</Text>
          </TouchableOpacity>
        </View>

        {/* Finish */}
        <TouchableOpacity style={[s.finishBtn, saving && { opacity: 0.5 }]} onPress={finish} disabled={saving}>
          <Text style={s.finishText}>{saving ? 'Saving…' : count > 0 ? `Finish & log ${count} ${noun.toLowerCase()}` : 'Done'}</Text>
        </TouchableOpacity>
        <Text style={s.note}>Logged sessions count toward your lifetime total in The Grind.</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingBottom: 60 },

  counterCard: {
    backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingVertical: 28, alignItems: 'center', marginBottom: 24,
  },
  count: { color: C.gold, fontSize: 84, fontWeight: '900', fontFamily: F.serif, lineHeight: 88 },
  countLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginTop: 2 },
  manualRow: { flexDirection: 'row', gap: 16, marginTop: 18 },
  manualBtn: {
    width: 56, height: 48, borderRadius: 8, backgroundColor: C.bg,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center',
  },
  manualBtnPlus: { backgroundColor: C.gold, borderColor: C.gold },

  section: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 10 },
  listenBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold, borderRadius: 10, paddingVertical: 14,
  },
  listenBtnOn: { backgroundColor: C.gold, borderColor: C.gold },
  listenLabel: { color: C.gold, fontWeight: '800', fontSize: 14 },
  sensRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  sensChip: {
    flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 6,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  sensChipOn: { borderColor: C.gold, backgroundColor: C.gold + '22' },
  sensLabel: { color: C.textMuted, fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  hint: { color: C.textDim, fontSize: 11, lineHeight: 15, marginTop: 8 },

  gateCard: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 },
  gateBlurb: { color: C.textMuted, fontSize: 12, lineHeight: 17 },
  gateBig: { color: C.gold, fontSize: 22, fontWeight: '900', fontFamily: F.serif, marginTop: 6 },
  gateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: C.gold, borderRadius: 8, paddingVertical: 12, marginTop: 8,
  },
  gateBtnText: { color: C.bg, fontWeight: '900', fontSize: 13 },
  gateCancel: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 4, marginTop: 4 },
  gateCancelText: { color: C.textMuted, fontWeight: '800', fontSize: 12 },
  gateDebug: { color: C.textDim, fontSize: 10, fontFamily: F.mono, marginTop: 8 },

  metroCard: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, gap: 14 },
  metroBpmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  bpmBtn: {
    minWidth: 40, height: 40, borderRadius: 6, backgroundColor: C.bg,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
  },
  bpmBtnText: { color: C.text, fontSize: 16, fontWeight: '800' },
  bpmDisplay: { alignItems: 'center', minWidth: 70 },
  bpmValue: { color: C.gold, fontSize: 32, fontWeight: '900', fontFamily: F.serif },
  bpmUnit: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginTop: -2 },
  metroToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: C.gold, borderRadius: 8, paddingVertical: 11,
  },
  metroToggleOn: { backgroundColor: C.gold, borderColor: C.gold },
  metroToggleText: { color: C.gold, fontWeight: '800', fontSize: 13 },

  finishBtn: { backgroundColor: C.gold, borderRadius: 10, paddingVertical: 16, alignItems: 'center', marginTop: 28 },
  finishText: { color: C.bg, fontWeight: '900', fontSize: 15 },
  note: { color: C.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 12, textAlign: 'center' },
});
