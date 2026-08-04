/**
 * Uneven lies — what the ground under the ball does to the shot LEAVING it.
 *
 * lib/ballFlight.ts owns the flight and everything after the ball lands. This
 * module owns the other end: the ball is sitting on a slope, in rough, on
 * hardpan, and the shot that comes off it is not the shot you would hit from a
 * flat fairway.
 *
 * WHY THIS EXISTS IN A SIMULATOR. The player is standing on a flat mat and the
 * launch monitor measures a flat-lie strike. To play a real course indoors,
 * that measurement has to be transformed into what the same swing would have
 * produced from the lie the ball actually found. Every commercial simulator
 * does this; the point here is to do it from geometry wherever geometry is
 * enough, and to be explicit about the places it is not.
 *
 * WHAT IS GEOMETRY (trustworthy):
 *   • Up/downhill changes the launch angle by the slope angle, because you
 *     stand perpendicular to the slope and swing along it.
 *   • Spin is barely affected by up/downhill. This surprises people, so:
 *     spin is driven by SPIN LOFT (dynamic loft − attack angle). Standing
 *     perpendicular to the slope shifts dynamic loft and attack angle by the
 *     SAME angle, so their difference — and therefore spin — is preserved.
 *     Only the launch direction rotates.
 *   • A sidehill lie tilts the club's effective lie angle, and a lie-angle
 *     error of β points the face off-line by asin(sin β · sin loft). More
 *     loft means more face deviation, which is why a wedge off a sidehill
 *     misses further off-line than a long iron does.
 *
 * WHAT IS ESTIMATED (the knobs to argue with):
 *   • The small ball-speed penalty for swinging off a slope.
 *   • How much the spin axis tilts with a sidehill lie.
 *   • Every surface multiplier in LIE_SURFACES.
 * These are labelled below and grouped into LIE_TUNING so they can be moved in
 * one place.
 */
import { LaunchConditions } from './ballFlight';

export type LieSurface =
  | 'tee' | 'fairway' | 'light_rough' | 'heavy_rough'
  | 'sand' | 'hardpan' | 'pine_straw';

export interface LieSurfaceProps {
  /** Multiplier on ball speed. */
  speed: number;
  /** Multiplier on spin. Below 1 is a flyer: grass gets between face and ball,
   *  friction drops, and the shot comes out hot and knuckling. */
  spin: number;
  /** Added to launch angle, degrees. Rough tends to launch the ball higher. */
  launch: number;
  label: string;
  /** Shown to the player so the number on screen is explainable. */
  note: string;
}

/**
 * ESTIMATES, not measurements. Ordered the way every golfer already knows:
 * a tee is perfect, rough costs speed and spin, sand costs a lot of speed,
 * hardpan strikes clean and spinny. Revisit these first if a lie feels wrong.
 */
export const LIE_SURFACES: Record<LieSurface, LieSurfaceProps> = {
  tee:         { speed: 1.00, spin: 1.00, launch: 0.0, label: 'Tee',         note: 'Clean strike.' },
  fairway:     { speed: 1.00, spin: 1.00, launch: 0.0, label: 'Fairway',     note: 'Clean strike.' },
  light_rough: { speed: 0.97, spin: 0.80, launch: 1.5, label: 'Light rough', note: 'Flyer risk: less spin, comes out hot.' },
  heavy_rough: { speed: 0.82, spin: 0.62, launch: 3.0, label: 'Heavy rough', note: 'Grass kills speed and spin.' },
  sand:        { speed: 0.76, spin: 1.10, launch: 2.0, label: 'Sand',        note: 'Fairway bunker: big speed loss.' },
  hardpan:     { speed: 0.99, spin: 1.12, launch: -1.0, label: 'Hardpan',    note: 'Clean and low, with extra spin.' },
  pine_straw:  { speed: 0.94, spin: 0.82, launch: 1.0, label: 'Pine straw',  note: 'Loose lie: some speed and spin lost.' },
};

/** The estimated coefficients, in one place. */
export const LIE_TUNING = {
  /**
   * Ball-speed lost per degree of slope, either direction. Standing on a
   * slope costs a little clubhead speed and centredness. 0.6%/deg puts a
   * 5° lie at ~3%, which is the right order and no more than that.
   */
  SPEED_LOSS_PER_DEG: 0.006,
  /**
   * How much of a sidehill slope shows up as spin-axis tilt. The ball leaves
   * closer to perpendicular to the ground it sat on, so the axis tilts with
   * the hill and the shot curves that way. 0.7 of the slope angle.
   */
  AXIS_FROM_CROSS_SLOPE: 0.7,
  /**
   * Launch angle is a proxy for dynamic loft when computing the face-tilt
   * geometry, since a launch monitor never reports loft. Irons launch at
   * roughly 0.8 of their dynamic loft.
   */
  LAUNCH_TO_LOFT: 1 / 0.8,
};

export interface Lie {
  surface: LieSurface;
  /** Slope along the shot line, degrees.
   *  positive = UPHILL (the ground rises toward the target). */
  upslopeDeg: number;
  /** Sidehill slope, degrees.
   *  positive = ball ABOVE the feet, negative = ball BELOW the feet. */
  crossSlopeDeg: number;
  /** Sidehill effects mirror for a left-handed player. */
  leftHanded?: boolean;
}

export interface LieAdjustment {
  /** Launch conditions as they would leave this lie. */
  conditions: LaunchConditions;
  /** Plain-language reasons, for showing under the shot. */
  notes: string[];
  /** How far left (negative) or right (positive) the ball will start and
   *  curve compared with the same swing off a flat tee, degrees. */
  aimShiftDeg: number;
}

export const FLAT_LIE: Lie = { surface: 'fairway', upslopeDeg: 0, crossSlopeDeg: 0 };

/** True when this lie does anything at all — lets callers skip the note UI. */
export function isFlatLie(lie: Lie): boolean {
  return lie.surface === 'fairway' || lie.surface === 'tee'
    ? Math.abs(lie.upslopeDeg) < 0.5 && Math.abs(lie.crossSlopeDeg) < 0.5
    : false;
}

/**
 * Transform a flat-lie strike into the shot that lie would actually produce.
 *
 * Order matters: surface first (it changes the raw energy of the strike), then
 * slope geometry (which rotates where that energy goes).
 */
export function applyLie(lc: LaunchConditions, lie: Lie): LieAdjustment {
  const notes: string[] = [];
  const surf = LIE_SURFACES[lie.surface] ?? LIE_SURFACES.fairway;

  // ── 1. Surface ──
  let speed = lc.ballSpeedMph * surf.speed;
  let spin = lc.spinRpm * surf.spin;
  let launch = lc.launchAngleDeg + surf.launch;
  if (surf.speed !== 1 || surf.spin !== 1 || surf.launch !== 0) {
    notes.push(`${surf.label}: ${surf.note}`);
  }

  // ── 2. Up / downhill ──
  // You stand perpendicular to the slope, so the whole swing rotates with it:
  // launch angle moves by the slope angle. Spin is left alone on purpose —
  // dynamic loft and attack angle both shift by the same amount, so spin loft
  // (which is what actually creates spin) does not change.
  const up = lie.upslopeDeg;
  if (Math.abs(up) >= 0.5) {
    launch += up;
    speed *= 1 - LIE_TUNING.SPEED_LOSS_PER_DEG * Math.abs(up);
    notes.push(up > 0
      ? `Uphill ${Math.abs(up).toFixed(0)}°: launches ~${Math.abs(up).toFixed(0)}° higher and lands shorter.`
      : `Downhill ${Math.abs(up).toFixed(0)}°: launches ~${Math.abs(up).toFixed(0)}° lower and runs out.`);
  }

  // ── 3. Sidehill ──
  // A cross slope tilts the club's effective lie angle. A lie-angle error of β
  // points the face off-line by asin(sin β · sin loft) — so the same slope
  // costs a wedge far more direction than a driver.
  let aimShiftDeg = 0;
  let axisShift = 0;
  const cross = lie.crossSlopeDeg;
  if (Math.abs(cross) >= 0.5) {
    const loftDeg = Math.max(5, Math.min(64, Math.abs(launch) * LIE_TUNING.LAUNCH_TO_LOFT));
    const beta = (Math.abs(cross) * Math.PI) / 180;
    const faceDeg =
      (Math.asin(Math.min(1, Math.sin(beta) * Math.sin((loftDeg * Math.PI) / 180))) * 180) / Math.PI;

    // Ball above feet pulls LEFT for a right-hander; mirror for a lefty.
    const dir = (cross > 0 ? -1 : 1) * (lie.leftHanded ? -1 : 1);
    aimShiftDeg = dir * faceDeg;
    axisShift = dir * Math.abs(cross) * LIE_TUNING.AXIS_FROM_CROSS_SLOPE;
    speed *= 1 - LIE_TUNING.SPEED_LOSS_PER_DEG * Math.abs(cross);

    notes.push(cross > 0
      ? `Ball above feet ${Math.abs(cross).toFixed(0)}°: starts left and draws.`
      : `Ball below feet ${Math.abs(cross).toFixed(0)}°: starts right and fades.`);
  }

  return {
    conditions: {
      ballSpeedMph: Math.max(0, speed),
      launchAngleDeg: launch,
      azimuthDeg: lc.azimuthDeg + aimShiftDeg,
      spinRpm: Math.max(0, spin),
      spinAxisDeg: lc.spinAxisDeg + axisShift,
    },
    notes,
    aimShiftDeg,
  };
}

/** One-line summary of a lie, for a status chip. */
export function describeLie(lie: Lie): string {
  const bits: string[] = [LIE_SURFACES[lie.surface]?.label ?? 'Fairway'];
  if (Math.abs(lie.upslopeDeg) >= 0.5) {
    bits.push(`${lie.upslopeDeg > 0 ? 'uphill' : 'downhill'} ${Math.abs(lie.upslopeDeg).toFixed(0)}°`);
  }
  if (Math.abs(lie.crossSlopeDeg) >= 0.5) {
    bits.push(`ball ${lie.crossSlopeDeg > 0 ? 'above' : 'below'} feet ${Math.abs(lie.crossSlopeDeg).toFixed(0)}°`);
  }
  return bits.join(' · ');
}
