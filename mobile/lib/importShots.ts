/**
 * Parses launch-monitor CSV exports (Flightscope, Trackman, Mevo, etc.)
 * into the shape our /users/me/import-shots endpoint accepts.
 *
 * Detects columns by header name so the same parser works across vendors —
 * different brands name distance "Carry", "Carry Distance", "Total", etc.
 * Skips Avg/Dev/Std summary rows automatically.
 */

export type ImportedShot = {
  club: string;            // Sacari club code (driver, 7i, pw, ...)
  distance_yds: number;    // Total distance in yards
  lateral_yds?: number;    // Signed: positive = right, negative = left
  recorded_at?: string;    // ISO timestamp if the CSV has one
};

export interface ParseResult {
  shots: ImportedShot[];
  perClubCounts: Record<string, number>;
  unmappedClubs: string[];   // raw names that didn't match our codes
  rowsSkipped: number;        // rows dropped (avg/dev/missing data)
}

/** Map vendor-specific club names → our internal codes. */
const CLUB_ALIASES: Record<string, string> = {
  // Driver & woods
  'driver': 'driver',
  'd': 'driver',
  '3 wood': '3w',  '3w': '3w', '3-wood': '3w', 'fairway 3': '3w',
  '5 wood': '5w',  '5w': '5w', '5-wood': '5w', 'fairway 5': '5w',
  '7 wood': '7w',  '7w': '7w', '7-wood': '7w',
  // Hybrids — collapse all hybrids to one bucket since the schema only has 'hybrid'
  '2 hybrid': 'hybrid', '3 hybrid': 'hybrid', '4 hybrid': 'hybrid', '5 hybrid': 'hybrid',
  'hybrid': 'hybrid', '2h': 'hybrid', '3h': 'hybrid', '4h': 'hybrid', '5h': 'hybrid',
  // Irons
  '2 iron': '2i', '2i': '2i',
  '3 iron': '3i', '3i': '3i',
  '4 iron': '4i', '4i': '4i',
  '5 iron': '5i', '5i': '5i',
  '6 iron': '6i', '6i': '6i',
  '7 iron': '7i', '7i': '7i',
  '8 iron': '8i', '8i': '8i',
  '9 iron': '9i', '9i': '9i',
  // Wedges
  'pitching wedge': 'pw', 'pw': 'pw', 'p wedge': 'pw',
  'gap wedge':      'gw', 'gw': 'gw', 'a wedge': 'gw', 'aw': 'gw', 'approach wedge': 'gw',
  'sand wedge':     'sw', 'sw': 'sw',
  'lob wedge':      'lw', 'lw': 'lw',
  // Putter
  'putter': 'putter', 'p': 'putter',
};

/** Parse a "12.3 R" or "4.5 L" or "8" lateral cell to a signed number.
 *  Returns null on garbage. Right is positive, left is negative. */
function parseLateral(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed === '-') return null;
  const m = trimmed.match(/^(-?[\d.]+)\s*([RL])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] && m[2].toUpperCase() === 'L') return -n;
  return n;
}

function parseDist(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
}

/** Header-name normalizer — lowercase + strip units/punctuation. */
function normalizeHeader(h: string) {
  return h.toLowerCase().replace(/\s*\(.*?\)/g, '').replace(/[_\-]+/g, ' ').trim();
}

export function parseCSV(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) {
    return { shots: [], perClubCounts: {}, unmappedClubs: [], rowsSkipped: 0 };
  }

  const headers = lines[0].split(',').map((h) => normalizeHeader(h));
  const idx = (...candidates: string[]) => {
    for (const c of candidates) {
      const i = headers.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const colClub    = idx('club', 'club name');
  // Prefer Total over Carry — matches what shows on a course (carry + roll).
  const colDist    = idx('total', 'total distance', 'carry', 'carry distance');
  const colLateral = idx('lateral', 'lateral distance', 'side', 'offline');
  const colShot    = idx('shot', 'shot #', '#');
  const colDate    = idx('date', 'time', 'timestamp');

  if (colClub < 0 || colDist < 0) {
    return { shots: [], perClubCounts: {}, unmappedClubs: [], rowsSkipped: 0 };
  }

  const shots: ImportedShot[] = [];
  const perClubCounts: Record<string, number> = {};
  const unmappedClubs = new Set<string>();
  let rowsSkipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const rawClub = cells[colClub]?.trim();
    if (!rawClub) { rowsSkipped++; continue; }

    // Skip Avg/Dev/Std/Total summary rows.
    const shotCell = colShot >= 0 ? cells[colShot]?.trim().toLowerCase() : '';
    if (shotCell && /^(avg|average|dev|std|stdev|total)$/.test(shotCell)) {
      rowsSkipped++; continue;
    }

    const code = CLUB_ALIASES[rawClub.toLowerCase()];
    if (!code) {
      unmappedClubs.add(rawClub);
      rowsSkipped++; continue;
    }

    const distance_yds = parseDist(cells[colDist] ?? '');
    if (distance_yds == null || distance_yds < 5 || distance_yds > 500) {
      rowsSkipped++; continue;
    }
    const lateral_yds = colLateral >= 0 ? (parseLateral(cells[colLateral]) ?? undefined) : undefined;
    const recorded_at = colDate >= 0 ? (cells[colDate]?.trim() || undefined) : undefined;

    shots.push({ club: code, distance_yds, lateral_yds, recorded_at });
    perClubCounts[code] = (perClubCounts[code] ?? 0) + 1;
  }

  return {
    shots,
    perClubCounts,
    unmappedClubs: Array.from(unmappedClubs),
    rowsSkipped,
  };
}
