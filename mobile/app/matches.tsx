/**
 * Match / round history screen.
 *
 * Shows the player's matches in three sections:
 *   1. ACTIVE / IN-PROGRESS — matches that have a scoring session started
 *      but haven't been completed yet. One tap resumes scoring.
 *   2. RECENT COMPLETED — finished matches newest-first, with result
 *      badge (WIN / LOSS / TIE) and ELO delta.
 *   3. PRACTICE — rounds tagged is_practice = true. Separated because they
 *      don't affect ELO; the player may want to see them but not have
 *      them dominate the list.
 *
 * Uses the existing `GET /matches` endpoint (api.matches.list) which
 * already returns the last 50 matches with my_side / my_delta_elo /
 * winner_side decorated server-side.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useCensor } from '../lib/censor';
import { C, F } from '../lib/colors';

/** Local cache of the My Matches list so the screen populates with no signal. */
const MATCHES_CACHE_KEY = 'coc_matches_cache';

// Server returns Match objects without a course_name on the top-level row;
// it's nested in players[]. We don't have players[] in /matches list, so
// we just show match_type + date + result. That's enough for an "is this
// the round I'm thinking of?" recall surface.
interface ListedMatch {
  match_id: string;
  match_type: string;
  name: string | null;
  completed: boolean;
  cancelled: boolean;
  is_practice: boolean;
  created_at: string;
  my_side: number | null;
  my_strokes: number | null;
  winner_side: number | null;
  delta_elo: number | null;
  my_delta_elo: number | null;
  has_opponent?: boolean;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now.getTime() - 86400 * 1000);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function matchTypeLabel(type: string): string {
  switch (type) {
    case 'solo':     return '1v1';
    case 'duo':      return '2v2';
    case 'squad':    return '4v4';
    case 'ffa':      return 'Arena';
    case 'practice': return 'Practice';
    default:         return type.toUpperCase();
  }
}

function resultBadge(m: ListedMatch): { label: string; color: string } | null {
  // `played` = the user has submitted their own round in this match
  // (my_strokes is set). Used to distinguish "I finished my round but
  // there's no opponent yet" from "still mid-round."
  const played = m.my_strokes != null;
  // Order matters: an ACTIVE round reads "IN PROGRESS" regardless of type
  // (so an in-progress practice round in the IN PROGRESS section is
  // labeled correctly). Only a COMPLETED practice round gets the
  // "PRACTICE" badge.
  if (m.cancelled) {
    // A cancelled match the user actually PLAYED reads "NO OPPONENT" —
    // their round was real, it just never got matched. A cancelled match
    // they never played is a plain "CANCELLED".
    return played
      ? { label: 'NO OPPONENT', color: C.textMuted }
      : { label: 'CANCELLED', color: C.textDim };
  }
  if (!m.completed) {
    // Finished your round but waiting on an opponent → "AWAITING
    // OPPONENT"; still mid-round → "IN PROGRESS".
    if (played && m.has_opponent === false) {
      return { label: 'AWAITING OPPONENT', color: C.blue };
    }
    return { label: 'IN PROGRESS', color: C.gold };
  }
  if (m.is_practice) return { label: 'PRACTICE', color: C.textMuted };
  // Completed, ranked
  if (m.winner_side == null && m.my_side != null) {
    return { label: 'TIE', color: C.blue };
  }
  if (m.winner_side != null && m.my_side != null) {
    const won = m.winner_side === m.my_side;
    return won
      ? { label: 'WIN',  color: C.green }
      : { label: 'LOSS', color: C.red };
  }
  return null;
}

export default function MatchesHistoryScreen() {
  const { user } = useAuth();
  const [matches, setMatches] = useState<ListedMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.matches.list();
      setMatches(data as ListedMatch[]);
      // Cache the list so My Matches loads with no signal. Each match's own
      // scoring screen additionally caches its full snapshot on first open
      // (match_cache_<id>), so a current round can be resumed offline.
      AsyncStorage.setItem(MATCHES_CACHE_KEY, JSON.stringify(data)).catch(() => { });
    } catch {
      // Offline / fetch failed → fall back to the last cached list so the
      // player can still see and open their current matches without service.
      try {
        const raw = await AsyncStorage.getItem(MATCHES_CACHE_KEY);
        if (raw) setMatches(JSON.parse(raw) as ListedMatch[]);
      } catch { /* nothing cached yet */ }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { if (user) load(); }, [user, load]);

  // Three bucketed groups for cleaner UX than one giant list. A "section
  // header" separator pattern would be more idiomatic but we're rendering
  // only 3 sections so inline headers in a flat FlatList is simpler.
  //
  // IN PROGRESS = every ACTIVE round, ranked OR practice. The previous
  // version excluded practice here, so an in-progress practice round was
  // buried in the PRACTICE bucket alongside finished ones and didn't read
  // as a "current round." Now any round that isn't completed or cancelled
  // shows up top as resumable — which is the whole point of this screen.
  const inProgress = matches.filter((m) => !m.completed && !m.cancelled);
  // RECENT = finished, ranked rounds.
  const completed  = matches.filter((m) =>  m.completed && !m.cancelled && !m.is_practice);
  // PRACTICE = finished practice rounds only (active practice is in IN PROGRESS above).
  const practice   = matches.filter((m) =>  m.completed && !m.cancelled && m.is_practice);
  // NO OPPONENT = matches the user PLAYED (my_strokes set) that got cancelled
  // — almost always a duo/squad that finished its round but never got
  // matched and aged out under the old cleanup. Surfaced so the round
  // isn't silently lost. (Going forward the cleanup no longer cancels
  // played matches, but this recovers any already in that state.)
  const noOpponent = matches.filter((m) => m.cancelled && m.my_strokes != null);

  const rows: ({ kind: 'header'; label: string; key: string } | { kind: 'row'; match: ListedMatch; key: string })[] = [];
  if (inProgress.length) {
    rows.push({ kind: 'header', label: `IN PROGRESS (${inProgress.length})`, key: 'h-active' });
    for (const m of inProgress) rows.push({ kind: 'row', match: m, key: m.match_id });
  }
  if (noOpponent.length) {
    rows.push({ kind: 'header', label: `NO OPPONENT (${noOpponent.length})`, key: 'h-noopp' });
    for (const m of noOpponent) rows.push({ kind: 'row', match: m, key: m.match_id });
  }
  if (completed.length) {
    rows.push({ kind: 'header', label: `RECENT (${completed.length})`, key: 'h-recent' });
    for (const m of completed) rows.push({ kind: 'row', match: m, key: m.match_id });
  }
  if (practice.length) {
    rows.push({ kind: 'header', label: `PRACTICE (${practice.length})`, key: 'h-prac' });
    for (const m of practice) rows.push({ kind: 'row', match: m, key: m.match_id });
  }

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'My Matches',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      {loading ? (
        <View style={s.centered}>
          <ActivityIndicator color={C.gold} />
        </View>
      ) : matches.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyTitle}>No matches yet</Text>
          <Text style={s.emptySub}>
            Start one from the Play tab or accept a friend's invite.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={C.gold}
            />
          }
          renderItem={({ item }) => {
            if (item.kind === 'header') {
              return <Text style={s.sectionHeader}>{item.label}</Text>;
            }
            return <MatchRow match={item.match} />;
          }}
        />
      )}
    </View>
  );
}

function MatchRow({ match: m }: { match: ListedMatch }) {
  const badge = resultBadge(m);
  const isResumable = !m.completed && !m.cancelled;
  const c = useCensor();

  const onPress = () => {
    if (isResumable) {
      // Resume → scoring screen for in-progress matches
      router.push(`/match/${m.match_id}` as any);
    } else {
      // Otherwise → match detail (which renders the final scorecard)
      router.push(`/match/${m.match_id}` as any);
    }
  };

  return (
    <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.7}>
      <View style={{ flex: 1 }}>
        <View style={s.rowTopLine}>
          <Text style={s.rowType}>{matchTypeLabel(m.match_type)}</Text>
          {m.name && <Text style={s.rowName} numberOfLines={1}>{c(m.name)}</Text>}
        </View>
        <Text style={s.rowDate}>{fmtDate(m.created_at)}</Text>
      </View>

      {/* Result / ELO column */}
      <View style={s.rowResult}>
        {badge && (
          <View style={[s.badge, { borderColor: badge.color }]}>
            <Text style={[s.badgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
        )}
        {/* ELO delta — only show for completed, non-practice matches.
            Tinted by sign so a glance reads as W/L. */}
        {m.completed && !m.is_practice && m.my_delta_elo != null && (
          <Text style={[
            s.elo,
            { color: m.my_delta_elo > 0 ? C.green : m.my_delta_elo < 0 ? C.red : C.textMuted },
          ]}>
            {m.my_delta_elo > 0 ? '+' : ''}{m.my_delta_elo} ELO
          </Text>
        )}
      </View>

      <Text style={s.chev}>›</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  emptyTitle: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },
  emptySub: { color: C.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 },

  sectionHeader: {
    color: C.gold,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: C.border,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border + '99',
    gap: 12,
  },
  rowTopLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowType: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 0.6 },
  rowName: { color: C.text, fontSize: 13, flex: 1 },
  rowDate: { color: C.textMuted, fontSize: 11, marginTop: 4 },

  rowResult: { alignItems: 'flex-end', gap: 4 },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 3,
    borderWidth: 1,
  },
  badgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  elo: { fontSize: 11, fontWeight: '800' },

  chev: { color: C.textDim, fontSize: 22 },
});
