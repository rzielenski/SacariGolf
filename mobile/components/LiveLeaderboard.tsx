/**
 * Live ranked standings for a match — the tournament-style board that replaces
 * "scroll everyone's scorecard." Self-contained: it fetches /matches/:id/
 * leaderboard and, while the match is still live, re-polls every few seconds so
 * positions move on their own. Renders nothing until the board is `active`
 * (both sides opted into live scores) or the match is final, so it's never a
 * scouting vector. Reused by the lobby now and the spectator/tournament views
 * later.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { api } from '../lib/api';
import { C } from '../lib/colors';
import { useCensor } from '../lib/censor';
import { IdentityAvatar, IdentityName } from './UserIdentity';

interface Row {
  user_id: string; username: string; side: number;
  thru: number; total: number; toPar: number; points: number | null;
  completed: boolean; position: number;
  meta?: { avatar_url?: string | null; elo?: number; is_bot?: boolean; equipped_visual?: any };
}

const POLL_MS = 12000;

export function LiveLeaderboard({ matchId, completed, onPressPlayer }: {
  matchId: string;
  completed?: boolean;
  onPressPlayer?: (userId: string) => void;
}) {
  const c = useCensor();
  // Only poll while the screen this board lives on is actually FOCUSED. The
  // lobby stays mounted underneath the scoring screen for the entire round,
  // so an ungated poll ran every 12s for hours from a covered screen (and
  // forever from any screen left stranded in the stack).
  const focused = useIsFocused();
  const [rows, setRows] = useState<Row[]>([]);
  const [format, setFormat] = useState('stroke');
  const [active, setActive] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!focused) return;   // re-runs (and refetches) the moment focus returns
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await api.matches.leaderboard(matchId);
        if (cancelled) return;
        setActive(res.active || res.completed);
        setFormat(res.format ?? 'stroke');
        setRows(res.leaderboard ?? []);
      } catch { /* keep the last good board */ }
      finally { if (!cancelled) setLoaded(true); }
      // Keep refreshing only while the round is still in progress.
      if (!cancelled && !completed) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [matchId, completed, focused]);

  if (!loaded) return <ActivityIndicator color={C.gold} style={{ marginVertical: 14 }} />;
  if (!active || rows.length === 0) return null;

  const isStableford = format === 'stableford';
  const toParText = (n: number) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

  return (
    <View style={s.wrap}>
      {rows.map((r) => {
        const started = r.thru > 0;
        const scoreText = isStableford
          ? `${r.points ?? 0}`
          : started ? toParText(r.toPar) : '—';
        const scoreColor = isStableford
          ? C.text
          : !started ? C.textDim : r.toPar < 0 ? C.green : r.toPar > 0 ? C.red : C.text;
        return (
          <TouchableOpacity
            key={r.user_id}
            style={s.row}
            activeOpacity={onPressPlayer ? 0.7 : 1}
            onPress={() => onPressPlayer?.(r.user_id)}
          >
            <Text style={s.pos}>{started ? r.position : '—'}</Text>
            <IdentityAvatar
              visual={r.meta?.equipped_visual}
              username={r.username}
              avatarUrl={r.meta?.avatar_url ?? null}
              size={26}
            />
            <View style={s.nameWrap}>
              <IdentityName visual={r.meta?.equipped_visual} style={s.name}>
                {c(r.username)}
              </IdentityName>
            </View>
            <Text style={s.thru}>{r.completed ? 'F' : started ? `${r.thru}` : '—'}</Text>
            <Text style={[s.score, { color: scoreColor }]}>{scoreText}</Text>
          </TouchableOpacity>
        );
      })}
      <View style={s.legend}>
        <Text style={s.legendText}>{isStableford ? 'PTS' : 'TO PAR'}  ·  THRU  ·  tap a player for their card</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: C.card, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 4,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 8,
  },
  pos: { width: 22, textAlign: 'center', color: C.textMuted, fontWeight: '800', fontSize: 13 },
  nameWrap: { flex: 1, minWidth: 0 },
  name: { color: C.text, fontWeight: '700', fontSize: 14 },
  thru: { width: 34, textAlign: 'right', color: C.textMuted, fontSize: 12 },
  score: { width: 46, textAlign: 'right', fontWeight: '900', fontSize: 15 },
  legend: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 4 },
  legendText: { color: C.textDim, fontSize: 9, letterSpacing: 0.5, fontWeight: '700' },
});
