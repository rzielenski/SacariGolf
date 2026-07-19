/**
 * Seed an App Store reviewer account with realistic data.
 *
 *   npm run seed:test           (against whatever DATABASE_URL points at)
 *
 * Creates a reviewer login plus two "friend" accounts, an accepted
 * friendship graph, a test course with 18 pinned holes, three completed
 * solo matches (a win, a loss, a tie — so the profile + feed show variety),
 * the auto-generated round posts, and a couple of plain text posts. The
 * reviewer lands on a populated home feed, a real leaderboard, and a
 * profile with history — none of the empty-screen states that make
 * reviewers think the app is broken.
 *
 * Idempotent: every entity uses a fixed UUID and the script deletes the
 * prior test data (cascades included) before re-inserting, so you can run
 * it as many times as you like and always get the same known-good state.
 *
 * The reviewer password defaults to `SacariReview2026!` — override with
 * the SEED_REVIEWER_PASSWORD env var if you want something else. Put the
 * final email + password in your App Store Connect "App Review
 * Information" notes.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pool from '../db/pool';

// ── Fixed IDs ───────────────────────────────────────────────────────────────
// All test entities use deterministic UUIDs so re-runs are clean and the
// data is easy to spot / purge in the DB later.
const COURSE_ID  = '5acab000-0000-0000-0000-0000000000c0';
const TEEBOX_ID  = '5acab000-0000-0000-0000-0000000000c1';
const REVIEWER   = '5acab000-0000-0000-0000-0000000000a0';
const FRIEND_1   = '5acab000-0000-0000-0000-0000000000a1';
const FRIEND_2   = '5acab000-0000-0000-0000-0000000000a2';
const MATCH_WIN  = '5acab000-0000-0000-0000-0000000000d0'; // reviewer wins
const MATCH_LOSS = '5acab000-0000-0000-0000-0000000000d1'; // reviewer loses
const MATCH_TIE  = '5acab000-0000-0000-0000-0000000000d2'; // draw
const ALL_MATCHES = [MATCH_WIN, MATCH_LOSS, MATCH_TIE];
const ALL_USERS   = [REVIEWER, FRIEND_1, FRIEND_2];
// Text posts get their own fixed IDs so they're replaced cleanly too.
const POST_TEXT_1 = '5acab000-0000-0000-0000-0000000000e0';
const POST_TEXT_2 = '5acab000-0000-0000-0000-0000000000e1';

const REVIEWER_EMAIL = 'appreview@sacari.golf';
const REVIEWER_PASSWORD = process.env.SEED_REVIEWER_PASSWORD || 'SacariReview2026!';

// Pebble-ish coordinates — anywhere real works; pins just need to be near
// the course centre so distance-to-pin + the heatmap have something to
// project against.
const COURSE_LAT = 36.5687;
const COURSE_LNG = -121.9496;

/** Standard 18-hole par layout (par 72): a believable mix of 3s/4s/5s. */
const PARS = [4, 5, 4, 4, 3, 5, 4, 3, 4,  4, 4, 3, 5, 4, 4, 3, 4, 5];
const YARDAGES = [380, 510, 410, 395, 165, 525, 420, 180, 405,
                  400, 415, 175, 540, 430, 390, 195, 410, 520];

/** Build a plausible 18-hole score line for a given "skill" — average
 *  strokes-over-par per hole, with light per-hole variance. */
function scoreLine(overParPerHole: number): number[] {
  return PARS.map((par) => {
    const noise = Math.round((Math.random() - 0.5) * 2); // -1..+1
    return Math.max(1, par + Math.round(overParPerHole) + noise);
  });
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Purge any prior test data ────────────────────────────────────
    // Order matters: posts.match_id is ON DELETE SET NULL (not CASCADE),
    // so round posts must go before their matches or they'd be orphaned.
    // Everything else cascades cleanly from users / matches / courses.
    await client.query(
      `DELETE FROM posts
        WHERE user_id = ANY($1::uuid[])
           OR match_id = ANY($2::uuid[])`,
      [ALL_USERS, ALL_MATCHES]
    );
    await client.query(`DELETE FROM matches WHERE match_id = ANY($1::uuid[])`, [ALL_MATCHES]);
    await client.query(
      `DELETE FROM friends WHERE user_id = ANY($1::uuid[]) OR friend_id = ANY($1::uuid[])`,
      [ALL_USERS]
    );
    await client.query(`DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [ALL_USERS]);
    await client.query(`DELETE FROM courses WHERE course_id = $1`, [COURSE_ID]);

    // ── 2. Course + teebox + 18 pinned holes ────────────────────────────
    await client.query(
      `INSERT INTO courses (course_id, course_name, club_name, city, state, country, latitude, longitude)
       VALUES ($1, 'Sacari Review Links', 'Sacari Demo Club', 'Pebble Beach', 'CA', 'USA', $2, $3)`,
      [COURSE_ID, COURSE_LAT, COURSE_LNG]
    );
    await client.query(
      `INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating,
                             total_yards, num_holes, par)
       VALUES ($1, $2, 'Blue', 'male', 72.4, 131, $3, 18, 72)`,
      [TEEBOX_ID, COURSE_ID, YARDAGES.reduce((a, b) => a + b, 0)]
    );
    for (let i = 0; i < 18; i++) {
      const holeNum = i + 1;
      // Spread the pins out around the course centre so they're distinct
      // points on the map — a hair under 0.001° (~100m) apart per hole.
      const pinLat = COURSE_LAT + (i - 9) * 0.0009;
      const pinLng = COURSE_LNG + (i % 2 === 0 ? 1 : -1) * 0.0007;
      await client.query(
        `INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap, pin_lat, pin_lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [TEEBOX_ID, holeNum, PARS[i], YARDAGES[i], holeNum, pinLat, pinLng]
      );
    }

    // ── 3. Users — reviewer + two friends ───────────────────────────────
    const reviewerHash = await bcrypt.hash(REVIEWER_PASSWORD, 12);
    // Friends never need to log in, so their password hash can be anything
    // valid — reuse the reviewer's so we don't pay for three bcrypt rounds.
    const users = [
      { id: REVIEWER, username: 'appreviewer',  email: REVIEWER_EMAIL,
        elo: 1240, matches: 3, wins: 1, ties: 1, hcap: 12.4,
        bio: 'App Store review account — seeded demo data.' },
      { id: FRIEND_1, username: 'caddie_casey', email: 'casey@sacari.golf',
        elo: 1305, matches: 14, wins: 8, ties: 1, hcap: 8.1,
        bio: 'Weekend warrior. Slice for sale.' },
      { id: FRIEND_2, username: 'birdie_bex',   email: 'bex@sacari.golf',
        elo: 1180, matches: 9,  wins: 3, ties: 0, hcap: 18.6,
        bio: 'Here for the putting practice.' },
    ];
    for (const u of users) {
      await client.query(
        `INSERT INTO users (user_id, username, email, password_hash, elo,
                            total_matches, total_wins, total_ties,
                            handicap_index, bio, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)`,
        [u.id, u.username, u.email, reviewerHash, u.elo,
         u.matches, u.wins, u.ties, u.hcap, u.bio]
      );
    }

    // ── 4. Friendships — reviewer ↔ both friends, accepted ──────────────
    // The friend lookups check both directions, so one row per pair is
    // enough. We also friend the two demo users to each other so the
    // friends-of-friends mix has something to surface.
    const friendPairs: [string, string][] = [
      [REVIEWER, FRIEND_1],
      [REVIEWER, FRIEND_2],
      [FRIEND_1, FRIEND_2],
    ];
    for (const [a, b] of friendPairs) {
      await client.query(
        `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'accepted')`,
        [a, b]
      );
    }

    // ── 5. Three completed solo matches ─────────────────────────────────
    // Each: reviewer on side 1, a friend on side 2, both rounds submitted,
    // a match_results row, and the two auto-post 'round' cards.
    type MatchSpec = {
      matchId: string;
      opponent: string;
      // overParPerHole skill: lower = better. reviewer ~+1, friends vary.
      reviewerOverPar: number;
      opponentOverPar: number;
      // winnerSide: 1 reviewer, 2 opponent, null tie
      winnerSide: 1 | 2 | null;
      daysAgo: number;
    };
    const matchSpecs: MatchSpec[] = [
      { matchId: MATCH_WIN,  opponent: FRIEND_1, reviewerOverPar: 0.6, opponentOverPar: 1.4, winnerSide: 1, daysAgo: 2 },
      { matchId: MATCH_LOSS, opponent: FRIEND_2, reviewerOverPar: 1.5, opponentOverPar: 0.7, winnerSide: 2, daysAgo: 5 },
      { matchId: MATCH_TIE,  opponent: FRIEND_1, reviewerOverPar: 1.0, opponentOverPar: 1.0, winnerSide: null, daysAgo: 9 },
    ];

    for (const spec of matchSpecs) {
      const created = `NOW() - INTERVAL '${spec.daysAgo} days'`;
      // matches row
      await client.query(
        `INSERT INTO matches (match_id, match_type, format, num_holes, completed, name, created_at)
         VALUES ($1, 'solo', 'stroke', 18, TRUE, 'Review Demo Match', ${created})`,
        [spec.matchId]
      );

      // Reviewer score line + round
      const reviewerScores = scoreLine(spec.reviewerOverPar);
      const reviewerTotal = reviewerScores.reduce((a, b) => a + b, 0);
      const opponentScores = scoreLine(spec.opponentOverPar);
      const opponentTotal = opponentScores.reduce((a, b) => a + b, 0);

      // match_players — reviewer side 1, opponent side 2
      await client.query(
        `INSERT INTO match_players (match_id, user_id, teebox_id, side, strokes, completed)
         VALUES ($1, $2, $3, 1, $4, TRUE), ($1, $5, $3, 2, $6, TRUE)`,
        [spec.matchId, REVIEWER, TEEBOX_ID, reviewerTotal, spec.opponent, opponentTotal]
      );

      // rounds — one per player. hole_stats left empty (player didn't track
      // putts/chips this round); the scorecard still renders fine.
      await client.query(
        `INSERT INTO rounds (match_id, user_id, course_id, teebox_id, hole_scores, hole_stats, total_score, round_type, created_at)
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, 'solo', ${created}),
                ($1, $7, $3, $4, $8, '[]'::jsonb, $9, 'solo', ${created})`,
        [spec.matchId, REVIEWER, COURSE_ID, TEEBOX_ID, reviewerScores, reviewerTotal,
         spec.opponent, opponentScores, opponentTotal]
      );

      // match_results — fabricate a believable ELO swing. Tie → 0 swing.
      const delta = spec.winnerSide == null ? 0 : 12;
      const side1Signed = spec.winnerSide == null ? 0 : (spec.winnerSide === 1 ? delta : -delta);
      const details = {
        side1Players: [REVIEWER],
        side2Players: [spec.opponent],
        tied: spec.winnerSide == null,
        side1DeltaSignedElo: side1Signed,
        side2DeltaSignedElo: -side1Signed,
        perks: [],
        format: 'stroke',
        formatDetails: null,
      };
      await client.query(
        `INSERT INTO match_results (match_id, match_type, winner_side,
                                    side1_score_differential, side2_score_differential,
                                    delta_elo, details, created_at)
         VALUES ($1, 'solo', $2, $3, $4, $5, $6, ${created})`,
        [
          spec.matchId,
          spec.winnerSide,
          reviewerTotal - 72,
          opponentTotal - 72,
          delta,
          JSON.stringify(details),
        ]
      );

      // Auto-post 'round' cards — one per player, same as resolveElo does.
      await client.query(
        `INSERT INTO posts (user_id, kind, match_id, created_at)
         VALUES ($1, 'round', $2, ${created}), ($3, 'round', $2, ${created})
         ON CONFLICT (user_id, match_id) WHERE kind = 'round' DO NOTHING`,
        [REVIEWER, spec.matchId, spec.opponent]
      );
    }

    // ── 6. A couple of plain text posts so the feed isn't all round cards ─
    await client.query(
      `INSERT INTO posts (post_id, user_id, kind, body, created_at)
       VALUES ($1, $2, 'text', $3, NOW() - INTERVAL '1 day')`,
      [POST_TEXT_1, FRIEND_1, 'Finally broke 80 at the demo links 🎉 the back nine pin positions were brutal though.']
    );
    await client.query(
      `INSERT INTO posts (post_id, user_id, kind, body, created_at)
       VALUES ($1, $2, 'text', $3, NOW() - INTERVAL '6 hours')`,
      [POST_TEXT_2, FRIEND_2, 'Anyone else practicing lag putting this week? My 3-putt count is out of control.']
    );

    await client.query('COMMIT');

    // eslint-disable-next-line no-console
    console.log('✅ Test account seeded.\n');
    // eslint-disable-next-line no-console
    console.log(`   Email:    ${REVIEWER_EMAIL}`);
    // eslint-disable-next-line no-console
    console.log(`   Password: ${REVIEWER_PASSWORD}`);
    // eslint-disable-next-line no-console
    console.log('\n   Friends: caddie_casey, birdie_bex (both accepted)');
    // eslint-disable-next-line no-console
    console.log('   Matches: 1 win, 1 loss, 1 tie — all on "Sacari Review Links"');
    // eslint-disable-next-line no-console
    console.log('   Feed:    6 round posts + 2 text posts\n');
    // eslint-disable-next-line no-console
    console.log('   Put the email + password in App Store Connect → App Review Information.');
  } catch (err) {
    await client.query('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error('❌ Seed failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
