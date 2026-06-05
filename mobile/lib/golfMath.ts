/**
 * Pure golf math + visual constants shared across the app.
 *
 * Single source of truth for distance, score labels, score colors, and the
 * shot-color palette. Prior to consolidation each of these lived in 3-6
 * places with subtle drift (different metres↔yards conversion constants,
 * slightly different color thresholds). Anything geometric or score-display
 * related should live here.
 *
 * No React, no I/O — these are referentially transparent functions safe to
 * call inside render paths or memo deps.
 */

import { C } from './colors';

// ─── Distances ──────────────────────────────────────────────────────────────

/** Great-circle distance between two lat/lng pairs, in metres (haversine). */
export function distMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Same as distMetres but in yards. The exact factor 1.0936132983 keeps
 *  long shots accurate to the inch. */
export function distYards(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return distMetres(lat1, lng1, lat2, lng2) * 1.0936132983;
}

/** Initial-bearing in degrees (0 = N, clockwise). Used to decompose wind
 *  along the shot line and to orient the heatmap projection. */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x) * 180 / Math.PI;
  return (θ + 360) % 360;
}

/** Project a start coord forward along a bearing by `forwardYds` and then
 *  perpendicular by `lateralYds` (positive = right of bearing). Generic
 *  geo helper for placing a synthetic point at a known offset from a
 *  real-world coordinate. Lateral perpendicular = bearing + 90°. */
export function projectYards(
  startLat: number, startLng: number,
  bearingDegrees: number,
  forwardYds: number,
  lateralYds = 0,
): { lat: number; lng: number } {
  const R = 6371000;
  const YDS_TO_M = 0.9144;
  const step = (lat: number, lng: number, bearRad: number, distM: number) => {
    const sLat = lat * Math.PI / 180;
    const sLng = lng * Math.PI / 180;
    const eLat = Math.asin(
      Math.sin(sLat) * Math.cos(distM / R) +
      Math.cos(sLat) * Math.sin(distM / R) * Math.cos(bearRad)
    );
    const eLng = sLng + Math.atan2(
      Math.sin(bearRad) * Math.sin(distM / R) * Math.cos(sLat),
      Math.cos(distM / R) - Math.sin(sLat) * Math.sin(eLat),
    );
    return { lat: eLat * 180 / Math.PI, lng: eLng * 180 / Math.PI };
  };
  const bearRad = bearingDegrees * Math.PI / 180;
  let p = { lat: startLat, lng: startLng };
  if (forwardYds !== 0) p = step(p.lat, p.lng, bearRad, forwardYds * YDS_TO_M);
  if (lateralYds !== 0) p = step(p.lat, p.lng, bearRad + Math.PI / 2, lateralYds * YDS_TO_M);
  return p;
}

// ─── Handicap display ───────────────────────────────────────────────────────

/**
 * Format a USGA Handicap Index for display.
 *
 *   12.3   → "12.3"   (positive — a normal handicap)
 *   0      → "0.0"    (scratch)
 *   -2.4   → "+2.4"   ("plus 2.4" — better-than-scratch player who gives
 *                      strokes back to the course rather than receiving them)
 *   null   → fallback ("—" by default)
 *
 * Negative handicaps must never render with a literal minus sign — by
 * convention a sub-scratch index is read as "plus X." Centralised here so
 * every screen surfaces the same shape.
 */
export function fmtHandicap(
  hi: number | null | undefined,
  fallback: string = '—',
): string {
  if (hi == null || isNaN(hi)) return fallback;
  if (hi < 0) return `+${(-hi).toFixed(1)}`;
  return hi.toFixed(1);
}

// ─── Score display ──────────────────────────────────────────────────────────

/**
 * Pro-rate a teebox's full par to the number of holes a player actually
 * completed. Teeboxes in the DB store their full-layout par (par 72 for
 * an 18-hole teebox, par 36 for a 9-hole teebox). A 9-hole round of an
 * 18-hole teebox should compare against ~36, not 72, otherwise a 41
 * (over par for 9) reads as "−31" for the day.
 *
 *   parForHolesPlayed(72,  9) → 36
 *   parForHolesPlayed(72, 18) → 72
 *   parForHolesPlayed(70,  9) → 35   (rounded; assumes even nines)
 *
 * Returns null when teeboxPar is null. Falls back to teeboxPar when
 * holesPlayed is null/unknown so legacy callsites keep their old behaviour
 * (and 18-hole rounds, the common case, are unaffected).
 */
export function parForHolesPlayed(
  teeboxPar: number | null | undefined,
  holesPlayed: number | null | undefined,
  teeboxNumHoles: number = 18,
): number | null {
  if (teeboxPar == null) return null;
  if (holesPlayed == null || holesPlayed <= 0) return teeboxPar;
  if (holesPlayed >= teeboxNumHoles)           return teeboxPar;
  return Math.round(teeboxPar * (holesPlayed / teeboxNumHoles));
}

/**
 * Total score relative to the par of the holes actually played. Negative
 * = under par, 0 = even, positive = over. Use this everywhere a round's
 * "to par" is displayed; never compute `total_score - teebox_par` raw,
 * because that breaks every 9-hole round of an 18-hole teebox.
 */
export function toParForHolesPlayed(
  totalScore: number | null | undefined,
  teeboxPar: number | null | undefined,
  holesPlayed: number | null | undefined,
  teeboxNumHoles: number = 18,
): number | null {
  if (totalScore == null) return null;
  const par = parForHolesPlayed(teeboxPar, holesPlayed, teeboxNumHoles);
  if (par == null) return null;
  return totalScore - par;
}

/** Format a `to par` integer the way scorecards do: "+3", "E", "−2".
 *  Returns "—" for null. */
export function fmtToPar(toPar: number | null | undefined): string {
  if (toPar == null) return '—';
  if (toPar > 0) return `+${toPar}`;
  if (toPar === 0) return 'E';
  return String(toPar);
}

/** Friendly label + accent color for a strokes-vs-par result.
 *  Hole-in-one wins over the par-3 eagle interpretation. */
export function scoreLabel(strokes: number, par: number): { label: string; color: string } {
  const diff = strokes - par;
  if (strokes === 1) return { label: 'Hole in One!', color: '#FFD700' };
  if (diff <= -3) return { label: 'Albatross',     color: '#FF00FF' };
  if (diff === -2) return { label: 'Eagle',        color: '#4CAF50' };
  if (diff === -1) return { label: 'Birdie',       color: '#81C784' };
  if (diff === 0)  return { label: 'Par',          color: C.text };
  if (diff === 1)  return { label: 'Bogey',        color: '#FF9800' };
  if (diff === 2)  return { label: 'Double Bogey', color: '#F44336' };
  if (diff === 3)  return { label: 'Triple Bogey', color: '#B71C1C' };
  return { label: `+${diff}`, color: '#7B1FA2' };
}

/** Cell tint for a hole's score on the scorecard grid. Eagle-or-better is
 *  a saturated green; bogey is amber; double-or-worse is red. */
export function scoreColor(score: number, par: number): string {
  const d = score - par;
  if (d <= -2) return '#4CAF50';
  if (d === -1) return '#81C784';
  if (d === 0)  return C.text;
  if (d === 1)  return '#FF9800';
  return '#F44336';
}

// ─── Visual constants ───────────────────────────────────────────────────────

/** High-contrast palette tuned to stand out against satellite imagery
 *  (greens / browns). Each successive shot on a hole picks the next color. */
export const SHOT_COLORS = [
  '#4a9eff', // bright blue
  '#e63946', // crimson
  '#ff66c4', // magenta
  '#ff9f1c', // orange
  '#00bbf9', // cyan
  '#9d4edd', // violet
  '#ffd60a', // school-bus yellow
] as const;
