/**
 * Foreground GPS + barometer tracking with quality filtering, fix buffering,
 * weighted-average sampling, and on-course detection.
 *
 *   const {
 *     userCoord, onCourse, locGranted,
 *     gpsAccuracyM, hasQualityFix,
 *     getAveragedFix, getRelativeAltitudeM,
 *   } = useLocation({
 *     enabled: !selectingCourse,
 *     courseLat: course?.latitude,
 *     courseLng: course?.longitude,
 *     onOffCourse: () => setFollowing(false),
 *   });
 *
 * Architecture (see research report in earlier conversation for sources):
 *
 *   1. Single long-running watchPositionAsync at Highest accuracy
 *      (kCLLocationAccuracyBest, the max the hardware can produce). We never
 *      call getCurrentPositionAsync mid-round — that forces a fresh fix and
 *      kills the GPS chip's hot-start state.
 *
 *   2. Quality filter on every incoming fix:
 *        • drop if horizontalAccuracy < 0 (invalid sentinel)
 *        • drop if horizontalAccuracy > ACCEPT_MAX_ACCURACY_M (65m)
 *        • drop if timestamp older than STALE_FIX_MS (5s) — guards against
 *          iOS handing back a cached fix on subscription start
 *        • discard the first WARMUP_FIXES (5) regardless — the GPS chip
 *          needs a few cycles to converge even at Highest accuracy
 *
 *   3. Maintain a rolling buffer of the last FIX_BUFFER_LIMIT (30) accepted
 *      fixes (~30s at 1Hz native rate). `getAveragedFix(windowMs)` returns
 *      an inverse-variance weighted mean (w_i = 1/accuracy_i²) over the
 *      window — this is the closed-form maximum-likelihood estimate under
 *      Gaussian errors with reported variances, what consumer GNSS receivers
 *      do internally. Used by shot-tracking when the user taps TRACK to
 *      get a yard-grade position fix instead of a single noisy sample.
 *
 *   4. Barometer (CMAltimeter relativeAltitude via expo-sensors): runs in
 *      parallel and exposes the *current* relative altitude via a ref-backed
 *      getter. The absolute value is meaningless (relative to wherever the
 *      sensor started), but deltas between two snapshots are sub-meter
 *      accurate on the timescale of one shot or one hole — vastly better
 *      than GPS altitude for plays-like slope. We do NOT fold this into
 *      userCoord every render (that would re-trigger every consumer); we
 *      stash it on the latest fix when buffering and let consumers pull
 *      a fresh value on demand.
 *
 *   5. Subscriptions torn down on unmount or when `enabled` flips false.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { Barometer } from 'expo-sensors';
import { distMetres } from '../../../../lib/golfMath';

const ON_COURSE_MILES = 3;
const ON_COURSE_METRES = ON_COURSE_MILES * 1609.34;

/** Soft outer bound — fixes worse than this are GPS-cold or indoors-grade. */
const ACCEPT_MAX_ACCURACY_M = 65;
/** First-N-fixes-after-start filter (warm-up garbage). */
const WARMUP_FIXES = 5;
/** Reject any fix older than this relative to now (iOS sometimes returns a
 *  cached position when the subscription first starts). */
const STALE_FIX_MS = 5_000;
/** Accuracy at or below which we consider the fix "trusted" enough to anchor
 *  shot points. Anything above falls through to "use the best we have but
 *  surface a low-accuracy flag." */
const TRUST_ACCURACY_M = 10;
/** Rolling buffer of recent accepted fixes — sized for the longest
 *  weighted-average window the callers ask for (currently 2.5s). 30 fixes
 *  ≈ 30s at the native 1Hz iOS rate; gives plenty of headroom. */
const FIX_BUFFER_LIMIT = 30;
/** Spatial coherence threshold used by getAveragedFix to detect "the player
 *  has been standing still" vs "the player is walking." Only fixes within
 *  this radius of the most recent fix are kept for averaging — without this,
 *  a player who taps TRACK immediately after walking to the ball would have
 *  the start point smeared along the walking path. 6m ≈ 6.5 yds: large
 *  enough to keep all the stationary-stand jitter on a 5m-accuracy fix,
 *  tight enough to reject walking-pace samples (1.5 m/s × 2.5s = 3.75m,
 *  so a walking sample 1+ seconds back is excluded). */
const STILL_RADIUS_M = 6;
/** If userCoord has been frozen (no accepted display fix) for this long, the
 *  staleness filter is bypassed so the next available fix — even a cached,
 *  old-timestamped one iOS hands back after pausing the watch — un-sticks the
 *  position. A slightly-stale fix is far better than a position frozen at
 *  "the last place you stood" until the app is restarted. */
const STUCK_ESCAPE_MS = 15_000;

interface BufferedFix {
  lat: number;
  lng: number;
  altitude: number | null;
  accuracy: number;
  /** Barometer relativeAltitude (m) captured at the same moment, if known. */
  baroRelativeM: number | null;
  /** Local clock ms — used for window filtering. */
  capturedAt: number;
}

export interface UserCoord {
  latitude: number;
  longitude: number;
  altitude?: number | null;
}

interface UseLocationArgs {
  enabled: boolean;
  courseLat?: number | null;
  courseLng?: number | null;
  onOffCourse?: () => void;
  /** When set, GPS is skipped entirely and this fixed coord is reported as
   *  userCoord. Used by Course Preview to pin the player to the tee box. */
  forced?: UserCoord | null;
}

export function useLocation({ enabled, courseLat, courseLng, onOffCourse, forced }: UseLocationArgs) {
  const [userCoord, setUserCoord] = useState<UserCoord | null>(null);
  const [onCourse, setOnCourse] = useState(true);
  const [locGranted, setLocGranted] = useState(false);
  const [gpsAccuracyM, setGpsAccuracyM] = useState<number | null>(null);
  const [hasQualityFix, setHasQualityFix] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const baroSubRef = useRef<{ remove: () => void } | null>(null);

  /** Most-recent barometer reading, captured outside of React state so we
   *  don't re-render on every barometer tick (10Hz default). */
  const baroRelativeMRef = useRef<number | null>(null);
  /** Rolling buffer of accepted fixes, newest last. Refs (not state) because
   *  we don't want consumers re-rendering on every push. */
  const fixBufferRef = useRef<BufferedFix[]>([]);
  /** Counts fixes seen so far this subscription, to drop the warm-up batch. */
  const fixesSeenRef = useRef(0);
  /** Wall-clock of the LAST accepted display-path fix. Drives the
   *  "GPS stale" UI indicator + the foreground-resume kick. */
  const lastFixAtRef = useRef<number | null>(null);

  // Stash callback in a ref so we don't tear down the subscription
  // every time the parent re-renders with a new lambda.
  const offCourseCb = useRef(onOffCourse);
  offCourseCb.current = onOffCourse;

  useEffect(() => {
    // Forced coord (Course Preview): no GPS — just report the fixed point as
    // the player's position so every distance/heatmap consumer works from it.
    if (forced) {
      setUserCoord(forced);
      setOnCourse(true);
      setLocGranted(true);
      setHasQualityFix(true);
      setGpsAccuracyM(null);
      return;
    }
    if (!enabled) return;
    let active = true;
    const cLat = courseLat ?? 0;
    const cLng = courseLng ?? 0;
    fixesSeenRef.current = 0;
    fixBufferRef.current = [];

    // ── Barometer (CMAltimeter) ──────────────────────────────────────────
    // Best-effort: simulator and devices without the chip return false.
    // We don't gate location on it — barometric altitude is a bonus, not
    // a requirement.
    (async () => {
      try {
        const supported = await Barometer.isAvailableAsync();
        if (!supported || !active) return;
        // 1 Hz is plenty — we only need a fresh sample at TRACK-press time,
        // and CMAltimeter's noise floor is already tiny.
        Barometer.setUpdateInterval(1000);
        baroSubRef.current = Barometer.addListener((data: any) => {
          if (!active) return;
          // expo-sensors returns relativeAltitude in METERS on iOS via
          // CMAltimeter; some platforms only return `pressure`, in which
          // case relativeAltitude is undefined. Android phones with a
          // barometer expose pressure (hPa) only — relativeAltitude would
          // need a sea-level baseline.
          if (typeof data?.relativeAltitude === 'number' && isFinite(data.relativeAltitude)) {
            baroRelativeMRef.current = data.relativeAltitude;
          }
        });
      } catch { /* sensor missing or permission denied — skip silently */ }
    })();

    // ── GPS ──────────────────────────────────────────────────────────────
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      if (!active) return;
      setLocGranted(true);

      // One-shot fresh fix to populate userCoord ASAP. We do NOT trust this
      // for shot tracking (it bypasses the warm-up filter), but it gets the
      // map centered and the "yards to pin" reading on screen quickly.
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Highest,
          maximumAge: 0,
        } as any);
        if (!active) return;
        const coord: UserCoord = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
        };
        const near = !cLat || distMetres(coord.latitude, coord.longitude, cLat, cLng) <= ON_COURSE_METRES;
        setOnCourse(near);
        setUserCoord(coord);
        if (typeof pos.coords.accuracy === 'number' && pos.coords.accuracy >= 0) {
          setGpsAccuracyM(pos.coords.accuracy);
        }
        if (!near) offCourseCb.current?.();
      } catch { /* initial fix can fail in low-signal areas — watch will recover */ }

      // The continuous watch — kCLLocationAccuracyBest under the hood, max
      // hardware accuracy.
      //
      // distanceInterval: 0 means "fire every native cycle" — iOS will push
      // ~1 fix/second whether the player is moving or standing still. CRITICAL
      // for shot tracking: a stationary golfer over the ball produces ZERO
      // callbacks at distanceInterval: 2 (since they haven't moved 2m), so
      // the inverse-variance-weighted average had nothing to average and
      // silently fell back to whatever stale fix came in 5+ seconds ago when
      // the player was last walking. Setting interval to 0 keeps the buffer
      // fresh during the address-the-ball pause where the user is about to
      // tap TRACK.
      //
      // timeInterval is Android-only on expo-location; iOS uses native cadence.
      watchRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Highest, distanceInterval: 0, timeInterval: 1000 },
        (loc) => {
          if (!active) return;
          fixesSeenRef.current += 1;

          const rawAcc = typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : -1;
          const ts = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now();
          const ageMs = Date.now() - ts;

          // Quality gate. We still want the user to *see* their position on
          // the map even from a noisy fix (better than no blue dot), so we
          // split into two paths:
          //   • Buffer-quality fix → push to the rolling buffer used by
          //     weighted-average sampling.
          //   • Display-quality fix → update userCoord so the map dot moves.
          // The buffer is stricter than the display path.

          const isBufferQuality =
            rawAcc > 0                    // strictly >0: a 0 (or −1 "unknown")
                                          // accuracy would make the 1/acc²
                                          // inverse-variance weight Infinity
                                          // and poison the averaged fix to NaN
            && rawAcc <= ACCEPT_MAX_ACCURACY_M
            && ageMs <= STALE_FIX_MS
            && fixesSeenRef.current > WARMUP_FIXES;

          if (isBufferQuality) {
            const fix: BufferedFix = {
              lat: loc.coords.latitude,
              lng: loc.coords.longitude,
              altitude: loc.coords.altitude ?? null,
              accuracy: rawAcc,
              baroRelativeM: baroRelativeMRef.current,
              // Use the fix's own timestamp (when iOS got it from the chip),
              // not Date.now() (when JS got the callback). Delivery latency
              // on iOS can be 100s of ms, so Date.now() lets fixes that are
              // actually 2.8s old slip into a "last 2.5s" window.
              capturedAt: ts,
            };
            const buf = fixBufferRef.current;
            buf.push(fix);
            if (buf.length > FIX_BUFFER_LIMIT) buf.shift();
            if (rawAcc <= TRUST_ACCURACY_M) setHasQualityFix(true);
          }

          // Display update — accept any non-invalid fix. The user-visible
          // map dot updates from this; tracked shot endpoints do not.
          //
          // Bad-fix filtering (added after a user reported the bottom-
          // right "TO PIN" yardage was stuck at the last shot's endpoint
          // distance for an entire hole — likely a single noisy fix
          // landing far off, or an iOS-paused subscription returning a
          // garbage 0/0 cached reading):
          //   • drop NaN / non-finite coords
          //   • drop the (0,0) "null island" sentinel — appears when iOS
          //     hands back an uninitialised cached fix
          //   • drop fixes with horizontal accuracy worse than 200m;
          //     anything that bad is room-scale noise from a phone in a
          //     deep pocket and would jump the user dot wildly
          //   • drop fixes timestamped >30s in the past, regardless of
          //     accuracy — they're cached stale-after-resume fixes
          // Staleness drop WITH an escape hatch. Normally we reject fixes
          // whose own timestamp is >30s old (iOS hands back cached fixes
          // after it pauses the watch — common when the player stands still
          // to measure a distance or address a shot). But if userCoord has
          // already been frozen for STUCK_ESCAPE_MS, accepting a
          // stale-but-present fix is far better than staying frozen: it's the
          // difference between "GPS catches up in a few seconds" and "stuck
          // until app restart." A stationary player's cached position is, by
          // definition, still roughly where they are.
          const stuckMs = lastFixAtRef.current == null ? Infinity : Date.now() - lastFixAtRef.current;
          const staleAndNotStuck = ageMs > 30_000 && stuckMs < STUCK_ESCAPE_MS;
          if (
            !Number.isFinite(loc.coords.latitude)
            || !Number.isFinite(loc.coords.longitude)
            || (Math.abs(loc.coords.latitude) < 0.001 && Math.abs(loc.coords.longitude) < 0.001)
            || (rawAcc >= 0 && rawAcc > 200)
            || staleAndNotStuck
          ) {
            return;
          }
          if (rawAcc >= 0) setGpsAccuracyM(rawAcc);
          const c: UserCoord = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            altitude: loc.coords.altitude,
          };
          const near2 = !cLat || distMetres(c.latitude, c.longitude, cLat, cLng) <= ON_COURSE_METRES;
          setOnCourse(near2);
          if (!near2) offCourseCb.current?.();
          setUserCoord(c);
          lastFixAtRef.current = Date.now();
        },
      );
    })();

    // ── GPS watchdog — restart a silently-dead watcher ───────────────
    // The single biggest source of "TO PIN yardage stuck on the wrong
    // value" bug reports: iOS pauses watchPositionAsync subscriptions
    // when the app moves to inactive (even briefly — notification UI,
    // proximity-sensor screen-off in pocket, system permission sheet)
    // and does NOT auto-resume on return-to-active. The subscription
    // object stays valid; it just never fires another callback. The
    // app's `userCoord` is then frozen at whatever it was just before
    // the pause. The user walks to the next hole, distance-to-pin
    // doesn't update, and they think the app is broken.
    //
    // This interval polls every 10s. If we haven't received a fix in
    // 25+ seconds, we tear down the watch and re-subscribe — that
    // forces iOS to give us a brand-new live stream. Also runs the
    // initial fresh `getCurrentPositionAsync` so userCoord catches up
    // immediately rather than waiting for the watcher's first callback.
    const watchdog = setInterval(async () => {
      if (!active) return;
      const last = lastFixAtRef.current;
      const sinceMs = last == null ? Infinity : Date.now() - last;
      if (sinceMs < 25_000) return;

      // Tear down + restart the watch.
      try { watchRef.current?.remove(); } catch { /* noop */ }
      watchRef.current = null;
      fixesSeenRef.current = 0;
      try {
        // Kick the chip first so the user sees an updated position
        // immediately, even before the new watch starts firing.
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Highest,
          maximumAge: 0,
        } as any);
        if (active && Number.isFinite(pos.coords.latitude)
            && !(Math.abs(pos.coords.latitude) < 0.001 && Math.abs(pos.coords.longitude) < 0.001)) {
          // We've had NO accepted fix for 25s+ to even reach here, so even a
          // somewhat-cached position is a strict improvement over the frozen
          // userCoord. This previously rejected anything >10s old — which,
          // combined with the display filter dropping stale-timestamped
          // fixes, could leave userCoord frozen indefinitely (only an app
          // restart recovered it: the classic "distance stuck at the last
          // place I stood" bug). Accept whatever we get; the fresh watch
          // below refines it on its next real fix.
          setUserCoord({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            altitude: pos.coords.altitude,
          });
          lastFixAtRef.current = Date.now();
        }
      } catch { /* silent — retry on next interval */ }
      try {
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Highest, distanceInterval: 0, timeInterval: 1000 },
          (loc) => {
            if (!active) return;
            const rawAcc = typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : -1;
            // NOTE: no timestamp-staleness drop here. This watch only exists
            // because the watchdog already detected a freeze and restarted —
            // re-applying the >30s filter would re-create the very deadlock
            // we're recovering from (iOS hands back stale-ts cached fixes
            // right after a pause). Accept any finite, non-null-island,
            // not-absurdly-inaccurate fix so userCoord un-sticks.
            if (
              !Number.isFinite(loc.coords.latitude)
              || !Number.isFinite(loc.coords.longitude)
              || (Math.abs(loc.coords.latitude) < 0.001 && Math.abs(loc.coords.longitude) < 0.001)
              || (rawAcc >= 0 && rawAcc > 200)
            ) return;
            if (rawAcc >= 0) setGpsAccuracyM(rawAcc);
            setUserCoord({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              altitude: loc.coords.altitude,
            });
            lastFixAtRef.current = Date.now();
          },
        );
      } catch { /* silent */ }
    }, 10_000);

    // ── Foreground-resume listener ──────────────────────────────────────
    // iOS aggressively pauses location subscriptions when the app moves
    // to inactive/background — opening a system alert, the iOS chat
    // notification, the music app, etc. expo-location does NOT
    // auto-resume; the existing watchRef stays "alive" but stops firing
    // callbacks. From the user's perspective the GPS just freezes and
    // the "TO PIN" yardage gets stuck at whatever it was when they
    // backgrounded.
    //
    // Fix: on every foreground transition, kick the GPS chip with a
    // fresh getCurrentPositionAsync (forces a real fix) so the
    // watchPositionAsync subscription wakes back up and userCoord
    // resumes updating. Also re-arm a fresh watch if the previous one
    // is dead (no fix in the last 15s while in foreground).
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (!active) return;
      if (state !== 'active') return;
      // Force a fresh fix — this kicks the subscription back on iOS.
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        maximumAge: 0,
      } as any).then((pos) => {
        if (!active) return;
        if (!Number.isFinite(pos.coords.latitude)) return;
        const coord: UserCoord = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
        };
        setUserCoord(coord);
        lastFixAtRef.current = Date.now();
      }).catch(() => { /* permission revoked or GPS denied — silent */ });
    });

    return () => {
      active = false;
      watchRef.current?.remove();
      watchRef.current = null;
      baroSubRef.current?.remove();
      baroSubRef.current = null;
      baroRelativeMRef.current = null;
      appStateSub.remove();
      clearInterval(watchdog);
    };
  }, [enabled, courseLat, courseLng, forced?.latitude, forced?.longitude]);

  /** Inverse-variance weighted average of fixes received in the last
   *  `windowMs`. Returns null if no fixes have been buffered yet — caller
   *  should fall back to userCoord and surface a "low accuracy" warning.
   *
   *  Two filtering passes happen before averaging:
   *    1. TEMPORAL: only fixes whose own timestamp is within windowMs of
   *       the most-recent buffered fix's timestamp (NOT wall-clock now —
   *       wall-clock would discard the whole window if the user backgrounded
   *       the app for 30 seconds).
   *    2. SPATIAL: only fixes within STILL_RADIUS_M (6m) of the most-recent
   *       buffered fix. This is what makes the average robust when the
   *       player has been walking: a player who just arrived at the ball
   *       and immediately taps TRACK has 2.5s of walking fixes in the
   *       window, which would smear the start point ~3-4m back along the
   *       walk path. The spatial filter keeps only the cluster of fixes
   *       at the player's current location.
   *
   *  The weighting (w_i = 1/accuracy_i²) on the surviving fixes is the
   *  maximum-likelihood estimate under independent Gaussian errors with
   *  reported variances. In practice this means: a 3m-accuracy fix counts
   *  100× more than a 30m fix, so pooling a stationary 2-3s sample
   *  reliably eliminates outliers without any explicit outlier rejection.
   *
   *  Altitude is averaged with the same weights, but only over fixes that
   *  actually reported one (some iOS situations return null altitude). If
   *  any fix in the window had a barometer reading, the *median* barometer
   *  value is attached — median (not mean) because barometer noise is
   *  much tighter than 1/N averaging needs, but we want to ignore the
   *  rare spike. */
  const getAveragedFix = useCallback((windowMs: number): {
    latitude: number;
    longitude: number;
    altitude: number | null;
    baroRelativeM: number | null;
    accuracyM: number;
    samples: number;
  } | null => {
    const buf = fixBufferRef.current;
    if (!buf.length) return null;
    const newest = buf[buf.length - 1];

    // Temporal filter anchored on the newest fix, not wall-clock — covers
    // the case where the watch callback hasn't ticked in a few seconds.
    const tempWindow = buf.filter((f) => newest.capturedAt - f.capturedAt <= windowMs);
    if (!tempWindow.length) return null;

    // Spatial filter — only fixes near the player's current cluster. A pure
    // temporal filter would let walking-pace fixes from a few seconds ago
    // pull the average meters back along the walking path.
    const window = tempWindow.filter(
      (f) => distMetres(f.lat, f.lng, newest.lat, newest.lng) <= STILL_RADIUS_M,
    );
    if (!window.length) return null;

    let sumLat = 0, sumLng = 0, sumW = 0;
    let sumAlt = 0, altW = 0;
    const baroSamples: number[] = [];
    for (const f of window) {
      // Defensive: skip any fix that slipped in with non-positive accuracy
      // (would yield an Infinite/NaN weight). The buffer gate already
      // enforces accuracy > 0, but this keeps getAveragedFix safe in
      // isolation.
      if (!(f.accuracy > 0)) continue;
      const w = 1 / (f.accuracy * f.accuracy);
      sumLat += f.lat * w;
      sumLng += f.lng * w;
      sumW += w;
      if (typeof f.altitude === 'number') {
        sumAlt += f.altitude * w;
        altW += w;
      }
      if (typeof f.baroRelativeM === 'number') baroSamples.push(f.baroRelativeM);
    }
    if (sumW === 0) return null;
    // 1σ uncertainty of the weighted mean = 1/sqrt(Σw). With four 5m fixes
    // that's 2.5m, which matches what consumer survey gear claims.
    const accuracyM = Math.sqrt(1 / sumW);
    let baroMedian: number | null = null;
    if (baroSamples.length) {
      baroSamples.sort((a, b) => a - b);
      baroMedian = baroSamples[Math.floor(baroSamples.length / 2)];
    }
    return {
      latitude: sumLat / sumW,
      longitude: sumLng / sumW,
      altitude: altW > 0 ? sumAlt / altW : null,
      baroRelativeM: baroMedian,
      accuracyM,
      samples: window.length,
    };
  }, []);

  /** Current barometer relativeAltitude (m). null if barometer unsupported
   *  or hasn't ticked yet. Read from a ref so we don't render-couple. */
  const getRelativeAltitudeM = useCallback((): number | null => {
    return baroRelativeMRef.current;
  }, []);

  /** Milliseconds since the last accepted display-path fix, or null when
   *  we've never seen one. Drives the "GPS frozen" warning in the bottom
   *  of the scoring screen so a stuck "TO PIN" yardage is visible to the
   *  player rather than silently wrong. */
  const getMsSinceLastFix = useCallback((): number | null => {
    if (lastFixAtRef.current == null) return null;
    return Date.now() - lastFixAtRef.current;
  }, []);

  /** Drop the rolling fix buffer. Called by the scoring screen on
   *  current-hole change so a previous hole's fixes can't leak into the
   *  next hole's getAveragedFix() — the spatial-still filter alone
   *  doesn't help when the player walks 100+ yds between holes (every
   *  old fix is outside STILL_RADIUS_M and gets discarded silently,
   *  leaving the average with zero samples and falling back to whatever
   *  single raw fix happened to be most recent). */
  const resetFixBuffer = useCallback(() => {
    fixBufferRef.current = [];
  }, []);

  /** Force a fresh GPS read. Used as a manual "Unstick GPS" affordance
   *  when the foreground-resume kick wasn't enough — typically only
   *  needed after iOS background-pauses the watch for several minutes. */
  const refreshGps = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        maximumAge: 0,
      } as any);
      if (!Number.isFinite(pos.coords.latitude)) return;
      setUserCoord({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        altitude: pos.coords.altitude,
      });
      lastFixAtRef.current = Date.now();
    } catch { /* GPS denied / no signal — UI will keep showing the stale warning */ }
  }, []);

  /** Ingest a fix from react-native-maps' own native location stream
   *  (MapView.onUserLocationChange). This is the SAME source that draws the
   *  blue user dot — and crucially it's an INDEPENDENT subscription from our
   *  expo-location watch. Field reports showed the blue dot staying live and
   *  correct while distances/measure-line froze: that's expo-location's watch
   *  going silent (iOS pause, etc.) while react-native-maps' stream kept
   *  running. Feeding that live stream into the same pipeline (buffer +
   *  userCoord + heartbeat) makes the displayed position resilient — if one
   *  subscription stalls, the other keeps userCoord fresh. */
  const noteMapFix = useCallback((coord: {
    latitude?: number; longitude?: number; altitude?: number | null; accuracy?: number | null;
  } | null | undefined) => {
    if (!coord) return;
    const lat = coord.latitude, lng = coord.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return; // null island
    const acc = typeof coord.accuracy === 'number' ? coord.accuracy : -1;
    if (acc >= 0 && acc > 200) return;                          // room-scale noise
    // Feed the averaging buffer too (only trustworthy-accuracy fixes), so
    // shot tracking stays alive even if the expo watch is the one that stalled.
    if (acc > 0 && acc <= ACCEPT_MAX_ACCURACY_M) {
      const buf = fixBufferRef.current;
      buf.push({
        lat, lng,
        altitude: coord.altitude ?? null,
        accuracy: acc,
        baroRelativeM: baroRelativeMRef.current,
        capturedAt: Date.now(),
      });
      if (buf.length > FIX_BUFFER_LIMIT) buf.shift();
      if (acc <= TRUST_ACCURACY_M) setHasQualityFix(true);
    }
    if (acc >= 0) setGpsAccuracyM(acc);
    const cLat = courseLat ?? 0;
    const near = !cLat || distMetres(lat, lng, cLat, courseLng ?? 0) <= ON_COURSE_METRES;
    setOnCourse(near);
    if (!near) offCourseCb.current?.();
    setUserCoord((prev) => ({
      latitude: lat,
      longitude: lng,
      // Preserve the last known altitude when a map fix doesn't carry one, so
      // we never wipe a good GPS-altitude reading. Altitude is only the
      // FALLBACK slope input anyway — barometer + crowdsourced course
      // elevation are the primary sources — but keeping it intact means the
      // map-fed path is never worse than the expo-fed path for slope.
      altitude: typeof coord.altitude === 'number' ? coord.altitude : (prev?.altitude ?? null),
    }));
    lastFixAtRef.current = Date.now();
  }, [courseLat, courseLng]);

  return {
    userCoord,
    onCourse,
    locGranted,
    gpsAccuracyM,
    hasQualityFix,
    getAveragedFix,
    getRelativeAltitudeM,
    getMsSinceLastFix,
    refreshGps,
    resetFixBuffer,
    noteMapFix,
  };
}
