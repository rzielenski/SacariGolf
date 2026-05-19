//
//  PlaysLike.swift
//  SacariGolfWatch
//
//  Plays-like yardage calculator. Premium feature — adjusts the raw GPS
//  distance for slope (elevation delta), wind component along the shot
//  line, temperature, altitude, and rain.
//
//  Ported from the iOS app's `mobile/lib/weatherAdjust.ts`. Keeping the
//  formulas in sync between clients matters: if the watch shows "plays
//  152" and the phone shows "plays 148" for the same shot, the user will
//  stop trusting both. Pure functions; no I/O.
//
//  Convention:
//    • effectiveDelta_yds > 0  → conditions REDUCE carry, so play MORE club
//    • effectiveDelta_yds < 0  → conditions ADD carry, play LESS club
//

import Foundation

struct PlaysLikeInputs {
    /// Raw great-circle distance to target, in yards.
    let baseYards: Double
    /// Elevation delta in METERS (target − player). Positive = target is
    /// uphill from the player. Set to 0 when DEM lookup not available.
    let elevationDeltaM: Double
    /// Weather snapshot from the backend's /weather endpoint. Optional —
    /// when nil the function returns slope-only adjustment.
    let weather: Weather?
    /// Shot bearing in degrees (0 = N, 90 = E). Used to decompose wind
    /// into along-shot vs cross-shot components. The cross component
    /// affects landing position, not distance — we surface only along.
    let shotBearingDeg: Double
    /// Player's home-course elevation in feet (from User.home_course_lat
    /// + a DEM lookup at home-set time). Used to compute the altitude
    /// DELTA between home and the current course — a 200ft delta makes
    /// no difference to ball flight, a 2000ft delta makes a 5+ yard
    /// difference. Pass 0 if unknown.
    let homeElevationFt: Double
}

struct PlaysLikeResult {
    /// The play-like yardage — what the player should club for.
    let playsLikeYds: Int
    /// Component breakdown, signed yardage. Positive = adds yards to
    /// the effective distance (reduces carry).
    let slopeYds: Int
    let windYds: Int
    let temperatureYds: Int
    let altitudeYds: Int
    let rainYds: Int

    /// Aggregate delta vs baseYards. Sum of the components above.
    var totalDelta: Int { slopeYds + windYds + temperatureYds + altitudeYds + rainYds }
}

/// Compute plays-like yardage. Always returns a result; missing inputs
/// (weather nil, elevation unknown) just zero out those components.
func playsLike(_ inputs: PlaysLikeInputs) -> PlaysLikeResult {
    // ── Slope ─────────────────────────────────────────────────────
    // 1m of elevation ≈ 1.09 yards of carry adjustment. Sign: uphill
    // (positive delta) PLAYS LONGER (positive component).
    let slopeYds = inputs.elevationDeltaM * 1.09

    // ── Wind ──────────────────────────────────────────────────────
    // Wind is reported as the bearing the wind is BLOWING FROM.
    // Convert to an along-shot component: positive = headwind (plays
    // longer), negative = tailwind (plays shorter).
    var windYds = 0.0
    if let w = inputs.weather,
       let speed = w.wind_speed_mph,
       let from  = w.wind_from_bearing
    {
        // Bearing the wind is GOING TO = from + 180. Component along
        // the shot line: speed * cos(shotBearing − windToBearing).
        let toBearing = (from + 180).truncatingRemainder(dividingBy: 360)
        let theta = (inputs.shotBearingDeg - toBearing) * .pi / 180
        let along = speed * cos(theta) * -1
        // -1 because: when wind blows in the same direction as the
        // shot (theta = 0, cos = 1), it's a tailwind → reduces effective
        // yardage → negative windYds. Tour-tested rule of thumb: each
        // mph along ≈ 1.4 yds of carry impact on a wedge, 0.6 on a
        // driver. We use 1.0 as a club-neutral middle ground here.
        windYds = along * 1.0
    }

    // ── Temperature ────────────────────────────────────────────────
    // Standard reference: 70°F. Cold air is denser → ball goes shorter
    // → plays longer (positive component). Roughly 1.5 yards per 20°F.
    var temperatureYds = 0.0
    if let f = inputs.weather?.temperature_f {
        temperatureYds = (70 - f) * (1.5 / 20)
    }

    // ── Altitude ───────────────────────────────────────────────────
    // Thinner air at altitude → ball flies farther → plays shorter
    // (negative component). About 2% per 1000ft.
    var altitudeYds = 0.0
    if let courseAltFt = inputs.weather?.elevation_ft {
        let deltaFt = courseAltFt - inputs.homeElevationFt
        // 2% per 1000ft, applied to the base distance.
        altitudeYds = -(deltaFt / 1000) * 0.02 * inputs.baseYards
    }

    // ── Rain ───────────────────────────────────────────────────────
    // Heavy rain robs ~2 yds off carry; light rain ~1. Wet grass also
    // kills rollout but we're only modeling carry here.
    var rainYds = 0.0
    if let r = inputs.weather?.rain {
        switch r {
        case "light": rainYds = 1
        case "heavy": rainYds = 2
        default: rainYds = 0
        }
    }

    let totalDelta = slopeYds + windYds + temperatureYds + altitudeYds + rainYds
    let plays = Int(round(inputs.baseYards + totalDelta))

    return PlaysLikeResult(
        playsLikeYds: plays,
        slopeYds:       Int(round(slopeYds)),
        windYds:        Int(round(windYds)),
        temperatureYds: Int(round(temperatureYds)),
        altitudeYds:    Int(round(altitudeYds)),
        rainYds:        Int(round(rainYds)),
    )
}
