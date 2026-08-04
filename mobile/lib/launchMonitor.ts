/**
 * Launch-monitor link for Range Sesh Live.
 *
 * Sacari does NOT talk the Mevo+ binary radar protocol directly — that's a
 * proprietary TCP protocol on the device's own WiFi, and React Native can't
 * open raw TCP sockets without a native module. Instead we speak the
 * **GSPro Connect v1 JSON schema over WebSocket**, which is the de-facto
 * interchange format in the simulator world: open-source bridges (ironsight
 * for the Mevo+, and the equivalents for Bushnell / Garmin / SkyTrak /
 * Uneekor) all emit it. Point Sacari at whatever bridge the user runs and
 * shots stream in.
 *
 * That choice means one integration covers every launch monitor that speaks
 * the standard, instead of one fragile reverse-engineered binding per device.
 *
 * Payload we consume (extra fields ignored):
 *   {
 *     "BallData": {
 *       "Speed": 147.3,        // mph
 *       "VLA": 14.3,           // vertical launch, deg
 *       "HLA": 2.3,            // horizontal launch, deg (+ right)
 *       "TotalSpin": 3250,     // rpm
 *       "SpinAxis": -13.2,     // deg (+ right / fade for a RH player)
 *       "BackSpin": 3163,      // rpm  (used to derive axis if SpinAxis absent)
 *       "SideSpin": -745       // rpm  (+ right)
 *     },
 *     "ClubData": { "Speed": 100, "SmashFactor": 1.47, "Path": 1.2, ... }
 *   }
 * Flat/snake_case variants are accepted too, since bridges vary.
 */

export interface LaunchShot {
  ballSpeedMph: number;
  launchAngleDeg: number;
  azimuthDeg: number;
  spinRpm: number;
  spinAxisDeg: number;
  /** Optional club-side telemetry, shown when the monitor provides it. */
  clubSpeedMph?: number | null;
  smashFactor?: number | null;
  /** The monitor's OWN carry number, when present — displayed next to ours
   *  as a cross-check. We never use it for the trajectory. */
  deviceCarryYds?: number | null;
}

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

/** Pull a number from an object under any of several key spellings. */
function num(obj: any, ...keys: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    // exact, then case-insensitive
    let v = obj[k];
    if (v === undefined) {
      const hit = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase());
      if (hit) v = obj[hit];
    }
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Normalize a bridge message into a LaunchShot, or null when the message
 * isn't a shot (heartbeats, acks, status frames all flow through here).
 */
export function parseShotMessage(raw: any): LaunchShot | null {
  let msg = raw;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); } catch { return null; }
  }
  if (!msg || typeof msg !== 'object') return null;

  // GSPro Connect nests under BallData; flat bridges put it at the root.
  const ball = msg.BallData ?? msg.ballData ?? msg.ball_data ?? msg.ball ?? msg;
  const club = msg.ClubData ?? msg.clubData ?? msg.club_data ?? msg.club ?? null;

  const ballSpeedMph = num(ball, 'Speed', 'BallSpeed', 'ball_speed', 'ballSpeed', 'speed_mph');
  const launchAngleDeg = num(ball, 'VLA', 'LaunchAngle', 'launch_angle', 'launchAngle', 'vla');
  if (ballSpeedMph == null || launchAngleDeg == null) return null;   // not a shot
  if (ballSpeedMph <= 0) return null;

  const azimuthDeg = num(ball, 'HLA', 'Azimuth', 'azimuth', 'launch_direction', 'hla') ?? 0;

  // Spin: prefer total + axis; otherwise derive them from back/side spin.
  let spinRpm = num(ball, 'TotalSpin', 'Spin', 'total_spin', 'totalSpin', 'spin_rpm') ?? 0;
  let spinAxisDeg = num(ball, 'SpinAxis', 'spin_axis', 'spinAxis');
  const backSpin = num(ball, 'BackSpin', 'back_spin', 'backSpin');
  const sideSpin = num(ball, 'SideSpin', 'side_spin', 'sideSpin');
  if ((spinAxisDeg == null || spinRpm <= 0) && backSpin != null && sideSpin != null) {
    if (spinRpm <= 0) spinRpm = Math.hypot(backSpin, sideSpin);
    if (spinAxisDeg == null) spinAxisDeg = (Math.atan2(sideSpin, Math.max(1, backSpin)) * 180) / Math.PI;
  }

  return {
    ballSpeedMph,
    launchAngleDeg,
    azimuthDeg,
    spinRpm: spinRpm > 0 ? spinRpm : 0,
    spinAxisDeg: spinAxisDeg ?? 0,
    clubSpeedMph: club ? num(club, 'Speed', 'ClubSpeed', 'club_speed', 'clubSpeed') : null,
    smashFactor: club ? num(club, 'SmashFactor', 'smash_factor', 'smashFactor') : null,
    deviceCarryYds: num(ball, 'CarryDistance', 'Carry', 'carry', 'carry_yds'),
  };
}

export interface LaunchMonitorLink {
  close: () => void;
  /** Current socket state, for UI that polls rather than subscribes. */
  status: () => LinkStatus;
}

/**
 * Open a WebSocket to a launch-monitor bridge. Auto-reconnects with backoff
 * until closed, because a range session outlives the odd dropped connection
 * (phone sleeps, bridge restarts) and re-pairing by hand mid-bucket is
 * exactly the friction that kills this feature.
 */
export function connectLaunchMonitor(
  url: string,
  handlers: {
    onShot: (shot: LaunchShot) => void;
    onStatus?: (s: LinkStatus, detail?: string) => void;
  },
): LaunchMonitorLink {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let status: LinkStatus = 'idle';

  const setStatus = (s: LinkStatus, detail?: string) => {
    status = s;
    handlers.onStatus?.(s, detail);
  };

  const open = () => {
    if (closedByUs) return;
    setStatus('connecting');
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      setStatus('error', e?.message ?? 'Could not open socket');
      schedule();
      return;
    }

    ws.onopen = () => { attempt = 0; setStatus('connected'); };
    ws.onmessage = (ev: any) => {
      const shot = parseShotMessage(ev?.data);
      if (shot) handlers.onShot(shot);
    };
    ws.onerror = () => {
      // RN gives no useful detail here; the close handler drives the retry.
      if (!closedByUs) setStatus('error', 'Connection problem');
    };
    ws.onclose = () => {
      ws = null;
      if (closedByUs) { setStatus('closed'); return; }
      schedule();
    };
  };

  const schedule = () => {
    if (closedByUs || retryTimer) return;
    attempt += 1;
    const delay = Math.min(15000, 800 * Math.pow(1.7, Math.min(attempt, 6)));
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, delay);
  };

  open();

  return {
    close: () => {
      closedByUs = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { ws?.close(); } catch { /* already gone */ }
      ws = null;
      setStatus('closed');
    },
    status: () => status,
  };
}

// ── Auto-discovery ───────────────────────────────────────────────────────────
// Users should never type an IP address. The bridge is a program on a laptop
// on the same WiFi, so we look for it: take the phone's own address, walk the
// /24 it sits on, and probe the standard ports. First socket that opens wins.
//
// iOS 14+ NOTE: any local-network connection (including this scan) requires
// NSLocalNetworkUsageDescription in Info.plist and triggers the system
// "allow local network" prompt. Without that key iOS fails the connections
// silently — no error, just nothing. It's declared in app.json.

/** GSPro Connect's standard port, then the alternates bridges commonly use. */
const BRIDGE_PORTS = [921, 8888, 2483, 9000];

/**
 * True when this BINARY can do local networking at all.
 *
 * expo-network is a native module and NSLocalNetworkUsageDescription is an
 * Info.plist key — both only exist in a build made after they were added. On
 * an older build the scan finds nothing and manual entry throws a generic
 * socket error, which looks like "the bridge is broken" when really the app
 * simply can't reach the LAN yet. The UI uses this to say so plainly.
 */
function localNetworkReady(): boolean {
  try {
    const N = require('expo-network');
    return typeof N?.getIpAddressAsync === 'function';
  } catch {
    return false;
  }
}

/** Probe one ws:// URL. Resolves true only if the socket actually opens. */
function probe(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already dead */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      finish(false);
      return;
    }
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

export interface Diagnostics {
  /** Can this BINARY reach the LAN at all (native module + entitlement)? */
  ready: boolean;
  /** The phone's own address, or null if we can't read it. */
  ip: string | null;
  /** The /24 the scan will sweep, e.g. "192.168.1." */
  subnet: string | null;
  /** Human-readable reason when something is missing. */
  note: string;
}

/**
 * What the app can actually see right now. Surfaced in the setup sheet so a
 * failed connection reports facts (build capability, phone IP, subnet) instead
 * of a generic error — you can't debug a network from "connection error".
 */
export async function getDiagnostics(): Promise<Diagnostics> {
  if (!localNetworkReady()) {
    return {
      ready: false, ip: null, subnet: null,
      note: 'This build has no local-network support. It needs expo-network and the NSLocalNetworkUsageDescription entitlement, which only ship in a new native build.',
    };
  }
  let ip: string | null = null;
  try {
    const N = require('expo-network');
    ip = await N.getIpAddressAsync();
  } catch (e: any) {
    return { ready: true, ip: null, subnet: null, note: `Could not read this device's IP: ${e?.message ?? 'unknown error'}` };
  }
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return { ready: true, ip, subnet: null, note: 'No IPv4 address — the phone may not be on WiFi.' };
  }
  if (ip.startsWith('127.')) {
    return { ready: true, ip, subnet: null, note: 'Only a loopback address — the phone is not on a WiFi network.' };
  }
  const subnet = ip.slice(0, ip.lastIndexOf('.') + 1);
  return {
    ready: true, ip, subnet,
    note: `Scanning ${subnet}1-254 on ports ${BRIDGE_PORTS.join(', ')}. The computer running your bridge must be on this same subnet.`,
  };
}

export interface DiscoverOptions {
  /** Checked first — the address that worked last time. */
  preferred?: string | null;
  timeoutMs?: number;
  /** Reports scan progress 0..1 so the UI can show something honest. */
  onProgress?: (fraction: number) => void;
  /** Set `.cancelled = true` to abort an in-flight scan. */
  signal?: { cancelled: boolean };
}

/**
 * Find a launch-monitor bridge on the local network. Returns a ws:// URL, or
 * null when nothing answered.
 */
export async function discoverBridge(opts: DiscoverOptions = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 900;
  const cancelled = () => opts.signal?.cancelled === true;

  // 1. Whatever worked last time — instant reconnect in the normal case.
  if (opts.preferred) {
    if (await probe(opts.preferred, timeoutMs)) return opts.preferred;
    if (cancelled()) return null;
  }

  // 2. Derive the subnet from our own address.
  let ip: string | null = null;
  try {
    const Network = require('expo-network');
    ip = await Network.getIpAddressAsync();
  } catch { /* module missing or permission denied */ }
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip.startsWith('127.')) return null;
  const prefix = ip.slice(0, ip.lastIndexOf('.') + 1);
  const ownHost = Number(ip.slice(ip.lastIndexOf('.') + 1));

  // 3. Sweep the /24 in batches, ports in priority order. Batching keeps us
  //    from opening 254 sockets at once; the first hit short-circuits.
  const BATCH = 48;
  const hosts: number[] = [];
  for (let h = 1; h <= 254; h++) if (h !== ownHost) hosts.push(h);

  const totalUnits = hosts.length * BRIDGE_PORTS.length;
  let done = 0;

  for (const port of BRIDGE_PORTS) {
    for (let i = 0; i < hosts.length; i += BATCH) {
      if (cancelled()) return null;
      const slice = hosts.slice(i, i + BATCH);
      const urls = slice.map((h) => `ws://${prefix}${h}:${port}`);
      const results = await Promise.all(urls.map((u) => probe(u, timeoutMs)));
      done += slice.length;
      opts.onProgress?.(Math.min(1, done / totalUnits));
      const hit = results.findIndex(Boolean);
      if (hit >= 0) return urls[hit];
    }
  }
  return null;
}

/**
 * Plausible shot for a club, used by Demo mode so the range is usable (and
 * testable) with no hardware present. Centred on PGA-ish launch conditions
 * with enough scatter to look like a real player.
 */
export function demoShot(club: string): LaunchShot {
  const BASE: Record<string, { b: number; l: number; s: number }> = {
    driver: { b: 152, l: 12.5, s: 2700 }, '3w': { b: 145, l: 10.5, s: 3500 },
    '5w': { b: 140, l: 11.0, s: 4200 },  hybrid: { b: 136, l: 11.5, s: 4400 },
    '3i': { b: 132, l: 11.5, s: 4600 },  '4i': { b: 128, l: 12.5, s: 4900 },
    '5i': { b: 124, l: 14.0, s: 5400 },  '6i': { b: 119, l: 15.5, s: 6200 },
    '7i': { b: 113, l: 17.5, s: 7100 },  '8i': { b: 108, l: 19.5, s: 8000 },
    '9i': { b: 102, l: 22.0, s: 8600 },  pw: { b: 96, l: 25.0, s: 9300 },
    gw: { b: 88, l: 27.0, s: 9700 },     sw: { b: 78, l: 30.0, s: 10200 },
    lw: { b: 68, l: 33.0, s: 10800 },
  };
  const base = BASE[club] ?? BASE['7i'];
  const jitter = (spread: number) => (Math.random() - 0.5) * 2 * spread;
  return {
    ballSpeedMph: Math.max(20, base.b + jitter(base.b * 0.04)),
    launchAngleDeg: base.l + jitter(1.8),
    azimuthDeg: jitter(3),
    spinRpm: Math.max(200, base.s + jitter(base.s * 0.12)),
    spinAxisDeg: jitter(9),
    clubSpeedMph: null,
    smashFactor: null,
    deviceCarryYds: null,
  };
}
