/**
 * What is the ball sitting on?
 *
 * Turns the player-traced polygons (the web shape editor) into the two things
 * the physics needs: the LIE the ball is played from (lib/lie.ts) and the
 * SURFACE it lands on (lib/ballFlight.ts). Without this the simulator has to
 * assume fairway everywhere, which is the assumption the polygon editor was
 * built to remove.
 */
import { Surface } from './ballFlight';
import { LieSurface } from './lie';

/** A traced shape, as the API returns it. */
export interface CoursePolygon {
  polygon_id: string;
  hole_num: number | null;
  kind: string;
  ring: [number, number][];
  min_lat: number; max_lat: number; min_lng: number; max_lng: number;
}

/**
 * Precedence when shapes overlap, most specific first.
 *
 * Overlap is normal and intended: a bunker is traced INSIDE the fairway it
 * sits in, a green inside its surround. Whichever feature is more specific
 * has to win, so this is an explicit order rather than "whatever was drawn
 * last" — which would make the answer depend on the order players happened to
 * trace things in.
 */
const PRECEDENCE = [
  'water', 'oob', 'bunker', 'green', 'tee', 'path', 'trees', 'native', 'rough', 'fairway',
] as const;

/** Where the ball LANDS: how the ground receives a bounce. */
const LANDING_SURFACE: Record<string, Surface> = {
  green: 'green', fairway: 'fairway', tee: 'fairway', bunker: 'sand',
  rough: 'rough', native: 'native', trees: 'rough', path: 'path',
  water: 'sand', oob: 'rough',
};

/** Where the ball SITS: how the next strike comes off it. */
const LIE_FROM_KIND: Record<string, LieSurface> = {
  green: 'fairway', fairway: 'fairway', tee: 'tee', bunker: 'sand',
  rough: 'light_rough', native: 'heavy_rough', trees: 'pine_straw',
  path: 'hardpan', water: 'sand', oob: 'light_rough',
};

export type BallLocation = {
  /** The winning polygon kind, or null when the ball is outside everything traced. */
  kind: string | null;
  surface: Surface;
  lieSurface: LieSurface;
  /** Ball is in a penalty area and the shot cannot simply continue. */
  penalty: 'water' | 'oob' | null;
  label: string;
  /** False when the course has no shapes at all, so callers can say
   *  "assuming fairway" instead of quietly pretending they know. */
  mapped: boolean;
};

const UNMAPPED: BallLocation = {
  kind: null, surface: 'fairway', lieSurface: 'fairway',
  penalty: null, label: 'Fairway', mapped: false,
};

/**
 * Ray-casting point-in-polygon. The bbox test first rejects almost every
 * polygon for the cost of four comparisons, which is why the bbox columns are
 * denormalised onto the row.
 */
function inRing(lat: number, lng: number, p: CoursePolygon): boolean {
  if (lat < p.min_lat || lat > p.max_lat || lng < p.min_lng || lng > p.max_lng) return false;
  const r = p.ring;
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [yi, xi] = r[i];
    const [yj, xj] = r[j];
    // Half-open edge test, so a point exactly on a shared edge lands in
    // exactly one of two adjacent shapes rather than both or neither.
    if ((yi > lat) !== (yj > lat)) {
      const xInt = xi + ((lat - yi) / (yj - yi)) * (xj - xi);
      if (lng < xInt) inside = !inside;
    }
  }
  return inside;
}

const LABELS: Record<string, string> = {
  green: 'Green', fairway: 'Fairway', tee: 'Tee box', bunker: 'Bunker',
  water: 'Water', rough: 'Rough', native: 'Native area', trees: 'Trees',
  path: 'Cart path', oob: 'Out of bounds',
};

/**
 * Classify a position against the course's traced shapes.
 *
 * `holeNum` narrows to shapes tagged for that hole plus course-wide ones, so a
 * neighbouring hole's fairway can't claim a ball.
 */
export function locateBall(
  lat: number, lng: number,
  polygons: CoursePolygon[] | null,
  holeNum?: number | null,
): BallLocation {
  if (!polygons || !polygons.length) return UNMAPPED;

  const relevant = polygons.filter(
    (p) => p.hole_num == null || holeNum == null || p.hole_num === holeNum,
  );
  const hits = new Set<string>();
  for (const p of relevant) if (inRing(lat, lng, p)) hits.add(p.kind);

  if (!hits.size) {
    // The course IS mapped, the ball just isn't on anything traced. That's
    // rough, not fairway — assuming fairway would quietly reward a bad shot.
    return {
      kind: null, surface: 'rough', lieSurface: 'light_rough',
      penalty: null, label: 'Rough (unmapped)', mapped: true,
    };
  }
  const kind = PRECEDENCE.find((k) => hits.has(k)) ?? [...hits][0];
  return {
    kind,
    surface: LANDING_SURFACE[kind] ?? 'fairway',
    lieSurface: LIE_FROM_KIND[kind] ?? 'fairway',
    penalty: kind === 'water' ? 'water' : kind === 'oob' ? 'oob' : null,
    label: LABELS[kind] ?? kind,
    mapped: true,
  };
}
