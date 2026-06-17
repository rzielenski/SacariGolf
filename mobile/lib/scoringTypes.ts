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
  /** Where the player aimed when they took the shot, captured at the moment
   *  TRACK→stop is tapped. Comes from the draggable heatmap target on the
   *  scoring map. When present, downstream stats recompute lateral_yds
   *  relative to the start→aim line instead of the start→pin line — so a
   *  golfer who deliberately played the right side of the fairway and
   *  found it isn't penalised with a fake "lateral miss" against center. */
  aim?: { lat: number; lng: number };
  /** Total great-circle distance from start to end, in yards. Always
   *  computed at finalize time so per-shot reads don't need to recompute
   *  haversine on every render. */
  total_yds?: number;
  /** Signed perpendicular offset from the centerline at the moment the
   *  shot was finalised, in yards. Positive = right of intended line,
   *  negative = left. Centerline is start→aim if the player dragged a
   *  heatmap target, else start→pin if the pin location is known. Absent
   *  when neither aim nor pin is available — we report total distance only
   *  in that case rather than guess a centerline. */
  lateral_yds?: number;
  /** Which centerline `lateral_yds` was computed against. Lets downstream
   *  stats know whether the lateral is meaningful (aim/pin) or absent. */
  lateral_ref?: 'aim' | 'pin';
  /** Partial-swing tag: a percentage ('75%') or clock ('9:00') label, absent
   *  for a full swing. Drives the per-club partial-distance breakdown in
   *  club-stats so a 75% wedge doesn't muddy the full-swing average. */
  partial_value?: string;
}

/** A shot that's been started but not stopped yet (TRACK tapped once). */
export interface ActiveShot {
  club: string;
  lie?: string;
  start: Pt;
  startedAt: string;
  /** Partial-swing tag carried from pendingPartial when the shot started. */
  partial_value?: string;
  /** Hole the shot was STARTED on. The finalised shot is attributed to this
   *  hole — not whatever hole is on screen when STOP is tapped — so swiping
   *  to another hole mid-shot can't misfile it (or fabricate a cross-hole
   *  segment). Optional for backward-compat with persisted/legacy active
   *  shots; finalize falls back to the current hole when absent. */
  holeNum?: number;
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
