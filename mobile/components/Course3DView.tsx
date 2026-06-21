import React, { useMemo } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { MAPBOX_TOKEN, MAPBOX_STYLE, MAPBOX_EMBED_URL } from '../lib/mapbox';

/**
 * Course3DView — the Phase 1 "3D course view": Mapbox satellite on 3D terrain
 * with shots as 3D arcs (deck.gl ArcLayer) flying above the ground.
 *
 * It loads the renderer from a REAL https URL (web/ → /embed/hole-3d) rather
 * than an inline HTML string. That matters: a WebView fed raw HTML has no
 * origin, so Mapbox's tile/style workers never start and the map hangs forever
 * at "Starting map". Loading a served page gives a proper origin where the map
 * works normally. The shots + token are injected via window.__CFG__ before the
 * page's script runs, so the token never lives in committed source.
 *
 * Callers should only mount this when HAS_MAPBOX is true and fall back to the
 * 2D map otherwise.
 */
type LL = { lat: number; lng: number };
export type Shot3D = { start: LL; end: LL; color?: string };

function bearing(a: LL, b: LL): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const g = (x: number) => (x * 180) / Math.PI;
  const dL = r(b.lng - a.lng);
  const y = Math.sin(dL) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(dL);
  return (g(Math.atan2(y, x)) + 360) % 360;
}

function buildCfg(shots: Shot3D[], pin: LL | null, tee: LL | null, center: LL | null) {
  const pts: LL[] = shots.flatMap((s) => [s.start, s.end]);
  if (pin) pts.push(pin);
  if (tee) pts.push(tee);
  const lngs = pts.map((p) => p.lng);
  const lats = pts.map((p) => p.lat);
  const pad = 0.0008; // never let the box be degenerate (1 shot / identical pts)
  const bounds = pts.length
    ? [[Math.min(...lngs) - pad, Math.min(...lats) - pad], [Math.max(...lngs) + pad, Math.max(...lats) + pad]]
    : undefined;
  const head = (tee && pin) ? bearing(tee, pin)
    : (shots.length ? bearing(shots[0].start, shots[shots.length - 1].end) : 0);
  const cfg: Record<string, unknown> = { token: MAPBOX_TOKEN, style: MAPBOX_STYLE, shots, pin, bounds, bearing: head };
  // No shots (course/hole preview): frame on a center point instead of bounds.
  if (!bounds && center) { cfg.center = [center.lng, center.lat]; cfg.zoom = 16; }
  return cfg;
}

export function Course3DView({ shots, pin, tee, center, style }: {
  shots?: Shot3D[];
  pin?: LL | null;
  tee?: LL | null;
  center?: LL | null;
  style?: StyleProp<ViewStyle>;
}) {
  // Injected at document-start, so window.__CFG__ exists before the page runs.
  // The trailing `true;` avoids a known iOS injection quirk.
  const injected = useMemo(
    () => `window.__CFG__=${JSON.stringify(buildCfg(shots ?? [], pin ?? null, tee ?? null, center ?? null))};true;`,
    [shots, pin, tee, center],
  );
  return (
    <View style={[styles.fill, style]}>
      <WebView
        source={{ uri: `${MAPBOX_EMBED_URL}/embed/hole-3d?v=2` }}
        injectedJavaScriptBeforeContentLoaded={injected}
        originWhitelist={['*']}
        style={styles.fill}
        javaScriptEnabled
        domStorageEnabled
        androidLayerType="hardware"
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        onMessage={(e) => {
          try {
            const d = JSON.parse(e.nativeEvent.data);
            if (d?.msg) console.warn('[Course3DView]', d.type, d.msg);
          } catch { /* ignore */ }
        }}
        onError={(e) => console.warn('[Course3DView] webview error:', e.nativeEvent?.description)}
        onHttpError={(e) => console.warn('[Course3DView] http error:', e.nativeEvent?.statusCode)}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, overflow: 'hidden' } });
