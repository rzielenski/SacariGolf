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
