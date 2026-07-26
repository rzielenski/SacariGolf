/**
 * FlightScope Mevo+ wire codec — framing, byte stuffing, checksum, field types.
 *
 * Frame layout:
 *
 *   0xF0 [ stuffed( DEST SRC TYPE PAYLOAD… ) ][ stuffed( CS_HI CS_LO ) ] 0xF1
 *
 * The checksum is a 16-bit sum of the **stuffed** bytes from DEST through the
 * last payload byte — i.e. it's computed over what actually goes on the wire,
 * not over the logical bytes. That's the single easiest thing to get wrong
 * here, so encode() and verify() both do it the same way on purpose.
 *
 * All multi-byte fields are big-endian.
 *
 * Protocol derived from the ironsight project's public documentation
 * (github.com/divotmaker/ironsight), which reverse-engineered it from the
 * device's own open WiFi broadcast for interoperability.
 */

export const FRAME_START = 0xf0;
export const FRAME_END = 0xf1;
const ESC = 0xfd;

/** Bus addresses. */
export const BUS = {
  APP: 0x10,
  PI: 0x12,
  AVR: 0x30,
  DSP: 0x40,
} as const;

/** Bytes that must be escaped inside a frame, and what they become. */
const STUFF_MAP: Record<number, number> = {
  0xf0: 0x01,
  0xf1: 0x02,
  0xfd: 0x03,
  0xfa: 0x04,
};
const UNSTUFF_MAP: Record<number, number> = {
  0x01: 0xf0,
  0x02: 0xf1,
  0x03: 0xfd,
  0x04: 0xfa,
};

export function stuff(bytes: number[]): number[] {
  const out: number[] = [];
  for (const b of bytes) {
    const esc = STUFF_MAP[b];
    if (esc !== undefined) { out.push(ESC, esc); } else { out.push(b); }
  }
  return out;
}

export function unstuff(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === ESC) {
      const next = bytes[++i];
      const real = UNSTUFF_MAP[next];
      // An unknown escape is corruption; emit the raw byte rather than throw so
      // one bad frame can't kill the session.
      out.push(real !== undefined ? real : next);
    } else {
      out.push(bytes[i]);
    }
  }
  return out;
}

const sum16 = (bytes: number[]): number =>
  bytes.reduce((a, b) => (a + b) & 0xffff, 0);

/** Build a complete on-the-wire frame. */
export function encodeFrame(dest: number, src: number, type: number, payload: number[] = []): Uint8Array {
  const interior = [dest, src, type, ...payload];
  const stuffed = stuff(interior);
  const cs = sum16(stuffed);
  const stuffedCs = stuff([(cs >> 8) & 0xff, cs & 0xff]);
  return Uint8Array.from([FRAME_START, ...stuffed, ...stuffedCs, FRAME_END]);
}

export interface DecodedFrame {
  dest: number;
  src: number;
  type: number;
  payload: number[];
  checksumOk: boolean;
}

/** Decode one frame's interior (the bytes BETWEEN 0xF0 and 0xF1). */
export function decodeFrameInterior(stuffedInterior: number[]): DecodedFrame | null {
  const flat = unstuff(stuffedInterior);
  // dest + src + type + 2 checksum bytes = 5 minimum
  if (flat.length < 5) return null;
  const cs = ((flat[flat.length - 2] << 8) | flat[flat.length - 1]) & 0xffff;
  const body = flat.slice(0, flat.length - 2);
  // Re-stuff the body to reproduce exactly what was summed on the sending side.
  const checksumOk = sum16(stuff(body)) === cs;
  return {
    dest: body[0],
    src: body[1],
    type: body[2],
    payload: body.slice(3),
    checksumOk,
  };
}

/**
 * Incremental frame reader. TCP gives us an arbitrarily chopped stream, so
 * bytes are buffered until a complete 0xF0…0xF1 frame is present. Anything
 * before a start byte is discarded as line noise.
 */
export class FrameReader {
  private buf: number[] = [];

  push(chunk: Uint8Array | number[]): DecodedFrame[] {
    for (const b of chunk) this.buf.push(b);
    const frames: DecodedFrame[] = [];

    for (;;) {
      const start = this.buf.indexOf(FRAME_START);
      if (start < 0) { this.buf.length = 0; break; }        // nothing usable
      if (start > 0) this.buf.splice(0, start);             // drop leading junk

      // Find the terminator, skipping any 0xF1 that is escaped.
      let end = -1;
      for (let i = 1; i < this.buf.length; i++) {
        if (this.buf[i] === ESC) { i++; continue; }         // escaped pair
        if (this.buf[i] === FRAME_END) { end = i; break; }
      }
      if (end < 0) break;                                   // frame incomplete

      const interior = this.buf.slice(1, end);
      this.buf.splice(0, end + 1);
      const f = decodeFrameInterior(interior);
      if (f) frames.push(f);
    }
    return frames;
  }

  reset() { this.buf.length = 0; }
}

// ── Field decoders ───────────────────────────────────────────────────────────

export function int16(b: number[], o: number): number {
  const v = ((b[o] << 8) | b[o + 1]) >>> 0;
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function int24(b: number[], o: number): number {
  const v = ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
  return v >= 0x800000 ? v - 0x1000000 : v;
}

export function int32(b: number[], o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0;
}

/**
 * FLOAT40 — 5 bytes: [exp_hi, exp_lo, mant_hi, mant_mid, mant_lo].
 *   value = mantissa × 2^(exponent − 23)
 * 23-bit mantissa (same precision as a float32 significand) with a much wider
 * 16-bit signed exponent. Zero is five zero bytes.
 */
export function float40(b: number[], o: number): number {
  let exp = ((b[o] << 8) | b[o + 1]) >>> 0;
  if (exp >= 0x8000) exp -= 0x10000;
  let mant = ((b[o + 2] << 16) | (b[o + 3] << 8) | b[o + 4]) >>> 0;
  if (mant >= 0x800000) mant -= 0x1000000;
  return mant * Math.pow(2, exp - 23);
}
