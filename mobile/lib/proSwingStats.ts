/**
 * PGA Tour + amateur baseline swing statistics, used for the Range Session
 * comparison view. Numbers are mean values across a broad sample — they're
 * marketing-grade benchmarks, not survey-precision, and intentionally
 * rounded to clean numbers that match what tour broadcasts cite.
 *
 * Sources synthesised from publicly published Trackman / FlightScope / PGA
 * Tour ShotLink summaries. When ranges varied across sources we picked the
 * mid-point. Tempo + body-position numbers come from the K-Vest / Sportsbox
 * coaching literature.
 *
 * "Amateur" is defined as a ~14-handicap male golfer — the median rec
 * player. Sacari users below 5 handicap will outperform these numbers;
 * users above 20 will trail them. The COMPARISON UI surfaces both the
 * pro reference AND the amateur reference so a 14-cap user can see they're
 * around average for their tier, not "100 mph slower than Rory."
 */

export interface ClubMetrics {
  /** Clubhead speed at impact, mph */
  clubheadSpeedMph: number;
  /** Ball speed off the face, mph */
  ballSpeedMph: number;
  /** Smash factor = ball speed / club speed. 1.50 is the physical ceiling. */
  smashFactor: number;
  /** Launch angle, degrees above horizontal */
  launchAngleDeg: number;
  /** Backspin, RPM */
  spinRpm: number;
  /** Carry distance, yards */
  carryYds: number;
}

export interface BodyMetrics {
  /** Backswing duration, seconds (address → top of backswing) */
  backswingSec: number;
  /** Downswing duration, seconds (top → impact) */
  downswingSec: number;
  /** Tempo ratio backswing:downswing. PGA pros are remarkably consistent
   *  at 3:1; amateurs are quicker and more variable (~2.2-2.5:1). */
  tempoRatio: number;
  /** Hip turn at top of backswing, degrees from address */
  hipTurnDeg: number;
  /** Shoulder turn at top of backswing, degrees from address */
  shoulderTurnDeg: number;
  /** X-factor = shoulder turn − hip turn, the "torsion" stored at the top.
   *  Higher = more power potential, but also more strain on the back. */
  xFactorDeg: number;
  /** Lateral hip shift through the strike, inches toward the target */
  lateralHipShiftIn: number;
  /** Lead wrist hinge angle at top of backswing, degrees */
  leadWristHingeDeg: number;
  /** Spine angle from vertical at address, degrees forward.
   *  Pros maintain this through impact within ~3°; amateurs lose it. */
  spineAngleDeg: number;
  /** Vertical head movement through the swing, inches.
   *  Pros: under 2". Amateurs: often 4-6". */
  headMovementIn: number;
}

export interface SwingReference {
  pro: ClubMetrics & BodyMetrics;
  amateur: ClubMetrics & BodyMetrics;
}

// ── Per-club references ──────────────────────────────────────────────────
// Each entry blends the club-specific ballistics (varies by club) with the
// body-mechanic numbers (mostly invariant across clubs — a pro's tempo
// ratio is 3:1 whether they're swinging a driver or a 9-iron).

const PRO_BODY: BodyMetrics = {
  backswingSec: 0.75,
  downswingSec: 0.25,
  tempoRatio: 3.0,
  hipTurnDeg: 45,
  shoulderTurnDeg: 95,
  xFactorDeg: 50,
  lateralHipShiftIn: 5,
  leadWristHingeDeg: 90,
  spineAngleDeg: 33,
  headMovementIn: 1.8,
};

const AMATEUR_BODY: BodyMetrics = {
  backswingSec: 0.65,
  downswingSec: 0.29,
  tempoRatio: 2.25,
  hipTurnDeg: 38,
  shoulderTurnDeg: 78,
  xFactorDeg: 40,
  lateralHipShiftIn: 3.2,
  leadWristHingeDeg: 72,
  spineAngleDeg: 28,
  headMovementIn: 4.4,
};

export const SWING_REF: Record<string, SwingReference> = {
  driver: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 113, ballSpeedMph: 167, smashFactor: 1.48, launchAngleDeg: 10.9, spinRpm: 2686, carryYds: 275 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 93,  ballSpeedMph: 132, smashFactor: 1.42, launchAngleDeg: 12.5, spinRpm: 3275, carryYds: 215 },
  },
  '3wood': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 107, ballSpeedMph: 158, smashFactor: 1.48, launchAngleDeg: 9.2,  spinRpm: 3655, carryYds: 243 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 88,  ballSpeedMph: 124, smashFactor: 1.41, launchAngleDeg: 11.2, spinRpm: 4350, carryYds: 195 },
  },
  '5wood': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 103, ballSpeedMph: 152, smashFactor: 1.47, launchAngleDeg: 9.4,  spinRpm: 4350, carryYds: 230 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 86,  ballSpeedMph: 119, smashFactor: 1.38, launchAngleDeg: 12.1, spinRpm: 5025, carryYds: 185 },
  },
  hybrid: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 100, ballSpeedMph: 146, smashFactor: 1.46, launchAngleDeg: 10.2, spinRpm: 4437, carryYds: 215 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 84,  ballSpeedMph: 116, smashFactor: 1.38, launchAngleDeg: 13.5, spinRpm: 5125, carryYds: 175 },
  },
  '4iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 99,  ballSpeedMph: 141, smashFactor: 1.43, launchAngleDeg: 12.1, spinRpm: 4630, carryYds: 203 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 80,  ballSpeedMph: 108, smashFactor: 1.35, launchAngleDeg: 14.3, spinRpm: 5350, carryYds: 165 },
  },
  '5iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 96,  ballSpeedMph: 135, smashFactor: 1.41, launchAngleDeg: 14.1, spinRpm: 5361, carryYds: 194 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 79,  ballSpeedMph: 105, smashFactor: 1.33, launchAngleDeg: 15.2, spinRpm: 6125, carryYds: 158 },
  },
  '6iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 93,  ballSpeedMph: 131, smashFactor: 1.40, launchAngleDeg: 15.8, spinRpm: 6231, carryYds: 183 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 77,  ballSpeedMph: 102, smashFactor: 1.33, launchAngleDeg: 16.9, spinRpm: 6900, carryYds: 148 },
  },
  '7iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 90,  ballSpeedMph: 120, smashFactor: 1.33, launchAngleDeg: 16.3, spinRpm: 7097, carryYds: 172 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 75,  ballSpeedMph: 97,  smashFactor: 1.29, launchAngleDeg: 18.4, spinRpm: 7750, carryYds: 135 },
  },
  '8iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 87,  ballSpeedMph: 115, smashFactor: 1.32, launchAngleDeg: 18.1, spinRpm: 7998, carryYds: 160 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 72,  ballSpeedMph: 92,  smashFactor: 1.28, launchAngleDeg: 19.7, spinRpm: 8500, carryYds: 124 },
  },
  '9iron': {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 85,  ballSpeedMph: 110, smashFactor: 1.29, launchAngleDeg: 20.4, spinRpm: 8647, carryYds: 148 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 70,  ballSpeedMph: 88,  smashFactor: 1.26, launchAngleDeg: 22.1, spinRpm: 9100, carryYds: 113 },
  },
  pw: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 83,  ballSpeedMph: 102, smashFactor: 1.23, launchAngleDeg: 24.2, spinRpm: 9304, carryYds: 136 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 68,  ballSpeedMph: 83,  smashFactor: 1.22, launchAngleDeg: 25.3, spinRpm: 9800, carryYds: 104 },
  },
  gw: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 80,  ballSpeedMph: 96,  smashFactor: 1.20, launchAngleDeg: 26.8, spinRpm: 9850, carryYds: 120 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 66,  ballSpeedMph: 78,  smashFactor: 1.18, launchAngleDeg: 28.0, spinRpm: 10100, carryYds: 92 },
  },
  sw: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 77,  ballSpeedMph: 89,  smashFactor: 1.16, launchAngleDeg: 28.7, spinRpm: 10100, carryYds: 105 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 64,  ballSpeedMph: 73,  smashFactor: 1.14, launchAngleDeg: 30.4, spinRpm: 10500, carryYds: 80 },
  },
  lw: {
    pro:     { ...PRO_BODY,     clubheadSpeedMph: 74,  ballSpeedMph: 83,  smashFactor: 1.12, launchAngleDeg: 31.5, spinRpm: 10400, carryYds: 85 },
    amateur: { ...AMATEUR_BODY, clubheadSpeedMph: 61,  ballSpeedMph: 67,  smashFactor: 1.10, launchAngleDeg: 33.0, spinRpm: 10800, carryYds: 65 },
  },
};

export const CLUB_LABELS: Record<string, string> = {
  driver: 'Driver',
  '3wood': '3-Wood',
  '5wood': '5-Wood',
  hybrid: 'Hybrid',
  '4iron': '4-Iron',
  '5iron': '5-Iron',
  '6iron': '6-Iron',
  '7iron': '7-Iron',
  '8iron': '8-Iron',
  '9iron': '9-Iron',
  pw: 'Pitching Wedge',
  gw: 'Gap Wedge',
  sw: 'Sand Wedge',
  lw: 'Lob Wedge',
};

/** A short, plain-language interpretation of how a user's value compares to
 *  the pro baseline. Pulled into the analysis screen as the human-readable
 *  "what does this mean?" footer for each metric. */
export function interpretDelta(
  value: number,
  proValue: number,
  amateurValue: number,
  unit: string,
  higherIsBetter = true,
): { tone: 'great' | 'good' | 'fair' | 'work'; text: string } {
  const proDelta = value - proValue;
  const amaDelta = value - amateurValue;
  const sign = higherIsBetter ? 1 : -1;
  const proGap = proDelta * sign;
  const amaGap = amaDelta * sign;

  if (proGap >= -1) {
    return { tone: 'great', text: `Tour-grade — you're within touring-pro range.` };
  }
  if (amaGap >= 2) {
    return { tone: 'good', text: `Above the rec-player average (${amateurValue}${unit}).` };
  }
  if (amaGap >= -2) {
    return { tone: 'fair', text: `Right at the rec-player average. Room to push toward pro.` };
  }
  return { tone: 'work', text: `Below the rec-player average — this is the biggest gain available.` };
}
