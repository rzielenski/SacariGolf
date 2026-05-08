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
