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

/** Minimal RFC-4180 line tokenizer. Splits a single CSV line on `delim`
 *  while respecting double-quoted fields (so a delimiter inside "…" is kept
 *  as data), unescaping doubled quotes ("") and stripping the surrounding
 *  quotes. Launch-monitor exports quote club names/notes containing commas
 *  (e.g. "Driver, 10.5°"); a naive split() would shift every later column. */
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;                            // closing quote
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Sniff the delimiter from the header line: whichever of comma / semicolon /
 *  tab appears most (outside quotes). European exports use ';' so a comma
 *  decimal separator doesn't clash. Defaults to comma. */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = splitCsvLine(headerLine, d).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

export function parseCSV(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) {
    return { shots: [], perClubCounts: {}, unmappedClubs: [], rowsSkipped: 0 };
  }

  // Detect the delimiter from the header so European semicolon/tab exports
  // work, then use that SAME delimiter for every row below.
  const delim = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delim).map((h) => normalizeHeader(h));
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
  // NOTE: do NOT match the bare "time" header — Flightscope and Trackman both
  // use "Time" for ball flight time (a number of seconds), not a timestamp.
  // We only accept headers that explicitly say date/timestamp.
  const colDate    = idx('date', 'date time', 'datetime', 'timestamp', 'date/time');

  if (colClub < 0 || colDist < 0) {
    return { shots: [], perClubCounts: {}, unmappedClubs: [], rowsSkipped: 0 };
  }

  const shots: ImportedShot[] = [];
  const perClubCounts: Record<string, number> = {};
  const unmappedClubs = new Set<string>();
  let rowsSkipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delim);
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
    // Only forward `recorded_at` if it actually parses as a real date — guards
    // against vendor CSVs putting a flight-time number under a header we
    // misidentified as a timestamp.
    let recorded_at: string | undefined;
    if (colDate >= 0) {
      const raw = cells[colDate]?.trim();
      if (raw) {
        const t = Date.parse(raw);
        if (Number.isFinite(t)) recorded_at = new Date(t).toISOString();
      }
    }

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
