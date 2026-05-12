/**
 * Foreground GPS tracking with on-course detection.
 *
 *   const { userCoord, onCourse, locGranted } = useLocation({
 *     enabled: !selectingCourse,
 *     courseLat: course?.latitude,
 *     courseLng: course?.longitude,
 *     onOffCourse: () => setFollowing(false),
 *   });
 *
 * Requests foreground permission, grabs a fresh fix (maximumAge: 0 avoids the
 * stale-cached-position bug seen on some Androids), then subscribes to
 * watchPositionAsync at 2-metre granularity. Whenever the user is outside
 * ON_COURSE_METRES of the course centre, `onCourse` flips false and the
 * optional `onOffCourse` callback fires (used by the parent to stop
 * auto-following on the map).
 *
 * Subscription is torn down on unmount or when `enabled` flips false.
 */

import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { distMetres } from '../../../../lib/golfMath';

const ON_COURSE_MILES = 3;
const ON_COURSE_METRES = ON_COURSE_MILES * 1609.34;

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
}

export function useLocation({ enabled, courseLat, courseLng, onOffCourse }: UseLocationArgs) {
  const [userCoord, setUserCoord] = useState<UserCoord | null>(null);
  const [onCourse, setOnCourse] = useState(true);
  const [locGranted, setLocGranted] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  // Stash callback in a ref so we don't tear down the subscription
  // every time the parent re-renders with a new lambda.
  const offCourseCb = useRef(onOffCourse);
  offCourseCb.current = onOffCourse;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const cLat = courseLat ?? 0;
    const cLng = courseLng ?? 0;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      if (!active) return;
      setLocGranted(true);

      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
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
      if (!near) offCourseCb.current?.();

      watchRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2 },
        (loc) => {
          if (!active) return;
          const c: UserCoord = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            altitude: loc.coords.altitude,
          };
          const near2 = !cLat || distMetres(c.latitude, c.longitude, cLat, cLng) <= ON_COURSE_METRES;
          setOnCourse(near2);
          if (!near2) offCourseCb.current?.();
          setUserCoord(c);
        },
      );
    })();
    return () => {
      active = false;
      watchRef.current?.remove();
      watchRef.current = null;
    };
  }, [enabled, courseLat, courseLng]);

  return { userCoord, onCourse, locGranted };
}
