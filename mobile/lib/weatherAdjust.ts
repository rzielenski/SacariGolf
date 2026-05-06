/**
 * Weather/atmospheric distance adjustments for golf shots.
 *
 * Returns multiplicative factors and additive yardages so the caller can
 * compute a "plays-like" distance for any club + carry. All formulas are
 * sourced from published golf-physics references — citations below.
 *
 * Sources:
 *  • Trackman: "Course Conditions" white paper — altitude & temperature
 *  • Bryson DeChambeau / Trackman 2020 charts — temperature carry deltas
 *  • Mark Broadie, "Every Shot Counts" (2014) — wind impact tables
 *  • USGA Equipment Standards — air density / ball flight
 *
 * Conventions:
 *  • All distances in yards
 *  • Temperature in °F (rule-of-thumb is keyed to °F per Trackman charts)
 *  • Wind in mph
 *  • Headwind = wind blowing TOWARD the player (negative carry); tailwind = +
 *  • Altitude in feet above sea level
 */

export type RainCondition = 'none' | 'light' | 'heavy';

export interface WeatherInputs {
  altitudeFt: number;       // course elevation above sea level, in feet
  temperatureF: number;     // ambient air temperature, °F
  /** Component of wind ALONG the shot line. Positive = tailwind, negative = headwind. */
  windAlongMph: number;
  rain: RainCondition;
}

export interface AdjustmentBreakdown {
  base_yds: number;
  altitude_yds: number;
  temperature_yds: number;
  wind_yds: number;
  rain_yds: number;
  plays_like_yds: number;
  /** Δ from base distance — positive means it plays SHORTER (i.e. need a longer club). */
  effective_delta_yds: number;
}

/* ─── Altitude ────────────────────────────────────────────────────────────
 * Trackman: carry increases ~2% per 1000 ft of altitude. So a 150-yd shot
 * at 5,280 ft (Denver) carries ~165 yds. Linear approximation is accurate
 * within ±1% up to ~10,000 ft, which covers every golf course on Earth. */
function altitudeMultiplier(altitudeFt: number): number {
  return 1 + (altitudeFt / 1000) * 0.02;
}

/* ─── Temperature ─────────────────────────────────────────────────────────
 * Baseline = 70°F. Trackman data: ~2 yds per 10°F per 150 yds of carry,
 * which is ~1.3% per 10°F. Cold air is denser AND the ball compresses
 * less, both reducing carry. Effect is roughly linear in the 30–100°F band. */
function temperatureMultiplier(tempF: number): number {
  const BASELINE_F = 70;
  return 1 + (tempF - BASELINE_F) * 0.0013;
}

/* ─── Wind ────────────────────────────────────────────────────────────────
 * Asymmetric: headwind hurts more than tailwind helps because a headwind
 * INCREASES spin/lift (ballooning the shot), whereas a tailwind reduces it.
 * Conventional caddie rule of thumb is "1% per mph headwind, 0.5% per mph
 * tailwind" — Broadie's data backs this up across club types.
 *
 * Returns yards of carry adjustment to ADD to the base shot. Negative for
 * headwind (less carry), positive for tailwind (more carry). */
function windYardageDelta(baseYds: number, windAlongMph: number): number {
  if (windAlongMph >= 0) {
    // Tailwind
    return baseYds * 0.005 * windAlongMph;
  } else {
    // Headwind (windAlongMph is negative)
    return baseYds * 0.01 * windAlongMph;
  }
}

/* ─── Rain ────────────────────────────────────────────────────────────────
 * Wet conditions cost carry from a soaked ball + soft, slow turf eliminating
 * roll-out. Light rain ≈ −2% effective; heavy ≈ −5%. We treat this as a flat
 * multiplier on TOTAL distance (carry + roll combined) since most amateurs
 * think in total yardage. */
function rainMultiplier(rain: RainCondition): number {
  switch (rain) {
    case 'heavy': return 0.95;
    case 'light': return 0.98;
    case 'none':
    default:      return 1.00;
  }
}

/**
 * Compute a full plays-like adjustment for a shot.
 *
 * Multiplicative effects (altitude, temperature, rain) compound. Wind is
 * additive in yards because its effect doesn't scale cleanly off the
 * adjusted distance — it's a function of the shot's flight time, which is
 * itself shaped by club, not raw yardage.
 */
export function adjustDistance(baseYds: number, w: WeatherInputs): AdjustmentBreakdown {
  const altMult  = altitudeMultiplier(w.altitudeFt);
  const tempMult = temperatureMultiplier(w.temperatureF);
  const rainMult = rainMultiplier(w.rain);

  const altitude_yds    = baseYds * (altMult - 1);
  const temperature_yds = baseYds * altMult * (tempMult - 1);
  const rain_yds        = baseYds * altMult * tempMult * (rainMult - 1);
  const wind_yds        = windYardageDelta(baseYds, w.windAlongMph);

  const plays_like_yds = baseYds + altitude_yds + temperature_yds + rain_yds + wind_yds;
  return {
    base_yds: baseYds,
    altitude_yds,
    temperature_yds,
    wind_yds,
    rain_yds,
    plays_like_yds,
    // From the player's perspective: if the shot will travel FARTHER than its
    // base yardage (positive plays_like − base), the EFFECTIVE distance to
    // the target is shorter (you need less club). Convention used by Trackman
    // and most caddie apps: "effective" = how much club you should hit.
    effective_delta_yds: -(plays_like_yds - baseYds),
  };
}

/**
 * Decompose a wind vector (speed + bearing) into the component along a
 * given shot line (bearing player → target). Both bearings in degrees,
 * 0 = north, clockwise.
 *
 * Returns:
 *   along_mph   — positive = tailwind, negative = headwind
 *   cross_mph   — positive = wind from left (pushing ball right)
 */
export function windComponents(
  windSpeedMph: number,
  windFromBearingDeg: number,  // bearing the wind is BLOWING FROM (meteorological convention)
  shotBearingDeg: number,
): { along_mph: number; cross_mph: number } {
  // Convert "blowing from" to "blowing toward" by flipping 180°.
  const windToBearing = (windFromBearingDeg + 180) % 360;
  const diffDeg = windToBearing - shotBearingDeg;
  const diffRad = (diffDeg * Math.PI) / 180;
  return {
    along_mph: windSpeedMph * Math.cos(diffRad),
    cross_mph: windSpeedMph * Math.sin(diffRad),
  };
}

/** Meters → feet helper, since GPS altitude is metres. */
export const metersToFeet = (m: number) => m * 3.28084;
