import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, Animated, Dimensions, TextInput, Modal,
  PanResponder, AppState,
} from 'react-native';
import MapView, { Marker, Polyline, Polygon, Circle, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, router } from 'expo-router';
import { api, OfflineError, NotAuthenticatedError } from '../../../lib/api';
import { queueSubmitScores, queueContributePin } from '../../../lib/outbox';
import { useAuth } from '../../../lib/auth';
import { isPremium } from '../../../lib/premium';
import { adjustDistance, windComponents, metersToFeet } from '../../../lib/weatherAdjust';
import { C, F } from '../../../lib/colors';
import { distMetres, distYards, bearingDeg, scoreLabel, scoreColor, SHOT_COLORS } from '../../../lib/golfMath';
import { useScorePanel } from './hooks/useScorePanel';
import { useShotTracking } from './hooks/useShotTracking';
import { useLocation } from './hooks/useLocation';
import { useGhostPlayer, GHOST_NAME } from './hooks/useGhostPlayer';
import type { Pt, Shot, ActiveShot } from '../../../lib/scoringTypes';
import { Hole, Teebox, Course } from '../../../types';
import { InviteFriendsModal } from '../../../components/InviteFriendsModal';
import { HoleScoreCelebration, CelebrationEvent, CelebrationKind } from '../../../components/HoleScoreCelebration';

const { width: SCREEN_W } = Dimensions.get('window');
const COLLAPSED_H = 110;
const EXPANDED_H = 380;

// ── Small stepper for per-hole stats (putts / chips) ───────────────────────
function StatStepper({ label, value, onChange }: {
  label: string;
  value: number | null;
  onChange: (n: number) => void;
}) {
  const display = value == null ? '—' : String(value);
  const inc = () => onChange(Math.min(10, (value ?? 0) + 1));
  const dec = () => onChange(Math.max(0, (value ?? 0) - 1));
  return (
    <View style={stepperStyles.wrap}>
      <Text style={stepperStyles.label}>{label.toUpperCase()}</Text>
      <View style={stepperStyles.row}>
        <TouchableOpacity style={stepperStyles.btn} onPress={dec}>
          <Text style={stepperStyles.btnText}>−</Text>
        </TouchableOpacity>
        <Text style={stepperStyles.value}>{display}</Text>
        <TouchableOpacity style={stepperStyles.btn} onPress={inc}>
          <Text style={stepperStyles.btnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const stepperStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', gap: 4 },
  label: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btn: {
    width: 28, height: 28, borderRadius: 4,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    justifyContent: 'center', alignItems: 'center',
  },
  btnText: { color: C.text, fontSize: 18, fontWeight: '700', lineHeight: 20 },
  value: { color: C.text, fontSize: 16, fontWeight: '800', minWidth: 18, textAlign: 'center' },
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function ScoringScreen() {
  const { id, holes: holesParam, subset: subsetParam } = useLocalSearchParams<{ id: string; holes?: string; subset?: string }>();
  // numHoles is a state so it can be corrected after loading the match's existing teebox
  const [numHoles, setNumHoles] = useState<number>(holesParam ? parseInt(holesParam, 10) : 18);
  // Whether to play the front 9, back 9, or full round. Only meaningful for
  // 9-hole matches on 18-hole teeboxes. Updated after match data loads if
  // the route param wasn't supplied (e.g. resumed match).
  const [holesSubset, setHolesSubset] = useState<'front' | 'back' | 'full'>(
    subsetParam === 'back' ? 'back' : subsetParam === 'front' ? 'front' : 'full'
  );
  const { user } = useAuth();

  // Match / course data
  const [match, setMatch] = useState<any>(null);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [teebox, setTeebox] = useState<Teebox | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [scores, setScores] = useState<number[]>([]);
  const [currentHole, setCurrentHole] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [scorecardVisible, setScorecardVisible] = useState(false);
  // In-round invite modal — only used for practice rounds, where the host can
  // pull in up to 8 friends to play the same course/teebox together (each on
  // their own scorecard, no ELO).
  const [inviteVisible, setInviteVisible] = useState(false);

  // Shot tracking — state machine in hooks/useShotTracking.ts. Recording flow:
  // pick club → tap TRACK (records start) → walk to ball → tap TRACK again
  // (records end). Long-press undoes the last shot.
  // Advanced detail entry modal — miss directions + per-putt distance sliders
  const [advancedVisible, setAdvancedVisible] = useState(false);

  // Weather conditions — fetched once per round (course location-based) and
  // refreshed every 15 min while playing. Drives the premium "plays-like"
  // distance adjustment.
  type WeatherData = {
    temperature_f: number | null;
    wind_speed_mph: number | null;
    wind_from_bearing: number | null;
    rain: 'none' | 'light' | 'heavy';
    elevation_ft: number | null;
  };
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherSheetVisible, setWeatherSheetVisible] = useState(false);
  const userIsPremium = isPremium(user as any);
  // Past shots from previous rounds on the current hole — premium overlay.
  // Indexed by hole_num; each entry is the full raw shot track from an old
  // round. Filtering to "near current GPS" happens at render time so the
  // overlay updates as the player walks.
  type PastRound = { match_id: string; created_at: string; shots: any[] };
  const [pastShotsByHole, setPastShotsByHole] = useState<Record<number, PastRound[]>>({});

  // Per-club performance — drives the auto-club-suggest and heatmap overlay
  // (both premium-only). Loaded once on mount, refreshed implicitly each
  // round since data only grows.
  type ClubStat = {
    club: string;
    shots: number;
    avg_yds: number;
    median_yds: number;
    dispersion: { lateral_yds: number; long_yds: number; dist_yds: number }[];
  };
  const [clubStats, setClubStats] = useState<ClubStat[] | null>(null);

  // Past shots this user has tracked on the CURRENT hole in PRIOR rounds.
  // Drives the "ghost shots" overlay so the player can see where they've
  // landed shots on this hole before. Premium-only. Refreshed on hole change.
  type PastRoundShots = { match_id: string; created_at: string; shots: Shot[] };
  const [pastHoleShots, setPastHoleShots] = useState<PastRoundShots[]>([]);

  // Elevation of the user's home course, used as a baseline so altitude
  // effects on plays-like distance are RELATIVE to where the player normally
  // calibrates their distances. e.g. a player who lives at 5,000 ft will
  // see a NEGATIVE altitude adjustment when playing at sea level (ball
  // flies shorter than they're used to). Fetched once per round.
  const [homeElevationFt, setHomeElevationFt] = useState<number | null>(null);

  // Precise terrain elevation at the player's CURRENT position, sourced from
  // the high-resolution DEM endpoint (USGS 3DEP for US, Copernicus elsewhere).
  // Refreshed when the player moves >5m horizontally. This replaces the GPS
  // altimeter (±15m noise + frame mismatch) for slope calculations.
  const [playerElevationM, setPlayerElevationM] = useState<number | null>(null);
  const lastElevFetchCoord = useRef<{ lat: number; lng: number } | null>(null);
  // Per-session cache so we don't refetch the same lat/lng across renders.
  const elevCacheRef = useRef<Map<string, number>>(new Map());

  // Per-hole stat tracking — putts, chips, fairway hit. Indexed by the hole
  // INDEX in our holes array (not hole_num) so we can submit it as a parallel
  // array alongside scores. Tracking is opt-in: untouched holes stay empty.
  type HoleStat = {
    putts?: number;
    chips?: number;
    gir?: boolean | null;
    fairwayHit?: boolean | null;
    // Advanced entry — direction of miss when fairway/green wasn't hit.
    fairwayMiss?: 'left' | 'right' | null;
    greenMiss?: 'left' | 'right' | 'short' | 'long' | null;
    // One distance entry per putt taken (in feet). Length should match `putts`.
    // Allowed stops: 3, 6, 10, 15, 20, 30, 40, 50.
    puttDistances?: number[];
  };
  const [holeStats, setHoleStats] = useState<HoleStat[]>([]);
  // Per-hole record of which fields the user manually set. Auto-derivation
  // from tracked shots will only overwrite fields NOT in this set, so user
  // taps always win.
  const [manualFields, setManualFields] = useState<Record<number, Set<string>>>({});
  const markManual = (holeIdx: number, ...fields: string[]) => {
    setManualFields((prev) => {
      const cur = prev[holeIdx] ?? new Set<string>();
      const next = new Set(cur);
      for (const f of fields) next.add(f);
      return { ...prev, [holeIdx]: next };
    });
  };

  // Course selection
  const [selectingCourse, setSelectingCourse] = useState(true);
  // Round length the player chose for this round. Null until they pick;
  // forces a step between course-pick and teebox-pick (matches play.tsx flow).
  const [chosenRoundHoles, setChosenRoundHoles] = useState<9 | 18 | null>(null);
  const [courseQuery, setCourseQuery] = useState('');
  const [courseResults, setCourseResults] = useState<Course[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [courseSearching, setCourseSearching] = useState(false);
  const [loadingCourse, setLoadingCourse] = useState(false);
  const [fullCourse, setFullCourse] = useState<Course | null>(null);

  // Map / location
  const mapRef = useRef<MapView>(null);
  const [measurePin, setMeasurePin] = useState<{ latitude: number; longitude: number } | null>(null);
  // DEM elevation at the tapped measure point. Looked up once per pin set
  // and cached locally — terrain doesn't move.
  const [measureElevationM, setMeasureElevationM] = useState<number | null>(null);
  // When the user taps the Clear button (which sits inside an absolute-
  // positioned banner OVER the MapView), iOS's native MapView still receives
  // the same physical tap — without this guard the map's onPress fires right
  // after, dropping a NEW measure pin at the banner's screen position.
  //
  // This is a SINGLE-SHOT boolean, not a time window. The old version armed a
  // ~300ms timestamp window; any genuine map tap that happened to land inside
  // that window (a quick re-measure after Clear, or event-timing jitter under
  // load) got silently swallowed and the banner stayed "stuck" on the old
  // distance. A single-shot flag swallows at most ONE event — the phantom tap
  // from Clear — and the very next map press consumes it, so no real tap can
  // ever be lost.
  const ignoreNextMapTap = useRef(false);
  const [following, setFollowing] = useState(true);
  const {
    userCoord, onCourse, locGranted,
    gpsAccuracyM, hasQualityFix,
    getAveragedFix, getRelativeAltitudeM,
    getMsSinceLastFix, refreshGps, resetFixBuffer,
  } = useLocation({
    enabled: !selectingCourse,
    courseLat: course?.latitude,
    courseLng: course?.longitude,
    onOffCourse: () => setFollowing(false),
  });

  // ── Relative-elevation crowdsourcing ───────────────────────────────────
  // Phone barometers are sub-meter accurate at *relative* altitude over short
  // timescales, but their *absolute* reading drifts. We anchor every reading
  // this round to a per-course origin (= 0m at the first contributor's
  // first teebox), so cached points become barometer-grade.
  //
  //   elevOffsetM:          device altitude that corresponds to course origin = 0m
  //   userRelElevationM:    derived from (userCoord.altitude - elevOffsetM) in slope math
  //   pinRelElevM:          looked up from server cache when on a hole
  //
  // The buffer accumulates per-watchPositionAsync samples; a debounced
  // flusher batch-uploads every 15s so a typical round contributes ~15
  // points without hammering the API.
  const [elevOffsetM, setElevOffsetM] = useState<number | null>(null);
  const [elevOffsetMode, setElevOffsetMode] = useState<'anchor' | 'global' | 'seed' | null>(null);
  const [pinRelElevM, setPinRelElevM] = useState<number | null>(null);
  const elevSampleBuf = useRef<{ lat: number; lng: number; elevationRelM: number }[]>([]);
  const elevFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastElevSampleAtRef = useRef<{ lat: number; lng: number } | null>(null);
  // ── Barometric anchor (set on first TRACK press of the round) ─────────
  // The first time the player taps TRACK they're at the tee box — a known
  // location, ideal for anchoring. We capture two values at that moment:
  //   • baroAnchorM   — CMAltimeter relativeAltitude (sub-meter precise)
  //   • gpsAltAnchorM — GPS altitude (±10m noisy, but absolute MSL)
  // For every subsequent elevation reading along the player's walk:
  //   effectiveAlt = gpsAltAnchorM + (currentBaroM - baroAnchorM)
  // The (currentBaro - anchorBaro) delta is sub-meter; the gpsAltAnchor
  // carries the single noisy absolute reading for the whole round. Across
  // many rounds + many players the GPS-anchor noise averages out in the
  // shared course-frame elevation grid, while same-round deltas remain
  // barometer-precise. This is what makes "walk-the-hole" elevation
  // mapping actually accurate.
  const baroAnchorMRef = useRef<number | null>(null);
  const gpsAltAnchorMRef = useRef<number | null>(null);
  // Course-level "is elevation well mapped" flag, captured from the
  // dataQuality response. When TRUE we skip the per-fix elevation
  // sampling entirely — the shared course grid already has enough
  // points and continuing to upload would waste battery (barometer +
  // GPS + radio for the periodic flush) for zero map improvement.
  // Null = not yet fetched (default to sampling, safe behavior).
  const [elevationWellMapped, setElevationWellMapped] = useState<boolean | null>(null);
  // Show the "this course is underdocumented" popup at most once per scoring-
  // screen instance so leaving and re-entering doesn't re-nag.
  const dataQualityShownRef = useRef(false);

  // Score panel — animated height + drag handler. See hooks/useScorePanel.ts
  const { panelAnim, panResponder, panelExpanded, snapPanel } = useScorePanel(COLLAPSED_H, EXPANDED_H);

  // Namespace saved progress by user so logging into a different account on
  // the same device doesn't pick up the previous user's in-progress round.
  const SAVE_KEY = `scores_${user?.user_id ?? 'anon'}_${id}`;

  /**
   * Persist the current round's score/stat draft to AsyncStorage.
   *
   * Called from three places:
   *   • The autosave effect below — whenever scores/holeStats/currentHole
   *     change, debounced ~400ms so rapid +/- taps don't hammer disk.
   *   • The AppState listener — IMMEDIATELY when the app moves to
   *     background or inactive, no debounce. iOS suspends JS within a
   *     few hundred ms of backgrounding, so this beats the debounce.
   *   • The unmount cleanup — last-chance flush when the player backs out.
   *
   * Bug history: previously only `saveAndLeave` wrote here. If the player
   * killed the app mid-round (multitasking swipe), every hole they'd
   * entered was lost because the in-memory state never touched disk.
   */
  const persistDraft = useCallback(async () => {
    if (!teebox || !course) return;
    try {
      await AsyncStorage.setItem(SAVE_KEY, JSON.stringify({
        scores,
        holeStats,
        currentHole,
        teeboxId: teebox?.teebox_id,
        courseId: course?.course_id,
        savedAt: Date.now(),
      }));
    } catch { /* best-effort — disk full, etc. */ }
  }, [SAVE_KEY, scores, holeStats, currentHole, teebox, course]);

  // Debounced autosave whenever a tracked field changes. The 400ms window
  // smooths out rapid stroke +/- taps and stat slider drags. Crucially, the
  // AppState listener below short-circuits this debounce — backgrounding
  // the app flushes immediately so even a sub-debounce kill survives.
  useEffect(() => {
    if (loading || selectingCourse) return;
    const t = setTimeout(() => { persistDraft(); }, 400);
    return () => clearTimeout(t);
  }, [scores, holeStats, currentHole, loading, selectingCourse, persistDraft]);

  // Background flush + unmount flush. iOS gives JS a small window between
  // 'inactive' and 'background' to finish work — writing synchronously here
  // means the round draft is on disk before the OS suspends the runtime.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') {
        persistDraft();
      }
    });
    return () => {
      sub.remove();
      // Final flush on unmount so a navigation away always saves.
      persistDraft();
    };
  }, [persistDraft]);

  // ── Live progress upload (so friends can watch) ─────────────────────────────
  // First update fires immediately when scoring starts (so the backend's
  // active-round query has a row to find). Subsequent updates are debounced
  // 2s after the last score change to avoid hammering the API.
  //
  // After every successful upload, immediately pull /celebrations so that
  // the local player sees their own birdie/eagle/HIO animation within ~half
  // a second of the score landing (without waiting for the regular poll
  // interval). The poll's own dedup logic prevents double-firing.
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReportedOnce = useRef(false);
  const fetchCelebrationsRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (selectingCourse || holes.length === 0 || scores.length === 0 || !teebox) return;
    const send = () => {
      api.matches.progress(id, {
        holeScores: scores.slice(0, Math.max(currentHole + 1, 1)),
        holeStats: holeStats.slice(0, Math.max(currentHole + 1, 1)),
        teeboxId: teebox.teebox_id,
      })
        .then(() => { fetchCelebrationsRef.current(); })
        .catch(() => { });
    };
    if (!hasReportedOnce.current) {
      hasReportedOnce.current = true;
      send();
      return;
    }
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(send, 2000);
    return () => { if (progressTimer.current) clearTimeout(progressTimer.current); };
  }, [scores, holeStats, currentHole, selectingCourse, holes.length, id, teebox]);

  // ── Birdie / Eagle / Hole-in-One celebrations ─────────────────────────
  // Polls /celebrations every 8s while the scoring screen is mounted +
  // forces an immediate fetch right after each /progress upload (above).
  // The server returns the ENTIRE event history for the match (no time
  // filter), so the async-play case works correctly: if Player A finished
  // their round Monday and Player B is playing the same match Saturday,
  // B's first poll returns A's full set of birdies/eagles/HIO.
  //
  // GATING — events only fire when the local player has REACHED the
  // corresponding hole. "Reached" = currentHole >= hole_num - 1 (since
  // currentHole is 0-indexed). This means:
  //   • Live play: A birdies hole 7 → A's screen fires it instantly
  //     (they're on hole 7); B's screen fires it when B reaches hole 7,
  //     not when A scored it.
  //   • Async play: B opens the match on Saturday, currentHole = 0. All of
  //     A's prior celebrations sit in the queue. As B advances through
  //     each hole, the corresponding celebration fires on entry.
  //
  // PERSISTENCE — celebration ids the local user has already SEEN are
  // mirrored to AsyncStorage so closing+reopening the match doesn't replay
  // every prior celebration. Persisted per (matchId, userId) — switching
  // users on the same device gets a fresh seen-set.
  //
  // For team matches we play the SCORING PLAYER's clan theme; for solos
  // we play their personal theme. Same isTeamMatch switch as MatchFoundIntro.
  const [celebrationEvent, setCelebrationEvent] = useState<CelebrationEvent | null>(null);
  type PendingCeleb = CelebrationEvent & { celebration_id: string };
  const pendingRef = useRef<PendingCeleb[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastSinceRef = useRef<string | null>(null);
  const isTeamMatch = (match?.match_type ?? 'solo') !== 'solo';
  const seenStorageKey = `celebrations_seen_${id}_${user?.user_id ?? 'anon'}`;

  // Hydrate the seen-set from disk so a remount doesn't re-fire events.
  useEffect(() => {
    if (!user?.user_id) return;
    let cancelled = false;
    AsyncStorage.getItem(seenStorageKey).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const arr: string[] = JSON.parse(raw);
        if (Array.isArray(arr)) seenIdsRef.current = new Set(arr);
      } catch { /* corrupt — start clean */ }
    });
    return () => { cancelled = true; };
  }, [seenStorageKey, user?.user_id]);

  // Debounced persistence of the seen-set. ~500ms after the last ingestion
  // we flush. Cheap (single setItem) and bounded in size — even an extreme
  // 18-hole match with both players acing every hole is 36 short ids.
  const seenPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSeenPersist = useCallback(() => {
    if (seenPersistTimer.current) clearTimeout(seenPersistTimer.current);
    seenPersistTimer.current = setTimeout(() => {
      AsyncStorage.setItem(seenStorageKey, JSON.stringify([...seenIdsRef.current])).catch(() => { });
    }, 500);
  }, [seenStorageKey]);

  /** Promote the first queued event whose hole_num the local player has
   *  reached into the visible slot. Called whenever something might've
   *  changed: a new poll landed, currentHole advanced, or the active
   *  event was dismissed. */
  const tryFireCelebration = useCallback(() => {
    if (celebrationEvent) return; // already showing one — wait for dismiss
    const eligibleHoleMax = currentHole + 1; // currentHole is 0-indexed
    const idx = pendingRef.current.findIndex((e) => e.hole <= eligibleHoleMax);
    if (idx < 0) return;
    const [next] = pendingRef.current.splice(idx, 1);
    setCelebrationEvent(next);
  }, [celebrationEvent, currentHole]);

  const fetchCelebrations = useCallback(async () => {
    if (selectingCourse) return;
    try {
      const rows = await api.matches.celebrations(id, lastSinceRef.current);
      if (!rows.length) return;
      // Advance the since cursor to the newest event — server returns
      // chronological order so this is always the last row.
      lastSinceRef.current = rows[rows.length - 1].created_at;
      let addedAny = false;
      for (const row of rows) {
        if (seenIdsRef.current.has(row.celebration_id)) continue;
        seenIdsRef.current.add(row.celebration_id);
        addedAny = true;
        const themePreview = isTeamMatch
          ? (row.clan_theme_preview ?? null)
          : (row.user_theme_preview ?? null);
        const themeTitle = isTeamMatch
          ? (row.clan_theme_title ?? null)
          : (row.user_theme_title ?? null);
        pendingRef.current.push({
          celebration_id: row.celebration_id,
          kind: row.kind as CelebrationKind,
          username: row.username,
          avatarUrl: row.avatar_url,
          elo: row.elo,
          hole: row.hole_num,
          score: row.score,
          par: row.par,
          themePreview,
          themeTitle,
        });
      }
      if (addedAny) {
        queueSeenPersist();
        tryFireCelebration();
      }
    } catch { /* polling is best-effort */ }
  }, [id, selectingCourse, isTeamMatch, tryFireCelebration, queueSeenPersist]);

  // Expose the latest fetcher to the progress upload callback above. Using
  // a ref instead of a closure dependency avoids re-creating the progress
  // useEffect every time fetchCelebrations changes.
  useEffect(() => { fetchCelebrationsRef.current = fetchCelebrations; }, [fetchCelebrations]);

  // Steady-state polling. 8s cadence — slow enough not to hammer the API,
  // fast enough that an opponent's birdie pops within ~10s of them tapping.
  useEffect(() => {
    if (selectingCourse) return;
    fetchCelebrations();
    const t = setInterval(fetchCelebrations, 8_000);
    return () => clearInterval(t);
  }, [fetchCelebrations, selectingCourse]);

  // When the local player advances to a new hole, retry firing — events
  // that were queued waiting for the player to reach this hole_num now
  // become eligible. Critical for the async-match case.
  useEffect(() => {
    tryFireCelebration();
  }, [currentHole, tryFireCelebration]);

  // When the active celebration is dismissed, try to fire the next eligible
  // one in the queue — rapid-fire celebrations (two players both birdied)
  // play back-to-back instead of being dropped.
  useEffect(() => {
    if (!celebrationEvent) tryFireCelebration();
  }, [celebrationEvent, tryFireCelebration]);

  const advanceCelebration = useCallback(() => {
    setCelebrationEvent(null);
  }, []);

  // ── Data loading ────────────────────────────────────────────────────────────

  // Cache key for the full match snapshot — separate from SAVE_KEY (which
  // stores the in-progress score draft). Lets a player who opened a match
  // online once resume scoring later even without a signal.
  const MATCH_CACHE_KEY = `match_cache_${id}`;

  /** Apply a loaded match/course/teebox to component state, restoring any
   *  in-progress scoring draft from SAVE_KEY on top. Shared between the
   *  online fetch path and the offline cache-hit path so the resume UX
   *  is identical either way. */
  const applyMatchData = useCallback(async (
    m: any,
    courseDetails: Course,
    tb: Teebox,
  ) => {
    const effectiveHoles = (m as any)?.num_holes ?? numHoles;
    if (effectiveHoles !== numHoles) setNumHoles(effectiveHoles);
    const matchSubset = (m as any)?.holes_subset as ('front' | 'back' | 'full' | undefined);
    const effSubset: 'front' | 'back' | 'full' = matchSubset ?? holesSubset ?? 'full';
    if (effSubset !== holesSubset) setHolesSubset(effSubset);

    const allSorted = [...(tb.holes ?? [])].sort((a, b) => a.hole_num - b.hole_num);
    const offset = effSubset === 'back' ? 9 : 0;
    const sorted = allSorted.slice(offset, offset + effectiveHoles);

    // Restore any saved in-progress draft on top of the fresh par defaults.
    let saved: { scores?: number[]; currentHole?: number; teeboxId?: string; courseId?: string; holeStats?: HoleStat[] } | null = null;
    try {
      const raw = await AsyncStorage.getItem(SAVE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { /* ignore */ }

    setMatch(m);
    setCourse(courseDetails);
    setTeebox(tb);
    setHoles(sorted);
    setScores(saved?.scores ?? sorted.map((h) => h.par));
    setHoleStats(
      saved?.holeStats && Array.isArray(saved.holeStats)
        ? saved.holeStats
        : sorted.map(() => ({}))
    );
    setCurrentHole(saved?.currentHole ?? 0);
    setSelectingCourse(false);
  }, [SAVE_KEY, numHoles, holesSubset]);

  const load = useCallback(async () => {
    try {
      const m = await api.matches.get(id);

      // Resolve which course/teebox to load — only look at THIS user's player row,
      // because every player in a match can pick their own course/teebox.
      const myPlayer = m.players?.find((p: any) => p.user_id === user?.user_id);
      let courseIdToLoad = myPlayer?.course_id;
      let teeboxIdToLoad = myPlayer?.teebox_id;
      // Falls back to locally-saved choice if I haven't picked yet (challenge
      // matches don't persist teebox to match_players until scores submit).
      if (!courseIdToLoad || !teeboxIdToLoad) {
        try {
          const raw = await AsyncStorage.getItem(SAVE_KEY);
          if (raw) {
            const s = JSON.parse(raw);
            courseIdToLoad = courseIdToLoad ?? s.courseId;
            teeboxIdToLoad = teeboxIdToLoad ?? s.teeboxId;
          }
        } catch { /* ignore */ }
      }

      if (courseIdToLoad && teeboxIdToLoad) {
        const courseDetails: Course = await api.courses.get(courseIdToLoad);
        const tb: Teebox | undefined = courseDetails.teeboxes?.find(
          (t) => t.teebox_id === teeboxIdToLoad
        );
        if (tb && tb.holes?.length > 0) {
          await applyMatchData(m, courseDetails, tb);
          // Snapshot the resolved state so a future offline cold-start can
          // resume scoring without ever talking to the server.
          AsyncStorage.setItem(MATCH_CACHE_KEY, JSON.stringify({
            match: m, course: courseDetails, teebox: tb,
            cachedAt: Date.now(),
          })).catch(() => { });
          // Notify friends a round has started (idempotent — backend only fires once)
          api.matches.started(id).catch(() => { });
          // Hydrate any previously-saved shot tracks. The hook handles
          // legacy-format conversion (flat point arrays → segment pairs).
          api.matches.listShotTracks(id, user?.user_id)
            .then((rows) => tracking.hydrate(rows))
            .catch(() => { });
        }
      } else {
        // No course chosen yet — the existing course-picker flow handles it.
        setMatch(m);
      }
    } catch (e: any) {
      // Offline cold-start: pull the last cached match snapshot from disk
      // and let the player keep scoring. ShotTracking hydrates from its own
      // local cache via the hook's mount effect, score draft from SAVE_KEY.
      // Submit-on-offline pushes to the outbox (already wired). The whole
      // round can be played + finalised without service.
      if (e instanceof OfflineError) {
        try {
          const raw = await AsyncStorage.getItem(MATCH_CACHE_KEY);
          if (raw) {
            const cached = JSON.parse(raw);
            if (cached?.match && cached?.course && cached?.teebox) {
              await applyMatchData(cached.match, cached.course, cached.teebox);
            }
          }
        } catch { /* nothing to fall back to — selectingCourse stays true */ }
      } else if (e instanceof NotAuthenticatedError) {
        // This load effect re-fires when auth state flips (it depends on
        // user?.user_id). On logout / token-invalidation the re-fire hits
        // the API with no token — swallow it; the app is already heading to
        // the login screen and an "Error: Not signed in" popup is just noise.
      } else {
        Alert.alert('Error', e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [id, user?.user_id]);

  useEffect(() => { load(); }, [load]);

  // Nearby courses for the course selection step
  useEffect(() => {
    if (!selectingCourse) return;
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const results = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearbyCourses(results);
      } catch { /* silent */ } finally {
        setLoadingNearby(false);
      }
    })();
  }, [selectingCourse]);

  // Location tracking handled by useLocation hook (declared above).

  // Follow user on map
  useEffect(() => {
    if (following && onCourse && userCoord && mapRef.current) {
      mapRef.current.animateToRegion(
        { latitude: userCoord.latitude, longitude: userCoord.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 },
        400,
      );
    }
  }, [userCoord, following, onCourse]);

  // ── Course selection helpers ─────────────────────────────────────────────────

  const searchCourses = useCallback(async (q: string) => {
    setCourseQuery(q);
    if (q.length < 2) { setCourseResults([]); return; }
    setCourseSearching(true);
    try {
      const results = await api.courses.search(q);
      setCourseResults(results);
    } finally { setCourseSearching(false); }
  }, []);

  const selectTeebox = (t: Teebox, c: Course) => {
    // Each player chooses their own teebox AND round length.
    // diff18() on the backend normalises 9-hole rounds to 18-hole equivalents
    // so different teeboxes (and different hole counts) compare fairly.
    const want = chosenRoundHoles ?? 18;
    const teeboxHoleCount = (t.holes ?? []).length;
    // "Play 9 holes twice for 18": if the user asked for 18 but the teebox
    // only has 9 holes, duplicate the front 9 to fill a full 18-card. The
    // duplicated holes get hole_num 10–18 (offset by 9) so per-hole stats,
    // scorecards, and shot-tracking keys don't collide between the first
    // and second pass.
    const isDoubleUp = want === 18 && teeboxHoleCount === 9;
    const playableHoles = isDoubleUp ? 18 : Math.min(t.num_holes, want, teeboxHoleCount);
    const baseHoles = [...(t.holes ?? [])].sort((a, b) => a.hole_num - b.hole_num);
    const h = isDoubleUp
      ? [
          ...baseHoles.slice(0, 9),
          ...baseHoles.slice(0, 9).map((hole) => ({
            ...hole,
            // hole_num continues 10..18 for the second pass so the scorecard
            // grid and downstream keys (shot-tracking, hole_stats) are unique.
            hole_num: hole.hole_num + 9,
          })),
        ]
      : baseHoles.slice(0, playableHoles);
    if (h.length === 0) {
      Alert.alert(
        'No Hole Data',
        'This tee box doesn\'t have hole-by-hole data. Try a different tee or course.',
      );
      return;
    }
    setNumHoles(playableHoles);
    setTeebox(t);
    setCourse(c);
    setHoles(h);
    setScores(h.map((hole) => hole.par));
    setHoleStats(h.map(() => ({})));
    setSelectingCourse(false);
    setCurrentHole(0);
    // Notify friends a round has started (idempotent — backend only fires once)
    api.matches.started(id).catch(() => { });
  };

  // ── Shot tracking ───────────────────────────────────────────────────────────

  const currentHoleNum = holes[currentHole]?.hole_num;

  /** Compute a *normalized* (neutral-conditions) yardage for a finalised shot.
   *  Stored alongside the shot so per-club stats reflect the player's true
   *  club capability rather than what happened to land under that day's wind
   *  / slope / temperature.
   *
   *  Convention (see weatherAdjust.ts):
   *    adjustDistance(base, w).plays_like_yds  ≈  base + bonusFromConditions
   *  We have the GPS-measured distance (what actually landed) and need the
   *  neutral-capability x such that x + bonus ≈ GPS. Linearising:
   *    normalized = 2*GPS − plays_like_weather(GPS) + slope_yds
   *  where slope_yds is positive for uphill (an uphill GPS shot implies a
   *  longer-capable swing) and negative for downhill. */
  const computePlaysLike = (start: Pt, end: Pt): number | null => {
    if (!weather || weather.temperature_f == null) return null;
    const gpsYds = distYards(start.lat, start.lng, end.lat, end.lng);
    if (gpsYds < 5 || gpsYds > 500) return null;   // skip GPS noise / putts

    // Slope: elevation gain (m) converted to yards. Uphill = positive.
    //
    // Prefer the barometric delta when both points have one — CMAltimeter's
    // relativeAltitude is sub-meter on the timescale of one shot (10s-30s
    // between TRACK start and TRACK end), where GPS altitude is ±10m and
    // genuinely useless for plays-like. Fall back to GPS altitude only when
    // the barometer isn't supported (simulator, very old iPhones).
    const baroDeltaM =
      typeof start.baro_relative_m === 'number' && typeof end.baro_relative_m === 'number'
        ? end.baro_relative_m - start.baro_relative_m
        : null;
    const gpsDeltaM =
      typeof start.elevation_m === 'number' && typeof end.elevation_m === 'number'
        ? end.elevation_m - start.elevation_m
        : null;
    const slopeM = baroDeltaM ?? gpsDeltaM ?? 0;
    const slopeYds = slopeM * 1.0936;

    // Wind along the shot line (start → end bearing).
    let along = 0;
    if (weather.wind_speed_mph && weather.wind_from_bearing != null) {
      const shotBearingDeg = bearingDeg(start.lat, start.lng, end.lat, end.lng);
      along = windComponents(weather.wind_speed_mph, weather.wind_from_bearing, shotBearingDeg).along_mph;
    }

    // Altitude effect is relative to the player's calibration baseline
    // (home course elevation) when one is known.
    const courseAltFt = weather.elevation_ft
      ?? (typeof userCoord?.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);
    const altDeltaFt = homeElevationFt != null ? courseAltFt - homeElevationFt : courseAltFt;

    const adj = adjustDistance(gpsYds, {
      altitudeFt:   altDeltaFt,
      temperatureF: weather.temperature_f,
      windAlongMph: along,
      rain:         weather.rain,
    });
    // Invert weather bonus, add slope bonus (uphill swing capability > GPS).
    const normalized = 2 * gpsYds - adj.plays_like_yds + slopeYds;
    if (normalized <= 0 || normalized > 1000) return null;
    return normalized;
  };

  // ── Per-hole aim point (draggable heatmap target) ──────────────────────
  // When the player wants to play (say) the left side of the fairway, they
  // drop / drag the on-map heatmap crosshair to their target. The heatmap
  // re-projects around that aim, and the snapshot is persisted on each
  // shot so downstream lateral stats compare against THEIR centerline, not
  // the fairway center. Cleared automatically when the player advances to
  // the next hole (each hole has its own aim).
  const [aimByHole, setAimByHole] = useState<Record<number, { lat: number; lng: number }>>({});
  const aimRef = useRef(aimByHole);
  aimRef.current = aimByHole;
  const aimForCurrentHole: { lat: number; lng: number } | null =
    currentHoleNum != null ? (aimByHole[currentHoleNum] ?? null) : null;
  // Live heatmap drag. The draggable dot fires `onDrag` continuously while the
  // finger slides (press-and-hold the dot, then move — no lift needed); we
  // commit the new aim on each tick so the dispersion rings re-point in real
  // time instead of only snapping when you release. State writes are throttled
  // (~30ms) so a 60fps native drag doesn't flood React with re-renders and
  // stutter — the native marker still follows the finger at full frame rate;
  // only the polygon recompute is rate-limited. `force` bypasses the throttle
  // for the final placement on drag-end.
  const lastAimDragRef = useRef(0);
  const commitAim = useCallback((lat: number, lng: number, force = false) => {
    if (currentHoleNum == null) return;
    const now = Date.now();
    if (!force && now - lastAimDragRef.current < 30) return;
    lastAimDragRef.current = now;
    setAimByHole((prev) => ({ ...prev, [currentHoleNum]: { lat, lng } }));
  }, [currentHoleNum]);
  const knownPinRef = useRef<{ lat: number; lng: number } | null>(null);

  const tracking = useShotTracking({
    matchId: id, userId: user?.user_id, userCoord, currentHoleNum, computePlaysLike,
    getAveragedFix, getRelativeAltitudeM,
    getAimPoint: () => (currentHoleNum != null ? aimRef.current[currentHoleNum] ?? null : null),
    // Pin fallback for the lateral_yds centerline. Read off a ref so the
    // hook gets the current hole's pin without needing the calling
    // component to memoize the callback.
    getPinPoint: () => knownPinRef.current,
  });
  const {
    shotsByHole, currentShots, activeShot, pendingClub, clubPickerVisible,
    setClubPickerVisible, pickClubManual, pickClubAuto, isManualPick,
    onTrackPress, onTrackLongPress, cancelActiveShot,
  } = tracking;

  // ── Capture barometric anchor on FIRST track press of the round ────────
  // When activeShot transitions from null → not-null for the first time in
  // this scoring screen's lifetime, the player is at the tee box. Capture
  // the (gpsAlt, baro) pair so subsequent elevation samples + slope
  // readings can use sub-meter baro deltas instead of noisy GPS altitude.
  // The refs persist across re-renders — never re-captured this round.
  useEffect(() => {
    if (!activeShot) return;
    if (baroAnchorMRef.current != null) return;     // already anchored
    if (!userCoord || typeof userCoord.altitude !== 'number') return;
    const baroNow = getRelativeAltitudeM();
    if (typeof baroNow !== 'number') return;        // no barometer support
    baroAnchorMRef.current = baroNow;
    gpsAltAnchorMRef.current = userCoord.altitude;
  }, [activeShot, userCoord, getRelativeAltitudeM]);

  // ── Past shots at this hole — premium ghost-shot overlay ──────────────
  // Pulls every tracked shot this user has landed on the current course +
  // hole in prior rounds. Only refetches when the hole or course changes.
  useEffect(() => {
    if (!userIsPremium) { setPastHoleShots([]); return; }
    if (!user || !course || currentHoleNum == null) return;
    let cancelled = false;
    api.users.holeShots(user.user_id, course.course_id, currentHoleNum, id)
      .then((d) => {
        if (cancelled) return;
        // Normalise both segment and legacy point formats into segment shape.
        const normalized: PastRoundShots[] = d.rounds.map((r) => {
          const raw = (r.shots as any[]) ?? [];
          let segs: Shot[] = [];
          if (raw.length === 0) {
            segs = [];
          } else if (raw[0]?.start && raw[0]?.end) {
            segs = raw as Shot[];
          } else {
            for (let i = 0; i < raw.length - 1; i++) {
              segs.push({
                club: raw[i]?.club ?? 'unknown',
                start: { lat: raw[i].lat, lng: raw[i].lng },
                end:   { lat: raw[i + 1].lat, lng: raw[i + 1].lng },
              });
            }
          }
          return { match_id: r.match_id, created_at: r.created_at, shots: segs };
        }).filter((r) => r.shots.length > 0);
        setPastHoleShots(normalized);
      })
      .catch(() => { /* silent — overlay just stays empty */ });
    return () => { cancelled = true; };
  }, [userIsPremium, user?.user_id, course?.course_id, currentHoleNum, id]);

  // ── Past-shots fetch ──────────────────────────────────────────────────
  // When the player switches holes (and they're premium), fetch their shot
  // history for the new hole. Cached per session so revisiting a hole later
  // in the round doesn't re-hit the API.
  useEffect(() => {
    if (!userIsPremium || !user || !course || currentHoleNum == null) return;
    if (pastShotsByHole[currentHoleNum] !== undefined) return; // already loaded
    let cancelled = false;
    api.users.holeShots(user.user_id, course.course_id, currentHoleNum, id)
      .then((d) => {
        if (cancelled) return;
        setPastShotsByHole((prev) => ({ ...prev, [currentHoleNum]: d.rounds ?? [] }));
      })
      .catch(() => {
        if (cancelled) return;
        // Cache the empty result so we don't keep retrying
        setPastShotsByHole((prev) => ({ ...prev, [currentHoleNum]: [] }));
      });
    return () => { cancelled = true; };
  }, [userIsPremium, user?.user_id, course?.course_id, currentHoleNum, id]);

  // ── Per-club stats fetch ───────────────────────────────────────────────
  // Premium-only consumer (suggest + heatmap), but we always fetch since the
  // free user could upgrade mid-round and we want the data ready.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.users.clubStats(user.user_id)
      .then((d) => { if (!cancelled) setClubStats(d.clubs); })
      .catch(() => { /* non-fatal — overlay & suggest just stay disabled */ });
    return () => { cancelled = true; };
  }, [user?.user_id]);

  // ── Home-course elevation baseline ─────────────────────────────────────
  // One-time fetch when we know the user's home course coordinates. Reused
  // by the altitude adjustment so distances are calibrated relative to where
  // the player typically plays. Premium-only since it's only consumed by
  // the plays-like math, which is itself premium.
  useEffect(() => {
    if (!userIsPremium) return;
    const homeLat = (user as any)?.home_course_lat;
    const homeLng = (user as any)?.home_course_lng;
    if (typeof homeLat !== 'number' || typeof homeLng !== 'number') return;
    let cancelled = false;
    api.weather.current(homeLat, homeLng)
      .then((d) => { if (!cancelled && d.elevation_ft != null) setHomeElevationFt(d.elevation_ft); })
      .catch(() => { /* non-fatal — falls back to absolute altitude */ });
    return () => { cancelled = true; };
  }, [userIsPremium, (user as any)?.home_course_lat, (user as any)?.home_course_lng]);

  // ── DEM elevation for an arbitrary tapped point (measure tool) ─────────
  useEffect(() => {
    if (!measurePin) { setMeasureElevationM(null); return; }
    const k = `${measurePin.latitude.toFixed(5)},${measurePin.longitude.toFixed(5)}`;
    const cached = elevCacheRef.current.get(k);
    if (cached != null) { setMeasureElevationM(cached); return; }
    let cancelled = false;
    api.weather.elevation(measurePin.latitude, measurePin.longitude)
      .then((d) => {
        if (cancelled) return;
        elevCacheRef.current.set(k, d.elevation_m);
        setMeasureElevationM(d.elevation_m);
      })
      .catch(() => { /* slope on measure stays disabled this tap */ });
    return () => { cancelled = true; };
  }, [measurePin?.latitude, measurePin?.longitude]);

  // ── Precise player elevation (DEM-sourced) ─────────────────────────────
  // Fetches every time the player moves >5m horizontally. Hits the
  // high-resolution elevation endpoint (USGS 3DEP for US courses, Copernicus
  // DEM elsewhere). This is the foundation of accurate slope.
  useEffect(() => {
    if (!userCoord) return;
    const last = lastElevFetchCoord.current;
    if (last) {
      const moved = distMetres(last.lat, last.lng, userCoord.latitude, userCoord.longitude);
      if (moved < 5) return;
    }
    lastElevFetchCoord.current = { lat: userCoord.latitude, lng: userCoord.longitude };
    // Fine-grid cache key — matches server-side rounding.
    const k = `${userCoord.latitude.toFixed(5)},${userCoord.longitude.toFixed(5)}`;
    const cached = elevCacheRef.current.get(k);
    if (cached != null) { setPlayerElevationM(cached); return; }
    let cancelled = false;
    api.weather.elevation(userCoord.latitude, userCoord.longitude)
      .then((d) => {
        if (cancelled) return;
        elevCacheRef.current.set(k, d.elevation_m);
        setPlayerElevationM(d.elevation_m);
      })
      .catch(() => { /* slope just won't update this tick — non-fatal */ });
    return () => { cancelled = true; };
  }, [userCoord?.latitude, userCoord?.longitude]);

  // ── Relative-elevation: establish per-round offset ─────────────────────
  // Run once when we first have a fix at a known course. Aligns the
  // device's barometer/altimeter to the course's origin = 0m frame so
  // every later sample is a meaningful delta. Re-fires only if we lost
  // and re-acquired a fix (offset becomes null only on hard reset).
  useEffect(() => {
    if (elevOffsetM != null) return;
    if (!course?.course_id || !userCoord) return;
    if (typeof userCoord.altitude !== 'number') return;
    let cancelled = false;
    api.courses.elevationReference(course.course_id, {
      lat: userCoord.latitude,
      lng: userCoord.longitude,
      deviceAltM: userCoord.altitude,
    })
      .then((res) => {
        if (cancelled) return;
        setElevOffsetM(res.offsetM);
        setElevOffsetMode(res.mode);
      })
      .catch(() => { /* slope falls back to DEM path — non-fatal */ });
    return () => { cancelled = true; };
  }, [course?.course_id, userCoord?.altitude != null, elevOffsetM != null]);

  // ── Data-quality warning popup ─────────────────────────────────────────
  // Fired once per scoring-screen mount when the course is underdocumented.
  // Tells the player slope / distances may be off, and dangles the Lucky
  // Round perk so contributing pins + tracking shots feels worth the tap.
  // Skipped on practice rounds (no perk possible there).
  useEffect(() => {
    if (selectingCourse) return;
    if (!course?.course_id) return;
    // Wait for the match to load before deciding — we need to know whether
    // it's a practice round (drives the perk text below) and we don't want
    // to fire the once-per-mount warning against a half-loaded match.
    if (!match) return;
    if (dataQualityShownRef.current) return;
    dataQualityShownRef.current = true;
    api.courses.dataQuality(course.course_id)
      .then((dq) => {
        // Stash the elevation-coverage flag so the sample effect can
        // skip uploading new points when the course is already well
        // mapped — saves battery on every subsequent round at this
        // course. Inverted: low_elevation=false → wellMapped=true.
        setElevationWellMapped(dq.low_elevation === false);
        if (!dq.low_data) return;
        const lines: string[] = [];
        if (dq.low_pins) {
          const pct = Math.round(dq.pin_coverage * 100);
          lines.push(`Pin locations: ${dq.holes_with_pins}/${dq.total_holes} holes mapped${dq.total_holes ? ` (${pct}%)` : ''}.`);
        }
        if (dq.low_elevation) {
          lines.push(`Elevation: only ${dq.elevation_points} reference point${dq.elevation_points === 1 ? '' : 's'} on file.`);
        }
        lines.push('');
        lines.push('Distances and slope may be less accurate until more rounds are played here. Mark the pin on each green (tap the flag) to map it for everyone.');
        // The Lucky Round perk only exists on ranked matches, so only dangle
        // it there. Practice rounds still get the accuracy warning above —
        // it's about distance reliability, which matters regardless of mode.
        if (!match.is_practice) {
          lines.push('');
          lines.push('Earn a LUCKY ROUND perk this match by:');
          lines.push('  • Marking the pin location on most holes you play');
          lines.push('  • OR tagging shots on most holes you play');
          lines.push('');
          lines.push('Lucky Round = next ranked match doubles a win OR cancels a loss.');
        }
        Alert.alert(
          'Course needs more data',
          lines.join('\n'),
          [{ text: 'Got it' }],
          { cancelable: true }
        );
      })
      .catch(() => { /* non-fatal */ });
  }, [selectingCourse, course?.course_id, match]);

  // ── Relative-elevation: collect samples + batch flush ──────────────────
  // Buffers each watchPositionAsync fix (skip repeats within ~3m horizontal).
  // Every 15s of activity the buffer flushes to the server, where points
  // get bucketed and averaged into the course's shared elevation map.
  //
  // ALTITUDE SOURCE — two paths, in order of preference:
  //   1. PREFERRED: baro-delta. Once the player has tapped TRACK on their
  //      first shot (= they're at the tee), we capture (gpsAlt, baro) as
  //      anchors. Subsequent samples use:
  //          effectiveAlt = gpsAltAnchor + (currentBaro - baroAnchor)
  //      The delta is sub-meter accurate from CMAltimeter; the anchor's
  //      GPS noise averages out across many rounds in the shared grid.
  //   2. FALLBACK: raw GPS altitude. Used until the anchor is captured
  //      (pre-first-shot wandering) or on devices without a barometer.
  useEffect(() => {
    if (!course?.course_id || elevOffsetM == null || !userCoord) return;
    if (typeof userCoord.altitude !== 'number') return;
    // BATTERY GATE: skip the whole sampling loop when the server has
    // told us this course already has solid elevation coverage. The
    // map won't get materially better from another set of contributions
    // and we'd be paying barometer + GPS + radio cost for nothing. Falls
    // through to sampling when the flag is null (data-quality call
    // hasn't returned yet, or failed) or true-low (course needs data).
    if (elevationWellMapped === true) return;
    // Throttle by movement so a stationary phone doesn't spam-overwrite the
    // same grid cell with hundreds of identical samples.
    const last = lastElevSampleAtRef.current;
    if (last && distMetres(last.lat, last.lng, userCoord.latitude, userCoord.longitude) < 3) return;
    lastElevSampleAtRef.current = { lat: userCoord.latitude, lng: userCoord.longitude };

    // Compute the sample's altitude. Baro-delta preferred when the anchor
    // is set + a fresh baro reading is available — sub-meter precision.
    const baroNow = getRelativeAltitudeM();
    const haveBaroPath =
      baroAnchorMRef.current != null
      && gpsAltAnchorMRef.current != null
      && typeof baroNow === 'number';
    const effectiveAlt = haveBaroPath
      ? gpsAltAnchorMRef.current! + (baroNow! - baroAnchorMRef.current!)
      : userCoord.altitude;

    elevSampleBuf.current.push({
      lat: userCoord.latitude,
      lng: userCoord.longitude,
      elevationRelM: effectiveAlt - elevOffsetM,
    });

    if (!elevFlushTimer.current) {
      elevFlushTimer.current = setTimeout(() => {
        const courseId = course?.course_id;
        const batch = elevSampleBuf.current;
        elevSampleBuf.current = [];
        elevFlushTimer.current = null;
        if (batch.length && courseId) {
          api.courses.elevationPoints(courseId, batch).catch(() => { /* silent */ });
        }
      }, 15_000);
    }
    // Cleanup is handled by the flush itself; clearing the timer on unmount
    // would drop the final samples, so we let it fire and the closure's
    // null-checks handle any race.
  }, [course?.course_id, elevOffsetM, userCoord?.latitude, userCoord?.longitude, userCoord?.altitude, getRelativeAltitudeM, elevationWellMapped]);

  // Final flush on unmount so the last few samples aren't lost.
  useEffect(() => {
    return () => {
      const courseId = course?.course_id;
      const batch = elevSampleBuf.current;
      if (batch.length && courseId) {
        api.courses.elevationPoints(courseId, batch).catch(() => { /* silent */ });
      }
      elevSampleBuf.current = [];
      if (elevFlushTimer.current) {
        clearTimeout(elevFlushTimer.current);
        elevFlushTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Weather fetching ───────────────────────────────────────────────────
  // Premium-only — non-premium users get the upgrade prompt instead, so we
  // don't bother hitting the upstream for them. Refreshes every 15 min.
  useEffect(() => {
    if (!userCoord || !userIsPremium) return;
    let cancelled = false;
    const load = () => {
      api.weather.current(userCoord.latitude, userCoord.longitude)
        .then(d => { if (!cancelled) setWeather(d); })
        .catch(() => { /* silent — weather is non-essential */ });
    };
    load();
    const id = setInterval(load, 15 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
    // Only re-key on coarse position change to avoid spamming the upstream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIsPremium,
      userCoord ? Math.round(userCoord.latitude * 100) : null,
      userCoord ? Math.round(userCoord.longitude * 100) : null]);

  // ── Auto-fill hole stats from tracked shots ────────────────────────────
  // Whenever the current hole's shot list changes, derive fairwayHit/Miss,
  // gir/greenMiss, putts, chips from GPS + pin. Only applies to fields the
  // user hasn't manually set (tracked in `manualFields[currentHole]`).
  useEffect(() => {
    if (currentHoleNum == null) return;
    const hole = holes[currentHole];
    if (!hole) return;
    const shots = currentShots;
    if (shots.length === 0) return;
    const inferred = inferHoleStatsFromShots(shots, {
      par: hole.par,
      pin_lat: hole.pin_lat,
      pin_lng: hole.pin_lng,
    });
    if (Object.keys(inferred).length === 0) return;

    const manual = manualFields[currentHole] ?? new Set<string>();
    setHoleStats((prev) => {
      const next = [...prev];
      const cur = next[currentHole] ?? {};
      const merged: any = { ...cur };
      let changed = false;
      for (const [k, v] of Object.entries(inferred)) {
        if (manual.has(k)) continue;          // user-owned → don't touch
        if ((merged as any)[k] === v) continue; // already up to date
        merged[k] = v;
        changed = true;
      }
      if (!changed) return prev;
      next[currentHole] = merged;
      return next;
    });
    // currentShots is a new array each render so include only its length / last
    // segment endpoint as deps to avoid infinite loops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentHole, currentShots.length,
    currentShots[currentShots.length - 1]?.end?.lat,
    currentShots[currentShots.length - 1]?.end?.lng,
  ]);

  // Club picking — see hooks/useShotTracking.ts. `pickClubManual` is what
  // the UI calls; `pickClubAuto` is used by the auto-suggest effect below.
  const pickClub = pickClubManual;

  // ── Pin (center of green) — community-contributed location & distance ──────

  // Local override for pins set during this round (so the UI updates immediately
  // even though the holes API response is cached in our state).
  type LocalPin = { lat: number; lng: number; elevation_m?: number | null };
  const [pinByHole, setPinByHole] = useState<Record<string, LocalPin>>({});
  // Count of distinct GPS contributions to each hole's pin position. Used to
  // show users how confident the pin location is and encourage re-marking.
  const [pinSamplesByHole, setPinSamplesByHole] = useState<Record<string, number>>({});
  const currentHoleObj = holes[currentHole];
  const knownPin: LocalPin | null = currentHoleObj
    ? (pinByHole[currentHoleObj.hole_id] ??
       (currentHoleObj.pin_lat != null && currentHoleObj.pin_lng != null
         ? {
             lat: currentHoleObj.pin_lat,
             lng: currentHoleObj.pin_lng,
             elevation_m: currentHoleObj.pin_elevation_m ?? null,
           }
         : null))
    : null;

  const yardsToPin = (knownPin && userCoord)
    ? Math.round(distYards(userCoord.latitude, userCoord.longitude, knownPin.lat, knownPin.lng))
    : null;

  // ── Clear GPS fix buffer when the hole changes ──────────────────────
  // Without this, fixes from the previous hole (recorded yards away)
  // would survive in the buffer and either (a) get discarded silently
  // by the spatial-still filter when the next finalize asks for an
  // averaged fix, leaving zero samples to average from, or (b) bias
  // the next averaged-fix toward the prior hole's location if the new
  // hole started before any fresh fix arrived. Resetting on hole change
  // ensures every shot finalize uses ONLY fixes from this hole.
  useEffect(() => {
    if (currentHoleNum == null) return;
    resetFixBuffer();
  }, [currentHoleNum, resetFixBuffer]);

  // ── GPS staleness tick ──────────────────────────────────────────────
  // Force a re-render every 5s so `gpsStaleSec` stays current even when
  // no GPS fix is arriving (which is exactly the failure mode we need to
  // visualise — without this tick, the screen would happily display a
  // stuck userCoord with no indication that updates have stopped).
  const [, setStaleTick] = useState(0);
  useEffect(() => {
    if (selectingCourse) return;
    const id = setInterval(() => setStaleTick((n) => (n + 1) % 1000), 5000);
    return () => clearInterval(id);
  }, [selectingCourse]);
  const gpsStaleSec = (() => {
    const ms = getMsSinceLastFix();
    if (ms == null) return null;
    return Math.floor(ms / 1000);
  })();
  // Threshold: 15s without a fix in foreground = "frozen" — by then any
  // displayed yardsToPin is reading off a stale userCoord.
  const gpsLooksFrozen = gpsStaleSec != null && gpsStaleSec >= 15;
  // Keep the ref in sync so useShotTracking's lateral_yds fallback reads
  // the right pin on each finalize. Plain assignment in render is fine —
  // refs aren't reactive and we're just shipping the latest value through.
  knownPinRef.current = knownPin ? { lat: knownPin.lat, lng: knownPin.lng } : null;

  // Ghost player — procedurally generated "slightly better" opponent whose
  // path appears faintly on the map for the player to chase. Pure visual,
  // no scoring impact. See hooks/useGhostPlayer.ts.
  const ghost = useGhostPlayer({
    holeId: currentHoleObj?.hole_id ?? null,
    holePar: currentHoleObj?.par ?? null,
    knownPin: knownPin ? { lat: knownPin.lat, lng: knownPin.lng } : null,
    userCoord,
    userHandicap: user?.handicap_index,
  });

  // ── Relative-elevation: pin lookup ─────────────────────────────────────
  // Pulls the cached relative elevation at the current hole's pin, if any
  // contributor has been close enough. Refreshes when the pin changes; null
  // when no point is within 25m of the pin (slope falls back to DEM).
  useEffect(() => {
    if (!course?.course_id || !knownPin) { setPinRelElevM(null); return; }
    let cancelled = false;
    api.courses.elevationAt(course.course_id, knownPin.lat, knownPin.lng, 25)
      .then((res) => { if (!cancelled) setPinRelElevM(res?.elevationRelM ?? null); })
      .catch(() => { if (!cancelled) setPinRelElevM(null); });
    return () => { cancelled = true; };
  }, [course?.course_id, knownPin?.lat, knownPin?.lng]);

  // Slope adjustment: each metre of elevation gain adds ~1.09 yards to the
  // play distance (downhill plays shorter, conversely).
  //
  // BOTH elevations now come from the same DEM-frame source:
  //   • Player: high-resolution DEM at current GPS position (USGS 3DEP for
  //     US, Copernicus elsewhere) — refreshed every 5m of movement.
  //   • Pin: DEM elevation looked up server-side when the pin was last
  //     contributed (see contributePin route).
  // Both are orthometric/sea-level so the difference is meaningful. Expected
  // slope error is ~±5 yds (limited by DEM accuracy, ~2-4m per side). Falls
  // back to GPS altimeter only when DEM lookup hasn't completed yet.
  // Memoised so the result identity is stable across renders — the heatmap
  // ellipse memo lists slopeAdjustment in its dep array, and a fresh object
  // each render would force the heatmap to re-project 120 perimeter points
  // every time the parent re-rendered for any reason.
  const slopeAdjustment = useMemo(() => {
    if (!knownPin || !userCoord || yardsToPin == null) return null;

    // PREFERRED PATH — crowdsourced relative elevation. Both endpoints come
    // from the same per-course origin frame, so phone barometer drift cancels
    // out and we get sub-meter precision regardless of device calibration.
    // Triggers when:
    //   • we've established the player's per-round offset (anchor or seed)
    //   • the pin sits within 25m of a cached contributor point
    //   • the device reported an altitude on the latest fix
    if (
      pinRelElevM != null
      && elevOffsetM != null
      && typeof userCoord.altitude === 'number'
    ) {
      // Effective altitude — uses the baro-delta path when the round's
      // anchor is set (player has tapped TRACK on their first shot).
      // Without the anchor we fall back to raw GPS altitude (±10m noise).
      const baroNow = getRelativeAltitudeM();
      const haveBaroPath =
        baroAnchorMRef.current != null
        && gpsAltAnchorMRef.current != null
        && typeof baroNow === 'number';
      const effectiveAlt = haveBaroPath
        ? gpsAltAnchorMRef.current! + (baroNow! - baroAnchorMRef.current!)
        : userCoord.altitude;
      const userRelM = effectiveAlt - elevOffsetM;
      const elevDiffM = pinRelElevM - userRelM;
      const adj = Math.round(elevDiffM * 1.09);
      // Sub-yard noise floor — even barometer reads jitter slightly.
      if (Math.abs(adj) < 1) return null;
      return { adj, playsLike: yardsToPin + adj, uphill: adj > 0, source: 'relative' as const };
    }

    // FALLBACK — DEM path (USGS 3DEP / Copernicus). Used until the course's
    // relative cache fills in around this player or this pin.
    const pinElevM = knownPin.elevation_m;
    if (typeof pinElevM !== 'number') return null;

    let userElevM: number | null = null;
    let isDem = false;
    if (typeof playerElevationM === 'number') {
      userElevM = playerElevationM;
      isDem = true;
    } else if (typeof userCoord.altitude === 'number') {
      // GPS altimeter fallback while the first DEM lookup is in flight.
      userElevM = userCoord.altitude;
    }
    if (userElevM == null) return null;

    const elevDiffM = pinElevM - userElevM;       // positive = uphill
    const adj = Math.round(elevDiffM * 1.09);     // yards of correction
    // Suppress sub-yard noise on the DEM path (high confidence); tighter
    // threshold on GPS fallback to avoid surfacing pure noise.
    const minSurface = isDem ? 1 : 3;
    if (Math.abs(adj) < minSurface) return null;
    return { adj, playsLike: yardsToPin + adj, uphill: adj > 0, source: isDem ? 'dem' as const : 'gps' as const };
  }, [knownPin, userCoord, yardsToPin, pinRelElevM, elevOffsetM, playerElevationM]);

  // ── Auto-suggest the most likely club from yardsToPin ─────────────────
  // Picks the bag club whose median distance is closest to the current
  // remaining yardage. Putter chosen automatically when very close to the
  // pin. Free for everyone — a default suggestion makes the CLUB chip feel
  // alive even before the player has tracked enough shots to build personal
  // medians. Personal data wins when present; otherwise we fall back to
  // baseline amateur distances per club.
  //
  // DEFAULT_CLUB_YDS: average distance for a typical mid-handicap amateur.
  // Used when the user has no `clubStats` entry for a club yet — the chip
  // still has to suggest *something* on shot 1 of round 1. Personal medians
  // override these the moment the user has tracked even a single shot per
  // club.
  const DEFAULT_CLUB_YDS: Record<string, number> = useMemo(() => ({
    driver: 220, '3w': 200, '5w': 185, '7w': 170, hybrid: 175,
    '2i': 195, '3i': 185, '4i': 170, '5i': 160, '6i': 150,
    '7i': 140, '8i': 130, '9i': 120,
    pw: 110, gw: 90, sw: 70, lw: 55,
  }), []);

  const suggestedClub = useMemo<string | null>(() => {
    // Premium-gated "smart caddie" feature. Everyone is currently flagged
    // premium so this is a no-op in practice; flip the flag at the user
    // level when the paywall ships.
    if (!userIsPremium) return null;
    if (yardsToPin == null) return null;

    // Restrict the suggestion pool to the user's bag (when set). Bag now
    // stores `{code,label?}` entries — extract just the codes for the
    // filter set. Backward-compat: still accepts the legacy `string[]`
    // shape in case a cached user object hasn't refreshed.
    const bag = user?.clubs_in_bag;
    const bagCodes = (Array.isArray(bag) && bag.length > 0)
      ? bag.map((e: any) => typeof e === 'string' ? e : e?.code).filter(Boolean) as string[]
      : null;
    const bagSet = bagCodes ? new Set(bagCodes) : null;
    const inBag = (club: string) => !bagSet || bagSet.has(club);

    if (yardsToPin <= 5 && inBag('putter')) return 'putter';

    // Build a map of club → expected_yds, preferring the player's personal
    // median when we have one, falling back to DEFAULT_CLUB_YDS otherwise.
    // Filtered to the user's bag so an auto-suggest never proposes a club
    // they aren't actually carrying.
    const expectedYds: Record<string, number> = {};
    for (const club of Object.keys(DEFAULT_CLUB_YDS)) {
      if (inBag(club)) expectedYds[club] = DEFAULT_CLUB_YDS[club];
    }
    if (clubStats?.length) {
      for (const c of clubStats) {
        if (c.median_yds > 0 && c.club !== 'putter' && inBag(c.club)) {
          expectedYds[c.club] = c.median_yds;
        }
      }
    }

    let best: { club: string; diff: number } | null = null;
    for (const club of Object.keys(expectedYds)) {
      const yds = expectedYds[club];
      const diff = Math.abs(yds - yardsToPin);
      if (!best || diff < best.diff) best = { club, diff };
    }
    return best?.club ?? null;
  }, [userIsPremium, clubStats, yardsToPin, DEFAULT_CLUB_YDS, user?.clubs_in_bag]);

  // Auto-suggest the most-likely club as the player walks. Takes effect
  // whenever the user hasn't manually picked one (pickClubAuto respects
  // manualPickRef inside the hook). Premium-gated via suggestedClub.
  useEffect(() => {
    if (!userIsPremium) return;
    if (activeShot) return;
    if (!suggestedClub) return;
    pickClubAuto(suggestedClub);
    // pickClubAuto is stable from the hook; suggestedClub re-runs the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIsPremium, activeShot, suggestedClub]);

  // ── Past shots near my current spot ───────────────────────────────────
  // Pulls past rounds at this hole and keeps only the segments whose START
  // was within ~20m of where the player is right now. Lets them see "last
  // time I was here, the ball ended up over there" — useful for picking
  // a target line based on what's actually worked before.
  type PastSeg = { start: { lat: number; lng: number }; end: { lat: number; lng: number }; club?: string; match_id: string; created_at: string };
  const NEARBY_RADIUS_M = 20;
  const nearbyPastShots = useMemo<PastSeg[]>(() => {
    if (!userIsPremium || !userCoord || currentHoleNum == null) return [];
    const rounds = pastShotsByHole[currentHoleNum];
    if (!rounds?.length) return [];
    const here = { lat: userCoord.latitude, lng: userCoord.longitude };
    const out: PastSeg[] = [];
    for (const round of rounds) {
      const raw: any[] = Array.isArray(round.shots) ? round.shots : [];
      // Convert legacy point format into segments on the fly.
      const segs: { start: any; end: any; club?: string }[] = [];
      if (raw.length && raw[0]?.start && raw[0]?.end) {
        for (const s of raw) {
          if (s?.start && s?.end) segs.push({ start: s.start, end: s.end, club: s.club });
        }
      } else {
        for (let i = 0; i < raw.length - 1; i++) {
          segs.push({ start: raw[i], end: raw[i + 1], club: raw[i]?.club });
        }
      }
      for (const s of segs) {
        const d = distMetres(here.lat, here.lng, s.start.lat, s.start.lng);
        if (d <= NEARBY_RADIUS_M) {
          out.push({ ...s, match_id: round.match_id, created_at: round.created_at });
        }
      }
    }
    return out;
  }, [
    userIsPremium, currentHoleNum, pastShotsByHole,
    // Re-evaluate when the player's coarse position changes (within ~5m).
    userCoord ? Math.round(userCoord.latitude * 20000) : null,
    userCoord ? Math.round(userCoord.longitude * 20000) : null,
  ]);

  // ── Heatmap overlay: project dispersion of the active/pending club onto
  // the map, anchored at the player's current position with "forward" =
  // bearing toward the known pin. Premium-gated (currently everyone is
  // flagged premium). Requires:
  //   • a known pin (so we have an aim bearing — without it the rotation is
  //     meaningless and we'd just plot a generic blob)
  //   • a club currently selected (active or pending)
  //   • at least one tracked shot for that club (otherwise dispersion is [])
  type LL = { latitude: number; longitude: number };
  /**
   * Confidence ellipses for the active/pending club, projected onto the map.
   *
   * Mirrors the profile-stats heatmap exactly: a 1σ inner ellipse (~68% of
   * shots fall inside) and a 2σ outer ellipse (~95%), tilted by the
   * eigenvectors of the per-club covariance so a hook/fade pattern visibly
   * leans the right way.
   *
   * Anchoring:
   *   • Center at userCoord + (median_yds + meanLong) along player→pin bearing
   *     + meanLat perpendicular. I.e. "where my average shot of this club lands
   *     if I aim at the pin from here." Works on-course AND when testing from
   *     home — the rings appear at median distance in the pin's direction
   *     from wherever the user is.
   *   • The lateral/long frame is rotated by the aim bearing so the ellipses
   *     line up visually with the player→pin vector regardless of compass
   *     orientation on the map.
   */
  const heatmapRings = useMemo<{ sigma1: LL[]; sigma2: LL[]; center: LL } | null>(() => {
    if (!userIsPremium || !userCoord || !clubStats?.length) return null;
    // The heatmap aim target — either the player's manually-dragged aim
    // point for this hole, or the pin if they haven't dragged one. This is
    // the centerline the ellipses point along.
    const aimTarget: { lat: number; lng: number } | null =
      aimForCurrentHole ?? (knownPin ? { lat: knownPin.lat, lng: knownPin.lng } : null);
    if (!aimTarget) return null;
    const club = activeShot?.club ?? pendingClub;
    if (!club) return null;
    const cs = clubStats.find((c) => c.club === club);
    // Need at least 2 shots to define any kind of "dispersion" — a single
    // shot has zero variance and would render as a degenerate ellipse.
    if (!cs?.dispersion || cs.dispersion.length < 2 || !cs.median_yds) return null;

    // Aim bearing (player → target), radians, 0 = N, clockwise. Target is
    // either the manual aim point (when dragged) or the pin.
    const lat1 = userCoord.latitude * Math.PI / 180;
    const lat2 = aimTarget.lat * Math.PI / 180;
    const dLng = (aimTarget.lng - userCoord.longitude) * Math.PI / 180;
    const yB = Math.sin(dLng) * Math.cos(lat2);
    const xB = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const aimBearing = Math.atan2(yB, xB);

    // Mean + covariance of the dispersion data, in the (lateral, long) yds frame.
    const N = cs.dispersion.length;
    const meanLat  = cs.dispersion.reduce((a, d) => a + d.lateral_yds, 0) / N;
    const meanLong = cs.dispersion.reduce((a, d) => a + d.long_yds,    0) / N;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const d of cs.dispersion) {
      const dx = d.lateral_yds - meanLat;
      const dy = d.long_yds    - meanLong;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
    cxx /= N; cyy /= N; cxy /= N;

    // 2×2 symmetric eigen-decomp. λ₁ ≥ λ₂ ≥ 0. Floor λ₂ so a perfectly
    // collinear pair of shots still renders a thin (but visible) minor axis.
    const trace = cxx + cyy;
    const det   = cxx * cyy - cxy * cxy;
    const disc  = Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
    const lambda1 = trace / 2 + disc;
    const lambda2 = Math.max(1, trace / 2 - disc);
    // θ = rotation of the major axis WITHIN the (lateral, long) frame.
    // The lateral axis itself is rotated by aimBearing+π/2 in world space.
    const thetaLocal = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const sigmaMajor = Math.sqrt(lambda1);
    const sigmaMinor = Math.sqrt(Math.max(1, lambda2));

    // Walk forward + lateral from a start coord. Standard great-circle.
    const R = 6371000;
    const YDS_TO_M = 0.9144;
    const project = (start: LL, bearingRad: number, distYds: number): LL => {
      if (distYds === 0) return start;
      const distM = distYds * YDS_TO_M;
      const sLat = start.latitude * Math.PI / 180;
      const sLng = start.longitude * Math.PI / 180;
      const eLat = Math.asin(
        Math.sin(sLat) * Math.cos(distM / R) +
        Math.cos(sLat) * Math.sin(distM / R) * Math.cos(bearingRad)
      );
      const eLng = sLng + Math.atan2(
        Math.sin(bearingRad) * Math.sin(distM / R) * Math.cos(sLat),
        Math.cos(distM / R) - Math.sin(sLat) * Math.sin(eLat)
      );
      return { latitude: eLat * 180 / Math.PI, longitude: eLng * 180 / Math.PI };
    };
    /** Project a (forward, lateral) yards pair from userCoord. */
    const place = (start: LL, forwardYds: number, lateralYds: number): LL => {
      const a = project(start, aimBearing, forwardYds);
      return project(a, aimBearing + Math.PI / 2, lateralYds);
    };

    // Player's neutral-condition mean landing distance forward of tee.
    // `meanLong` is the average forward delta from median across all the
    // dispersion samples — usually ~0 but absorbs any systematic offset.
    const baseForward = cs.median_yds + meanLong;

    // Apply current-condition adjustments to the center of the cluster.
    // The DISPERSION (sigmaMajor/sigmaMinor/theta) is intrinsic to the
    // player's swing — conditions don't change how scattered they are,
    // only WHERE the scatter lands. So we shift the centroid and keep the
    // axes untouched.
    let effectiveForward = baseForward;
    // Effective lateral offset to apply to the ellipse center. Defaults to
    // the (small) per-club systematic bias from the dispersion mean; when
    // the player drags the aim manually we zero this out and pin the
    // center to the aim coordinate instead.
    let effectiveLateral = meanLat;

    // ── Weather: wind / temperature / altitude / rain ─────────────────
    // Same conditions object the pin-distance plays-like uses; just
    // applied to baseForward as the carry base. plays_like_yds gives the
    // raw landing distance under conditions, before terrain interception.
    if (weather && weather.temperature_f != null) {
      let along = 0;
      if (weather.wind_speed_mph && weather.wind_from_bearing != null) {
        const shotBearingDeg = (aimBearing * 180 / Math.PI + 360) % 360;
        along = windComponents(
          weather.wind_speed_mph,
          weather.wind_from_bearing,
          shotBearingDeg,
        ).along_mph;
      }
      const courseAltFt = weather.elevation_ft
        ?? (typeof userCoord.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);
      const altDeltaFt = homeElevationFt != null ? courseAltFt - homeElevationFt : courseAltFt;
      const adj = adjustDistance(baseForward, {
        altitudeFt:   altDeltaFt,
        temperatureF: weather.temperature_f,
        windAlongMph: along,
        rain:         weather.rain,
      });
      effectiveForward = adj.plays_like_yds;
    }

    // ── Slope: ground interception alters where the ball lands ─────────
    // slopeAdjustment.adj is the yard correction over the FULL pin
    // distance (positive = uphill = swing needs more club). Pro-rate to
    // the heatmap's actual landing distance, then subtract — a ball hit
    // with neutral capability lands `slopeAtLanding` yards SHORT when
    // uphill (the ground intercepts it earlier), LONG when downhill.
    if (slopeAdjustment && yardsToPin && yardsToPin > 0) {
      const slopeAtLanding = slopeAdjustment.adj * (baseForward / yardsToPin);
      effectiveForward -= slopeAtLanding;
    }

    const start: LL = { latitude: userCoord.latitude, longitude: userCoord.longitude };
    // When the user manually places an aim, we use that point's BEARING
    // (already captured into `aimBearing` above) but keep `effectiveForward`
    // pinned to the club's condition-adjusted carry. The semantic is "I'm
    // aiming this direction for THIS club" — the heatmap rotates around
    // the player at the club's natural distance, it does NOT stretch out
    // to wherever the user tapped. That's exactly the case for someone
    // laying up or aiming at the left side of a green: same club, same
    // expected distance, different line. Lateral offset is zeroed so the
    // ellipse sits squarely on the new aim line.
    if (aimForCurrentHole) {
      effectiveLateral = 0;
    }
    const center: LL = place(start, effectiveForward, effectiveLateral);

    // Sample 60 points around each σ ellipse perimeter. In the (lateral,
    // long) frame relative to the ELLIPSE CENTER:
    //   local_lat  = mult * sigmaMajor * cos(t) * cos(thetaLocal)
    //              - mult * sigmaMinor * sin(t) * sin(thetaLocal)
    //   local_long = mult * sigmaMajor * cos(t) * sin(thetaLocal)
    //              + mult * sigmaMinor * sin(t) * cos(thetaLocal)
    // i.e. parametric ellipse in local frame rotated by thetaLocal.
    const STEPS = 60;
    const buildRing = (mult: number): LL[] => {
      const out: LL[] = [];
      for (let i = 0; i < STEPS; i++) {
        const t = (i / STEPS) * Math.PI * 2;
        const lx = mult * sigmaMajor * Math.cos(t);
        const ly = mult * sigmaMinor * Math.sin(t);
        const rotLat  = lx * Math.cos(thetaLocal) - ly * Math.sin(thetaLocal);
        const rotLong = lx * Math.sin(thetaLocal) + ly * Math.cos(thetaLocal);
        // Project from ELLIPSE CENTER (effectiveForward, effectiveLateral),
        // not from start, so the perimeter follows the (possibly manually
        // aimed) center.
        out.push(place(start, effectiveForward + rotLong, effectiveLateral + rotLat));
      }
      return out;
    };
    return { sigma1: buildRing(1), sigma2: buildRing(2), center };
  }, [
    userIsPremium, userCoord, knownPin, clubStats, activeShot, pendingClub,
    // Re-roll when conditions change — weather poll, slope DEM lookup, or
    // player elevation calibration. Without these the ellipses would feel
    // stale relative to the pin's plays-like banner.
    weather, slopeAdjustment, yardsToPin, homeElevationFt,
    // Re-roll when the player drags the heatmap aim — the center jumps to
    // wherever they dropped the crosshair.
    aimForCurrentHole,
  ]);

  // Weather-adjusted plays-like distance — premium feature. Layers altitude,
  // temperature, wind, and rain on top of the slope-adjusted yardage.
  const weatherAdjustment = (() => {
    if (!userIsPremium || !weather || yardsToPin == null) return null;
    const baseYds = (slopeAdjustment?.playsLike ?? yardsToPin); // start from slope-adjusted
    if (weather.temperature_f == null) return null;             // need the basics

    // Derive shot bearing (player → pin) for wind decomposition.
    let along = 0;
    if (knownPin && userCoord && weather.wind_speed_mph && weather.wind_from_bearing != null) {
      const lat1 = userCoord.latitude * Math.PI / 180;
      const lat2 = knownPin.lat * Math.PI / 180;
      const dLng = (knownPin.lng - userCoord.longitude) * Math.PI / 180;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      const shotBearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      const comps = windComponents(weather.wind_speed_mph, weather.wind_from_bearing, shotBearingDeg);
      along = comps.along_mph;
    }

    // Use measured GPS altitude as a fallback if upstream elevation is missing.
    const courseAltFt = weather.elevation_ft
      ?? (typeof userCoord?.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);

    // Altitude effect is RELATIVE to the player's home course when one is set.
    // A player who calibrates their distances at 5,000 ft will see a negative
    // adjustment when playing at sea level (denser air → less carry than they
    // expect). When no home course is known, falls back to absolute altitude
    // (i.e. sea-level baseline).
    const altDeltaFt = homeElevationFt != null
      ? courseAltFt - homeElevationFt
      : courseAltFt;

    const adj = adjustDistance(baseYds, {
      altitudeFt:   altDeltaFt,
      temperatureF: weather.temperature_f,
      windAlongMph: along,
      rain:         weather.rain,
    });
    // effective = the "club for X yards" number to display alongside the
    // raw yardage. By convention (see weatherAdjust.ts:122), positive
    // effective_delta_yds means conditions REDUCE carry (headwind, cold,
    // sea-level vs altitude home) so we need MORE club — i.e. effective
    // should be HIGHER than base. Negative delta means conditions HELP
    // carry — effective is LOWER than base.
    //
    // Previously this had an extra negation that inverted the direction:
    // a 10mph headwind ended up displaying "plays 135" on a 150 target
    // (suggesting LESS club), which is exactly backwards.
    const effective = Math.round(baseYds + adj.effective_delta_yds);
    if (effective === baseYds) return null;
    return {
      effective, breakdown: adj, windAlong: along,
      altRelative: homeElevationFt != null,
      altDeltaFt,
    };
  })();

  const markPin = () => {
    if (!userCoord || !currentHoleObj) {
      Alert.alert('No GPS', 'Wait for a GPS lock before marking the pin.');
      return;
    }
    // Prefer the inverse-variance weighted average of the last 2.5s of fixes
    // — the user is standing at the pin, so a 2-3 fix average is dramatically
    // tighter than a single sample. Falls back to userCoord if the buffer
    // hasn't filled yet (very first pin contribution of the round).
    const avg = getAveragedFix(2500);
    const lat = avg?.latitude ?? userCoord.latitude;
    const lng = avg?.longitude ?? userCoord.longitude;
    const elevation_m =
      avg && typeof avg.altitude === 'number' ? avg.altitude
      : typeof userCoord.altitude === 'number' ? userCoord.altitude
      : null;
    const point: LocalPin = { lat, lng, elevation_m };
    setPinByHole((prev) => ({ ...prev, [currentHoleObj.hole_id]: point }));
    api.matches.contributePin(id, currentHoleObj.hole_id, point.lat, point.lng, elevation_m)
      .then((res) => {
        if (typeof res?.samples === 'number') {
          setPinSamplesByHole((prev) => ({ ...prev, [currentHoleObj.hole_id]: res.samples }));
        }
      })
      .catch((e: any) => {
        // Offline = queue and KEEP the local pin override so the player can
        // continue using their just-marked pin for distances + heatmap. The
        // outbox will upload the contribution when service returns. Only
        // genuine server errors roll back + alert.
        if (e instanceof OfflineError) {
          queueContributePin({
            matchId: id,
            holeId: currentHoleObj.hole_id,
            lat: point.lat,
            lng: point.lng,
            elevation_m,
          }).catch(() => { });
          return;
        }
        setPinByHole((prev) => {
          const next = { ...prev };
          delete next[currentHoleObj.hole_id];
          return next;
        });
        Alert.alert('Could not save pin', e?.message ?? 'Try again.');
      });
  };

  const pickCourse = async (c: Course) => {
    setLoadingCourse(true);
    try {
      const details = await api.courses.get(c.course_id);
      setFullCourse(details);
    } catch (e: any) { Alert.alert('Error', e.message); } finally { setLoadingCourse(false); }
  };

  // ── Leave / Cancel / Forfeit ────────────────────────────────────────────────

  const saveAndLeave = useCallback(async () => {
    try {
      await AsyncStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          scores,
          holeStats,
          currentHole,
          teeboxId: teebox?.teebox_id,
          courseId: course?.course_id,
        })
      );
    } catch { /* best-effort */ }
    router.back();
  }, [scores, holeStats, currentHole, teebox, course, SAVE_KEY]);

  const doCancel = useCallback(async () => {
    setForfeiting(true);
    try {
      await api.matches.cancel(id);
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      // Also clear the per-match shot cache so a future match with the same
      // id (impossible, but defensive) doesn't resurrect stale shots or a
      // stranded in-progress activeShot.
      try { await AsyncStorage.removeItem(`shots_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`shots_active_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`match_cache_${id}`); } catch { }
      router.replace('/(tabs)/' as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setForfeiting(false);
    }
  }, [id, SAVE_KEY]);

  const doForfeit = useCallback(async () => {
    setForfeiting(true);
    try {
      await api.matches.forfeit(id);
      // Clear any saved progress
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      // Also clear the per-match shot cache so a future match with the same
      // id (impossible, but defensive) doesn't resurrect stale shots or a
      // stranded in-progress activeShot.
      try { await AsyncStorage.removeItem(`shots_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`shots_active_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`match_cache_${id}`); } catch { }
      router.replace(`/match/${id}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setForfeiting(false);
    }
  }, [id, SAVE_KEY]);

  const handleLeave = useCallback(() => {
    // "Cancel" (no ELO) is offered when the user is still in course selection
    // OR has not advanced past hole 0 with no score changes — backend enforces
    // the real rule (no player completed = safe to cancel).
    const noScoringStarted = selectingCourse || currentHole === 0;

    const buttons: any[] = [
      { text: 'Keep Playing', style: 'cancel' },
      { text: 'Save & Leave', onPress: saveAndLeave },
    ];

    if (noScoringStarted) {
      buttons.push({
        text: 'Cancel Match',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Cancel Match?',
            'The match will be deleted. No ELO penalty for anyone.',
            [
              { text: 'Keep Match', style: 'cancel' },
              { text: 'Cancel Match', style: 'destructive', onPress: doCancel },
            ]
          );
        },
      });
    } else {
      buttons.push({
        text: 'Forfeit Match',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Forfeit?',
            'You will take an ELO penalty. This cannot be undone.',
            [
              { text: 'Keep Playing', style: 'cancel' },
              { text: 'Forfeit', style: 'destructive', onPress: doForfeit },
            ]
          );
        },
      });
    }

    Alert.alert('Leave Round', 'What would you like to do?', buttons);
  }, [saveAndLeave, doCancel, doForfeit, selectingCourse, currentHole]);

  // ── Scoring helpers ─────────────────────────────────────────────────────────

  const adjustScore = (delta: number) => {
    // Guard against currentHole drifting out of bounds (e.g. holes were resliced
    // or scoring screen briefly mounts before holes load).
    if (currentHole < 0 || currentHole >= holes.length) return;
    const fallbackPar = holes[currentHole]?.par ?? 4;
    setScores((prev) => {
      const next = [...prev];
      next[currentHole] = Math.max(1, Math.min(20, (next[currentHole] ?? fallbackPar) + delta));
      return next;
    });
  };

  const goToHole = (dir: 1 | -1) => {
    const next = currentHole + dir;
    if (next < 0 || next >= holes.length) return;
    setCurrentHole(next);
    pickClubManual(null);   // each hole picks its own club fresh
    cancelActiveShot();     // discard any in-progress shot
  };

  const jumpToHole = (index: number) => {
    setScorecardVisible(false);
    setCurrentHole(index);
    pickClubManual(null);
    cancelActiveShot();
  };

  const handleSubmit = () => {
    Alert.alert(
      'Submit Scores?',
      `Total: ${scores.reduce((a, b) => a + b, 0)} strokes`
      + `\n\nThis will finalise your round.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Submit', onPress: doSubmit },
      ]
    );
  };

  const doSubmit = async () => {
    setSubmitting(true);
    const submitBody = {
      holeScores: scores,
      holeStats,
      courseId: course?.course_id,
      teeboxId: teebox?.teebox_id,
    };
    try {
      const result = await api.matches.submitScores(id, submitBody);
      // Clear saved progress on successful submit
      try { await AsyncStorage.removeItem(SAVE_KEY); } catch { }
      // Also clear the per-match shot cache so a future match with the same
      // id (impossible, but defensive) doesn't resurrect stale shots or a
      // stranded in-progress activeShot.
      try { await AsyncStorage.removeItem(`shots_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`shots_active_${id}`); } catch { }
      try { await AsyncStorage.removeItem(`match_cache_${id}`); } catch { }
      const perkEarned = result?.result?.perkAwarded === 'lucky_round';
      if (result.result && !result.result.perkAwarded) {
        // Match fully resolved — go straight to the post-match page where
        // the win/loss/draw card is rendered from authoritative server data.
        router.replace(`/match/${id}` as any);
      } else if (result.result && perkEarned) {
        Alert.alert(
          'Lucky Round Earned',
          'You marked the pin on enough holes to earn a Lucky Round perk! It will double your win or prevent a loss on your next ranked match.',
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }]
        );
      } else {
        const msg = perkEarned
          ? 'Round submitted! You also earned a Lucky Round perk for marking the pin on enough holes.'
          : 'Waiting for the other side to finish — check back soon.';
        Alert.alert(
          perkEarned ? 'Lucky Round Earned' : 'Round Submitted',
          msg,
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }]
        );
      }
    } catch (e: any) {
      // Offline = queue for replay rather than lose the round. We keep the
      // local score draft (SAVE_KEY + shot caches) on disk so a relaunch
      // still rehydrates the in-progress state, and the outbox will replay
      // the submit the moment we're back online.
      if (e instanceof OfflineError) {
        try { await queueSubmitScores({ matchId: id, body: submitBody }); } catch { /* disk full → fall through to alert */ }
        Alert.alert(
          'Saved — Will Sync',
          "You're offline. Your scores are saved on this device and will submit automatically the moment you have a connection.",
          [{ text: 'OK', onPress: () => router.replace(`/match/${id}` as any) }],
        );
      } else {
        Alert.alert('Error', e?.message ?? 'Submission failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / course selection ───────────────────────────────────────────────

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  if (selectingCourse) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Select Course</Text>
        <TextInput
          style={styles.searchInput}
          value={courseQuery}
          onChangeText={searchCourses}
          placeholder="Search course or city..."
          placeholderTextColor={C.textMuted}
          autoFocus
        />
        {(courseSearching || loadingCourse) && <ActivityIndicator color={C.gold} style={{ marginTop: 12 }} />}
        <ScrollView style={{ flex: 1 }}>
          {!fullCourse ? (
            courseQuery.length < 2 ? (
              loadingNearby
                ? <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />
                : nearbyCourses.length > 0 && (
                  <>
                    <Text style={styles.nearbyLabel}>Nearby</Text>
                    {nearbyCourses.map((c) => (
                      <TouchableOpacity key={c.course_id} style={styles.courseCard} onPress={() => pickCourse(c)}>
                        <Text style={styles.courseName}>{c.course_name}</Text>
                        <Text style={styles.courseLocation}>{[c.city, c.state].filter(Boolean).join(', ')}</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                )
            ) : courseResults.map((c) => (
              <TouchableOpacity key={c.course_id} style={styles.courseCard} onPress={() => pickCourse(c)}>
                <Text style={styles.courseName}>{c.course_name}</Text>
                <Text style={styles.courseLocation}>{[c.city, c.state].filter(Boolean).join(', ')}</Text>
              </TouchableOpacity>
            ))
          ) : (
            <>
              <Text style={styles.sectionTitle}>{fullCourse.course_name}</Text>
              <Text style={styles.subtitle}>{[fullCourse.city, fullCourse.state].filter(Boolean).join(', ')}</Text>
              <TouchableOpacity
                onPress={() => { setFullCourse(null); setChosenRoundHoles(null); }}
                style={{ marginBottom: 8, paddingHorizontal: 20 }}
              >
                <Text style={{ color: C.gold }}>← Choose different course</Text>
              </TouchableOpacity>

              {/* Step: pick round length (9 or 18) */}
              {chosenRoundHoles == null ? (
                <>
                  <Text style={styles.holesLabel}>How many holes?</Text>
                  <View style={styles.holesRow}>
                    {([9, 18] as const).map((n) => (
                      <TouchableOpacity
                        key={n}
                        style={styles.holesBtn}
                        onPress={() => setChosenRoundHoles(n)}
                      >
                        <Text style={styles.holesBtnText}>{n} Holes</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : (
                <>
                  {/* Step: pick teebox (only those long enough for the chosen length) */}
                  <TouchableOpacity
                    onPress={() => setChosenRoundHoles(null)}
                    style={{ marginBottom: 8, paddingHorizontal: 20 }}
                  >
                    <Text style={{ color: C.gold }}>← Change round length ({chosenRoundHoles})</Text>
                  </TouchableOpacity>
                  {(fullCourse.teeboxes ?? []).filter((t) =>
                    t.num_holes >= chosenRoundHoles || (chosenRoundHoles === 18 && t.num_holes === 9)
                  ).length === 0 && (
                    <Text style={{ color: C.textMuted, paddingHorizontal: 20, marginTop: 12 }}>
                      No tee boxes for {chosenRoundHoles} holes at this course.
                    </Text>
                  )}
                  {(fullCourse.teeboxes ?? []).filter((t) =>
                    t.num_holes >= chosenRoundHoles || (chosenRoundHoles === 18 && t.num_holes === 9)
                  ).map((t) => (
                    <TouchableOpacity
                      key={t.teebox_id}
                      style={[styles.teeboxCard, (t.holes ?? []).length === 0 && styles.teeboxCardDisabled]}
                      onPress={() => selectTeebox(t, fullCourse)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.teeboxName}>{t.name} Tees</Text>
                        <Text style={styles.teeboxMeta}>
                          {t.num_holes} holes · Par {t.par} · {t.total_yards?.toLocaleString()} yds
                          {chosenRoundHoles === 18 && t.num_holes === 9 ? '  ·  plays twice for 18' : ''}
                          {(t.holes ?? []).length === 0 ? '  ·  No hole data' : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.rating}>Rating {t.course_rating}</Text>
                        <Text style={styles.slope}>Slope {t.slope_rating}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  if (holes.length === 0 || !holes[currentHole]) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.gold} /></View>;
  }

  // ── Scoring view ─────────────────────────────────────────────────────────────

  const hole = holes[currentHole];
  const score = scores[currentHole] ?? hole.par;
  const sl = scoreLabel(score, hole.par);
  const totalScore = scores.reduce((a, b) => a + b, 0);
  const totalPar = holes.reduce((a, h) => a + h.par, 0);
  const scoreToPar = totalScore - totalPar;
  const isLastHole = currentHole === holes.length - 1;

  const front = holes.slice(0, 9);
  const back = holes.slice(9);
  const frontParTotal = front.reduce((a, h) => a + h.par, 0);
  const backParTotal = back.reduce((a, h) => a + h.par, 0);
  const frontScoreTotal = front.reduce((a, h, i) => a + (scores[i] ?? h.par), 0);
  const backScoreTotal = back.reduce((a, h, i) => a + (scores[9 + i] ?? h.par), 0);

  const cLat = course?.latitude ?? 0;
  const cLng = course?.longitude ?? 0;
  const initialRegion: Region = {
    latitude: userCoord && onCourse ? userCoord.latitude : (cLat || 37.5),
    longitude: userCoord && onCourse ? userCoord.longitude : (cLng || -100),
    latitudeDelta: 0.004,
    longitudeDelta: 0.004,
  };

  const measureDist = userCoord && measurePin
    ? distYards(userCoord.latitude, userCoord.longitude, measurePin.latitude, measurePin.longitude)
    : null;
  // Distance from the tapped measure pin to the actual hole pin (if we
  // know where the pin is). Lets the player gauge "if I lay up there, how
  // far do I have left in?" in a single tap — common pre-shot question.
  const measureToPin = measurePin && knownPin
    ? distYards(measurePin.latitude, measurePin.longitude, knownPin.lat, knownPin.lng)
    : null;

  const scoreParColor = scoreToPar < 0 ? C.green : scoreToPar > 0 ? C.red : C.text;

  return (
    <View style={styles.container}>
      {/* ── Map (fills screen) ── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation={locGranted}
        showsMyLocationButton={false}
        showsCompass
        mapType="satellite"
        onPress={(e) => {
          // Suppress the single phantom tap that bleeds through from the
          // Clear button overlay. Consume the flag on the very next event so
          // a real tap is never swallowed (see ignoreNextMapTap declaration).
          if (ignoreNextMapTap.current) {
            ignoreNextMapTap.current = false;
            return;
          }
          setMeasurePin(e.nativeEvent.coordinate);
          setFollowing(false);
        }}
        // Long-press anywhere on the map sets / moves the heatmap aim for
        // this hole. The heatmap stays at the club's natural distance and
        // only rotates to point toward the long-pressed spot (see the
        // heatmapRings memo — only the bearing of this point is used). To
        // then fine-tune, the player presses-and-holds the heatmap dot
        // itself and slides it (the Marker is `draggable`); releasing drops
        // it. This replaced the old "MOVE HEATMAP" tap-arm toggle.
        onLongPress={(e) => {
          if (currentHoleNum == null) return;
          const { latitude, longitude } = e.nativeEvent.coordinate;
          setAimByHole((prev) => ({
            ...prev,
            [currentHoleNum]: { lat: latitude, lng: longitude },
          }));
          setFollowing(false);
        }}
        onPanDrag={() => setFollowing(false)}
      >
        {measurePin && (
          <>
            {/* tracksViewChanges={false} avoids the well-known react-native-maps
                bug where iOS Markers can swallow the next map tap when their
                content view re-renders. tappable={false} ensures a tap near
                the existing pin always falls through to MapView.onPress so
                the user can reposition the pin without first clearing it. */}
            <Marker
              coordinate={measurePin}
              anchor={{ x: 0.5, y: 0.5 }}
              tappable={false}
              tracksViewChanges={false}
            >
              <View style={styles.pinOuter}>
                <View style={styles.pinInner} />
              </View>
            </Marker>
            {userCoord && (
              <Polyline
                coordinates={[userCoord, measurePin]}
                strokeColor={C.gold}
                strokeWidth={2}
                lineDashPattern={[6, 4]}
              />
            )}
            {/* Second leg — from the tapped measure pin to the actual hole
                pin, when we know the pin's location. Drawn in a paler tint
                so the player can tell the two legs apart at a glance, and
                labelled with its own yardage at the midpoint. */}
            {knownPin && (
              <>
                <Polyline
                  coordinates={[
                    measurePin,
                    { latitude: knownPin.lat, longitude: knownPin.lng },
                  ]}
                  strokeColor={C.gold + 'aa'}
                  strokeWidth={2}
                  lineDashPattern={[4, 4]}
                />
                {measureToPin != null && (
                  <Marker
                    coordinate={{
                      latitude:  (measurePin.latitude  + knownPin.lat) / 2,
                      longitude: (measurePin.longitude + knownPin.lng) / 2,
                    }}
                    anchor={{ x: 0.5, y: 0.5 }}
                    tappable={false}
                    tracksViewChanges={false}
                  >
                    <View style={styles.measureLegPill}>
                      <Text style={styles.measureLegPillText}>
                        {Math.round(measureToPin)} to pin
                      </Text>
                    </View>
                  </Marker>
                )}
              </>
            )}
          </>
        )}

        {/* Past shots from prior rounds at this hole — faint colored lines
            so they sit visually behind the current round's shots and the
            heatmap. Each prior round gets its own color from the same palette
            so a quick glance can compare different rounds. */}
        {pastHoleShots.flatMap((round, ri) =>
          round.shots.map((shot, si) => {
            const color = SHOT_COLORS[ri % SHOT_COLORS.length];
            return (
              <React.Fragment key={`past-${round.match_id}-${si}`}>
                <Polyline
                  coordinates={[
                    { latitude: shot.start.lat, longitude: shot.start.lng },
                    { latitude: shot.end.lat,   longitude: shot.end.lng },
                  ]}
                  strokeColor={color + '88'}
                  strokeWidth={2}
                  lineDashPattern={[4, 4]}
                />
                <Marker
                  coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  opacity={0.55}
                >
                  <View style={[styles.pastShotDot, { backgroundColor: color }]} />
                </Marker>
              </React.Fragment>
            );
          })
        )}

        {/* Past-shot overlay — your shots from previous rounds where you
            stood within ~20m of your current position. Drawn as faint
            white-ish dashed lines with small endpoint markers, distinct
            from the bright current-round colors. */}
        {nearbyPastShots.map((shot, i) => (
          <React.Fragment key={`past-${shot.match_id}-${i}`}>
            <Polyline
              coordinates={[
                { latitude: shot.start.lat, longitude: shot.start.lng },
                { latitude: shot.end.lat,   longitude: shot.end.lng },
              ]}
              strokeColor="rgba(255,255,255,0.55)"
              strokeWidth={2}
              lineDashPattern={[4, 4]}
            />
            <Marker
              coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              opacity={0.8}
            >
              <View style={styles.pastShotEndDot} />
            </Marker>
          </React.Fragment>
        ))}

        {/* Heatmap overlay — 1σ / 2σ confidence ellipses for the active
            club's shot dispersion, projected from the player toward the pin.
            Mirrors the profile-stats heatmap styling (neon yellow inner ring
            covers ~68% of shots, neon red outer ring ~95%) so the on-map
            preview and the profile view tell the same story. */}
        {heatmapRings && (
          <>
            <Polygon
              coordinates={heatmapRings.sigma2}
              strokeColor="#ff2d55"            // neon red — 2σ ≈ 95%
              strokeWidth={2}
              fillColor="rgba(255,45,85,0.08)"
            />
            <Polygon
              coordinates={heatmapRings.sigma1}
              strokeColor="#fff200"            // neon yellow — 1σ ≈ 68%
              strokeWidth={2}
              fillColor="rgba(255,242,0,0.12)"
            />
            {/* Heatmap aim handle — DRAGGABLE. Press-and-hold the dot and
                slide; the dispersion rings re-point live (onDrag) so the
                heatmap follows your finger in real time, no lift needed.
                The handle's coordinate is bound to the aim point itself
                (not the projected ring center) so the native drag and our
                state stay in lockstep — without that the marker fights the
                finger, snapping back toward the club-distance center. Until
                an aim is placed it rests on the ring center as the grab
                target. Releasing commits the final placement. */}
            <Marker
              coordinate={aimForCurrentHole
                ? { latitude: aimForCurrentHole.lat, longitude: aimForCurrentHole.lng }
                : heatmapRings.center}
              anchor={{ x: 0.5, y: 0.5 }}
              draggable
              tracksViewChanges={false}
              onDragStart={() => setFollowing(false)}
              onDrag={(e) => {
                const { latitude, longitude } = e.nativeEvent.coordinate;
                commitAim(latitude, longitude);
              }}
              onDragEnd={(e) => {
                const { latitude, longitude } = e.nativeEvent.coordinate;
                commitAim(latitude, longitude, true);
              }}
            >
              {/* The outer transparent square is the actual TOUCH target —
                  a generous fingertip area (see heatmapHitbox). The inner
                  View is the visible dot. Without the oversized wrapper the
                  draggable hitbox is just the 8–14pt dot, which is brutal
                  to grab on a satellite tile. */}
              <View style={styles.heatmapHitbox}>
                <View style={[
                  styles.heatmapCenterDot,
                  aimForCurrentHole && styles.heatmapCenterDotAimed,
                ]} />
              </View>
            </Marker>
          </>
        )}

        {/* Standalone aim crosshair — shown when the player has placed an
            aim but the dispersion heatmap isn't renderable (e.g. brand-
            new player without enough club stats, or before clubStats has
            loaded). Keeps the dropped target visible so the player isn't
            staring at a blank map wondering where their aim went. */}
        {aimForCurrentHole && !heatmapRings && (
          <Marker
            coordinate={{
              latitude:  aimForCurrentHole.lat,
              longitude: aimForCurrentHole.lng,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            draggable
            tracksViewChanges={false}
            onDragStart={() => setFollowing(false)}
            onDrag={(e) => {
              const { latitude, longitude } = e.nativeEvent.coordinate;
              commitAim(latitude, longitude);
            }}
            onDragEnd={(e) => {
              const { latitude, longitude } = e.nativeEvent.coordinate;
              commitAim(latitude, longitude, true);
            }}
          >
            {/* Same fingertip-sized hitbox as the heatmap-rings center marker
                so the standalone aim is just as easy to grab. */}
            <View style={styles.heatmapHitbox}>
              <View style={styles.heatmapCenterDotAimed} />
            </View>
          </Marker>
        )}

        {/* Pin marker (center of green) for the current hole */}
        {knownPin && (
          <Marker
            coordinate={{ latitude: knownPin.lat, longitude: knownPin.lng }}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={styles.pinMarker}>
              <View style={styles.pinMarkerHead} />
              <View style={styles.pinMarkerStaff} />
            </View>
          </Marker>
        )}

        {/* Ghost player path — slightly-better fictional opponent, rendered
            faintly behind the user's real shots. No interaction. Drawn as
            a dashed silver polyline ending with a small "GHOST_NAME" label. */}
        {ghost?.shots.length ? (
          <>
            {ghost.shots.map((g, i) => (
              <Polyline
                key={`ghost-${i}`}
                coordinates={[
                  { latitude: g.start.lat, longitude: g.start.lng },
                  { latitude: g.end.lat,   longitude: g.end.lng },
                ]}
                strokeColor={g.isPutt ? '#d8d8d855' : '#d8d8d8aa'}
                strokeWidth={g.isPutt ? 2 : 3}
                lineDashPattern={[6, 6]}
                lineCap="round"
              />
            ))}
            {/* Endpoint marker — small silver dot with the ghost's name. */}
            <Marker
              coordinate={{
                latitude:  ghost.shots[ghost.shots.length - 1].end.lat,
                longitude: ghost.shots[ghost.shots.length - 1].end.lng,
              }}
              anchor={{ x: 0.5, y: 1 }}
              tappable={false}
              tracksViewChanges={false}
            >
              <View style={styles.ghostLabel}>
                <Text style={styles.ghostLabelText}>{GHOST_NAME}</Text>
                <Text style={styles.ghostLabelScore}>
                  {ghost.targetScore === (currentHoleObj?.par ?? 0)
                    ? 'par'
                    : `+${ghost.targetScore - (currentHoleObj?.par ?? 0)}`}
                </Text>
              </View>
            </Marker>
          </>
        ) : null}

        {/* Saved shots for the current hole — each as a colored start→end
            polyline, with a numbered start dot and end dot. */}
        {currentShots.map((shot, i) => {
          const color = SHOT_COLORS[i % SHOT_COLORS.length];
          return (
            <React.Fragment key={`shot-${i}`}>
              <Polyline
                coordinates={[
                  { latitude: shot.start.lat, longitude: shot.start.lng },
                  { latitude: shot.end.lat,   longitude: shot.end.lng },
                ]}
                strokeColor={color}
                strokeWidth={4}
              />
              <Marker
                coordinate={{ latitude: shot.start.lat, longitude: shot.start.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={[styles.shotDot, { backgroundColor: color }]}>
                  <Text style={styles.shotDotText}>{i + 1}</Text>
                </View>
              </Marker>
              <Marker
                coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={[styles.shotEndDot, { borderColor: color }]} />
              </Marker>
            </React.Fragment>
          );
        })}

        {/* Live tracking line — drawn while the player is between TRACK
            start and TRACK stop. Goes from the start point to current GPS,
            updates as the player walks. The yardage chip at the midpoint
            updates with every GPS fix so the player knows how far they've
            walked — useful as a sanity check before they tap TRACK→stop. */}
        {activeShot && userCoord && (() => {
          const liveYds = Math.round(distYards(
            activeShot.start.lat, activeShot.start.lng,
            userCoord.latitude,   userCoord.longitude,
          ));
          const midLat = (activeShot.start.lat + userCoord.latitude) / 2;
          const midLng = (activeShot.start.lng + userCoord.longitude) / 2;
          const color = SHOT_COLORS[currentShots.length % SHOT_COLORS.length];
          return (
            <>
              <Polyline
                coordinates={[
                  { latitude: activeShot.start.lat, longitude: activeShot.start.lng },
                  { latitude: userCoord.latitude,   longitude: userCoord.longitude },
                ]}
                strokeColor={color}
                strokeWidth={4}
                lineDashPattern={[8, 6]}
              />
              <Marker
                coordinate={{ latitude: activeShot.start.lat, longitude: activeShot.start.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={[styles.shotDot, { backgroundColor: color }]}>
                  <Text style={styles.shotDotText}>{currentShots.length + 1}</Text>
                </View>
              </Marker>
              {/* Midpoint distance label — re-renders with each userCoord
                  update so the player sees live yardage growing as they
                  walk to the ball. */}
              <Marker
                coordinate={{ latitude: midLat, longitude: midLng }}
                anchor={{ x: 0.5, y: 0.5 }}
                tappable={false}
              >
                <View style={[styles.liveShotPill, { borderColor: color }]}>
                  <Text style={[styles.liveShotPillText, { color }]}>{liveYds} yds</Text>
                </View>
              </Marker>
            </>
          );
        })()}
      </MapView>

      {/* ── Top bar (floats over map) ── */}
      <View style={styles.topBar}>
        {/* Leave button — replaces the old ✕ + separate leaveBtn */}
        <TouchableOpacity onPress={handleLeave} style={styles.topBarLeave} disabled={forfeiting}>
          {forfeiting
            ? <ActivityIndicator color={C.textMuted} size="small" />
            : <Text style={styles.topBarLeaveText}>⋮</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.topBarCenter}
          onPress={() => course && router.push(`/course/${course.course_id}` as any)}
          activeOpacity={0.7}
        >
          <Text style={styles.courseName2} numberOfLines={1}>{course?.course_name}</Text>
          <Text style={styles.teeboxName2}>{teebox?.name} · {holes.length} holes</Text>
        </TouchableOpacity>
        <View style={styles.topBarRight}>
          <Text style={[styles.scoreToPar, { color: scoreParColor }]}>
            {scoreToPar === 0 ? 'E' : scoreToPar > 0 ? `+${scoreToPar}` : `${scoreToPar}`}
          </Text>
          <TouchableOpacity style={styles.topBarBtn} onPress={() => setScorecardVisible(true)}>
            <Text style={styles.topBarBtnText}>Card</Text>
          </TouchableOpacity>
          {/* Match chat — cross-team room for everyone in this match. Hidden
              for practice rounds when nobody else has joined yet (chat would
              be a soliloquy). Routes to the same chat screen the lobby uses
              so the message list stays continuous. */}
          {(!match?.is_practice || (match?.players?.length ?? 0) > 1) && (
            <TouchableOpacity
              style={styles.topBarBtn}
              onPress={() => router.push(`/chat/match/${id}` as any)}
              activeOpacity={0.7}
            >
              <Text style={styles.topBarBtnText}>Chat</Text>
            </TouchableOpacity>
          )}
          {/* Practice rounds only: invite up to 8 friends to play the same
              course alongside you. They each get their own scorecard. */}
          {match?.is_practice && (
            <TouchableOpacity
              style={styles.topBarBtn}
              onPress={() => setInviteVisible(true)}
              activeOpacity={0.7}
            >
              <Text style={[styles.topBarBtnText, { color: C.gold }]}>+ Invite</Text>
            </TouchableOpacity>
          )}
          {onCourse ? (
            <TouchableOpacity
              style={[styles.topBarBtn, following && styles.topBarBtnActive]}
              onPress={() => {
                if (!onCourse) return;
                setFollowing(true);
                if (userCoord && mapRef.current) {
                  mapRef.current.animateToRegion(
                    { latitude: userCoord.latitude, longitude: userCoord.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 },
                    400,
                  );
                }
              }}
            >
              <Text style={[styles.topBarBtnText, following && { color: C.gold }]}>
                {following ? 'GPS' : 'Find Me'}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.topBarBtn, { opacity: 0.4 }]}>
              <Text style={styles.topBarBtnText}>Off Course</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Top action row: WEATHER · TRACK SHOT · CLUB ── */}
      <View style={styles.topActionRow}>
        {/* WEATHER — premium users see live conditions; free users see a lock that prompts upgrade. */}
        <TouchableOpacity
          style={[styles.topChip, !userIsPremium && styles.topChipLocked]}
          onPress={() => setWeatherSheetVisible(true)}
          activeOpacity={0.7}
        >
          {userIsPremium && weather ? (
            <>
              <Text style={styles.topChipLabel}>WX</Text>
              <Text style={styles.topChipValue}>
                {weather.temperature_f != null ? `${weather.temperature_f}°` : '—'}
                {weather.wind_speed_mph != null ? ` · ${weather.wind_speed_mph}mph` : ''}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.topChipLabel}>WEATHER</Text>
              <Text style={styles.topChipValue}>👑</Text>
            </>
          )}
        </TouchableOpacity>

        {/* TRACK SHOT — toggles start/stop. Long-press while idle removes
            the most recent shot; long-press while tracking cancels. */}
        <TouchableOpacity
          style={[
            styles.topChip,
            styles.topChipPrimary,
            !userCoord && { opacity: 0.4 },
            activeShot && styles.topChipTracking,
          ]}
          onPress={onTrackPress}
          onLongPress={onTrackLongPress}
          delayLongPress={500}
          disabled={!userCoord}
          activeOpacity={0.7}
        >
          <Text style={[styles.topChipLabel, { color: activeShot ? C.red : C.gold }]}>
            {activeShot ? 'STOP' : 'TRACK'}
          </Text>
          <Text style={styles.topChipValue}>
            {activeShot
              ? `${activeShot.club.toUpperCase()} live`
              : currentShots.length === 0
                ? 'Tap to begin'
                : `Shot ${currentShots.length + 1}`}
          </Text>
        </TouchableOpacity>

        {/* CLUB picker. Required before TRACK can be pressed. Premium users
            see the auto-suggested club here unless they've picked manually. */}
        <TouchableOpacity
          style={styles.topChip}
          onPress={() => setClubPickerVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.topChipLabel}>
            CLUB{userIsPremium && pendingClub && !isManualPick() ? ' · AUTO' : ''}
          </Text>
          <Text style={styles.topChipValue}>
            {(activeShot?.club ?? pendingClub)?.toUpperCase() ?? '—'}
          </Text>
        </TouchableOpacity>
      </View>


      {/* Club picker modal */}
      <Modal
        visible={clubPickerVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setClubPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.clubPickerBackdrop}
          activeOpacity={1}
          onPress={() => setClubPickerVisible(false)}
        >
          <View style={styles.clubPickerSheet}>
            <Text style={styles.clubPickerTitle}>Pick Club</Text>
            <Text style={styles.clubPickerSub}>
              {activeShot
                ? `Tracking ${activeShot.club.toUpperCase()} shot — change club:`
                : 'Required before you start tracking'}
            </Text>
            <View style={styles.clubGrid}>
              {/* Render the user's bag entries — preserving order so a
                  player who likes their wedges grouped at the bottom keeps
                  that layout. Each chip shows the entry's custom label
                  when set, else the canonical code. Falls back to the
                  full ALL list when no bag is saved so a fresh account
                  isn't forced through the bag editor on first use.

                  After the bag chips we ALWAYS append a "CHIP" option —
                  visually distinct (gold-tinted) — which lets the player
                  track a shot on the map WITHOUT it counting toward any
                  specific club's per-club stats. The backend skips
                  segments tagged 'chip' from /club-stats aggregation. */}
              {(() => {
                const ALL = ['driver','3w','5w','7w','hybrid','2i','3i','4i','5i','6i','7i','8i','9i','pw','gw','sw','lw','putter'] as const;
                const bag = user?.clubs_in_bag;
                type Vis = { code: string; label?: string; key: string };
                let visible: Vis[];
                if (Array.isArray(bag) && bag.length > 0) {
                  visible = bag
                    .map((e: any, i: number): Vis | null =>
                      typeof e === 'string'
                        ? { code: e, key: `${e}-${i}` }
                        : (typeof e?.code === 'string'
                            ? { code: e.code, label: typeof e.label === 'string' ? e.label : undefined, key: `${e.code}-${i}` }
                            : null))
                    .filter((v): v is Vis => v != null);
                } else {
                  visible = ALL.map((c, i) => ({ code: c, key: `${c}-${i}` }));
                }
                return visible.map((v) => {
                  const active = (activeShot?.club ?? pendingClub) === v.code;
                  return (
                    <TouchableOpacity
                      key={v.key}
                      style={[styles.clubBtn, active && styles.clubBtnActive]}
                      onPress={() => { pickClub(v.code); setClubPickerVisible(false); }}
                    >
                      <Text style={[styles.clubBtnText, active && { color: C.bg }]}>
                        {(v.label ?? v.code).toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                });
              })()}
              {/* CHIP — always visible, styled differently so the player
                  knows it's a no-stats option. Useful for the bump-and-
                  run / chip-out shots where the player doesn't want to
                  pollute their wedge averages with a 15-yard punch. */}
              {(() => {
                const active = (activeShot?.club ?? pendingClub) === 'chip';
                return (
                  <TouchableOpacity
                    style={[styles.clubBtn, styles.clubBtnChip, active && styles.clubBtnChipActive]}
                    onPress={() => { pickClub('chip'); setClubPickerVisible(false); }}
                  >
                    <Text style={[styles.clubBtnChipText, active && { color: C.bg }]}>CHIP</Text>
                  </TouchableOpacity>
                );
              })()}
            </View>
            <View style={styles.clubPickerFooter}>
              <TouchableOpacity onPress={() => { setClubPickerVisible(false); router.push('/bag' as any); }}>
                <Text style={styles.clubPickerEditBag}>Edit my bag →</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { pickClub(null); setClubPickerVisible(false); }}>
                <Text style={styles.clubClearText}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Advanced entry modal — fairway/green miss directions + per-putt distances */}
      <AdvancedEntryModal
        visible={advancedVisible}
        onClose={() => setAdvancedVisible(false)}
        holePar={holes[currentHole]?.par ?? 4}
        stat={holeStats[currentHole]}
        onChange={(patch) => {
          markManual(currentHole, ...Object.keys(patch));
          setHoleStats((prev) => {
            const next = [...prev];
            next[currentHole] = { ...(next[currentHole] ?? {}), ...patch };
            return next;
          });
        }}
      />

      {/* In-round invite modal — practice only. The host (creator) adds friends
          mid-round; accepters get a notification and can join the same
          practice match (up to 8 friends total via SIDE_CAPS on the backend). */}
      {match?.is_practice && (
        <InviteFriendsModal
          visible={inviteVisible}
          matchId={id}
          onClose={() => setInviteVisible(false)}
          title="Invite to Practice"
          subtitle="Up to 8 friends can join your practice round. They'll each track their own scorecard."
          maxAdditional={8}
        />
      )}

      {/* ── Pin distance / Mark Pin — bottom-right, lifts with the score panel ── */}
      <Animated.View style={[
        styles.pinDistAnchor,
        // Sit 12px above the panel's current top edge, regardless of
        // collapsed/expanded state.
        { bottom: Animated.add(panelAnim, new Animated.Value(12)) },
      ]}>
        {yardsToPin != null ? (
          // Tappable: lets the user contribute another GPS reading to refine
          // the crowdsourced pin location. The backend median-blends across
          // all contributions, so the pin gets more accurate with each one.
          // When GPS looks frozen (no fix in 15+s), tapping the chip instead
          // forces a GPS refresh — so a stuck "TO PIN" yardage has a
          // one-tap escape hatch.
          <TouchableOpacity
            style={[
              styles.mapChipBase, styles.pinDistChip,
              gpsLooksFrozen && { borderColor: C.red, backgroundColor: C.red + '22' },
            ]}
            onPress={() => {
              if (gpsLooksFrozen) {
                refreshGps();
                return;
              }
              if (!userCoord || !currentHoleObj) return;
              const samples = pinSamplesByHole[currentHoleObj.hole_id] ?? null;
              Alert.alert(
                'Refine Pin Location',
                samples != null
                  ? `Currently averaged from ${samples} contribution${samples === 1 ? '' : 's'}. Are you standing at the cup right now? Your reading will help refine the location.`
                  : 'Are you standing at the cup right now? Your reading will help refine the pin location.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Yes, refine', style: 'default', onPress: markPin },
                ],
              );
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.pinDistLabel, gpsLooksFrozen && { color: C.red }]}>
              {gpsLooksFrozen ? `GPS STUCK ${gpsStaleSec}s` : 'TO PIN'}
            </Text>
            <Text style={[styles.pinDistVal, gpsLooksFrozen && { color: C.red }]}>
              {gpsLooksFrozen ? 'Tap to refresh' : `${yardsToPin} yds`}
            </Text>
            {(() => {
              // Combined adjusted distance: weatherAdjustment.effective already
              // layers weather on top of the slope-adjusted base. If only slope
              // is available (free user, no weather data), fall back to that.
              const adjusted = weatherAdjustment?.effective ?? slopeAdjustment?.playsLike ?? null;
              if (adjusted == null || adjusted === yardsToPin) return null;
              const delta = adjusted - yardsToPin;
              const sign = delta > 0 ? '+' : '';
              return (
                <Text style={styles.pinDistPlaysLike}>
                  plays {adjusted} ({sign}{delta})
                </Text>
              );
            })()}
            {gpsAccuracyM != null && gpsAccuracyM > 15 && (
              // Surface poor GPS quality so the user understands why a
              // distance might be off. >15m horizontal accuracy is roughly
              // "phone in a pocket near a building" — yardage may swing ±5y.
              <Text style={styles.pinDistWeak}>
                weak GPS · ±{Math.round(gpsAccuracyM)}m
              </Text>
            )}
            {(() => {
              const samples = currentHoleObj && pinSamplesByHole[currentHoleObj.hole_id];
              if (!samples) return null;
              return (
                <Text style={styles.pinDistSamples}>
                  {samples} sample{samples === 1 ? '' : 's'} · tap to refine
                </Text>
              );
            })()}
          </TouchableOpacity>
        ) : (
          // No known pin yet on this hole — make the contribute CTA hard to
          // miss. Pin coverage is what unlocks distance, slope, weather, and
          // heatmap features for everyone, so we lean hard into it visually
          // and dangle the Lucky Round perk so it feels worth the tap.
          <TouchableOpacity
            style={[styles.dropPinBtn, !userCoord && { opacity: 0.4 }]}
            onPress={() => {
              if (!userCoord) {
                Alert.alert('No GPS', 'Wait for a GPS lock before marking the pin.');
                return;
              }
              Alert.alert(
                'Drop Pin Here?',
                'Are you standing at the cup right now? This GPS reading becomes the pin location for everyone playing this hole. Contribute pins on the majority of your holes to earn a Lucky Round perk.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Drop Pin', style: 'default', onPress: markPin },
                ],
              );
            }}
            disabled={!userCoord}
            activeOpacity={0.85}
          >
            <View style={styles.dropPinDot} />
            <View>
              <Text style={styles.dropPinLabel}>DROP PIN</Text>
              <Text style={styles.dropPinSub}>tap at the cup</Text>
            </View>
          </TouchableOpacity>
        )}
      </Animated.View>

      {/* Weather details sheet */}
      <Modal
        visible={weatherSheetVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setWeatherSheetVisible(false)}
      >
        <TouchableOpacity
          style={styles.advBackdrop}
          activeOpacity={1}
          onPress={() => setWeatherSheetVisible(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow */ }}>
            <View style={styles.advSheet}>
              <Text style={styles.advTitle}>{userIsPremium ? 'Conditions' : 'Weather'}</Text>
              {!userIsPremium ? (
                // Free users: simple paywall — no live weather data shown.
                <View style={styles.wxLockBox}>
                  <Text style={styles.wxLockTitle}>👑 Premium feature</Text>
                  <Text style={styles.wxLockBody}>
                    See live conditions and plays-like distances auto-adjusted
                    for altitude, temperature, wind, and rain.
                  </Text>
                  <TouchableOpacity
                    style={styles.wxLockBtn}
                    onPress={() => { setWeatherSheetVisible(false); router.push('/premium' as any); }}
                  >
                    <Text style={styles.wxLockBtnText}>UNLOCK PREMIUM</Text>
                  </TouchableOpacity>
                </View>
              ) : weather ? (
                <>
                  <View style={styles.wxGrid}>
                    <WxStat label="TEMP"   value={weather.temperature_f != null ? `${weather.temperature_f}°F` : '—'} />
                    <WxStat label="WIND"   value={weather.wind_speed_mph != null ? `${weather.wind_speed_mph} mph` : '—'} />
                    <WxStat label="RAIN"   value={weather.rain.toUpperCase()} />
                    <WxStat label="ELEV"   value={weather.elevation_ft != null ? `${weather.elevation_ft} ft` : '—'} />
                  </View>
                  {weatherAdjustment && yardsToPin != null && (
                    <>
                      <Text style={styles.advSection}>PLAYS-LIKE BREAKDOWN</Text>
                      <Text style={styles.wxBaseLine}>
                        Base distance: {yardsToPin} yds
                      </Text>
                      <WxRow
                        label={weatherAdjustment.altRelative ? 'Altitude vs home' : 'Altitude'}
                        yds={weatherAdjustment.breakdown.altitude_yds}
                        extra={weatherAdjustment.altRelative
                          ? `${weatherAdjustment.altDeltaFt > 0 ? '+' : ''}${weatherAdjustment.altDeltaFt} ft`
                          : undefined}
                      />
                      <WxRow label="Temperature"  yds={weatherAdjustment.breakdown.temperature_yds} />
                      <WxRow label="Wind"         yds={weatherAdjustment.breakdown.wind_yds} extra={
                        weatherAdjustment.windAlong > 0
                          ? `${Math.round(weatherAdjustment.windAlong)} mph tailwind`
                          : weatherAdjustment.windAlong < 0
                            ? `${Math.round(-weatherAdjustment.windAlong)} mph headwind`
                            : 'crosswind only'
                      } />
                      <WxRow label="Rain"         yds={weatherAdjustment.breakdown.rain_yds} />
                      <View style={styles.totalDivider2} />
                      <View style={styles.wxTotalRow}>
                        <Text style={styles.wxTotalLabel}>PLAYS LIKE</Text>
                        <Text style={styles.wxTotalVal}>{weatherAdjustment.effective} yds</Text>
                      </View>
                    </>
                  )}
                </>
              ) : null}
              <TouchableOpacity style={styles.advCloseBtn} onPress={() => setWeatherSheetVisible(false)}>
                <Text style={styles.advCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Measure distance banner — centered, lifts with score panel ── */}
      {measureDist !== null && (() => {
        const raw = Math.round(measureDist);
        // Slope adjustment: use the DEM elevation at the EXACT tapped point
        // as the destination, and the player's DEM elevation as the source.
        // Both in the same orthometric frame → accurate within ~5 yards
        // anywhere on the planet. Falls back to GPS altimeter while DEM
        // lookups are still in flight.
        let slopeAdj = 0;
        const playerElev = playerElevationM ?? (typeof userCoord?.altitude === 'number' ? userCoord.altitude : null);
        if (measureElevationM != null && playerElev != null) {
          const elevDiffM = measureElevationM - playerElev;
          slopeAdj = Math.round(elevDiffM * 1.09);
        }
        const slopeBase = raw + slopeAdj;

        // Apply weather adjustments on top of the slope-adjusted base.
        let adjusted: number | null = null;
        if (userIsPremium && weather?.temperature_f != null) {
          const courseAltFt = weather.elevation_ft
            ?? (typeof userCoord?.altitude === 'number' ? Math.round(metersToFeet(userCoord.altitude)) : 0);
          const altDeltaFt = homeElevationFt != null ? courseAltFt - homeElevationFt : courseAltFt;
          // Wind component along the measure-line
          let along = 0;
          if (measurePin && userCoord && weather.wind_speed_mph && weather.wind_from_bearing != null) {
            const lat1 = userCoord.latitude * Math.PI / 180;
            const lat2 = measurePin.latitude * Math.PI / 180;
            const dLng = (measurePin.longitude - userCoord.longitude) * Math.PI / 180;
            const y = Math.sin(dLng) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
            const shotBearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
            along = windComponents(weather.wind_speed_mph, weather.wind_from_bearing, shotBearingDeg).along_mph;
          }
          const adj = adjustDistance(slopeBase, {
            altitudeFt: altDeltaFt,
            temperatureF: weather.temperature_f,
            windAlongMph: along,
            rain: weather.rain,
          });
          // Same sign convention as the main pin-distance plays-like
          // calculation above (line ~1515): positive effective_delta means
          // conditions reduce carry → effective yardage is HIGHER than
          // base (need more club). A stray negation here used to flip
          // both wind and altitude readings.
          const eff = Math.round(slopeBase + adj.effective_delta_yds);
          // Show ANY non-zero adjustment, however small — the user is paying
          // attention to it and a "−1 yds" plays-like still tells them the
          // direction conditions are pushing the ball.
          if (eff !== raw) adjusted = eff;
        } else if (slopeAdj !== 0) {
          // Free user OR no weather: still surface slope-only adjustment.
          adjusted = slopeBase;
        }

        return (
          <Animated.View style={[
            styles.distBanner,
            { bottom: Animated.add(panelAnim, new Animated.Value(20)) },
          ]}>
            <View>
              <Text style={styles.distNum}>{raw} yds</Text>
              {adjusted != null && (
                <Text style={styles.distAdj}>
                  plays {adjusted} ({adjusted > raw ? '+' : ''}{adjusted - raw})
                </Text>
              )}
              {/* "X to pin" — yardage from the tapped point onward to the
                  actual hole. Mirrors the second polyline + label drawn on
                  the map so the player has both numbers within glance:
                  carry to the lay-up + what's left in. */}
              {measureToPin != null && (
                <Text style={styles.distLeg}>
                  +{Math.round(measureToPin)} to pin
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => {
                // Arm the single-shot guard so the phantom map tap this
                // press bleeds through gets eaten — exactly one event.
                ignoreNextMapTap.current = true;
                setMeasurePin(null);
              }}
              style={styles.distClear}
            >
              <Text style={styles.distClearText}>Clear</Text>
            </TouchableOpacity>
          </Animated.View>
        );
      })()}

      {/* ── Score panel (collapsible, anchored at bottom) ── */}
      <Animated.View style={[styles.panel, { height: panelAnim }]}>
        <View style={styles.panelHandle} {...panResponder.panHandlers}>
          <TouchableOpacity onPress={() => snapPanel(!panelExpanded)} activeOpacity={0.6}>
            <View style={styles.handleBar} />
          </TouchableOpacity>
          <View style={styles.collapsedRow}>
            <TouchableOpacity
              style={[styles.miniNavBtn, currentHole === 0 && styles.miniNavBtnDisabled]}
              onPress={(e) => { e.stopPropagation?.(); goToHole(-1); }}
              disabled={currentHole === 0}
            >
              <Text style={styles.miniNavText}>←</Text>
            </TouchableOpacity>

            <View style={styles.holeSummary}>
              <Text style={styles.holeSummaryHole}>
                Hole {hole.hole_num}
                <Text style={styles.holeSummaryPar}>  Par {hole.par}{hole.yardage ? `  ·  ${hole.yardage} yds` : ''}</Text>
              </Text>
              <View style={styles.scoreSummaryRow}>
                <Text style={[styles.scoreSummaryNum, { color: sl.color }]}>{score}</Text>
                <Text style={[styles.scoreSummaryLabel, { color: sl.color }]}>{sl.label}</Text>
              </View>
            </View>

            {isLastHole ? (
              <TouchableOpacity
                style={styles.miniSubmitBtn}
                onPress={(e) => { e.stopPropagation?.(); handleSubmit(); }}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator color="#000" size="small" />
                  : <Text style={styles.miniSubmitText}>Submit</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.miniNavBtn}
                onPress={(e) => { e.stopPropagation?.(); goToHole(1); }}
              >
                <Text style={styles.miniNavText}>→</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {panelExpanded && (
          <View style={styles.expandedContent}>
            {hole.handicap != null && (
              <Text style={styles.hcapLine}>Handicap {hole.handicap}</Text>
            )}

            <View style={styles.scoreRow}>
              <TouchableOpacity style={styles.scoreBtn} onPress={() => adjustScore(-1)}>
                <Text style={styles.scoreBtnText}>−</Text>
              </TouchableOpacity>
              <View style={styles.scoreCenter}>
                <Text style={styles.scoreNum}>{score}</Text>
              </View>
              <TouchableOpacity style={styles.scoreBtn} onPress={() => adjustScore(1)}>
                <Text style={styles.scoreBtnText}>+</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.quickScoreRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[styles.quickBtn, score === n && { backgroundColor: C.gold }]}
                  onPress={() => setScores((prev) => { const next = [...prev]; next[currentHole] = n; return next; })}
                >
                  <Text style={[styles.quickBtnText, score === n && { color: '#000' }]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Single DETAILS button — opens the full hole-detail modal where
                putts, chips, fairway, GIR, and putt distances all live. */}
            <TouchableOpacity
              style={styles.detailBtn}
              onPress={() => setAdvancedVisible(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.detailBtnLabel}>HOLE DETAILS</Text>
              {(() => {
                const hs = holeStats[currentHole];
                const manual = manualFields[currentHole] ?? new Set<string>();
                const bits: string[] = [];
                if (hs?.putts != null) bits.push(`${hs.putts} putt${hs.putts === 1 ? '' : 's'}`);
                if (hs?.chips != null && hs.chips > 0) bits.push(`${hs.chips} chip${hs.chips === 1 ? '' : 's'}`);
                if (hs?.fairwayHit === true) bits.push('FW hit');
                if (hs?.fairwayHit === false) bits.push(`FW ${hs.fairwayMiss ?? 'miss'}`);
                if (hs?.gir === true) bits.push('GIR');
                if (hs?.gir === false) bits.push(`grn ${hs.greenMiss ?? 'miss'}`);
                const hasAuto = ['fairwayHit','fairwayMiss','gir','greenMiss','putts','chips']
                  .some(k => (hs as any)?.[k] !== undefined && !manual.has(k));
                if (!bits.length) {
                  return <Text style={styles.detailBtnHint}>tap to enter putts, chips, FW, GIR…</Text>;
                }
                return (
                  <Text style={styles.detailBtnSummary}>
                    {hasAuto && '⚡ '}{bits.join(' · ')}
                  </Text>
                );
              })()}
            </TouchableOpacity>

            <View style={styles.navRow}>
              <TouchableOpacity
                style={[styles.navBtn, currentHole === 0 && styles.navBtnDisabled]}
                onPress={() => goToHole(-1)}
                disabled={currentHole === 0}
              >
                <Text style={styles.navBtnText}>← Prev</Text>
              </TouchableOpacity>
              {isLastHole ? (
                <TouchableOpacity
                  style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                  onPress={handleSubmit}
                  disabled={submitting}
                >
                  {submitting
                    ? <ActivityIndicator color="#000" />
                    : <Text style={styles.submitBtnText}>Submit Round</Text>}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.nextBtn} onPress={() => goToHole(1)}>
                  <Text style={styles.nextBtnText}>Next →</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      </Animated.View>

      {/* ── Scorecard Modal ── */}
      <Modal
        visible={scorecardVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setScorecardVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{course?.course_name}</Text>
              <Text style={styles.modalSub}>{teebox?.name} Tees · Par {totalPar}</Text>
            </View>
            <TouchableOpacity style={styles.modalClose} onPress={() => setScorecardVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 40 }}>
            <View style={styles.scRow}>
              <Text style={[styles.scCell, styles.scHoleCol, styles.scHeader]}>HOLE</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>PAR</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>YDS</Text>
              <Text style={[styles.scCell, styles.scStatCol, styles.scHeader]}>HCP</Text>
              <Text style={[styles.scCell, styles.scScoreCol, styles.scHeader]}>SCORE</Text>
            </View>

            {holes.map((h, i) => {
              const s = scores[i] ?? h.par;
              const isActive = i === currentHole;
              return (
                <TouchableOpacity key={h.hole_id} onPress={() => jumpToHole(i)}>
                  <View style={[styles.scRow, isActive && styles.scRowActive]}>
                    <View style={[styles.scCell, styles.scHoleCol, { alignItems: 'flex-start' }]}>
                      <View style={[styles.holeNumBadge, isActive && { backgroundColor: C.gold }]}>
                        <Text style={[styles.holeNumBadgeText, isActive && { color: '#000' }]}>{h.hole_num}</Text>
                      </View>
                    </View>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.par}</Text>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.yardage ?? '—'}</Text>
                    <Text style={[styles.scCell, styles.scStatCol, styles.scText]}>{h.handicap ?? '—'}</Text>
                    <Text style={[styles.scCell, styles.scScoreCol, styles.scScore, { color: scoreColor(s, h.par) }]}>{s}</Text>
                  </View>
                  {(i === 8 && holes.length > 9) && (
                    <View style={styles.subtotalRow}>
                      <Text style={styles.subtotalLabel}>OUT</Text>
                      <Text style={styles.subtotalPar}>{frontParTotal}</Text>
                      <Text style={[styles.subtotalScore, { color: frontScoreTotal - frontParTotal < 0 ? C.green : frontScoreTotal - frontParTotal > 0 ? C.red : C.text }]}>
                        {frontScoreTotal}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {holes.length > 9 && (
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>IN</Text>
                <Text style={styles.subtotalPar}>{backParTotal}</Text>
                <Text style={[styles.subtotalScore, { color: backScoreTotal - backParTotal < 0 ? C.green : backScoreTotal - backParTotal > 0 ? C.red : C.text }]}>
                  {backScoreTotal}
                </Text>
              </View>
            )}
            <View style={[styles.subtotalRow, styles.totalRow]}>
              <Text style={[styles.subtotalLabel, { color: C.gold }]}>TOTAL</Text>
              <Text style={[styles.subtotalPar, { color: C.gold }]}>{totalPar}</Text>
              <Text style={[styles.subtotalScore, { color: scoreToPar < 0 ? C.green : scoreToPar > 0 ? C.red : C.gold, fontSize: 18 }]}>
                {totalScore}
              </Text>
            </View>
            <Text style={styles.tapHint}>Tap a hole to jump to it</Text>
          </ScrollView>
        </View>
      </Modal>

      {/* Birdie / Eagle / HIO overlay. Sits ABOVE everything else in the
          screen because <Modal> escapes the local view tree — so it'll
          paint over the scorecard modal, the club picker, etc. */}
      <HoleScoreCelebration event={celebrationEvent} onDismiss={advanceCelebration} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },

  // Course selection
  backBtn: { marginBottom: 10, marginTop: 60, paddingHorizontal: 20 },
  backBtnText: { color: C.gold, fontSize: 16 },
  title: { color: C.text, fontSize: 24, fontWeight: '900', paddingHorizontal: 20, marginBottom: 4 },
  subtitle: { color: C.textMuted, fontSize: 13, paddingHorizontal: 20, marginBottom: 12 },
  sectionTitle: { color: C.text, fontSize: 18, fontWeight: '800', paddingHorizontal: 20, marginBottom: 4, marginTop: 8 },
  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 13, fontSize: 15,
    borderWidth: 1, borderColor: C.border, marginHorizontal: 20, marginBottom: 10,
  },
  nearbyLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 8, paddingHorizontal: 20 },
  courseCard: { backgroundColor: C.card, borderRadius: 6, padding: 14, marginHorizontal: 20, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  courseLocation: { color: C.gold, fontSize: 12, marginTop: 3 },
  teeboxCard: { backgroundColor: C.cardAlt, borderRadius: 6, padding: 16, marginHorizontal: 20, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.border },
  teeboxCardDisabled: { opacity: 0.45 },
  holesLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 8, marginBottom: 6, paddingHorizontal: 20 },
  holesRow: { flexDirection: 'row', gap: 10, marginHorizontal: 20, marginBottom: 14 },
  holesBtn: { flex: 1, paddingVertical: 14, borderRadius: 6, alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  holesBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },
  teeboxName: { color: C.text, fontWeight: '700', fontSize: 15 },
  teeboxMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  rating: { color: C.gold, fontWeight: '700', fontSize: 12 },
  slope: { color: C.textMuted, fontSize: 12 },

  // Top bar (floating over map) — no separate leave button anymore
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 56, paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: C.bg + 'dd',
    borderBottomWidth: 1, borderBottomColor: C.border + '88',
    gap: 8,
  },
  topBarLeave: {
    width: 36, height: 36, borderRadius: 6, backgroundColor: C.card + 'cc',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: C.border,
  },
  topBarLeaveText: { color: C.textMuted, fontSize: 20, fontWeight: '700', lineHeight: 22 },
  topBarCenter: { flex: 1 },
  courseName2: { color: C.text, fontWeight: '700', fontSize: 13 },
  teeboxName2: { color: C.textMuted, fontSize: 10 },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scoreToPar: { fontSize: 20, fontWeight: '900', marginRight: 4 },
  topBarBtn: {
    backgroundColor: C.card + 'cc', borderRadius: 4, paddingHorizontal: 9, paddingVertical: 5,
    borderWidth: 1, borderColor: C.border,
  },
  topBarBtnActive: { borderColor: C.gold },
  topBarBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 11 },

  // ── Top action row (3 small chips: Weather · Track · Club) ─────────────
  topActionRow: {
    position: 'absolute', top: 124, left: 12, right: 12,
    flexDirection: 'row', gap: 8,
    zIndex: 5,
  },
  topChip: {
    flex: 1,
    backgroundColor: C.bg + 'ee',
    borderRadius: 6, borderWidth: 1, borderColor: C.gold + '66',
    paddingVertical: 8, paddingHorizontal: 8,
    alignItems: 'center', justifyContent: 'center', minHeight: 50,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  topChipPrimary: { borderColor: C.gold, borderWidth: 2 },
  topChipTracking: { borderColor: C.red, borderWidth: 2, backgroundColor: C.red + '22' },
  topChipLocked:  { borderColor: C.textMuted + '88' },
  topChipLabel:   { color: C.textMuted, fontWeight: '800', fontSize: 9, letterSpacing: 1 },
  topChipValue:   { color: C.text, fontWeight: '900', fontSize: 12, marginTop: 2 },

  // ── Bottom-right pin anchor — bottom value follows panel height ────────
  pinDistAnchor: { position: 'absolute', right: 12 },

  // Floating chip base — used by pin distance / mark-pin variants.
  mapChipBase: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8,
    minWidth: 110, minHeight: 64,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  pinDistChip: { borderColor: '#fff', backgroundColor: C.green + 'ee' },
  markPinBtn:  { borderColor: C.green },

  clubPickerBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end',
  },
  clubPickerSheet: {
    backgroundColor: C.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 20, paddingBottom: 36,
    borderTopWidth: 1, borderColor: C.gold + '88',
  },
  clubPickerTitle: { color: C.gold, fontFamily: F.serif, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  clubPickerSub: { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  clubGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  clubBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, minWidth: 64,
  },
  clubBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  clubBtnText: { color: C.text, fontWeight: '800', fontSize: 12, textAlign: 'center', letterSpacing: 0.6 },
  // CHIP — non-attributing club chip. Same shape as regular club chips
  // so the picker layout stays tidy, but tinted gold + dashed border to
  // signal "this is the catch-all, doesn't go into per-club stats."
  clubBtnChip: {
    backgroundColor: C.gold + '14',
    borderColor: C.gold,
    borderStyle: 'dashed',
  },
  clubBtnChipActive: { backgroundColor: C.gold, borderColor: C.gold, borderStyle: 'solid' },
  clubBtnChipText: { color: C.gold, fontWeight: '900', fontSize: 12, textAlign: 'center', letterSpacing: 0.6 },
  clubClearBtn: { marginTop: 14, alignSelf: 'center', padding: 8 },
  clubClearText: { color: C.textMuted, fontSize: 12 },
  clubPickerFooter: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 14, paddingHorizontal: 8,
  },
  clubPickerEditBag: { color: C.gold, fontSize: 12, fontWeight: '700' },
  shotDot: {
    width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 3,
  },
  shotDotText: { color: '#fff', fontWeight: '900', fontSize: 11 },

  // Tiny dot at the center of the σ ellipses — marks the player's mean
  // landing point for the selected club. Neon yellow to match the 1σ ring.
  heatmapCenterDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#fff200',
    borderWidth: 1, borderColor: '#000',
    shadowColor: '#fff200', shadowOpacity: 0.8, shadowRadius: 4,
  },
  // Invisible 90×90pt wrapper around the heatmap center dot. Way bigger
  // than Apple's 44pt HIG minimum — the heatmap marker sits on top of a
  // satellite tile (no nearby contrast to aim at) AND has to win the drag
  // race against the map pan gesture, so a generous hitbox is the only
  // way it feels reliable. The visible dot stays small (8–14pt) so the
  // σ rings underneath aren't occluded.
  heatmapHitbox: {
    width: 90, height: 90,
    alignItems: 'center', justifyContent: 'center',
    // backgroundColor left undefined so the wrapper is fully transparent;
    // a tinted debug background can be temporarily added here when
    // troubleshooting hit testing.
  },
  // Larger and gold-tinted when the player has manually dragged the aim —
  // signals "this is your committed aim point, not the auto-projected one."
  heatmapCenterDotAimed: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: C.gold,
    borderColor: '#000', borderWidth: 2,
    shadowColor: C.gold, shadowOpacity: 1, shadowRadius: 6,
  },
  // Live shot yardage pill — floats at the midpoint of the active shot
  // polyline. Dark background so it's readable against the satellite tiles
  // regardless of where on the course the player is walking.
  liveShotPill: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 12, borderWidth: 1.5,
    paddingHorizontal: 10, paddingVertical: 4,
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 3,
    elevation: 4,
  },
  liveShotPillText: { fontFamily: F.serif, fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },

  // Ghost player endpoint label — silver, low-contrast so it sits behind
  // the real shot markers. Italic + lowercase for the wizardly vibe.
  ghostLabel: {
    backgroundColor: '#1a1a1ad9',
    borderColor: '#d8d8d8',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignItems: 'center',
  },
  ghostLabelText: {
    color: '#e8e8e8',
    fontSize: 9,
    fontWeight: '700',
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },
  ghostLabelScore: {
    color: '#c8c8c8',
    fontSize: 8,
    fontWeight: '600',
    marginTop: 1,
  },
  shotEndDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#fff', borderWidth: 3,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 2,
  },
  pastShotDot: {
    width: 9, height: 9, borderRadius: 5,
    borderWidth: 1, borderColor: '#fff',
  },
  pastShotEndDot: {
    width: 9, height: 9, borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.6)',
  },

  // Pin distance + Mark Pin (chip variants are defined above; only the
  // text styling lives here)
  pinDistLabel: { color: '#fff', fontWeight: '800', fontSize: 9, letterSpacing: 1.2 },
  pinDistVal: { color: '#fff', fontWeight: '900', fontSize: 16, marginTop: 2, fontFamily: F.serif },
  pinDistPlaysLike: { color: '#fff', fontWeight: '700', fontSize: 11, marginTop: 3, opacity: 0.95 },
  pinDistSamples: { color: '#fff', fontSize: 9, marginTop: 2, opacity: 0.75, fontStyle: 'italic' },
  pinDistWeak:    { color: '#FFCC66', fontSize: 9, marginTop: 2, opacity: 0.9, fontWeight: '700' },

  // Weather details sheet
  wxGrid: { flexDirection: 'row', gap: 8, marginTop: 12 },
  wxStatBox: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    backgroundColor: C.bg, borderRadius: 6, borderWidth: 1, borderColor: C.border,
  },
  wxStatLabel: { color: C.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  wxStatVal: { color: C.text, fontFamily: F.serif, fontSize: 16, fontWeight: '900', marginTop: 4 },
  wxBaseLine: { color: C.textMuted, fontSize: 11, marginBottom: 6 },
  wxLineRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: C.bg, borderRadius: 6, borderWidth: 1, borderColor: C.border,
    marginBottom: 6,
  },
  wxLineLabel: { color: C.text, fontSize: 13, fontWeight: '700' },
  wxLineYds: { fontFamily: F.serif, fontSize: 14, fontWeight: '900' },
  wxLineExtra: { color: C.textMuted, fontSize: 9, marginTop: 1 },
  totalDivider2: { height: 1, backgroundColor: C.gold + '44', marginVertical: 8 },
  wxTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: C.gold + '22', borderRadius: 6, borderWidth: 1, borderColor: C.gold,
  },
  wxTotalLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 0.8 },
  wxTotalVal: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900' },

  wxLockBox: {
    marginTop: 16, padding: 16, borderRadius: 8,
    borderWidth: 1, borderColor: C.gold + '88', backgroundColor: C.bg, alignItems: 'center',
  },
  wxLockTitle: { color: C.gold, fontWeight: '900', fontSize: 14 },
  wxLockBody: { color: C.text, fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: 8 },
  wxLockBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: C.gold, borderRadius: 6,
  },
  wxLockBtnText: { color: C.bg, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },

  // Mark Pin chip text styling (chip variant defined above)
  // Compact MARK / PIN button — stacked label, smaller footprint than the
  // floating chips so the centered distance banner has more breathing room.
  markPinBtnSmall: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 8, borderWidth: 1, borderColor: C.green,
    paddingHorizontal: 10, paddingVertical: 8,
    minWidth: 70, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  markPinLabelSmall: { color: C.green, fontWeight: '900', fontSize: 12, letterSpacing: 1.5, lineHeight: 14 },

  // Bigger, more inviting drop-pin CTA used when no pin exists on this hole.
  // Keeps the gold-accent treatment consistent with other primary CTAs (e.g.
  // the "Start Round" button) so players read it as "do this thing".
  dropPinBtn: {
    backgroundColor: C.gold + 'cc',
    borderRadius: 10, borderWidth: 1.5, borderColor: C.gold,
    paddingHorizontal: 14, paddingVertical: 10,
    minWidth: 132, flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: C.gold, shadowOpacity: 0.45, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  dropPinDot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#000',
  },
  dropPinLabel: { color: '#000', fontWeight: '900', fontSize: 13, letterSpacing: 1.5 },
  dropPinSub:   { color: '#000', fontWeight: '600', fontSize: 9, opacity: 0.75, marginTop: 1 },

  // Pin marker on the map (small red flag)
  pinMarker: { width: 18, height: 24, alignItems: 'center' },
  pinMarkerHead: {
    width: 12, height: 8, backgroundColor: C.red,
    borderRadius: 1, borderWidth: 1, borderColor: '#fff',
  },
  pinMarkerStaff: {
    width: 1.5, height: 16, backgroundColor: '#fff',
    marginTop: -1,
  },

  // Measure pin
  pinOuter: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: C.gold + 'aa', borderWidth: 2, borderColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
  },
  pinInner: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },

  // Distance banner — centered, lifts with the collapsible score panel.
  distBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bg + 'f0', borderRadius: 6,
    borderWidth: 1, borderColor: C.gold,
    paddingVertical: 10, paddingHorizontal: 18,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 8,
  },
  distNum: { fontFamily: F.serif, color: C.gold, fontSize: 22, fontWeight: '700' },
  distAdj: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 2 },
  // Second-leg line — yardage from the tapped point on to the pin. Slightly
  // dimmer than distNum/distAdj since it's the supporting info, not the
  // primary readout.
  distLeg: { color: C.gold + 'cc', fontSize: 11, fontWeight: '700', marginTop: 2 },
  // Midpoint label on the measure→pin polyline. Matches the live-shot pill
  // styling so the on-map number readouts feel like one family.
  measureLegPill: {
    backgroundColor: C.bg + 'ee',
    borderRadius: 10, borderWidth: 1, borderColor: C.gold + 'aa',
    paddingHorizontal: 8, paddingVertical: 3,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3,
    elevation: 3,
  },
  measureLegPillText: { color: C.gold, fontFamily: F.serif, fontSize: 11, fontWeight: '900' },
  distClear: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.border },
  distClearText: { color: C.textMuted, fontWeight: '700', fontSize: 11 },

  // Collapsible score panel
  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: C.bg + 'f5',
    borderTopWidth: 1, borderTopColor: C.border,
    overflow: 'hidden',
  },
  panelHandle: { paddingTop: 8, paddingBottom: 4, paddingHorizontal: 16 },
  handleBar: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 10,
  },
  collapsedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 28,
  },
  holeSummary: { flex: 1, alignItems: 'center' },
  holeSummaryHole: { color: C.text, fontWeight: '700', fontSize: 13 },
  holeSummaryPar: { color: C.textMuted, fontWeight: '400', fontSize: 12 },
  scoreSummaryRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  scoreSummaryNum: { fontFamily: F.serif, fontSize: 28, fontWeight: '700' },
  scoreSummaryLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  miniNavBtn: {
    width: 44, height: 44, borderRadius: 4, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  miniNavBtnDisabled: { opacity: 0.3 },
  miniNavText: { color: C.text, fontSize: 18, fontWeight: '700' },
  miniSubmitBtn: {
    paddingHorizontal: 12, height: 44, borderRadius: 4,
    backgroundColor: C.gold, justifyContent: 'center', alignItems: 'center',
  },
  miniSubmitText: { color: '#000', fontWeight: '900', fontSize: 13 },

  // Expanded panel content
  expandedContent: { paddingHorizontal: 16, paddingBottom: 36 },
  hcapLine: { color: C.textDim, fontSize: 11, letterSpacing: 1, textAlign: 'center', marginBottom: 8 },

  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  scoreBtn: {
    width: 58, height: 58, borderRadius: 6, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: C.border,
  },
  scoreBtnText: { color: C.text, fontSize: 30, fontWeight: '300' },
  scoreCenter: { width: 110, alignItems: 'center' },
  scoreNum: { fontFamily: F.serif, fontSize: 64, fontWeight: '700', color: C.text, lineHeight: 72 },

  quickScoreRow: { flexDirection: 'row', gap: 5, justifyContent: 'center', marginBottom: 12 },
  quickBtn: {
    width: 34, height: 34, borderRadius: 4, backgroundColor: C.card,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  quickBtnText: { color: C.text, fontWeight: '700', fontSize: 13 },

  navRow: { flexDirection: 'row', gap: 10 },
  navBtn: { flex: 1, backgroundColor: C.card, borderRadius: 6, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  navBtnDisabled: { opacity: 0.3 },
  navBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },
  nextBtn: { flex: 2, backgroundColor: C.gold + '22', borderRadius: 6, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.gold },
  nextBtnText: { color: C.gold, fontWeight: '800', fontSize: 14 },
  submitBtn: { flex: 2, backgroundColor: C.gold, borderRadius: 6, padding: 12, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },

  // Scorecard modal
  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900' },
  modalSub: { color: C.textMuted, fontSize: 13, marginTop: 2 },
  modalClose: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 8 },
  modalCloseText: { color: '#000', fontWeight: '800', fontSize: 14 },
  modalScroll: { flex: 1 },

  scRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: C.border + '55',
  },
  scRowActive: { backgroundColor: C.card },
  scHeader: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  scCell: { justifyContent: 'center' },
  scHoleCol: { width: 48 },
  scStatCol: { flex: 1, textAlign: 'center' },
  scScoreCol: { width: 52, textAlign: 'right' },
  scText: { color: C.text, fontSize: 14 },
  scScore: { fontSize: 16, fontWeight: '800', textAlign: 'right' },

  holeNumBadge: {
    width: 32, height: 32, borderRadius: 4, backgroundColor: C.surface,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  holeNumBadgeText: { color: C.text, fontWeight: '800', fontSize: 13 },

  subtotalRow: {
    flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 16,
    backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  subtotalLabel: { width: 48, color: C.textMuted, fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  subtotalPar: { flex: 3, color: C.textMuted, fontSize: 13, textAlign: 'center' },
  subtotalScore: { width: 52, fontWeight: '800', fontSize: 15, textAlign: 'right' },
  totalRow: { backgroundColor: C.cardAlt, marginTop: 2 },

  tapHint: { color: C.textDim, fontSize: 12, textAlign: 'center', marginTop: 16 },

  // ── Single DETAILS button on the score panel ────────────────────────────
  detailBtn: {
    marginTop: 4, marginBottom: 12,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, borderColor: C.gold,
    backgroundColor: C.card, alignItems: 'center',
  },
  detailBtnLabel: { color: C.gold, fontWeight: '900', fontSize: 13, letterSpacing: 1.2 },
  detailBtnHint: { color: C.textMuted, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
  detailBtnSummary: { color: C.text, fontSize: 11, marginTop: 4, textAlign: 'center' },

  // Row holding the Putts/Chips steppers inside the detail modal
  advCountsRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },

  // ── Advanced entry modal ────────────────────────────────────────────────
  advBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  advSheet: {
    backgroundColor: C.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    height: '92%',
    borderTopWidth: 1, borderColor: C.gold + '88',
  },
  advSheetInner: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  advTitle: { color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  advSheetHeader: {
    paddingTop: 8, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  advSheetGrip: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 12,
  },
  advSheetTitleRow: { flexDirection: 'row', alignItems: 'center', paddingBottom: 12 },
  advHeaderClose: { paddingHorizontal: 12, paddingVertical: 6 },
  advHeaderCloseText: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 0.6 },
  advSection: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 18, marginBottom: 8 },

  // Direction button (LEFT / FAIRWAY / RIGHT and the green compass rose)
  dirRow: { flexDirection: 'row', gap: 6 },
  dirBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },
  dirBtnActive: { borderColor: C.gold, backgroundColor: C.gold },
  dirBtnText: { color: C.text, fontWeight: '800', fontSize: 12, letterSpacing: 0.6 },
  dirBtnTextActive: { color: C.bg },

  // Compass rose for green miss
  greenRose: { alignItems: 'center', marginTop: 4 },
  greenRoseRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginVertical: 4 },
  greenCenter: {
    width: 80, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },
  greenSide: {
    width: 80, paddingVertical: 12, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: 'center',
  },

  // Per-putt slider
  putRow: { marginTop: 10 },
  putHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  putLabel: { color: C.text, fontSize: 13, fontWeight: '700' },
  putVal: { color: C.gold, fontFamily: F.serif, fontSize: 16, fontWeight: '900' },

  // WheelPicker (horizontal scroll-wheel for putt distance)
  wheelWrap: {
    height: 64, backgroundColor: C.bg, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
    position: 'relative', justifyContent: 'center',
  },
  wheelSelector: {
    position: 'absolute', top: 4, bottom: 4,
    backgroundColor: C.gold + '14',
    borderLeftWidth: 1, borderRightWidth: 1, borderColor: C.gold + '88',
  },
  wheelArrow: {
    position: 'absolute', top: 0, width: 8, height: 6,
    borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 6,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: C.gold,
  },
  wheelItem: { alignItems: 'center', justifyContent: 'center', height: '100%' },
  wheelItemText: { color: C.textMuted, fontSize: 14, fontWeight: '600' },
  wheelItemMajor: { color: C.text, fontSize: 16, fontWeight: '800' },
  wheelItemActive: { color: C.gold, fontWeight: '900', fontFamily: F.serif, fontSize: 18 },
  wheelTick: {
    width: 1, height: 6, backgroundColor: C.border, marginTop: 4,
  },
  wheelTickMajor: { height: 10, backgroundColor: C.textMuted },
  wheelTickActive: { backgroundColor: C.gold, width: 2 },

  advCloseBtn: { marginTop: 20, alignSelf: 'center', padding: 10 },
  advCloseText: { color: C.gold, fontSize: 14, fontWeight: '700' },
});

// ── Geometry helpers (shared with derivation) ─────────────────────────────
const EARTH_R_M = 6371000;
const _toRad = (d: number) => d * Math.PI / 180;
function haversineYds(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = _toRad(b.lat - a.lat);
  const dLng = _toRad(b.lng - a.lng);
  const lat1 = _toRad(a.lat), lat2 = _toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return (2 * EARTH_R_M * Math.asin(Math.sqrt(h))) * 1.0936;
}
function bearingRad(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const lat1 = _toRad(a.lat), lat2 = _toRad(b.lat);
  const dLng = _toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return Math.atan2(y, x);
}

/**
 * Infer per-hole stat fields (fairwayHit/Miss, gir/greenMiss, putts, chips)
 * from a sequence of tracked shot SEGMENTS + the hole's pin location.
 *
 * Each shot is a segment: shot.start = where the player struck the ball,
 * shot.end = where it came to rest. So:
 *   • Shot 1's landing = shots[0].end
 *   • GIR shot's landing = shots[par - 3].end (par 3 → shot 1; par 4 → shot 2)
 *   • Putt count = shots whose start was on the green
 *
 * Returns only the fields it can confidently derive; everything else stays
 * undefined so the caller can leave manual values intact.
 */
function inferHoleStatsFromShots(
  shots: { start: { lat: number; lng: number }; end: { lat: number; lng: number } }[],
  hole: { par: number; pin_lat?: number | null; pin_lng?: number | null },
): {
  fairwayHit?: boolean;
  fairwayMiss?: 'left' | 'right' | null;
  gir?: boolean;
  greenMiss?: 'left' | 'right' | 'short' | 'long' | null;
  putts?: number;
  chips?: number;
} {
  if (!hole.pin_lat || !hole.pin_lng || shots.length === 0) return {};
  const pin = { lat: hole.pin_lat, lng: hole.pin_lng };
  const tee = shots[0].start;
  const centerB = bearingRad(tee, pin);
  const teeToPinYds = haversineYds(tee, pin);

  // Project a point onto the tee→pin axis: returns { lateral, longitudinal }
  // both in yards. Lateral positive = right of line. Longitudinal = forward.
  const project = (p: { lat: number; lng: number }) => {
    const d = haversineYds(tee, p);
    const b = bearingRad(tee, p);
    let off = b - centerB;
    while (off > Math.PI) off -= 2 * Math.PI;
    while (off < -Math.PI) off += 2 * Math.PI;
    return { lateral: d * Math.sin(off), longitudinal: d * Math.cos(off) };
  };

  const GREEN_RADIUS_YDS = 12;     // ~36 ft — typical green effective radius
  const FAIRWAY_HALF_YDS = 25;     // ~30-yd-wide fairway; ±25 yds = forgiving

  const out: ReturnType<typeof inferHoleStatsFromShots> = {};

  // Fairway hit (par 4+, needs at least one shot recorded so we have a landing)
  if (hole.par >= 4 && shots.length >= 1) {
    const teeShotLanding = shots[0].end;
    const { lateral } = project(teeShotLanding);
    if (Math.abs(lateral) <= FAIRWAY_HALF_YDS) {
      out.fairwayHit = true;
      out.fairwayMiss = null;
    } else {
      out.fairwayHit = false;
      out.fairwayMiss = lateral > 0 ? 'right' : 'left';
    }
  }

  // GIR: did the player's `par − 2`th shot land on the green?
  // That shot is `shots[par - 3]` (zero-indexed). Par 3 → shots[0].end,
  // par 4 → shots[1].end, par 5 → shots[2].end.
  const girShotIdx = hole.par - 3;
  if (girShotIdx >= 0 && shots.length > girShotIdx) {
    const girLanding = shots[girShotIdx].end;
    const distToPin = haversineYds(girLanding, pin);
    if (distToPin <= GREEN_RADIUS_YDS) {
      out.gir = true;
      out.greenMiss = null;
    } else {
      out.gir = false;
      const { lateral, longitudinal } = project(girLanding);
      const distMiss = longitudinal - teeToPinYds;
      if (Math.abs(lateral) > Math.abs(distMiss)) {
        out.greenMiss = lateral > 0 ? 'right' : 'left';
      } else {
        out.greenMiss = distMiss > 0 ? 'long' : 'short';
      }
    }
  }

  // Putts and chips — count shots whose START was on/near the green.
  // On-green = within GREEN_RADIUS_YDS of pin; chip = 12–30 yds out.
  let putts = 0, chips = 0;
  for (const shot of shots) {
    const dist = haversineYds(shot.start, pin);
    if (dist <= GREEN_RADIUS_YDS) putts += 1;
    else if (dist <= 30) chips += 1;
  }
  if (shots.length > 0) {
    out.putts = putts;
    out.chips = chips;
  }

  return out;
}

// ── Weather details sheet helpers ────────────────────────────────────────
function WxStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.wxStatBox}>
      <Text style={styles.wxStatLabel}>{label}</Text>
      <Text style={styles.wxStatVal}>{value}</Text>
    </View>
  );
}
function WxRow({ label, yds, extra }: { label: string; yds: number; extra?: string }) {
  const rounded = Math.round(yds);
  if (Math.abs(rounded) < 1 && !extra) return null;
  const sign = rounded > 0 ? '+' : '';
  const color = rounded > 0 ? C.green : rounded < 0 ? C.red : C.text;
  return (
    <View style={styles.wxLineRow}>
      <Text style={styles.wxLineLabel}>{label}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.wxLineYds, { color }]}>{sign}{rounded} yds</Text>
        {extra && <Text style={styles.wxLineExtra}>{extra}</Text>}
      </View>
    </View>
  );
}

// ── Advanced entry modal ──────────────────────────────────────────────────
// Lets the player record the direction of fairway and green misses, plus the
// distance of each individual putt. All optional; informs strokes-gained.

// Putt distances are stored as integers in feet, range 0–80. The wheel
// picker renders that range; the data model accepts any non-negative int.
const PUTT_MAX_FT = 80;

function AdvancedEntryModal({
  visible, onClose, holePar, stat, onChange,
}: {
  visible: boolean;
  onClose: () => void;
  holePar: number;
  stat: any | undefined;
  onChange: (patch: Record<string, any>) => void;
}) {
  const fwMiss = stat?.fairwayMiss ?? null;
  const fwHit  = stat?.fairwayHit ?? null;
  const grMiss = stat?.greenMiss ?? null;
  const gir    = stat?.gir ?? null;
  const putts  = stat?.putts ?? 0;
  const dists: number[] = stat?.puttDistances ?? [];

  // Set the i-th putt distance, padding with default 0 for any earlier
  // putts the player hasn't dialed in yet.
  const setPuttDist = (i: number, d: number) => {
    const next = [...dists];
    while (next.length <= i) next.push(0);
    next[i] = d;
    // Trim to current putt count so we don't store stale entries.
    onChange({ puttDistances: next.slice(0, putts) });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.advBackdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.advSheet}>
          {/* Header: drag handle + title + close, fixed at top */}
          <View style={styles.advSheetHeader}>
            <View style={styles.advSheetGrip} />
            <View style={styles.advSheetTitleRow}>
              <Text style={[styles.advTitle, { flex: 1, textAlign: 'left' }]}>Hole Detail</Text>
              <TouchableOpacity onPress={onClose} style={styles.advHeaderClose}>
                <Text style={styles.advHeaderCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView
            style={styles.advSheetInner}
            contentContainerStyle={{ paddingBottom: 60 }}
            showsVerticalScrollIndicator={true}
          >

            {/* Putts + Chips counts — basic numbers */}
            <Text style={styles.advSection}>SHOT COUNTS</Text>
            <View style={styles.advCountsRow}>
              <StatStepper
                label="Putts"
                value={stat?.putts ?? null}
                onChange={(v) => onChange({ putts: v })}
              />
              <StatStepper
                label="Chips"
                value={stat?.chips ?? null}
                onChange={(v) => onChange({ chips: v })}
              />
            </View>

            {/* Fairway miss — only relevant on par 4+ */}
            {holePar >= 4 && (
              <>
                <Text style={styles.advSection}>FAIRWAY</Text>
                <View style={styles.dirRow}>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === false && fwMiss === 'left' && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: false, fairwayMiss: 'left' })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === false && fwMiss === 'left' && styles.dirBtnTextActive]}>← LEFT</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === true && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: true, fairwayMiss: null })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === true && styles.dirBtnTextActive]}>FAIRWAY</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dirBtn, fwHit === false && fwMiss === 'right' && styles.dirBtnActive]}
                    onPress={() => onChange({ fairwayHit: false, fairwayMiss: 'right' })}
                  >
                    <Text style={[styles.dirBtnText, fwHit === false && fwMiss === 'right' && styles.dirBtnTextActive]}>RIGHT →</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* Green miss — compass rose */}
            <Text style={styles.advSection}>GREEN</Text>
            <View style={styles.greenRose}>
              {/* LONG */}
              <TouchableOpacity
                style={[styles.greenSide, gir === false && grMiss === 'long' && styles.dirBtnActive]}
                onPress={() => onChange({ gir: false, greenMiss: 'long' })}
              >
                <Text style={[styles.dirBtnText, gir === false && grMiss === 'long' && styles.dirBtnTextActive]}>↑ LONG</Text>
              </TouchableOpacity>
              {/* LEFT — HIT — RIGHT */}
              <View style={styles.greenRoseRow}>
                <TouchableOpacity
                  style={[styles.greenSide, gir === false && grMiss === 'left' && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: false, greenMiss: 'left' })}
                >
                  <Text style={[styles.dirBtnText, gir === false && grMiss === 'left' && styles.dirBtnTextActive]}>← LEFT</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.greenCenter, gir === true && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: true, greenMiss: null })}
                >
                  <Text style={[styles.dirBtnText, gir === true && styles.dirBtnTextActive]}>GREEN</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.greenSide, gir === false && grMiss === 'right' && styles.dirBtnActive]}
                  onPress={() => onChange({ gir: false, greenMiss: 'right' })}
                >
                  <Text style={[styles.dirBtnText, gir === false && grMiss === 'right' && styles.dirBtnTextActive]}>RIGHT →</Text>
                </TouchableOpacity>
              </View>
              {/* SHORT */}
              <TouchableOpacity
                style={[styles.greenSide, gir === false && grMiss === 'short' && styles.dirBtnActive]}
                onPress={() => onChange({ gir: false, greenMiss: 'short' })}
              >
                <Text style={[styles.dirBtnText, gir === false && grMiss === 'short' && styles.dirBtnTextActive]}>↓ SHORT</Text>
              </TouchableOpacity>
            </View>

            {/* Per-putt distance — scroll-wheel picker per putt */}
            <Text style={styles.advSection}>
              PUTT DISTANCES {putts === 0 ? '(set Putts on the basic screen first)' : `· ${putts} putt${putts === 1 ? '' : 's'}`}
            </Text>
            {Array.from({ length: putts }).map((_, i) => (
              <View key={i} style={styles.putRow}>
                <View style={styles.putHeader}>
                  <Text style={styles.putLabel}>Putt #{i + 1}</Text>
                  <Text style={styles.putVal}>
                    {dists[i] != null ? `${dists[i]} ft` : '— ft'}
                  </Text>
                </View>
                <WheelPicker
                  min={0}
                  max={PUTT_MAX_FT}
                  value={dists[i] ?? 0}
                  onChange={(v) => setPuttDist(i, v)}
                />
              </View>
            ))}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Horizontal scroll-wheel picker for integer values. Renders [min..max] as
 * fixed-width tiles, snaps to a tile on release, and reports the centered
 * tile via onChange. The center indicator shows which value is currently
 * selected.
 */
function WheelPicker({
  min, max, value, onChange,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  const ITEM_W = 44;
  const scrollRef = useRef<ScrollView>(null);
  const items = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, i) => min + i),
    [min, max]
  );
  const [containerW, setContainerW] = useState(0);
  const sidePad = Math.max(0, (containerW - ITEM_W) / 2);

  // Snap the scroll position to the current value when it changes externally
  // (e.g. modal first opens). We skip if the user is mid-drag.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current || !scrollRef.current || containerW === 0) return;
    const idx = Math.max(0, Math.min(items.length - 1, value - min));
    scrollRef.current.scrollTo({ x: idx * ITEM_W, animated: false });
  }, [value, containerW, items.length, min]);

  const onMomentumEnd = (e: any) => {
    const x = e.nativeEvent.contentOffset.x;
    const idx = Math.round(x / ITEM_W);
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    const v = min + clamped;
    if (v !== value) onChange(v);
  };

  return (
    <View
      style={styles.wheelWrap}
      onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}
    >
      {/* Center selector: a vertical strip + arrow, marks the active value */}
      <View pointerEvents="none" style={[styles.wheelSelector, { left: containerW / 2 - ITEM_W / 2, width: ITEM_W }]} />
      <View pointerEvents="none" style={[styles.wheelArrow, { left: containerW / 2 - 4 }]} />

      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={ITEM_W}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: sidePad, alignItems: 'center' }}
        onScrollBeginDrag={() => { draggingRef.current = true; }}
        onScrollEndDrag={() => { draggingRef.current = false; }}
        onMomentumScrollEnd={onMomentumEnd}
      >
        {items.map((n) => {
          const active = n === value;
          // Highlight ticks at every 5 ft for easier visual reference.
          const isMajor = n % 5 === 0;
          return (
            <View key={n} style={[styles.wheelItem, { width: ITEM_W }]}>
              <Text style={[
                styles.wheelItemText,
                isMajor && styles.wheelItemMajor,
                active && styles.wheelItemActive,
              ]}>
                {n}
              </Text>
              <View style={[
                styles.wheelTick,
                isMajor && styles.wheelTickMajor,
                active && styles.wheelTickActive,
              ]} />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

