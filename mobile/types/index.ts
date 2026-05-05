export interface User {
  user_id: string;
  username: string;
  email: string;
  elo: number;
  total_matches: number;
  total_wins: number;
  avatar_url: string | null;
  created_at: string;
  handicap_index: number | null;
}

export interface ChatMessage {
  message_id: string;
  created_at: string;
  body: string;
  user_id: string;
  username: string;
}

export interface MatchInvite {
  invite_id: string;
  match_id: string;
  created_at: string;
  from_username: string;
  from_elo: number;
  match_type: string;
  match_name: string | null;
}

export interface Course {
  course_id: string;
  course_name: string;
  club_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  teeboxes?: Teebox[];
}

export interface Teebox {
  teebox_id: string;
  name: string;
  gender: string;
  course_rating: number;
  slope_rating: number;
  total_yards: number;
  num_holes: number;
  par: number;
  holes: Hole[];
}

export interface Hole {
  hole_id: string;
  hole_num: number;
  par: number;
  yardage: number | null;
  handicap: number | null;
}

export interface Match {
  match_id: string;
  match_type: 'solo' | 'duo' | 'squad' | 'practice';
  format: 'stroke' | 'scramble';
  num_holes: number;
  name: string | null;
  completed: boolean;
  is_practice: boolean;
  created_at: string;
  players?: MatchPlayer[];
  result?: MatchResult | null;
  my_side?: number;
  my_strokes?: number;
  winner_side?: number;
  delta_elo?: number;
}

export interface MatchPlayer {
  user_id: string;
  username: string;
  elo: number;
  side: number;
  strokes: number | null;
  completed: boolean;
  teebox_name: string | null;
  course_rating: number | null;
  slope_rating: number | null;
  num_holes?: number;
  course_id?: string;
  hole_scores?: number[] | null;
}

export interface MatchResult {
  winner_side: number;
  delta_elo: number;
  side1_score_differential: number;
  side2_score_differential: number;
}

export interface ClanMember {
  user_id: string;
  username: string;
  elo: number;
  total_matches: number;
  total_wins: number;
  avatar_url: string | null;
  role: 'leader' | 'member';
  joined_at: string;
}

export interface Clan {
  clan_id: string;
  name: string;
  clan_mode: 'duo' | 'squad';
  elo: number;
  total_matches: number;
  total_wins: number;
  member_count: number;
  max_players: number;
  is_public: boolean;
  role?: string;
  members?: ClanMember[];
}
