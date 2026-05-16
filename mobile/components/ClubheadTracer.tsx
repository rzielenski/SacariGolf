/**
 * Clubhead trace overlay — renders the path the clubhead followed through
 * the swing as a series of fading dots (older points fainter, newer points
 * brighter). Optionally animates along a playback time so the trace draws
 * in sync with video playback.
 *
 *   <ClubheadTracer
 *     trace={analysis.clubheadTrace}
 *     width={videoW}
 *     height={videoH}
 *     currentTimeSec={playbackTime}      // undefined = show full trace
 *     impactTimeSec={analysis.impactTimeSec}
 *   />
 *
 * Each dot is a tiny absolutely-positioned View. We render a fixed sample
 * count (≤ 60 points typically) so render cost is negligible even when
 * scrubbing.
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
  /** Per-tier accent color override. Defaults to gold. */
  accent?: string;
  /** Largest dot diameter (newest sample). Older dots scale down. */
  dotSize?: number;
}

export function ClubheadTracer({
  trace, width, height,
  currentTimeSec, impactTimeSec,
  accent = C.gold, dotSize = 8,
}: Props) {
  // Filter to only the points the playback has reached, if a time cursor
  // is provided. Otherwise show every sample.
  const visible = currentTimeSec == null
    ? trace
    : trace.filter((p) => p.t <= currentTimeSec);

  // For each visible point, fade older points toward transparent.
  // Newest (visible[last]) is fully opaque; oldest fades to ~15%.
  return (
    <View
      style={[StyleSheet.absoluteFill, { width, height }]}
      pointerEvents="none"
    >
      {visible.map((p, i) => {
        const ageFrac = visible.length > 1 ? i / (visible.length - 1) : 1;
        // Slight size taper too — visually reinforces that the trace was
        // drawn in time.
        const size = dotSize * (0.5 + 0.5 * ageFrac);
        const isImpact = impactTimeSec != null
          && Math.abs(p.t - impactTimeSec) < 0.03; // ~30ms tolerance
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
                backgroundColor: isImpact ? '#fff' : accent,
                opacity: 0.15 + 0.85 * ageFrac,
                ...(isImpact && {
                  borderWidth: 2,
                  borderColor: accent,
                  shadowColor: accent,
                  shadowOpacity: 0.9,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 0 },
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
                  left: impactPoint.x * width + 8,
                  top: impactPoint.y * height - 8,
                  borderColor: accent,
                },
              ]}
            >
              <Text style={[styles.impactLabelText, { color: accent }]}>IMPACT</Text>
            </View>
          );
        })()}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
  },
  impactLabel: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
  },
  impactLabelText: {
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
