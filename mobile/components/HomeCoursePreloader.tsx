import React, { useEffect, useRef, useState } from 'react';
import { View, AppState } from 'react-native';
import MapView from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Pre-warm the OS map tile cache for the user's home course.
 *
 * Strategy: mount an off-screen MapView centered on the home course at the
 * zoom levels typical for scoring (~17-18). Apple Maps (iOS) and Google Maps
 * (Android) cache loaded tiles in their internal cache (default ~30 day TTL),
 * so the next time the user opens the scoring screen at this course the tiles
 * load instantly even on a flaky connection.
 *
 * This is a best-effort warm-up, not true offline support. It runs at most
 * once every 24 hours per home course (tracked via AsyncStorage), and only
 * fires when the app is foregrounded with a home course set.
 */
const PRELOAD_KEY_PREFIX = 'home_course_preload_';
const PRELOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function HomeCoursePreloader({
  courseId,
  lat,
  lng,
}: {
  courseId?: string | null;
  lat?: number | null;
  lng?: number | null;
}) {
  const [shouldRun, setShouldRun] = useState(false);
  const [done, setDone] = useState(false);
  const cycleIdx = useRef(0);
  const [region, setRegion] = useState<{ latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number } | null>(null);

  // Decide whether to pre-load: needs lat/lng + last-preload >24h ago
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!courseId || lat == null || lng == null) return;
      try {
        const stamp = await AsyncStorage.getItem(`${PRELOAD_KEY_PREFIX}${courseId}`);
        const last = stamp ? parseInt(stamp, 10) : 0;
        if (Date.now() - last < PRELOAD_TTL_MS) return; // cached recently, skip
      } catch { /* fall through to run */ }
      if (cancelled) return;
      setShouldRun(true);
    })();
    return () => { cancelled = true; };
  }, [courseId, lat, lng]);

  // Cycle through a few sub-regions of the course to warm tiles across the
  // whole property (a single MapView at one center loads only ~9-16 tiles).
  useEffect(() => {
    if (!shouldRun || lat == null || lng == null) return;
    // Four overlapping panels covering ~1.5km² total
    const offsets = [
      { dLat:  0.000,  dLng:  0.000 },
      { dLat:  0.003,  dLng:  0.003 },
      { dLat: -0.003,  dLng:  0.003 },
      { dLat:  0.003,  dLng: -0.003 },
      { dLat: -0.003,  dLng: -0.003 },
    ];
    setRegion({
      latitude: lat + offsets[0].dLat,
      longitude: lng + offsets[0].dLng,
      latitudeDelta: 0.006,
      longitudeDelta: 0.006,
    });
    const interval = setInterval(() => {
      cycleIdx.current += 1;
      if (cycleIdx.current >= offsets.length) {
        clearInterval(interval);
        AsyncStorage.setItem(`${PRELOAD_KEY_PREFIX}${courseId}`, Date.now().toString()).catch(() => { });
        setDone(true);
        return;
      }
      const o = offsets[cycleIdx.current];
      setRegion({
        latitude: lat + o.dLat,
        longitude: lng + o.dLng,
        latitudeDelta: 0.006,
        longitudeDelta: 0.006,
      });
    }, 2500);
    return () => clearInterval(interval);
  }, [shouldRun, lat, lng, courseId]);

  // Pause preloading when app goes to background (Android tile loading can
  // continue draining battery in the background).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') setDone(true);
    });
    return () => sub.remove();
  }, []);

  if (!shouldRun || done || !region) return null;

  return (
    <View
      style={{
        position: 'absolute',
        left: -10000, top: -10000,
        width: 200, height: 200,
        opacity: 0,
      }}
      pointerEvents="none"
    >
      <MapView
        style={{ flex: 1 }}
        mapType="satellite"
        region={region}
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
      />
    </View>
  );
}
