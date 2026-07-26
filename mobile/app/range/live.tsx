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
 * Demo mode generates plausible shots so the range is usable with no hardware.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, Animated, Easing,
} from 'react-native';
import { Stack, router } from 'expo-router';
import Svg, {
  Defs, LinearGradient, Stop, Rect, Path, Circle, G, Ellipse, Line,
  Text as SvgText,
} from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C, F } from '../../lib/colors';
import { api } from '../../lib/api';
import { simulateFlight, FlightResult, FlightPoint } from '../../lib/ballFlight';
import {
  connectLaunchMonitor, demoShot, discoverBridge,
  LaunchShot, LaunchMonitorLink, LinkStatus,
} from '../../lib/launchMonitor';
import { CLUBS_CATALOG, clubLabel } from '../../lib/clubs';

const BRIDGE_KEY = 'range_live_bridge_url';

// ── Range geometry (world yards) ─────────────────────────────────────────────
const TARGET_GREENS = [50, 100, 150, 200, 250];
const RANGE_WIDTH_YDS = 70;      // half-width of the mown range

// ── Camera: pinhole behind and above the tee ────────────────────────────────
// Chosen so ~10 yds fills the bottom of the frame and 250+ compresses toward
// the horizon, which is what makes the depth read correctly.
const VIEW_W = 400, VIEW_H = 300;
const HORIZON_Y = 108;
const CAM_H = 6;        // camera height, yards
const CAM_D = 8;        // distance from camera to tee, yards
const FOCAL = 520;

function project(p: FlightPoint): { x: number; y: number } {
  const depth = p.x + CAM_D;
  return {
    x: VIEW_W / 2 + (FOCAL * p.y) / depth,
    y: HORIZON_Y + (FOCAL * (CAM_H - p.z)) / depth,
  };
}

type Landed = {
  id: number;
  club: string;
  shot: LaunchShot;
  flight: FlightResult;
};

export default function RangeLive() {
  const [club, setClub] = useState('7i');
  const [clubPickerOpen, setClubPickerOpen] = useState(false);
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
  const linkRef = useRef<LaunchMonitorLink | null>(null);
  const scanSignal = useRef<{ cancelled: boolean }>({ cancelled: false });
  const nextId = useRef(1);
  // `connect` is defined below (it depends on `ingest`); autoConnect reaches it
  // through this ref so the mount effect doesn't have to wait on declaration
  // order or re-run when the callback identity changes.
  const connectRef = useRef<((url: string) => void) | null>(null);

  // Flight animation: 0 → 1 along the trajectory path.
  const flightAnim = useRef(new Animated.Value(0)).current;
  const [flightT, setFlightT] = useState(1);
  useEffect(() => {
    const sub = flightAnim.addListener(({ value }) => setFlightT(value));
    return () => flightAnim.removeListener(sub);
  }, [flightAnim]);

  // Auto-connect on open: reuse the address that worked last time, otherwise
  // sweep the WiFi for a bridge. The user never types an IP.
  const autoConnect = useCallback(async () => {
    if (scanning) return;
    scanSignal.current = { cancelled: false };
    setScanning(true);
    setScanPct(0);
    setStatusDetail(null);
    try {
      const saved = await AsyncStorage.getItem(BRIDGE_KEY).catch(() => null);
      if (saved) setBridgeUrl(saved);
      const found = await discoverBridge({
        preferred: saved,
        signal: scanSignal.current,
        onProgress: setScanPct,
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
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  useEffect(() => {
    autoConnect();
    return () => { scanSignal.current.cancelled = true; };
    // Run once on mount — autoConnect is stable enough for this purpose and
    // re-running on every state change would restart the sweep mid-scan.
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

  // Keep the latest club available to the socket callback without
  // re-subscribing (which would drop the connection on every club change).
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
      Alert.alert(
        'Saved',
        `${res.total_shots} shots added to your club stats.`,
        [{ text: 'Done', onPress: () => router.back() }, { text: 'Keep hitting' }],
      );
      setShots([]);
      setActive(null);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally { setSaving(false); }
  };

  // ── Per-club summary for the session ───────────────────────────────────────
  const summary = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const s of shots) {
      const arr = by.get(s.club) ?? [];
      arr.push(s.flight.carryYds);
      by.set(s.club, arr);
    }
    return [...by.entries()].map(([c, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        club: c,
        shots: arr.length,
        medianCarry: Math.round(sorted[Math.floor(sorted.length / 2)]),
      };
    }).sort((a, b) => b.medianCarry - a.medianCarry);
  }, [shots]);

  const statusColor =
    scanning ? C.gold
    : status === 'connected' ? C.green
    : status === 'connecting' ? C.gold
    : status === 'error' ? C.red : C.textMuted;
  const statusLabel =
    scanning ? `SEARCHING WIFI… ${Math.round(scanPct * 100)}%`
    : status === 'connected' ? 'MONITOR CONNECTED'
    : status === 'connecting' ? 'CONNECTING…'
    : status === 'error' ? 'CONNECTION ERROR'
    : status === 'closed' ? 'DISCONNECTED' : 'TAP TO CONNECT';

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Range Live', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />

      {/* ── The range ──────────────────────────────────────────────────── */}
      <View style={s.rangeWrap}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
          <Defs>
            <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#0f1d33" />
              <Stop offset="0.55" stopColor="#2b4a6d" />
              <Stop offset="1" stopColor="#6f8fa6" />
            </LinearGradient>
            <LinearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#2c4a2a" />
              <Stop offset="1" stopColor="#4e8244" />
            </LinearGradient>
            <LinearGradient id="tracer" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={C.gold} stopOpacity="0.05" />
              <Stop offset="1" stopColor={C.gold} stopOpacity="0.95" />
            </LinearGradient>
          </Defs>

          {/* Sky + ground */}
          <Rect x="0" y="0" width={VIEW_W} height={HORIZON_Y + 2} fill="url(#sky)" />
          <Rect x="0" y={HORIZON_Y} width={VIEW_W} height={VIEW_H - HORIZON_Y} fill="url(#turf)" />

          {/* Distant treeline — a soft band of overlapping blobs on the horizon */}
          <G opacity={0.9}>
            {Array.from({ length: 26 }).map((_, i) => (
              <Ellipse
                key={`t${i}`}
                cx={(i * VIEW_W) / 25}
                cy={HORIZON_Y - 2}
                rx={14 + ((i * 7) % 9)}
                ry={7 + ((i * 5) % 6)}
                fill="#16301f"
              />
            ))}
          </G>
          <Rect x="0" y={HORIZON_Y - 1} width={VIEW_W} height="2.5" fill="#122a19" opacity={0.8} />

          {/* Mown stripes — alternating bands between distance markers, drawn
              as trapezoids so they converge correctly toward the horizon. */}
          {Array.from({ length: 11 }).map((_, i) => {
            const near = i * 30, far = near + 30;
            if (i % 2 === 1) return null;
            const nl = project({ x: near, y: -RANGE_WIDTH_YDS, z: 0 });
            const nr = project({ x: near, y: RANGE_WIDTH_YDS, z: 0 });
            const fl = project({ x: far, y: -RANGE_WIDTH_YDS, z: 0 });
            const fr = project({ x: far, y: RANGE_WIDTH_YDS, z: 0 });
            return (
              <Path
                key={`stripe${i}`}
                d={`M${nl.x} ${nl.y} L${nr.x} ${nr.y} L${fr.x} ${fr.y} L${fl.x} ${fl.y} Z`}
                fill="#000"
                opacity={0.07}
              />
            );
          })}

          {/* Centre aim line */}
          {(() => {
            const a = project({ x: 2, y: 0, z: 0 });
            const b = project({ x: 260, y: 0, z: 0 });
            return <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ffffff" strokeOpacity={0.13} strokeWidth={1} />;
          })()}

          {/* Target greens + flags */}
          {TARGET_GREENS.map((d) => {
            const c0 = project({ x: d, y: 0, z: 0 });
            const edge = project({ x: d, y: 9, z: 0 });
            const rx = Math.max(3, Math.abs(edge.x - c0.x));
            const ry = Math.max(1.4, rx * 0.32);
            const flagTop = project({ x: d, y: 0, z: 2.6 });
            return (
              <G key={`g${d}`}>
                <Ellipse cx={c0.x} cy={c0.y} rx={rx} ry={ry} fill="#79b56a" opacity={0.75} />
                <Ellipse cx={c0.x} cy={c0.y} rx={rx * 0.45} ry={ry * 0.45} fill="#8fce7e" opacity={0.65} />
                <Line x1={c0.x} y1={c0.y} x2={flagTop.x} y2={flagTop.y} stroke="#f2f2f2" strokeWidth={1.1} />
                <Path
                  d={`M${flagTop.x} ${flagTop.y} L${flagTop.x + Math.max(5, rx * 0.5)} ${flagTop.y + 2.4} L${flagTop.x} ${flagTop.y + 4.8} Z`}
                  fill={C.gold}
                />
              </G>
            );
          })}

          {/* Yardage markers down the right side. Font size shrinks with
              distance so they sit in the scene instead of floating on top. */}
          {TARGET_GREENS.map((d) => {
            const p = project({ x: d, y: RANGE_WIDTH_YDS * 0.62, z: 0 });
            const scale = Math.max(0.45, Math.min(1, 60 / (d + CAM_D)));
            const w = 22 * scale, h = 11 * scale;
            return (
              <G key={`m${d}`}>
                <Rect x={p.x - w / 2} y={p.y - h} width={w} height={h} rx={1.5} fill="#0d1a12" opacity={0.8} />
                <SvgText
                  x={p.x}
                  y={p.y - h * 0.25}
                  fill="#e8e2d4"
                  fontSize={7.5 * scale}
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {d}
                </SvgText>
              </G>
            );
          })}

          {/* Landed shots — flattened dots where previous balls finished */}
          {shots.slice(0, 40).map((sh) => {
            const p = project({ x: sh.flight.carryYds, y: sh.flight.offlineYds, z: 0 });
            const isActive = active?.id === sh.id;
            return (
              <Circle
                key={`b${sh.id}`}
                cx={p.x} cy={p.y}
                r={isActive ? 2.6 : 1.8}
                fill={isActive ? C.gold : '#ffffff'}
                opacity={isActive ? 1 : 0.5}
              />
            );
          })}

          {/* Live tracer for the shot in flight */}
          {active && (() => {
            const path = active.flight.path;
            const upto = Math.max(1, Math.floor(path.length * flightT));
            const pts = path.slice(0, upto).map(project);
            if (pts.length < 2) return null;
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
            const head = pts[pts.length - 1];
            return (
              <G>
                <Path d={d} stroke="url(#tracer)" strokeWidth={2.2} fill="none" strokeLinecap="round" />
                <Circle cx={head.x} cy={head.y} r={3.2} fill="#fff" />
                <Circle cx={head.x} cy={head.y} r={5.5} fill="#fff" opacity={0.25} />
              </G>
            );
          })()}

          {/* Tee marker */}
          {(() => {
            const t = project({ x: 0, y: 0, z: 0 });
            return <Ellipse cx={t.x} cy={t.y} rx={26} ry={5} fill="#6b4b2a" opacity={0.55} />;
          })()}
        </Svg>

        {/* Connection pill, floating over the range */}
        <TouchableOpacity style={s.statusPill} onPress={() => setSetupOpen(true)} activeOpacity={0.8}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Last shot readout ──────────────────────────────────────────── */}
      <View style={s.readout}>
        {active ? (
          <>
            <View style={s.readoutTop}>
              <Text style={s.readoutCarry}>{Math.round(active.flight.carryYds)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.readoutCarryLabel}>YDS CARRY</Text>
                <Text style={s.readoutTotal}>
                  {Math.round(active.flight.totalYds)} total ·{' '}
                  {Math.abs(active.flight.offlineYds) < 1
                    ? 'straight'
                    : `${Math.abs(Math.round(active.flight.offlineYds))} yds ${active.flight.offlineYds > 0 ? 'right' : 'left'}`}
                </Text>
              </View>
              <Text style={s.readoutClub}>{clubLabel(active.club)}</Text>
            </View>
            <View style={s.metricRow}>
              <Metric label="BALL" value={`${active.shot.ballSpeedMph.toFixed(1)}`} unit="mph" />
              <Metric label="LAUNCH" value={`${active.shot.launchAngleDeg.toFixed(1)}°`} />
              <Metric label="SPIN" value={`${Math.round(active.shot.spinRpm)}`} unit="rpm" />
              <Metric label="APEX" value={`${active.flight.apexFt}`} unit="ft" />
              <Metric label="DESC" value={`${active.flight.descentAngleDeg.toFixed(0)}°`} />
            </View>
          </>
        ) : (
          <Text style={s.readoutEmpty}>
            Connect your launch monitor and hit a shot. Every shot flies on Sacari's own
            physics model and saves into your club stats.
          </Text>
        )}
      </View>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <View style={s.controls}>
        <TouchableOpacity style={s.clubBtn} onPress={() => setClubPickerOpen(true)} activeOpacity={0.8}>
          <Text style={s.clubBtnLabel}>CLUB</Text>
          <Text style={s.clubBtnValue}>{clubLabel(club)}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.demoBtn}
          onPress={() => ingest(demoShot(club), club)}
          activeOpacity={0.8}
        >
          <Text style={s.demoBtnText}>Demo Shot</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.saveBtn, (!shots.length || saving) && { opacity: 0.4 }]}
          onPress={saveSession}
          disabled={!shots.length || saving}
          activeOpacity={0.8}
        >
          {saving ? <ActivityIndicator color="#000" /> : (
            <Text style={s.saveBtnText}>Save {shots.length ? `(${shots.length})` : ''}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Session summary ────────────────────────────────────────────── */}
      <ScrollView style={s.sessionList} contentContainerStyle={{ paddingBottom: 24 }}>
        {summary.length > 0 && (
          <>
            <Text style={s.section}>THIS SESSION</Text>
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
      <Modal visible={setupOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSetupOpen(false)}>
        <ScrollView style={s.modal} contentContainerStyle={{ padding: 20 }}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Launch Monitor</Text>
            <TouchableOpacity onPress={() => setSetupOpen(false)}><Text style={s.modalDone}>Close</Text></TouchableOpacity>
          </View>
          <Text style={s.setupBody}>
            Start your launch monitor's bridge software on a computer on the same
            WiFi as your phone. Sacari finds it automatically. no addresses to type.
          </Text>

          <TouchableOpacity
            style={[s.setupConnect, scanning && { opacity: 0.6 }]}
            onPress={() => { setSetupOpen(false); autoConnect(); }}
            disabled={scanning}
          >
            {scanning
              ? <ActivityIndicator color="#000" />
              : <Text style={s.setupConnectText}>Search my WiFi</Text>}
          </TouchableOpacity>

          {status === 'connected' && (
            <Text style={s.setupOk}>Connected to {bridgeUrl}</Text>
          )}
          {statusDetail && <Text style={s.setupErr}>{statusDetail}</Text>}

          <Text style={s.setupNote}>
            Works with any bridge that speaks the GSPro Connect format, which covers
            the Mevo+ and most other monitors. If the search comes up empty, check
            that the phone and the computer are on the same network (not a guest
            network), and that the bridge is running.
          </Text>

          {/* Manual entry stays available but out of the way — almost nobody
              should need it. */}
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
              <TouchableOpacity
                style={[s.setupConnect, { backgroundColor: C.card, borderWidth: 1, borderColor: C.gold }]}
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

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={s.metricValue}>{value}{unit ? <Text style={s.metricUnit}> {unit}</Text> : null}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  rangeWrap: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#0f1d33' },
  statusPill: {
    position: 'absolute', top: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#000000aa', borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: '#ffffff22',
  },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  readout: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  readoutTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  readoutCarry: { color: C.gold, fontFamily: F.serif, fontSize: 40, fontWeight: '900' },
  readoutCarryLabel: { color: C.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  readoutTotal: { color: C.text, fontSize: 13, marginTop: 2 },
  readoutClub: { color: C.text, fontSize: 13, fontWeight: '800' },
  readoutEmpty: { color: C.textMuted, fontSize: 13, lineHeight: 19 },
  metricRow: { flexDirection: 'row', marginTop: 12, gap: 6 },
  metric: {
    flex: 1, backgroundColor: C.card, borderRadius: 6,
    borderWidth: 1, borderColor: C.border,
    paddingVertical: 7, alignItems: 'center',
  },
  metricLabel: { color: C.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.9 },
  metricValue: { color: C.text, fontSize: 13, fontWeight: '800', marginTop: 2 },
  metricUnit: { color: C.textMuted, fontSize: 9, fontWeight: '700' },

  controls: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  clubBtn: {
    flex: 1.1, backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, paddingVertical: 9, alignItems: 'center',
  },
  clubBtnLabel: { color: C.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  clubBtnValue: { color: C.text, fontSize: 14, fontWeight: '800', marginTop: 2 },
  demoBtn: {
    flex: 1, backgroundColor: C.card, borderRadius: 8,
    borderWidth: 1, borderColor: C.gold + '77', alignItems: 'center', justifyContent: 'center',
  },
  demoBtnText: { color: C.gold, fontSize: 13, fontWeight: '800' },
  saveBtn: {
    flex: 1, backgroundColor: C.gold, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  saveBtnText: { color: '#000', fontSize: 13, fontWeight: '900' },

  sessionList: { flex: 1, paddingHorizontal: 16 },
  section: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.3, marginBottom: 8 },
  sumRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6,
  },
  sumClub: { flex: 1, color: C.text, fontSize: 14, fontWeight: '700' },
  sumShots: { color: C.textMuted, fontSize: 11, marginRight: 12 },
  sumCarry: { color: C.gold, fontFamily: F.serif, fontSize: 16, fontWeight: '900' },
  sumHint: { color: C.textDim, fontSize: 11, fontStyle: 'italic', marginTop: 4 },

  modal: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  modalDone: { color: C.gold, fontSize: 15, fontWeight: '800' },
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
  setupErr: { color: C.red, fontSize: 12, marginTop: 10 },
  setupOk: { color: C.green, fontSize: 12, marginTop: 10, fontFamily: F.mono },
  setupToggle: { color: C.gold, fontSize: 13, fontWeight: '700', marginTop: 22 },
  setupNote: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 18, fontStyle: 'italic' },
});
