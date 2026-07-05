import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import MapView, { Marker, Polyline, Region } from 'react-native-maps';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { distYards, SHOT_COLORS } from '../lib/golfMath';

// Local narrower types — see comment in ShotMap.tsx for rationale.
type Pt = { lat: number; lng: number };
type Shot = { start: Pt; end: Pt; club?: string };

/**
 * Live spectator view. Polls the active-round endpoint for the current hole,
 * then fetches that user's shot track for the same hole every few seconds so
 * a friend can watch a round unfold in (near) real time.
 */
export function LiveSpectatorModal({
  visible,
  userId,
  username,
  onClose,
}: {
  visible: boolean;
  userId?: string | null;
  username?: string;
  onClose: () => void;
}) {
  const [active, setActive] = useState<any | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(false);

  // Poll active round every 10s while the modal is visible
  useEffect(() => {
    if (!visible || !userId) return;
    let cancelled = false;
    const fetchLive = async () => {
      try {
        setLoading(true);
        const a = await api.users.activeRound(userId);
        if (cancelled) return;
        setActive(a);
        if (a?.match_id) {
          const tracks = await api.matches.listShotTracks(a.match_id, userId);
          if (cancelled) return;
          const playedSoFar = a.hole_scores?.length ?? 0;
          const curHoleNum = Math.max(1, playedSoFar);
          const row = tracks.find((t) => t.hole_num === curHoleNum);
          const raw = (row?.shots as any[]) ?? [];
          // Normalise — accept either segment or legacy point format.
          if (!raw.length) {
            setShots([]);
          } else if (raw[0]?.start && raw[0]?.end) {
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
        } else {
          setShots([]);
        }
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    };
    fetchLive();
    const t = setInterval(fetchLive, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [visible, userId]);

  // Compute the map region from all shot endpoints. Memoized on `shots` so its
  // identity only changes when the tracked shots actually change (every 10s
  // poll), NOT on every render. A controlled `region` prop with a fresh object
  // identity each render forces react-native-maps to re-apply the camera and
  // re-lay-out the satellite tile view repeatedly, which accumulates native
  // map memory over a long spectate session.
  const region: Region | undefined = useMemo(() => {
    if (shots.length === 0) return undefined;
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
  }, [shots]);

  const segments = shots.map((s) => ({
    yards: distYards(s.start.lat, s.start.lng, s.end.lat, s.end.lng),
  }));
  const totalYards = segments.reduce((a, b) => a + b.yards, 0);

  const playedSoFar = active?.hole_scores?.length ?? 0;
  const totalSoFar = (active?.hole_scores ?? []).reduce((a: number, b: number) => a + b, 0);
  const curHoleNum = Math.max(1, playedSoFar);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.container}>
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <View style={s.liveTagRow}>
              <View style={s.liveDot} />
              <Text style={s.liveTag}>LIVE</Text>
            </View>
            <Text style={s.title}>{username ?? 'Spectator'}</Text>
            {active?.course_name && <Text style={s.sub}>{active.course_name} · {active.teebox_name ?? ''}</Text>}
          </View>
          <TouchableOpacity onPress={onClose} style={s.doneBtn}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        {!active ? (
          <View style={s.empty}>
            {loading
              ? <ActivityIndicator color={C.gold} size="large" />
              : <Text style={s.emptyMsg}>{username} isn't playing right now.</Text>}
          </View>
        ) : (
          <>
            <View style={s.statBar}>
              <View style={s.statCell}>
                <Text style={s.statLabel}>HOLE</Text>
                <Text style={s.statVal}>{curHoleNum}{active.num_holes ? ` / ${active.num_holes}` : ''}</Text>
              </View>
              <View style={s.statCell}>
                <Text style={s.statLabel}>SCORE</Text>
                <Text style={s.statVal}>{totalSoFar || '—'}</Text>
              </View>
              <View style={s.statCell}>
                <Text style={s.statLabel}>SHOTS THIS HOLE</Text>
                <Text style={s.statVal}>{shots.length}</Text>
              </View>
            </View>

            <View style={s.mapWrap}>
              {shots.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyMsg}>No shots tracked on this hole yet.</Text>
                  <Text style={s.emptyHint}>Updates every 10 seconds.</Text>
                </View>
              ) : (
                <MapView
                  style={{ flex: 1 }}
                  initialRegion={region}
                  region={region}
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
                          tracksViewChanges={false}
                        >
                          <View style={[s.dot, { backgroundColor: color }]}>
                            <Text style={s.dotText}>{i + 1}</Text>
                          </View>
                        </Marker>
                        <Marker
                          coordinate={{ latitude: shot.end.lat, longitude: shot.end.lng }}
                          anchor={{ x: 0.5, y: 0.5 }}
                          tracksViewChanges={false}
                        >
                          <View style={[s.endDot, { borderColor: color }]} />
                        </Marker>
                      </React.Fragment>
                    );
                  })}
                </MapView>
              )}
            </View>

            {shots.length > 1 && (
              <View style={s.totalsRow}>
                <Text style={s.totalsLabel}>HOLE DISTANCE SO FAR</Text>
                <Text style={s.totalsVal}>{Math.round(totalYards)} yds</Text>
              </View>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingTop: 20, paddingHorizontal: 20, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: C.border, gap: 12,
  },
  liveTagRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  liveTag: { color: C.green, fontWeight: '900', letterSpacing: 1.2, fontSize: 10 },
  title: { color: C.text, fontSize: 20, fontWeight: '900', fontFamily: F.serif },
  sub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  doneBtn: { backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  doneText: { color: '#000', fontWeight: '800', fontSize: 14 },

  statBar: {
    flexDirection: 'row', backgroundColor: C.card,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  statCell: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  statLabel: { color: C.textMuted, fontWeight: '800', fontSize: 9, letterSpacing: 1 },
  statVal: { color: C.text, fontFamily: F.serif, fontSize: 22, fontWeight: '700', marginTop: 4 },

  mapWrap: { flex: 1, minHeight: 280 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 6 },
  emptyMsg: { color: C.text, fontSize: 14, textAlign: 'center' },
  emptyHint: { color: C.textMuted, fontSize: 11 },

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

  totalsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card,
  },
  totalsLabel: { color: C.textMuted, fontWeight: '800', fontSize: 10, letterSpacing: 1 },
  totalsVal: { color: C.gold, fontFamily: F.serif, fontSize: 18, fontWeight: '700' },
});
