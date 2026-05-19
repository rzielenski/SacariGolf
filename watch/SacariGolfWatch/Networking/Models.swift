//
//  Models.swift
//  SacariGolfWatch
//
//  Codable structs mirroring the backend's JSON shapes. Field names match
//  the wire format exactly (snake_case where Postgres uses it) so we
//  don't need keyDecodingStrategy. Optional types match the backend's
//  nullable columns.
//

import Foundation

// ─── Auth ──────────────────────────────────────────────────────────────

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct LoginResponse: Codable {
    let token: String
    let user: User
}

struct User: Codable, Identifiable {
    let user_id: String
    let username: String
    let email: String
    let elo: Int
    let total_matches: Int
    let total_wins: Int
    let total_ties: Int?
    let avatar_url: String?
    let is_premium: Bool?
    let handicap_index: Double?
    let home_course_id: String?
    let home_course_name: String?
    let home_course_lat: Double?
    let home_course_lng: Double?

    var id: String { user_id }
}

// ─── Matches ───────────────────────────────────────────────────────────

/// Summary row returned by GET /matches. Enough to render the match list
/// and decide which match to score, not enough to render the scorecard —
/// that needs the per-hole teebox data from GET /courses/:id.
struct MatchSummary: Codable, Identifiable {
    let match_id: String
    let match_type: String
    let name: String?
    let completed: Bool
    let cancelled: Bool
    let is_practice: Bool
    let created_at: String
    let my_side: Int?
    let my_strokes: Int?
    let has_opponent: Bool?

    var id: String { match_id }
}

/// Detail returned by GET /matches/:id. We use this to find the player's
/// teebox_id + course_id so the watch can hydrate the right hole data
/// (par / yardage / pin coords) for scoring.
struct MatchDetail: Codable {
    let match_id: String
    let match_type: String
    let completed: Bool
    let cancelled: Bool
    let is_practice: Bool
    let num_holes: Int?
    let players: [MatchPlayer]
}

struct MatchPlayer: Codable, Identifiable {
    let user_id: String
    let side: Int?
    let strokes: Int?
    let teebox_id: String?
    let course_id: String?
    let course_name: String?
    let teebox_name: String?
    let num_holes: Int?
    /// Hole scores already submitted (live-scoring state). When the watch
    /// resumes a partially-scored round we seed the +/- counters from this.
    let hole_scores: [Int]?

    var id: String { user_id }
}

/// Course detail with all teeboxes + holes. Used by ScoringView to know
/// par + yardage per hole + pin coordinates.
struct Course: Codable, Identifiable {
    let course_id: String
    let course_name: String
    let club_name: String?
    let city: String?
    let state: String?
    let latitude: Double?
    let longitude: Double?
    let teeboxes: [Teebox]?

    var id: String { course_id }
}

struct Teebox: Codable, Identifiable {
    let teebox_id: String
    let name: String
    let course_rating: Double?
    let slope_rating: Int?
    let total_yards: Int?
    let num_holes: Int
    let par: Int
    let holes: [Hole]?

    var id: String { teebox_id }
}

struct Hole: Codable, Identifiable {
    let hole_id: String
    let teebox_id: String
    let hole_num: Int
    let par: Int
    let yardage: Int
    let handicap: Int?
    let pin_lat: Double?
    let pin_lng: Double?
    let pin_elevation_m: Double?

    var id: String { hole_id }
}

/// Body for POST /matches/:id/scores. holeScores is the per-hole stroke
/// count in display order. holeStats is intentionally [String:Any] on the
/// backend; we leave it empty from the watch (the iOS app populates the
/// rich putts/chips/fairway-hit data).
struct SubmitScoresRequest: Codable {
    let holeScores: [Int]
    let holeStats: [String: String]  // empty dict, kept for shape
    let courseId: String?
    let teeboxId: String?
}

/// Body for PUT /matches/:id/shots/:holeNum. Segment format — each shot
/// has a start + end coord, optional club + lie + plays_like_yds + aim.
/// Mirrors the iOS Shot type so the data lands in the same Postgres
/// `shots` table.
struct ShotSegment: Codable {
    let start: Coord
    let end: Coord
    let club: String?
    let lie: String?
    let recorded_at: String?
    let plays_like_yds: Int?
    let total_yds: Int?
}

struct Coord: Codable {
    let lat: Double
    let lng: Double
    let elevation_m: Double?
}

struct SaveShotsRequest: Codable {
    let shots: [ShotSegment]
}

// ─── Weather (for plays-like) ─────────────────────────────────────────

struct Weather: Codable {
    let temperature_f: Double?
    let humidity_pct: Double?
    let wind_speed_mph: Double?
    /// Bearing the wind is coming FROM (meteorological convention),
    /// 0 = N, 90 = E.
    let wind_from_bearing: Double?
    let precipitation_in: Double?
    let rain: String?  // "none" | "light" | "heavy"
    let elevation_ft: Double?
}

// ─── Chat ──────────────────────────────────────────────────────────────

struct Conversation: Codable, Identifiable {
    let other_id: String
    let other_username: String
    let other_elo: Int?
    let other_avatar_url: String?
    let last_message: String?
    let last_at: String?
    let unread: Bool?

    var id: String { other_id }
}

struct DirectMessage: Codable, Identifiable {
    let message_id: String
    let created_at: String
    let body: String
    let user_id: String
    let username: String

    var id: String { message_id }
}

struct SendDMRequest: Codable {
    let body: String
}

// ─── Friends ───────────────────────────────────────────────────────────

struct Friend: Codable, Identifiable {
    let user_id: String
    let username: String
    let elo: Int
    let avatar_url: String?

    var id: String { user_id }
}
