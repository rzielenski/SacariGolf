/**
 * Clubhead trace overlay — renders the path the clubhead followed through
 * the swing as a continuous two-color line. Backswing samples are drawn in
 * one color (default: a muted dark gold for the "up and back" portion);
 * downswing + follow-through samples in a brighter contrasting color.
 *
 *   <ClubheadTracer
 *     trace={analysis.clubheadTrace}
 *     width={videoW}
 *     height={videoH}
 *     currentTimeSec={playbackTime}      // undefined = show full trace
 *     impactTimeSec={analysis.impactTimeSec}
 *   />
 *
 * Rendering strategy: 60 sample points → 60 small dots with size + spacing
 * tuned so adjacent dots overlap, producing a continuous-looking line
 * without needing a SVG path component (no react-native-svg dependency).
 *
 * Phase split happens at t = totalSec / 2, which corresponds to the top of
 * the backswing (u=0.5 in the trace's u→t map). Before the split = backswing
 * color; at/after = downswing + follow-through color. The impact moment
 * (u=0.75) gets a special highlighted marker.
 *
 * IMPORTANT: until the Vision-framework per-frame clubhead detection lands,
 * this is a SCHEMATIC trace based on a generic swing template — it shows
 * the canonical swing shape but doesn't track the actual clubhead in any
 * specific video. The impact position assumes ball at (0.50, 0.70) for
 * face-on or (0.62, 0.66) for down-the-line.
 */

import { StyleSheet, View, Text } from 'react-native';
import { C } from '../lib/colors';

interface Props {
  trace: { x: number; y: number; t: number }[];
  width: number;
  height: number;
  /** When set, only draws points whose `t` is ≤ currentTimeSec — the trace
   *  appears to draw itself during playback. Undefined draws the full path. */
  currentTimeSec?: number;
  /** Time of impact in the trace — gets a special bigger marker. */
  impactTimeSec?: number;
  /** Backswing color — drawn for points before the top of backswing.
   *  Default = matte dark gold so it reads as "track behind, less important." */
  backswingColor?: string;
  /** Downswing + follow-through color — drawn for points at/after the top.
   *  Default = bright crimson to mirror the canonical instruction-video
   *  red-arc-on-downswing visualisation. */
  downswingColor?: string;
  /** Diameter of each sample dot. 10 keeps adjacent samples overlapping
   *  on a typical 60-sample path so the line reads as continuous. */
  dotSize?: number;
}

export function ClubheadTracer({
  trace, width, height,
  currentTimeSec, impactTimeSec,
  backswingColor = '#1f1c18',     // matte dark — matches the steel border color
  downswingColor = '#e63946',     // crimson red — matches instruction-video convention
  dotSize = 10,
}: Props) {
  // Filter to only the points the playback has reached, if a time cursor
  // is provided. Otherwise show every sample.
  const visible = currentTimeSec == null
    ? trace
    : trace.filter((p) => p.t <= currentTimeSec);

  // Total trace duration — used to decide which color each point gets.
  // Phase split is at exactly the halfway mark in the trace's u→t map
  // (which corresponds to the top of the backswing, u=0.5).
  const totalT = trace.length > 0 ? trace[trace.length - 1].t : 1;
  const splitT = totalT / 2;

  return (
    <View
      style={[StyleSheet.absoluteFill, { width, height }]}
      pointerEvents="none"
    >
      {visible.map((p, i) => {
        const isBackswing = p.t < splitT;
        const isImpact = impactTimeSec != null
          && Math.abs(p.t - impactTimeSec) < (totalT / trace.length); // 1 sample tolerance
        const color = isImpact
          ? '#fff'
          : isBackswing ? backswingColor : downswingColor;
        const size = isImpact ? dotSize * 1.6 : dotSize;
        return (
          <View
            key={`pt-${i}`}
            style={[
              styles.dot,
              {
                left: p.x * width - size / 2,
                top: p.y * height - size / 2,
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                ...(isImpact && {
                  borderWidth: 2,
                  borderColor: downswingColor,
                  shadowColor: downswingColor,
                  shadowOpacity: 0.95,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 0 },
                  zIndex: 5,
                }),
              },
            ]}
          />
        );
      })}

      {/* Impact label — only shows once the trace has reached impact time. */}
      {impactTimeSec != null
        && (currentTimeSec == null || currentTimeSec >= impactTimeSec) && (() => {
          const impactPoint = trace.reduce((closest, p) =>
            Math.abs(p.t - impactTimeSec) < Math.abs(closest.t - impactTimeSec)
              ? p
              : closest,
            trace[0],
          );
          if (!impactPoint) return null;
          return (
            <View
              style={[
                styles.impactLabel,
                {
                  left: impactPoint.x * width + 14,
                  top: impactPoint.y * height - 10,
                  borderColor: downswingColor,
                },
              ]}
            >
              <Text style={[styles.impactLabelText, { color: downswingColor }]}>IMPACT</Text>
            </View>
          );
        })()}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    // Subtle outline so the trace reads against busy video backgrounds
    // (sky, grass, range netting) without getting lost.
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  impactLabel: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
  },
  impactLabelText: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
