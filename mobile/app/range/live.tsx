/**
 * Range Sesh Live — hit into a rendered driving range with a launch monitor.
 *
 * A bridge (see lib/launchMonitor.ts) streams GSPro-Connect shots over
 * WebSocket; every shot is run through our own ball-flight model
 * (lib/ballFlight.ts) so we own the trajectory, then drawn flying down the
 * range. At the end the session saves into the SAME store as the launch-
 * monitor CSV import, so range reps feed club distances, dispersion, and the
 * between-clubs partial suggestions on the course.
 *
 * LAYOUT: the range art fills the whole screen and everything else floats on
 * top of it. The photo supplies the scenery (sky, turf, trees); the SVG layer
 * is purely functional — target greens, the tracer, and where balls finished.
 * This screen is the one place in the app that rotates (see _layout.tsx), and
 * it swaps to the landscape art when turned.
 *
 * Demo mode generates plausible shots so the range is usable with no hardware.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, Animated, Easing,
  ImageBackground, useWindowDimensions,
} from 'react-native';
import { Stack, router } from 'expo-router';
import Svg, {
  Defs, LinearGradient, Stop, Path, Circle, G, Line,
  Text as SvgText,
} from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C, F } from '../../lib/colors';
import { api } from '../../lib/api';
import { simulateFlight, FlightResult, FlightPoint } from '../../lib/ballFlight';
import {
  connectLaunchMonitor, demoShot, discoverBridge, localNetworkReady,
  getDiagnostics, testAddress, BRIDGE_PORTS,
  LaunchShot, LaunchMonitorLink, LinkStatus, Diagnostics,
} from '../../lib/launchMonitor';
import { CLUBS_CATALOG, clubLabel } from '../../lib/clubs';

const BRIDGE_KEY = 'range_live_bridge_url';

/**
 * Range backdrop art. Swap these files to change the scenery — no code change.
 *
 * NOTE the mapping: the file named "range-portrait.jpg" is actually the WIDE
 * (1168×784) shot and "range-landscape.jpg" is the TALL (832×1248) one, so
 * they're wired to the orientation whose SHAPE they fit, not their filename.
 * If you re-export the art, match it by shape rather than trusting the names.
 */
const RANGE_ART = {
  /** Tall art for a portrait phone. */
  portrait: require('../../assets/range/range-landscape.jpg'),
  /** Wide art for a rotated phone. */
  landscape: require('../../assets/range/range-portrait.jpg'),
};
/** Where the turf meets the treeline in the art, as a fraction of image
 *  height — this is the vanishing-point row the ball flight is projected
 *  against. Both photos sit at roughly 53%. If you swap in art with a
 *  different horizon, change this or shots won't meet the ground. */
const HORIZON_FRAC = 0.53;

const TARGET_GREENS = [50, 100, 150, 200, 250];
const CAM_H = 6;         // camera height above the tee, yards
const CAM_D = 8;         // camera set-back from the tee, yards
const NEAR_YDS = 8;      // ground distance that sits at the bottom edge

/** Perspective projector for the current viewport. Single focal length for
 *  both axes so the geometry stays honest rather than anamorphic. */
function makeProject(w: number, h: number) {
  const horizonY = h * HORIZON_FRAC;
  // Chosen so NEAR_YDS lands exactly on the bottom edge — the ground plane
  // then fills everything between the horizon and the bottom of the screen.
  const focal = ((h - horizonY) * (NEAR_YDS + CAM_D)) / CAM_H;
  return (p: FlightPoint) => {
    const depth = p.x + CAM_D;
    return {
      x: w / 2 + (focal * p.y) / depth,
      y: horizonY + (focal * (CAM_H - p.z)) / depth,
    };
  };
}

type Landed = { id: number; club: string; shot: LaunchShot; flight: FlightResult };

export default function RangeLive() {
  const { width: winW, height: winH } = useWindowDimensions();
  const isLandscape = winW > winH;
  const project = useMemo(() => makeProject(winW, winH), [winW, winH]);

  const [club, setClub] = useState('7i');
  const [clubPickerOpen, setClubPickerOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [shots, setShots] = useState<Landed[]>([]);
  const [active, setActive] = useState<Landed | null>(null);
  const [status, setStatus] = useState<LinkStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanPct, setScanPct] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const linkRef = useRef<LaunchMonitorLink | null>(null);
  const scanSignal = useRef<{ cancelled: boolean }>({ cancelled: false });
  const nextId = useRef(1);
  const connectRef = useRef<((url: string) => void) | null>(null);

  // Flight animation: 0 → 1 along the trajectory path.
  const flightAnim = useRef(new Animated.Value(0)).current;
  const [flightT, setFlightT] = useState(1);
  useEffect(() => {
    const sub = flightAnim.addListener(({ value }) => setFlightT(value));
    return () => flightAnim.removeListener(sub);
  }, [flightAnim]);

  const autoConnect = useCallback(async () => {
    if (scanning) return;
    // An older binary physically can't reach the LAN (no expo-network, no
    // local-network entitlement). Say that instead of "nothing found", which
    // sends people hunting for a hardware problem that doesn't exist.
    if (!localNetworkReady()) {
      setStatus('idle');
      setStatusDetail(
        'This version of the app can\'t search your network yet. Range Live needs the next app update. Demo Shot works now.',
      );
      return;
    }
    scanSignal.current = { cancelled: false };
    setScanning(true);
    setScanPct(0);
    setStatusDetail(null);
    try {
      const saved = await AsyncStorage.getItem(BRIDGE_KEY).catch(() => null);
      if (saved) setBridgeUrl(saved);
      const found = await discoverBridge({
        preferred: saved, signal: scanSignal.current, onProgress: setScanPct,
      });
      if (scanSignal.current.cancelled) return;
      if (found) {
        setBridgeUrl(found);
        AsyncStorage.setItem(BRIDGE_KEY, found).catch(() => { });
        connectRef.current?.(found);
      } else {
        setStatus('idle');
        setStatusDetail('No launch monitor found on this WiFi.');
      }
    } finally { setScanning(false); }
  }, [scanning]);

  useEffect(() => {
    autoConnect();
    return () => { scanSignal.current.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run a launch-monitor shot through the flight model and fly it. */
  const ingest = useCallback((ls: LaunchShot, forClub: string) => {
    const flight = simulateFlight({
      ballSpeedMph: ls.ballSpeedMph,
      launchAngleDeg: ls.launchAngleDeg,
      azimuthDeg: ls.azimuthDeg,
      spinRpm: ls.spinRpm,
      spinAxisDeg: ls.spinAxisDeg,
    });
    const landed: Landed = { id: nextId.current++, club: forClub, shot: ls, flight };
    setActive(landed);
    setShots((prev) => [landed, ...prev]);
    flightAnim.setValue(0);
    Animated.timing(flightAnim, {
      toValue: 1,
      duration: Math.min(3200, Math.max(900, flight.flightTimeS * 620)),
      easing: Easing.linear,
      useNativeDriver: false,   // we read the value to index the path
    }).start();
  }, [flightAnim]);

  // Latest club, reachable from the socket callback without re-subscribing.
  const clubRef = useRef(club);
  clubRef.current = club;

  const connect = useCallback((url: string) => {
    linkRef.current?.close();
    linkRef.current = connectLaunchMonitor(url, {
      onShot: (s) => ingest(s, clubRef.current),
      onStatus: (st, detail) => { setStatus(st); setStatusDetail(detail ?? null); },
    });
  }, [ingest]);
  connectRef.current = connect;

  useEffect(() => () => { linkRef.current?.close(); }, []);

  const saveSession = async () => {
    if (!shots.length) return;
    setSaving(true);
    try {
      const payload = shots.map((s) => ({
        club: s.club,
        distance_yds: Math.round(s.flight.totalYds),
        lateral_yds: Math.round(s.flight.offlineYds),
      }));
      const res = await api.users.importShots({ name: 'Range Sesh Live', shots: payload });
      Alert.alert('Saved', `${res.total_shots} shots added to your club stats.`, [
        { text: 'Done', onPress: () => router.back() },
        { text: 'Keep hitting' },
      ]);
      setShots([]); setActive(null); setSessionOpen(false);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally { setSaving(false); }
  };

  const summary = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const s of shots) {
      const arr = by.get(s.club) ?? [];
      arr.push(s.flight.carryYds);
      by.set(s.club, arr);
    }
    return [...by.entries()].map(([c, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return { club: c, shots: arr.length, medianCarry: Math.round(sorted[Math.floor(sorted.length / 2)]) };
    }).sort((a, b) => b.medianCarry - a.medianCarry);
  }, [shots]);

  const statusColor =
    scanning ? C.gold
    : status === 'connected' ? C.green
    : status === 'connecting' ? C.gold
    : status === 'error' ? C.red : '#ffffffaa';
  const statusLabel =
    scanning ? `SEARCHING… ${Math.round(scanPct * 100)}%`
    : status === 'connected' ? 'CONNECTED'
    : status === 'connecting' ? 'CONNECTING…'
    : status === 'error' ? 'CONNECTION ERROR'
    : status === 'closed' ? 'DISCONNECTED' : 'TAP TO CONNECT';

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* ── Full-screen range art ──────────────────────────────────────── */}
      <ImageBackground
        source={isLandscape ? RANGE_ART.landscape : RANGE_ART.portrait}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        {/* Functional overlay only — the art supplies sky, turf and trees. */}
        <Svg width="100%" height="100%" viewBox={`0 0 ${winW} ${winH}`}>
          <Defs>
            <LinearGradient id="tracer" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={C.gold} stopOpacity="0.05" />
              <Stop offset="1" stopColor={C.gold} stopOpacity="0.95" />
            </LinearGradient>
          </Defs>

          {/* Centre aim line */}
          {(() => {
            const a = project({ x: NEAR_YDS, y: 0, z: 0 });
            const b = project({ x: 265, y: 0, z: 0 });
            return <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ffffff" strokeOpacity={0.15} strokeWidth={1} />;
          })()}

          {/* Distance grid. The photos already contain real target greens and
              flags, so drawing synthetic ones on top looked like a bad collage.
              Instead: a faint tick across the range at each reference distance
              with its yardage, which is the part that's actually useful and
              reads clearly as an overlay rather than fake scenery. */}
          {TARGET_GREENS.map((d) => {
            const l = project({ x: d, y: -14, z: 0 });
            const r = project({ x: d, y: 14, z: 0 });
            const fade = Math.max(0.16, 0.4 - d / 900);
            return (
              <G key={`d${d}`}>
                <Line x1={l.x} y1={l.y} x2={r.x} y2={r.y} stroke="#ffffff" strokeOpacity={fade} strokeWidth={1} />
                <SvgText
                  x={r.x + 6} y={r.y + 3}
                  fill="#ffffff" fontSize={Math.max(8, 13 - d / 34)} fontWeight="bold"
                  opacity={0.62}
                >
                  {d}
                </SvgText>
              </G>
            );
          })}

          {/* Landed shots */}
          {shots.slice(0, 40).map((sh) => {
            const p = project({ x: sh.flight.carryYds, y: sh.flight.offlineYds, z: 0 });
            const isActive = active?.id === sh.id;
            return (
              <Circle
                key={`b${sh.id}`} cx={p.x} cy={p.y}
                r={isActive ? 3.4 : 2.2}
                fill={isActive ? C.gold : '#ffffff'}
                opacity={isActive ? 1 : 0.55}
              />
            );
          })}

          {/* Live tracer */}
          {active && (() => {
            const path = active.flight.path;
            const upto = Math.max(1, Math.floor(path.length * flightT));
            const pts = path.slice(0, upto).map(project);
            if (pts.length < 2) return null;
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
            const head = pts[pts.length - 1];
            return (
              <G>
                <Path d={d} stroke="url(#tracer)" strokeWidth={2.6} fill="none" strokeLinecap="round" />
                <Circle cx={head.x} cy={head.y} r={4} fill="#fff" />
                <Circle cx={head.x} cy={head.y} r={7} fill="#fff" opacity={0.25} />
              </G>
            );
          })()}
        </Svg>
      </ImageBackground>

      {/* ── Floating chrome ────────────────────────────────────────────── */}
      <View style={s.topBar} pointerEvents="box-none">
        <TouchableOpacity style={s.iconBtn} onPress={() => router.back()} activeOpacity={0.8}>
          <Text style={s.iconBtnText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.statusPill} onPress={() => setSetupOpen(true)} activeOpacity={0.8}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* Shot readout — floats over the art, sized down in landscape so it
          never eats the range. */}
      {active && (
        <View style={[s.readout, isLandscape ? s.readoutLandscape : s.readoutPortrait]} pointerEvents="none">
          <View style={s.readoutTop}>
            <Text style={s.readoutCarry}>{Math.round(active.flight.carryYds)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.readoutCarryLabel}>YDS CARRY</Text>
              <Text style={s.readoutTotal}>
                {Math.round(active.flight.totalYds)} total ·{' '}
                {Math.abs(active.flight.offlineYds) < 1
                  ? 'straight'
                  : `${Math.abs(Math.round(active.flight.offlineYds))} ${active.flight.offlineYds > 0 ? 'R' : 'L'}`}
              </Text>
            </View>
            <Text style={s.readoutClub}>{clubLabel(active.club)}</Text>
          </View>
          <View style={s.metricRow}>
            <Metric label="BALL" value={active.shot.ballSpeedMph.toFixed(1)} unit="mph" />
            <Metric label="LAUNCH" value={`${active.shot.launchAngleDeg.toFixed(1)}°`} />
            <Metric label="SPIN" value={`${Math.round(active.shot.spinRpm)}`} unit="rpm" />
            <Metric label="APEX" value={`${active.flight.apexFt}`} unit="ft" />
            <Metric label="DESC" value={`${active.flight.descentAngleDeg.toFixed(0)}°`} />
          </View>
        </View>
      )}

      {!active && (
        <View style={[s.hint, isLandscape ? s.readoutLandscape : s.readoutPortrait]} pointerEvents="none">
          <Text style={s.hintText}>
            Connect your launch monitor, or tap Demo Shot. Every shot flies on Sacari's
            own physics and saves into your club stats.
          </Text>
        </View>
      )}

      {/* Bottom controls */}
      <View style={s.controls}>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => setClubPickerOpen(true)} activeOpacity={0.85}>
          <Text style={s.ctrlLabel}>CLUB</Text>
          <Text style={s.ctrlValue}>{clubLabel(club)}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.ctrlBtn, s.ctrlGold]} onPress={() => ingest(demoShot(club), club)} activeOpacity={0.85}>
          <Text style={[s.ctrlValue, { color: C.gold }]}>Demo Shot</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => setSessionOpen(true)} activeOpacity={0.85}>
          <Text style={s.ctrlLabel}>SESSION</Text>
          <Text style={s.ctrlValue}>{shots.length}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.ctrlBtn, s.ctrlSave, (!shots.length || saving) && { opacity: 0.4 }]}
          onPress={saveSession}
          disabled={!shots.length || saving}
          activeOpacity={0.85}
        >
          {saving ? <ActivityIndicator color="#000" /> : <Text style={s.ctrlSaveText}>Save</Text>}
        </TouchableOpacity>
      </View>

      {/* ── Session summary ────────────────────────────────────────────── */}
      <Modal visible={sessionOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSessionOpen(false)}>
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>This Session</Text>
            <TouchableOpacity onPress={() => setSessionOpen(false)}><Text style={s.modalDone}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {summary.length === 0 ? (
              <Text style={s.sumHint}>No shots yet.</Text>
            ) : (
              <>
                {summary.map((r) => (
                  <View key={r.club} style={s.sumRow}>
                    <Text style={s.sumClub}>{clubLabel(r.club)}</Text>
                    <Text style={s.sumShots}>{r.shots} shot{r.shots === 1 ? '' : 's'}</Text>
                    <Text style={s.sumCarry}>{r.medianCarry} yds</Text>
                  </View>
                ))}
                <Text style={s.sumHint}>Median carry. Saving adds these to your club stats and dispersion.</Text>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ── Club picker ────────────────────────────────────────────────── */}
      <Modal visible={clubPickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setClubPickerOpen(false)}>
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Club</Text>
            <TouchableOpacity onPress={() => setClubPickerOpen(false)}><Text style={s.modalDone}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {CLUBS_CATALOG.filter((c) => c.code !== 'putter').map((c) => (
              <TouchableOpacity
                key={c.code}
                style={[s.clubRow, club === c.code && s.clubRowActive]}
                onPress={() => { setClub(c.code); setClubPickerOpen(false); }}
              >
                <Text style={[s.clubRowText, club === c.code && { color: C.gold }]}>{c.defaultLabel}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>

      {/* ── Bridge setup ───────────────────────────────────────────────── */}
      <Modal
        visible={setupOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSetupOpen(false)}
        onShow={() => { getDiagnostics().then(setDiag).catch(() => setDiag(null)); }}
      >
        <ScrollView style={s.modal} contentContainerStyle={{ padding: 20 }}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Launch Monitor</Text>
            <TouchableOpacity onPress={() => setSetupOpen(false)}><Text style={s.modalDone}>Close</Text></TouchableOpacity>
          </View>
          <Text style={s.setupBody}>
            Range Live needs two things: your phone and a computer on the same WiFi,
            and bridge software running on that computer.
          </Text>
          <Text style={s.setupBody}>
            The Mevo+ speaks its own private protocol that phones can't read directly,
            so a small bridge program on a laptop translates it. Connecting your phone
            to the Mevo+'s own WiFi will not work on its own. Once the bridge is
            running, Sacari finds it automatically. no addresses to type.
          </Text>
          {!localNetworkReady() && (
            <Text style={s.setupErr}>
              This app version can't search the network yet. that arrives in the next
              app update. Demo Shot works right now.
            </Text>
          )}

          <TouchableOpacity
            style={[s.setupConnect, scanning && { opacity: 0.6 }]}
            onPress={() => { setSetupOpen(false); autoConnect(); }}
            disabled={scanning}
          >
            {scanning ? <ActivityIndicator color="#000" /> : <Text style={s.setupConnectText}>Search my WiFi</Text>}
          </TouchableOpacity>

          {status === 'connected' && <Text style={s.setupOk}>Connected to {bridgeUrl}</Text>}
          {statusDetail && <Text style={s.setupErr}>{statusDetail}</Text>}

          {/* Diagnostics — facts, not guesses. Without this a failed connection
              is indistinguishable from a broken bridge, a wrong network, or an
              app build that can't do local networking at all. */}
          <Text style={s.setupLabel}>DIAGNOSTICS</Text>
          <View style={s.diagBox}>
            <DiagRow k="Local network support" v={diag ? (diag.ready ? 'yes' : 'NO — needs new build') : '…'} bad={diag ? !diag.ready : false} />
            <DiagRow k="This phone" v={diag?.ip ?? '—'} bad={!!diag && diag.ready && !diag.ip} />
            <DiagRow k="Subnet scanned" v={diag?.subnet ? `${diag.subnet}1-254` : '—'} />
            <DiagRow k="Ports tried" v={BRIDGE_PORTS.join(', ')} />
            {diag?.note ? <Text style={s.diagNote}>{diag.note}</Text> : null}
          </View>

          <Text style={s.setupNote}>
            Works with any bridge that speaks the GSPro Connect format, which covers
            the Mevo+ and most other monitors. If the search comes up empty, check that
            the phone and the computer are on the same network (not a guest network),
            and that the bridge is running.
          </Text>

          <TouchableOpacity onPress={() => setShowManual((v) => !v)} activeOpacity={0.7}>
            <Text style={s.setupToggle}>{showManual ? 'Hide manual setup' : 'Enter an address manually'}</Text>
          </TouchableOpacity>
          {showManual && (
            <>
              <Text style={s.setupLabel}>BRIDGE ADDRESS</Text>
              <TextInput
                style={s.setupInput}
                value={bridgeUrl}
                onChangeText={setBridgeUrl}
                placeholder="ws://192.168.1.20:921"
                placeholderTextColor={C.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  style={[s.setupConnect, { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border }, testing && { opacity: 0.6 }]}
                  disabled={testing}
                  onPress={async () => {
                    const url = bridgeUrl.trim();
                    if (!url) { setTestResult('Enter an address first.'); return; }
                    setTesting(true); setTestResult(null);
                    try {
                      const r = await testAddress(url);
                      setTestResult(`${r.ok ? 'OK — ' : 'Failed — '}${r.note}`);
                    } finally { setTesting(false); }
                  }}
                >
                  {testing
                    ? <ActivityIndicator color={C.text} />
                    : <Text style={[s.setupConnectText, { color: C.text }]}>Test</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.setupConnect, { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.gold }]}
                  onPress={() => {
                    const url = bridgeUrl.trim();
                    if (!url) { Alert.alert('Address needed', 'Enter your bridge address.'); return; }
                    AsyncStorage.setItem(BRIDGE_KEY, url).catch(() => { });
                    connect(url);
                    setSetupOpen(false);
                  }}
                >
                  <Text style={[s.setupConnectText, { color: C.gold }]}>Connect</Text>
                </TouchableOpacity>
              </View>
              {testResult && (
                <Text style={testResult.startsWith('OK') ? s.setupOk : s.setupErr}>{testResult}</Text>
              )}
            </>
          )}

          <Text style={s.setupNote}>
            No hardware handy? Use Demo Shot to hit plausible shots and see the range work.
          </Text>
        </ScrollView>
      </Modal>
    </View>
  );
}

function DiagRow({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <View style={s.diagRow}>
      <Text style={s.diagKey}>{k}</Text>
      <Text style={[s.diagVal, bad && { color: C.red }]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={s.metricValue}>{value}{unit ? <Text style={s.metricUnit}> {unit}</Text> : null}</Text>
    </View>
  );
}

const GLASS = 'rgba(8,14,10,0.62)';

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f1d33' },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 52, paddingHorizontal: 14,
  },
  iconBtn: {
    backgroundColor: GLASS, borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: '#ffffff22',
  },
  iconBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: GLASS, borderRadius: 14,
    paddingHorizontal: 11, paddingVertical: 6,
    borderWidth: 1, borderColor: '#ffffff22',
  },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  readout: {
    position: 'absolute', left: 14, right: 14,
    backgroundColor: GLASS, borderRadius: 14,
    borderWidth: 1, borderColor: '#ffffff1f',
    paddingHorizontal: 14, paddingVertical: 11,
  },
  readoutPortrait: { bottom: 104 },
  readoutLandscape: { bottom: 84, right: undefined, maxWidth: 420 },
  readoutTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  readoutCarry: { color: C.gold, fontFamily: F.serif, fontSize: 38, fontWeight: '900' },
  readoutCarryLabel: { color: '#ffffffaa', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  readoutTotal: { color: '#fff', fontSize: 13, marginTop: 2 },
  readoutClub: { color: '#fff', fontSize: 13, fontWeight: '800' },
  metricRow: { flexDirection: 'row', marginTop: 10, gap: 5 },
  metric: {
    flex: 1, backgroundColor: '#ffffff12', borderRadius: 6,
    paddingVertical: 6, alignItems: 'center',
  },
  metricLabel: { color: '#ffffff99', fontSize: 8, fontWeight: '900', letterSpacing: 0.9 },
  metricValue: { color: '#fff', fontSize: 12, fontWeight: '800', marginTop: 2 },
  metricUnit: { color: '#ffffff99', fontSize: 9, fontWeight: '700' },

  hint: {
    position: 'absolute', left: 14, right: 14,
    backgroundColor: GLASS, borderRadius: 14,
    borderWidth: 1, borderColor: '#ffffff1f',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  hintText: { color: '#ffffffdd', fontSize: 12, lineHeight: 18 },

  controls: {
    position: 'absolute', left: 14, right: 14, bottom: 26,
    flexDirection: 'row', gap: 8,
  },
  ctrlBtn: {
    flex: 1, backgroundColor: GLASS, borderRadius: 12,
    borderWidth: 1, borderColor: '#ffffff22',
    paddingVertical: 9, alignItems: 'center', justifyContent: 'center',
  },
  ctrlGold: { borderColor: C.gold + 'aa' },
  ctrlSave: { backgroundColor: C.gold, borderColor: C.gold },
  ctrlLabel: { color: '#ffffff99', fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  ctrlValue: { color: '#fff', fontSize: 13, fontWeight: '800', marginTop: 1 },
  ctrlSaveText: { color: '#000', fontSize: 14, fontWeight: '900' },

  modal: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  modalDone: { color: C.gold, fontSize: 15, fontWeight: '800' },

  sumRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6,
  },
  sumClub: { flex: 1, color: C.text, fontSize: 14, fontWeight: '700' },
  sumShots: { color: C.textMuted, fontSize: 11, marginRight: 12 },
  sumCarry: { color: C.gold, fontFamily: F.serif, fontSize: 16, fontWeight: '900' },
  sumHint: { color: C.textDim, fontSize: 11, fontStyle: 'italic', marginTop: 4 },

  clubRow: {
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 8,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, marginBottom: 6,
  },
  clubRowActive: { borderColor: C.gold },
  clubRowText: { color: C.text, fontSize: 15, fontWeight: '700' },

  setupBody: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginTop: 14 },
  setupLabel: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginTop: 18, marginBottom: 6 },
  setupInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    borderWidth: 1, borderColor: C.border, fontFamily: F.mono,
  },
  setupConnect: {
    marginTop: 16, backgroundColor: C.gold, borderRadius: 8,
    paddingVertical: 13, alignItems: 'center',
  },
  setupConnectText: { color: '#000', fontWeight: '900', fontSize: 15 },
  setupErr: { color: C.red, fontSize: 12, marginTop: 10, lineHeight: 17 },
  setupOk: { color: C.green, fontSize: 12, marginTop: 10, fontFamily: F.mono },
  setupToggle: { color: C.gold, fontSize: 13, fontWeight: '700', marginTop: 22 },
  diagBox: {
    backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, padding: 12, gap: 6,
  },
  diagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  diagKey: { color: C.textMuted, fontSize: 12 },
  diagVal: { color: C.text, fontSize: 12, fontWeight: '700', fontFamily: F.mono, flexShrink: 1, textAlign: 'right' },
  diagNote: { color: C.textDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
  setupNote: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 18, fontStyle: 'italic' },
});
