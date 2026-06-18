import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MatchFoundIntro, SidePlayer } from './MatchFoundIntro';

/**
 * Global "match found" detector. Polls /matches periodically (and on app
 * foreground transitions) while a user is logged in. When it sees any
 * non-completed, non-cancelled match where:
 *
 *   • an opponent has been added (`has_opponent` is true), AND
 *   • the server has NOT yet recorded that the intro animation was shown
 *     to this user on this match (`intro_shown_at` is null)
 *
 * …it fetches the full match detail and triggers the VS reveal. Immediately
 * after triggering, it tells the server `mark-intro-shown` so the next poll
 * sees the flag and skips. This gives a true "once and only once" guarantee
 * across devices, reinstalls, and app launches — the source of truth lives
 * on the server, not in AsyncStorage.
 *
 * Lives at the root layout so the overlay floats above whatever screen the
 * player happens to be on.
 *
 * If the player is offline (or has the app closed) when their match pairs,
 * the next foreground tick picks up the still-unflagged match and fires
 * the intro then.
 */
const POLL_INTERVAL_MS = 30 * 1000;
/** Defensive cap: don't replay a stale intro for a match older than this.
 *  If the server's intro_shown_at flag somehow stayed null on an old match
 *  (e.g. a markIntroShown call lost to the network), we'd rather silently
 *  skip than play a "match found" animation for a match the player has
 *  already moved past. */
const MAX_INTRO_AGE_MS = 48 * 60 * 60 * 1000;
/** Local-backup key for matches we've already fired the intro on. Belt-and-
 *  suspenders against the server `mark-intro-shown` call failing silently. */
const SHOWN_KEY = 'coc_intro_shown_match_ids';

export function MatchFoundWatcher() {
  const { user, token } = useAuth();
  const [intro, setIntro] = useState<{
    matchId: string;
    matchType: string;
    meSide: 1 | 2;
    side1: SidePlayer[];
    side2: SidePlayer[];
  } | null>(null);

  // In-session dedup — guards against two consecutive poll ticks both
  // queuing the same animation while the server-side mark is in flight.
  // Server is the persistent source of truth; this is just a fast-path.
  const triggeredThisSession = useRef<Set<string>>(new Set());
  // Cross-session backup: server `intro_shown_at` is the source of truth, but
  // if markIntroShown ever fails to land (offline, 5xx) we'd otherwise replay
  // the intro on the next launch. Persisting locally as well makes the
  // "shown once" guarantee robust to API flakes. Hydrated on mount.
  const shownLocallyRef = useRef<Set<string>>(new Set());
  // Mirror of `intro` in a ref so the tick closure always sees the CURRENT
  // value, not whatever was captured at effect-mount time. Without this
  // mirror, dismissing a stale intro and waiting for a real one to fire
  // would silently fail because the closure-captured `intro` would still
  // look truthy.
  const showingRef = useRef(false);

  useEffect(() => {
    if (!user || !token) return;
    let cancelled = false;

    // Hydrate the local "already-shown" backup once per mount. This is a
    // best-effort cache — if AsyncStorage is empty (fresh install) we fall
    // back to the server's intro_shown_at flag, which is the real truth.
    AsyncStorage.getItem(SHOWN_KEY).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) shownLocallyRef.current = new Set(ids);
      } catch { /* corrupt cache → ignore, server flag will catch us up */ }
    });

    const persistShown = (matchId: string) => {
      shownLocallyRef.current.add(matchId);
      // Keep the on-disk list bounded — only the most recent 200 matter.
      const arr = Array.from(shownLocallyRef.current).slice(-200);
      AsyncStorage.setItem(SHOWN_KEY, JSON.stringify(arr)).catch(() => { });
    };

    const tick = async () => {
      if (cancelled || showingRef.current) return;   // one intro at a time
      try {
        const matches = await api.matches.list();
        if (cancelled) return;
        for (const m of matches as any[]) {
          if (m.completed) continue;
          if (m.cancelled) continue;
          // Practice rounds are inherently solo — they should never trigger
          // a VS intro. Filtered here as defense-in-depth in case a backend
          // edge case ever leaves a stale player row on the other side.
          if (m.is_practice) continue;
          // Arena (ffa) is an invite-only free-for-all, not a 1v1/team pairing.
          // Friends trickle into the lobby by invitation, so a side-2 player
          // appearing is normal lobby fill, not an "opponent found" moment.
          // Firing the team-style VS reveal here wrongly reads two arena rivals
          // as "you vs them" — and clanmates in the same arena get the same
          // banner on both sides, so it looks like "duo vs duo". No VS intro for
          // Arena; the host just fills the lobby and starts.
          if (m.match_type === 'ffa') continue;
          if (!m.has_opponent) continue;
          // Server already recorded that this user has seen the intro.
          if (m.intro_shown_at) continue;
          if (triggeredThisSession.current.has(m.match_id)) continue;
          if (shownLocallyRef.current.has(m.match_id)) continue;
          // Stale safety net: if a match is older than MAX_INTRO_AGE_MS and
          // we still don't have an intro_shown_at flag, treat it as
          // already-seen rather than firing a "match found" animation for a
          // match the player has long since moved past. Likely cause: a
          // markIntroShown POST that never landed; the player has been
          // playing without ever needing the intro replay.
          const createdAt = m.created_at ? new Date(m.created_at).getTime() : 0;
          if (createdAt && Date.now() - createdAt > MAX_INTRO_AGE_MS) {
            // Persist locally so we don't keep checking this row every tick.
            persistShown(m.match_id);
            api.matches.markIntroShown(m.match_id).catch(() => { });
            continue;
          }

          // Reserve the slot in this session BEFORE doing anything async,
          // so a second tick that fires while we're still fetching detail
          // doesn't pick the same match up.
          triggeredThisSession.current.add(m.match_id);

          // Tell the server immediately. Doing this BEFORE the animation
          // renders means a crash mid-animation can't trigger a replay on
          // the next launch. The server uses COALESCE so duplicate calls
          // from racing devices are safe. Also persist locally — if the
          // server call drops, the local cache still prevents a replay.
          persistShown(m.match_id);
          api.matches.markIntroShown(m.match_id).catch(() => { });

          // Fetch the full match for clan info / theme previews / avatars.
          const detail = await api.matches.get(m.match_id);
          if (cancelled) return;

          const players = (detail.players ?? []) as any[];
          const me = players.find((p) => p.user_id === user.user_id);
          if (!me) continue;
          const meSide: 1 | 2 = me.side === 2 ? 2 : 1;
          const side1 = players.filter((p) => p.side === 1) as SidePlayer[];
          const side2 = players.filter((p) => p.side === 2) as SidePlayer[];
          if (side1.length === 0 || side2.length === 0) continue;

          // Defensive: for TEAM matches (duo / squad), suppress the intro
          // if my clan somehow appears on both sides — that would only
          // happen via a legacy data row, since the server now refuses to
          // pair team matches with shared clanmates. Solo matches are
          // intentionally allowed to pair clanmates against each other
          // (in-house 1v1), so we DO NOT skip on shared-clan for solo —
          // doing so would silently drop the animation for two friends
          // in the same league playing 1v1.
          const detailType = (detail.match_type ?? m.match_type ?? 'solo') as string;
          if (detailType !== 'solo') {
            const myClanId = (me as any).clan_id;
            const opponent = meSide === 1 ? side2 : side1;
            const opponentHasMyClan = !!myClanId
              && opponent.some((p: any) => p.clan_id === myClanId);
            if (opponentHasMyClan) continue;
          }

          showingRef.current = true;
          setIntro({
            matchId: m.match_id,
            matchType: detail.match_type ?? m.match_type ?? 'solo',
            meSide,
            side1,
            side2,
          });
          // Only show one intro at a time — bail out of the loop. Subsequent
          // matches will fire on the next tick after this one is dismissed.
          break;
        }
      } catch { /* network blips — try again next tick */ }
    };

    // Run immediately on mount, then on a regular interval.
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);

    // Also re-check when the app foregrounds (catches the "match happened
    // while my phone was locked" case — the player gets the intro the
    // moment they reopen the app, even if it paired hours earlier).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_id, token]);

  const dismiss = () => {
    // Server flag is already persisted at trigger time, so closing the
    // overlay is purely a local state change. Reset the ref so the next
    // tick is free to fire a new intro if another match has paired since.
    showingRef.current = false;
    setIntro(null);
  };

  if (!intro) return null;
  return (
    <MatchFoundIntro
      visible={true}
      matchType={intro.matchType}
      meSide={intro.meSide}
      side1Players={intro.side1}
      side2Players={intro.side2}
      onDismiss={dismiss}
    />
  );
}
