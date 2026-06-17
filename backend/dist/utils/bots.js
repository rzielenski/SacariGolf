"use strict";
/**
 * CPU opponents.
 *
 * A pool of bot accounts, one per rank, so a player who finds no human
 * opponent within a few hours still gets a match resolved instead of waiting
 * forever. Design rules:
 *
 *   • Two bots per rank (a low + high sub-band of the tier), plus an Obsidian
 *     capstone — ~15 total, not one per division. Names are a mix of real-
 *     sounding players and goofy golf handles, like an actual player base.
 *   • Skill is anchored so DIAMOND ≈ SCRATCH (handicap 0) and scales linearly:
 *     every ~37.5 ELO below Diamond's floor (1300) is +1 stroke of handicap,
 *     so Wood is a ~32-handicap and Obsidian plays a couple under.
 *   • Bots NEVER gain or lose ELO — their rating only marks their skill band.
 *     They accumulate a win/loss record and round history so their profiles
 *     read like real players, but they do NOT author posts in the global feed
 *     (that just spams it) — they only appear there as a human's opponent.
 *   • Bots fill SOLO matches (1v1) AND team matches (duo = 2 bots, squad = 4),
 *     drawing a team from the nearest-ELO bots in the one-per-bracket pool.
 *     Arena (ffa) is invite-only, so it's never bot-filled.
 *   • Bots appear everywhere a real player does (search, leaderboards, feed,
 *     profiles, course records) to make the app feel populated — EXCEPT they
 *     can't win tournaments or the weekly Sacari Cup, which stay human-only.
 *     They're also skipped for push notifications (no token) and stale-match
 *     cleanup, which is correct internal logic.
 *   • backfillBotVsBotMatches seeds a one-time history of bots playing each
 *     other so the leaderboard + bot profiles look lived-in from day one.
 *
 * Resolution reuses the exact ELO helpers from routes/matches (diff18,
 * expectedScore, kFactor, shapeDelta, placementUserSet) so a bot match scores
 * identically to a human one — including the asymmetric win gain. The team
 * resolver below mirrors routes/matches' resolveElo but freezes bot ELO.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedBots = seedBots;
exports.runBotMatchPass = runBotMatchPass;
exports.runBotTeamMatchPass = runBotTeamMatchPass;
exports.backfillBotVsBotMatches = backfillBotVsBotMatches;
const pool_1 = __importDefault(require("../db/pool"));
const matches_1 = require("../routes/matches");
const notifyFomo_1 = require("./notifyFomo");
const DIAMOND_FLOOR = 1300; // ELO at which a bot plays scratch
const ELO_PER_STROKE = 37.5; // ELO below Diamond per +1 handicap stroke
const BOT_MATCH_AFTER_HOURS = 3; // only sub in a bot after this much waiting
const TIERS = [
    ['wood', 'Wood', 100], ['bronze', 'Bronze', 300], ['silver', 'Silver', 500],
    ['gold', 'Gold', 700], ['platinum', 'Platinum', 900], ['ruby', 'Ruby', 1100],
    ['diamond', 'Diamond', 1300],
];
// A mix of real-sounding names and goofy golf handles — like an actual player
// base, not a roster of obvious NPCs. Ordered weakest → strongest (low/high per
// rank); the goofier handles skew low-rank, the serious names high-rank.
// Assigned positionally; the email key (not the name) is the idempotency key,
// so a bot can be renamed here without orphaning its account.
const BOT_NAMES = [
    'Shankapotamus', 'Mulligan Mike', // Wood   (low / high)
    'Bogey Bandit', 'Greg Almeida', // Bronze
    'Chip Shot Chad', 'Marcus Webb', // Silver
    'Sandy Bunker', 'Cole Bishop', // Gold
    'Putt Pirate', 'Elliot Vance', // Platinum
    'Shooter McGavin', 'Victor Salas', // Ruby
    'Adrian Cross', 'Roman Sato', // Diamond
    'Maxwell Sterling', // Obsidian
];
/** Strokes over a scratch 18-hole round for a bot at this ELO. Diamond floor
 *  (1300) = 0; clamped so the worst bot is ~36 and the best plays ~3 under. */
function handicapForElo(elo) {
    const h = (DIAMOND_FLOOR - elo) / ELO_PER_STROKE;
    return Math.max(-3, Math.min(36, Math.round(h * 10) / 10));
}
const DEFAULT_LOADOUT = {
    background: 'bg_default', border: 'border_classic',
    username: 'uname_default', ball_trail: 'trail_default',
};
const BOT_COSMETICS = {
    'obsidian': { background: 'bg_liquid_gold', border: 'border_plasma', username: 'uname_holographic' },
    'diamond-140': { background: 'bg_cyber_grid', border: 'border_comet', username: 'uname_ocean' },
    'diamond-60': { background: 'bg_cyber_grid', ball_trail: 'trail_galaxy' },
    'ruby-140': { background: 'bg_volcanic', border: 'border_frost', username: 'uname_fire' },
    'ruby-60': { background: 'bg_volcanic', ball_trail: 'trail_fire' },
    'platinum-140': { background: 'bg_phoenix_rise', username: 'uname_sunset' },
    'platinum-60': { border: 'border_inferno', ball_trail: 'trail_phoenix' },
    'gold-140': { background: 'bg_deep_ocean' },
    'gold-60': { background: 'bg_sakura_fall' },
    'silver-140': { ball_trail: 'trail_comet' },
    // silver-60, bronze-*, wood-* → plain defaults, like casual/newer players.
};
const BOT_RANKS = (() => {
    const out = [];
    let n = 0;
    // Two bots per rank — a low and high sub-band within the tier's ~200-ELO
    // width — so matchmaking always finds a nearby-skill opponent without one
    // bot per division flooding the leaderboard.
    for (const [key, , floor] of TIERS) {
        for (const offset of [60, 140]) {
            const elo = floor + offset;
            const idx = n;
            const k = `${key}-${offset}`;
            out.push({ key: k, username: BOT_NAMES[n++],
                email: `bot+${key}${offset}@sacarigolf.bot`, elo, handicap: handicapForElo(elo),
                avatarUrl: `/avatars/bot/${idx}`, // distinct real-face portrait per bot
                cosmetics: BOT_COSMETICS[k] ?? {} });
        }
    }
    const oIdx = n;
    out.push({ key: 'obsidian', username: BOT_NAMES[n++], email: 'bot+obsidian@sacarigolf.bot',
        elo: 1550, handicap: handicapForElo(1550), avatarUrl: `/avatars/bot/${oIdx}`,
        cosmetics: BOT_COSMETICS['obsidian'] ?? {} });
    return out;
})();
/** Create / refresh the bot accounts. Idempotent: inserts only what's missing
 *  (guarding both email and username), and keeps each bot's ELO + handicap in
 *  sync if the midpoints ever change. */
async function seedBots() {
    for (const b of BOT_RANKS) {
        try {
            const cos = {
                background: b.cosmetics.background ?? DEFAULT_LOADOUT.background,
                border: b.cosmetics.border ?? DEFAULT_LOADOUT.border,
                username: b.cosmetics.username ?? DEFAULT_LOADOUT.username,
                ball_trail: b.cosmetics.ball_trail ?? DEFAULT_LOADOUT.ball_trail,
            };
            await pool_1.default.query(`INSERT INTO users (username, email, elo, handicap_index, is_bot, email_verified, avatar_url,
                            equipped_background, equipped_border, equipped_username, equipped_ball_trail)
         SELECT $1, $2, $3, $4, TRUE, TRUE, $5, $6, $7, $8, $9
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $2 OR username = $1)`, [b.username, b.email, b.elo, b.handicap, b.avatarUrl,
                cos.background, cos.border, cos.username, cos.ball_trail]);
            // Keep ELO/handicap in sync AND migrate the username to the curated
            // real-looking name — but only if no OTHER account already holds it
            // (case-insensitive), so we never collide with a real user.
            await pool_1.default.query(`UPDATE users u
            SET elo = $2, handicap_index = $3, is_bot = TRUE, avatar_url = $5,
                equipped_background = $6, equipped_border = $7,
                equipped_username = $8, equipped_ball_trail = $9,
                username = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM users o
                     WHERE lower(o.username) = lower($4) AND o.user_id <> u.user_id
                  ) THEN u.username ELSE $4 END
          WHERE u.email = $1`, [b.email, b.elo, b.handicap, b.username, b.avatarUrl,
                cos.background, cos.border, cos.username, cos.ball_trail]);
        }
        catch (err) {
            console.error('[bots] seed failed for', b.username, err);
        }
    }
    // Prune any seeded bots no longer in the roster (e.g. after shrinking from
    // one-per-division to a couple per rank, or renaming the pool). Only ever
    // touches our own bot accounts (guarded on the bot email pattern); their
    // match_players/rounds cascade away. Idempotent — a no-op once the DB
    // matches the roster.
    try {
        await pool_1.default.query(`DELETE FROM users
        WHERE is_bot = TRUE
          AND email LIKE 'bot+%@sacarigolf.bot'
          AND email <> ALL($1::text[])`, [BOT_RANKS.map((b) => b.email)]);
    }
    catch (err) {
        console.error('[bots] prune failed', err);
    }
}
/** Build a plausible per-hole scorecard summing exactly to `total`, with
 *  values clustered around par (≈ total/holes). Stays sum-exact. */
function distributeScores(total, holes) {
    const base = Math.floor(total / holes);
    let rem = total - base * holes;
    const arr = Array(holes).fill(base);
    for (let i = 0; i < holes && rem > 0; i++) {
        arr[i] += 1;
        rem--;
    }
    // A few sum-preserving swaps so it doesn't read as a flat card.
    for (let k = 0; k < holes; k++) {
        const a = k % holes;
        const b = (k * 7 + 3) % holes;
        if (a !== b && arr[a] > 2) {
            arr[a] -= 1;
            arr[b] += 1;
        }
    }
    return arr;
}
/** Generate a bot's round for a teebox: a gross appropriate to the bot's skill
 *  band, plus a plausible scorecard. */
function generateBotRound(courseRating, teeboxHoles, holesPlayed, handicap) {
    const cr = courseRating ?? (teeboxHoles === 9 ? 35 : 70);
    const rating18 = teeboxHoles === 9 ? cr * 2 : cr; // full-18 rating
    const expected18 = rating18 + handicap; // bot's expected 18-hole gross
    const hp = holesPlayed > 0 ? holesPlayed : (teeboxHoles === 9 ? 9 : 18);
    const expected = expected18 * (hp / 18);
    // Round-to-round variance: roughly ±3 strokes over 18, scaled to holes.
    const noise = (Math.random() + Math.random() - 1) * 4 * Math.sqrt(hp / 18);
    const total = Math.max(hp * 2, Math.round(expected + noise)); // never below 2/hole
    return { holeScores: distributeScores(total, hp), total };
}
/**
 * Fill stale SOLO matches with an ELO-matched bot. A match qualifies when the
 * human finished their round, no opponent ever showed, and it's been waiting
 * longer than BOT_MATCH_AFTER_HOURS. The bot "plays" the human's teebox at its
 * skill band and the match resolves immediately under the standard ELO math.
 */
async function runBotMatchPass() {
    let candidates;
    try {
        const res = await pool_1.default.query(`SELECT m.match_id, m.num_holes, m.holes_subset,
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
          AND NOT EXISTS (SELECT 1 FROM match_players x WHERE x.match_id = m.match_id AND x.side <> 1)`);
        candidates = res.rows;
    }
    catch (err) {
        console.error('[bots] candidate query failed:', err);
        return;
    }
    for (const c of candidates) {
        const client = await pool_1.default.connect();
        try {
            await client.query('BEGIN');
            // Re-check under a row lock — a human pairing or the 3-day cron may have
            // grabbed this match between the read and now.
            const { rows: lock } = await client.query(`SELECT completed, cancelled, paired_match_id, superseded_by_match_id
           FROM matches WHERE match_id = $1 FOR UPDATE`, [c.match_id]);
            const m = lock[0];
            if (!m || m.completed || m.cancelled || m.paired_match_id || m.superseded_by_match_id) {
                await client.query('ROLLBACK');
                continue;
            }
            const { rows: oppCheck } = await client.query(`SELECT 1 FROM match_players WHERE match_id = $1 AND side <> 1`, [c.match_id]);
            if (oppCheck.length) {
                await client.query('ROLLBACK');
                continue;
            }
            // Teebox + the human's round.
            const { rows: tRows } = await client.query(`SELECT course_rating, slope_rating, num_holes, course_id,
                front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
           FROM teeboxes WHERE teebox_id = $1`, [c.teebox_id]);
            const { rows: hrRows } = await client.query(`SELECT total_score, COALESCE(array_length(hole_scores, 1), $2) AS holes_played
           FROM rounds WHERE match_id = $1 AND user_id = $3`, [c.match_id, c.num_holes ?? 18, c.human_id]);
            const t = tRows[0];
            const hr = hrRows[0];
            if (!t || !hr || hr.total_score == null) {
                await client.query('ROLLBACK');
                continue;
            }
            const holesPlayed = Number(hr.holes_played) || c.num_holes || 18;
            // Pick the ELO-closest bot.
            const humanElo = Number(c.human_elo) || 100;
            const bot = [...BOT_RANKS].sort((a, b) => Math.abs(a.elo - humanElo) - Math.abs(b.elo - humanElo))[0];
            const { rows: botRows } = await client.query(`SELECT user_id, elo FROM users WHERE email = $1 AND is_bot = TRUE`, [bot.email]);
            if (!botRows.length) {
                await client.query('ROLLBACK');
                continue;
            }
            const botId = botRows[0].user_id;
            const botElo = Number(botRows[0].elo) || bot.elo;
            // Bot plays a RANDOM course (not the human's) at its skill band — an
            // opponent that always plays your exact course reads as fake. The 1v1
            // result compares score DIFFERENTIALS, so different courses still match
            // up fairly. Falls back to the human's teebox if no other is available.
            const { rows: btRows } = await client.query(`SELECT teebox_id, course_rating, slope_rating, num_holes
           FROM teeboxes
          WHERE course_rating IS NOT NULL AND slope_rating IS NOT NULL
            AND num_holes >= $1
            AND ($2::uuid IS NULL OR course_id <> $2)
          ORDER BY random() LIMIT 1`, [holesPlayed, t.course_id ?? null]);
            const bt = btRows[0] ?? {
                teebox_id: c.teebox_id, course_rating: t.course_rating,
                slope_rating: t.slope_rating, num_holes: t.num_holes,
            };
            const { holeScores, total: botGross } = generateBotRound(bt.course_rating, bt.num_holes, holesPlayed, bot.handicap);
            // Insert the bot as side 2 + its round, on the bot's own (random) teebox.
            await client.query(`INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
         VALUES ($1, $2, $3, 2, $4, TRUE)
         ON CONFLICT (match_id, user_id) DO NOTHING`, [c.match_id, botId, bt.teebox_id, botGross]);
            await client.query(`INSERT INTO rounds (match_id, user_id, teebox_id, hole_scores, total_score, round_type)
         VALUES ($1, $2, $3, $4, $5, 'solo')
         ON CONFLICT (match_id, user_id) DO NOTHING`, [c.match_id, botId, bt.teebox_id, holeScores, botGross]);
            // ── Resolve (1v1, human vs bot) reusing the standard ELO math ──────
            // Each side's differential is computed on its OWN course/teebox.
            const subset = c.holes_subset;
            const overrideRating = subset === 'front' ? t.front_course_rating : subset === 'back' ? t.back_course_rating : null;
            const overrideSlope = subset === 'front' ? t.front_slope_rating : subset === 'back' ? t.back_slope_rating : null;
            const humanDiff = (0, matches_1.diff18)(Number(hr.total_score), t.course_rating, t.slope_rating, holesPlayed, t.num_holes ?? holesPlayed, overrideRating, overrideSlope);
            const botDiff = (0, matches_1.diff18)(botGross, bt.course_rating, bt.slope_rating, holesPlayed, bt.num_holes ?? holesPlayed, null, null);
            const isTie = Math.abs(humanDiff - botDiff) < 0.05;
            const humanWins = !isTie && humanDiff < botDiff; // lower differential wins
            const expA = (0, matches_1.expectedScore)(humanElo, botElo);
            const k = (0, matches_1.kFactor)(Number(c.human_matches) || 0, humanElo);
            const actual = isTie ? 0.5 : (humanWins ? 1 : 0);
            const base = k * (actual - expA);
            const placement = await (0, matches_1.placementUserSet)(client, [c.human_id], c.match_id);
            const delta = (0, matches_1.shapeDelta)(base, humanWins, placement.has(c.human_id));
            // Display-only swing for the bot's feed card (lost when the human won).
            const botShown = isTie ? 0 : (humanWins ? -Math.abs(delta) : Math.abs(delta));
            // Only the human's ELO moves; the bot's rating is fixed.
            await client.query(`UPDATE users
            SET elo = GREATEST(100, elo + $1),
                total_matches = total_matches + 1,
                total_wins = total_wins + $2,
                total_ties = total_ties + $3
          WHERE user_id = $4`, [delta, humanWins ? 1 : 0, isTie ? 1 : 0, c.human_id]);
            // The bot keeps a real win/loss record (but NOT ELO) so its profile
            // reads like a genuine player.
            await client.query(`UPDATE users
            SET total_matches = total_matches + 1,
                total_wins = total_wins + $2,
                total_ties = total_ties + $3
          WHERE user_id = $1`, [botId, (!humanWins && !isTie) ? 1 : 0, isTie ? 1 : 0]);
            await client.query(`INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
                                    side2_score_differential, delta_elo, details)
         VALUES ($1, 'solo', $2, $3, $4, $5, $6)`, [
                c.match_id,
                isTie ? null : (humanWins ? 1 : 2),
                humanDiff, botDiff, Math.abs(delta),
                JSON.stringify({ bot: true, botId, tied: isTie, playerDeltas: { [c.human_id]: delta, [botId]: botShown } }),
            ]);
            await client.query(`UPDATE matches SET completed = TRUE WHERE match_id = $1`, [c.match_id]);
            // Round post for the HUMAN only. Bots do NOT post into the global feed
            // (it floods it); they still show as the opponent on this card and in
            // their own profile's round history.
            await client.query(`INSERT INTO posts (user_id, kind, match_id, body)
         SELECT r.user_id, 'round', $1, r.caption
           FROM rounds r WHERE r.match_id = $1 AND r.user_id = $2`, [c.match_id, c.human_id]);
            await client.query('COMMIT');
            console.log(`[bots] resolved ${c.match_id}: human ${humanWins ? 'beat' : isTie ? 'tied' : 'lost to'} ${bot.username} (Δelo ${delta})`);
            // FOMO push: tell the human their round was matched + the result/swing.
            (0, notifyFomo_1.notifyMatchResolved)(c.match_id).catch(() => { });
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error('[bots] match fill failed:', err);
        }
        finally {
            client.release();
        }
    }
}
/** Pick the `count` nearest-ELO distinct bots to `targetElo`, resolved to
 *  their live DB rows. Returns fewer than `count` only if the pool is
 *  under-seeded (the caller skips the match in that case). */
async function pickBotTeam(client, targetElo, count) {
    const ranked = [...BOT_RANKS]
        .sort((a, b) => Math.abs(a.elo - targetElo) - Math.abs(b.elo - targetElo))
        .slice(0, count);
    const { rows } = await client.query(`SELECT user_id, email, elo FROM users WHERE email = ANY($1) AND is_bot = TRUE`, [ranked.map((b) => b.email)]);
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const team = [];
    for (const b of ranked) {
        const row = byEmail.get(b.email);
        if (row)
            team.push({ user_id: row.user_id, elo: Number(row.elo) || b.elo, handicap: b.handicap, username: b.username });
    }
    return team;
}
/**
 * Fill stale DUO / SQUAD matches with an ELO-matched bot TEAM. A match
 * qualifies when every human on side 1 finished, no opponent team ever showed,
 * and the last finish was more than BOT_MATCH_AFTER_HOURS ago. The bot team
 * (one bot per human, nearest ELO) plays RANDOM courses at its skill band — an
 * opponent that always plays your exact course reads as fake — so the match
 * resolves by team score DIFFERENTIAL (the cross-course-fair comparison). The
 * hole-by-hole formats can't compare across courses, so they fall back to that
 * same differential. The bots' ratings stay frozen.
 */
async function runBotTeamMatchPass() {
    let candidates;
    try {
        const res = await pool_1.default.query(`SELECT m.match_id, m.match_type, m.num_holes, m.holes_subset, m.format,
              array_agg(mp.user_id) AS human_ids,
              avg(u.elo)::float AS avg_elo
         FROM matches m
         JOIN match_players mp ON mp.match_id = m.match_id AND mp.side = 1
         JOIN users u          ON u.user_id = mp.user_id
        WHERE m.completed = false AND m.cancelled = false AND m.is_practice = false
          AND m.match_type IN ('duo','squad')
          AND m.paired_match_id IS NULL
          AND m.superseded_by_match_id IS NULL
          AND u.is_bot = false
          AND NOT EXISTS (SELECT 1 FROM match_players x WHERE x.match_id = m.match_id AND x.side <> 1)
        GROUP BY m.match_id
       HAVING bool_and(mp.completed) = true
          AND max(COALESCE(mp.completed_at, m.created_at)) < NOW() - INTERVAL '${BOT_MATCH_AFTER_HOURS} hours'`);
        candidates = res.rows;
    }
    catch (err) {
        console.error('[bots] team candidate query failed:', err);
        return;
    }
    for (const c of candidates) {
        const client = await pool_1.default.connect();
        try {
            await client.query('BEGIN');
            const { rows: lock } = await client.query(`SELECT completed, cancelled, paired_match_id, superseded_by_match_id
           FROM matches WHERE match_id = $1 FOR UPDATE`, [c.match_id]);
            const m = lock[0];
            if (!m || m.completed || m.cancelled || m.paired_match_id || m.superseded_by_match_id) {
                await client.query('ROLLBACK');
                continue;
            }
            const { rows: oppCheck } = await client.query(`SELECT 1 FROM match_players WHERE match_id = $1 AND side <> 1`, [c.match_id]);
            if (oppCheck.length) {
                await client.query('ROLLBACK');
                continue;
            }
            // Load the human side with the same projection the live resolver uses.
            const { rows: side1 } = await client.query(`SELECT mp.user_id, mp.strokes,
                t.course_rating, t.slope_rating,
                t.front_course_rating, t.front_slope_rating,
                t.back_course_rating, t.back_slope_rating,
                t.num_holes AS teebox_num_holes, t.teebox_id, t.course_id,
                r.hole_scores,
                COALESCE(array_length(r.hole_scores, 1), $2) AS holes_played,
                u.elo, u.total_matches
           FROM match_players mp
           JOIN users u ON u.user_id = mp.user_id
           LEFT JOIN teeboxes t ON t.teebox_id = mp.teebox_id
           LEFT JOIN rounds r ON r.match_id = mp.match_id AND r.user_id = mp.user_id
          WHERE mp.match_id = $1 AND mp.side = 1`, [c.match_id, c.num_holes ?? 18]);
            const teamSize = side1.length;
            if (!teamSize || side1.some((p) => p.strokes == null)) {
                await client.query('ROLLBACK');
                continue;
            }
            // Fallback teebox (a human's) only used if the random-course pick comes
            // up empty for some bot.
            const rep = side1.find((p) => p.course_rating != null && p.slope_rating != null) ?? side1[0];
            const holesPlayed = Number(rep.holes_played) || c.num_holes || 18;
            // Courses the humans played — bots avoid these so they never read as
            // "playing your exact course".
            const humanCourseIds = side1.map((p) => p.course_id).filter(Boolean);
            const botTeam = await pickBotTeam(client, Number(c.avg_elo) || 100, teamSize);
            if (botTeam.length !== teamSize) {
                await client.query('ROLLBACK');
                continue;
            }
            // Bots play RANDOM courses (never the humans'), exactly like the solo
            // pass. Because the sides are on different courses we resolve by score
            // DIFFERENTIAL (the hole-by-hole formats can't compare across courses, so
            // they fall back to the same differential). Scramble is one shared team
            // card on one random course; every other format gives each bot its own.
            const isScramble = c.format === 'scramble';
            const pickRandomTee = async () => {
                const { rows } = await client.query(`SELECT teebox_id, course_rating, slope_rating, num_holes,
                  front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
             FROM teeboxes
            WHERE course_rating IS NOT NULL AND slope_rating IS NOT NULL AND num_holes >= $1
              AND course_id <> ALL($2::uuid[])
            ORDER BY random() LIMIT 1`, [holesPlayed, humanCourseIds]);
                return rows[0] ?? (rep.teebox_id ? {
                    teebox_id: rep.teebox_id, course_rating: rep.course_rating, slope_rating: rep.slope_rating,
                    num_holes: rep.teebox_num_holes,
                    front_course_rating: rep.front_course_rating, front_slope_rating: rep.front_slope_rating,
                    back_course_rating: rep.back_course_rating, back_slope_rating: rep.back_slope_rating,
                } : null);
            };
            const side2 = [];
            const sharedTee = isScramble ? await pickRandomTee() : null;
            const teamHcp = isScramble
                ? Math.max(-5, Math.min(...botTeam.map((b) => b.handicap)) - teamSize) // a scramble team scores well under any member
                : 0;
            const scrambleRound = isScramble && sharedTee
                ? generateBotRound(sharedTee.course_rating, sharedTee.num_holes, holesPlayed, teamHcp)
                : null;
            let teamOk = true;
            for (const b of botTeam) {
                const tee = isScramble ? sharedTee : await pickRandomTee();
                if (!tee) {
                    teamOk = false;
                    break;
                }
                const round = isScramble && scrambleRound
                    ? scrambleRound
                    : generateBotRound(tee.course_rating, tee.num_holes, holesPlayed, b.handicap);
                side2.push({
                    user_id: b.user_id, strokes: round.total, hole_scores: round.holeScores,
                    course_rating: tee.course_rating, slope_rating: tee.slope_rating,
                    front_course_rating: tee.front_course_rating, front_slope_rating: tee.front_slope_rating,
                    back_course_rating: tee.back_course_rating, back_slope_rating: tee.back_slope_rating,
                    teebox_num_holes: tee.num_holes, holes_played: holesPlayed,
                    elo: b.elo, total_matches: 0,
                });
                await client.query(`INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
           VALUES ($1, $2, $3, 2, $4, TRUE)
           ON CONFLICT (match_id, user_id) DO NOTHING`, [c.match_id, b.user_id, tee.teebox_id, round.total]);
                await client.query(`INSERT INTO rounds (match_id, user_id, teebox_id, hole_scores, total_score, round_type)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (match_id, user_id) DO NOTHING`, [c.match_id, b.user_id, tee.teebox_id, round.holeScores, round.total, c.match_type]);
            }
            if (!teamOk || side2.length !== teamSize) {
                await client.query('ROLLBACK');
                continue;
            }
            // ── Resolve (team vs team) by score differential, mirroring resolveElo ──
            const subset = c.holes_subset;
            const diffOf = (p) => {
                if (!p.course_rating || !p.slope_rating)
                    return p.strokes;
                const oR = subset === 'front' ? p.front_course_rating : subset === 'back' ? p.back_course_rating : null;
                const oS = subset === 'front' ? p.front_slope_rating : subset === 'back' ? p.back_slope_rating : null;
                return (0, matches_1.diff18)(p.strokes, p.course_rating, p.slope_rating, p.holes_played, p.teebox_num_holes || p.holes_played, oR, oS);
            };
            const teamDiff = (players, topN) => {
                const ds = players.map(diffOf).sort((a, b) => a - b).slice(0, topN);
                return ds.reduce((a, b) => a + b, 0) / ds.length;
            };
            const compareCount = Math.min(side1.length, side2.length);
            const side1Diff = teamDiff(side1, compareCount);
            const side2Diff = teamDiff(side2, compareCount);
            const isTie = Math.abs(side1Diff - side2Diff) < 0.05;
            const side1Wins = !isTie && side1Diff < side2Diff;
            const rep1 = side1[0];
            const rep2 = side2[0];
            const expA = (0, matches_1.expectedScore)(Number(rep1.elo), Number(rep2.elo));
            const k = (0, matches_1.kFactor)(Number(rep1.total_matches) || 0, Number(rep1.elo));
            const side1Delta = Math.round(k * ((isTie ? 0.5 : (side1Wins ? 1 : 0)) - expA));
            const side2Delta = -side1Delta;
            const humanIds = side1.map((p) => p.user_id);
            const placementSet = await (0, matches_1.placementUserSet)(client, humanIds, c.match_id);
            const playerDeltas = {};
            // Humans: shaped delta applied to ELO + record.
            for (const p of side1) {
                const won = !isTie && side1Wins;
                const eloChange = (0, matches_1.shapeDelta)(side1Delta, won, placementSet.has(p.user_id));
                playerDeltas[p.user_id] = eloChange;
                await client.query(`UPDATE users
              SET elo = GREATEST(100, elo + $1),
                  total_matches = total_matches + 1,
                  total_wins = total_wins + $2,
                  total_ties = total_ties + $3
            WHERE user_id = $4`, [eloChange, won ? 1 : 0, isTie ? 1 : 0, p.user_id]);
            }
            // Bots: record only (ELO frozen). Display delta drives their feed card.
            for (const p of side2) {
                const botWon = !isTie && !side1Wins;
                playerDeltas[p.user_id] = (0, matches_1.shapeDelta)(side2Delta, botWon, false);
                await client.query(`UPDATE users
              SET total_matches = total_matches + 1,
                  total_wins = total_wins + $2,
                  total_ties = total_ties + $3
            WHERE user_id = $1`, [p.user_id, botWon ? 1 : 0, isTie ? 1 : 0]);
            }
            await client.query(`INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
                                    side2_score_differential, delta_elo, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
                c.match_id, c.match_type,
                isTie ? null : (side1Wins ? 1 : 2),
                side1Diff, side2Diff, Math.abs(side1Delta),
                JSON.stringify({
                    bot: true,
                    side1Players: humanIds,
                    side2Players: side2.map((p) => p.user_id),
                    tied: isTie,
                    side1DeltaSignedElo: side1Delta,
                    side2DeltaSignedElo: side2Delta,
                    playerDeltas,
                    format: c.format,
                    // Resolved by differential (bots are on different courses), so the
                    // hole-by-hole format breakdown isn't computed for bot team matches.
                    formatDetails: null,
                }),
            ]);
            await client.query(`UPDATE matches SET completed = TRUE WHERE match_id = $1`, [c.match_id]);
            // Round post for the HUMAN players only — bots don't post into the global
            // feed. They still appear as opponents here and on their own profiles.
            await client.query(`INSERT INTO posts (user_id, kind, match_id, body)
         SELECT r.user_id, 'round', $1, r.caption
           FROM rounds r WHERE r.match_id = $1 AND r.user_id = ANY($2)`, [c.match_id, humanIds]);
            await client.query('COMMIT');
            console.log(`[bots] resolved ${c.match_type} ${c.match_id}: humans ${side1Wins ? 'beat' : isTie ? 'tied' : 'lost to'} bot team (Δelo ${side1Delta})`);
            (0, notifyFomo_1.notifyMatchResolved)(c.match_id).catch(() => { });
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error('[bots] team match fill failed:', err);
        }
        finally {
            client.release();
        }
    }
}
/**
 * One-time history backfill: generate a batch of completed SOLO matches of bots
 * playing EACH OTHER, so the ELO leaderboard and bot profiles look lived-in
 * instead of every bot sitting at 0-0. Each match is two random bots on two
 * random courses, resolved by score differential (skill-anchored, so stronger
 * bots win more — a realistic ladder). Backdated over the past ~60 days. Bot
 * ELO stays frozen; only their win/loss/match record moves. No feed posts (we
 * don't want to backfill the global timeline) and these never touch the cup
 * (bots are excluded there). Idempotent: tagged `botVsBot` so it never re-runs.
 *
 * @param perBot ~how many matches each bot should end up with.
 */
async function backfillBotVsBotMatches(perBot = 25) {
    try {
        // Skip if the current bots already carry a match history, so this never
        // re-runs on later boots. Robust to roster changes: freshly-seeded bots
        // sit near 0 matches, so a shrunk/renamed pool gets re-backfilled.
        const { rows: chk } = await pool_1.default.query(`SELECT COALESCE(AVG(total_matches), 0)::float AS avg_m FROM users WHERE is_bot = TRUE`);
        if ((chk[0]?.avg_m ?? 0) >= 12)
            return; // already populated
        const { rows: botRows } = await pool_1.default.query(`SELECT user_id, elo FROM users WHERE is_bot = TRUE`);
        if (botRows.length < 2)
            return;
        const bots = botRows.map((b) => ({
            user_id: b.user_id, elo: Number(b.elo), handicap: handicapForElo(Number(b.elo)),
        }));
        // A pool of real 18-hole courses to spread the bots across.
        const { rows: tees } = await pool_1.default.query(`SELECT teebox_id, course_rating, slope_rating, num_holes
         FROM teeboxes
        WHERE course_rating IS NOT NULL AND slope_rating IS NOT NULL AND num_holes >= 18
        ORDER BY random() LIMIT 250`);
        if (!tees.length) {
            console.warn('[bots] bot-vs-bot backfill skipped — no rated teeboxes');
            return;
        }
        const randOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const target = Math.round((bots.length * perBot) / 2);
        let made = 0;
        const client = await pool_1.default.connect();
        try {
            for (let i = 0; i < target; i++) {
                const a = randOf(bots);
                let b = randOf(bots);
                for (let g = 0; g < 6 && b.user_id === a.user_id; g++)
                    b = randOf(bots);
                if (b.user_id === a.user_id)
                    continue;
                const ta = randOf(tees), tb = randOf(tees);
                const ra = generateBotRound(ta.course_rating, ta.num_holes, 18, a.handicap);
                const rb = generateBotRound(tb.course_rating, tb.num_holes, 18, b.handicap);
                const da = (0, matches_1.diff18)(ra.total, ta.course_rating, ta.slope_rating, 18, ta.num_holes, null, null);
                const db = (0, matches_1.diff18)(rb.total, tb.course_rating, tb.slope_rating, 18, tb.num_holes, null, null);
                const tie = Math.abs(da - db) < 0.05;
                const aWins = !tie && da < db;
                const daysAgo = Math.floor(Math.random() * 60) + 1;
                try {
                    await client.query('BEGIN');
                    const { rows: mrow } = await client.query(`INSERT INTO matches (match_type, format, num_holes, completed, is_practice, created_at)
             VALUES ('solo','stroke',18,TRUE,FALSE, NOW() - make_interval(days => $1::int))
             RETURNING match_id`, [daysAgo]);
                    const matchId = mrow[0].match_id;
                    await client.query(`INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed, completed_at)
             VALUES ($1,$2,$3,1,$4,TRUE, NOW() - make_interval(days => $8::int)),
                    ($1,$5,$6,2,$7,TRUE, NOW() - make_interval(days => $8::int))`, [matchId, a.user_id, ta.teebox_id, ra.total, b.user_id, tb.teebox_id, rb.total, daysAgo]);
                    await client.query(`INSERT INTO rounds (match_id, user_id, teebox_id, hole_scores, total_score, round_type, created_at)
             VALUES ($1,$2,$3,$4,$5,'solo', NOW() - make_interval(days => $10::int)),
                    ($1,$6,$7,$8,$9,'solo', NOW() - make_interval(days => $10::int))`, [matchId, a.user_id, ta.teebox_id, ra.holeScores, ra.total, b.user_id, tb.teebox_id, rb.holeScores, rb.total, daysAgo]);
                    await client.query(`INSERT INTO match_results (match_id, match_type, winner_side, side1_score_differential,
                                        side2_score_differential, delta_elo, details)
             VALUES ($1,'solo',$2,$3,$4,0,$5)`, [matchId, tie ? null : (aWins ? 1 : 2), da, db,
                        JSON.stringify({ bot: true, botVsBot: true, tied: tie, playerDeltas: {} })]);
                    // Win/loss record only — bot ELO is frozen.
                    await client.query(`UPDATE users SET total_matches = total_matches + 1, total_wins = total_wins + $2,
                              total_ties = total_ties + $3 WHERE user_id = $1`, [a.user_id, aWins ? 1 : 0, tie ? 1 : 0]);
                    await client.query(`UPDATE users SET total_matches = total_matches + 1, total_wins = total_wins + $2,
                              total_ties = total_ties + $3 WHERE user_id = $1`, [b.user_id, (!aWins && !tie) ? 1 : 0, tie ? 1 : 0]);
                    await client.query('COMMIT');
                    made++;
                }
                catch (err) {
                    await client.query('ROLLBACK');
                    console.error('[bots] bot-vs-bot row failed:', err);
                }
            }
        }
        finally {
            client.release();
        }
        console.log(`[bots] bot-vs-bot backfill created ${made} matches across ${bots.length} bots`);
    }
    catch (err) {
        console.error('[bots] bot-vs-bot backfill failed:', err);
    }
}
