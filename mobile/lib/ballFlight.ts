/**
 * Golf ball flight simulation — launch conditions → full 3D trajectory.
 *
 * Used by Range Sesh Live: a launch monitor (Mevo+ etc.) reports what the ball
 * did at impact; this turns that into where it goes, so we can draw the flight
 * and report carry / total / apex / offline ourselves rather than trusting the
 * device's own (hidden, model-dependent) distance numbers.
 *
 * MODEL — the standard one every serious simulator uses:
 *   • Drag      Fd = ½ ρ A Cd |v|² , opposing velocity
 *   • Magnus    Fl = ½ ρ A Cl |v|² , along (ω × v)
 *   • Gravity   mg
 *   • Cd and Cl are functions of the dimensionless SPIN RATIO S = ωr/|v|
 *     (Bearman & Harvey wind-tunnel formulation). Constant coefficients are
 *     what make naive simulators wrong — a wedge (S ≈ 0.30) and a driver
 *     (S ≈ 0.08) live in completely different aerodynamic regimes.
 *   • Spin decays exponentially in flight (τ ≈ 25 s).
 * Integrated with RK4 at a 2 ms step — small enough that halving it moves
 * carry by less than a yard.
 *
 * COORDINATES (right-handed, yards for output, SI internally):
 *   x = downrange, y = RIGHT of target line, z = up.
 * A positive spin axis tilts the lift vector right → the ball curves right
 * (a slice for a right-hander), matching launch-monitor convention.
 *
 * CALIBRATION — coefficients below are tuned so these published PGA Tour
 * averages (Trackman) reproduce within a few yards:
 *   Driver  167 mph ball, 10.9° launch, 2686 rpm  → ~275 yd carry, ~102 ft apex
 *   6-iron  127 mph ball, 14.0° launch, 6231 rpm  → ~183 yd carry
 *   PW       97 mph ball, 24.2° launch, 9304 rpm  → ~136 yd carry
 * Tune AERO if you ever want to match a specific simulator more tightly; the
 * shape of the model is what matters, the constants are the knob.
 */

/** Physical constants (SI). */
const MASS_KG = 0.04593;          // 45.93 g — max legal ball mass
const RADIUS_M = 0.021335;        // 42.67 mm diameter
const AREA_M2 = Math.PI * RADIUS_M * RADIUS_M;
const RHO = 1.225;                // air density at sea level, 15 °C
const G = 9.80665;
const SPIN_DECAY_TAU_S = 25;      // e-folding time of spin in flight

/** Aerodynamic coefficient model. Exported so it can be re-tuned without
 *  touching the integrator. */
export const AERO = {
  /** Lift saturates as spin ratio grows: Cl = A·S / (B + S).
   *  Yields Cl ≈ 0.15 at S = 0.08 (driver) and ≈ 0.28 at S = 0.30 (wedge),
   *  matching Bearman & Harvey's dimpled-sphere wind-tunnel curve. */
  CL_A: 0.415,
  CL_B: 0.144,
  /** Drag: Cd = D0 + D1·S + D2·S². The negative quadratic flattens the curve
   *  at high spin instead of letting it run away linearly. Yields Cd ≈ 0.225
   *  (driver) and ≈ 0.31 (wedge) — again matching the wind-tunnel data. */
  CD_0: 0.188,
  CD_S: 0.487,
  CD_S2: -0.275,
};

/** Spin ratio is clamped before evaluating coefficients. Real golf shots top
 *  out near S ≈ 0.35; beyond that the empirical fits are extrapolation. */
const MAX_SPIN_RATIO = 0.6;

const MPH_TO_MS = 0.44704;
const M_TO_YDS = 1.0936133;
const M_TO_FT = 3.2808399;
const RPM_TO_RADS = (2 * Math.PI) / 60;

export interface LaunchConditions {
  /** Ball speed, mph. */
  ballSpeedMph: number;
  /** Vertical launch angle, degrees above horizontal. */
  launchAngleDeg: number;
  /** Horizontal launch direction, degrees. positive = right of target. */
  azimuthDeg: number;
  /** Total spin, rpm. */
  spinRpm: number;
  /** Spin-axis tilt, degrees. positive = tilted right → ball curves right. */
  spinAxisDeg: number;
}

export interface FlightPoint { x: number; y: number; z: number }   // yards

export interface FlightResult {
  carryYds: number;
  totalYds: number;
  /** Lateral offset where it first lands. positive = right. */
  offlineYds: number;
  apexFt: number;
  descentAngleDeg: number;
  flightTimeS: number;
  /** Downsampled trajectory for rendering (~60 points, yards). */
  path: FlightPoint[];
}

interface State { px: number; py: number; pz: number; vx: number; vy: number; vz: number }

/** Acceleration at a given state, for a spin vector that decays over time. */
function accel(s: State, wx: number, wy: number, wz: number): [number, number, number] {
  const v = Math.hypot(s.vx, s.vy, s.vz);
  if (v < 1e-6) return [0, 0, -G];

  const wMag = Math.hypot(wx, wy, wz);
  const S = Math.min(MAX_SPIN_RATIO, (wMag * RADIUS_M) / v);   // spin ratio
  const Cd = AERO.CD_0 + AERO.CD_S * S + AERO.CD_S2 * S * S;
  const Cl = wMag > 1e-6 ? (AERO.CL_A * S) / (AERO.CL_B + S) : 0;

  const q = 0.5 * RHO * AREA_M2 * v * v;                 // dynamic pressure × area
  // Drag — straight back along the velocity unit vector.
  const dragMag = (q * Cd) / MASS_KG;
  const ax0 = -dragMag * (s.vx / v);
  const ay0 = -dragMag * (s.vy / v);
  const az0 = -dragMag * (s.vz / v);

  // Magnus — along the unit vector of (ω × v).
  let ax1 = 0, ay1 = 0, az1 = 0;
  if (Cl > 0) {
    const cx = wy * s.vz - wz * s.vy;
    const cy = wz * s.vx - wx * s.vz;
    const cz = wx * s.vy - wy * s.vx;
    const cMag = Math.hypot(cx, cy, cz);
    if (cMag > 1e-9) {
      const liftMag = (q * Cl) / MASS_KG;
      ax1 = liftMag * (cx / cMag);
      ay1 = liftMag * (cy / cMag);
      az1 = liftMag * (cz / cMag);
    }
  }
  return [ax0 + ax1, ay0 + ay1, az0 + az1 - G];
}

/**
 * Simulate a shot. Flat ground, still air — a driving range, which is exactly
 * the environment this is for.
 */
export function simulateFlight(lc: LaunchConditions): FlightResult {
  const v0 = Math.max(0, lc.ballSpeedMph) * MPH_TO_MS;
  const vla = (lc.launchAngleDeg * Math.PI) / 180;
  const hla = (lc.azimuthDeg * Math.PI) / 180;

  const s: State = {
    px: 0, py: 0, pz: 0,
    vx: v0 * Math.cos(vla) * Math.cos(hla),
    vy: v0 * Math.cos(vla) * Math.sin(hla),
    vz: v0 * Math.sin(vla),
  };

  // Spin vector. Backspin lifts (ω along −y for travel down +x); a right-tilted
  // axis adds a +z component, which pushes the Magnus force right.
  const wTotal = Math.max(0, lc.spinRpm) * RPM_TO_RADS;
  const axis = (lc.spinAxisDeg * Math.PI) / 180;
  const wBack = wTotal * Math.cos(axis);
  const wSide = wTotal * Math.sin(axis);
  const w0x = 0, w0y = -wBack, w0z = wSide;

  const dt = 0.002;
  const raw: FlightPoint[] = [{ x: 0, y: 0, z: 0 }];
  let t = 0;
  let apexM = 0;
  let prev = { ...s };
  const MAX_STEPS = 15000;   // 30 s — far beyond any real golf shot

  for (let i = 0; i < MAX_STEPS; i++) {
    prev = { ...s };
    const decay = Math.exp(-t / SPIN_DECAY_TAU_S);
    const wx = w0x * decay, wy = w0y * decay, wz = w0z * decay;

    // Classic RK4 over the 6-dim state.
    const k1 = accel(s, wx, wy, wz);
    const s2: State = {
      px: s.px + (s.vx * dt) / 2, py: s.py + (s.vy * dt) / 2, pz: s.pz + (s.vz * dt) / 2,
      vx: s.vx + (k1[0] * dt) / 2, vy: s.vy + (k1[1] * dt) / 2, vz: s.vz + (k1[2] * dt) / 2,
    };
    const k2 = accel(s2, wx, wy, wz);
    const s3: State = {
      px: s.px + (s2.vx * dt) / 2, py: s.py + (s2.vy * dt) / 2, pz: s.pz + (s2.vz * dt) / 2,
      vx: s.vx + (k2[0] * dt) / 2, vy: s.vy + (k2[1] * dt) / 2, vz: s.vz + (k2[2] * dt) / 2,
    };
    const k3 = accel(s3, wx, wy, wz);
    const s4: State = {
      px: s.px + s3.vx * dt, py: s.py + s3.vy * dt, pz: s.pz + s3.vz * dt,
      vx: s.vx + k3[0] * dt, vy: s.vy + k3[1] * dt, vz: s.vz + k3[2] * dt,
    };
    const k4 = accel(s4, wx, wy, wz);

    s.px += ((s.vx + 2 * s2.vx + 2 * s3.vx + s4.vx) * dt) / 6;
    s.py += ((s.vy + 2 * s2.vy + 2 * s3.vy + s4.vy) * dt) / 6;
    s.pz += ((s.vz + 2 * s2.vz + 2 * s3.vz + s4.vz) * dt) / 6;
    s.vx += ((k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) * dt) / 6;
    s.vy += ((k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) * dt) / 6;
    s.vz += ((k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]) * dt) / 6;
    t += dt;

    if (s.pz > apexM) apexM = s.pz;
    raw.push({ x: s.px * M_TO_YDS, y: s.py * M_TO_YDS, z: s.pz * M_TO_YDS });

    if (s.pz <= 0 && s.vz < 0) break;   // landed
  }

  // Interpolate the exact ground crossing between the last two samples so
  // carry isn't quantised to the 2 ms step.
  let landX = s.px, landY = s.py, landT = t;
  if (prev.pz > 0 && s.pz <= 0) {
    const f = prev.pz / (prev.pz - s.pz);
    landX = prev.px + (s.px - prev.px) * f;
    landY = prev.py + (s.py - prev.py) * f;
    landT = t - dt * (1 - f);
    if (raw.length) raw[raw.length - 1] = { x: landX * M_TO_YDS, y: landY * M_TO_YDS, z: 0 };
  }

  const carryYds = Math.max(0, landX * M_TO_YDS);
  const offlineYds = landY * M_TO_YDS;
  const vHoriz = Math.hypot(s.vx, s.vy);
  const descentAngleDeg = vHoriz > 1e-6 ? (Math.atan2(-s.vz, vHoriz) * 180) / Math.PI : 90;

  // Roll-out on a flat, firm range. Shallow descent rolls out; a steep,
  // high-spin wedge checks up almost immediately.
  const spinCheck = 1 - Math.min(0.5, Math.max(0, lc.spinRpm) / 12000);
  const rollFrac = Math.max(0, 0.11 - 0.0022 * descentAngleDeg) * spinCheck;
  const totalYds = carryYds * (1 + rollFrac);

  // Downsample for rendering — ~60 points is plenty for a smooth arc.
  const target = 60;
  const stride = Math.max(1, Math.floor(raw.length / target));
  const path: FlightPoint[] = [];
  for (let i = 0; i < raw.length; i += stride) path.push(raw[i]);
  if (path[path.length - 1] !== raw[raw.length - 1]) path.push(raw[raw.length - 1]);

  return {
    carryYds: Math.round(carryYds * 10) / 10,
    totalYds: Math.round(totalYds * 10) / 10,
    offlineYds: Math.round(offlineYds * 10) / 10,
    apexFt: Math.round(apexM * M_TO_FT),
    descentAngleDeg: Math.round(descentAngleDeg * 10) / 10,
    flightTimeS: Math.round(landT * 100) / 100,
    path,
  };
}
