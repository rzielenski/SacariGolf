import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { useLocalSearchParams, router } from 'expo-router';
import { C, F } from '../../../lib/colors';
import { distMetres, distYards } from '../../../lib/golfMath';

const ON_COURSE_MILES = 3;
const ON_COURSE_METRES = ON_COURSE_MILES * 1609.34;

function isOnCourse(userLat: number, userLng: number, cLat: number, cLng: number): boolean {
  return distMetres(userLat, userLng, cLat, cLng) <= ON_COURSE_METRES;
}

function fmtYards(yds: number): string {
  if (yds < 10) return `${yds.toFixed(1)} yds`;
  return `${Math.round(yds)} yds`;
}

export default function CourseMapScreen() {
  const { courseLat, courseLng, holeNum, holePar, holeYardage } =
    useLocalSearchParams<{
      courseLat: string;
      courseLng: string;
      holeNum: string;
      holePar: string;
      holeYardage?: string;
    }>();

  const cLat = parseFloat(courseLat);
  const cLng = parseFloat(courseLng);

  const mapRef = useRef<MapView>(null);
  const [userCoord, setUserCoord] = useState<{ latitude: number; longitude: number } | null>(null);
  const [measurePin, setMeasurePin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [following, setFollowing] = useState(true);
  const [onCourse, setOnCourse] = useState(true);
  const [locGranted, setLocGranted] = useState(false);
  const [locLoading, setLocLoading] = useState(true);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  // Request location permission and start watching
  useEffect(() => {
    let active = true;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocLoading(false);
        Alert.alert(
          'Location needed',
          'Enable location in Settings to use the distance tool.',
        );
        return;
      }
      setLocGranted(true);

      // Get a quick initial fix (Highest = kCLLocationAccuracyBest, max
      // hardware accuracy — about 5x more accurate than High at the same
      // battery cost on iPhone). Wrapped in try/catch: the initial fix can
      // reject on a cold start in low signal (kCLErrorLocationUnknown). If it
      // does, we skip centering here but must still clear the loader and start
      // the watch so a later fix recovers the screen.
      try {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
        if (!active) return;
        const coord = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        const near = isOnCourse(coord.latitude, coord.longitude, cLat, cLng);
        setOnCourse(near);
        setUserCoord(coord);
        if (!near) setFollowing(false);
      } catch {
        /* initial fix can fail in low-signal areas — watch will recover */
      } finally {
        if (active) setLocLoading(false);
      }
      if (!active) return;

      // Then watch for updates. distanceInterval: 0 + timeInterval: 1000 keeps
      // fixes arriving ~1/sec even while the golfer stands still — the whole
      // point of this screen is tap-to-measure while stationary, and at
      // distanceInterval: 2 a motionless player gets ZERO callbacks so the
      // measured yardage silently goes stale.
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Highest, distanceInterval: 0, timeInterval: 1000 },
        (loc) => {
          if (!active) return;
          const c = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          const near = isOnCourse(c.latitude, c.longitude, cLat, cLng);
          setOnCourse(near);
          if (!near) setFollowing(false);
          setUserCoord(c);
        },
      );
      // If the user backed out during the subscribe delay, cleanup already ran
      // (active=false) before this resolved — tear down the now-live sub so it
      // doesn't leak, and don't stash it in the ref.
      if (!active) {
        sub.remove();
        return;
      }
      watchRef.current = sub;
    })();
    return () => {
      active = false;
      watchRef.current?.remove();
    };
  }, []);

  // Re-center map on user when following is on and user is near the course
  useEffect(() => {
    if (following && onCourse && userCoord && mapRef.current) {
      mapRef.current.animateToRegion(
        {
          latitude: userCoord.latitude,
          longitude: userCoord.longitude,
          latitudeDelta: 0.003,
          longitudeDelta: 0.003,
        },
        400,
      );
    }
  }, [userCoord, following, onCourse]);

  const handleMapPress = useCallback(
    (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
      setMeasurePin(e.nativeEvent.coordinate);
      // Tapping map means user is manually navigating — stop auto-follow
      setFollowing(false);
    },
    [],
  );

  const clearPin = () => setMeasurePin(null);

  const goToMe = () => {
    if (!onCourse) return;
    setFollowing(true);
    if (userCoord && mapRef.current) {
      mapRef.current.animateToRegion(
        {
          latitude: userCoord.latitude,
          longitude: userCoord.longitude,
          latitudeDelta: 0.003,
          longitudeDelta: 0.003,
        },
        400,
      );
    }
  };

  const distance =
    userCoord && measurePin
      ? distYards(userCoord.latitude, userCoord.longitude, measurePin.latitude, measurePin.longitude)
      : null;

  // Initial region: user if available, else course coordinates
  const initialRegion: Region = {
    latitude: userCoord?.latitude ?? cLat,
    longitude: userCoord?.longitude ?? cLng,
    latitudeDelta: 0.004,
    longitudeDelta: 0.004,
  };

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={styles.holeInfo}>
          <Text style={styles.holeNum}>Hole {holeNum}</Text>
          <Text style={styles.holeMeta}>
            Par {holePar}{holeYardage ? ` · ${holeYardage} yds` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.followBtn, following && onCourse && styles.followBtnActive, !onCourse && styles.followBtnOff]}
          onPress={goToMe}
          disabled={!onCourse}
        >
          <Text style={[styles.followBtnText, following && onCourse && styles.followBtnTextActive]}>
            {!onCourse ? 'Off Course' : following ? 'Following' : 'Find Me'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Map */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={initialRegion}
        showsUserLocation={locGranted}
        showsMyLocationButton={false}
        showsCompass
        mapType="satellite"
        onPress={handleMapPress}
        onPanDrag={() => setFollowing(false)}
      >
        {/* Measure pin */}
        {measurePin && (
          <>
            {/* tappable + tracksViewChanges off: prevents the marker from
                swallowing nearby re-taps (a react-native-maps iOS gotcha). */}
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

            {/* Line from user to pin */}
            {userCoord && (
              <Polyline
                coordinates={[userCoord, measurePin]}
                strokeColor={C.gold}
                strokeWidth={2}
                lineDashPattern={[6, 4]}
              />
            )}
          </>
        )}
      </MapView>

      {/* Distance banner */}
      {distance !== null && (
        <View style={styles.distBanner}>
          <Text style={styles.distNum}>{fmtYards(distance)}</Text>
          <Text style={styles.distLabel}>tap-to-pin distance</Text>
          <TouchableOpacity style={styles.clearBtn} onPress={clearPin}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Hint when no pin */}
      {distance === null && (
        <View style={styles.hintBar}>
          <Text style={styles.hintText}>Tap the map to measure distance</Text>
        </View>
      )}

      {/* Location loading indicator */}
      {locLoading && (
        <View style={styles.locLoader}>
          <ActivityIndicator color={C.gold} size="small" />
          <Text style={styles.locLoaderText}>Getting GPS...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 60, paddingBottom: 12, paddingHorizontal: 16,
    backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border,
    zIndex: 10,
  },
  backBtn: { paddingRight: 8 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  holeInfo: { alignItems: 'center' },
  holeNum: { color: C.text, fontWeight: '900', fontSize: 16 },
  holeMeta: { color: C.textMuted, fontSize: 11, marginTop: 1 },
  followBtn: {
    borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  followBtnActive: { borderColor: C.gold, backgroundColor: C.gold + '22' },
  followBtnOff: { borderColor: C.border, opacity: 0.5 },
  followBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 12 },
  followBtnTextActive: { color: C.gold },

  map: { flex: 1 },

  pinOuter: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: C.gold + 'aa', borderWidth: 2, borderColor: C.gold,
    justifyContent: 'center', alignItems: 'center',
  },
  pinInner: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff',
  },

  distBanner: {
    position: 'absolute', bottom: 40, alignSelf: 'center',
    backgroundColor: C.bg + 'f0', borderRadius: 6,
    borderWidth: 1, borderColor: C.gold,
    paddingVertical: 12, paddingHorizontal: 20,
    flexDirection: 'row', alignItems: 'center', gap: 14,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  distNum: { fontFamily: F.serif, color: C.gold, fontSize: 26, fontWeight: '700' },
  distLabel: { color: C.textMuted, fontSize: 11, flex: 1 },
  clearBtn: {
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: C.border,
  },
  clearBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 12 },

  hintBar: {
    position: 'absolute', bottom: 40, alignSelf: 'center',
    backgroundColor: C.bg + 'cc', borderRadius: 6,
    paddingVertical: 8, paddingHorizontal: 16,
    borderWidth: 1, borderColor: C.border,
  },
  hintText: { color: C.textMuted, fontSize: 12 },

  locLoader: {
    position: 'absolute', top: 100, alignSelf: 'center',
    backgroundColor: C.bg + 'ee', borderRadius: 6,
    paddingVertical: 6, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: C.border,
  },
  locLoaderText: { color: C.textMuted, fontSize: 12 },
});
