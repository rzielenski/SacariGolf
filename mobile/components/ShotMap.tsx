import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

// High-contrast palette tuned to stand out against satellite-imagery green.
const SHOT_COLORS = ['#4a9eff', '#e63946', '#ff66c4', '#ff9f1c', '#00bbf9', '#9d4edd', '#ffd60a'];

/** Normalised shot — the renderer treats both segment and legacy formats
 *  the same way once we've converted them on load. */
type Pt = { lat: number; lng: number };
type Shot = { start: Pt; end: Pt; club?: string };

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
        const raw = (row?.shots as any[]) ?? [];
        if (!raw.length) { setShots([]); return; }
        // Detect format and normalise to segment shape.
        if (raw[0]?.start && raw[0]?.end) {
          setShots(raw as Shot[]);
        } else {
          const segs: Shot[] = [];
          for (let i = 0; i < raw.length - 1; i++) {
            segs.push({
              start: { lat: raw[i].lat, lng: raw[i].lng },
              end:   { lat: raw[i + 1].lat, lng: raw[i + 1].lng },
              club:  raw[i]?.club,
            });
          }
          setShots(segs);
        }
      })
      .catch(() => { if (!cancelled) setShots([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, matchId, userId, holeNum]);

  // Compute initial map region from all shot endpoints
  const region: Region | undefined = shots.length > 0
    ? (() => {
        const allPts = shots.flatMap((s) => [s.start, s.end]);
        const lats = allPts.map((p) => p.lat);
        const lngs = allPts.map((p) => p.lng);
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

  // Per-shot distances
  const segments = shots.map((s) => ({
    yards: distYards(s.start.lat, s.start.lng, s.end.lat, s.end.lng),
    club: s.club,
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
                {shots.map((shot, i) => {
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
                        <View style={[s.dot, { backgroundColor: color }]}>
                          <Text style={s.dotText}>{i + 1}</Text>
                        </View>
                      </Marker>
                      <Marker
                        coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
                        anchor={{ x: 0.5, y: 0.5 }}
                      >
                        <View style={[s.endDot, { borderColor: color }]} />
                      </Marker>
                    </React.Fragment>
                  );
                })}
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
                    <Text style={s.shotRowDotText}>SHOT {i + 1}</Text>
                  </View>
                  {seg.club && <Text style={s.shotRowClub}>{seg.club.toUpperCase()}</Text>}
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
  endDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#fff', borderWidth: 3,
  },
  shotRowClub: { color: C.gold, fontWeight: '800', fontSize: 11 },

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
