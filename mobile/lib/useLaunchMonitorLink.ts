/**
 * useLaunchMonitorLink — one hook that gets shots out of a launch monitor.
 *
 * Encapsulates the connect ladder so a screen only has to say "give me shots":
 *   1. probe the phone's own gateway (the Mevo+ hands out DHCP on its AP, so
 *      the gateway IS the device when you're joined to its WiFi)
 *   2. walk the known fallback addresses
 *   3. fall back to a GSPro-Connect bridge on the LAN (covers every other
 *      monitor: SkyTrak, Bushnell, Garmin, Uneekor)
 *
 * Screens get a single `status` to render and a `connect()` to call. The
 * protocol lives in lib/mevo/* and lib/launchMonitor.ts; this only orchestrates.
 *
 * NOTE: app/range/live.tsx predates this hook and still runs its own copy of
 * the ladder (it also drives an on-screen protocol log used to reverse-engineer
 * the handshake). Fix transport bugs in lib/mevo/client.ts so both benefit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  connectLaunchMonitor, discoverBridge, getDiagnostics, LaunchShot, LinkStatus,
} from './launchMonitor';
import { MevoClient, MevoState, MEVO_HOST_CANDIDATES, MEVO_PORT } from './mevo/client';

const BRIDGE_KEY = 'sacari.lm.bridge';
/** How long a candidate host gets to prove a socket is real. */
const PROBE_MS = 3500;

export type LinkPhase = 'idle' | 'searching' | 'connecting' | 'ready' | 'error';

export function useLaunchMonitorLink(onShot: (s: LaunchShot) => void) {
  const [phase, setPhase] = useState<LinkPhase>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [scanPct, setScanPct] = useState(0);

  const mevoRef = useRef<MevoClient | null>(null);
  const linkRef = useRef<{ close: () => void } | null>(null);
  const busyRef = useRef(false);
  const scanSignal = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Callback identity changes every render in most screens; keep the socket
  // handler stable by reading through a ref instead of re-subscribing.
  const shotRef = useRef(onShot);
  shotRef.current = onShot;

  const closeAll = useCallback(() => {
    linkRef.current?.close();
    mevoRef.current?.close();
    linkRef.current = null;
    mevoRef.current = null;
  }, []);

  useEffect(() => () => { scanSignal.current.cancelled = true; closeAll(); }, [closeAll]);

  /** Try one host over raw TCP. Resolves true once the session is genuinely up. */
  const tryMevo = useCallback((host: string): Promise<boolean> => new Promise((resolve) => {
    closeAll();
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const timer = setTimeout(() => done(false), PROBE_MS);
    const c = new MevoClient({
      onState: (st: MevoState, d?: string) => {
        setDetail(d ?? null);
        if (st === 'handshaking' || st === 'arming' || st === 'ready' || st === 'shot') {
          clearTimeout(timer); done(true);
          setPhase(st === 'ready' || st === 'shot' ? 'ready' : 'connecting');
        } else if (st === 'error' || st === 'closed') {
          clearTimeout(timer); done(false);
          setPhase('error');
        }
      },
      onShot: (s) => shotRef.current({
        ballSpeedMph: s.ballSpeedMph,
        launchAngleDeg: s.launchAngleDeg,
        azimuthDeg: s.azimuthDeg,
        spinRpm: s.spinRpm,
        spinAxisDeg: s.spinAxisDeg,
        clubSpeedMph: null, smashFactor: null, deviceCarryYds: null,
      }),
      onLog: () => { },
    });
    mevoRef.current = c;
    c.connect(host, MEVO_PORT);
  }), [closeAll]);

  /** Full ladder: device direct, then a bridge. */
  const connect = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDetail(null);
    setPhase('searching');
    try {
      const d = await getDiagnostics().catch(() => null);
      if (!d?.ready) {
        setPhase('error');
        setDetail('This build can\'t reach the local network. Needs a dev or production build.');
        return;
      }
      if (!d.subnet) { setPhase('error'); setDetail(d.note); return; }

      const gw = `${d.subnet}1`;
      for (const host of [gw, ...MEVO_HOST_CANDIDATES.filter((h) => h !== gw)]) {
        setDetail(`Trying ${host}…`);
        if (await tryMevo(host)) return;         // client owns the session now
      }

      setDetail('No monitor answered directly. Looking for a bridge.');
      scanSignal.current = { cancelled: false };
      const saved = await AsyncStorage.getItem(BRIDGE_KEY).catch(() => null);
      const found = await discoverBridge({
        preferred: saved, signal: scanSignal.current, onProgress: setScanPct,
      });
      if (!found) {
        setPhase('error');
        setDetail('Nothing found. Check the phone is on the monitor\'s WiFi.');
        return;
      }
      AsyncStorage.setItem(BRIDGE_KEY, found).catch(() => { });
      closeAll();
      setPhase('connecting');
      linkRef.current = connectLaunchMonitor(found, {
        onShot: (s) => shotRef.current(s),
        onStatus: (st: LinkStatus, dd?: string) => {
          setDetail(dd ?? null);
          setPhase(st === 'connected' ? 'ready' : st === 'error' || st === 'closed' ? 'error' : 'connecting');
        },
      });
    } finally {
      busyRef.current = false;
    }
  }, [tryMevo, closeAll]);

  const disconnect = useCallback(() => {
    scanSignal.current.cancelled = true;
    closeAll();
    setPhase('idle');
    setDetail(null);
  }, [closeAll]);

  return { phase, detail, scanPct, connect, disconnect };
}
