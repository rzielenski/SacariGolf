/**
 * Collapsible bottom score-panel state machine.
 *
 * Encapsulates the animated height + PanResponder so the screen file just
 * spreads `panResponder.panHandlers` on the drag area and reads
 * `panelAnim` / `panelExpanded` for layout.
 *
 *   const { panelAnim, panResponder, panelExpanded, snapPanel } = useScorePanel();
 *
 * Heights are passed in so the caller can tune to its layout. Defaults
 * mirror the values used in scoring/[id].tsx prior to extraction.
 */

import { useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';

export function useScorePanel(collapsedH = 110, expandedH = 380) {
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelAnim = useRef(new Animated.Value(collapsedH)).current;
  // Height at the start of the current drag — captured in onPanResponderGrant
  // so the move handler can compute the new height as a delta.
  const dragStartHeight = useRef(collapsedH);

  const snapPanel = (toExpanded: boolean) => {
    setPanelExpanded(toExpanded);
    Animated.spring(panelAnim, {
      toValue: toExpanded ? expandedH : collapsedH,
      useNativeDriver: false,
      friction: 12,
      tension: 120,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      // Only claim the gesture once vertical movement is unambiguous, so taps
      // on inner controls still go through.
      onMoveShouldSetPanResponder: (_, { dy }) => Math.abs(dy) > 6,
      onPanResponderGrant: () => {
        panelAnim.stopAnimation((val) => { dragStartHeight.current = val; });
      },
      onPanResponderMove: (_, { dy }) => {
        const next = Math.max(collapsedH, Math.min(expandedH, dragStartHeight.current - dy));
        panelAnim.setValue(next);
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        const endH = Math.max(collapsedH, Math.min(expandedH, dragStartHeight.current - dy));
        const mid = (collapsedH + expandedH) / 2;
        // Snap on either velocity OR position past the midpoint.
        const toExpanded = vy < -0.3 || (Math.abs(vy) <= 0.3 && endH > mid);
        snapPanel(toExpanded);
      },
    })
  ).current;

  return { panelAnim, panResponder, panelExpanded, snapPanel };
}
