import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MatchFoundIntro, SidePlayer } from './MatchFoundIntro';

/**
 * Global "match found" detector. Polls /matches periodically (and on app
 * foreground transitions) while a user is logged in. When it sees any
 * non-completed match where the player now has an opponent (`has_opponent`
 * flipped to true) AND it hasn't been shown to them yet, fetches the full
 * match detail and triggers the VS intro animation.
 *
 * Lives at the root layout so it overlays whatever screen the player
 * happens to be on — the scoring screen mid-round, the social tab, anywhere.
 *
 * "Seen" state is per-match per-device, persisted in AsyncStorage so a
 * single match never plays the intro twice. If the app is closed during the
 * matchmaking moment, the next launch hits this poller's foreground tick
 * and fires the intro then.
 */
const POLL_INTERVAL_MS = 30 * 1000;
const SEEN_KEY = (matchId: string) => `match_intro_seen_${matchId}`;

export function MatchFoundWatcher() {
  const { user, token } = useAuth();
  const [intro, setIntro] = useState<{
    matchId: string;
    meSide: 1 | 2;
    side1: SidePlayer[];
    side2: SidePlayer[];
  } | null>(null);

  // Track which matches we've already triggered for in THIS session (in
  // addition to the persistent AsyncStorage record). Prevents a race where
  // two consecutive poll ticks both fetch details before AsyncStorage is
  // written.
  const triggeredThisSession = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user || !token) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const matches = await api.matches.list();
        if (cancelled) return;
        // Find newly-paired non-completed matches we haven't shown yet.
        for (const m of matches as any[]) {
          if (m.completed) continue;
          if (!m.has_opponent) continue;
          if (triggeredThisSession.current.has(m.match_id)) continue;
          const seen = await AsyncStorage.getItem(SEEN_KEY(m.match_id));
          if (seen) {
            triggeredThisSession.current.add(m.match_id);
            continue;
          }
          // Mark as triggered NOW so a slow detail fetch doesn't allow a
          // second tick to also pick this match up. Also persist the flag
          // BEFORE we render the animation — that way, if the app crashes
          // or backgrounds mid-animation, the next launch won't replay it.
          triggeredThisSession.current.add(m.match_id);
          await AsyncStorage.setItem(SEEN_KEY(m.match_id), '1').catch(() => { });
          // Fetch the full match so we have player avatars / clan info.
          const detail = await api.matches.get(m.match_id);
          if (cancelled) return;
          const players = (detail.players ?? []) as any[];
          const me = players.find((p) => p.user_id === user.user_id);
          if (!me) continue;
          const meSide: 1 | 2 = me.side === 2 ? 2 : 1;
          const side1 = players.filter((p) => p.side === 1) as SidePlayer[];
          const side2 = players.filter((p) => p.side === 2) as SidePlayer[];
          if (side1.length === 0 || side2.length === 0) continue;
          setIntro({ matchId: m.match_id, meSide, side1, side2 });
          // Only show one intro at a time — bail out of the loop.
          break;
        }
      } catch { /* network blips — try again next tick */ }
    };

    // Run immediately on mount, then on a regular interval.
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);

    // Also re-check when the app foregrounds (catches the "match happened
    // while my phone was locked" case).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
  }, [user?.user_id, token]);

  const dismiss = () => {
    // Seen flag is already persisted at trigger time (above). Just close the
    // overlay — the next poll will skip this match because both the
    // in-session set and AsyncStorage are populated.
    setIntro(null);
  };

  if (!intro) return null;
  return (
    <MatchFoundIntro
      visible={true}
      meSide={intro.meSide}
      side1Players={intro.side1}
      side2Players={intro.side2}
      onDismiss={dismiss}
    />
  );
}
