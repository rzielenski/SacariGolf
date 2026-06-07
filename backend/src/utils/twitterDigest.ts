/**
 * Once-a-day @Sacari Twitter/X digest.
 *
 * A single light, funny recap tweet summarising the day on the app:
 * how many rounds were played, how many balls drowned, the round of the day,
 * and the player who lost the most balls ("Richard lost 13 balls today").
 *
 * Privacy: a player is only ever named after they opt in
 * (users.share_to_twitter — set via PATCH /users/me). Everyone else folds
 * into anonymous app-wide totals ("Someone out there lost 13 balls today").
 *
 * Scheduling: a 15-minute tick fires runDailyDigest(); once the local clock
 * (DIGEST_TZ) passes DIGEST_HOUR and the day hasn't been handled yet, it
 * composes + posts one tweet and records the day in `digest_log` so a restart
 * or a later tick never double-posts. Quiet days (no activity) are recorded
 * but not tweeted.
 *
 * Config (all optional):
 *   DIGEST_TZ    — IANA tz for "today" / the post time. Default America/New_York.
 *   DIGEST_HOUR  — hour (0-23) after which the day's digest goes out. Default 20.
 *   plus the TWITTER_* creds consumed by utils/tweet.ts.
 */
import pool from '../db/pool';
import { postTweet, isConfigured } from './tweet';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PersonStat {
  username: string;
  optedIn: boolean;
  count: number;
}
interface RoundStat {
  username: string;
  course: string | null;
  toPar: number;
  holes: number;
}
export interface DigestStats {
  roundsToday: number;
  ballsLost: number;
  ballsFound: number;
  topLoser: PersonStat | null;
  topFinder: PersonStat | null;
  roundOfDay: RoundStat | null;
}

// ─── Tunables ──────────────────────────────────────────────────────────────

// Only call out a ball-loser / finder when the count is actually funny.
const LOSER_MIN = 5;
const FINDER_MIN = 6;
// A round only counts toward "round of the day" once at least a 9 is in, and
// its computed to-par must be sane (guards against bad teebox par data
// producing a "-40" headline).
const MIN_HOLES = 9;
const TO_PAR_FLOOR = -25;
const TO_PAR_CEIL = 60;

// ─── Pure formatting (no DB — unit-tested in tests/digestCompose.test.js) ────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function toParPhrase(toPar: number): string {
  if (toPar === 0) return 'even par';
  return toPar < 0 ? `${-toPar} under par` : `${toPar} over par`;
}

// Deterministic daily variety: same date → same quip, but it rotates day to
// day. Avoids RNG so the composed text is stable to unit-test.
function seedFrom(dateKey: string): number {
  let h = 0;
  for (let i = 0; i < dateKey.length; i++) h = (h * 31 + dateKey.charCodeAt(i)) >>> 0;
  return h;
}

const LOSER_QUIPS = [
  'Buy that human a ball retriever.',
  'The lake thanks you.',
  'Reload that sleeve. 🏌️',
  'Pro V1s are not cheap, friend.',
];
const LOSER_ANON_QUIPS = [
  "We won't name names.",
  'Their secret is safe with us.',
  'You know who you are.',
];

/**
 * Compose the digest tweet text from already-fetched stats. Returns null on a
 * genuinely quiet day (nothing worth tweeting) so the caller can skip posting.
 * Pure + deterministic given (stats, dateKey).
 */
export function composeDigest(stats: DigestStats, dateKey: string): string | null {
  const { roundsToday, ballsLost, ballsFound, topLoser, topFinder, roundOfDay } = stats;
  if (roundsToday === 0 && ballsLost === 0 && ballsFound === 0) return null;

  const seed = seedFrom(dateKey);
  const pick = <T>(arr: T[]): T => arr[seed % arr.length];

  const lines: string[] = [`⛳ Sacari recap · ${prettyDate(dateKey)}`];

  // Activity headline.
  if (roundsToday > 0) {
    let s = `${plural(roundsToday, 'round')} logged`;
    if (ballsLost > 0) s += `, ${plural(ballsLost, 'ball')} lost to the rough 💦`;
    lines.push(s + '.');
  } else if (ballsLost > 0) {
    lines.push(`${plural(ballsLost, 'ball')} lost to the rough today 💦.`);
  }

  // Round of the day (only opted-in players reach this — see fetchDigestStats).
  if (roundOfDay) {
    const at = roundOfDay.course ? ` at ${roundOfDay.course}` : '';
    lines.push(`🔥 Round of the day: ${roundOfDay.username} shot ${toParPhrase(roundOfDay.toPar)}${at}.`);
  }

  // The "Richard lost 13 balls today" line.
  if (topLoser && topLoser.count >= LOSER_MIN) {
    if (topLoser.optedIn) {
      lines.push(`🌊 ${topLoser.username} lost ${topLoser.count} balls today. ${pick(LOSER_QUIPS)}`);
    } else {
      lines.push(`🌊 Someone out there lost ${topLoser.count} balls today. ${pick(LOSER_ANON_QUIPS)}`);
    }
  }

  // Ball-finder shout-out (opted-in only, and not the same person we just
  // roasted for losing them).
  if (
    topFinder &&
    topFinder.optedIn &&
    topFinder.count >= FINDER_MIN &&
    (!topLoser || topFinder.username !== topLoser.username)
  ) {
    lines.push(`🦅 ${topFinder.username} fished out ${topFinder.count} balls. Net positive.`);
  }

  // Header only = nothing real to say.
  if (lines.length <= 1) return null;

  let text = lines.join('\n');
  if (text.length > 280) text = text.slice(0, 279).trimEnd() + '…';
  return text;
}

// ─── Data fetch (DB) ─────────────────────────────────────────────────────────

// "Since local midnight today" in the given tz, as a timestamptz. AT TIME ZONE
// twice: timestamptz → local wall clock → truncate to the day → back to an
// instant. Keeps the day boundary correct without any JS date math.
const DAY_START = `(date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1)`;

export async function fetchDigestStats(tz: string): Promise<DigestStats> {
  const totals = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM rounds r
         WHERE r.created_at >= ${DAY_START} AND r.total_score IS NOT NULL)::int AS rounds_today,
       (SELECT COUNT(*) FROM ball_log b
         WHERE b.kind = 'lost'  AND b.created_at >= ${DAY_START})::int AS balls_lost,
       (SELECT COUNT(*) FROM ball_log b
         WHERE b.kind = 'found' AND b.created_at >= ${DAY_START})::int AS balls_found`,
    [tz],
  );

  const person = async (kind: 'lost' | 'found'): Promise<PersonStat | null> => {
    const { rows } = await pool.query(
      `SELECT u.username, u.share_to_twitter AS opted_in, COUNT(*)::int AS count
         FROM ball_log b
         JOIN users u ON u.user_id = b.user_id
        WHERE b.kind = $2 AND b.created_at >= ${DAY_START}
        GROUP BY u.user_id, u.username, u.share_to_twitter
        ORDER BY count DESC, u.username ASC
        LIMIT 1`,
      [tz, kind],
    );
    if (!rows.length) return null;
    return { username: rows[0].username, optedIn: !!rows[0].opted_in, count: rows[0].count };
  };

  // Round of the day — only opted-in players, since we name them. Played par is
  // summed from the actual holes played (front/back aware), the same vetted
  // formula the feed card uses, so to-par matches the in-app recap.
  const roundRows = await pool.query(
    `SELECT u.username, c.course_name AS course, r.total_score AS strokes,
            array_length(r.hole_scores, 1) AS holes,
            (SELECT SUM(h.par)::int FROM holes h
              WHERE h.teebox_id = r.teebox_id
                AND h.hole_num >= CASE WHEN m.holes_subset = 'back' THEN 10 ELSE 1 END
                AND h.hole_num <  CASE WHEN m.holes_subset = 'back' THEN 10 ELSE 1 END
                                + COALESCE(array_length(r.hole_scores, 1), t.num_holes, m.num_holes, 18)
            ) AS played_par
       FROM rounds r
       JOIN users u   ON u.user_id = r.user_id AND u.share_to_twitter = TRUE
       LEFT JOIN matches m  ON m.match_id = r.match_id
       LEFT JOIN teeboxes t ON t.teebox_id = r.teebox_id
       LEFT JOIN courses c  ON c.course_id = t.course_id
      WHERE r.created_at >= ${DAY_START}
        AND r.total_score IS NOT NULL
        AND array_length(r.hole_scores, 1) >= ${MIN_HOLES}`,
    [tz],
  );

  let roundOfDay: RoundStat | null = null;
  for (const row of roundRows.rows) {
    if (row.played_par == null) continue;
    const toPar = row.strokes - row.played_par;
    if (toPar < TO_PAR_FLOOR || toPar > TO_PAR_CEIL) continue;
    if (!roundOfDay || toPar < roundOfDay.toPar) {
      roundOfDay = { username: row.username, course: row.course ?? null, toPar, holes: row.holes };
    }
  }

  return {
    roundsToday: totals.rows[0].rounds_today,
    ballsLost: totals.rows[0].balls_lost,
    ballsFound: totals.rows[0].balls_found,
    topLoser: await person('lost'),
    topFinder: await person('found'),
    roundOfDay,
  };
}

export async function buildDigestText(tz: string, dateKey: string): Promise<string | null> {
  const stats = await fetchDigestStats(tz);
  return composeDigest(stats, dateKey);
}

// ─── Scheduler ────────────────────────────────────────────────────────────

/** Local calendar date (YYYY-MM-DD) and hour (0-23) in the given tz. */
function localNow(tz: string): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some ICU builds emit '24' for midnight
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

let running = false;

/**
 * Idempotent daily run. Safe to call on any tick: it no-ops until the local
 * hour passes DIGEST_HOUR, skips a day already recorded in digest_log, and
 * only records (claims) the day after a successful post or a deliberate quiet
 * skip — a failed post is left unrecorded so the next tick retries.
 */
export async function runDailyDigest(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!isConfigured()) return; // no creds → stay dormant, don't spam logs

    const tz = process.env.DIGEST_TZ || 'America/New_York';
    const targetHour = Math.min(23, Math.max(0, parseInt(process.env.DIGEST_HOUR || '20', 10) || 20));
    const { dateKey, hour } = localNow(tz);
    if (hour < targetHour) return;

    const seen = await pool.query(`SELECT 1 FROM digest_log WHERE digest_date = $1`, [dateKey]);
    if (seen.rowCount) return; // already handled today

    const text = await buildDigestText(tz, dateKey);

    if (text) {
      const tweetId = await postTweet(text);
      if (!tweetId) return; // post failed — leave unrecorded so we retry
      await pool.query(
        `INSERT INTO digest_log (digest_date, tweet_id) VALUES ($1, $2)
         ON CONFLICT (digest_date) DO NOTHING`,
        [dateKey, tweetId],
      );
      console.log(`[digest] posted ${dateKey} → tweet ${tweetId}`);
    } else {
      // Quiet day: record it so we don't recompute every 15 min until midnight.
      await pool.query(
        `INSERT INTO digest_log (digest_date, tweet_id) VALUES ($1, NULL)
         ON CONFLICT (digest_date) DO NOTHING`,
        [dateKey],
      );
      console.log(`[digest] quiet day ${dateKey}, nothing tweeted`);
    }
  } catch (err) {
    console.error('[digest] runDailyDigest failed:', err);
  } finally {
    running = false;
  }
}

let digestHandle: ReturnType<typeof setInterval> | null = null;

/** Start the 15-minute digest tick. Idempotent — clears any prior handle. */
export function startTwitterDigestSchedule(): void {
  stopTwitterDigestSchedule();
  if (!isConfigured()) {
    console.log('[digest] TWITTER_* env not set — daily digest disabled.');
    return;
  }
  runDailyDigest(); // catch-up on boot in case we slept through the window
  digestHandle = setInterval(runDailyDigest, 15 * 60 * 1000);
  console.log('[digest] daily Twitter digest scheduled.');
}

export function stopTwitterDigestSchedule(): void {
  if (digestHandle) {
    clearInterval(digestHandle);
    digestHandle = null;
  }
}
