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
  /**
   * Lateral-only multiplier on the Magnus force. Carry/apex/descent are
   * calibrated hard against Trackman's published table, so this exists to
   * tune CURVE without touching any of that.
   *
   * Published guidance is inconsistent here (one widely-cited figure puts
   * 1,500 rpm of sidespin at 20-30 yds of curve, which is far less than the
   * raw physics produces), so this is deliberately a single honest knob:
   * compare the app's offline number against what the launch monitor reports
   * on a fade or slice and adjust. 1.0 = pure physics.
   */
  SIDE_SCALE: 0.55,
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

/* ─────────────────────────── Ground interaction ───────────────────────────
 * What happens after the ball lands is not a fudge factor. A wedge that
 * checks up, a driver that chases 25 yards down a slope, and a ball that
 * kicks sideways off a downslope are all the same rigid-body impulse plus a
 * friction phase — so that's what this models, rather than a roll fraction.
 */

export type Surface =
  | 'green' | 'fairway' | 'rough' | 'heavy_rough'
  | 'sand' | 'hardpan' | 'path' | 'native';

export interface SurfaceProps {
  /** LOW-SPEED coefficient of restitution. The actual COR used falls steeply
   *  with impact speed (see corAt) — a constant COR is the single biggest
   *  reason naive run-out models send a driver 100 yards down the fairway. */
  e0: number;
  /** Coulomb friction between ball and surface. Governs how much backspin is
   *  converted into a backward kick, and how quickly a slide becomes a roll. */
  mu: number;
  /** Rolling resistance, as a fraction of normal force. */
  crr: number;
  /**
   * PLOWING coefficient: how hard the wall of the ball's own pitch mark
   * resists its forward motion, as a multiple of the normal impulse. See
   * plowFactor. Zero for a surface that does not yield, like a cart path.
   */
  plow: number;
  label: string;
}

/**
 * Plowing — the ball pushing through the front wall of its own pitch mark.
 *
 * This is the term that makes run-out come out right, and it is separate from
 * friction on purpose. Coulomb friction acts at the CONTACT PATCH and stops
 * the moment the patch stops slipping, which under backspin is almost
 * immediately; after that, no amount of extra friction removes any more
 * forward speed. That is why a plain rigid-plane impact model sends a Tour
 * drive rolling 60+ yards, and why raising mu does nothing to fix it (the fit
 * is provably identical at mu = 0.3, 0.4 and 0.5).
 *
 * A ball landing hard does not strike a rigid plane. It craters, and the
 * material ahead of it pushes back on the BODY of the ball for as long as it
 * is submerged — no grip condition, no slip requirement. Modelled here as an
 * extra tangential impulse proportional to the normal impulse, opposing the
 * ball's centre-of-mass motion, and applied through the centre (it acts over
 * the whole buried surface, so it exerts little net torque).
 *
 * Scales with how hard the ball arrives: a gentle bounce barely marks turf.
 */
const PLOW_REF_MS = 18;
function plowFactor(plow: number, vn: number): number {
  return plow * Math.min(1, Math.abs(vn) / PLOW_REF_MS);
}

/**
 * Rolling resistance grows with speed on grass.
 *
 * A single constant cannot describe both ends of what a golf ball does on the
 * ground. A putt trickling at 1 m/s on a green must run 10 ft per the
 * stimpmeter (crr ≈ 0.06); a ball skipping across a fairway at 10 m/s is
 * half-airborne between blades and sheds energy far faster than that same
 * constant predicts. Grass is not a rigid roller bearing: faster contact
 * deflects more of it, and micro-hops dissipate on every reattachment.
 *
 * Linear growth with speed captures it with one shared constant, and leaves
 * each surface's base crr meaning what it should — the slow-roll value, which
 * for a green is directly measurable with a stimpmeter.
 */
const CRR_SPEED_K = 0.30;      // per m/s
function crrAt(crr: number, speed: number): number {
  return crr * (1 + CRR_SPEED_K * speed);
}

/**
 * Restitution as a function of normal approach speed.
 *
 * Turf is not a trampoline. A ball arriving steeply and fast digs in, throws
 * a divot and leaves most of its vertical energy in the ground; the same ball
 * dropped gently bounces properly. Penner (2002, "The run of a golf ball")
 * measured this and fitted
 *      e = 0.510 − 0.0375·vn + 0.000903·vn²      (vn in m/s)
 * which is ~0.51 at walking pace and ~0.12 at the 18 m/s a driver arrives
 * with. That curve is used here, normalised to 1 at vn = 0 and scaled by each
 * surface's own low-speed COR, so one published relation drives every surface.
 *
 * The fit turns back upwards past its minimum near 21 m/s, which is
 * extrapolation rather than physics, so vn is clamped there.
 */
function corAt(e0: number, vn: number): number {
  const v = Math.min(Math.abs(vn), 20.8);
  const shape = (0.510 - 0.0375 * v + 0.000903 * v * v) / 0.510;
  return Math.max(0.02, Math.min(0.92, e0 * shape));
}

/**
 * Surface parameters.
 *
 * HONESTY NOTE: `fairway` is calibrated — e0 comes straight from Penner's
 * published turf fit, and mu/crr were solved so the 11-club Trackman table
 * reproduces its published carry AND total. The others are set relative to it
 * using the ordering every golfer knows (a green holds, rough grabs, sand
 * kills the ball, a cart path launches it). Those are estimates, not
 * measurements, and are the first thing to revisit if a surface feels wrong.
 */
export const SURFACES: Record<Surface, SurfaceProps> = {
  // A green marks deeply (that is why it holds an approach) but is mown and
  // rolled, so once the ball is rolling it barely slows: crr here is derived
  // from a stimpmeter, where a ball leaving at 1.83 m/s runs 10 ft.
  // A green is the most RECEPTIVE surface (watered and soft, so it takes a
  // deep pitch mark — that is why it holds an approach) and simultaneously
  // the FASTEST once the ball is rolling. Those are two different terms, and
  // splitting them is what lets one model hold a wedge and still roll a putt:
  // crr here is derived from a stimpmeter, where a ball released at 1.83 m/s
  // must run 10 ft.
  green:       { e0: 0.44, mu: 0.42, crr: 0.045, plow: 0.52, label: 'Green' },
  fairway:     { e0: 0.51, mu: 0.40, crr: 0.150, plow: 0.39, label: 'Fairway' },
  rough:       { e0: 0.32, mu: 0.60, crr: 0.350, plow: 0.60, label: 'Rough' },
  heavy_rough: { e0: 0.22, mu: 0.75, crr: 0.600, plow: 0.80, label: 'Heavy rough' },
  sand:        { e0: 0.12, mu: 0.55, crr: 0.900, plow: 0.98, label: 'Sand' },
  hardpan:     { e0: 0.65, mu: 0.35, crr: 0.060, plow: 0.08, label: 'Hardpan' },
  path:        { e0: 0.62, mu: 0.25, crr: 0.020, plow: 0.00, label: 'Cart path' },
  native:      { e0: 0.24, mu: 0.75, crr: 0.650, plow: 0.75, label: 'Native area' },
};

/**
 * What a surface would read on a stimpmeter, in feet.
 *
 * A stimpmeter releases a ball onto level turf at a known 1.83 m/s and you
 * measure how far it runs; a typical green reads 9-11 ft, a fast tournament
 * green 12+. This is an INDEPENDENT check on the rolling model — nothing in
 * the Trackman calibration touches it — and it is the only number here a
 * greenkeeper could verify with equipment they already own.
 */
export function stimpFeet(surface: Surface = 'green'): number {
  const props = SURFACES[surface];
  let v = 1.83;                       // m/s, the stimpmeter release speed
  let d = 0;
  const dt = 0.001;
  for (let i = 0; i < 200000 && v > 1e-4; i++) {
    v -= crrAt(props.crr, v) * G * dt;
    if (v <= 0) break;
    d += v * dt;
  }
  return d * 3.2808399;
}

export interface GroundOptions {
  /** What the ball lands on. Defaults to fairway. */
  surface?: Surface;
  /** Slope of the landing area along the shot line, degrees.
   *  positive = ground RISES away from the player (an upslope to land into). */
  upslopeDeg?: number;
  /** Cross slope of the landing area, degrees.
   *  positive = ground falls away to the RIGHT. */
  crossSlopeDeg?: number;
}

export interface Bounce {
  /** Where the ball struck, yards. */
  x: number; y: number;
  /** Speed into the impact, mph — useful for debugging a surface's feel. */
  inSpeedMph: number;
}

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

  // ── ground phase ──
  /** Ground distance travelled after the first bounce, yards. Negative when a
   *  high-spin shot finishes behind where it pitched. */
  rollYds: number;
  /** Lateral offset where the ball finally comes to rest. positive = right. */
  finishOfflineYds: number;
  /** Each impact with the ground, in order. */
  bounces: Bounce[];
  /** Bounce + roll path for rendering, yards. Starts at the pitch mark. */
  groundPath: FlightPoint[];
  /** True when the ball was still moving when the run-out simulation gave up
   *  (a steep slope it will not stop on). */
  stillRolling: boolean;
}

interface State { px: number; py: number; pz: number; vx: number; vy: number; vz: number }

/** Acceleration at a given state, for a spin vector that decays over time. */
function accel(s: State, wx: number, wy: number, wz: number): [number, number, number] {
  const v = Math.hypot(s.vx, s.vy, s.vz);
  if (v < 1e-6) return [0, 0, -G];

  // ω × v. Its magnitude carries the only spin that matters aerodynamically.
  const cx = wy * s.vz - wz * s.vy;
  const cy = wz * s.vx - wx * s.vz;
  const cz = wx * s.vy - wy * s.vx;
  const cMag = Math.hypot(cx, cy, cz);

  // Spin ratio from the PERPENDICULAR spin component, not raw |ω|. Spin about
  // the flight axis ("rifle spin") generates no Magnus force, and a tilted
  // axis puts progressively more of the ball's spin there — especially as the
  // shot steepens into its descent. Using |ω| overstates both lift and curve
  // on any shot that isn't pure backspin.
  const wPerp = cMag / v;                                      // rad/s
  const S = Math.min(MAX_SPIN_RATIO, (wPerp * RADIUS_M) / v);  // spin ratio
  const Cd = AERO.CD_0 + AERO.CD_S * S + AERO.CD_S2 * S * S;
  const Cl = wPerp > 1e-6 ? (AERO.CL_A * S) / (AERO.CL_B + S) : 0;

  const q = 0.5 * RHO * AREA_M2 * v * v;                 // dynamic pressure × area
  // Drag — straight back along the velocity unit vector.
  const dragMag = (q * Cd) / MASS_KG;
  const ax0 = -dragMag * (s.vx / v);
  const ay0 = -dragMag * (s.vy / v);
  const az0 = -dragMag * (s.vz / v);

  // Magnus — along the unit vector of (ω × v). The sideways component is
  // additionally scaled by AERO.SIDE_SCALE so curvature can be calibrated
  // against real launch-monitor data without disturbing carry or apex.
  let ax1 = 0, ay1 = 0, az1 = 0;
  if (Cl > 0 && cMag > 1e-9) {
    const liftMag = (q * Cl) / MASS_KG;
    ax1 = liftMag * (cx / cMag);
    ay1 = liftMag * (cy / cMag) * AERO.SIDE_SCALE;
    az1 = liftMag * (cz / cMag);
  }
  return [ax0 + ax1, ay0 + ay1, az0 + az1 - G];
}

/* ── small vector helpers, kept local so the module stays dependency-free ── */
type V3 = [number, number, number];
const vAdd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const vDot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vLen = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const vCross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Unit normal of the landing plane. */
function planeNormal(upslopeDeg: number, crossSlopeDeg: number): V3 {
  // Surface height z = a·x + b·y. Rising downrange => a > 0; falling to the
  // right => b < 0. The normal of z = ax + by is (−a, −b, 1).
  const a = Math.tan((upslopeDeg * Math.PI) / 180);
  const b = -Math.tan((crossSlopeDeg * Math.PI) / 180);
  const n: V3 = [-a, -b, 1];
  return vScale(n, 1 / vLen(n));
}

/**
 * One ball-ground impact, as a rigid-body impulse.
 *
 * Splits the approach velocity about the surface normal. The normal part is
 * scaled by the restitution; the tangential part is fought by Coulomb friction
 * acting at the CONTACT POINT, whose velocity includes the spin (u = v + ω×r).
 * That single detail is what makes backspin behave: a wedge arrives with the
 * bottom of the ball racing forwards, friction fires backwards, and the ball
 * kicks back and stands up. Nothing here is special-cased for spin.
 *
 * Friction is capped two ways: it can never exceed μ·Jn (sliding), and never
 * exceed what is needed to bring the contact point to rest (gripping), which
 * for a uniform sphere is (2/7)·m·|u_t|.
 */
function bounceImpulse(v: V3, w: V3, n: V3, props: SurfaceProps): { v: V3; w: V3 } {
  const vn = vDot(v, n);
  if (vn >= 0) return { v, w };                    // already leaving the surface

  const e = corAt(props.e0, vn);
  const Jn = -(1 + e) * MASS_KG * vn;              // normal impulse, > 0
  const I = 0.4 * MASS_KG * RADIUS_M * RADIUS_M;   // solid sphere

  // ── Coulomb friction at the contact patch ──
  // Acts on the contact point, so it both slows the ball and swaps spin for
  // speed. Capped by sliding (mu·Jn) and by grip ((2/7)m|u_t|, the impulse
  // that brings the patch exactly to rest).
  const r = vScale(n, -RADIUS_M);                  // centre → contact point
  const u = vAdd(v, vCross(w, r));                 // contact-point velocity
  const ut = vSub(u, vScale(n, vDot(u, n)));
  const utMag = vLen(ut);
  let Jt: V3 = [0, 0, 0];
  if (utMag > 1e-9) {
    const grip = (2 / 7) * MASS_KG * utMag;
    Jt = vScale(ut, -Math.min(grip, props.mu * Jn) / utMag);
  }

  // ── Plowing through the pitch mark ──
  // Opposes the CENTRE's tangential motion, not the contact patch, and is not
  // grip-capped. Applied through the centre, so no torque.
  const vt = vSub(v, vScale(n, vn));
  const vtMag = vLen(vt);
  let Jp: V3 = [0, 0, 0];
  if (vtMag > 1e-9 && props.plow > 0) {
    const mag = Math.min(
      plowFactor(props.plow, vn) * Jn,
      MASS_KG * vtMag,                             // never reverse the ball
    );
    Jp = vScale(vt, -mag / vtMag);
  }

  let vOut = vAdd(v, vScale(vAdd(vAdd(vScale(n, Jn), Jt), Jp), 1 / MASS_KG));
  let wOut = vAdd(w, vScale(vCross(r, Jt), 1 / I));

  // Hard backstop: an impact may never increase total kinetic energy. The
  // crater model is a geometric approximation of a genuinely messy process,
  // and this guarantees no parameter choice can turn it into a slingshot.
  const ke = (vv: V3, ww: V3) =>
    0.5 * MASS_KG * vDot(vv, vv) + 0.5 * I * vDot(ww, ww);
  const keIn = ke(v, w);
  const keOut = ke(vOut, wOut);
  if (keOut > keIn && keOut > 1e-9) {
    const k = Math.sqrt(keIn / keOut);
    vOut = vScale(vOut, k);
    wOut = vScale(wOut, k);
  }
  return { v: vOut, w: wOut };
}

/** Below this normal approach speed a "bounce" is just contact; switch to the
 *  rolling/sliding solver. */
const BOUNCE_FLOOR_MS = 0.35;
const MAX_BOUNCES = 12;
/** Give up on a run-out that will not settle (steep slope). */
const MAX_GROUND_TIME_S = 30;
/**
 * The landing slope describes the ground AROUND the pitch mark, not the whole
 * hole. Extrapolating one constant gradient far enough and a ball on a 10°
 * green rolls 300 yards, which says more about the model than the golf course.
 * Past this distance the run-out is cut off and `stillRolling` is set, so the
 * caller knows the ball was handed off rather than settled.
 */
const MAX_GROUND_RUN_M = 55;

/**
 * Everything after the ball first touches the ground: successive bounces, then
 * a sliding/rolling phase that ends when the ball settles.
 *
 * The slide-then-roll split matters. A ball rarely lands rolling: it skids,
 * friction spins it up (or kills its backspin), and only then does it roll.
 * Modelling that is why a wedge can still crawl backwards after its bounce,
 * and why a driver skids before it chases.
 *
 * Returns positions in METRES relative to the pitch mark, on a plane with the
 * given normal passing through it.
 */
function simulateGround(
  vIn: V3, wIn: V3, n: V3, props: SurfaceProps,
): { path: V3[]; bounces: V3[]; rest: V3; stillRolling: boolean } {
  let v = vIn;
  let w = wIn;
  let p: V3 = [0, 0, 0];
  const path: V3[] = [[0, 0, 0]];
  const bounces: V3[] = [];

  const g: V3 = [0, 0, -G];
  const gN = vDot(g, n);                    // negative; |gN| = g·cosθ
  const gT = vSub(g, vScale(n, gN));        // downhill acceleration
  const gTMag = vLen(gT);
  const normalAccel = -gN;                  // g·cosθ, positive
  const I = 0.4 * MASS_KG * RADIUS_M * RADIUS_M;
  const r = vScale(n, -RADIUS_M);

  const dt = 0.004;
  let t = 0;
  let stillRolling = false;

  // ── bounce phase ──
  for (let b = 0; b < MAX_BOUNCES; b++) {
    const after = bounceImpulse(v, w, n, props);
    v = after.v; w = after.w;
    bounces.push([...p] as V3);

    const vn = vDot(v, n);
    if (vn < BOUNCE_FLOOR_MS) break;        // too weak to leave the ground

    // Ballistic hop. Air forces are negligible at these speeds, but the same
    // accel() is used so a fast first bounce still feels drag.
    for (let i = 0; i < 4000; i++) {
      const st: State = { px: p[0], py: p[1], pz: p[2], vx: v[0], vy: v[1], vz: v[2] };
      const a = accel(st, w[0], w[1], w[2]);
      const pNext: V3 = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
      const vNext: V3 = [v[0] + a[0] * dt, v[1] + a[1] * dt, v[2] + a[2] * dt];
      t += dt;
      // Height above the (tilted) plane through the origin.
      const hNext = vDot(pNext, n);
      if (hNext <= 0 && vDot(vNext, n) < 0) {
        // Land exactly on the plane rather than a step below it.
        const h = vDot(p, n);
        const f = h / (h - hNext) || 0;
        p = vAdd(p, vScale(vSub(pNext, p), f));
        v = vNext;
        path.push([...p] as V3);
        break;
      }
      p = pNext; v = vNext;
      path.push([...p] as V3);
      if (t > MAX_GROUND_TIME_S || vLen(p) > MAX_GROUND_RUN_M) break;
    }
    if (t > MAX_GROUND_TIME_S || vLen(p) > MAX_GROUND_RUN_M) { stillRolling = true; break; }
  }

  // ── slide / roll phase ──
  // Kill any residual normal velocity: the ball is on the ground now.
  v = vSub(v, vScale(n, vDot(v, n)));

  for (let i = 0; t < MAX_GROUND_TIME_S; i++) {
    const speed = vLen(v);
    const u = vAdd(v, vCross(w, r));                   // contact-point velocity
    const ut = vSub(u, vScale(n, vDot(u, n)));
    const utMag = vLen(ut);

    let a: V3;
    if (utMag > 0.05) {
      // SLIDING: kinetic friction opposes the contact point, and its torque
      // spins the ball up (or scrubs backspin off) until the slide ends.
      // Cap the step so friction can never drive the contact point past zero
      // and start pumping it the other way — with a high-mu surface and a
      // heavily spinning ball that oscillation runs away.
      const fMax = (2 / 7) * utMag / dt;               // stops the slide exactly
      const fMag = Math.min(props.mu * normalAccel, fMax);
      const dir = vScale(ut, -1 / utMag);
      a = vAdd(gT, vScale(dir, fMag));
      const torque = vCross(r, vScale(dir, fMag * MASS_KG));
      w = vAdd(w, vScale(torque, dt / I));
    } else {
      // ROLLING: only rolling resistance and gravity along the slope.
      if (speed < 1e-4) {
        if (gTMag <= props.crr * normalAccel) break;   // slope can't restart it
        a = gT;
      } else {
        const rr = crrAt(props.crr, speed) * normalAccel;
        a = vAdd(gT, vScale(v, -rr / speed));
        // Would resistance reverse it this step? Then it has stopped.
        const vNext = vAdd(v, vScale(a, dt));
        if (vDot(vNext, v) < 0 && gTMag <= props.crr * normalAccel) break;
      }
      // Keep ω consistent with rolling so a later hop carries sane spin.
      w = vScale(vCross(n, v), 1 / RADIUS_M);
    }

    v = vAdd(v, vScale(a, dt));
    // Stay on the plane.
    v = vSub(v, vScale(n, vDot(v, n)));
    p = vAdd(p, vScale(v, dt));
    p = vSub(p, vScale(n, vDot(p, n)));
    t += dt;
    if (i % 3 === 0) path.push([...p] as V3);

    if (vLen(v) < 0.06 && gTMag <= props.crr * normalAccel) break;
    if (vLen(p) > MAX_GROUND_RUN_M) { stillRolling = true; break; }
  }
  if (t >= MAX_GROUND_TIME_S) stillRolling = true;

  path.push([...p] as V3);
  return { path, bounces, rest: p, stillRolling };
}

/**
 * Simulate a shot: flight, then bounce and run-out on the landing surface.
 *
 * Still air. Ground defaults to a flat fairway, which is the driving range
 * this was built for; pass `ground` to land it on a slope or another surface.
 */
export function simulateFlight(lc: LaunchConditions, ground?: GroundOptions): FlightResult {
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

  // ── Ground phase ──
  // The landing plane is anchored at the pitch mark, so "carry" keeps its
  // conventional meaning (where the ball first touches down) regardless of
  // how the ground is tilted around it.
  const props = SURFACES[ground?.surface ?? 'fairway'];
  const n = planeNormal(ground?.upslopeDeg ?? 0, ground?.crossSlopeDeg ?? 0);
  const decayAtLanding = Math.exp(-landT / SPIN_DECAY_TAU_S);
  const gr = simulateGround(
    [s.vx, s.vy, s.vz],
    [w0x * decayAtLanding, w0y * decayAtLanding, w0z * decayAtLanding],
    n, props,
  );

  const restX = landX + gr.rest[0];
  const restY = landY + gr.rest[1];
  const totalYds = restX * M_TO_YDS;
  const finishOfflineYds = restY * M_TO_YDS;

  // Downsample for rendering — ~60 points is plenty for a smooth arc.
  const target = 60;
  const stride = Math.max(1, Math.floor(raw.length / target));
  const path: FlightPoint[] = [];
  for (let i = 0; i < raw.length; i += stride) path.push(raw[i]);
  if (path[path.length - 1] !== raw[raw.length - 1]) path.push(raw[raw.length - 1]);

  // Ground path, in the same world frame and units as `path`.
  const gStride = Math.max(1, Math.floor(gr.path.length / 40));
  const groundPath: FlightPoint[] = [];
  for (let i = 0; i < gr.path.length; i += gStride) {
    groundPath.push({
      x: (landX + gr.path[i][0]) * M_TO_YDS,
      y: (landY + gr.path[i][1]) * M_TO_YDS,
      z: gr.path[i][2] * M_TO_YDS,
    });
  }
  const lastG = gr.path[gr.path.length - 1];
  groundPath.push({
    x: (landX + lastG[0]) * M_TO_YDS,
    y: (landY + lastG[1]) * M_TO_YDS,
    z: lastG[2] * M_TO_YDS,
  });

  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    carryYds: r1(carryYds),
    totalYds: r1(totalYds),
    offlineYds: r1(offlineYds),
    apexFt: Math.round(apexM * M_TO_FT),
    descentAngleDeg: r1(descentAngleDeg),
    flightTimeS: Math.round(landT * 100) / 100,
    path,
    rollYds: r1(totalYds - carryYds),
    finishOfflineYds: r1(finishOfflineYds),
    bounces: gr.bounces.map((b, i) => ({
      x: r1((landX + b[0]) * M_TO_YDS),
      y: r1((landY + b[1]) * M_TO_YDS),
      inSpeedMph: i === 0 ? Math.round(Math.hypot(s.vx, s.vy, s.vz) / MPH_TO_MS) : 0,
    })),
    groundPath,
    stillRolling: gr.stillRolling,
  };
}
