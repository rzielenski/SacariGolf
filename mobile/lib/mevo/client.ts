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

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/**
 * Decode a base64 string to raw bytes.
 *
 * Hand-rolled because React Native's Hermes engine provides neither Node's
 * `Buffer` nor a dependable global `atob` across versions — and reaching for
 * a polyfill package to move a few hundred bytes per shot isn't worth it.
 * Ignores whitespace and padding; unknown characters are skipped.
 */
export function base64ToBytes(b64: string): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const ch = b64[i];
    if (ch === '=') break;
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) continue;            // whitespace / newline / stray char
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

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

  /** Detection mode sent in 0xA5 before arming. The device reports the value
   *  back in its "ARMED DetectionMode=NN" text, so the log confirms it took. */
  detectionMode = 0x00;
  /** How far the unit sits BEHIND the ball, mm. Mevo+ is normally set up
   *  around 8 ft (2438 mm). */
  unitDistanceMm = 2438;
  /** Height of the hitting surface above the unit's base, mm (0 = level). */
  surfaceHeightMm = 0;

  constructor(events: MevoEvents) { this.events = events; }

  private setState(s: MevoState, detail?: string) {
    this.state = s;
    this.events.onState(s, detail);
  }
  private log(line: string) {
    this.events.onLog(line);
    // Mirror to the JS console so the line also lands in the Metro terminal.
    // That makes the protocol trace readable on the DEV MACHINE (and teeable
    // to a file) instead of only on the phone screen — the difference between
    // debugging this from a transcript and squinting at a handset.
    console.log(`[mevo] ${line}`);
  }

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
      // RN hands back either a base64 STRING or a Uint8Array depending on
      // platform/version. Node's Buffer does NOT exist in Hermes, so decode
      // base64 ourselves rather than reaching for a polyfill.
      const bytes: number[] = typeof data === 'string'
        ? base64ToBytes(data)
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
      // Uint8Array, NOT Buffer — react-native-tcp-socket accepts it directly
      // and Buffer is a Node global that Hermes doesn't provide.
      this.socket.write(Uint8Array.from(frame));
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
    setTimeout(() => this.configure(), 880);
  }

  /**
   * Post-sync configuration — the step whose absence made the device reject
   * ARM with 0x94 ("unknown"). The unit will not arm until it has been told a
   * detection mode and had that committed; the documented order is:
   *
   *   0xA5 [02 00 MODE]  set detection mode   → AVR echoes 0xA5
   *   0xB0 [01 00]       commit               → 0x95
   *   0xA4 [06 …]        radar calibration    → AVR echoes 0xA4
   *   0xB0 [01 00]       commit               → 0x95
   *
   * only THEN is 0xB0 [01 01] (ARM) accepted.
   */
  private configure() {
    this.log(`configuring: mode=${hex(this.detectionMode)}, unit ${this.unitDistanceMm}mm back, ${this.surfaceHeightMm}mm up`);
    this.send(BUS.AVR, MSG.MODE_SET, [0x02, 0x00, this.detectionMode]);
    setTimeout(() => this.send(BUS.AVR, MSG.CONFIG, [0x01, 0x00]), 150);
    setTimeout(() => {
      // [06 RR RR 00 HH 00 00] — RR RR = distance behind the ball in mm
      // (big-endian), HH = surface height in mm.
      const d = Math.max(0, Math.min(0xffff, Math.round(this.unitDistanceMm)));
      this.send(BUS.AVR, MSG.RADAR_CAL, [
        0x06, (d >> 8) & 0xff, d & 0xff, 0x00,
        Math.max(0, Math.min(0xff, Math.round(this.surfaceHeightMm))), 0x00, 0x00,
      ]);
    }, 300);
    setTimeout(() => this.send(BUS.AVR, MSG.CONFIG, [0x01, 0x00]), 450);
    setTimeout(() => this.arm(), 620);
  }

  /** 0xB0 [01 01] is the ARM trigger; the device confirms with 0x95 then an
   *  unsolicited "ARMED DetectionMode=…" text. Only valid after configure(). */
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

  /**
   * Acknowledge a finished shot. Called on "PROCESSED".
   *
   * IMPORTANT: this does NOT re-arm. The device is still finishing up at
   * PROCESSED (it saves raw samples, drops to System State 5, then emits
   * "IDLE"); arming before that lands is rejected with 0x94 and the session
   * silently stops accepting shots. Re-arming is driven by the IDLE text
   * instead — see onFrame.
   */
  private ackShot() {
    this.send(BUS.AVR, MSG.SHOT_DATA_ACK);
    this.send(BUS.AVR, MSG.SHOT_DATA_ACK);
  }

  /** Re-arm for the next shot. Only safe once the device reports IDLE. */
  private reArm() {
    this.log('device idle — re-arming');
    this.send(BUS.AVR, MSG.CONFIG_QUERY);
    setTimeout(() => this.send(BUS.AVR, MSG.CONFIG, [0x01, 0x01]), 120);
    // The device confirms with an "ARMED …" text, which flips us to ready.
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      if (this.state !== 'ready') {
        this.log('re-arm not confirmed after 4s');
        this.setState('error', 'Device did not re-arm for the next shot.');
      }
    }, 4000);
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

        // The device narrates its own solution before sending the binary
        // result: "Distance Model Success: Vb = 29.2, LA = 30.4, Spin = 6381".
        // That's a genuine fallback — on short/indoor shots the 0xD4 record
        // comes back zeroed (ERROR_MODEL_TOO_LITTLE_TIME) and this text is the
        // only place the launch conditions survive. Only fills gaps; the
        // binary records win when they carry real values.
        const m = text.match(/Vb\s*=\s*([\d.]+).*?LA\s*=\s*(-?[\d.]+).*?Spin\s*=\s*([\d.]+)/i);
        if (m) {
          const vbMs = parseFloat(m[1]);
          const la = parseFloat(m[2]);
          const spin = parseFloat(m[3]);
          if (Number.isFinite(vbMs) && vbMs > 0) {
            const prev = this.pending ?? {};
            this.pending = {
              ...prev,
              ballSpeedMph: prev.ballSpeedMph || vbMs * 2.2369363,
              launchAngleDeg: prev.launchAngleDeg ?? la,
              spinRpm: prev.spinRpm || spin,
            };
            this.log(`← ${from} text solution: ${(vbMs * 2.2369363).toFixed(1)} mph, LA ${la}°, spin ${spin}`);
            this.scheduleEmit();
          }
        }
        // Horizontal launch shows up separately on the trigger line.
        const h = text.match(/HLA\s*=\s*(-?[\d.]+)/i);
        if (h) {
          const hla = parseFloat(h[1]);
          if (Number.isFinite(hla)) {
            this.pending = { ...(this.pending ?? {}), azimuthDeg: this.pending?.azimuthDeg ?? hla };
          }
        }

        // PROCESSED = results done, but the device is still writing samples.
        // Ack now; wait for IDLE before re-arming or it rejects with 0x94.
        if (/PROCESSED/i.test(text)) { this.flushShot(); this.ackShot(); }
        if (/\bIDLE\b/i.test(text)) this.reArm();
        return;
      }
      case MSG.NAK: {
        // The device refused the command. Historically this was the silent
        // killer: ARM sent before configuration returned 0x94 and we just sat
        // in 'arming' until the unit dropped the socket.
        this.log(`← ${from} REJECTED (0x94) — device refused the last command`);
        if (this.state === 'arming') {
          this.setState('error', 'Device refused ARM. it needs configuring first (see log).');
        }
        return;
      }
      case MSG.CONFIG_ACK: {
        this.log(`← ${from} ack${f.payload.length ? ` [${f.payload.map(hex).join(' ')}]` : ''}`);
        return;
      }
      case MSG.MODE_SET: {
        this.log(`← ${from} mode accepted [${f.payload.map(hex).join(' ')}]`);
        return;
      }
      case MSG.RADAR_CAL: {
        this.log(`← ${from} radar cal accepted`);
        return;
      }
      case MSG.FLIGHT_RESULT: {
        const d = decodeFlightResult(f.payload);
        if (!d) {
          this.log(`← ${from} FLIGHT_RESULT (${f.payload.length}B) — too short to decode`);
          return;
        }
        // A ZEROED record is real and expected: when the device logs
        // "Distance Model Error … TOO_LITTLE_TIME" (short or indoor shots) it
        // still sends 0xD4, full of zeros. Merging that would wipe the good
        // preliminary reading from 0xE8, so treat it as no-data.
        if (!d.ballSpeedMph || d.ballSpeedMph < 1) {
          this.log(`← ${from} FLIGHT_RESULT empty (device reported no solution) — keeping earlier values`);
          this.scheduleEmit();
          return;
        }
        this.pending = { ...(this.pending ?? {}), ...d };
        this.log(`← ${from} FLIGHT_RESULT ball ${d.ballSpeedMph?.toFixed(1)} mph, launch ${d.launchAngleDeg?.toFixed(1)}°`);
        this.scheduleEmit();
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
