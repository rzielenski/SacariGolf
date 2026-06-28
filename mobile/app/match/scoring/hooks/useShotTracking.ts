/**
 * Per-hole shot tracking state machine.
 *
 *   const tracking = useShotTracking({ matchId, userId, userCoord, currentHoleNum });
 *
 * Flow:
 *   • Player picks a club via `pickClubManual` (this becomes pendingClub).
 *   • Taps TRACK → `onTrackPress` records the start position (activeShot set).
 *   • Walks to the ball, taps TRACK again → `onTrackPress` records the end,
 *     appends the finalized Shot to shotsByHole[hole], persists to server,
 *     and clears pendingClub so the next shot prompts a fresh club pick.
 *   • Long-press TRACK while recording → `onTrackLongPress` cancels active.
 *   • Long-press TRACK while idle → removes the most recent shot.
 *
 * Manual-vs-auto club choice is tracked via `manualPickRef` so the
 * auto-suggest effect can call `pickClubAuto` without clobbering a
 * player's explicit pick.
 *
 * `hydrate(rows)` is called by the parent after `api.matches.listShotTracks`
 * completes during initial load. Accepts both segment-format and legacy
 * point-array format from older clients.
 */

import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../../../lib/api';
import { distYards, bearingDeg } from '../../../../lib/golfMath';
import type { Shot, ActiveShot, Pt } from '../../../../lib/scoringTypes';

/**
 * Per-match local cache key for shotsByHole. Mirrored to AsyncStorage on
 * every change so a kill-switch / background-suspend / offline-then-die
 * can't lose tracked shots — even if the server save was in flight or
 * blocked. The parent hydrates from the server when it can; this hook
 * additionally hydrates from local on mount so the UI is populated
 * before the network round-trip finishes.
 */
const localKey = (matchId: string) => `shots_${matchId}`;
const activeKey = (matchId: string) => `shots_active_${matchId}`;
/** A persisted activeShot older than this is treated as stale and dropped.
 *  Rationale: a real shot-in-progress is at most a few minutes (walk to the
 *  ball). Anything older is almost certainly an abandoned recording that
 *  the player forgot about — restoring it would attach a wrong "start" to
 *  whatever they next track. */
const ACTIVE_STALE_MS = 2 * 60 * 60 * 1000;

interface UseShotTrackingArgs {
  matchId: string;
  userId: string | undefined;
  userCoord: { latitude: number; longitude: number; altitude?: number | null } | null;
  currentHoleNum: number | undefined;
  /** Optional: called at shot-finalize time with the start/end Pt. If it
   *  returns a number, that becomes the shot's `plays_like_yds` and is
   *  persisted alongside the raw GPS coords. Lets the parent inject its
   *  weather / slope context without coupling the hook to those modules. */
  computePlaysLike?: (start: Pt, end: Pt) => number | null;
  /** Optional: inverse-variance weighted average of recent GPS fixes
   *  (from useLocation.getAveragedFix). When provided, shot endpoints
   *  are sampled from the buffered window instead of taking a single
   *  noisy fix — typically tightens shot length by 50–70%. Falls back
   *  to userCoord when no buffered fixes are available yet. */
  getAveragedFix?: (windowMs: number) => {
    latitude: number;
    longitude: number;
    altitude: number | null;
    baroRelativeM: number | null;
    accuracyM: number;
    samples: number;
  } | null;
  /** Optional: current barometer relative altitude (m). Captured into the
   *  Pt's `baro_relative_m` field so plays-like slope can use the sub-meter
   *  barometric delta instead of the ±10m GPS-altitude delta. */
  getRelativeAltitudeM?: () => number | null;
  /** Optional: the player's aim point for THIS hole, set by dragging the
   *  on-map heatmap target. When present, it's recorded on the finalised
   *  Shot so the post-round lateral calculation uses the start→aim line as
   *  the centerline instead of the default start→pin line. */
  getAimPoint?: () => { lat: number; lng: number } | null;
  /** Optional: the known pin coordinate for THIS hole. Used as the
   *  fallback centerline for lateral_yds when the player hasn't dragged
   *  the heatmap aim — i.e. on every shot where no manual target was
   *  picked but we do know where the hole is. Absent on holes the player
   *  hasn't pinned yet AND the course catalog doesn't have a pin for. */
  getPinPoint?: () => { lat: number; lng: number } | null;
  /** Optional: the teebox coordinate for THIS hole. Used as the START anchor
   *  when logging a forgotten DRIVE (the first shot of the hole) the player
   *  never tapped TRACK for. Null on holes without a marked tee. */
  getTeePoint?: () => { lat: number; lng: number } | null;
  /** Optional: ms since the last accepted GPS fix (from useLocation). When
   *  the GPS is frozen (iOS paused the watch, deep pocket, etc.) the
   *  displayed position is stale; recording a shot from it produces a
   *  0-yard or wildly-jumped phantom segment. We block START/STOP when this
   *  exceeds STALE_FIX_TRACK_MS rather than silently logging garbage. */
  getMsSinceLastFix?: () => number | null;
}

/** How far back into the rolling fix buffer we look when finalising a shot
 *  point. 2.5s is the sweet spot: long enough that a stationary golfer over
 *  the ball has 2-3 fixes in the window (1Hz native iOS rate), short enough
 *  that a walking-fast player doesn't average over a 5m arc. */
const AVERAGE_WINDOW_MS = 2500;

/** GPS older than this when TRACK is tapped is treated as frozen — we refuse
 *  to start/stop a shot rather than record a phantom from a stale fix. */
const STALE_FIX_TRACK_MS = 15_000;

/** A shot is only safe to keep (and render) if both endpoints have numeric
 *  coords. Malformed entries — legacy formats, half-saved offline tracks, a
 *  corrupt local cache — are dropped at ingestion so NO render path (the map
 *  loops, the forgotten-shot anchor, the stat inference) can deref an undefined
 *  coordinate and crash the scoring screen. */
function isValidShot(s: any): s is Shot {
  return !!s && !!s.start && !!s.end
    && typeof s.start.lat === 'number' && typeof s.start.lng === 'number'
    && typeof s.end.lat === 'number' && typeof s.end.lng === 'number';
}

/** Filter a persisted shotsByHole map down to well-formed shots only. */
function sanitizeShotsByHole(obj: any): Record<number, Shot[]> {
  const out: Record<number, Shot[]> = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) out[Number(k)] = obj[k].filter(isValidShot);
  }
  return out;
}

export function useShotTracking({
  matchId, userCoord, currentHoleNum, computePlaysLike,
  getAveragedFix, getRelativeAltitudeM, getAimPoint, getPinPoint, getTeePoint,
  getMsSinceLastFix,
}: UseShotTrackingArgs) {
  const [shotsByHole, setShotsByHole] = useState<Record<number, Shot[]>>({});
  const [activeShot, setActiveShot] = useState<ActiveShot | null>(null);
  const [pendingClub, setPendingClubState] = useState<string | null>(null);
  const [pendingPartial, setPendingPartial] = useState<string | null>(null);
  const [clubPickerVisible, setClubPickerVisible] = useState(false);

  /** True iff the current pendingClub was set by an explicit user tap.
   *  Auto-suggestions only run when this is false. */
  const manualPickRef = useRef(false);

  // ── Local cache ─────────────────────────────────────────────────────────
  // True once a real server hydrate has happened. Until then, local-only
  // shots are preserved across mounts; once the server speaks we let it
  // win for keys it has, while keeping any local shots the server didn't
  // know about yet (e.g. saved offline).
  const serverHydratedRef = useRef(false);

  // Boot-up: read the cached shotsByHole if any, so the map renders with
  // last-known shots immediately on remount. The parent will call hydrate()
  // once the server responds — that merge keeps anything the server is
  // missing (in-flight saves that never landed).
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(localKey(matchId)).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const cached = JSON.parse(raw);
        if (cached && typeof cached === 'object' && !serverHydratedRef.current) {
          setShotsByHole(sanitizeShotsByHole(cached));
        }
      } catch { /* corrupt cache → wait for server hydrate */ }
    });
    return () => { cancelled = true; };
  }, [matchId]);

  // Mirror every shotsByHole change to AsyncStorage. Cheap relative to the
  // server save (single setItem, no network), so we don't debounce.
  useEffect(() => {
    AsyncStorage.setItem(localKey(matchId), JSON.stringify(shotsByHole)).catch(() => { });
  }, [matchId, shotsByHole]);

  // Boot-up: restore an in-progress activeShot if one was persisted and is
  // still fresh. "Fresh" = startedAt within ACTIVE_STALE_MS. A persisted
  // shot older than that is most likely an abandoned recording from a
  // previous session — restoring it would let the next TRACK tap finalize
  // a shot with a long-stale "start" GPS point. Better to drop and retrack.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(activeKey(matchId)).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const cached = JSON.parse(raw) as ActiveShot;
        if (!cached?.startedAt) return;
        const ageMs = Date.now() - new Date(cached.startedAt).getTime();
        if (ageMs < 0 || ageMs > ACTIVE_STALE_MS) {
          // Stale or clock-skewed — drop the on-disk copy too so we don't
          // re-examine it every mount.
          AsyncStorage.removeItem(activeKey(matchId)).catch(() => { });
          return;
        }
        // Strip baro_relative_m from the restored start point: the
        // CMAltimeter barometer counts from wherever the sensor session
        // started, so a value persisted in the previous session is in a
        // different reference frame than the freshly-captured END reading
        // would be. Comparing them produces a meaningless slope delta
        // (often several meters wrong, since weather pressure drifts).
        // Drops back to GPS-altitude delta for plays-like — less precise
        // but at least the SIGN is correct.
        if (cached.start) {
          const { baro_relative_m: _baro, ...startNoBaro } = cached.start;
          cached.start = startNoBaro;
        }
        setActiveShot(cached);
        // The pendingClub UI label should also reflect the club the player
        // had locked in when they started the shot — re-arm it so the
        // CLUB chip shows the right value on relaunch.
        if (cached.club) {
          setPendingClubState(cached.club);
          manualPickRef.current = true;
        }
        if (cached.partial_value) setPendingPartial(cached.partial_value);
      } catch { /* corrupt cache → ignore */ }
    });
    return () => { cancelled = true; };
  }, [matchId]);

  // Mirror activeShot to AsyncStorage. Tiny write (a couple of floats + a
  // timestamp), no debounce. Cleared by writing null/removing the key so
  // the next mount doesn't restore a finalized or cancelled shot.
  useEffect(() => {
    if (activeShot) {
      AsyncStorage.setItem(activeKey(matchId), JSON.stringify(activeShot)).catch(() => { });
    } else {
      AsyncStorage.removeItem(activeKey(matchId)).catch(() => { });
    }
  }, [matchId, activeShot]);

  /** Snapshot the player's position into a Pt. Prefers the inverse-variance
   *  weighted average of the last AVERAGE_WINDOW_MS of buffered fixes
   *  (from useLocation) — a stationary golfer over the ball typically has
   *  2-3 fixes in the window, giving sub-3m horizontal accuracy where a
   *  single raw fix is 5-10m. Falls back to userCoord if the buffer is
   *  empty (very first shot of the round, before warm-up completes).
   *
   *  Barometric relative altitude is captured into baro_relative_m so the
   *  end-of-shot computePlaysLike callback can use the sub-meter
   *  barometric delta for slope instead of the ±10m GPS-altitude delta. */
  const ptFromCoord = (): Pt | null => {
    const avg = getAveragedFix?.(AVERAGE_WINDOW_MS);
    if (avg) {
      const p: Pt = { lat: avg.latitude, lng: avg.longitude };
      if (typeof avg.altitude === 'number') p.elevation_m = avg.altitude;
      const baro = avg.baroRelativeM ?? getRelativeAltitudeM?.();
      if (typeof baro === 'number') p.baro_relative_m = baro;
      return p;
    }
    if (!userCoord) return null;
    const p: Pt = { lat: userCoord.latitude, lng: userCoord.longitude };
    if (typeof userCoord.altitude === 'number') p.elevation_m = userCoord.altitude;
    const baro = getRelativeAltitudeM?.();
    if (typeof baro === 'number') p.baro_relative_m = baro;
    return p;
  };

  const persistShots = (holeNum: number, next: Shot[]) => {
    api.matches.saveShotTrack(matchId, holeNum, next).catch(() => { /* best-effort */ });
  };

  /** Build, append, persist, and reset for a finalized shot. Shared by the
   *  normal STOP path and the "forgot to start" path so the geometry (total /
   *  lateral / plays-like) is identical for both. */
  const finalizeShot = (p: {
    start: Pt; end: Pt; club: string; lie?: string; partial?: string; holeNum: number;
  }) => {
    const { start, end, club, lie, partial, holeNum } = p;
    const playsLike = computePlaysLike?.(start, end);
    const aim = getAimPoint?.() ?? null;
    const pin = getPinPoint?.() ?? null;
    const total_yds = Math.round(distYards(start.lat, start.lng, end.lat, end.lng));
    let lateral_yds: number | undefined;
    let lateral_ref: 'aim' | 'pin' | undefined;
    const centerline = aim ?? pin;
    if (centerline) {
      const refBearing = bearingDeg(start.lat, start.lng, centerline.lat, centerline.lng);
      const shotBearing = bearingDeg(start.lat, start.lng, end.lat, end.lng);
      let dB = shotBearing - refBearing;
      while (dB > 180) dB -= 360;
      while (dB < -180) dB += 360;
      lateral_yds = Math.round(total_yds * Math.sin(dB * Math.PI / 180));
      lateral_ref = aim ? 'aim' : 'pin';
    }
    const newShot: Shot = {
      club,
      lie,
      start,
      end,
      recorded_at: new Date().toISOString(),
      total_yds,
      ...(typeof playsLike === 'number' && playsLike > 0 ? { plays_like_yds: Math.round(playsLike) } : {}),
      ...(aim ? { aim } : {}),
      ...(lateral_yds != null && lateral_ref ? { lateral_yds, lateral_ref } : {}),
      ...(partial ? { partial_value: partial } : {}),
    };
    setShotsByHole((prev) => {
      const cur = prev[holeNum] ?? [];
      const next = [...cur, newShot];
      persistShots(holeNum, next);
      return { ...prev, [holeNum]: next };
    });
    setActiveShot(null);
    setPendingClubState(null);
    setPendingPartial(null);
    manualPickRef.current = false;
  };

  /** User explicitly picked a club. Sticks until the next shot is finalized. */
  const pickClubManual = (club: string | null) => {
    manualPickRef.current = club !== null;
    setPendingClubState(club);
    if (!club) setPendingPartial(null);   // clearing the club clears the partial
    if (activeShot && club) setActiveShot({ ...activeShot, club });
  };

  /** Set the partial-swing tag for the next/active shot ('75%', '9:00', or
   *  null for a full swing). */
  const pickPartial = (value: string | null) => {
    setPendingPartial(value);
    if (activeShot) setActiveShot({ ...activeShot, partial_value: value ?? undefined });
  };

  /** Auto-suggest sets the club WITHOUT marking it manual, so a subsequent
   *  user tap (via pickClubManual) still locks it in. */
  const pickClubAuto = (club: string) => {
    if (manualPickRef.current) return;
    if (pendingClub === club) return;
    setPendingClubState(club);
  };

  /** True if the auto-suggest effect should run (player hasn't picked). */
  const isManualPick = () => manualPickRef.current;

  const onTrackPress = () => {
    if (!userCoord || currentHoleNum == null) {
      Alert.alert('No GPS', 'Wait for a GPS lock before tracking shots.');
      return;
    }
    // Reject a frozen fix — recording from a stale position logs a 0-yard
    // or jumped phantom shot. Applies to both START and STOP.
    const sinceFix = getMsSinceLastFix?.();
    if (sinceFix != null && sinceFix > STALE_FIX_TRACK_MS) {
      Alert.alert('GPS stale', "Your GPS hasn't updated recently. Wait for a fresh fix before tracking the shot.");
      return;
    }
    // STOP — finalize the active shot. Attribute it to the hole it was STARTED
    // on (activeShot.holeNum), not whatever hole is on screen now, so a mid-shot
    // hole change can't misfile it. Falls back to the current hole for legacy
    // active shots persisted without holeNum.
    if (activeShot) {
      const end = ptFromCoord();
      if (!end) return;
      finalizeShot({
        start: activeShot.start,
        end,
        club: activeShot.club,
        lie: activeShot.lie,
        partial: activeShot.partial_value,
        holeNum: activeShot.holeNum ?? currentHoleNum,
      });
      return;
    }
    // START — require a club first.
    if (!pendingClub) {
      Alert.alert(
        'Pick a club first',
        "Tap CLUB to choose what you're hitting before tracking the shot.",
        [{ text: 'OK', onPress: () => setClubPickerVisible(true) }],
      );
      return;
    }
    const start = ptFromCoord();
    if (!start) return;
    setActiveShot({ club: pendingClub, partial_value: pendingPartial ?? undefined, start, startedAt: new Date().toISOString(), holeNum: currentHoleNum });
  };

  /** Start anchor for a "forgot to start" shot: the END of the previous shot
   *  on this hole, or the teebox for the first shot (a drive). Null when neither
   *  is known — we never fabricate a start out of thin air. */
  const forgottenShotStart = (): { pt: Pt; lie?: string } | null => {
    if (currentHoleNum == null) return null;
    const cur = shotsByHole[currentHoleNum] ?? [];
    if (cur.length > 0) {
      const prevEnd = cur[cur.length - 1]?.end;
      // Only anchor to a previous shot that actually has a usable endpoint.
      if (!prevEnd || typeof prevEnd.lat !== 'number' || typeof prevEnd.lng !== 'number') return null;
      // Drop baro_relative_m from the prior end: it may belong to an earlier
      // barometer session (app relaunch mid-round), so comparing it to a fresh
      // end reading would yield a bogus slope. Plays-like falls back to the
      // GPS-altitude delta — less precise but correct in sign.
      const { baro_relative_m: _b, ...startNoBaro } = prevEnd;
      return { pt: startNoBaro };
    }
    const tee = getTeePoint?.() ?? null;
    if (tee && typeof tee.lat === 'number' && typeof tee.lng === 'number') {
      return { pt: { lat: tee.lat, lng: tee.lng }, lie: 'tee' };
    }
    return null;
  };

  /** True when a forgotten shot can be anchored (previous shot's finish, or a
   *  known tee for a drive). The UI only offers the action when this is true. */
  const canTrackForgottenShot = (): boolean => forgottenShotStart() != null;

  /** Log a shot the player forgot to START: start = previous shot's finish (or
   *  the tee for a drive), end = current position. One tap, no walk-back. */
  const trackForgottenShot = () => {
    if (activeShot || currentHoleNum == null) return;
    const sinceFix = getMsSinceLastFix?.();
    if (sinceFix != null && sinceFix > STALE_FIX_TRACK_MS) {
      Alert.alert('GPS stale', "Your GPS hasn't updated recently. Wait for a fresh fix before logging the shot.");
      return;
    }
    const anchor = forgottenShotStart();
    if (!anchor) {
      Alert.alert(
        "Can't log that yet",
        'A forgotten shot can only be logged when we know where it started — the finish of your previous shot on this hole, or the tee for a drive.',
      );
      return;
    }
    if (!pendingClub) {
      Alert.alert(
        'Pick a club first',
        'Tap CLUB to choose what you hit, then log the forgotten shot.',
        [{ text: 'OK', onPress: () => setClubPickerVisible(true) }],
      );
      return;
    }
    const end = ptFromCoord();
    if (!end) { Alert.alert('No GPS', 'Wait for a GPS lock before logging the shot.'); return; }
    finalizeShot({
      start: anchor.pt, end, club: pendingClub, lie: anchor.lie,
      partial: pendingPartial ?? undefined, holeNum: currentHoleNum,
    });
  };

  const cancelActiveShot = () => {
    if (!activeShot) return;
    setActiveShot(null);
  };

  /** Long-press: cancel active shot OR undo the last finalized shot. */
  const onTrackLongPress = () => {
    if (activeShot) { cancelActiveShot(); return; }
    if (currentHoleNum == null) return;
    setShotsByHole((prev) => {
      const cur = prev[currentHoleNum] ?? [];
      if (!cur.length) return prev;
      const next = cur.slice(0, -1);
      persistShots(currentHoleNum, next);
      return { ...prev, [currentHoleNum]: next };
    });
  };

  /** Delete a specific tracked shot by hole + index (e.g. long-pressed on the
   *  map). Re-persisting the trimmed array triggers the backend's atomic
   *  per-hole replace, so the shot is removed from the map AND from stats. */
  const deleteShotAt = (holeNum: number, index: number) => {
    setShotsByHole((prev) => {
      const cur = prev[holeNum] ?? [];
      if (index < 0 || index >= cur.length) return prev;
      const next = cur.filter((_, i) => i !== index);
      persistShots(holeNum, next);
      return { ...prev, [holeNum]: next };
    });
  };

  /** Merge server-side records into shotsByHole. Server wins for any hole
   *  it has data for; holes the server doesn't know about (e.g. an offline
   *  save that never reached the API) keep whatever was in the local cache.
   *
   *  Accepts segment format ({start, end}) and legacy point arrays
   *  ([{lat, lng, club?}]); legacy rounds stored shots as flat point arrays. */
  const hydrate = (rows: { hole_num: number; shots: any[] }[]) => {
    const fromServer: Record<number, Shot[]> = {};
    for (const r of rows) {
      const raw = (r.shots as any[]) ?? [];
      if (!raw.length) { fromServer[r.hole_num] = []; continue; }
      if (raw[0]?.start && raw[0]?.end) {
        fromServer[r.hole_num] = (raw as Shot[]).filter(isValidShot);
      } else {
        const segs: Shot[] = [];
        for (let i = 0; i < raw.length - 1; i++) {
          segs.push({
            club: raw[i]?.club ?? 'unknown',
            lie: raw[i]?.lie,
            start: { lat: raw[i]?.lat, lng: raw[i]?.lng, elevation_m: raw[i]?.elevation_m },
            end:   { lat: raw[i + 1]?.lat, lng: raw[i + 1]?.lng, elevation_m: raw[i + 1]?.elevation_m },
          });
        }
        fromServer[r.hole_num] = segs.filter(isValidShot);
      }
    }
    serverHydratedRef.current = true;
    setShotsByHole((local) => {
      // For each hole, prefer server-side data when present, else keep local.
      // Holes the server explicitly returned (even as empty []) win — that's
      // an authoritative "user has no shots here". Holes the server didn't
      // mention at all stay from local so a queued-but-not-yet-saved hole
      // doesn't get wiped.
      const merged: Record<number, Shot[]> = { ...local };
      for (const k of Object.keys(fromServer)) {
        merged[Number(k)] = fromServer[Number(k)];
      }
      // Retry any local-only holes against the server now that we're online.
      for (const k of Object.keys(local)) {
        if (!(k in fromServer)) {
          api.matches.saveShotTrack(matchId, Number(k), local[Number(k)]).catch(() => { });
        }
      }
      return merged;
    });
  };

  const currentShots = currentHoleNum != null ? (shotsByHole[currentHoleNum] ?? []) : [];

  return {
    shotsByHole,
    currentShots,
    activeShot,
    pendingClub,
    pendingPartial,
    clubPickerVisible,
    setClubPickerVisible,
    pickClubManual,
    pickPartial,
    pickClubAuto,
    isManualPick,
    onTrackPress,
    onTrackLongPress,
    cancelActiveShot,
    deleteShotAt,
    canTrackForgottenShot,
    trackForgottenShot,
    hydrate,
  };
}
