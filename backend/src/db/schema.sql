-- Clash Of Clubs Database Schema

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
  avatar_url TEXT,
  push_token TEXT,
  handicap_index REAL
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
  UNIQUE (teebox_id, hole_num)
);

-- Matches
CREATE TABLE matches (
  match_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_type TEXT NOT NULL DEFAULT 'solo', -- solo | duo | squad | practice
  format TEXT NOT NULL DEFAULT 'stroke', -- stroke | match_play
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  is_practice BOOLEAN NOT NULL DEFAULT FALSE
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
  UNIQUE (match_id, to_user_id)
);

-- Find reports (moderation)
CREATE TABLE IF NOT EXISTS find_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  find_id UUID NOT NULL REFERENCES finds(find_id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'inappropriate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (find_id, reporter_id)
);
