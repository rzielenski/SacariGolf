import pool from './pool';

/**
 * Idempotent additive migrations. Safe to run on every cold start — each
 * statement is `IF NOT EXISTS` so re-running is a no-op. Use this for
 * non-destructive schema bumps; destructive changes belong in schema.sql.
 *
 * Add new migrations to the bottom of `MIGRATIONS`. Order matters because
 * later statements may depend on earlier columns.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: 'users.premium_columns',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_premium    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS premium_since TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS premium_plan  TEXT;
    `,
  },
  {
    // Per-user theme song. Same shape as the team theme but lives on the
    // user record so a solo player has a personal anthem too. The match-
    // found intro picks team theme first, then falls back to the player's
    // personal theme if no team theme is set.
    name: 'users.theme_columns',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS theme_track_id      TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_title   TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_artist  TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_artwork TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_preview TEXT;
    `,
  },
  {
    // Clan customization: avatar image (uploaded like user avatars) and a
    // theme song sourced from the iTunes Search API (preview URL is a 30s
    // CDN-hosted MP4/M4A that any client can stream without auth).
    name: 'clans.avatar_and_theme',
    sql: `
      ALTER TABLE clans
        ADD COLUMN IF NOT EXISTS avatar_url             TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_id         TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_title      TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_artist     TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_artwork    TEXT,
        ADD COLUMN IF NOT EXISTS theme_track_preview    TEXT;
    `,
  },
  {
    // Durable per-shot table. Replaces the JSONB-array-per-hole approach in
    // shot_tracks, which was cascade-deleted with matches and made it
    // impossible to keep launch-monitor imports or generate per-club stats
    // independently of match lifetime. Each shot is its own row.
    //
    //   • match_id is NULLABLE and ON DELETE SET NULL — wiping matches
    //     preserves the shot history (sets match_id to null on those rows).
    //   • hole_id likewise SET NULL — teebox-rebuilds don't lose shots.
    //   • source: 'gps' = tracked during a round, 'launch_monitor' = CSV
    //     import, 'manual' = future hand-entered.
    name: 'shots.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS shots (
        shot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        match_id UUID REFERENCES matches(match_id) ON DELETE SET NULL,
        hole_id UUID REFERENCES holes(hole_id) ON DELETE SET NULL,
        hole_num SMALLINT,
        shot_index SMALLINT NOT NULL DEFAULT 0,
        club TEXT NOT NULL,
        lie TEXT,
        start_lat REAL NOT NULL,
        start_lng REAL NOT NULL,
        start_elevation_m REAL,
        end_lat REAL NOT NULL,
        end_lng REAL NOT NULL,
        end_elevation_m REAL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL DEFAULT 'gps'
      );
      CREATE INDEX IF NOT EXISTS shots_user_club_idx
        ON shots(user_id, club);
      CREATE INDEX IF NOT EXISTS shots_match_user_hole_idx
        ON shots(match_id, user_id, hole_num);
      CREATE INDEX IF NOT EXISTS shots_user_recorded_idx
        ON shots(user_id, recorded_at DESC);
    `,
  },
  {
    // For 9-hole matches on 18-hole teeboxes, store whether the player chose
    // the front 9 or the back 9. 18-hole rounds use 'full'. Affects which
    // ratings (front_course_rating vs back_course_rating) feed the WHS /
    // ELO calc, and which holes the scoring screen shows.
    name: 'matches.holes_subset',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS holes_subset TEXT NOT NULL DEFAULT 'full';
    `,
  },
  {
    // One-shot cleanup: cancel any existing matches where the two sides
    // contain teammates from the same clan (created by older auto-pair
    // logic that didn't respect team boundaries). Idempotent — once these
    // are cancelled, the WHERE clause matches nothing on subsequent boots.
    name: 'matches.cancel_self_team_pairs',
    sql: `
      UPDATE matches m
         SET cancelled = TRUE
       WHERE m.completed = FALSE
         AND m.cancelled = FALSE
         AND EXISTS (
           SELECT 1
             FROM match_players p1
             JOIN match_players p2 ON p2.match_id = p1.match_id AND p2.side <> p1.side
             JOIN clan_members cm1 ON cm1.user_id = p1.user_id
             JOIN clan_members cm2 ON cm2.user_id = p2.user_id AND cm2.clan_id = cm1.clan_id
            WHERE p1.match_id = m.match_id
         );
    `,
  },
  {
    // Track which team (clan_id) a duo/squad match was created for. Used by
    // the auto-pair logic to prevent a team from being matched against
    // itself or its own teammates' matches. Solo matches stay NULL.
    name: 'matches.team_clan_id',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS clan_id UUID REFERENCES clans(clan_id) ON DELETE SET NULL;
    `,
  },
  {
    // Distinct flag from `completed`. A match becomes `cancelled` when:
    //   • the player abandons it (no activity for 24h, auto-set by cron)
    //   • someone explicitly cancels (future feature)
    // Cancelled matches are excluded from stats, handicap, ELO, and "active
    // round" lookups. They remain in the table for audit/debug.
    name: 'matches.cancelled_flag',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // pin_contributions originally tracked only WHO contributed (for perks).
    // We now also store WHERE (each user's GPS reading), so we can median-blend
    // multiple contributions on the same hole and converge on the true cup
    // position over time. Columns are nullable so old rows survive.
    name: 'pin_contributions.add_coords',
    sql: `
      ALTER TABLE pin_contributions
        ADD COLUMN IF NOT EXISTS lat REAL,
        ADD COLUMN IF NOT EXISTS lng REAL,
        ADD COLUMN IF NOT EXISTS elevation_m REAL;
    `,
  },
  {
    // Server-side record of "match-found intro has been delivered to this
    // player". Source of truth for the watcher — replaces AsyncStorage so the
    // intro is genuinely once-and-only-once across devices, reinstalls, and
    // sessions. Set by POST /matches/:id/mark-intro-shown the moment the
    // animation kicks off.
    name: 'match_players.intro_shown_at',
    sql: `
      ALTER TABLE match_players
        ADD COLUMN IF NOT EXISTS intro_shown_at TIMESTAMPTZ;
    `,
  },
  {
    // Backfill existing rows so the freshly-added column doesn't resurrect
    // the intro for every old paired match the moment this deploys.
    // Marks anyone in a match that is already completed, cancelled, superseded,
    // or older than one hour — i.e. anything that's plausibly "stale" — as
    // already seen. New / fresh pairs (created in the last hour) keep
    // intro_shown_at = NULL so their animation can still fire normally.
    // Idempotent: re-running matches no rows after the first pass.
    name: 'match_players.intro_shown_at_backfill',
    sql: `
      UPDATE match_players mp
         SET intro_shown_at = NOW()
       WHERE mp.intro_shown_at IS NULL
         AND EXISTS (
           SELECT 1 FROM matches m
            WHERE m.match_id = mp.match_id
              AND (m.completed = TRUE
                   OR m.cancelled = TRUE
                   OR m.superseded_by_match_id IS NOT NULL
                   OR m.created_at < NOW() - INTERVAL '1 hour')
         );
    `,
  },
  {
    // One-shot grant: every account created before the cutoff timestamp gets
    // lifetime premium ('founder' plan) as a thank-you to early users. Future
    // signups (created_at >= cutoff) are unaffected. Idempotent because the
    // WHERE clause only matches users who haven't been touched yet
    // (premium_since IS NULL); on subsequent boots it's a no-op.
    name: 'users.premium_grandfather_existing',
    sql: `
      UPDATE users
         SET is_premium    = TRUE,
             premium_since = NOW(),
             premium_until = NULL,
             premium_plan  = 'founder'
       WHERE premium_since IS NULL
         AND created_at < TIMESTAMP '2026-05-07 00:00:00';
    `,
  },
  {
    // Crowd-sourced course-data corrections. Players hit obviously-wrong
    // course/teebox/hole data and tap "Report" — we collect their suggestion
    // here for human review (Richard reviews the table periodically and
    // updates the underlying course/teebox/hole row by hand).
    //
    // Kept simple — no auto-apply, no voting. The point is to surface bad
    // data fast, not to build a moderation system.
    name: 'course_corrections.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS course_corrections (
        correction_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id      UUID NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        teebox_id      UUID REFERENCES teeboxes(teebox_id) ON DELETE CASCADE,
        hole_id        UUID REFERENCES holes(hole_id) ON DELETE CASCADE,
        user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        field          TEXT NOT NULL,        -- e.g. 'course_rating', 'slope', 'par', 'yardage'
        current_value  TEXT,                 -- what's currently shown to the user
        suggested_value TEXT NOT NULL,       -- what they say it should be
        notes          TEXT,                 -- free-form comment
        status         TEXT NOT NULL DEFAULT 'pending', -- pending | applied | rejected
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS course_corrections_status_idx ON course_corrections(status, created_at);
      CREATE INDEX IF NOT EXISTS course_corrections_course_idx ON course_corrections(course_id);
    `,
  },
  {
    // Recurring tournaments / leagues. Either a fixed window of matches at a
    // single course, or an open-ended weekly league across whatever course
    // each player picks.
    //   • match_filter: stores filter criteria as JSONB so we can extend
    //     (course_id, format, num_holes, scoring rules) without migrations.
    //   • is_open: anyone can join via shareable code; otherwise invite only.
    name: 'tournaments.create_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS tournaments (
        tournament_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        owner_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        clan_id        UUID REFERENCES clans(clan_id) ON DELETE SET NULL,
        name           TEXT NOT NULL,
        description    TEXT,
        starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at        TIMESTAMPTZ,
        scoring        TEXT NOT NULL DEFAULT 'best_round', -- best_round | total_strokes | points | wins
        format         TEXT NOT NULL DEFAULT 'stroke',     -- stroke | match | stableford | skins | scramble
        course_id      UUID REFERENCES courses(course_id) ON DELETE SET NULL,
        is_open        BOOLEAN NOT NULL DEFAULT TRUE,
        join_code      TEXT UNIQUE,
        status         TEXT NOT NULL DEFAULT 'active'  -- active | finished | cancelled
      );
      CREATE INDEX IF NOT EXISTS tournaments_owner_idx ON tournaments(owner_id);
      CREATE INDEX IF NOT EXISTS tournaments_status_idx ON tournaments(status, ends_at);

      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id  UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
        user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tournament_id, user_id)
      );

      -- Link a match to a tournament so leaderboards can aggregate scores.
      -- A single match counts toward at most one tournament.
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(tournament_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS matches_tournament_idx ON matches(tournament_id);
    `,
  },
  {
    // Match-format expansion: stableford, match play, skins.
    // The matches.format column already exists as TEXT — no DDL change needed
    // beyond expanding the conceptual enum. This migration is intentionally
    // empty but kept here to document the conceptual change.
    name: 'matches.format_enum_expanded',
    sql: `SELECT 1;`, // no-op — TEXT column accepts any value
  },
  {
    // Group scoring: when one phone records strokes for several players,
    // we store the "ghost" players (no user account) as JSONB on the match.
    // Each entry: { name: string, side: number, scores: number[], teebox_id?: string }
    // Real users use match_players + rounds as before. Aggregate match results
    // include both real-user side scores and ghost scores.
    name: 'matches.guest_players',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS guest_players JSONB NOT NULL DEFAULT '[]';
    `,
  },
  {
    // User-blocking — required by Apple Guideline 1.2 for any app with
    // user-generated content. Each row means: blocker has hidden blocked
    // from their feeds (friend search, finds pair, leaderboard, DMs, etc.).
    // The relationship is one-directional — the blocked user is not notified
    // and can't tell. To "unblock" simply delete the row.
    //
    // Filters live close to each query; a helper in routes/users.ts exposes
    // a single getBlockedIds(userId) function so every reader can apply it.
    name: 'blocked_users.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS blocked_users (
        blocker_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        blocked_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id)
      );
      CREATE INDEX IF NOT EXISTS blocked_users_blocker_idx ON blocked_users(blocker_id);
      CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx ON blocked_users(blocked_id);
    `,
  },
  {
    // Track WHY a perk was awarded so we can show "earned by tracking shots"
    // / "earned by marking pins" on the perk banner. Optional — older perks
    // get NULL and the UI just says "Lucky Round earned".
    name: 'user_perks.earned_reason',
    sql: `
      ALTER TABLE user_perks
        ADD COLUMN IF NOT EXISTS earned_reason TEXT;
    `,
  },
  {
    // Crowd-sourced relative-elevation grid per course. Phone barometers are
    // very accurate at RELATIVE altitude on short timescales (sub-meter) but
    // their absolute reading drifts up to 10–30m. By anchoring every point
    // on a course to the FIRST player's first reading (course "origin = 0"),
    // every subsequent sample stored here is a delta from that origin —
    // accurate to a meter or two regardless of phone calibration.
    //
    // Grid bucketing collapses readings within ~5m to one row so we get
    // multi-sample running averages without storing every wiggle. Lookups
    // search the surrounding 3×3 buckets (≈15m) so we always find a nearby
    // anchor when one exists.
    //
    //   lat_grid = round(lat * 20000)   → ~5.5m N/S grid
    //   lng_grid = round(lng * 20000)   → narrows toward poles, fine in
    //                                     the 24°–60° latitude band where
    //                                     ~99% of golf is played.
    //
    // The course's "origin" doesn't need its own column — it's implicit:
    // wherever the first cached point sits, its elevation_rel_m = 0.
    name: 'course_elevation_points.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS course_elevation_points (
        course_id        UUID NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        lat_grid         INTEGER NOT NULL,
        lng_grid         INTEGER NOT NULL,
        lat              DOUBLE PRECISION NOT NULL,
        lng              DOUBLE PRECISION NOT NULL,
        elevation_rel_m  REAL NOT NULL,
        samples          INTEGER NOT NULL DEFAULT 1,
        last_updated     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, lat_grid, lng_grid)
      );
      CREATE INDEX IF NOT EXISTS course_elevation_points_course_idx
        ON course_elevation_points(course_id);
    `,
  },
];

export async function runMigrations() {
  for (const m of MIGRATIONS) {
    try {
      await pool.query(m.sql);
      // Quiet on success — startup logs stay tidy.
    } catch (err) {
      console.error(`Migration "${m.name}" failed:`, err);
      // Don't crash on migration failure — let the server start anyway so
      // other endpoints keep working. The failed feature simply won't function.
    }
  }
}
