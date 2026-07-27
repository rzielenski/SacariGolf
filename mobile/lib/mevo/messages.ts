/**
 * Mevo+ message catalogue and shot decoders.
 *
 * Only the messages Range Live actually needs are decoded. The device emits
 * ~43 types per session (tracking bursts, polynomials, camera frames); we care
 * about launch conditions and spin, because our own ball-flight model takes it
 * from there.
 *
 * Field offsets are relative to the PAYLOAD (the bytes after DEST/SRC/TYPE),
 * matching the ironsight wire documentation.
 */
import { int16, int24 } from './frame';

export const MSG = {
  // ── device → app: shot results ──
  FLIGHT_RESULT: 0xd4,       // 158B — authoritative ball speed + launch angles
  FLIGHT_RESULT_V1: 0xe8,    // 94B  — early/preliminary launch data
  CLUB_RESULT: 0xed,         // club head metrics
  SPIN_RESULT: 0xef,         // 138B — authoritative total spin + spin axis
  SHOT_TEXT: 0xe5,           // ASCII state ("BALL TRIGGER", "PROCESSED", "IDLE")
  STATUS_TEXT: 0xe3,         // ASCII logs ("ARMED DetectionMode=…")
  TRACKING_STATUS: 0xe9,
  PRC_DATA: 0xec,

  // ── app → device ──
  STATUS: 0xaa,              // status poll / keepalive
  CONFIG: 0xb0,              // [01 00] commit, [01 01] ARM
  MODE_SET: 0xa5,            // [02 00 XX] detection mode
  CONFIG_QUERY: 0x21,
  HW_QUERY: 0x48,            // → 0xC8 (0x80 = Mevo+, 0xC0 = Gen2)
  INFO_REQ: 0x67,            // → 0xE7 ASCII identity
  PARAM_READ: 0xbe,
  SHOT_DATA_ACK: 0x69,
  SHOT_RESULT_REQ: 0x6d,
  RADAR_CAL: 0xa4,           // [06 RRRR 00 HH 00 00] unit distance + height

  // ── device → app: acks ──
  CONFIG_ACK: 0x95,
  /** Device rejected the command — "unknown"/not-ready. Seen when ARM is sent
   *  before the unit has been configured (mode set + committed). */
  NAK: 0x94,
  HW_RESP: 0xc8,
  INFO_RESP: 0xe7,
  CONFIG_RESP: 0xa0,
} as const;

/** Launch conditions as the device measured them (already in our units). */
export interface MevoShot {
  ballSpeedMph: number;
  launchAngleDeg: number;   // vertical
  azimuthDeg: number;       // + = right of target
  spinRpm: number;
  spinAxisDeg: number;      // + = curves right
  /** True once SPIN_RESULT has landed; before that spin is from FLIGHT_RESULT. */
  spinFinal: boolean;
}

const MS_TO_MPH = 2.2369363;

/**
 * 0xD4 FLIGHT_RESULT (158B) — the authoritative launch record.
 *   [16-18] INT24 /1000  LaunchSpeed (m/s)
 *   [19-21] INT24 /1000  LaunchAzimuth (deg)   — wire is NEGATIVE for right
 *   [22-24] INT24 /1000  LaunchElevation (deg)
 *   [43-45] INT24        BackspinRPM
 *   [46-48] INT24        SidespinRPM
 */
export function decodeFlightResult(p: number[]): Partial<MevoShot> | null {
  if (p.length < 49) return null;
  const speedMs = int24(p, 16) / 1000;
  const azimuthWire = int24(p, 19) / 1000;
  const elevation = int24(p, 22) / 1000;
  const back = int24(p, 43);
  const side = int24(p, 46);
  const spin = Math.hypot(back, side);
  // Wire azimuth is negative-for-right; Sacari uses positive-for-right
  // everywhere (see lib/ballFlight.ts), so flip it here at the boundary.
  return {
    ballSpeedMph: speedMs * MS_TO_MPH,
    launchAngleDeg: elevation,
    azimuthDeg: -azimuthWire,
    spinRpm: spin,
    spinAxisDeg: spin > 0 ? (Math.atan2(side, Math.max(1, back)) * 180) / Math.PI : 0,
    spinFinal: false,
  };
}

/**
 * 0xE8 FLIGHT_RESULT_V1 (94B) — arrives earlier than 0xD4, same idea.
 *   [7-9]   INT24 /1000  BallVelocity (m/s)
 *   [22-24] INT24 /1000  Elevation (deg)
 *   [25-27] INT24 /1000  Azimuth (deg)
 *   [34-36] INT24        Backspin
 *   [37-39] INT24        Sidespin
 */
export function decodeFlightResultV1(p: number[]): Partial<MevoShot> | null {
  if (p.length < 40) return null;
  const speedMs = int24(p, 7) / 1000;
  if (!(speedMs > 0)) return null;
  const back = int24(p, 34);
  const side = int24(p, 37);
  const spin = Math.hypot(back, side);
  return {
    ballSpeedMph: speedMs * MS_TO_MPH,
    launchAngleDeg: int24(p, 22) / 1000,
    azimuthDeg: -(int24(p, 25) / 1000),
    spinRpm: spin,
    spinAxisDeg: spin > 0 ? (Math.atan2(side, Math.max(1, back)) * 180) / Math.PI : 0,
    spinFinal: false,
  };
}

/**
 * 0xEF SPIN_RESULT (138B) — the authoritative spin numbers.
 *   [108-109] INT16       PMSpinFinal (RPM)
 *   [132-133] INT16 /10   SpinAxis (deg), sign negated vs. display
 */
export function decodeSpinResult(p: number[]): { spinRpm: number; spinAxisDeg: number } | null {
  if (p.length < 134) return null;
  const spin = int16(p, 108);
  if (!(spin > 0)) return null;
  return { spinRpm: spin, spinAxisDeg: -(int16(p, 132) / 10) };
}

/** ASCII body of a text message (0xE5 / 0xE3), trimmed. */
export function decodeText(p: number[]): string {
  return p
    .filter((b) => b >= 0x20 && b < 0x7f)
    .map((b) => String.fromCharCode(b))
    .join('')
    .trim();
}
