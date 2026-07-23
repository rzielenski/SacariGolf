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
    // Scramble shot attribution: who actually HIT the tracked shot. NULL = the
    // tracker (user_id) hit it themselves — the normal solo / non-scramble
    // case. In a scramble, one phone logs the selected shots and tags each with
    // the teammate whose ball was used, so distance / dispersion / closest-to-
    // pin count toward THAT player's stats (via COALESCE(owner_user_id,user_id)).
    // The atomic per-hole replace + map display still key on user_id (the
    // tracker), so only stat attribution changes.
    name: 'shots.owner_user_id',
    sql: `
      ALTER TABLE shots
        ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS shots_owner_club_idx
        ON shots(owner_user_id, club) WHERE owner_user_id IS NOT NULL;
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
    // LIVE round posts. A round post is now created the moment a player enters
    // their first score (see /matches/:id/progress), not only at completion,
    // so friends can follow the round on the feed as it fills in. To make that
    // safe against the completion-time inserts (resolveElo, bots, backfill),
    // there must be at most ONE round post per (user, match) that everything
    // can UPSERT onto. First collapse any pre-existing duplicates to the
    // earliest row, then add the partial unique index the ON CONFLICT clauses
    // arbitrate on. match_id IS NULL rows (orphaned when a match is wiped) are
    // left alone — NULLs are distinct in the index, so they don't collide.
    name: 'posts.round_unique_for_live',
    sql: `
      DELETE FROM posts p
        USING posts keep
       WHERE p.kind = 'round' AND keep.kind = 'round'
         AND p.user_id  = keep.user_id
         AND p.match_id = keep.match_id
         AND p.match_id IS NOT NULL
         AND (p.created_at > keep.created_at
              OR (p.created_at = keep.created_at AND p.post_id > keep.post_id));
      CREATE UNIQUE INDEX IF NOT EXISTS posts_round_user_match_uidx
        ON posts(user_id, match_id) WHERE kind = 'round';
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
  {
    // Case-insensitive username uniqueness. The base schema already has an
    // exact-match UNIQUE on username, so the only possible collisions differ
    // by case (e.g. "Rich" vs "rich"). Resolve those first — keep the
    // earliest account's name, suffix later ones with a short uid fragment —
    // then add a unique index on lower(username) so @mentions resolve to
    // exactly one user and case-variant impersonation is impossible.
    name: 'users.username_ci_unique',
    sql: `
      WITH dupes AS (
        SELECT user_id,
               row_number() OVER (PARTITION BY lower(username)
                                  ORDER BY created_at, user_id) AS rn
          FROM users
      )
      UPDATE users u
         SET username = left(u.username, 14) || '_' || left(replace(u.user_id::text, '-', ''), 4)
        FROM dupes d
       WHERE d.user_id = u.user_id AND d.rn > 1;
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq
        ON users (lower(username));
    `,
  },
  {
    // Optional one-line note the player attaches to a round when submitting;
    // becomes the body of the 'round' feed post created at match resolution.
    name: 'rounds.caption',
    sql: `ALTER TABLE rounds ADD COLUMN IF NOT EXISTS caption TEXT;`,
  },
  {
    // @mentions in feed posts (text/photo posts and round captions). One row
    // per (post, mentioned user); drives the "you were tagged" notification
    // surfaced in GET /users/me/notifications.
    name: 'post_mentions.create',
    sql: `
      CREATE TABLE IF NOT EXISTS post_mentions (
        post_id           UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
        mentioned_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        author_user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (post_id, mentioned_user_id)
      );
      CREATE INDEX IF NOT EXISTS post_mentions_user_idx
        ON post_mentions(mentioned_user_id, created_at DESC);
    `,
  },
  {
    // Backfill lateral/total for already-imported (launch-monitor / CSV)
    // shots. They were synthesised with the carry projected due NORTH and
    // the side-miss projected due EAST, but lateral_yds / total_yds were
    // never stored — so the target-relative dispersion read them as 0
    // ("every imported shot on line"). Recover them from the geometry:
    //   • lateral (+ = right) = east component = Δlng · R · cos(lat)
    //   • total                = hypotenuse of the north + east components
    // Only touches imported shots still missing the values, so it's safe to
    // re-run and won't clobber freshly-imported shots (which now store them).
    name: 'shots.backfill_imported_lateral',
    sql: `
      UPDATE shots
         SET lateral_yds = round(
               (radians(end_lng - start_lng) * 6371000 * cos(radians(start_lat))) * 1.0936
             )::int,
             total_yds = round(
               sqrt(
                 power(radians(end_lat - start_lat) * 6371000, 2) +
                 power(radians(end_lng - start_lng) * 6371000 * cos(radians(start_lat)), 2)
               ) * 1.0936
             )::int
       WHERE source = 'launch_monitor'
         AND lateral_yds IS NULL
         AND start_lat IS NOT NULL AND start_lng IS NOT NULL
         AND end_lat   IS NOT NULL AND end_lng   IS NOT NULL;
    `,
  },
  {
    // Lost/found golf-ball log — one row per ball the player taps to log.
    // Drives the "Ball Count" running tally + leaderboard. kind = 'found'
    // adds to the count, 'lost' subtracts; net = found − lost is the
    // headline number. Stored as individual events (not a denormalized
    // counter) so an undo is just deleting the most recent row and the
    // leaderboard always derives from a single source of truth.
    name: 'ball_log.create',
    sql: `
      CREATE TABLE IF NOT EXISTS ball_log (
        log_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('found', 'lost')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ball_log_user_idx
        ON ball_log(user_id, created_at DESC);
    `,
  },
  {
    // One-shot migration bookkeeping. The migration runner has no applied-table
    // (it relies on IF NOT EXISTS idempotency), but the ELO rescale below is a
    // population-wide transform that is NOT safe to re-run once live ratings
    // diverge — so it needs a real "has this run?" flag.
    name: 'migration_flags.create',
    sql: `
      CREATE TABLE IF NOT EXISTS migration_flags (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    // Ladder overhaul: new players start at the Wood 4 floor (100), not 1200.
    name: 'users.elo_default_100',
    sql: `ALTER TABLE users ALTER COLUMN elo SET DEFAULT 100;`,
  },
  {
    // Rebase the existing population onto the new ladder. Linear-scale every
    // user's ELO so the LAST-place player lands at Wood 4 / 0 LP (100) and the
    // FIRST-place player at Silver 2 / 0 LP (600), preserving the spread between
    // everyone. Guarded by migration_flags so it runs EXACTLY once — re-running
    // after ratings move would corrupt earned progress. If everyone shares one
    // ELO (no spread), they all reset to the 100 floor.
    name: 'users.elo_rescale_wood_silver2',
    sql: `
      DO $$
      DECLARE lo numeric; hi numeric;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE name = 'elo_rescale_wood_silver2_v1') THEN
          SELECT MIN(elo), MAX(elo) INTO lo, hi FROM users;
          IF hi IS NOT NULL THEN
            IF hi <= lo THEN
              UPDATE users SET elo = 100;
            ELSE
              UPDATE users SET elo = round(100 + (elo - lo) / (hi - lo) * 500)::int;
            END IF;
          END IF;
          INSERT INTO migration_flags(name) VALUES ('elo_rescale_wood_silver2_v1');
        END IF;
      END $$;
    `,
  },
  {
    // Golf Club of Newport, NY (Herkimer County). Two 18-hole tee sets off
    // the supplied scorecards, both Par 72 on the same physical holes, so
    // per-hole par and handicap are identical between tees and only the
    // yardages differ:
    //   Black 6792 yds, White ("Regular") 5988 yds, Rating 68.8 / Slope 129.
    //
    // NOTE: the 68.8 / 129 rating belongs to the White set. The Black rating
    // is carried as a placeholder pending confirmation, since a 6792-yard tee
    // rates harder than 68.8. Update the Black course_rating/slope_rating once
    // the real figures are known.
    //
    // Note on the back nine: each card prints OUT 36 / IN 36 / TOT 72, so the
    // back must carry two par 5s. Hole 18 is one; the only reading consistent
    // with the printed IN 36 makes hole 17 (the longest non-18 hole on the
    // back) the second par 5. Front nine sums to 36 as printed.
    //
    // ON CONFLICT DO NOTHING throughout so re-deploys / restores are no-ops.
    name: 'seed.golf_club_of_newport_ny',
    sql: `
      INSERT INTO courses (course_id, course_name, club_name, address, city, state, country, latitude, longitude) VALUES
        ('a4000000-0000-0000-0000-000000000001', 'Golf Club of Newport', 'Golf Club of Newport', 'Newport, NY', 'Newport', 'NY', 'United States', 43.183905, -75.046470)
      ON CONFLICT (course_id) DO NOTHING;

      INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
        ('b4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Black', 'male', 68.8, 129, 6792, 18, 72),
        ('b4000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000001', 'White', 'male', 68.8, 129, 5988, 18, 72)
      ON CONFLICT (teebox_id) DO NOTHING;

      INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
        ('b4000000-0000-0000-0000-000000000001',  1, 4, 371,  9),
        ('b4000000-0000-0000-0000-000000000001',  2, 4, 440,  3),
        ('b4000000-0000-0000-0000-000000000001',  3, 4, 352, 13),
        ('b4000000-0000-0000-0000-000000000001',  4, 3, 212, 15),
        ('b4000000-0000-0000-0000-000000000001',  5, 5, 538,  5),
        ('b4000000-0000-0000-0000-000000000001',  6, 4, 393,  1),
        ('b4000000-0000-0000-0000-000000000001',  7, 3, 130, 17),
        ('b4000000-0000-0000-0000-000000000001',  8, 5, 483,  7),
        ('b4000000-0000-0000-0000-000000000001',  9, 4, 455, 11),
        ('b4000000-0000-0000-0000-000000000001', 10, 4, 399, 12),
        ('b4000000-0000-0000-0000-000000000001', 11, 4, 421, 16),
        ('b4000000-0000-0000-0000-000000000001', 12, 4, 392,  2),
        ('b4000000-0000-0000-0000-000000000001', 13, 3, 212, 18),
        ('b4000000-0000-0000-0000-000000000001', 14, 4, 351, 10),
        ('b4000000-0000-0000-0000-000000000001', 15, 4, 400,  6),
        ('b4000000-0000-0000-0000-000000000001', 16, 3, 210, 14),
        ('b4000000-0000-0000-0000-000000000001', 17, 5, 452,  4),
        ('b4000000-0000-0000-0000-000000000001', 18, 5, 581,  8),
        -- White ("Regular") tees, 5988 yds. Same physical holes as Black, so
        -- par and handicap match; only the yardages change.
        ('b4000000-0000-0000-0000-000000000002',  1, 4, 328,  9),
        ('b4000000-0000-0000-0000-000000000002',  2, 4, 370,  3),
        ('b4000000-0000-0000-0000-000000000002',  3, 4, 309, 13),
        ('b4000000-0000-0000-0000-000000000002',  4, 3, 173, 15),
        ('b4000000-0000-0000-0000-000000000002',  5, 5, 490,  5),
        ('b4000000-0000-0000-0000-000000000002',  6, 4, 371,  1),
        ('b4000000-0000-0000-0000-000000000002',  7, 3, 110, 17),
        ('b4000000-0000-0000-0000-000000000002',  8, 5, 451,  7),
        ('b4000000-0000-0000-0000-000000000002',  9, 4, 357, 11),
        ('b4000000-0000-0000-0000-000000000002', 10, 4, 331, 12),
        ('b4000000-0000-0000-0000-000000000002', 11, 4, 396, 16),
        ('b4000000-0000-0000-0000-000000000002', 12, 4, 348,  2),
        ('b4000000-0000-0000-0000-000000000002', 13, 3, 158, 18),
        ('b4000000-0000-0000-0000-000000000002', 14, 4, 312, 10),
        ('b4000000-0000-0000-0000-000000000002', 15, 4, 400,  6),
        ('b4000000-0000-0000-0000-000000000002', 16, 3, 150, 14),
        ('b4000000-0000-0000-0000-000000000002', 17, 5, 412,  4),
        ('b4000000-0000-0000-0000-000000000002', 18, 5, 522,  8)
      ON CONFLICT (teebox_id, hole_num) DO NOTHING;
    `,
  },
  {
    // Track authorship of user-built courses. When a player adds a course
    // themselves through the in-app builder (POST /courses), we stamp who
    // submitted it and whether an admin has verified the data since. Both
    // columns are nullable / default-false so the ~27k seed-imported and
    // bulk-imported rows remain untouched.
    //   created_by_user_id  → NULL for seed / API imports
    //   verified            → TRUE only after a human review
    name: 'courses.user_authored',
    sql: `
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS verified           BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS courses_created_by_idx
        ON courses(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
    `,
  },
  {
    // Idempotency for ball_log + ball_log undo. The mobile ball counter
    // moved to an optimistic UI: taps update the local state instantly and
    // the API call rides a persistent retry queue, which means the same
    // request can fire twice over a flaky network. Without these, a retry
    // would double-log a found ball or double-delete via undo.
    //
    //   ball_log.client_id (nullable)
    //     • Partial unique index so legacy NULL rows coexist.
    //     • POST /balls/log uses ON CONFLICT (user_id, client_id) DO NOTHING
    //       on rows that carry a clientId.
    //
    //   ball_log_undo (new table)
    //     • Stores (user_id, client_id, deleted_log_id). POST /balls/undo
    //       checks the table first and short-circuits on a repeat clientId,
    //       returning the cached totals instead of deleting again.
    name: 'ball_log.client_id_idempotency',
    sql: `
      ALTER TABLE ball_log
        ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS ball_log_user_client_uniq
        ON ball_log(user_id, client_id) WHERE client_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS ball_log_undo (
        user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        client_id      TEXT NOT NULL,
        deleted_log_id UUID,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, client_id)
      );
    `,
  },
  {
    // Per-player "round-finished friend push fired" guard. Lives on
    // match_players so each finisher's friends get exactly one push per
    // round even if the player re-submits scores or edits an existing
    // round. Mirrors the matches.started_notified pattern at the player
    // level instead of the match level — async multiplayer matches
    // finish one player at a time, so per-player granularity is right.
    name: 'match_players.finished_notified',
    sql: `
      ALTER TABLE match_players
        ADD COLUMN IF NOT EXISTS finished_notified BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // Theme song max-volume preference. When TRUE the mobile theme player
    // overrides the silent switch and plays at max output (the most
    // iOS will allow a third-party app — system volume itself is not
    // programmatically controllable). Defaults FALSE so existing users
    // keep "respect silent mode" behaviour.
    name: 'users.theme_song_max_volume',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS theme_song_max_volume BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // Referral system:
    //   • users.referral_code        — the inviter's share code (in their
    //                                  /invite/<code> link). 7 chars,
    //                                  uppercase alphanumeric, unique. We
    //                                  generate on signup going forward and
    //                                  backfill existing rows below.
    //   • users.referred_by_user_id  — who invited this account. Nullable
    //                                  because (a) existing users weren't
    //                                  referred and (b) future signups can
    //                                  skip the code field.
    //
    // The reward today is a `lucky_round` perk (matches the open-beta posture
    // where premium is on the house). When pricing kicks in this should
    // switch to a 7-day premium grant; see backend/src/routes/auth.ts.
    //
    // The backfill is idempotent: it only generates codes for rows that
    // don't have one yet, and the loop retries on the unique-violation
    // edge case (vanishingly rare for 7×36 chars but possible).
    name: 'users.referral_columns',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS referral_code        TEXT,
        ADD COLUMN IF NOT EXISTS referred_by_user_id  UUID REFERENCES users(user_id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uniq
        ON users(referral_code) WHERE referral_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS users_referred_by_idx
        ON users(referred_by_user_id) WHERE referred_by_user_id IS NOT NULL;

      DO $$
      DECLARE
        u RECORD;
        code TEXT;
      BEGIN
        FOR u IN SELECT user_id FROM users WHERE referral_code IS NULL LOOP
          LOOP
            -- 7 uppercase alphanumeric chars. encode(gen_random_bytes()) ->
            -- base64 then strip the chars that aren't in [A-Z0-9] and slice.
            -- Re-rolls if we land short.
            SELECT upper(substring(translate(encode(gen_random_bytes(8), 'base64'),
                                              '+/=abcdefghijklmnopqrstuvwxyz', ''),
                                    1, 7))
              INTO code;
            EXIT WHEN length(code) = 7
                 AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code = code);
          END LOOP;
          UPDATE users SET referral_code = code WHERE user_id = u.user_id;
        END LOOP;
      END $$;
    `,
  },
  {
    // Per-player opt-in for the automated @Sacari Twitter/X digest. Default
    // FALSE — a player's name/score is only ever tweeted after they flip this
    // on in settings (PATCH /users/me { shareToTwitter }). The daily digest
    // folds everyone else into anonymous app-wide totals. See
    // utils/twitterDigest.ts.
    name: 'users.share_to_twitter',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS share_to_twitter BOOLEAN NOT NULL DEFAULT FALSE;`,
  },
  {
    // One row per day the digest job has handled — idempotency guard so a
    // restart or the 15-min scheduler tick never double-posts. digest_date is
    // the local calendar date in DIGEST_TZ; tweet_id is NULL on a quiet day we
    // deliberately skipped. See utils/twitterDigest.ts.
    name: 'digest_log.create',
    sql: `
      CREATE TABLE IF NOT EXISTS digest_log (
        digest_date DATE PRIMARY KEY,
        tweet_id    TEXT,
        posted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    // Rate-limit + audit log for scorecard OCR scans. Every
    // /courses/scan-scorecard call that actually reaches (and is billed by)
    // the vision API logs a row here; the endpoint counts a user's rows in
    // the trailing 24h and refuses past a daily cap, so a bored or malicious
    // user can't run the Anthropic bill up by spamming scans. One row per
    // billed attempt (not per course added), since every attempt costs a call.
    name: 'scorecard_scans.create',
    sql: `
      CREATE TABLE IF NOT EXISTS scorecard_scans (
        scan_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS scorecard_scans_user_created_idx
        ON scorecard_scans(user_id, created_at DESC);
    `,
  },
  {
    // F2P cosmetics. Five slot kinds today (border / background / username
    // / ball_trail / fx) with one row per item in `cosmetics`, one row per
    // owned item in `user_cosmetics`, and a denormalised "what's equipped
    // right now" set on the users table itself so feed/profile reads
    // don't have to join through a separate table on every render.
    //
    // unlock_kind discriminates how an item is acquired:
    //   • 'free'        — everyone owns it (seed loop below grants to all)
    //   • 'premium'     — premium members get it (granted on premium flip)
    //   • 'cup_winner'  — won the weekly Sacari Cup at a specific place
    //                     (1/2/3); awarded by the cup-resolution job
    //   • 'rank'        — reached a specific rank tier (granted by the
    //                     elo-tier promotion code path)
    // visual_data is opaque JSON that the mobile renderer interprets per
    // kind — e.g. { color: '#d4a93f' } for username flair, or a gradient
    // pair for backgrounds. The catalog ships as data, not code, so a
    // future cosmetic can be added without an app release.
    name: 'cosmetics.create',
    sql: `
      CREATE TABLE IF NOT EXISTS cosmetics (
        cosmetic_id  TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('border','background','username','ball_trail','fx')),
        name         TEXT NOT NULL,
        rarity       TEXT NOT NULL DEFAULT 'common',
        unlock_kind  TEXT NOT NULL CHECK (unlock_kind IN ('free','premium','cup_winner','rank')),
        unlock_data  JSONB,
        visual_data  JSONB NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cosmetics_kind_idx ON cosmetics(kind);
      CREATE INDEX IF NOT EXISTS cosmetics_unlock_kind_idx ON cosmetics(unlock_kind);

      CREATE TABLE IF NOT EXISTS user_cosmetics (
        user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        cosmetic_id    TEXT NOT NULL REFERENCES cosmetics(cosmetic_id) ON DELETE CASCADE,
        unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unlock_source  TEXT,
        PRIMARY KEY (user_id, cosmetic_id)
      );
      CREATE INDEX IF NOT EXISTS user_cosmetics_user_idx ON user_cosmetics(user_id);

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS equipped_border      TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS equipped_background  TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS equipped_username    TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS equipped_ball_trail  TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS equipped_fx          TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL;
    `,
  },
  {
    // Seed the starter catalog. Twelve items: enough for the screen to
    // feel populated on day one without locking the user into a tiny set
    // of cosmetics. Each item is idempotent via cosmetic_id PK.
    //
    // Naming scheme: <kind>_<theme> so adding new items doesn't risk
    // collision with anything outside this seed.
    name: 'cosmetics.seed_starter_catalog',
    sql: `
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        -- Borders
        ('border_classic',   'border', 'Classic',         'common',    'free',
          NULL,
          '{"color":"#aeb6c2","width":2}'::jsonb),
        ('border_fairway',   'border', 'Fairway Stripe',  'common',    'free',
          NULL,
          '{"color":"#74bd9a","width":3}'::jsonb),
        ('border_gold',      'border', 'Gold Frame',      'rare',      'premium',
          NULL,
          '{"color":"#d4a93f","width":3,"animated":true}'::jsonb),
        ('border_champion',  'border', 'Champion Wreath', 'legendary', 'cup_winner',
          '{"place":1}'::jsonb,
          '{"color":"#d4a93f","width":4,"animated":true,"glow":true}'::jsonb),
        ('border_obsidian',  'border', 'Obsidian Edge',   'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"color":"#e8623a","width":3,"animated":true}'::jsonb),

        -- Backgrounds
        ('bg_default',       'background', 'Slate',         'common',    'free',
          NULL,
          '{"from":"#1a1a1d","to":"#26262b"}'::jsonb),
        ('bg_fairway',       'background', 'Sunset Fairway','common',    'free',
          NULL,
          '{"from":"#0f3a2e","to":"#74bd9a"}'::jsonb),
        ('bg_royal',         'background', 'Royal Velvet',  'rare',      'premium',
          NULL,
          '{"from":"#1a0a2e","to":"#a89cf0"}'::jsonb),
        ('bg_gold_dust',     'background', 'Gold Dust',     'epic',      'cup_winner',
          '{"place":1}'::jsonb,
          '{"from":"#1a1410","to":"#d4a93f"}'::jsonb),

        -- Username flair
        ('uname_default',    'username',   'Standard',      'common',    'free',
          NULL,
          '{"color":"#ffffff"}'::jsonb),
        ('uname_gold',       'username',   'Gold Text',     'rare',      'premium',
          NULL,
          '{"color":"#d4a93f"}'::jsonb),
        ('uname_champion',   'username',   'Champion Gold', 'legendary', 'cup_winner',
          '{"place":1}'::jsonb,
          '{"color":"#d4a93f","gradient":["#d4a93f","#ffe28a","#d4a93f"]}'::jsonb),

        -- Ball trails (shot-map polyline color)
        ('trail_default',    'ball_trail', 'White',         'common',    'free',
          NULL,
          '{"color":"#ffffff","width":2}'::jsonb),
        ('trail_crimson',    'ball_trail', 'Crimson',       'common',    'free',
          NULL,
          '{"color":"#d83a5e","width":2}'::jsonb),
        ('trail_lightning',  'ball_trail', 'Lightning',     'rare',      'premium',
          NULL,
          '{"color":"#74e0ff","width":3,"glow":true}'::jsonb),
        ('trail_gold',       'ball_trail', 'Gold Streak',   'epic',      'cup_winner',
          '{"place":1}'::jsonb,
          '{"color":"#d4a93f","width":3,"glow":true,"animated":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO NOTHING;

      -- Grant every 'free' item to every existing user so the locker room
      -- shows owned items on day one. Idempotent via PK.
      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'free'
          FROM users u
          CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'free'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      -- Grant every 'premium' item to current premium members. The flip
      -- in routes/auth + premium handlers should also grant on future
      -- premium upgrades; this catches the existing population once.
      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'premium'
          FROM users u
          CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'premium'
           AND u.is_premium = TRUE
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      -- Default equipped: nudge every user into the 'free' starter set
      -- so the profile renders consistently even before they tap
      -- into the locker room. Only sets columns that are still null
      -- (won't overwrite anyone's existing pick).
      UPDATE users SET
        equipped_border     = COALESCE(equipped_border,     'border_classic'),
        equipped_background = COALESCE(equipped_background, 'bg_default'),
        equipped_username   = COALESCE(equipped_username,   'uname_default'),
        equipped_ball_trail = COALESCE(equipped_ball_trail, 'trail_default');
    `,
  },
  {
    // Weekly Sacari Cup. Auto-recurring tournament; one row per week,
    // keyed by Monday 00:00 UTC. The server boot routine in index.ts
    // (a) creates the current week's cup if it's missing and (b)
    // resolves any active cup whose week has ended.
    //
    // Resolution awards cup-winner cosmetics to top 3 finishers + posts
    // a feed card + sends push notifications. The leaderboard query
    // pulls each user's BEST round (lowest to-par with pro-rating for
    // 9/18-hole rounds) submitted during the week window.
    name: 'weekly_cups.create',
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_cups (
        cup_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        week_starts_at  TIMESTAMPTZ NOT NULL UNIQUE,
        status          TEXT NOT NULL DEFAULT 'active',
        resolved_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS weekly_cups_status_idx
        ON weekly_cups(status, week_starts_at DESC);
    `,
  },
  {
    // Pin which user_id won which cup. Used for the home-page banner,
    // the per-profile trophy row, and stats. The resolver writes here
    // alongside the user_cosmetics grant.
    name: 'weekly_cup_winners.create',
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_cup_winners (
        cup_id        UUID PRIMARY KEY REFERENCES weekly_cups(cup_id) ON DELETE CASCADE,
        user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        best_to_par   INTEGER NOT NULL,
        decided_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS weekly_cup_winners_user_idx
        ON weekly_cup_winners(user_id);
    `,
  },
  {
    // Cosmetics v2 — rewrite the catalog around a richer visual_data
    // schema and ditch the placeholder gold-frame/gold-text items. New
    // items are designed as season-pass tier rewards or premium perks,
    // not cup payouts; cup payouts collapse to just the Champion Wreath
    // border (+ a trophy count tracked separately via
    // weekly_cup_winners). Idempotent — only DELETEs items the seed
    // explicitly replaced, never touches user_cosmetics rows for
    // surviving items.
    name: 'cosmetics.catalog_v2',
    sql: `
      -- Drop the items the v2 seed is replacing. CASCADE clears any
      -- user_cosmetics rows pointing at them so nobody's stuck with a
      -- now-deleted reference.
      DELETE FROM user_cosmetics WHERE cosmetic_id IN (
        'border_gold', 'border_obsidian',
        'bg_fairway', 'bg_royal', 'bg_gold_dust',
        'uname_gold', 'uname_champion',
        'trail_lightning', 'trail_gold'
      );
      DELETE FROM cosmetics WHERE cosmetic_id IN (
        'border_gold', 'border_obsidian',
        'bg_fairway', 'bg_royal', 'bg_gold_dust',
        'uname_gold', 'uname_champion',
        'trail_lightning', 'trail_gold'
      );

      -- Clear equipped pointers that referenced now-deleted items so
      -- the FK doesn't dangle. Replacement defaults are reinstated below.
      UPDATE users SET
        equipped_border     = CASE WHEN equipped_border     IN ('border_gold','border_obsidian') THEN 'border_classic' ELSE equipped_border END,
        equipped_background = CASE WHEN equipped_background IN ('bg_fairway','bg_royal','bg_gold_dust') THEN 'bg_default' ELSE equipped_background END,
        equipped_username   = CASE WHEN equipped_username   IN ('uname_gold','uname_champion') THEN 'uname_default' ELSE equipped_username END,
        equipped_ball_trail = CASE WHEN equipped_ball_trail IN ('trail_lightning','trail_gold') THEN 'trail_default' ELSE equipped_ball_trail END;

      -- Seed v2. Each visual_data carries a 'style' discriminator the
      -- mobile renderer branches on; the rest of the fields describe
      -- the look. Tier rewards are season-pass-only — players can't
      -- find them anywhere else.
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        -- ── Borders ────────────────────────────────────────────────
        ('border_champion',  'border', 'Champion Wreath', 'legendary', 'cup_winner',
          '{"place":1}'::jsonb,
          '{"style":"glow","color":"#d4a93f","accent":"#ffe28a","width":4,"animated":true}'::jsonb),
        ('border_holographic','border','Holographic',    'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"holographic","colors":["#ff6b9d","#74e0ff","#a89cf0","#ffe28a"],"width":3,"animated":true}'::jsonb),
        ('border_storm',     'border', 'Storm Edge',     'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"pulse","color":"#5a76b0","accent":"#cad9ff","width":3,"animated":true}'::jsonb),

        -- ── Backgrounds ────────────────────────────────────────────
        ('bg_america',       'background', 'Stars & Stripes', 'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"flag","stripes":["#bf0a30","#ffffff"],"canton":"#002868","stars":50,"animated":false}'::jsonb),
        ('bg_storm',         'background', 'Thunderstorm',    'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"pulse","from":"#0a0f1c","to":"#3a4060","flash":"#cad9ff","animated":true}'::jsonb),
        ('bg_aurora',        'background', 'Aurora',          'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"aurora","layers":["#00ff9d","#7fa2ff","#c779ff"],"from":"#04161e","animated":true}'::jsonb),
        ('bg_cosmic',        'background', 'Cosmic Drift',    'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"stars","from":"#040515","to":"#1a0a3a","stars":80,"animated":false}'::jsonb),
        ('bg_volcanic',      'background', 'Volcanic',        'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"gradient","from":"#1a0807","to":"#e8623a","accent":"#ffd700"}'::jsonb),

        -- ── Ball trails (shot map polyline) ────────────────────────
        ('trail_lightning',  'ball_trail', 'Lightning Crackle','legendary','rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"crackle","color":"#74e0ff","accent":"#ffffff","width":3,"animated":true,"glow":true}'::jsonb),
        ('trail_fire',       'ball_trail', 'Wildfire',        'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"gradient","color":"#ffb14a","accent":"#d83a5e","width":3,"animated":true,"glow":true}'::jsonb),
        ('trail_galaxy',     'ball_trail', 'Galaxy',          'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"gradient","color":"#c779ff","accent":"#74e0ff","width":3,"animated":true,"glow":true}'::jsonb),
        ('trail_neon',       'ball_trail', 'Neon Pulse',      'rare',     'premium',
          NULL,
          '{"style":"pulse","color":"#39ff14","width":3,"animated":true,"glow":true}'::jsonb),

        -- ── Username flair ────────────────────────────────────────
        ('uname_holographic','username', 'Holographic Text',  'legendary','rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"gradient","gradient":["#ff6b9d","#74e0ff","#a89cf0"],"animated":true}'::jsonb),
        ('uname_fire',       'username', 'Wildfire Text',     'epic',     'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"gradient","gradient":["#ffb14a","#d83a5e"],"animated":true}'::jsonb),
        ('uname_ice',        'username', 'Ice Crystal',       'rare',     'premium',
          NULL,
          '{"style":"solid","color":"#74e0ff","glow":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO UPDATE
        SET kind        = EXCLUDED.kind,
            name        = EXCLUDED.name,
            rarity      = EXCLUDED.rarity,
            unlock_kind = EXCLUDED.unlock_kind,
            unlock_data = EXCLUDED.unlock_data,
            visual_data = EXCLUDED.visual_data;

      -- Catch-up: grant premium items to current premium members + grant
      -- free items to everyone, same as v1. Rank-locked items are NOT
      -- granted here — they're awarded via the season-pass and
      -- rank-promotion code paths.
      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'free'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'free'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'premium'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'premium'
           AND u.is_premium  = TRUE
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;
    `,
  },
  {
    // Season pass. One season per calendar month, auto-created by
    // utils/seasonPass.ts on boot. XP is earned 1 per completed ranked
    // round (~10 rounds = full pass). The reward ladder is data-driven:
    // season_pass_tiers rows define which cosmetic the player gets at
    // each XP threshold. claimed_tiers JSONB on the progress row
    // tracks what the user has already pulled.
    name: 'season_pass.create_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS seasons (
        season_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        starts_at      TIMESTAMPTZ NOT NULL UNIQUE,
        ends_at        TIMESTAMPTZ NOT NULL,
        name           TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS seasons_window_idx
        ON seasons(starts_at, ends_at);

      CREATE TABLE IF NOT EXISTS season_pass_tiers (
        season_id      UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
        tier           INT  NOT NULL,
        xp_required    INT  NOT NULL,
        cosmetic_id    TEXT REFERENCES cosmetics(cosmetic_id) ON DELETE SET NULL,
        PRIMARY KEY (season_id, tier)
      );

      CREATE TABLE IF NOT EXISTS season_pass_progress (
        user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        season_id       UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
        xp              INT  NOT NULL DEFAULT 0,
        claimed_tiers   INT[] NOT NULL DEFAULT '{}',
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, season_id)
      );
      CREATE INDEX IF NOT EXISTS season_pass_progress_season_idx
        ON season_pass_progress(season_id, xp DESC);
    `,
  },
  {
    // Catalog v3: refines visual_data on items the v2 seed used a
    // placeholder style for (e.g. trail_fire was 'gradient', now 'fire'
    // so the renderer paints rising embers; bg_volcanic was a static
    // gradient, now uses the 'flame' renderer with wisps) AND adds 18
    // new cosmetics across every kind so the renderer's full set of
    // styles has paying inventory behind it.
    //
    // Idempotent — UPSERT on cosmetic_id means re-running the migration
    // just refreshes visual_data. New rank-locked items are NOT
    // back-granted to qualifying users here; rank promotion writes the
    // grant rows so this migration stays predictable. Premium items
    // catch up via the same pattern v2 used.
    name: 'cosmetics.catalog_v3',
    sql: `
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        -- ── REFRESH: existing items get the right renderer style ─────
        ('bg_volcanic',       'background', 'Volcanic',         'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"flame","from":"#1a0807","to":"#5e1a14","accent":"#ffb14a","animated":true}'::jsonb),
        ('trail_fire',        'ball_trail', 'Wildfire',         'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"fire","color":"#ffb14a","accent":"#d83a5e","width":3,"animated":true,"glow":true}'::jsonb),
        ('trail_galaxy',      'ball_trail', 'Galaxy',           'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"galaxy","color":"#c779ff","accent":"#74e0ff","width":3,"animated":true,"glow":true}'::jsonb),
        ('uname_holographic', 'username',   'Holographic Text', 'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"holographic","gradient":["#ff6b9d","#74e0ff","#a89cf0","#ffe28a","#ff6b9d"],"animated":true}'::jsonb),
        ('uname_fire',        'username',   'Wildfire Text',    'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"gradient","gradient":["#ffe28a","#ffb14a","#d83a5e"],"animated":true}'::jsonb),

        -- ── NEW BACKGROUNDS (6) ──────────────────────────────────────
        ('bg_cyber_grid',     'background', 'Cyber Grid',       'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"cyber","from":"#02060e","to":"#0a1e2e","accent":"#00ffd5","animated":true}'::jsonb),
        ('bg_solar_flare',    'background', 'Solar Flare',      'legendary', 'cup_winner',
          '{"place":1}'::jsonb,
          '{"style":"solar","from":"#2a0d05","to":"#0a0204","accent":"#ffb14a","core":"#fff3a8","animated":true}'::jsonb),
        ('bg_deep_ocean',     'background', 'Deep Ocean',       'epic',      'premium',
          NULL,
          '{"style":"ocean","from":"#0a1e3a","to":"#072a48","accent":"#5aacd9","animated":true}'::jsonb),
        ('bg_sakura_fall',    'background', 'Sakura Fall',      'epic',      'premium',
          NULL,
          '{"style":"sakura","from":"#3a1a2a","to":"#7a3a55","animated":true}'::jsonb),
        ('bg_liquid_gold',    'background', 'Liquid Gold',      'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"liquid","animated":true}'::jsonb),
        ('bg_phoenix_rise',   'background', 'Phoenix Rise',     'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"flame","from":"#1a0207","to":"#5e0a14","accent":"#ff8a3a","animated":true}'::jsonb),

        -- ── NEW BORDERS (4) ──────────────────────────────────────────
        ('border_comet',      'border',     'Comet Trail',      'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"traveling","color":"#ffe28a","width":3,"animated":true}'::jsonb),
        ('border_plasma',     'border',     'Plasma Coil',      'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"plasma","color":"#c779ff","accent":"#74e0ff","width":3,"animated":true}'::jsonb),
        ('border_frost',      'border',     'Frost Crown',      'epic',      'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"frost","color":"#74e0ff","accent":"#cad9ff","width":3,"animated":true}'::jsonb),
        ('border_inferno',    'border',     'Inferno Ring',     'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"flame","width":3,"animated":true}'::jsonb),

        -- ── NEW BALL TRAILS (2) ──────────────────────────────────────
        ('trail_phoenix',     'ball_trail', 'Phoenix Wing',     'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"fire","color":"#ff8a3a","accent":"#bf1a3a","width":3,"animated":true,"glow":true}'::jsonb),
        ('trail_comet',       'ball_trail', 'Comet',            'rare',      'premium',
          NULL,
          '{"style":"traveling","color":"#ffe28a","width":3,"animated":true,"glow":true}'::jsonb),

        -- ── NEW USERNAMES (3) ────────────────────────────────────────
        ('uname_sunset',      'username',   'Sunset',           'epic',      'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"gradient","gradient":["#ffe28a","#ff6b9d","#a36bff"],"animated":true}'::jsonb),
        ('uname_ocean',       'username',   'Ocean',            'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"gradient","gradient":["#74e0ff","#3d8bbf","#0a1e3a"],"animated":true}'::jsonb),
        ('uname_shimmer',     'username',   'Gold Shimmer',     'epic',      'cup_winner',
          '{"place":1}'::jsonb,
          '{"style":"shimmer","color":"#d4a93f","animated":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO UPDATE
        SET kind        = EXCLUDED.kind,
            name        = EXCLUDED.name,
            rarity      = EXCLUDED.rarity,
            unlock_kind = EXCLUDED.unlock_kind,
            unlock_data = EXCLUDED.unlock_data,
            visual_data = EXCLUDED.visual_data;

      -- Catch-up grants for non-rank items: same pattern as v2. Rank-
      -- locked items wait for the rank-promotion code path so this
      -- migration doesn't accidentally hand out rewards to people who
      -- haven't earned them — except for the testing account.
      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'free'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'free'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'premium'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'premium' AND u.is_premium = TRUE
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      -- Test account gets everything so Richard can preview before
      -- shipping. Safe to leave in — the username is unique.
      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'admin_grant'
          FROM users u CROSS JOIN cosmetics c
         WHERE LOWER(u.username) = 'rickybobbyfairways'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;
    `,
  },
  {
    // Catalog v4: ten artistic, VFX-heavy additions. Each maps to a new
    // renderer style shipped in the same binary as v3's styles, so there
    // is no live-binary regression risk: nothing existing is restyled,
    // these are purely new rows. Same idempotent UPSERT + grant pattern
    // as v3.
    name: 'cosmetics.catalog_v4',
    sql: `
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        -- ── Backgrounds (5) ──────────────────────────────────────────
        ('bg_synthwave',   'background', 'Synthwave',     'epic',      'premium',
          NULL,
          '{"style":"synthwave","accent":"#ff2d95","grid":"#ff2d95","animated":true}'::jsonb),
        ('bg_eclipse',     'background', 'Total Eclipse', 'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"eclipse","accent":"#ffdf8a","animated":true}'::jsonb),
        ('bg_matrix',      'background', 'Digital Rain',  'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"matrix","color":"#00ff41","animated":true}'::jsonb),
        ('bg_dusk',        'background', 'Golden Hour',   'epic',      'premium',
          NULL,
          '{"style":"dusk","animated":true}'::jsonb),
        ('bg_thunder',     'background', 'Tempest',       'legendary', 'rank',
          '{"tier":"ruby"}'::jsonb,
          '{"style":"thunder","from":"#0b0918","to":"#2a2440","animated":true}'::jsonb),

        -- ── Borders (2) ──────────────────────────────────────────────
        ('border_tesla',   'border', 'Storm Cage', 'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"tesla","color":"#74e0ff","accent":"#e4ecff","width":3,"animated":true}'::jsonb),
        ('border_corona',  'border', 'Corona',     'epic',      'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"eclipse","color":"#d4a93f","accent":"#ffe28a","width":3,"animated":true}'::jsonb),

        -- ── Usernames (2) ────────────────────────────────────────────
        ('uname_neon',     'username', 'Neon Sign', 'epic', 'premium',
          NULL,
          '{"style":"neon","color":"#ff2d95","animated":true}'::jsonb),
        ('uname_glitch',   'username', 'Glitch',    'epic', 'rank',
          '{"tier":"platinum"}'::jsonb,
          '{"style":"glitch","color":"#ffffff","animated":true}'::jsonb),

        -- ── Ball trails (1) ──────────────────────────────────────────
        ('trail_rainbow',  'ball_trail', 'Prism Ribbon', 'epic', 'premium',
          NULL,
          '{"style":"rainbow","width":3,"animated":true,"glow":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO UPDATE
        SET kind        = EXCLUDED.kind,
            name        = EXCLUDED.name,
            rarity      = EXCLUDED.rarity,
            unlock_kind = EXCLUDED.unlock_kind,
            unlock_data = EXCLUDED.unlock_data,
            visual_data = EXCLUDED.visual_data;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'free'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'free'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'premium'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'premium' AND u.is_premium = TRUE
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'admin_grant'
          FROM users u CROSS JOIN cosmetics c
         WHERE LOWER(u.username) = 'rickybobbyfairways'
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;
    `,
  },
  {
    // Chat send idempotency. The mobile app stamps every send with a
    // client-generated id; a retry after an ambiguous network failure
    // (request landed, response lost) hits the partial unique index and
    // returns the original row instead of duplicating the message. Also
    // adds the thread-poll indexes: every open chat screen polls its
    // thread every 5 seconds, which was a sequential scan before.
    name: 'chat.client_id_idempotency',
    sql: `
      ALTER TABLE messages        ADD COLUMN IF NOT EXISTS client_id TEXT;
      ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS messages_client_dedupe
        ON messages(user_id, client_id) WHERE client_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS dm_client_dedupe
        ON direct_messages(from_user_id, client_id) WHERE client_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_match_created_idx
        ON messages(match_id, created_at) WHERE match_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_clan_created_idx
        ON messages(clan_id, created_at) WHERE clan_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS dm_pair_created_idx
        ON direct_messages(from_user_id, to_user_id, created_at);
    `,
  },
  {
    // Server-driven app configuration. The mobile app fetches /config on
    // boot (cached locally); keys can be changed from the Railway console
    // or POST /admin/config without an app release. Today: min_version
    // (drives the in-app "update required" banner), banner (freeform
    // announcement text or null), features (flag object for gating
    // future work). Seed defaults never overwrite edited values.
    name: 'app_config.create',
    sql: `
      CREATE TABLE IF NOT EXISTS app_config (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO app_config (key, value) VALUES
        ('min_version', '"1.0.0"'::jsonb),
        ('banner',      'null'::jsonb),
        ('features',    '{}'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `,
  },
  {
    // Linked matches. Two waiting duo/squad matches that share a player
    // can't be MERGED (one match can't hold a player on both sides or two
    // rounds for them — match_players PK and rounds UNIQUE are both
    // (match_id,user_id)). Instead they're LINKED: both stay separate,
    // paired_match_id points each at the other, every player plays their
    // own round, and resolution compares the two teams. Nullable + ON
    // DELETE SET NULL so deleting one match doesn't cascade-orphan.
    name: 'matches.paired_match_id',
    sql: `
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS paired_match_id UUID REFERENCES matches(match_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS matches_paired_idx
        ON matches(paired_match_id) WHERE paired_match_id IS NOT NULL;
    `,
  },
  {
    // Hot-path indexes for the highest-frequency reads: home feed, the
    // profile screens' recent/best round queries, membership checks, and
    // the friends graph that gates feed, DMs, and follower lists.
    name: 'perf.hot_path_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS posts_created_idx
        ON posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS rounds_user_created_idx
        ON rounds(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS match_players_user_idx
        ON match_players(user_id);
      CREATE INDEX IF NOT EXISTS friends_user_status_idx
        ON friends(user_id, status);
      CREATE INDEX IF NOT EXISTS friends_friend_status_idx
        ON friends(friend_id, status);
    `,
  },
  {
    // Comment send idempotency for round + post comments. Same contract as
    // chat.client_id_idempotency: the composer stamps every send with a
    // client-generated id, so a retry after an ambiguous network failure
    // (request landed, response lost) hits the partial unique index and
    // gets the original row back instead of double-posting the comment.
    // Partial indexes so pre-existing NULL rows coexist.
    name: 'comments.client_id_idempotency',
    sql: `
      ALTER TABLE round_comments ADD COLUMN IF NOT EXISTS client_id TEXT;
      ALTER TABLE post_comments  ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS round_comments_client_dedupe
        ON round_comments(user_id, client_id) WHERE client_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS post_comments_client_dedupe
        ON post_comments(user_id, client_id) WHERE client_id IS NOT NULL;
    `,
  },
  {
    // Owner group. users.is_owner flags staff/owner accounts: they
    // dynamically own every cosmetic, count as premium, and can broadcast
    // an "@everyone" announcement post that pushes to all users. Add or
    // remove an owner straight from the DB, no app change:
    //   UPDATE users SET is_owner = true  WHERE LOWER(username) = 'someone';
    //   UPDATE users SET is_owner = false WHERE LOWER(username) = 'someone';
    // posts.is_announcement marks an owner's @everyone broadcast so it
    // surfaces in EVERY user's feed (bypassing the friends/local scope),
    // and the partial index keeps that feed union cheap.
    name: 'owner_group.create',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_announcement BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS posts_announcement_idx
        ON posts(created_at DESC) WHERE is_announcement = TRUE;
      -- Seed the existing test/owner account so it works out of the box.
      UPDATE users SET is_owner = TRUE WHERE LOWER(username) = 'rickybobbyfairways';
    `,
  },
  {
    // Live scoreboard opt-in. Each player can agree to share their scores
    // live during a match; when at least one player on EACH side has opted
    // in ("both sides agree"), the match's anti-cheat redaction lifts and
    // everyone sees live scores hole-by-hole (Golf Game Book style).
    name: 'match_players.live_scores_optin',
    sql: `
      ALTER TABLE match_players
        ADD COLUMN IF NOT EXISTS live_scores_optin BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // Per-hole tee-box GPS for the course-preview feature. Unlike pins (the
    // green is shared across every teebox), the tee marker is PER teebox —
    // the Black tees and Red tees start at different spots — so these columns
    // live on the per-teebox holes rows and are set by the teebox-specific
    // tee-marking screen. Crowd-sourced, last-write-wins, audited like pins.
    name: 'holes.tee_coords',
    sql: `
      ALTER TABLE holes
        ADD COLUMN IF NOT EXISTS tee_lat REAL,
        ADD COLUMN IF NOT EXISTS tee_lng REAL,
        ADD COLUMN IF NOT EXISTS tee_set_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tee_set_by UUID REFERENCES users(user_id);
    `,
  },
  {
    // When a match was LINKED to its opponent (paired_match_id set). The
    // un-pair cron releases a linked pair after 3 days if one side never
    // finished. Backfill existing linked matches from created_at so the rule
    // applies to the current backlog of paired-but-unresolved matches too.
    name: 'matches.paired_at',
    sql: `
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS paired_at TIMESTAMPTZ;
      UPDATE matches
         SET paired_at = created_at
       WHERE paired_match_id IS NOT NULL AND paired_at IS NULL;
    `,
  },
  {
    // CPU opponents. A pool of bot accounts (one per rank) fills a player's
    // match when no human turns up for a few hours, so nobody is stranded
    // waiting. Bots are hidden from leaderboards / feed / search and never
    // gain or lose ELO themselves (their rating just marks their skill band).
    name: 'users.is_bot',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS users_is_bot_idx ON users(is_bot) WHERE is_bot = TRUE;
    `,
  },
  {
    // When a player FINISHED their round. The bot fill-in waits a few hours
    // after THIS (not after match creation) before subbing in a CPU opponent.
    // Backfill existing finished rows to NOW() so the clock starts at deploy
    // rather than instantly bot-matching the whole waiting backlog.
    name: 'match_players.completed_at',
    sql: `
      ALTER TABLE match_players ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      UPDATE match_players SET completed_at = NOW()
       WHERE completed = TRUE AND completed_at IS NULL;
    `,
  },
  {
    // Phase 3 tournaments: a winner pin + a dedicated champion cosmetic prize.
    // The cosmetics CHECK only allowed free/premium/cup_winner/rank — widen it
    // for a 'tournament_winner' kind so the prize is NOT auto-granted to weekly
    // Sacari Cup winners (which key on unlock_kind='cup_winner').
    name: 'tournaments.phase3_prize',
    sql: `
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS winner_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
      ALTER TABLE cosmetics DROP CONSTRAINT IF EXISTS cosmetics_unlock_kind_check;
      ALTER TABLE cosmetics ADD CONSTRAINT cosmetics_unlock_kind_check
        CHECK (unlock_kind IN ('free','premium','cup_winner','rank','tournament_winner'));
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        ('border_tournament_champ', 'border', 'Tournament Champion', 'legendary', 'tournament_winner',
          '{"place":1}'::jsonb,
          '{"style":"glow","color":"#d4a93f","width":3,"animated":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO UPDATE
        SET kind = EXCLUDED.kind, name = EXCLUDED.name, rarity = EXCLUDED.rarity,
            unlock_kind = EXCLUDED.unlock_kind, unlock_data = EXCLUDED.unlock_data,
            visual_data = EXCLUDED.visual_data;
    `,
  },
  {
    // Bag + partial-swing overhaul: a per-shot partial-swing tag (e.g. '75%' or
    // '9:00'; NULL = a full swing) and the user's preferred entry mode for it.
    name: 'shots.partial_value_and_user_mode',
    sql: `
      ALTER TABLE shots ADD COLUMN IF NOT EXISTS partial_value TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS partial_swing_mode TEXT NOT NULL DEFAULT 'percentage';
    `,
  },
  {
    // Stored per-round comparison score, computed in app code (utils/scoring.ts
    // normalizedScore, via utils/roundScore.ts): an 18-hole-equivalent score
    // that is rating/slope-adjusted (a USGA differential) when the teebox has a
    // course rating + slope, else a par-based to-par. Every cross-player board
    // ranks on this one integer instead of recomputing a formula in SQL. NULL
    // until the submit hook / reconcile pass fills it (or forever if the teebox
    // has no par). The index covers the reconcile scan + leaderboard ORDER BYs.
    name: 'rounds.normalized_to_par',
    sql: `
      ALTER TABLE rounds ADD COLUMN IF NOT EXISTS normalized_to_par INTEGER;
      CREATE INDEX IF NOT EXISTS rounds_normalized_to_par_idx ON rounds(normalized_to_par);
    `,
  },
  {
    // Earned titles — flexed under your name. Catalog + ownership + one equipped
    // slot on users. Awarded by utils/titles.ts (all derivable from existing
    // stats, so they backfill on boot).
    name: 'titles.system',
    sql: `
      CREATE TABLE IF NOT EXISTS titles (
        title_id     TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        rarity       TEXT NOT NULL DEFAULT 'common',
        sort         INT  NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_titles (
        user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        title_id    TEXT NOT NULL REFERENCES titles(title_id) ON DELETE CASCADE,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, title_id)
      );
      CREATE INDEX IF NOT EXISTS user_titles_user_idx ON user_titles(user_id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_title TEXT REFERENCES titles(title_id) ON DELETE SET NULL;
      INSERT INTO titles (title_id, name, description, rarity, sort) VALUES
        ('first_blood',  'First Blood',  'Win your first ranked match.',             'common',    10),
        ('dominating',   'Dominating',   'Win 3 ranked matches in a row.',           'rare',      20),
        ('unstoppable',  'Unstoppable',  'Win 5 ranked matches in a row.',           'epic',      30),
        ('godlike',      'Godlike',      'Win 8 ranked matches in a row.',           'epic',      40),
        ('legendary',    'Legendary',    'Win 12 ranked matches in a row.',          'legendary', 50),
        ('challenger',   'Challenger',   'Climb to Obsidian.',                        'legendary', 60),
        ('prodigy',      'Prodigy',      'Reach Diamond in under 30 matches.',        'epic',      70),
        ('veteran',      'Veteran',      'Play 50 ranked matches.',                   'rare',      80),
        ('smurf',        'Smurf',        'Win 70% of your matches over 20+ played.',  'epic',      90),
        ('eagle_hunter', 'Eagle Hunter', 'Card 5 career eagles.',                     'rare',      100),
        ('albatross',    'Albatross',    'Card an albatross (3-under on a hole).',    'legendary', 110),
        ('ace',          'Ace',          'Make a hole-in-one.',                       'epic',      120),
        ('iron_tour',    'Iron Tour',    'Track 100 shots.',                          'rare',      130),
        ('globetrotter', 'Globetrotter', 'Play 10 different courses.',                'rare',      140),
        ('cup_champion', 'Cup Champion', 'Win the Sacari Cup.',                       'legendary', 150),
        ('giant_slayer', 'Giant Slayer', 'Beat a player who was on a 5+ win streak.', 'epic',     145)
      ON CONFLICT (title_id) DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description,
            rarity = EXCLUDED.rarity, sort = EXCLUDED.sort;
    `,
  },
  {
    // Catalog v5: six new animated backgrounds. The renderer styles ship in
    // Cosmetics.tsx (nebula / embers / meteor / plasma / blizzard / prism);
    // this just gives them inventory. Same idempotent UPSERT + catch-up grant
    // pattern as v4 — premium items reach premium users, rank items wait for
    // the rank-promotion code path so this migration never hands out rewards.
    name: 'cosmetics.catalog_v5',
    sql: `
      INSERT INTO cosmetics (cosmetic_id, kind, name, rarity, unlock_kind, unlock_data, visual_data) VALUES
        ('bg_nebula',     'background', 'Nebula',        'legendary', 'premium',
          NULL,
          '{"style":"nebula","from":"#070314","to":"#13042a","clouds":["#b14ad9","#4a6bd9","#d94a8a"],"animated":true}'::jsonb),
        ('bg_embers',     'background', 'Fireflies',     'epic',      'premium',
          NULL,
          '{"style":"embers","from":"#0a0f0a","to":"#04140e","accent":"#ffcf7a","animated":true}'::jsonb),
        ('bg_meteor',     'background', 'Meteor Shower', 'legendary', 'rank',
          '{"tier":"diamond"}'::jsonb,
          '{"style":"meteor","from":"#060814","to":"#0e1430","accent":"#cfe0ff","animated":true}'::jsonb),
        ('bg_plasma',     'background', 'Plasma',        'epic',      'premium',
          NULL,
          '{"style":"plasma","from":"#0b0518","to":"#04030f","colors":["#7a2ad9","#2a6bd9","#d92a8a","#2ad9c4","#c98a2a"],"animated":true}'::jsonb),
        ('bg_blizzard',   'background', 'Blizzard',      'epic',      'premium',
          NULL,
          '{"style":"blizzard","from":"#1a2a3e","to":"#0a1420","accent":"#cfe6ff","animated":true}'::jsonb),
        ('bg_prism',      'background', 'Prism',         'legendary', 'rank',
          '{"tier":"obsidian"}'::jsonb,
          '{"style":"prism","from":"#0a0a14","to":"#141020","colors":["#ff6b9d","#ffd166","#5ad9c4","#74a8ff","#c779ff"],"animated":true}'::jsonb)
      ON CONFLICT (cosmetic_id) DO UPDATE
        SET kind        = EXCLUDED.kind,
            name        = EXCLUDED.name,
            rarity      = EXCLUDED.rarity,
            unlock_kind = EXCLUDED.unlock_kind,
            unlock_data = EXCLUDED.unlock_data,
            visual_data = EXCLUDED.visual_data;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'premium'
          FROM users u CROSS JOIN cosmetics c
         WHERE c.unlock_kind = 'premium' AND u.is_premium = TRUE
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;

      INSERT INTO user_cosmetics (user_id, cosmetic_id, unlock_source)
        SELECT u.user_id, c.cosmetic_id, 'admin_grant'
          FROM users u CROSS JOIN cosmetics c
         WHERE LOWER(u.username) = 'rickybobbyfairways'
           AND c.cosmetic_id IN ('bg_nebula','bg_embers','bg_meteor','bg_plasma','bg_blizzard','bg_prism')
      ON CONFLICT (user_id, cosmetic_id) DO NOTHING;
    `,
  },
  {
    // Creator Leagues — a creator-branded flavor of a tournament. Reuses the
    // whole tournaments/leaderboard/join-code engine; these columns add the
    // branding + a "beat the creator" target (the creator's standing score the
    // whole field tries to beat, stored as 18-hole-equivalent to-par so 9- and
    // 18-hole attempts compare fairly, same basis as the leaderboard).
    name: 'tournaments.creator_leagues',
    sql: `
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_creator_league BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS accent_color   TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS tagline        TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS target_to_par  REAL;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS target_label   TEXT;
      -- Browse surface filters on (is_creator_league, is_open, status).
      CREATE INDEX IF NOT EXISTS tournaments_creator_browse_idx
        ON tournaments(is_creator_league, status) WHERE is_creator_league = TRUE;
    `,
  },
  {
    // Approved-creator group. users.is_creator gates who can HOST a creator
    // league (POST /tournaments with isCreatorLeague). Managed from the DB the
    // same way as the owner group:
    //   UPDATE users SET is_creator = true  WHERE LOWER(username) = 'someone';
    //   UPDATE users SET is_creator = false WHERE LOWER(username) = 'someone';
    // Owners are implicitly creators (the gate is is_owner OR is_creator); this
    // also flags any existing owner so a direct is_creator read is true too.
    name: 'users.is_creator',
    // DDL ONLY, as a single statement so it commits on its own. This MUST NOT be
    // batched with the owner-backfill UPDATE below: node-postgres runs a
    // multi-statement string in ONE implicit transaction, so if the UPDATE ever
    // errored it would roll the ADD COLUMN back with it — leaving the column
    // absent while GET /users/me (which selects is_creator) 500s every user out
    // of the app's user-gated tabs (home/profile/finds). Keep DDL + backfill apart.
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN NOT NULL DEFAULT FALSE;`,
  },
  {
    // Backfill owners as creators, in its OWN migration so a failure here can
    // never undo the column add above. Idempotent + re-run every boot.
    name: 'users.is_creator_backfill_owners',
    sql: `UPDATE users SET is_creator = TRUE WHERE is_owner = TRUE AND is_creator = FALSE;`,
  },
  {
    // Creator-league social + seasons:
    //   - messages.tournament_id  → reuse the generic chat for a per-league channel
    //   - league_posts            → a dedicated league feed (member text + system events)
    //   - tournament_players.auto_post → member opt-in to auto-submit their solo rounds
    //   - tournaments.reset_period / season_started_at / last_champion_* →
    //     a recurring season that auto-crowns a winner + resets on a cadence.
    name: 'creator_leagues.social_seasons',
    sql: `
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(tournament_id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS messages_tournament_created_idx
        ON messages(tournament_id, created_at) WHERE tournament_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS league_posts (
        post_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        league_id  UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
        user_id    UUID REFERENCES users(user_id) ON DELETE SET NULL,  -- null = pure system event
        kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'event')),
        body       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS league_posts_feed_idx ON league_posts(league_id, created_at DESC);

      ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS auto_post BOOLEAN NOT NULL DEFAULT FALSE;

      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS reset_period      TEXT NOT NULL DEFAULT 'none'; -- none | weekly | monthly
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS season_started_at TIMESTAMPTZ;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS last_champion_id  UUID REFERENCES users(user_id) ON DELETE SET NULL;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS last_champion_at  TIMESTAMPTZ;
      -- Existing creator leagues start their first season at creation time.
      UPDATE tournaments SET season_started_at = created_at
        WHERE is_creator_league = TRUE AND season_started_at IS NULL;
    `,
  },
  {
    // Private "buddies leagues" — a peer-hosted league flavor of tournaments
    // that ANY user can create (no approved-creator gate), invite-only, and
    // scored NET (handicap-adjusted) so a 20-handicap and a scratch golfer
    // compete fairly in the same group.
    //   - league_type: 'none' (plain tournament) | 'creator' | 'buddies'.
    //     Backfilled to 'creator' for existing creator leagues so the season /
    //     social plumbing can key off league_type <> 'none' uniformly instead
    //     of is_creator_league (which stays TRUE only for public creator ones).
    //   - handicap_adjusted: the leaderboard subtracts each player's
    //     users.handicap_index from their normalized (18-eq) to-par.
    name: 'buddies_leagues',
    sql: `
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS league_type       TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS handicap_adjusted  BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE tournaments SET league_type = 'creator' WHERE is_creator_league = TRUE AND league_type = 'none';
      CREATE INDEX IF NOT EXISTS tournaments_league_type_idx
        ON tournaments(league_type, status) WHERE league_type <> 'none';
    `,
  },
  {
    // Comment replies (one level) + image attachments, on both comment
    // surfaces. parent_comment_id points at a TOP-LEVEL comment; the routes
    // normalize a reply-to-a-reply back to its top-level ancestor so threads
    // never nest deeper than one level. image_url is a /uploads/comments/ path.
    // Pure DDL (ADD COLUMN IF NOT EXISTS) so it's a safe, re-runnable no-op.
    name: 'comments.replies_and_images',
    sql: `
      ALTER TABLE post_comments
        ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES post_comments(comment_id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE round_comments
        ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES round_comments(comment_id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS image_url TEXT;
      CREATE INDEX IF NOT EXISTS post_comments_parent_idx
        ON post_comments(parent_comment_id) WHERE parent_comment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS round_comments_parent_idx
        ON round_comments(parent_comment_id) WHERE parent_comment_id IS NOT NULL;
    `,
  },
  {
    // Likes on posts and on both comment surfaces. Each is a (target, user)
    // join table with a cascade so likes vanish with their target. A like count
    // is COUNT(*) over the PK prefix, so no extra index is needed. Pure DDL —
    // safe, re-runnable no-op.
    name: 'likes.posts_and_comments',
    sql: `
      CREATE TABLE IF NOT EXISTS post_likes (
        post_id    UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (post_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS post_comment_likes (
        comment_id UUID NOT NULL REFERENCES post_comments(comment_id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (comment_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS round_comment_likes (
        comment_id UUID NOT NULL REFERENCES round_comments(comment_id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (comment_id, user_id)
      );
    `,
  },
  {
    // Practice sessions for "The Grind" — range + putting reps logged from the
    // session screens. Lifetime shot totals (summed here) drive the profile
    // stat. Pure DDL, safe re-runnable no-op.
    name: 'practice_sessions.create',
    sql: `
      CREATE TABLE IF NOT EXISTS practice_sessions (
        session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,            -- 'range' | 'putting'
        shots       INTEGER NOT NULL DEFAULT 0,
        duration_s  INTEGER NOT NULL DEFAULT 0,
        bpm         INTEGER,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS practice_sessions_user_idx
        ON practice_sessions(user_id, created_at DESC);
    `,
  },
  {
    // Mark a served find matchup as voted, so /finds/vote can require the pair
    // was actually shown to this user (anti ballot-stuffing) AND can't be voted
    // on twice. NULL = served-but-not-yet-voted. Pure DDL, safe re-runnable.
    name: 'find_pair_seen.voted_at',
    sql: `
      ALTER TABLE find_pair_seen
        ADD COLUMN IF NOT EXISTS voted_at TIMESTAMPTZ;
    `,
  },
  {
    // Client crash telemetry. The app self-reports four failure kinds:
    //   js_fatal            — uncaught JS exception (ErrorUtils global handler)
    //   js_boundary         — render error caught by AppErrorBoundary
    //   unhandled_rejection — a promise rejection nobody caught
    //   abnormal_exit       — the PREVIOUS session ended while FOREGROUNDED with
    //                         no clean shutdown = native crash / OOM / watchdog
    //                         kill (detected on next launch from a persisted
    //                         session marker; carries the last route, the
    //                         breadcrumb trail, and how many iOS memory warnings
    //                         preceded death — high mem_warns == leak/OOM, which
    //                         is exactly the "crashes while just moving around"
    //                         signature).
    // user_id is NULLABLE: a crash can happen pre-login and an anonymous report
    // is still useful. Rows are tiny; prune from the admin whenever.
    name: 'crash_reports.create',
    sql: `
      CREATE TABLE IF NOT EXISTS crash_reports (
        crash_id    BIGSERIAL PRIMARY KEY,
        user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
        kind        TEXT NOT NULL,
        message     TEXT,
        stack       TEXT,
        last_route  TEXT,
        breadcrumbs JSONB,
        mem_warns   INT,
        app_version TEXT,
        update_id   TEXT,
        platform    TEXT,
        os_version  TEXT,
        extra       JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS crash_reports_created_idx ON crash_reports(created_at DESC);
    `,
  },
  {
    // Premium-on-the-house is OVER (2026-07-10). Grandfather EVERY user who was
    // already signed up at the cutover to LIFETIME premium, so ending the open
    // beta doesn't yank premium from the people who were here for it. Runs once
    // (idempotent by name); anyone who signs up AFTER this migration starts as
    // non-premium and can buy in. Bots are skipped. premium_until = NULL means
    // lifetime; premium_plan 'open_beta' drives the "premium is on the house"
    // banner + hides the paywall for these grandfathered accounts.
    name: 'users.grandfather_beta_lifetime',
    sql: `
      UPDATE users
         SET is_premium    = TRUE,
             premium_since = COALESCE(premium_since, NOW()),
             premium_until = NULL,
             premium_plan  = COALESCE(premium_plan, 'open_beta')
       WHERE COALESCE(is_bot, false) = false;
    `,
  },
];

export async function runMigrations() {
  // Ledger table first, outside the loop, so even a first-boot migration
  // failure is visible remotely via GET /admin/migration-status instead
  // of only in deploy logs. Each migration upserts its latest outcome —
  // these are idempotent and re-run every boot, so the ledger reflects
  // the MOST RECENT run, which is what "is prod healthy" actually means.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        ok          BOOLEAN NOT NULL,
        error       TEXT,
        last_ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  } catch (err) {
    console.error('Migration ledger create failed:', err);
  }

  for (const m of MIGRATIONS) {
    let ok = true;
    let errText: string | null = null;
    try {
      await pool.query(m.sql);
      // Quiet on success — startup logs stay tidy.
    } catch (err) {
      ok = false;
      errText = err instanceof Error ? err.message : String(err);
      console.error(`Migration "${m.name}" failed:`, err);
      // Don't crash on migration failure — let the server start anyway so
      // other endpoints keep working. The failed feature simply won't function.
    }
    try {
      await pool.query(
        `INSERT INTO schema_migrations (name, ok, error, last_ran_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (name)
         DO UPDATE SET ok = $2, error = $3, last_ran_at = NOW()`,
        [m.name, ok, errText],
      );
    } catch { /* ledger write is best-effort */ }
  }
}
