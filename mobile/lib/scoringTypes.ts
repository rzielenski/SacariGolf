/**
 * Shared types for the scoring screen, scorecard view, shot-map modal, and
 * live spectator. Centralising prevents the structural drift that comes
 * from re-declaring `Shot` / `HoleStat` in every consumer.
 *
 * Keep everything in this file optional-by-default — round storage is
 * forward-compatible and we accept partial entries from older clients.
 */

/** A single geographic point. Elevation is only present when the device
 *  reported an altitude on the GPS fix (some devices return null).
 *
 *  `baro_relative_m` is the iPhone barometer's relative altitude reading
 *  (CMAltimeter) at the moment the point was captured. Itself meaningless
 *  in isolation (it's relative to wherever the barometer session started),
 *  but the *difference* between two points' baro_relative_m is sub-meter
 *  accurate over short timescales — vastly better than GPS altitude for
 *  shot-to-shot or ball-to-pin elevation deltas. */
export interface Pt {
  lat: number;
  lng: number;
  elevation_m?: number;
  baro_relative_m?: number;
}

/** A finalised shot — start + end as one segment. Rendered as a polyline. */
export interface Shot {
  club: string;
  lie?: string;
  start: Pt;
  end: Pt;
  recorded_at?: string;
  /** Plays-like (normalized) yardage: raw GPS distance adjusted for the
   *  weather snapshot + slope at recording time. Used by club-stats so
   *  averages reflect what the shot WOULD have gone in neutral conditions.
   *  Missing on legacy rows and on imported launch-monitor data. */
  plays_like_yds?: number;
}

/** A shot that's been started but not stopped yet (TRACK tapped once). */
export interface ActiveShot {
  club: string;
  lie?: string;
  start: Pt;
  startedAt: string;
}

/** Per-hole stat detail, attached parallel to hole_scores in the rounds
 *  row. All fields optional — players can fill any subset. */
export interface HoleStat {
  putts?: number;
  chips?: number;
  gir?: boolean | null;
  fairwayHit?: boolean | null;
  fairwayMiss?: 'left' | 'right' | null;
  greenMiss?: 'left' | 'right' | 'short' | 'long' | null;
  /** Distance per putt in feet. Length should match `putts`. */
  puttDistances?: number[];
}

/** Cached pin location for a hole — either from the server (`holes.pin_lat`)
 *  or locally contributed by the current player this round. */
export interface LocalPin {
  lat: number;
  lng: number;
  elevation_m?: number | null;
}
