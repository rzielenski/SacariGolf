/**
 * Clubhead trace overlay — renders the path the clubhead followed through
 * the swing as a continuous polyline that tracks the actual detected
 * trajectory points exactly.
 *
 *   <ClubheadTracer
 *     trace={analysis.clubheadTrace}
 *     width={videoW}
 *     height={videoH}
 *     currentTimeSec={playbackTime}      // undefined = show full trace
 *     impactTimeSec={analysis.impactTimeSec}
 *   />
 *
 * Rendering: each consecutive pair of (x, y) points becomes one oriented
 * View segment — exact same trick the swing-annotator + skeleton overlay
 * use. The segments share endpoints, so the line is geometrically
 * continuous (no "polka dot" gaps even when the upstream trajectory has
 * few, widely-spaced samples). This is the key difference from the prior
 * "60 overlapping dots" implementation, which only looked like a line
 * because the source was a dense template — when the real Vision-framework
 * VNDetectTrajectoriesRequest hands us 8-15 widely-spaced points (typical
 * for a golf swing), connected segments still show a coherent arc whereas
 * disconnected dots fall apart.
 *
 * Phase split at top-of-backswing (t = totalT / 2): segments before that
 * draw in `backswingColor` (muted), at/after in `downswingColor` (bright).
 * The impact moment gets a highlighted dot marker.
 */

import { StyleSheet, View, Text } from 'react-native';
import { C } from '../lib/colors';

interface Props {
  trace: { x: number; y: number; t: number }[];
  width: number;
  height: number;
  /** When set, only draws segments whose mid-time is ≤ currentTimeSec —
   *  the trace appears to draw itself during playback. Undefined draws
   *  the full path. */
  currentTimeSec?: number;
  /** Time of impact in the trace — gets a special bigger marker. */
  impactTimeSec?: number;
  /** Backswing color — drawn for segments before the top of backswing.
   *  Default = matte dark gold so it reads as "track behind, less
   *  important." */
  backswingColor?: string;
  /** Downswing + follow-through color — drawn for segments at/after the
   *  top. Default = bright crimson to mirror the canonical
   *  instruction-video red-arc-on-downswing visualisation. */
  downswingColor?: string;
  /** Line width in pixels. */
  lineWidth?: number;
}

export function ClubheadTracer({
  trace, width, height,
  currentTimeSec, impactTimeSec,
  backswingColor = '#8a6b18',
  downswingColor = '#e63946',
  lineWidth = 4,
}: Props) {
  if (trace.length === 0) return null;

  // Total trace duration — used to decide which color each segment gets.
  // Phase split is at the halfway point of the captured trace (which
  // corresponds to top-of-backswing in both the native trajectory and
  // the template fallback).
  const totalT = trace[trace.length - 1].t;
  const splitT = totalT / 2;

  // Segments are drawn between consecutive trace points. For each segment
  // we check whether its END time has been reached by the playback cursor
  // (so the line "extends" as the video plays). The endpoint-cap dots
  // fill the joint corners so sharp direction changes don't show triangle
  // teeth.
  const segments: React.ReactNode[] = [];

  // Initial cap at the first point so the trace starts with a smooth
  // rounded dot rather than a sharp corner.
  if (currentTimeSec == null || currentTimeSec >= trace[0].t) {
    const first = trace[0];
    segments.push(
      <View
        key="cap-start"
        style={[
          styles.cap,
          {
            left: first.x * width - lineWidth / 2,
            top:  first.y * height - lineWidth / 2,
            width: lineWidth, height: lineWidth,
            borderRadius: lineWidth / 2,
            backgroundColor: first.t < splitT ? backswingColor : downswingColor,
          },
        ]}
      />,
    );
  }

  for (let i = 0; i < trace.length - 1; i++) {
    const a = trace[i];
    const b = trace[i + 1];
    // Hide segments whose end time hasn't been reached yet. Keeps the
    // line growing as playback progresses.
    if (currentTimeSec != null && b.t > currentTimeSec) break;
    const ax = a.x * width, ay = a.y * height;
    const bx = b.x * width, by = b.y * height;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    // Color picked from the segment's MIDPOINT time so a phase boundary
    // doesn't land on a stale-looking edge.
    const midT = (a.t + b.t) / 2;
    const color = midT < splitT ? backswingColor : downswingColor;
    segments.push(
      <View
        key={`seg-${i}`}
        style={[
          styles.segment,
          {
            left: ax,
            top:  ay - lineWidth / 2,
            width: len,
            height: lineWidth,
            backgroundColor: color,
            transform: [{ rotate: `${angle}deg` }],
            transformOrigin: 'left center',
          } as any,
        ]}
      />,
    );
    // Round cap at the segment end — fills joint corners + the very end
    // of the trace.
    segments.push(
      <View
        key={`cap-${i}`}
        style={[
          styles.cap,
          {
            left: bx - lineWidth / 2,
            top:  by - lineWidth / 2,
            width: lineWidth, height: lineWidth,
            borderRadius: lineWidth / 2,
            backgroundColor: color,
          },
        ]}
      />,
    );
  }

  // Impact marker — a bigger white dot with a colored glow, placed at the
  // trace point closest to impactTimeSec. Only rendered once playback
  // has reached that moment (or always, when no playback cursor).
  let impactMarker: React.ReactNode = null;
  if (
    impactTimeSec != null
    && (currentTimeSec == null || currentTimeSec >= impactTimeSec)
  ) {
    const impactPoint = trace.reduce((closest, p) =>
      Math.abs(p.t - impactTimeSec) < Math.abs(closest.t - impactTimeSec)
        ? p
        : closest,
      trace[0],
    );
    if (impactPoint) {
      const size = lineWidth * 2.2;
      impactMarker = (
        <>
          <View
            style={[
              styles.impactDot,
              {
                left: impactPoint.x * width - size / 2,
                top:  impactPoint.y * height - size / 2,
                width: size, height: size, borderRadius: size / 2,
                borderColor: downswingColor,
                shadowColor: downswingColor,
              },
            ]}
          />
          <View
            style={[
              styles.impactLabel,
              {
                left: impactPoint.x * width + 12,
                top:  impactPoint.y * height - 10,
                borderColor: downswingColor,
              },
            ]}
          >
            <Text style={[styles.impactLabelText, { color: downswingColor }]}>IMPACT</Text>
          </View>
        </>
      );
    }
  }

  return (
    <View
      style={[StyleSheet.absoluteFill, { width, height }]}
      pointerEvents="none"
    >
      {segments}
      {impactMarker}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    position: 'absolute',
    // Subtle dark shadow so the line reads against busy video backgrounds
    // (sky, grass, range netting) without needing an outline View.
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  cap: {
    position: 'absolute',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  impactDot: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderWidth: 2,
    shadowOpacity: 0.95,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    zIndex: 5,
  },
  impactLabel: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
    zIndex: 6,
  },
  impactLabelText: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
