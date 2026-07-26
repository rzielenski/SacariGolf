/**
 * Mevo+ direct client — talks to the launch monitor over raw TCP from the
 * phone, no laptop bridge in the middle.
 *
 * Connect the phone to the Mevo+'s WiFi, then this opens TCP :5100 to the
 * device and runs the documented lifecycle:
 *
 *   handshake (DSP → AVR sync) → ARM → keepalive ~1 Hz
 *   → on a shot: collect 0xD4 (launch) + 0xEF (spin) → emit → re-arm
 *
 * DESIGN NOTE — the full FS Golf handshake is six phases and ~50 exchanges,
 * most of which configure the camera and write tuning parameters we don't use.
 * We run a MINIMAL subset: identify the device, sync the AVR, then arm. Every
 * frame in and out is logged, so if the device refuses to arm we can see
 * exactly where it stopped and add the missing step. The alternative — writing
 * all six phases blind against hardware I can't test — would be far more code
 * and no more likely to work first try.
 *
 * Requires react-native-tcp-socket (native), so it needs a dev/production
 * build; it will not run in Expo Go.
 */
import { BUS, FrameReader, encodeFrame, DecodedFrame } from './frame';
import {
  MSG, MevoShot, decodeFlightResult, decodeFlightResultV1, decodeSpinResult, decodeText,
} from './messages';

export const MEVO_PORT = 5100;
/** The device's address on its own access point. */
export const MEVO_DEFAULT_HOST = '192.168.0.1';
/** Other gateways seen in the wild, tried in order if the default is silent. */
export const MEVO_HOST_CANDIDATES = ['192.168.0.1', '192.168.1.1', '10.0.0.1', '192.168.4.1'];

export type MevoState =
  | 'idle' | 'connecting' | 'handshaking' | 'arming' | 'ready' | 'shot' | 'error' | 'closed';

export interface MevoEvents {
  onState: (s: MevoState, detail?: string) => void;
  onShot: (shot: MevoShot) => void;
  /** Every frame + lifecycle note, for the in-app debug log. */
  onLog: (line: string) => void;
}

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0').toUpperCase()}`;

export class MevoClient {
  private socket: any = null;
  private reader = new FrameReader();
  private events: MevoEvents;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private state: MevoState = 'idle';
  /** Shot fields accumulate across several messages before we emit. */
  private pending: Partial<MevoShot> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(events: MevoEvents) { this.events = events; }

  private setState(s: MevoState, detail?: string) {
    this.state = s;
    this.events.onState(s, detail);
  }
  private log(line: string) { this.events.onLog(line); }

  /** Open the socket and start the lifecycle. */
  connect(host: string = MEVO_DEFAULT_HOST, port: number = MEVO_PORT) {
    this.closed = false;
    let TcpSocket: any;
    try {
      TcpSocket = require('react-native-tcp-socket').default ?? require('react-native-tcp-socket');
    } catch {
      this.setState('error', 'Direct mode needs a development or production build (not Expo Go).');
      return;
    }

    this.setState('connecting', `${host}:${port}`);
    this.log(`connecting to ${host}:${port}`);
    try {
      this.socket = TcpSocket.createConnection({ host, port, tls: false }, () => {
        this.log('tcp connected');
        this.startHandshake();
      });
    } catch (e: any) {
      this.setState('error', e?.message ?? 'Could not open socket');
      return;
    }

    this.socket.on('data', (data: any) => {
      // RN gives a Buffer-like or base64 string depending on platform/version.
      const bytes: number[] = typeof data === 'string'
        ? Array.from(Buffer.from(data, 'base64'))
        : Array.from(data as Uint8Array);
      for (const f of this.reader.push(bytes)) this.onFrame(f);
    });
    this.socket.on('error', (e: any) => {
      if (this.closed) return;
      this.log(`socket error: ${e?.message ?? e}`);
      this.setState('error', e?.message ?? 'Socket error');
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.log('socket closed by device');
      this.setState('closed');
      this.stopTimers();
    });
  }

  close() {
    this.closed = true;
    this.stopTimers();
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.reader.reset();
    this.setState('closed');
  }

  private stopTimers() {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.armTimer) { clearTimeout(this.armTimer); this.armTimer = null; }
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
  }

  private send(dest: number, type: number, payload: number[] = []) {
    if (!this.socket || this.closed) return;
    const frame = encodeFrame(dest, BUS.APP, type, payload);
    try {
      this.socket.write(Buffer.from(frame));
      this.log(`→ ${hex(type)} to ${hex(dest)}${payload.length ? ` [${payload.map(hex).join(' ')}]` : ''}`);
    } catch (e: any) {
      this.log(`write failed: ${e?.message ?? e}`);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private startHandshake() {
    this.setState('handshaking');
    // Identify the device, then wake the AVR. Small gaps between steps: the
    // device is a microcontroller and answers in its own time.
    this.send(BUS.DSP, MSG.STATUS, [0x01, 0x01]);
    setTimeout(() => this.send(BUS.DSP, MSG.HW_QUERY), 120);
    setTimeout(() => this.send(BUS.DSP, MSG.INFO_REQ), 240);
    setTimeout(() => this.send(BUS.DSP, MSG.CONFIG_QUERY), 360);
    setTimeout(() => this.send(BUS.AVR, MSG.STATUS, [0x01, 0x01]), 500);
    setTimeout(() => this.send(BUS.AVR, MSG.INFO_REQ), 620);
    setTimeout(() => this.send(BUS.AVR, MSG.CONFIG_QUERY), 740);
    setTimeout(() => this.arm(), 900);
  }

  /** 0xB0 [01 01] is the ARM trigger; the device confirms with 0x95 then an
   *  unsolicited "ARMED DetectionMode=…" text. */
  private arm() {
    this.setState('arming');
    this.send(BUS.AVR, MSG.CONFIG, [0x01, 0x01]);
    this.startKeepalive();
    // If no ARMED text lands, say so rather than hanging silently.
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      if (this.state === 'arming') {
        this.log('no ARMED confirmation after 4s — device may need more of the handshake');
        this.setState('error', 'Device did not arm. See the log for the last response.');
      }
    }, 4000);
  }

  private startKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    // ~1 Hz poll of each bus; the device goes dormant without it.
    this.keepaliveTimer = setInterval(() => {
      this.send(BUS.DSP, MSG.STATUS, [0x01, 0x01]);
      this.send(BUS.AVR, MSG.STATUS, [0x01, 0x01]);
    }, 1000);
  }

  /** After a shot the device waits to be acked and re-armed, or it goes quiet. */
  private reArm() {
    this.send(BUS.AVR, MSG.SHOT_DATA_ACK);
    this.send(BUS.AVR, MSG.SHOT_DATA_ACK);
    setTimeout(() => this.send(BUS.AVR, MSG.CONFIG_QUERY), 80);
    setTimeout(() => {
      this.send(BUS.AVR, MSG.CONFIG, [0x01, 0x01]);
      this.setState('ready');
    }, 160);
  }

  // ── Frame handling ─────────────────────────────────────────────────────────

  private onFrame(f: DecodedFrame) {
    if (!f.checksumOk) { this.log(`← ${hex(f.type)} BAD CHECKSUM (ignored)`); return; }
    const from = f.src === BUS.AVR ? 'AVR' : f.src === BUS.DSP ? 'DSP' : f.src === BUS.PI ? 'PI' : hex(f.src);

    switch (f.type) {
      case MSG.HW_RESP: {
        const model = f.payload[1] === 0x80 ? 'Mevo+' : f.payload[1] === 0xc0 ? 'Mevo Gen2' : 'unknown';
        this.log(`← ${from} hardware: ${model}`);
        return;
      }
      case MSG.SHOT_TEXT:
      case MSG.STATUS_TEXT: {
        const text = decodeText(f.payload);
        if (text) this.log(`← ${from} "${text}"`);
        if (/ARMED/i.test(text) && !/CANCELLED/i.test(text)) {
          if (this.armTimer) { clearTimeout(this.armTimer); this.armTimer = null; }
          this.setState('ready', text);
        }
        if (/BALL TRIGGER/i.test(text)) this.setState('shot');
        if (/PROCESSED/i.test(text)) { this.flushShot(); this.reArm(); }
        return;
      }
      case MSG.FLIGHT_RESULT: {
        const d = decodeFlightResult(f.payload);
        if (d) {
          this.pending = { ...(this.pending ?? {}), ...d };
          this.log(`← ${from} FLIGHT_RESULT ball ${d.ballSpeedMph?.toFixed(1)} mph, launch ${d.launchAngleDeg?.toFixed(1)}°`);
          this.scheduleEmit();
        } else {
          this.log(`← ${from} FLIGHT_RESULT (${f.payload.length}B) — too short to decode`);
        }
        return;
      }
      case MSG.FLIGHT_RESULT_V1: {
        // Only fill gaps; 0xD4 is authoritative and may already have landed.
        const d = decodeFlightResultV1(f.payload);
        if (d && !this.pending?.ballSpeedMph) {
          this.pending = { ...(this.pending ?? {}), ...d };
          this.log(`← ${from} FLIGHT_RESULT_V1 ball ${d.ballSpeedMph?.toFixed(1)} mph (preliminary)`);
          this.scheduleEmit();
        }
        return;
      }
      case MSG.SPIN_RESULT: {
        const sp = decodeSpinResult(f.payload);
        if (sp) {
          this.pending = { ...(this.pending ?? {}), ...sp, spinFinal: true };
          this.log(`← ${from} SPIN_RESULT ${Math.round(sp.spinRpm)} rpm, axis ${sp.spinAxisDeg.toFixed(1)}°`);
          this.scheduleEmit();
        }
        return;
      }
      // High-volume tracking data we don't use — count them, don't spam.
      case MSG.PRC_DATA:
      case MSG.TRACKING_STATUS:
      case MSG.STATUS:
      case MSG.CONFIG_ACK:
        return;
      default:
        this.log(`← ${from} ${hex(f.type)} (${f.payload.length}B)`);
    }
  }

  /**
   * Launch and spin arrive in separate messages. Emit shortly after the last
   * useful piece so the shot carries spin when it's available, without waiting
   * forever if SPIN_RESULT never comes.
   */
  private scheduleEmit() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    const delay = this.pending?.spinFinal ? 60 : 700;
    this.emitTimer = setTimeout(() => this.flushShot(), delay);
  }

  private flushShot() {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    const p = this.pending;
    this.pending = null;
    if (!p || !p.ballSpeedMph || !(p.ballSpeedMph > 0)) return;
    this.events.onShot({
      ballSpeedMph: p.ballSpeedMph,
      launchAngleDeg: p.launchAngleDeg ?? 0,
      azimuthDeg: p.azimuthDeg ?? 0,
      spinRpm: p.spinRpm ?? 0,
      spinAxisDeg: p.spinAxisDeg ?? 0,
      spinFinal: p.spinFinal ?? false,
    });
  }
}
