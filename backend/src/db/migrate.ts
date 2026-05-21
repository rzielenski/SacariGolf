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
  {
    // Plays-like (normalized) yardage captured at recording time so per-club
    // stats reflect what the shot WOULD have gone in neutral conditions.
    // Snapshots wind/slope/temp/altitude/rain effects into a single number
    // — the club-stats aggregator prefers this when present, falling back
    // to raw GPS distance for legacy rows and imported launch-monitor data.
    name: 'shots.plays_like_yds',
    sql: `
      ALTER TABLE shots
        ADD COLUMN IF NOT EXISTS plays_like_yds REAL;
    `,
  },
  {
    // Per-user, per-chat read tracking so the social tab can surface an
    // "unread" indicator and sort unread chats to the top. One row per
    // (user, kind, key) tuple — updated to NOW() whenever the user opens
    // that chat. A chat is "unread" iff its newest message's created_at
    // is > the corresponding chat_reads.last_read_at (or no row exists).
    //
    //   kind = 'dm' | 'match' | 'clan'
    //   key  = other_user_id | match_id | clan_id (stored as UUID text)
    name: 'chat_reads.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS chat_reads (
        user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        chat_key     UUID NOT NULL,
        last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, kind, chat_key)
      );
      CREATE INDEX IF NOT EXISTS chat_reads_user_idx
        ON chat_reads(user_id);
    `,
  },
  {
    // Voice messages — file is on disk under /uploads/voice/<message_id>.m4a,
    // duration_ms captured client-side at record time so the bubble can show
    // length without decoding the audio on the server. Body text remains
    // present so quoting / push-notification preview still works.
    name: 'messages.voice_fields',
    sql: `
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS voice_url      TEXT,
        ADD COLUMN IF NOT EXISTS voice_duration_ms INTEGER;
      ALTER TABLE direct_messages
        ADD COLUMN IF NOT EXISTS voice_url      TEXT,
        ADD COLUMN IF NOT EXISTS voice_duration_ms INTEGER;
    `,
  },
  {
    // Cross-table message reporting. `kind` discriminates whether the
    // message_id refers to messages.message_id (channel) or
    // direct_messages.dm_id (dm). Status starts 'pending'; admins can flip
    // to 'reviewed' / 'dismissed' off-app. UNIQUE prevents one reporter
    // from spamming the same message.
    name: 'message_reports.create',
    sql: `
      CREATE TABLE IF NOT EXISTS message_reports (
        report_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind         TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
        message_id   UUID NOT NULL,
        reporter_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (kind, message_id, reporter_id)
      );
      CREATE INDEX IF NOT EXISTS message_reports_status_idx
        ON message_reports(status, created_at);
    `,
  },
  {
    // Per-user bag — the subset of ALLOWED_CLUBS the player actually
    // carries. NULL (the default) means "all clubs are eligible" so
    // existing users aren't silently constrained until they save a custom
    // bag. The club picker + auto-suggest both filter their pool by this
    // when present.
    name: 'users.clubs_in_bag',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS clubs_in_bag TEXT[];
    `,
  },
  {
    // Social feed — auto-posts on round completion + user-authored text /
    // image posts. `kind` discriminates how the card renders client-side.
    // `match_id` is SET NULL on match wipe (post stays as a historical
    // marker even if the match record is gone).
    //
    //   kind:
    //     'round'  → match_id required; body/image both null (the card
    //                pulls the score / course / opponent info via the
    //                joined match row, so the post itself stays tiny)
    //     'text'   → body required, image_url null
    //     'photo'  → image_url required, body optional caption
    name: 'posts.create',
    sql: `
      CREATE TABLE IF NOT EXISTS posts (
        post_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('round', 'text', 'photo')),
        body       TEXT,
        image_url  TEXT,
        match_id   UUID REFERENCES matches(match_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS posts_user_created_idx
        ON posts(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS posts_created_idx
        ON posts(created_at DESC);
    `,
  },
  {
    // Backfill existing completed matches as round posts so the feed isn't
    // empty for users with history. Inherits each post's created_at from
    // the match result (or match creation as a fallback) so the timeline
    // reflects when the round actually happened — they'll sit further down
    // the feed than new rounds, exactly as expected. Idempotent via the
    // NOT EXISTS guard: re-running on boot inserts nothing the second time.
    name: 'posts.backfill_round_posts',
    sql: `
      INSERT INTO posts (user_id, kind, match_id, created_at)
      SELECT mp.user_id, 'round', mp.match_id,
             COALESCE(mr.created_at, m.created_at)
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.match_id
      LEFT JOIN match_results mr ON mr.match_id = m.match_id
      WHERE m.completed = TRUE
        AND m.is_practice = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM posts p
          WHERE p.user_id  = mp.user_id
            AND p.match_id = m.match_id
            AND p.kind     = 'round'
        );
    `,
  },
  {
    // Bag entries get free-text labels alongside the canonical code, so a
    // player can carry e.g. "Vokey 56°" and "Vokey 60°" both mapped to
    // the canonical 'sw' / 'lw' codes for analytics. Migrating in place:
    //   • Drop the TEXT[] form
    //   • Re-add as JSONB array of {code, label?} objects
    // Existing data was rare enough (the bag feature only shipped recently)
    // that destructive migration is the simplest path. Users whose bag was
    // wiped just fall back to "all clubs eligible" until they re-save.
    name: 'users.clubs_in_bag.to_jsonb',
    sql: `
      ALTER TABLE users
        DROP COLUMN IF EXISTS clubs_in_bag;
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS clubs_in_bag JSONB;
    `,
  },
  {
    // Per-row index on posts.match_id so the feed query's join into the
    // matches/results/players chain doesn't sequential-scan the posts
    // table on every request. The existing indexes cover (user_id,
    // created_at) and (created_at) only — fine for "newest first" reads
    // but the match join was unindexed.
    name: 'posts.match_id_idx',
    sql: `
      CREATE INDEX IF NOT EXISTS posts_match_idx
        ON posts(match_id) WHERE match_id IS NOT NULL;
    `,
  },
  {
    // Per-user matchup history for the finds ranker. Previously we tracked
    // which individual finds a user had voted on — so once they'd seen a
    // find paired with one opponent, that find never re-appeared, even
    // against new finds added later. Now we track the PAIR (canonicalised
    // as (LEAST, GREATEST)) so a brand-new find can be ranked against
    // every existing find the user has already seen.
    //
    // A row is inserted when the server serves a pair (not just on vote)
    // so skipping or abandoning a matchup still counts as "seen" — keeps
    // the ranker from looping the same pair forever.
    name: 'find_pair_seen.create',
    sql: `
      CREATE TABLE IF NOT EXISTS find_pair_seen (
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        find_a_id  UUID NOT NULL REFERENCES finds(find_id) ON DELETE CASCADE,
        find_b_id  UUID NOT NULL REFERENCES finds(find_id) ON DELETE CASCADE,
        seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, find_a_id, find_b_id),
        CHECK (find_a_id < find_b_id)
      );
      CREATE INDEX IF NOT EXISTS find_pair_seen_user_idx
        ON find_pair_seen(user_id);
    `,
  },
  {
    // Feed-post abuse reports. Mirrors find_reports / message_reports:
    // a lightweight moderation queue, no auto-action, no voting. The
    // UNIQUE constraint stops one reporter from spamming the same post.
    // ON DELETE CASCADE on post_id means deleting a post (by its author
    // or a moderator) clears its reports too. Status starts 'pending';
    // admins flip it to 'reviewed' / 'dismissed' off-app.
    //
    // Required for App Store review — Apple's UGC guideline (1.2) needs
    // a report path on EVERY user-content surface, and the feed was the
    // one surface still missing it.
    name: 'post_reports.create',
    sql: `
      CREATE TABLE IF NOT EXISTS post_reports (
        report_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id      UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
        reporter_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (post_id, reporter_id)
      );
      CREATE INDEX IF NOT EXISTS post_reports_status_idx
        ON post_reports(status, created_at);
    `,
  },
  {
    // GolfCourseAPI id for each imported course. The bulk-import script
    // (DownloadCourses.py) records it so it can auto-resume from
    // MAX(external_id)+1 and never re-fetch a course we already have —
    // the API-cap saver. NULL for the ~27k courses that came in via the
    // old Supabase backup (they don't carry their API id). Partial unique
    // index so all those NULL rows coexist without tripping uniqueness.
    name: 'courses.external_id',
    sql: `
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS external_id BIGINT;
      CREATE UNIQUE INDEX IF NOT EXISTS courses_external_id_idx
        ON courses(external_id) WHERE external_id IS NOT NULL;
    `,
  },
  {
    // Birdie / eagle / hole-in-one celebrations. Written by /matches/:id/progress
    // the first time a hole's score crosses one of those thresholds, then
    // pulled by every player + spectator in the match so each device fires
    // the same celebratory animation.
    //
    // UNIQUE (match_id, user_id, hole_num) is what guarantees the celebration
    // fires exactly once per hole even if the user edits/re-saves the score
    // (or comes in from a flaky network and the progress endpoint sees the
    // same shot twice).
    //
    // `expires_at` defaults to 365 days so async-paced matches still work:
    // Player A finishes on Monday, Player B picks up the same match on
    // Saturday — B should still see A's birdies as B plays each hole. The
    // client gates by "has the local player reached this hole_num" so the
    // long server-side window is just a safety net, not the primary control.
    name: 'celebrations.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS celebrations (
        celebration_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        match_id        UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        hole_num        INT NOT NULL,
        score           INT NOT NULL,
        par             INT NOT NULL,
        kind            TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '365 days',
        UNIQUE (match_id, user_id, hole_num)
      );
      CREATE INDEX IF NOT EXISTS celebrations_match_active_idx
        ON celebrations(match_id, created_at);
    `,
  },
  {
    // Fix-up for any environment that ran the earlier (2-minute expiry)
    // version of celebrations.create_table before it was widened. Pushes
    // every existing row's expires_at out to 365 days from creation, then
    // changes the column default for future inserts. Idempotent — running
    // it a second time is a no-op because the UPDATE only touches rows
    // that haven't already been pushed out.
    name: 'celebrations.expand_expiry',
    sql: `
      UPDATE celebrations
         SET expires_at = created_at + INTERVAL '365 days'
       WHERE expires_at < created_at + INTERVAL '60 days';
      ALTER TABLE celebrations
        ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '365 days';
    `,
  },
  {
    // Alder Creek Golf Course — Remsen, NY. 9-hole layout played twice for
    // an 18-hole round (back 9 mirrors front 9 exactly per the scorecard).
    // The supplied 34.2 rating is the 9-hole figure; we store the doubled
    // 68.4 here so handicap math stays in 18-hole units like every other
    // course in the database. Slope 118 carries through unchanged (slope
    // is reported on an 18-hole basis already).
    //
    // ON CONFLICT DO NOTHING throughout so the migration is idempotent —
    // running it twice (re-deploy, environment restore) is a no-op.
    name: 'seed.alder_creek_remsen_ny',
    sql: `
      INSERT INTO courses (course_id, course_name, club_name, address, city, state, country, latitude, longitude) VALUES
        ('a2000000-0000-0000-0000-0000000a1de2', 'Alder Creek Golf Course', 'Alder Creek Golf & Country Club', 'NY-12, Remsen, NY 13438', 'Remsen', 'NY', 'United States', 43.4258, -75.2625)
      ON CONFLICT (course_id) DO NOTHING;

      INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
        ('b2000000-0000-0000-0000-0000000a1de2', 'a2000000-0000-0000-0000-0000000a1de2', 'White', 'male', 68.4, 118, 6356, 18, 72)
      ON CONFLICT (teebox_id) DO NOTHING;

      INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
        ('b2000000-0000-0000-0000-0000000a1de2',  1, 5, 515,  1),
        ('b2000000-0000-0000-0000-0000000a1de2',  2, 4, 352,  2),
        ('b2000000-0000-0000-0000-0000000a1de2',  3, 3, 158,  3),
        ('b2000000-0000-0000-0000-0000000a1de2',  4, 4, 350,  4),
        ('b2000000-0000-0000-0000-0000000a1de2',  5, 3, 175,  5),
        ('b2000000-0000-0000-0000-0000000a1de2',  6, 5, 525,  6),
        ('b2000000-0000-0000-0000-0000000a1de2',  7, 4, 423,  7),
        ('b2000000-0000-0000-0000-0000000a1de2',  8, 4, 347,  8),
        ('b2000000-0000-0000-0000-0000000a1de2',  9, 4, 333,  9),
        ('b2000000-0000-0000-0000-0000000a1de2', 10, 5, 515, 10),
        ('b2000000-0000-0000-0000-0000000a1de2', 11, 4, 352, 11),
        ('b2000000-0000-0000-0000-0000000a1de2', 12, 3, 158, 12),
        ('b2000000-0000-0000-0000-0000000a1de2', 13, 4, 350, 13),
        ('b2000000-0000-0000-0000-0000000a1de2', 14, 3, 175, 14),
        ('b2000000-0000-0000-0000-0000000a1de2', 15, 5, 525, 15),
        ('b2000000-0000-0000-0000-0000000a1de2', 16, 4, 423, 16),
        ('b2000000-0000-0000-0000-0000000a1de2', 17, 4, 347, 17),
        ('b2000000-0000-0000-0000-0000000a1de2', 18, 4, 333, 18)
      ON CONFLICT (teebox_id, hole_num) DO NOTHING;
    `,
  },
  {
    // Lake Pleasant Golf Course — Lake Pleasant, NY (Adirondacks, 315 area
    // code). 9-hole physical layout that's played twice for an 18-hole
    // round; the scorecard exposes two tee positions on each physical
    // hole so the front 9 and back 9 differ slightly in yardage on a few
    // holes (per the supplied scorecard). Stored as full 18-hole teeboxes
    // so the on-screen scorecard matches the printed one exactly — a
    // player who picks "9 holes" plays the front-9 tee positions, "18"
    // plays the full layout.
    //
    // Two tee colors recorded:
    //   • RED   — 4914 yds, Par 73, Rating 68.3 / Slope 114
    //   • WHITE — 5531 yds, Par 70, Rating 66.7 / Slope 110
    //
    // WHITE par follows the user-provided per-hole breakdown — holes 5/8
    // and their back-9 mirrors 14 are par-3 from WHITE despite being
    // par-4 from the (shorter, forward) RED tees, the standard
    // forward-vs-back-tee convention. HCP rankings: RED was provided
    // directly; WHITE re-uses RED's since the physical hole order is the
    // same and the relative difficulty ranking doesn't change with tee.
    //
    // Coords are approximate centroid of the course (Adirondack Park, NY).
    // ON CONFLICT DO NOTHING so the seed is idempotent.
    name: 'seed.lake_pleasant_ny',
    sql: `
      INSERT INTO courses (course_id, course_name, club_name, address, city, state, country, latitude, longitude) VALUES
        ('a3000001-0000-0000-0000-000000001ace', 'Lake Pleasant Golf Course', 'Lake Pleasant Golf Course', 'Lake Pleasant, NY', 'Lake Pleasant', 'NY', 'United States', 43.4793, -74.4153)
      ON CONFLICT (course_id) DO NOTHING;

      INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
        ('b3000001-0000-0000-0000-000000001ace', 'a3000001-0000-0000-0000-000000001ace', 'Red',   'female', 68.3, 114, 4914, 18, 73),
        ('b3000002-0000-0000-0000-000000001ace', 'a3000001-0000-0000-0000-000000001ace', 'White', 'male',   66.7, 110, 5531, 18, 70)
      ON CONFLICT (teebox_id) DO NOTHING;

      INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
        -- Red tees: 4914 yds / Par 73. Holes 4/5/8/9 vs 13/14/17/18 have
        -- slightly different yardages because the second pass uses an
        -- alternate tee marker on the same physical hole.
        ('b3000001-0000-0000-0000-000000001ace',  1, 4, 315,  7),
        ('b3000001-0000-0000-0000-000000001ace',  2, 5, 370,  9),
        ('b3000001-0000-0000-0000-000000001ace',  3, 4, 338,  1),
        ('b3000001-0000-0000-0000-000000001ace',  4, 3, 134,  5),
        ('b3000001-0000-0000-0000-000000001ace',  5, 4, 225, 15),
        ('b3000001-0000-0000-0000-000000001ace',  6, 5, 370, 13),
        ('b3000001-0000-0000-0000-000000001ace',  7, 4, 320,  3),
        ('b3000001-0000-0000-0000-000000001ace',  8, 4, 220, 17),
        ('b3000001-0000-0000-0000-000000001ace',  9, 4, 195, 11),
        ('b3000001-0000-0000-0000-000000001ace', 10, 4, 315,  8),
        ('b3000001-0000-0000-0000-000000001ace', 11, 5, 370, 12),
        ('b3000001-0000-0000-0000-000000001ace', 12, 4, 338,  2),
        ('b3000001-0000-0000-0000-000000001ace', 13, 3, 152,  6),
        ('b3000001-0000-0000-0000-000000001ace', 14, 4, 203, 18),
        ('b3000001-0000-0000-0000-000000001ace', 15, 5, 370, 16),
        ('b3000001-0000-0000-0000-000000001ace', 16, 4, 320,  4),
        ('b3000001-0000-0000-0000-000000001ace', 17, 3, 164, 10),
        ('b3000001-0000-0000-0000-000000001ace', 18, 4, 195, 14),

        -- White tees: 5531 yds / Par 70. Par diverges from RED on holes
        -- 5/8/14 (long par-3s from white that are short par-4s from the
        -- forward red tees).
        ('b3000002-0000-0000-0000-000000001ace',  1, 4, 315,  7),
        ('b3000002-0000-0000-0000-000000001ace',  2, 5, 458,  9),
        ('b3000002-0000-0000-0000-000000001ace',  3, 4, 390,  1),
        ('b3000002-0000-0000-0000-000000001ace',  4, 3, 134,  5),
        ('b3000002-0000-0000-0000-000000001ace',  5, 3, 225, 15),
        ('b3000002-0000-0000-0000-000000001ace',  6, 5, 426, 13),
        ('b3000002-0000-0000-0000-000000001ace',  7, 4, 320,  3),
        ('b3000002-0000-0000-0000-000000001ace',  8, 3, 220, 17),
        ('b3000002-0000-0000-0000-000000001ace',  9, 4, 290, 11),
        ('b3000002-0000-0000-0000-000000001ace', 10, 4, 315,  8),
        ('b3000002-0000-0000-0000-000000001ace', 11, 5, 458, 12),
        ('b3000002-0000-0000-0000-000000001ace', 12, 4, 390,  2),
        ('b3000002-0000-0000-0000-000000001ace', 13, 3, 152,  6),
        ('b3000002-0000-0000-0000-000000001ace', 14, 3, 203, 18),
        ('b3000002-0000-0000-0000-000000001ace', 15, 5, 426, 16),
        ('b3000002-0000-0000-0000-000000001ace', 16, 4, 320,  4),
        ('b3000002-0000-0000-0000-000000001ace', 17, 3, 164, 10),
        ('b3000002-0000-0000-0000-000000001ace', 18, 4, 325, 14)
      ON CONFLICT (teebox_id, hole_num) DO NOTHING;
    `,
  },
  {
    // Where the player aimed at the moment they finalised this shot,
    // captured from the on-map draggable heatmap target. Nullable — most
    // shots won't have it because the player only drags the target when
    // they want a different centerline than start→pin. Lateral-accuracy
    // stats use these when present so a deliberate "play the left side"
    // tee shot reads as accurate, not as a lateral miss.
    name: 'shots.aim_columns',
    sql: `
      ALTER TABLE shots
        ADD COLUMN IF NOT EXISTS aim_lat REAL,
        ADD COLUMN IF NOT EXISTS aim_lng REAL;
    `,
  },
  {
    // Per-shot geometry frozen at finalize time. Keeps lateral / total
    // values consistent with the player's intent at the moment they
    // tapped TRACK→stop — even if the pin gets re-pinned later, or the
    // course catalog adds a pin for a hole that didn't have one before.
    //   • total_yds   — raw great-circle distance start→end (yards).
    //   • lateral_yds — signed perpendicular offset from the centerline
    //                   the player aimed at. Sign convention: + = right.
    //   • lateral_ref — 'aim' or 'pin' depending on which centerline was
    //                   in scope. NULL when neither was available.
    name: 'shots.geometry_columns',
    sql: `
      ALTER TABLE shots
        ADD COLUMN IF NOT EXISTS total_yds   INTEGER,
        ADD COLUMN IF NOT EXISTS lateral_yds INTEGER,
        ADD COLUMN IF NOT EXISTS lateral_ref TEXT;
    `,
  },
  {
    // One-shot guard on the "X started a round" friend-notification path.
    // POST /matches/:id/started flips this to TRUE on the first call so a
    // re-mount of the scoring screen doesn't spam every friend repeatedly.
    // Schema.sql already has the column on fresh installs — this migration
    // covers existing prod DBs where the column never existed.
    name: 'matches.started_notified',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS started_notified BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // Per-user toggle for the content-safety profanity censor. Default
    // TRUE so new accounts and existing rows (which the ALTER backfills
    // with the default) start with the cleaner experience — the same
    // posture App Review will expect for a UGC app. A user who wants
    // to see unfiltered chat / posts / DMs can flip it OFF from the
    // Profile screen.
    name: 'users.censor_offensive_language',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS censor_offensive_language BOOLEAN NOT NULL DEFAULT TRUE;
    `,
  },
  {
    // clan_invites was referenced by clans.ts + users.ts (notifications)
    // for months but never defined in schema.sql or a prior migration. On
    // a fresh prod DB the invite endpoints silently failed against a
    // missing table. This idempotent ADD covers existing DBs that have
    // it (legacy hand-creation) and new ones equally.
    //   status flow: pending → accepted | declined (set by accept/decline)
    //   expires_at NULL = no expiry (the leader can revoke by re-inviting
    //   or the recipient can decline at any time).
    name: 'clan_invites.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS clan_invites (
        invite_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clan_id       UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
        from_user_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        to_user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_clan_invites_to_status
        ON clan_invites(to_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_clan_invites_clan
        ON clan_invites(clan_id);
    `,
  },
  {
    // User-submitted course-add requests. Pure inbox table — no automated
    // course creation happens from this; an admin reviews entries by hand
    // and runs the normal course-import flow if it's legit. Keeping it as
    // its own table (rather than e.g. a `courses.pending = true` flag) so
    // we never accidentally surface a half-validated course on /nearby or
    // /search before review.
    name: 'course_requests.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS course_requests (
        request_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
        course_name TEXT NOT NULL,
        city        TEXT,
        state       TEXT,
        country     TEXT,
        website     TEXT,
        notes       TEXT,
        status      TEXT NOT NULL DEFAULT 'pending', -- pending | added | rejected
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_course_requests_status_created
        ON course_requests(status, created_at DESC);
    `,
  },
  {
    // Comments on social-feed posts. Mirrors the round_comments table
    // (same shape: UUID PK, author FK, parent FK, ≤280-char body,
    // timestamp) so the client + push pattern carry over 1:1. ON DELETE
    // CASCADE on post_id means deleting a post cleans up its comment
    // thread automatically.
    name: 'post_comments.create_table',
    sql: `
      CREATE TABLE IF NOT EXISTS post_comments (
        comment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id     UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
        user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        body        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_post_comments_post_created
        ON post_comments(post_id, created_at);
    `,
  },
  {
    // Friends data backfill / reconciliation. The friends table stores ONE
    // directional row per friendship (user_id = initiator, friend_id =
    // recipient; status flips pending → accepted on accept). But older data
    // — created before the bidirectional-dedup guard landed in the
    // send-request endpoint — can contain BOTH (A,B) and (B,A) rows for the
    // same pair. That makes a single friend appear in both the Following
    // and Followers lists and double-counts them. This collapses every
    // bidirectional pair to a single canonical row and drops self-rows.
    //
    // Idempotent: after the first run there are no bidirectional pairs left,
    // so re-running deletes nothing.
    name: 'messages.image_url',
    sql: `
      ALTER TABLE messages         ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE direct_messages  ADD COLUMN IF NOT EXISTS image_url TEXT;
    `,
  },
  {
    // Beers logged during a round — drives the "Beer Ranker" leaderboards
    // (all-time total + per-round average). Stored per round so both
    // leaderboards derive from a single source of truth (no denormalized
    // counters to drift / double-count on score resubmits). NULL/0 = none
    // logged, which is the default for every existing round.
    name: 'rounds.beers',
    sql: `
      ALTER TABLE rounds ADD COLUMN IF NOT EXISTS beers INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Lifetime "Drinks Drunk" tally — a self-reported vanity counter the
    // user adjusts directly from their profile (+/-), not per-round. Kept
    // as a single column on users (was previously derived from
    // rounds.beers, but the per-round logging UI was removed in favour of
    // a profile stepper). Backfilled from any beers already logged on
    // rounds so existing data isn't lost.
    name: 'users.drinks',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS drinks INTEGER NOT NULL DEFAULT 0;
      UPDATE users u
         SET drinks = sub.total
        FROM (SELECT user_id, COALESCE(SUM(beers),0)::int AS total FROM rounds GROUP BY user_id) sub
       WHERE sub.user_id = u.user_id AND u.drinks = 0 AND sub.total > 0;
    `,
  },
  {
    name: 'friends.dedupe_backfill',
    sql: `
      -- (a) Self-friendships should never exist; remove any.
      DELETE FROM friends WHERE user_id = friend_id;

      -- (b) Collapse bidirectional pairs. For each pair {X,Y} that has rows
      --     in BOTH directions, delete the "weaker" row, keeping exactly
      --     one. Priority for which to KEEP:
      --       1. accepted beats pending (a real friendship wins)
      --       2. same status → keep the earlier created_at (original intent)
      --       3. exact tie → keep the lower user_id (deterministic)
      --     The DELETE removes row f when its reverse row g is "better".
      DELETE FROM friends f
      USING friends g
      WHERE f.user_id = g.friend_id
        AND f.friend_id = g.user_id
        AND (
          (g.status = 'accepted' AND f.status <> 'accepted')
          OR (g.status = f.status AND f.created_at > g.created_at)
          OR (g.status = f.status AND f.created_at = g.created_at AND f.user_id > g.user_id)
        );
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
