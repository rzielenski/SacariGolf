/**
 * Skeleton overlay rendered on top of a swing video — shows the player's
 * body pose at one of the four keyframes (address / top / impact /
 * follow-through). Pure React Native using View + position absolute;
 * no SVG dependency.
 *
 *   <SwingPoseOverlay
 *     frame={analysis.poseKeyframes.top}
 *     width={videoWidth}
 *     height={videoHeight}
 *     accent="#d4a93f"
 *   />
 *
 * The joint positions in the `frame` are normalized 0-1 within the video
 * frame. Lines connecting joints (the "skeleton") are rendered as thin
 * absolutely-positioned Views with rotation applied via transform.
 */

import { StyleSheet, View } from 'react-native';
import type { PoseFrame } from '../lib/rangeSession';
import { C } from '../lib/colors';

interface Props {
  frame: PoseFrame;
  width: number;
  height: number;
  accent?: string;
  /** Joint marker diameter in px. Defaults to 8 — increase for bigger overlays. */
  jointSize?: number;
  /** Skeleton line width in px. */
  lineWidth?: number;
  /** When true, draws each joint as a labeled small chip so the user can
   *  see which joint is which. Useful for debugging / dev preview. */
  labels?: boolean;
}

/** Skeleton edges — pairs of joints connected by a line in the rendered
 *  figure. SportsBox-style schema: head as a top→bottom line, separate
 *  L/R shoulders, hips, knees, and feet. Lines from each shoulder to its
 *  same-side hip form the torso "rectangle"; the head sits on the
 *  shoulder line via headBottom connecting to both shoulders. */
const SKELETON_EDGES: [keyof PoseFrame, keyof PoseFrame][] = [
  // Head
  ['headTop', 'headBottom'],
  ['headBottom', 'leftShoulder'],
  ['headBottom', 'rightShoulder'],
  // Shoulders + arms
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  // Torso
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  // Hips + legs
  ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftFoot'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightFoot'],
];

export function SwingPoseOverlay({
  frame, width, height, accent = C.gold,
  jointSize = 9, lineWidth = 2.5, labels = false,
}: Props) {
  // Convert normalized 0-1 coords to pixel positions for this overlay size.
  const px = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height });

  return (
    <View
      style={[StyleSheet.absoluteFill, { width, height }]}
      pointerEvents="none"
    >
      {/* Skeleton edges — drawn first so joint dots sit on top. */}
      {SKELETON_EDGES.map(([a, b], i) => {
        const pa = px(frame[a]);
        const pb = px(frame[b]);
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        return (
          <View
            key={`edge-${i}`}
            style={[
              styles.edge,
              {
                left: pa.x,
                top: pa.y - lineWidth / 2,
                width: length,
                height: lineWidth,
                backgroundColor: accent,
                transform: [{ translateX: 0 }, { rotate: `${angle}deg` }],
                transformOrigin: 'left center',
              } as any,
            ]}
          />
        );
      })}

      {/* Joint dots — small filled circles with a dark border for contrast. */}
      {(Object.keys(frame) as (keyof PoseFrame)[]).map((k) => {
        const p = px(frame[k]);
        return (
          <View
            key={`joint-${k}`}
            style={[
              styles.joint,
              {
                left: p.x - jointSize / 2,
                top: p.y - jointSize / 2,
                width: jointSize,
                height: jointSize,
                borderRadius: jointSize / 2,
                backgroundColor: accent,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: 'absolute',
    borderRadius: 2,
    opacity: 0.85,
    // The skeleton line gets a slight dark outline via a shadow so the
    // overlay reads against a busy video background (grass, sky, etc).
    shadowColor: '#000',
    shadowOpacity: 0.7,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  joint: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: '#000',
    shadowColor: '#000',
    shadowOpacity: 0.8,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
