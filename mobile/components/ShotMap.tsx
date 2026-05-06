import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

const SHOT_COLORS = ['#4a9eff', '#9c2128', '#7aab78', '#bdb9aa', '#c89a45', '#a672b8', '#d4794a'];

type Shot = { lat: number; lng: number };

function distYards(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.09361;
}

export function ShotMapModal({
  visible,
  matchId,
  userId,
  username,
  holeNum,
  par,
  onClose,
}: {
  visible: boolean;
  matchId?: string | null;
  userId?: string | null;
  username?: string;
  holeNum?: number | null;
  par?: number | null;
  onClose: () => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !matchId || !userId || !holeNum) { setShots([]); return; }
    let cancelled = false;
    setLoading(true);
    api.matches.listShotTracks(matchId, userId)
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.hole_num === holeNum);
        setShots(row?.shots ?? []);
      })
      .catch(() => { if (!cancelled) setShots([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, matchId, userId, holeNum]);

  // Compute initial map region from shot extents
  const region: Region | undefined = shots.length > 0
    ? (() => {
        const lats = shots.map((s) => s.lat);
        const lngs = shots.map((s) => s.lng);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        return {
          latitude: (minLat + maxLat) / 2,
          longitude: (minLng + maxLng) / 2,
          latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.0015),
          longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.0015),
        };
      })()
    : undefined;

  // Per-segment distances
  const segments = shots.slice(1).map((s, i) => ({
    from: shots[i],
    to: s,
    yards: distYards(shots[i].lat, shots[i].lng, s.lat, s.lng),
  }));
  const totalYards = segments.reduce((a, b) => a + b.yards, 0);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.container}>
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Hole {holeNum}{par != null ? `  ·  Par ${par}` : ''}</Text>
            {username && <Text style={s.sub}>{username}</Text>}
          </View>
          <TouchableOpacity onPress={onClose} style={s.doneBtn}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={s.empty}><ActivityIndicator color={C.gold} size="large" /></View>
        ) : shots.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No shot track</Text>
            <Text style={s.emptySub}>This hole wasn't recorded.</Text>
          </View>
        ) : (
          <>
            <View style={s.mapWrap}>
              <MapView
                style={{ flex: 1 }}
                initialRegion={region}
                mapType="satellite"
                pitchEnabled={false}
                rotateEnabled={false}
              >
                {shots.slice(1).map((sh, i) => (
                  <Polyline
                    key={`l${i}`}
                    coordinates={[
                      { latitude: shots[i].lat, longitude: shots[i].lng },
                      { latitude: sh.lat, longitude: sh.lng },
                    ]}
                    strokeColor={SHOT_COLORS[i % SHOT_COLORS.length]}
                    strokeWidth={3}
                  />
                ))}
                {shots.map((sh, i) => (
                  <Marker
                    key={`m${i}`}
                    coordinate={{ latitude: sh.lat, longitude: sh.lng }}
                    anchor={{ x: 0.5, y: 0.5 }}
                  >
                    <View style={[s.dot, { backgroundColor: SHOT_COLORS[i % SHOT_COLORS.length] }]}>
                      <Text style={s.dotText}>{i + 1}</Text>
                    </View>
                  </Marker>
                ))}
              </MapView>
            </View>

            {/* Distance summary */}
            <View style={s.summary}>
              <View style={s.summaryRow}>
                <Text style={s.summaryLabel}>SHOTS</Text>
                <Text style={s.summaryValue}>{shots.length}</Text>
              </View>
              <View style={s.summaryRow}>
                <Text style={s.summaryLabel}>TOTAL</Text>
                <Text style={s.summaryValue}>{Math.round(totalYards)} yds</Text>
              </View>
            </View>

            {/* Per-shot distances */}
            <View style={s.shotList}>
              {segments.map((seg, i) => (
                <View key={i} style={s.shotRow}>
                  <View style={[s.shotRowDot, { backgroundColor: SHOT_COLORS[i % SHOT_COLORS.length] }]}>
                    <Text style={s.shotRowDotText}>{i + 1}→{i + 2}</Text>
                  </View>
                  <Text style={s.shotRowYards}>{Math.round(seg.yards)} yds</Text>
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.border, gap: 12,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  sub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  doneBtn: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  doneText: { color: '#000', fontWeight: '800', fontSize: 14 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6 },
  emptyTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySub: { color: C.textMuted, fontSize: 13 },

  mapWrap: { flex: 1, minHeight: 280 },

  dot: {
    width: 22, height: 22, borderRadius: 11,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3,
  },
  dotText: { color: '#fff', fontWeight: '900', fontSize: 11 },

  summary: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: C.card,
  },
  summaryRow: { alignItems: 'center' },
  summaryLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  summaryValue: { color: C.text, fontSize: 22, fontFamily: F.serif, fontWeight: '700', marginTop: 2 },

  shotList: { paddingHorizontal: 20, paddingVertical: 12, paddingBottom: 28 },
  shotRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 6,
  },
  shotRowDot: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
    minWidth: 50, alignItems: 'center',
  },
  shotRowDotText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  shotRowYards: { color: C.text, fontWeight: '700', fontSize: 14, fontFamily: F.serif },
});
