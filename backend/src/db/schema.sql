-- Sacari Golf Database Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  elo INTEGER NOT NULL DEFAULT 1200,
  total_matches INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_ties INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  push_token TEXT,
  handicap_index REAL,
  bio TEXT,
  home_course_id UUID REFERENCES courses(course_id) ON DELETE SET NULL,
  notifications_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Forgot-password support: stores SHA-256 hash of a 6-digit code (so leaking
  -- the table doesn't reveal active codes) plus its expiry. Cleared on use.
  reset_code_hash TEXT,
  reset_code_expires_at TIMESTAMPTZ,
  -- Email verification: same pattern. email_verified flips true on first
  -- successful POST /auth/verify-email; the code/expiry get cleared then.
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verify_code_hash TEXT,
  email_verify_expires_at TIMESTAMPTZ
);

-- Friends
CREATE TABLE friends (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

-- Clans
CREATE TABLE clans (
  clan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name TEXT NOT NULL,
  clan_mode TEXT NOT NULL DEFAULT 'duo', -- duo | squad
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  elo INTEGER NOT NULL DEFAULT 1200,
  total_matches INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE clan_members (
  clan_id UUID NOT NULL REFERENCES clans(clan_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- leader | member
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clan_id, user_id)
);

-- Courses
CREATE TABLE courses (
  course_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_name TEXT NOT NULL,
  club_name TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
);

CREATE INDEX idx_courses_name ON courses USING gin(to_tsvector('english', course_name || ' ' || COALESCE(club_name, '') || ' ' || COALESCE(city, '') || ' ' || COALESCE(state, '')));
CREATE INDEX idx_courses_city ON courses(city);
CREATE INDEX idx_courses_state ON courses(state);

-- Teeboxes
CREATE TABLE teeboxes (
  teebox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'male', -- male | female
  course_rating REAL,
  slope_rating INTEGER,
  total_yards INTEGER,
  num_holes INTEGER NOT NULL DEFAULT 18,
  par INTEGER NOT NULL DEFAULT 72,
  front_course_rating REAL,
  front_slope_rating INTEGER,
  back_course_rating REAL,
  back_slope_rating INTEGER
);

-- Holes
CREATE TABLE holes (
  hole_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teebox_id UUID NOT NULL REFERENCES teeboxes(teebox_id) ON DELETE CASCADE,
  hole_num SMALLINT NOT NULL,
  par SMALLINT NOT NULL,
  yardage INTEGER,
  handicap SMALLINT,
  pin_lat REAL,             -- center of green (community-contributed)
  pin_lng REAL,
  pin_elevation_m REAL,     -- device-reported altitude when first pin was set
  pin_set_at TIMESTAMPTZ,
  pin_set_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  UNIQUE (teebox_id, hole_num)
);

-- Matches
CREATE TABLE matches (
  match_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_type TEXT NOT NULL DEFAULT 'solo', -- solo | duo | squad | practice
  format TEXT NOT NULL DEFAULT 'stroke', -- stroke | scramble
  num_holes SMALLINT NOT NULL DEFAULT 18,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  is_practice BOOLEAN NOT NULL DEFAULT FALSE,
  started_notified BOOLEAN NOT NULL DEFAULT FALSE,
  -- When a solo match gets absorbed into another via the auto-match pool, the
  -- original "waiting" match points at the new match here. GET /matches filters
  -- these out so the player only sees one row per real match.
  superseded_by_match_id UUID REFERENCES matches(match_id) ON DELETE SET NULL
);

-- Match Players (each user/clan slot in a match)
CREATE TABLE match_players (
  match_id UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  clan_id UUID REFERENCES clans(clan_id),
  teebox_id UUID REFERENCES teeboxes(teebox_id),
  side SMALLINT NOT NULL DEFAULT 1, -- 1 or 2
  strokes INTEGER,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, user_id)
);

-- Rounds (hole-by-hole scores)
CREATE TABLE rounds (
  round_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID REFERENCES matches(match_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(course_id),
  teebox_id UUID REFERENCES teeboxes(teebox_id),
  hole_scores SMALLINT[] NOT NULL DEFAULT '{}',
  total_score INTEGER,
  round_type TEXT NOT NULL DEFAULT 'solo'
);

-- Add unique constraint for upsert
ALTER TABLE rounds ADD CONSTRAINT rounds_match_user_unique UNIQUE (match_id, user_id);

-- Match Results (ELO changes)
CREATE TABLE match_results (
  match_id UUID PRIMARY KEY REFERENCES matches(match_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_type TEXT NOT NULL,
  winner_side SMALLINT,
  side1_score_differential REAL,
  side2_score_differential REAL,
  delta_elo INTEGER NOT NULL DEFAULT 0,
  details JSONB
);


-- Find Ranker
CREATE TABLE IF NOT EXISTS finds (
  find_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  description TEXT,
  elo INTEGER NOT NULL DEFAULT 1200,
  total_votes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finds_user_idx ON finds(user_id);

-- Chat messages (match or clan)
CREATE TABLE IF NOT EXISTS messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID REFERENCES matches(match_id) ON DELETE CASCADE,
  clan_id UUID REFERENCES clans(clan_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  CHECK ((match_id IS NULL) != (clan_id IS NULL))
);
CREATE INDEX IF NOT EXISTS messages_match_idx ON messages(match_id, created_at);
CREATE INDEX IF NOT EXISTS messages_clan_idx ON messages(clan_id, created_at);

-- Match invites
CREATE TABLE IF NOT EXISTS match_invites (
  invite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  UNIQUE (match_id, to_user_id)
);

-- Pin contributions — track when a user contributed pin data while playing
-- so we can reward them with a perk if they did so on the majority of holes.
CREATE TABLE IF NOT EXISTS pin_contributions (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  hole_id UUID NOT NULL REFERENCES holes(hole_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, match_id, hole_id)
);
CREATE INDEX IF NOT EXISTS pin_contrib_user_match_idx ON pin_contributions(user_id, match_id);

-- User perks — earned by contributing pin data, auto-consumed on next ranked match.
-- 'lucky_round' protects from a loss AND doubles a win (whichever applies).
CREATE TABLE IF NOT EXISTS user_perks (
  perk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  perk_type TEXT NOT NULL DEFAULT 'lucky_round',
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  earned_match_id UUID REFERENCES matches(match_id) ON DELETE SET NULL,
  consumed_at TIMESTAMPTZ,
  consumed_match_id UUID REFERENCES matches(match_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS user_perks_unused_idx ON user_perks(user_id) WHERE consumed_at IS NULL;

-- Shot tracks — per (match, user, hole) — array of {lat, lng} GPS points
CREATE TABLE IF NOT EXISTS shot_tracks (
  match_id UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  hole_num SMALLINT NOT NULL,
  shots JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, user_id, hole_num)
);
CREATE INDEX IF NOT EXISTS shot_tracks_match_user_idx ON shot_tracks(match_id, user_id);

-- Round reactions — text-only (no emoji glyphs in storage). Limited set of types.
CREATE TABLE IF NOT EXISTS round_reactions (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES rounds(round_id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, round_id, reaction)
);
CREATE INDEX IF NOT EXISTS round_reactions_round_idx ON round_reactions(round_id);

-- Round comments — short text per user, on a completed round
CREATE TABLE IF NOT EXISTS round_comments (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES rounds(round_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS round_comments_round_idx ON round_comments(round_id, created_at);

-- Find reports (moderation)
CREATE TABLE IF NOT EXISTS find_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  find_id UUID NOT NULL REFERENCES finds(find_id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'inappropriate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (find_id, reporter_id)
);
