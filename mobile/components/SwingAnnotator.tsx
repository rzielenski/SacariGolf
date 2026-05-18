/**
 * Swing annotator — freehand drawing layer over a recorded swing video.
 *
 * Lets the player draw lines / shapes on the playback frame (swing plane,
 * shoulder line, target line, etc.) and persists them with the recording.
 *
 *   <SwingAnnotator
 *     width={overlayW}
 *     height={overlayH}
 *     strokes={swing.annotations ?? []}
 *     drawing={drawingEnabled}
 *     mode={'pen' | 'eraser'}
 *     penColor={'#ffd60a'}
 *     onStrokesChange={(next) => persistStrokes(next)}
 *   />
 *
 * Rendering strategy: no react-native-svg dependency (none installed). Each
 * stroke is broken into segment-Views — for each consecutive pair of points
 * we render an absolutely-positioned 1-pixel-tall View, sized + rotated to
 * lie along that segment. Rounded ends + a slight shadow give the line a
 * smooth, hand-drawn appearance against busy video backgrounds.
 *
 * Eraser: tapping anywhere on the overlay in eraser mode finds the nearest
 * stroke (by minimum point-to-segment distance) and removes it whole. We
 * don't do partial-stroke erasing because the visual difference is small
 * and the implementation is dramatically simpler.
 *
 * Coords are normalized 0..1 in the overlay frame so a stored drawing
 * survives a device rotation or container resize.
 */

import React, { useMemo, useRef, useState } from 'react';
import { View, StyleSheet, PanResponder } from 'react-native';
import type { Stroke } from '../lib/rangeSession';

interface Props {
  /** Overlay size in pixels. Lines + touches map to these dimensions. */
  width: number;
  height: number;
  /** Strokes already saved on the swing — always rendered. */
  strokes: Stroke[];
  /** True if the overlay should accept touch input. When false, the
   *  layer is purely visual (pointerEvents="none") and the video player
   *  controls underneath remain interactive. */
  drawing: boolean;
  /** Pen mode draws a new stroke; eraser mode removes existing strokes. */
  mode: 'pen' | 'eraser';
  /** Hex color for new pen strokes. */
  penColor: string;
  /** Width in px (at the overlay's natural size) for new pen strokes. */
  penWidth?: number;
  /** Called when the saved strokes change — append for pen-up, splice for
   *  eraser hits. Caller is responsible for persisting. */
  onStrokesChange: (next: Stroke[]) => void;
}

export function SwingAnnotator({
  width, height, strokes, drawing, mode,
  penColor, penWidth = 4, onStrokesChange,
}: Props) {
  // The stroke currently under the finger. Tracked in component state so
  // its segments render in real-time as the user drags. Committed to
  // `strokes` (via onStrokesChange) on pan-release.
  const [active, setActive] = useState<Stroke | null>(null);
  const activeRef = useRef<Stroke | null>(null);
  activeRef.current = active;

  // Re-create the PanResponder whenever the mode / dimensions / pen-color
  // change so the closure captures the right values. Otherwise an
  // initial pen-mode responder would keep drawing forever even after the
  // user toggled to eraser.
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder:        () => drawing,
    onMoveShouldSetPanResponder:         () => drawing,
    onStartShouldSetPanResponderCapture: () => drawing,
    onMoveShouldSetPanResponderCapture:  () => drawing,
    onPanResponderTerminationRequest:    () => false,

    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      const x = clamp01(locationX / width);
      const y = clamp01(locationY / height);
      if (mode === 'eraser') {
        // Eraser-on-tap: hit-test against all stored strokes, drop the
        // closest one within a reasonable tolerance.
        const idx = nearestStrokeIndex(strokes, { x, y }, width, height);
        if (idx >= 0) {
          const next = [...strokes];
          next.splice(idx, 1);
          onStrokesChange(next);
        }
        return;
      }
      // Pen: start a new stroke at the touch point.
      setActive({
        id: `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        color: penColor,
        width: penWidth,
        points: [{ x, y }],
      });
    },

    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      const x = clamp01(locationX / width);
      const y = clamp01(locationY / height);
      if (mode === 'eraser') {
        // Continuous erase while dragging — finds + removes any stroke
        // the finger crosses over. Cheaper than per-segment hit testing.
        const idx = nearestStrokeIndex(strokes, { x, y }, width, height);
        if (idx >= 0) {
          const next = [...strokes];
          next.splice(idx, 1);
          onStrokesChange(next);
        }
        return;
      }
      // Pen: append the new sample to the active stroke. Skip a sample if
      // it's essentially on top of the previous one — keeps the stroke
      // arrays from blowing up while the finger is stationary.
      setActive((prev) => {
        if (!prev) return prev;
        const last = prev.points[prev.points.length - 1];
        if (last && Math.abs(last.x - x) < 0.002 && Math.abs(last.y - y) < 0.002) return prev;
        return { ...prev, points: [...prev.points, { x, y }] };
      });
    },

    onPanResponderRelease: () => {
      const finished = activeRef.current;
      if (finished && finished.points.length > 0) {
        onStrokesChange([...strokes, finished]);
      }
      setActive(null);
    },
    onPanResponderTerminate: () => {
      // Touch was cancelled mid-stroke — discard the in-progress stroke.
      setActive(null);
    },
  }), [drawing, mode, penColor, penWidth, width, height, strokes, onStrokesChange]);

  return (
    <View
      style={[StyleSheet.absoluteFill, { width, height }]}
      pointerEvents={drawing ? 'box-only' : 'none'}
      {...(drawing ? panResponder.panHandlers : {})}
    >
      {strokes.map((s) => (
        <StrokeView key={s.id} stroke={s} width={width} height={height} />
      ))}
      {active && (
        <StrokeView stroke={active} width={width} height={height} />
      )}
    </View>
  );
}

/** Renders one stroke as a series of oriented segment-Views.
 *
 *  Each segment between p[i] and p[i+1] is an absolutely-positioned View
 *  with `width = pixel length` and `height = strokeWidth`, rotated to lie
 *  along that segment. Endpoint dots fill the gap at every joint so the
 *  line doesn't show triangle teeth at sharp turns. */
function StrokeView({
  stroke, width, height,
}: { stroke: Stroke; width: number; height: number }) {
  const pts = stroke.points;
  if (pts.length === 0) return null;

  // Single-point stroke renders as a dot — keeps a quick tap from
  // disappearing visually.
  if (pts.length === 1) {
    const px = pts[0].x * width;
    const py = pts[0].y * height;
    return (
      <View
        pointerEvents="none"
        style={[
          styles.cap,
          {
            left: px - stroke.width / 2,
            top:  py - stroke.width / 2,
            width: stroke.width, height: stroke.width,
            borderRadius: stroke.width / 2,
            backgroundColor: stroke.color,
          },
        ]}
      />
    );
  }

  const segments = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ax = a.x * width, ay = a.y * height;
    const bx = b.x * width, by = b.y * height;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    segments.push(
      <View
        key={`seg-${stroke.id}-${i}`}
        pointerEvents="none"
        style={[
          styles.segment,
          {
            left: ax,
            top:  ay - stroke.width / 2,
            width: len,
            height: stroke.width,
            backgroundColor: stroke.color,
            transform: [{ rotate: `${angle}deg` }],
            transformOrigin: 'left center',
          } as any,
        ]}
      />,
    );
    // Round cap at the end of each segment so joints aren't faceted.
    segments.push(
      <View
        key={`cap-${stroke.id}-${i}`}
        pointerEvents="none"
        style={[
          styles.cap,
          {
            left: bx - stroke.width / 2,
            top:  by - stroke.width / 2,
            width: stroke.width, height: stroke.width,
            borderRadius: stroke.width / 2,
            backgroundColor: stroke.color,
          },
        ]}
      />,
    );
  }
  // Cap at the very first point too, so a stroke starts with a smooth
  // dot rather than a sharp edge.
  const first = pts[0];
  segments.unshift(
    <View
      key={`cap-${stroke.id}-start`}
      pointerEvents="none"
      style={[
        styles.cap,
        {
          left: first.x * width - stroke.width / 2,
          top:  first.y * height - stroke.width / 2,
          width: stroke.width, height: stroke.width,
          borderRadius: stroke.width / 2,
          backgroundColor: stroke.color,
        },
      ]}
    />,
  );
  return <>{segments}</>;
}

/** Find the index of the stroke closest to `pt` (in normalised coords),
 *  using minimum point-to-segment distance across all the stroke's
 *  segments. Returns -1 when nothing is within the tolerance threshold. */
function nearestStrokeIndex(
  strokes: Stroke[], pt: { x: number; y: number },
  width: number, height: number,
): number {
  // ~14px hit tolerance regardless of stroke width — generous enough that
  // a quick swipe over a thin line still erases it.
  const HIT_PX = 14;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const pts = s.points;
    if (pts.length === 0) continue;
    let d = Infinity;
    if (pts.length === 1) {
      const dx = (pts[0].x - pt.x) * width;
      const dy = (pts[0].y - pt.y) * height;
      d = Math.sqrt(dx * dx + dy * dy);
    } else {
      for (let j = 0; j < pts.length - 1; j++) {
        d = Math.min(d, segmentDistancePx(pts[j], pts[j + 1], pt, width, height));
      }
    }
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestDist <= HIT_PX ? bestIdx : -1;
}

/** Perpendicular distance from `p` to the segment a→b, all in normalised
 *  coords scaled to pixels via the overlay dimensions. */
function segmentDistancePx(
  a: { x: number; y: number }, b: { x: number; y: number },
  p: { x: number; y: number },
  width: number, height: number,
): number {
  const ax = a.x * width, ay = a.y * height;
  const bx = b.x * width, by = b.y * height;
  const px = p.x * width, py = p.y * height;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const dx2 = px - ax, dy2 = py - ay;
    return Math.sqrt(dx2 * dx2 + dy2 * dy2);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = px - cx, ddy = py - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const styles = StyleSheet.create({
  segment: {
    position: 'absolute',
    // Subtle dark shadow so the line reads against grass / sky / range
    // netting without needing a stroke outline.
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1 },
  },
  cap: {
    position: 'absolute',
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1 },
  },
});
