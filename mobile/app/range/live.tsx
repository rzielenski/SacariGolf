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
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Modal, Animated, Easing,
  ImageBackground, useWindowDimensions, Share,
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
  connectLaunchMonitor, demoShot, discoverBridge, getDiagnostics,
  LaunchShot, LaunchMonitorLink, LinkStatus, Diagnostics,
} from '../../lib/launchMonitor';
import { CLUBS_CATALOG, clubLabel } from '../../lib/clubs';
import { MevoClient, MevoState, MEVO_HOST_CANDIDATES, MEVO_PORT } from '../../lib/mevo/client';

const BRIDGE_KEY = 'range_live_bridge_url';
/** Last protocol trace, persisted so it survives the phone hopping off the
 *  dev network (and app reloads) — see the replay button in the setup sheet. */
const MEVO_LOG_KEY = 'range_live_mevo_log';

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

/**
 * Every stat a shot can display, in the order they're offered in settings.
 * `from` marks provenance so the UI can be honest: 'device' values are what
 * the launch monitor measured, 'flight' values come from our ball-flight
 * model. A stat returns null when its source didn't provide it (e.g. club
 * speed when ClubTrigger is disabled) and renders as a dash.
 */
type StatCtx = { shot: LaunchShot; flight: FlightResult };
interface StatDef {
  key: string;
  label: string;
  from: 'device' | 'flight';
  value: (c: StatCtx) => string | null;
}
const STAT_DEFS: StatDef[] = [
  { key: 'carry', label: 'CARRY', from: 'flight', value: (c) => `${Math.round(c.flight.carryYds)}` },
  { key: 'total', label: 'TOTAL', from: 'flight', value: (c) => `${Math.round(c.flight.totalYds)}` },
  { key: 'ballSpeed', label: 'BALL SPEED', from: 'device', value: (c) => c.shot.ballSpeedMph.toFixed(1) },
  { key: 'launch', label: 'LAUNCH', from: 'device', value: (c) => `${c.shot.launchAngleDeg.toFixed(1)}°` },
  { key: 'spin', label: 'TOTAL SPIN', from: 'device', value: (c) => `${Math.round(c.shot.spinRpm)}` },
  { key: 'spinAxis', label: 'SPIN AXIS', from: 'device', value: (c) => `${c.shot.spinAxisDeg.toFixed(1)}°` },
  { key: 'offline', label: 'OFFLINE', from: 'flight',
    value: (c) => {
      const o = Math.round(c.flight.offlineYds);
      return o === 0 ? '0' : `${Math.abs(o)} ${o > 0 ? 'R' : 'L'}`;
    } },
  { key: 'apex', label: 'APEX', from: 'flight', value: (c) => `${c.flight.apexFt}` },
  { key: 'descent', label: 'DESCENT', from: 'flight', value: (c) => `${c.flight.descentAngleDeg.toFixed(0)}°` },
  { key: 'direction', label: 'LAUNCH DIR', from: 'device', value: (c) => `${c.shot.azimuthDeg.toFixed(1)}°` },
  { key: 'backSpin', label: 'BACKSPIN', from: 'device',
    value: (c) => `${Math.round(c.shot.spinRpm * Math.cos((c.shot.spinAxisDeg * Math.PI) / 180))}` },
  { key: 'sideSpin', label: 'SIDESPIN', from: 'device',
    value: (c) => `${Math.round(c.shot.spinRpm * Math.sin((c.shot.spinAxisDeg * Math.PI) / 180))}` },
  { key: 'roll', label: 'ROLL', from: 'flight',
    value: (c) => `${Math.round(c.flight.rollYds)}` },
  { key: 'bounces', label: 'BOUNCES', from: 'flight',
    value: (c) => `${c.flight.bounces.length}` },
  { key: 'finishOffline', label: 'FINISH OFFLINE', from: 'flight',
    value: (c) => {
      const o = Math.round(c.flight.finishOfflineYds);
      return o === 0 ? '0' : `${Math.abs(o)}${o > 0 ? 'R' : 'L'}`;
    } },
  { key: 'flightTime', label: 'HANG TIME', from: 'flight', value: (c) => `${c.flight.flightTimeS.toFixed(1)}s` },
  { key: 'clubSpeed', label: 'CLUB SPEED', from: 'device',
    value: (c) => (c.shot.clubSpeedMph != null ? c.shot.clubSpeedMph.toFixed(1) : null) },
  { key: 'smash', label: 'SMASH', from: 'device',
    value: (c) => (c.shot.smashFactor != null ? c.shot.smashFactor.toFixed(2) : null) },
];
const STAT_BY_KEY: Record<string, StatDef> = Object.fromEntries(STAT_DEFS.map((d) => [d.key, d]));
/** Shown on the range overlay by default; the full set lives on the stats view. */
const DEFAULT_STAT_ORDER = ['carry', 'total', 'ballSpeed', 'launch', 'spin', 'spinAxis', 'offline', 'apex', 'descent'];
const STAT_ORDER_KEY = 'range_live_stat_order';

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
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [connectingAuto, setConnectingAuto] = useState(false);
  /** 'range' = fly the shot over the art; 'stats' = full numbers, no scenery
   *  (what FSPro/GSPro call the data view). */
  const [viewMode, setViewMode] = useState<'range' | 'stats'>('range');
  const [statOrder, setStatOrder] = useState<string[]>(DEFAULT_STAT_ORDER);
  const [statConfigOpen, setStatConfigOpen] = useState(false);
  // Direct mode: phone → Mevo+ over raw TCP, no laptop bridge.
  const [mevoState, setMevoState] = useState<MevoState>('idle');
  const [mevoLog, setMevoLog] = useState<string[]>([]);
  const [mevoHost, setMevoHost] = useState(MEVO_HOST_CANDIDATES[0]);
  /** Gateway inferred from the phone's own address (x.y.z.1). On the Mevo+'s
   *  AP the device IS the gateway, so this is the address to talk to — the
   *  same value iOS shows as "Router" under the network's (i) button. */
  const [detectedGateway, setDetectedGateway] = useState<string | null>(null);
  const mevoRef = useRef<MevoClient | null>(null);
  const linkRef = useRef<LaunchMonitorLink | null>(null);
  const scanSignal = useRef<{ cancelled: boolean }>({ cancelled: false });
  const nextId = useRef(1);
  const connectRef = useRef<((url: string) => void) | null>(null);
  /** connectMevoDirect is defined below (it depends on `ingest`); connectAuto
   *  reaches it through this ref so declaration order doesn't matter. */
  const connectMevoRef = useRef<((host: string) => Promise<boolean>) | null>(null);

  // Flight animation: 0 → 1 along the trajectory path.
  const flightAnim = useRef(new Animated.Value(0)).current;
  const [flightT, setFlightT] = useState(1);
  /** Whether the current shot has finished flying — gates the landing dot so
   *  we never reveal where the ball ends up before it gets there. */
  const flightDone = flightT >= 1;
  useEffect(() => {
    const sub = flightAnim.addListener(({ value }) => setFlightT(value));
    return () => flightAnim.removeListener(sub);
  }, [flightAnim]);

  /**
   * One-button connect. Tries the launch monitor DIRECTLY over TCP first
   * (phone on the device's own WiFi — no laptop), and falls back to scanning
   * for a GSPro-Connect bridge. Everything it does is logged, and the log is
   * mirrored to the Metro terminal.
   */
  const connectAuto = useCallback(async () => {
    if (connectingAuto) return;
    setConnectingAuto(true);
    setStatusDetail(null);
    setMevoLog([]);
    try {
      const d = await getDiagnostics().catch(() => null);
      setDiag(d);
      if (!d?.ready) {
        setStatusDetail('This build can\'t reach the local network. needs the native modules from a dev/production build.');
        return;
      }
      if (!d.subnet) {
        setStatusDetail(d.note);
        return;
      }
      const gw = `${d.subnet}1`;
      setDetectedGateway(gw);

      // 1. The device itself, at the gateway and the known fallbacks.
      const hosts = [gw, ...MEVO_HOST_CANDIDATES.filter((h) => h !== gw)];
      for (const host of hosts) {
        setMevoHost(host);
        const ok = await connectMevoRef.current?.(host);
        if (ok) return;                       // client took over; it logs from here
      }

      // 2. No device answered — look for a bridge instead.
      setStatusDetail('No launch monitor answered directly. looking for a bridge.');
      scanSignal.current = { cancelled: false };
      setScanning(true);
      setScanPct(0);
      const saved = await AsyncStorage.getItem(BRIDGE_KEY).catch(() => null);
      const found = await discoverBridge({
        preferred: saved, signal: scanSignal.current, onProgress: setScanPct,
      });
      if (found) {
        setBridgeUrl(found);
        AsyncStorage.setItem(BRIDGE_KEY, found).catch(() => { });
        connectRef.current?.(found);
        setStatusDetail(null);
      } else {
        setStatusDetail('Nothing found. Check the phone is on the launch monitor\'s WiFi (or the bridge\'s network).');
      }
    } finally {
      setScanning(false);
      setConnectingAuto(false);
    }
  }, [connectingAuto]);

  /** Dump the whole buffered trace to the JS console in one go. Metro is
   *  unreachable while the phone sits on the Mevo+'s WiFi, so this is how the
   *  trace gets to the dev terminal: test on the device's network, rejoin the
   *  normal WiFi (Metro reconnects), then replay. */
  const printLogToTerminal = useCallback(() => {
    const header = `phone ${diag?.ip ?? '?'}  gateway ${detectedGateway ?? '?'}  state=${mevoState}`;
    console.log('\n===== SACARI MEVO+ LOG (start) =====');
    console.log(header);
    for (const line of mevoLog) console.log(line);
    console.log(`===== SACARI MEVO+ LOG (end, ${mevoLog.length} lines) =====\n`);
    Alert.alert('Printed', `${mevoLog.length} lines sent to the Metro terminal.`);
  }, [mevoLog, diag, detectedGateway, mevoState]);

  /** Persisted stat layout. Unknown keys are dropped so an old saved order
   *  can't resurrect a stat that no longer exists. */
  useEffect(() => {
    AsyncStorage.getItem(STAT_ORDER_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (Array.isArray(saved)) {
          const clean = saved.filter((k: any) => typeof k === 'string' && STAT_BY_KEY[k]);
          if (clean.length) setStatOrder(clean);
        }
      })
      .catch(() => { });
  }, []);
  const saveStatOrder = useCallback((next: string[]) => {
    setStatOrder(next);
    AsyncStorage.setItem(STAT_ORDER_KEY, JSON.stringify(next)).catch(() => { });
  }, []);

  useEffect(() => {
    // Restore the previous trace so a reload (or a trip onto the Mevo+'s
    // network) doesn't lose it before it can be replayed.
    AsyncStorage.getItem(MEVO_LOG_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length) setMevoLog((cur) => (cur.length ? cur : saved));
      })
      .catch(() => { });
    connectAuto();
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

  useEffect(() => () => { linkRef.current?.close(); mevoRef.current?.close(); }, []);

  /** Connect straight to the Mevo+ over TCP (phone joined to its WiFi). */
  /**
   * Open a direct TCP session to a candidate host. Resolves TRUE once the
   * socket is genuinely up (state moved past 'connecting'), FALSE on error or
   * if nothing happens within the probe window — that's what lets connectAuto
   * walk a list of candidate addresses and stop at the one that answers.
   */
  const connectMevoDirect = useCallback((host: string): Promise<boolean> => new Promise((resolve) => {
    linkRef.current?.close();          // bridge and direct are mutually exclusive
    mevoRef.current?.close();
    setMevoLog([]);
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    // Nothing answered in time — move on to the next candidate.
    const probeTimer = setTimeout(() => done(false), 3500);
    const c = new MevoClient({
      onState: (st, detail) => {
        setMevoState(st);
        setStatusDetail(detail ?? null);
        // Anything past 'connecting' means the TCP session is real.
        if (st === 'handshaking' || st === 'arming' || st === 'ready' || st === 'shot') {
          clearTimeout(probeTimer); done(true);
        } else if (st === 'error' || st === 'closed') {
          clearTimeout(probeTimer); done(false);
        }
        // Mirror into the main pill so the range header reflects direct mode.
        setStatus(st === 'ready' || st === 'shot' ? 'connected'
          : st === 'error' ? 'error'
          : st === 'closed' ? 'closed' : 'connecting');
      },
      onShot: (s) => ingest(
        {
          ballSpeedMph: s.ballSpeedMph,
          launchAngleDeg: s.launchAngleDeg,
          azimuthDeg: s.azimuthDeg,
          spinRpm: s.spinRpm,
          spinAxisDeg: s.spinAxisDeg,
          clubSpeedMph: null, smashFactor: null, deviceCarryYds: null,
        },
        clubRef.current,
      ),
      // Keep the tail only — a session emits thousands of frames. Also
      // persisted so the trace survives leaving the Mevo+'s WiFi, an app
      // reload, or a crash — that's the whole point, since Metro is
      // unreachable while the phone is on the device's own network.
      onLog: (line) => setMevoLog((prev) => {
        const next = [...prev.slice(-400), line];
        AsyncStorage.setItem(MEVO_LOG_KEY, JSON.stringify(next)).catch(() => { });
        return next;
      }),
    });
    mevoRef.current = c;
    c.connect(host, MEVO_PORT);
  }), [ingest]);
  connectMevoRef.current = connectMevoDirect;

  /** Drop the most recent shot — the mishit you don't want polluting your
   *  club averages. Removes it from the session and clears it off the range. */
  const deleteLastShot = useCallback(() => {
    setShots((prev) => {
      if (!prev.length) return prev;
      const [dropped, ...rest] = prev;   // newest first
      setActive(rest.length ? rest[0] : null);
      // The remaining shot is already flown; don't re-animate it.
      flightAnim.setValue(1);
      setFlightT(1);
      if (dropped) {
        // Keep the club selection in step with what's now showing.
        setClub((c) => (rest.length ? rest[0].club : c));
      }
      return rest;
    });
  }, [flightAnim]);

  const saveSession = async () => {
    if (!shots.length) return;
    setSaving(true);
    try {
      const payload = shots.map((s) => ({
        club: s.club,
        distance_yds: Math.round(s.flight.totalYds),
        lateral_yds: Math.round(s.flight.finishOfflineYds),
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

  /**
   * Project the active shot's trajectory ONCE, and pre-build the cumulative
   * SVG path string at every step.
   *
   * The flight used to re-project all ~60 points and rebuild the whole `d`
   * string on every animation frame, which is what made it stutter. Now each
   * frame is an array index plus one interpolated point.
   */
  const activePath = useMemo(() => {
    if (!active) return null;
    const pts = active.flight.path.map(project);
    const ds: string[] = [];
    let acc = '';
    pts.forEach((p, i) => {
      acc += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
      ds.push(acc);
    });
    return { pts, ds };
  }, [active, project]);

  /** Landing dots for previous shots — projected once per shot list change,
   *  not once per animation frame. */
  const landedDots = useMemo(
    () => shots.slice(0, 40).map((sh) => ({
      id: sh.id,
      // Where the ball came to REST, so the scatter reflects the shot's real
      // result rather than its pitch mark.
      ...project({ x: sh.flight.totalYds, y: sh.flight.finishOfflineYds, z: 0 }),
    })),
    [shots, project],
  );

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

      {/* Fallback scenery, painted UNDER the photo. The JPEGs are ~300 KB and
          take a moment to decode (and can fail outright), which is what made
          the screen occasionally show as flat blue. Sky and turf split at the
          same horizon the projection uses, so even the bare fallback reads as
          a range and the ball still lands on the right line. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={{ height: `${HORIZON_FRAC * 100}%`, backgroundColor: '#3d6485' }} />
        <View style={{ flex: 1, backgroundColor: '#41703c' }} />
      </View>

      {/* ── Full-screen range art ──────────────────────────────────────── */}
      <ImageBackground
        source={isLandscape ? RANGE_ART.landscape : RANGE_ART.portrait}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        // The fallback scenery underneath carries the screen if this fails;
        // surface it in the log so a broken asset isn't invisible.
        onError={(e) => console.warn('[range] backdrop failed to load', e?.nativeEvent)}
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

          {/* Landed shots. The shot in flight is deliberately EXCLUDED until
              it touches down — drawing its landing dot up front gave away
              where the ball was going to finish. */}
          {landedDots.map((p) => {
            const isActive = active?.id === p.id;
            if (isActive && !flightDone) return null;
            return (
              <Circle
                key={`b${p.id}`} cx={p.x} cy={p.y}
                r={isActive ? 3.4 : 2.2}
                fill={isActive ? C.gold : '#ffffff'}
                opacity={isActive ? 1 : 0.55}
              />
            );
          })}

          {/* Live tracer. The head position is INTERPOLATED between path
              points — with ~60 samples the ball would otherwise visibly hop
              from one to the next. */}
          {activePath && activePath.pts.length > 1 && (() => {
            const { pts, ds } = activePath;
            const exact = Math.max(0, Math.min(1, flightT)) * (pts.length - 1);
            const i0 = Math.min(pts.length - 2, Math.floor(exact));
            const frac = exact - i0;
            const p0 = pts[i0];
            const p1 = pts[i0 + 1];
            const head = { x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac };
            const d = `${ds[i0]}L${head.x.toFixed(1)} ${head.y.toFixed(1)}`;
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

      {/* Stats view — the range art and tracer give way to nothing but the
          numbers, laid out in the player's own order. */}
      {viewMode === 'stats' && (
        <View style={s.statsPage}>
          {active ? (
            <>
              <View style={s.statsHead}>
                <Text style={s.statsClub}>{clubLabel(active.club)}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <TouchableOpacity onPress={() => setStatConfigOpen(true)}>
                    <Text style={s.statsAction}>Configure</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={deleteLastShot}>
                    <Text style={[s.statsAction, { color: C.red }]}>Delete</Text>
                  </TouchableOpacity>
                  <Text style={s.statsCount}>SHOT {shots.length}</Text>
                </View>
              </View>
              <ScrollView contentContainerStyle={s.statsGrid}>
                {statOrder.map((k) => {
                  const def = STAT_BY_KEY[k];
                  if (!def) return null;
                  const v = def.value({ shot: active.shot, flight: active.flight });
                  return (
                    <View key={k} style={s.statCell}>
                      <Text style={s.statCellLabel}>{def.label}</Text>
                      <Text style={[s.statCellValue, v == null && { color: C.textDim }]}>{v ?? '—'}</Text>
                      <Text style={s.statCellFrom}>{def.from === 'device' ? 'measured' : 'computed'}</Text>
                    </View>
                  );
                })}
              </ScrollView>
            </>
          ) : (
            <Text style={s.statsEmpty}>Hit a shot to see the numbers.</Text>
          )}
        </View>
      )}

      {/* ── Floating chrome ────────────────────────────────────────────── */}
      <View style={s.topBar} pointerEvents="box-none">
        <TouchableOpacity style={s.iconBtn} onPress={() => router.back()} activeOpacity={0.8}>
          <Text style={s.iconBtnText}>Back</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            style={s.iconBtn}
            onPress={() => setViewMode((m) => (m === 'range' ? 'stats' : 'range'))}
            activeOpacity={0.8}
          >
            <Text style={s.iconBtnText}>{viewMode === 'range' ? 'Stats' : 'Range'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.statusPill} onPress={() => setSetupOpen(true)} activeOpacity={0.8}>
            <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Shot readout — floats over the art, sized down in landscape so it
          never eats the range. */}
      {viewMode === 'range' && active && (
        <View style={[s.readout, isLandscape ? s.readoutLandscape : s.readoutPortrait]}>
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
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.readoutClub}>{clubLabel(active.club)}</Text>
              {/* Ditch a mishit before it reaches your club averages. */}
              <TouchableOpacity onPress={deleteLastShot} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.readoutDelete}>Delete shot</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={s.metricRow} pointerEvents="none">
            {statOrder.slice(0, 5).map((k) => {
              const def = STAT_BY_KEY[k];
              if (!def) return null;
              return (
                <Metric
                  key={k}
                  label={def.label.length > 8 ? def.label.split(' ')[0] : def.label}
                  value={def.value({ shot: active.shot, flight: active.flight }) ?? '—'}
                />
              );
            })}
          </View>
        </View>
      )}

      {viewMode === 'range' && !active && (
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

      {/* ── Stat layout ────────────────────────────────────────────────
          Pick which numbers appear and in what order. The first five also
          become the strip on the range overlay, so ordering does real work
          rather than only affecting the stats page. */}
      <Modal
        visible={statConfigOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setStatConfigOpen(false)}
      >
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Stats Shown</Text>
            <TouchableOpacity onPress={() => setStatConfigOpen(false)}><Text style={s.modalDone}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <Text style={s.cfgNote}>
              Tap to add or remove. Use the arrows to reorder — the top five also show
              on the range.
            </Text>

            <Text style={s.cfgSection}>SHOWING</Text>
            {statOrder.map((k, i) => {
              const def = STAT_BY_KEY[k];
              if (!def) return null;
              return (
                <View key={k} style={s.cfgRow}>
                  <Text style={s.cfgIndex}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cfgLabel}>{def.label}</Text>
                    <Text style={s.cfgFrom}>{def.from === 'device' ? 'measured by monitor' : 'computed by Sacari'}</Text>
                  </View>
                  <TouchableOpacity
                    style={[s.cfgArrow, i === 0 && { opacity: 0.25 }]}
                    disabled={i === 0}
                    onPress={() => {
                      const next = [...statOrder];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      saveStatOrder(next);
                    }}
                  >
                    <Text style={s.cfgArrowText}>↑</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.cfgArrow, i === statOrder.length - 1 && { opacity: 0.25 }]}
                    disabled={i === statOrder.length - 1}
                    onPress={() => {
                      const next = [...statOrder];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      saveStatOrder(next);
                    }}
                  >
                    <Text style={s.cfgArrowText}>↓</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.cfgRemove}
                    onPress={() => saveStatOrder(statOrder.filter((x) => x !== k))}
                  >
                    <Text style={s.cfgRemoveText}>Remove</Text>
                  </TouchableOpacity>
                </View>
              );
            })}

            {STAT_DEFS.some((d) => !statOrder.includes(d.key)) && (
              <>
                <Text style={s.cfgSection}>AVAILABLE</Text>
                {STAT_DEFS.filter((d) => !statOrder.includes(d.key)).map((def) => (
                  <TouchableOpacity
                    key={def.key}
                    style={s.cfgRow}
                    onPress={() => saveStatOrder([...statOrder, def.key])}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.cfgLabel}>{def.label}</Text>
                      <Text style={s.cfgFrom}>{def.from === 'device' ? 'measured by monitor' : 'computed by Sacari'}</Text>
                    </View>
                    <Text style={s.cfgAdd}>+ Add</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            <TouchableOpacity
              style={s.cfgReset}
              onPress={() => saveStatOrder(DEFAULT_STAT_ORDER)}
            >
              <Text style={s.cfgResetText}>Reset to default</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

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

      {/* ── Connect sheet ──────────────────────────────────────────────
          One button. It figures out what's on the network itself: the Mevo+
          directly over TCP if the phone is on the device's WiFi, otherwise a
          GSPro-Connect bridge. Every step is logged, and the same lines are
          mirrored to the Metro terminal with a [mevo] prefix. */}
      <Modal
        visible={setupOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSetupOpen(false)}
        onShow={() => {
          getDiagnostics().then((d) => {
            setDiag(d);
            if (d.subnet) setDetectedGateway(`${d.subnet}1`);
          }).catch(() => setDiag(null));
        }}
      >
        <ScrollView style={s.modal} contentContainerStyle={{ padding: 20 }}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Launch Monitor</Text>
            <TouchableOpacity onPress={() => setSetupOpen(false)}><Text style={s.modalDone}>Close</Text></TouchableOpacity>
          </View>

          <Text style={s.setupBody}>
            Join your phone to your launch monitor's WiFi (or the network running a
            bridge), then connect. Sacari finds the device itself.
          </Text>

          <TouchableOpacity
            style={[s.setupConnect, (scanning || connectingAuto) && { opacity: 0.6 }]}
            onPress={connectAuto}
            disabled={scanning || connectingAuto}
          >
            {(scanning || connectingAuto)
              ? <ActivityIndicator color="#000" />
              : <Text style={s.setupConnectText}>Find &amp; Connect</Text>}
          </TouchableOpacity>

          {/* Compact status line — what it is, where, and how far it got. */}
          <Text style={s.setupNote}>
            {diag?.ip ? `This phone ${diag.ip}` : 'Reading network…'}
            {detectedGateway ? `  ·  device likely ${detectedGateway}` : ''}
          </Text>
          {mevoState !== 'idle' && (
            <Text style={mevoState === 'error' ? s.setupErr : s.setupOk}>
              Mevo+: {mevoState}
            </Text>
          )}
          {status === 'connected' && <Text style={s.setupOk}>Bridge connected: {bridgeUrl}</Text>}
          {statusDetail && <Text style={s.setupErr}>{statusDetail}</Text>}

          {mevoLog.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.setupLabel}>PROTOCOL LOG</Text>
                <TouchableOpacity
                  onPress={printLogToTerminal}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ color: C.gold, fontSize: 12, fontWeight: '800' }}>Print to terminal</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    const body = [
                      `Sacari Mevo+ log — ${new Date().toISOString()}`,
                      `phone ${diag?.ip ?? '?'}  gateway ${detectedGateway ?? '?'}  state=${mevoState}`,
                      '',
                      ...mevoLog,
                    ].join('\n');
                    Share.share({ message: body }).catch(() => { });
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ color: C.gold, fontSize: 12, fontWeight: '800' }}>Share</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={s.logBox} nestedScrollEnabled>
                {mevoLog.map((l, i) => (
                  <Text key={i} style={s.logLine}>{l}</Text>
                ))}
              </ScrollView>
              <Text style={s.setupNote}>
                These same lines print in your Metro terminal prefixed [mevo].
              </Text>
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

  readoutDelete: { color: C.red, fontSize: 11, fontWeight: '800', marginTop: 4 },

  // ── Stats view (no scenery, just the numbers) ──
  statsPage: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg, paddingTop: 96, paddingHorizontal: 14 },
  statsHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  statsClub: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  statsAction: { color: C.gold, fontSize: 12, fontWeight: '800' },
  statsCount: { color: C.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 110 },
  statCell: {
    flexBasis: '31%', flexGrow: 1,
    backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center',
  },
  statCellLabel: { color: C.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.9 },
  statCellValue: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '900', marginTop: 3 },
  statCellFrom: { color: C.textDim, fontSize: 8, marginTop: 2 },
  statsEmpty: { color: C.textMuted, fontSize: 14, textAlign: 'center', marginTop: 40 },

  // ── Stat layout config ──
  cfgNote: { color: C.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 6 },
  cfgSection: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.3, marginTop: 18, marginBottom: 8 },
  cfgRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6,
  },
  cfgIndex: { color: C.gold, fontSize: 12, fontWeight: '900', width: 18 },
  cfgLabel: { color: C.text, fontSize: 14, fontWeight: '700' },
  cfgFrom: { color: C.textDim, fontSize: 10, marginTop: 1 },
  cfgArrow: {
    width: 30, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  cfgArrowText: { color: C.text, fontSize: 15, fontWeight: '900' },
  cfgRemove: { paddingHorizontal: 6 },
  cfgRemoveText: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
  cfgAdd: { color: C.gold, fontSize: 12, fontWeight: '800' },
  cfgReset: { marginTop: 22, alignSelf: 'center', padding: 10 },
  cfgResetText: { color: C.textMuted, fontSize: 13, fontWeight: '700' },

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
  hostChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  hostChipActive: { backgroundColor: C.gold, borderColor: C.gold },
  hostChipText: { color: C.text, fontSize: 12, fontWeight: '700', fontFamily: F.mono },
  logBox: {
    maxHeight: 220, backgroundColor: '#000', borderRadius: 8,
    borderWidth: 1, borderColor: C.border, padding: 10,
  },
  logLine: { color: '#9fe89f', fontSize: 10, fontFamily: F.mono, lineHeight: 14 },
  setupNote: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 18, fontStyle: 'italic' },
});
