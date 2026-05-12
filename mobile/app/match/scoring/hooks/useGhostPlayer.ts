/**
 * Procedural "ghost player" — a fictional opponent named "harryfoot potter"
 * whose shot path is drawn faintly on each hole for the player to chase. No
 * scoring, no real interaction, no server data — pure client-side eye candy.
 *
 *   const ghost = useGhostPlayer({ hole, knownPin, userCoord, userHandicap });
 *
 * Generation rules:
 *   • Ghost plays at handicap = max(0, userHandicap − 3) — "slightly better"
 *   • Target score = par + round(ghostHandicap / 18) — handicap allocated
 *     uniformly across the round
 *   • Two putts assumed; everything else is a "long shot"
 *   • Long shots interpolate from tee → pin with lateral and longitudinal
 *     scatter scaled by ghost handicap (tighter for scratch, wider for high
 *     handicaps) — gives the path some visual interest instead of a straight
 *     line
 *   • Final long shot lands within ~5 yds of the pin so the putt segments
 *     don't span half the green
 *
 * Tee location: snapshot of the player's GPS the first time they're on the
 * hole. Stored in a ref keyed by hole_id so the ghost doesn't shift if the
 * player walks. Re-generated when the hole changes.
 *
 * Determinism: a seeded mulberry32 PRNG (seed derived from hole_id) means the
 * ghost's path is stable across renders — no shimmer. Different holes get
 * different paths; the same hole re-opened later draws the same ghost path.
 */

import { useMemo, useRef } from 'react';
import { bearingDeg, distYards, projectYards } from '../../../../lib/golfMath';

/** Public-facing ghost name. Pure flavor — appears beside the path on the map. */
export const GHOST_NAME = 'harryfoot potter';

interface GhostInputs {
  holeId: string | null | undefined;
  holePar: number | null | undefined;
  knownPin: { lat: number; lng: number } | null;
  userCoord: { latitude: number; longitude: number } | null;
  /** Player's current handicap index. Defaults to 18 for fresh accounts
   *  so the ghost isn't impossibly good before the player has been rated. */
  userHandicap: number | null | undefined;
}

export interface GhostShot {
  start: { lat: number; lng: number };
  end:   { lat: number; lng: number };
  /** True for the final per-hole putt — rendered differently (tighter). */
  isPutt: boolean;
}

export interface GhostPath {
  shots: GhostShot[];
  /** Strokes the ghost takes on the hole (== shots.length). */
  targetScore: number;
  /** Effective ghost handicap used to size the scatter. */
  ghostHandicap: number;
}

/** Hash a string → 32-bit integer. Used to seed the per-hole PRNG so the
 *  same hole always renders the same ghost path. */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast deterministic PRNG. Returns numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert a uniform [0,1) into a roughly-normal sample in [-1, 1] via a
 *  cheap sum-of-two trick. Box-Muller is overkill for visual placement. */
const norm = (r: () => number) => (r() + r()) - 1;

export function useGhostPlayer({
  holeId, holePar, knownPin, userCoord, userHandicap,
}: GhostInputs): GhostPath | null {
  // First GPS-locked frame on a hole = "tee" for the ghost. Stable per hole.
  const teeByHole = useRef<Record<string, { lat: number; lng: number }>>({});
  if (holeId && userCoord && !teeByHole.current[holeId]) {
    teeByHole.current[holeId] = {
      lat: userCoord.latitude, lng: userCoord.longitude,
    };
  }

  return useMemo<GhostPath | null>(() => {
    if (!holeId || !knownPin || holePar == null) return null;
    const tee = teeByHole.current[holeId];
    if (!tee) return null;

    const userHcap = typeof userHandicap === 'number' ? userHandicap : 18;
    const ghostHcap = Math.max(0, userHcap - 3);
    // Target hole score: par + handicap allocation per hole (rounded). For
    // an 18-cap that's par+1 every hole; a scratch ghost (hcap=0) plays par.
    const targetScore = Math.max(2, holePar + Math.round(ghostHcap / 18));

    const putts = 2;
    const longShots = Math.max(1, targetScore - putts);

    // Geometry
    const totalYds = distYards(tee.lat, tee.lng, knownPin.lat, knownPin.lng);
    if (totalYds < 5) return null;   // tee == pin, nothing meaningful to draw
    const aim = bearingDeg(tee.lat, tee.lng, knownPin.lat, knownPin.lng);

    // Scatter scale — tight for low handicap, generous for high. Lateral
    // (off-line) is smaller than longitudinal (distance error) because
    // amateurs miss more long/short than left/right at typical scales.
    const latStd  = 5 + ghostHcap * 1.2;    // yds
    const longStd = 8 + ghostHcap * 1.8;    // yds

    const rand = mulberry32(hashStr(holeId));

    const shots: GhostShot[] = [];
    let cursor = { ...tee };

    for (let i = 0; i < longShots; i++) {
      const isLast = i === longShots - 1;
      const baseProgress = (i + 1) / longShots;
      let forwardYds: number;
      let lateralYds: number;
      if (isLast) {
        // Final approach: must land near the pin so the putts make sense.
        forwardYds = totalYds + norm(rand) * 4;       // ±4 yds long/short
        lateralYds = norm(rand) * 6;                  // tight near green
      } else {
        forwardYds = totalYds * baseProgress + norm(rand) * longStd;
        lateralYds = norm(rand) * latStd;
        // Clamp so layup shots don't visually overshoot the green or land
        // ridiculously short of where progress would put them.
        forwardYds = Math.max(forwardYds, totalYds * baseProgress * 0.6);
        forwardYds = Math.min(forwardYds, totalYds * baseProgress + longStd * 1.5);
      }
      const end = projectYards(tee.lat, tee.lng, aim, forwardYds, lateralYds);
      shots.push({ start: cursor, end, isPutt: false });
      cursor = end;
    }

    // Two putts: cursor → mid → pin. Keeps the polyline visually distinct
    // from a single straight line to the cup.
    for (let i = 0; i < putts; i++) {
      const isLast = i === putts - 1;
      const end = isLast
        ? { lat: knownPin.lat, lng: knownPin.lng }
        : { lat: (cursor.lat + knownPin.lat) / 2, lng: (cursor.lng + knownPin.lng) / 2 };
      shots.push({ start: cursor, end, isPutt: true });
      cursor = end;
    }

    return { shots, targetScore, ghostHandicap: ghostHcap };
  }, [holeId, holePar, knownPin?.lat, knownPin?.lng, userHandicap, userCoord]);
}
