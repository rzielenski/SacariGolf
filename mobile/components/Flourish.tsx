import React from 'react';
import { View, Text, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { C, F } from '../lib/colors';

// ─────────────────────────────────────────────────────────────────────────────
// Decorative pieces for the Sacari Golf UI. Pure View shapes — no unicode
// or emoji glyphs — so they render identically across platforms and never
// surprise us with a rendered emoji.
// ─────────────────────────────────────────────────────────────────────────────

/** A small rotated square that reads as a diamond / lozenge. */
export function Diamond({
  size = 6,
  color = C.gold,
  filled = true,
  style,
}: {
  size?: number;
  color?: string;
  filled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          backgroundColor: filled ? color : 'transparent',
          borderWidth: filled ? 0 : 1,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        },
        style,
      ]}
    />
  );
}

/** Three small diamonds stacked horizontally as a center ornament. */
function TripleDiamond({ color = C.gold, size = 5 }: { color?: string; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Diamond size={size - 1} color={color} filled={false} />
      <Diamond size={size + 1} color={color} />
      <Diamond size={size - 1} color={color} filled={false} />
    </View>
  );
}

/**
 * A horizontal rule with a centered diamond ornament.
 *   <Divider />
 */
export function Divider({
  color = C.gold,
  style,
  triple = true,
}: {
  color?: string;
  style?: StyleProp<ViewStyle>;
  triple?: boolean;
}) {
  return (
    <View style={[s.dividerRow, style]}>
      <View style={[s.dividerLine, { backgroundColor: color + '55' }]} />
      {triple ? <TripleDiamond color={color} /> : <Diamond size={6} color={color} />}
      <View style={[s.dividerLine, { backgroundColor: color + '55' }]} />
    </View>
  );
}

/**
 * A section title flanked by small diamonds.
 *   <OrnamentTitle title="Recent Rounds" />
 */
export function OrnamentTitle({
  title,
  color = C.gold,
  align = 'left',
  style,
}: {
  title: string;
  color?: string;
  align?: 'left' | 'center';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        s.titleRow,
        align === 'center' ? { justifyContent: 'center' } : { justifyContent: 'flex-start' },
        style,
      ]}
    >
      <Diamond size={5} color={color} />
      <Text style={[s.titleText, { color: C.textMuted }]}>{title.toUpperCase()}</Text>
      <Diamond size={5} color={color} />
    </View>
  );
}

/**
 * Small absolutely-positioned corner diamond. Place inside a relatively-
 * positioned parent. Mimics the brass corner flourishes on the cover art.
 */
export function CornerOrnament({
  corner = 'tl',
  color = C.gold,
  size = 6,
}: {
  corner?: 'tl' | 'tr' | 'bl' | 'br';
  color?: string;
  size?: number;
}) {
  const positionStyle: ViewStyle =
    corner === 'tl' ? { top: 8, left: 8 } :
    corner === 'tr' ? { top: 8, right: 8 } :
    corner === 'bl' ? { bottom: 8, left: 8 } :
                      { bottom: 8, right: 8 };
  return (
    <View style={[s.corner, positionStyle]} pointerEvents="none">
      <Diamond size={size} color={color} filled={false} />
    </View>
  );
}

/**
 * Wraps any content in a card with all four corner diamond flourishes.
 */
export function FlourishCard({
  children,
  style,
  padding = 16,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padding?: number;
}) {
  return (
    <View style={[s.flourishCard, { padding }, style]}>
      <CornerOrnament corner="tl" />
      <CornerOrnament corner="tr" />
      <CornerOrnament corner="bl" />
      <CornerOrnament corner="br" />
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12 },
  dividerLine: { flex: 1, height: 1 },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  titleText: { fontSize: 11, fontWeight: '800', letterSpacing: 2, fontFamily: F.serif },

  corner: { position: 'absolute' },

  flourishCard: {
    backgroundColor: C.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    position: 'relative',
  },
});
