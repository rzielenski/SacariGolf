/**
 * CPU opponents.
 *
 * A pool of bot accounts, one per rank, so a player who finds no human
 * opponent within a few hours still gets a match resolved instead of waiting
 * forever. Design rules:
 *
 *   • One bot per individual rank (Wood IV … Diamond I, plus Obsidian). Each
 *     bot sits at the MIDPOINT ELO of its division.
 *   • Skill is anchored so DIAMOND ≈ SCRATCH (handicap 0) and scales linearly:
 *     every ~37.5 ELO below Diamond's floor (1300) is +1 stroke of handicap,
 *     so Wood is a ~32-handicap and Obsidian plays a couple under.
 *   • Bots NEVER gain or lose ELO — their rating only marks their skill band.
 *   • Bots are hidden from leaderboards / feed / search (users.is_bot), and
 *     only fill SOLO matches, and only after the human has waited a while.
 *
 * Resolution reuses the exact ELO helpers from routes/matches (diff18,
 * expectedScore, kFactor, shapeDelta, placementUserSet) so a bot match scores
 * identically to a human one — including the asymmetric win gain.
 */

import pool from '../db/pool';
import { diff18, expectedScore, kFactor, shapeDelta, placementUserSet } from '../routes/matches';
import { notifyMatchResolved } from './notifyFomo';

const DIAMOND_FLOOR = 1300;          // ELO at which a bot plays scratch
const ELO_PER_STROKE = 37.5;         // ELO below Diamond per +1 handicap stroke
const BOT_MATCH_AFTER_HOURS = 3;     // only sub in a bot after this much waiting

const TIERS: [string, string, number][] = [
  ['wood', 'Wood', 100], ['bronze', 'Bronze', 300], ['silver', 'Silver', 500],
  ['gold', 'Gold', 700], ['platinum', 'Platinum', 900], ['ruby', 'Ruby', 1100],
  ['diamond', 'Diamond', 1300],
];

// Real-looking player names, ordered weakest → strongest: one per division
// (Wood IV … Diamond I) then Obsidian last. Assigned positionally so the pool
// is stable across seeds; the email/key — not the name — is the idempotency
// key, so a bot can be renamed here without orphaning its account.
const BOT_NAMES = [
  'Pete Hargrove', 'Marcus Webb', 'Tyler Boone', 'Greg Almeida',        // Wood IV..I
  'Sam Whitfield', 'Andre Coleman', 'Nico Park', 'Russ Dalton',         // Bronze IV..I
  'Cole Bishop', 'Javier Mendez', 'Brett Sandoval', 'Owen Fletcher',    // Silver IV..I
  'Damon Reyes', 'Will Castellano', 'Theo Brandt', 'Hank Mercer',       // Gold IV..I
  'Elliot Vance', 'Jonah Pruitt', 'Caleb Ostrander', 'Reid Calloway',   // Platinum IV..I
  'Victor Salas', 'Dominic Hale', 'Asher Quinn', 'Lucas Behrens',       // Ruby IV..I
  'Spencer Wolfe', 'Adrian Cross', 'Roman Sato', 'Julian Frost',        // Diamond IV..I
  'Maxwell Sterling',                                                    // Obsidian
];

/** Strokes over a scratch 18-hole round for a bot at this ELO. Diamond floor
 *  (1300) = 0; clamped so the worst bot is ~36 and the best plays ~3 under. */
function handicapForElo(elo: number): number {
  const h = (DIAMOND_FLOOR - elo) / ELO_PER_STROKE;
  return Math.max(-3, Math.min(36, Math.round(h * 10) / 10));
}

interface BotRank { key: string; username: string; email: string; elo: number; handicap: number }

const BOT_RANKS: BotRank[] = (() => {
  const out: BotRank[] = [];
  let n = 0;
  for (const [key, , floor] of TIERS) {
    for (let div = 4; div >= 1; div--) {
      const elo = floor + (4 - div) * 50 + 25;   // division midpoint
      out.push({ key: `${key}${div}`, username: BOT_NAMES[n++],
                 email: `bot+${key}${div}@sacarigolf.bot`, elo, handicap: handicapForElo(elo) });
    }
  }
  out.push({ key: 'obsidian', username: BOT_NAMES[n++], email: 'bot+obsidian@sacarigolf.bot',
             elo: 1550, handicap: handicapForElo(1550) });
  return out;
})();

/** Create / refresh the bot accounts. Idempotent: inserts only what's missing
 *  (guarding both email and username), and keeps each bot's ELO + handicap in
 *  sync if the midpoints ever change. */
export async function seedBots(): Promise<void> {
  for (const b of BOT_RANKS) {
    try {
      await pool.query(
        `INSERT INTO users (username, email, elo, handicap_index, is_bot, email_verified)
         SELECT $1, $2, $3, $4, TRUE, TRUE
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $2 OR username = $1)`,
        [b.username, b.email, b.elo, b.handicap],
      );
      // Keep ELO/handicap in sync AND migrate the username to the curated
      // real-looking name — but only if no OTHER account already holds it
      // (case-insensitive), so we never collide with a real user.
      await pool.query(
        `UPDATE users u
            SET elo = $2, handicap_index = $3, is_bot = TRUE,
                username = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM users o
                     WHERE lower(o.username) = lower($4) AND o.user_id <> u.user_id
                  ) THEN u.username ELSE $4 END
          WHERE u.email = $1`,
        [b.email, b.elo, b.handicap, b.username],
      );
    } catch (err) {
      console.error('[bots] seed failed for', b.username, err);
    }
  }
}

/** Build a plausible per-hole scorecard summing exactly to `total`, with
 *  values clustered around par (≈ total/holes). Stays sum-exact. */
function distributeScores(total: number, holes: number): number[] {
  const base = Math.floor(total / holes);
  let rem = total - base * holes;
  const arr = Array(holes).fill(base);
  for (let i = 0; i < holes && rem > 0; i++) { arr[i] += 1; rem--; }
  // A few sum-preserving swaps so it doesn't read as a flat card.
  for (let k = 0; k < holes; k++) {
    const a = k % holes;
    const b = (k * 7 + 3) % holes;
    if (a !== b && arr[a] > 2) { arr[a] -= 1; arr[b] += 1; }
  }
  return arr;
}

/** Generate a bot's round for the human's teebox: a gross appropriate to the
 *  bot's skill band, plus a plausible scorecard. */
function generateBotRound(
  courseRating: number | null, teeboxHoles: number | null, holesPlayed: number, handicap: number,
): { holeScores: number[]; total: number } {
  const cr = courseRating ?? (teeboxHoles === 9 ? 35 : 70);
  const rating18 = teeboxHoles === 9 ? cr * 2 : cr;          // full-18 rating
  const expected18 = rating18 + handicap;                    // bot's expected 18-hole gross
  const hp = holesPlayed > 0 ? holesPlayed : (teeboxHoles === 9 ? 9 : 18);
  const expected = expected18 * (hp / 18);
  // Round-to-round variance: roughly ±3 strokes over 18, scaled to holes.
  const noise = (Math.random() + Math.random() - 1) * 4 * Math.sqrt(hp / 18);
  const total = Math.max(hp * 2, Math.round(expected + noise));   // never below 2/hole
  return { holeScores: distributeScores(total, hp), total };
}

/**
 * Fill stale SOLO matches with an ELO-matched bot. A match qualifies when the
 * human finished their round, no opponent ever showed, and it's been waiting
 * longer than BOT_MATCH_AFTER_HOURS. The bot "plays" the human's teebox at its
 * skill band and the match resolves immediately under the standard ELO math.
 */
export async function runBotMatchPass(): Promise<void> {
  let candidates: any[];
  try {
    const res = await pool.query(
      `SELECT m.match_id, m.num_holes, m.holes_subset,
              mp.user_id AS human_id, mp.teebox_id, u.elo AS human_elo, u.total_matches AS human_matches
         FROM matches m
         JOIN match_players mp ON mp.match_id = m.match_id AND mp.side = 1
         JOIN users u          ON u.user_id = mp.user_id
        WHERE m.completed = false AND m.cancelled = false AND m.is_practice = false
          AND m.match_type = 'solo'
          AND m.paired_match_id IS NULL
          AND m.superseded_by_match_id IS NULL
          -- Wait a few hours after the human FINISHED their round (not after
          -- the match was created) before subbing a bot in.
          AND COALESCE(mp.completed_at, m.created_at) < NOW() - INTERVAL '${BOT_MATCH_AFTER_HOURS} hours'
          AND u.is_bot = false
          AND mp.completed = true
          AND NOT EXISTS (SELECT 1 FROM match_players x WHERE x.match_id = m.match_id AND x.side <> 1)`,
    );
    candidates = res.rows;
  } catch (err) {
    console.error('[bots] candidate query failed:', err);
    return;
  }

  for (const c of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check under a row lock — a human pairing or the 3-day cron may have
      // grabbed this match between the read and now.
      const { rows: lock } = await client.query(
        `SELECT completed, cancelled, paired_match_id, superseded_by_match_id
           FROM matches WHERE match_id = $1 FOR UPDATE`, [c.match_id],
      );
      const m = lock[0];
      if (!m || m.completed || m.cancelled || m.paired_match_id || m.superseded_by_match_id) {
        await client.query('ROLLBACK'); continue;
      }
      const { rows: oppCheck } = await client.query(
        `SELECT 1 FROM match_players WHERE match_id = $1 AND side <> 1`, [c.match_id],
      );
      if (oppCheck.length) { await client.query('ROLLBACK'); continue; }

      // Teebox + the human's round.
      const { rows: tRows } = await client.query(
        `SELECT course_rating, slope_rating, num_holes,
                front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
           FROM teeboxes WHERE teebox_id = $1`, [c.teebox_id],
      );
      const { rows: hrRows } = await client.query(
        `SELECT total_score, COALESCE(array_length(hole_scores, 1), $2) AS holes_played
           FROM rounds WHERE match_id = $1 AND user_id = $3`,
        [c.match_id, c.num_holes ?? 18, c.human_id],
      );
      const t = tRows[0];
      const hr = hrRows[0];
      if (!t || !hr || hr.total_score == null) { await client.query('ROLLBACK'); continue; }
      const holesPlayed = Number(hr.holes_played) || c.num_holes || 18;

      // Pick the ELO-closest bot.
      const humanElo = Number(c.human_elo) || 100;
      const bot = [...BOT_RANKS].sort((a, b) => Math.abs(a.elo - humanElo) - Math.abs(b.elo - humanElo))[0];
      const { rows: botRows } = await client.query(
        `SELECT user_id, elo FROM users WHERE email = $1 AND is_bot = TRUE`, [bot.email],
      );
      if (!botRows.length) { await client.query('ROLLBACK'); continue; }
      const botId = botRows[0].user_id as string;
      const botElo = Number(botRows[0].elo) || bot.elo;

      // Bot plays a RANDOM course (not the human's) at its skill band — an
      // opponent that always plays your exact course reads as fake. The 1v1
      // result compares score DIFFERENTIALS, so different courses still match
      // up fairly. Falls back to the human's teebox if no other is available.
      const { rows: btRows } = await client.query(
        `SELECT teebox_id, course_rating, slope_rating, num_holes
           FROM teeboxes
          WHERE course_rating IS NOT NULL AND slope_rating IS NOT NULL
            AND num_holes >= $1
          ORDER BY random() LIMIT 1`,
        [holesPlayed],
      );
      const bt = btRows[0] ?? {
        teebox_id: c.teebox_id, course_rating: t.course_rating,
        slope_rating: t.slope_rating, num_holes: t.num_holes,
      };

      const { holeScores, total: botGross } = generateBotRound(
        bt.course_rating, bt.num_holes, holesPlayed, bot.handicap,
      );

      // Insert the bot as side 2 + its round, on the bot's own (random) teebox.
      await client.query(
        `INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
         VALUES ($1, $2, $3, 2, $4, TRUE)
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [c.match_id, botId, bt.teebox_id, botGross],
      );
      await client.query(
        `INSERT INTO rounds (match_id, user_id, teebox_id, hole_scores, total_score, round_type)
         VALUES ($1, $2, $3, $4, $5, 'solo')
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [c.match_id, botId, bt.teebox_id, holeScores, botGross],
      );

      // ── Resolve (1v1, human vs bot) reusing the standard ELO math ──────
      // Each side's differential is computed on its OWN course/teebox.
      const subset = c.holes_subset as ('front' | 'back' | 'full' | null);
      const overrideRating = subset === 'front' ? t.front_course_rating : subset === 'back' ? t.back_course_rating : null;
      const overrideSlope  = subset === 'front' ? t.front_slope_rating  : subset === 'back' ? t.back_slope_rating  : null;

      const humanDiff = diff18(Number(hr.total_score), t.course_rating, t.slope_rating, holesPlayed, t.num_holes ?? holesPlayed, overrideRating, overrideSlope);
      const botDiff   = diff18(botGross, bt.course_rating, bt.slope_rating, holesPlayed, bt.num_holes ?? holesPlayed, null, null);

      const isTie = Math.abs(humanDiff - botDiff) < 0.05;
      const humanWins = !isTie && humanDiff < botDiff;          // lower differential wins
      const expA = expectedScore(humanElo, botElo);
      const k = kFactor(Number(c.human_matches) || 0, humanElo);
      const actual = isTie ? 0.5 : (humanWins ? 1 : 0);
      const base = k * (actual - expA);
      const placement = await placementUserSet(client, [c.human_id], c.match_id);
      const delta = shapeDelta(base, humanWins, placement.has(c.human_id));

      // Only the human's ELO moves; the bot's rating is fixed.
      await client.query(
        `UPDATE users
            SET elo = GREATEST(100, elo + $1),
                total_matches = total_matches + 1,
                total_wins = total_wins + $2,
                total_ties = total_ties + $3
          WHERE user_id = $4`,
        [delta, humanWins ? 1 : 0, isTie ? 1 : 0, c.human_id],
      );
      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
                                    side2_score_differential, delta_elo, details)
         VALUES ($1, 'solo', $2, $3, $4, $5, $6)`,
        [
          c.match_id,
          isTie ? null : (humanWins ? 1 : 2),
          humanDiff, botDiff, Math.abs(delta),
          JSON.stringify({ bot: true, botId, tied: isTie, playerDeltas: { [c.human_id]: delta } }),
        ],
      );
      await client.query(`UPDATE matches SET completed = TRUE WHERE match_id = $1`, [c.match_id]);
      // Round post for the HUMAN only (bots never post — see backfillRoundPosts).
      await client.query(
        `INSERT INTO posts (user_id, kind, match_id, body)
         SELECT $1, 'round', $2, r.caption FROM rounds r WHERE r.match_id = $2 AND r.user_id = $1`,
        [c.human_id, c.match_id],
      );

      await client.query('COMMIT');
      console.log(`[bots] resolved ${c.match_id}: human ${humanWins ? 'beat' : isTie ? 'tied' : 'lost to'} ${bot.username} (Δelo ${delta})`);
      // FOMO push: tell the human their round was matched + the result/swing.
      notifyMatchResolved(c.match_id).catch(() => {});
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[bots] match fill failed:', err);
    } finally {
      client.release();
    }
  }
}
