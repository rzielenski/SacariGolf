/**
 * GolfAvatar — renders a player's custom golfer from an AvatarConfig as a
 * layered react-native-svg drawing. Static (no animation), so it's cheap to
 * render anywhere, and vector, so it's crisp at any size and ships OTA.
 *
 *   <GolfAvatar config={cfg} size={220} />            full body (builder / profile)
 *   <GolfAvatar config={cfg} size={40} mode="bust" /> head + shoulders (avatar slot)
 *
 * The whole figure is authored in a 200×340 viewBox centred on x=100; `bust`
 * mode just re-frames that same art to the head/shoulders. Everything is keyed
 * off the config via lib/avatar.ts lookups, so new styles/colours are additive.
 */
import Svg, {
  Path, Circle, Ellipse, Rect, G, Defs, RadialGradient, Stop,
} from 'react-native-svg';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  type AvatarConfig, skinTone, hairHex, clothHex, normalizeAvatar,
} from '../lib/avatar';

const VB_W = 200, VB_H = 340;
const CX = 100;

/** Lighten (amt>0) / darken (amt<0) a #hex. */
function shade(hex: string, amt: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

type Build = { shoulderHW: number; waistHW: number; hipHW: number };
function buildDims(build: string): Build {
  if (build === 'slim')  return { shoulderHW: 40, waistHW: 27, hipHW: 30 };
  if (build === 'broad') return { shoulderHW: 55, waistHW: 40, hipHW: 40 };
  return { shoulderHW: 47, waistHW: 32, hipHW: 34 };
}

// Key vertical anchors (px in the 200×340 viewBox).
const HEAD_CY = 78, HEAD_RX = 33, HEAD_RY = 36;
const SHOULDER_Y = 128, WAIST_Y = 210, HIP_Y = 216, KNEE_Y = 262, ANKLE_Y = 300;

export function GolfAvatar({
  config: rawConfig, size = 200, mode = 'full', background = true, style,
}: {
  /** Accepts a full AvatarConfig OR a raw/partial stored blob — normalized
   *  internally, so any missing/unknown key falls back to a sane default. */
  config: AvatarConfig | Record<string, string> | null | undefined;
  size?: number;
  mode?: 'full' | 'bust';
  /** Draw a soft backdrop disc behind the figure (nice in the circular slot). */
  background?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const config = normalizeAvatar(rawConfig);
  const skin = skinTone(config.skin);
  const SK = skin.hex, SKS = skin.shadow, SKL = skin.line;
  const hair = hairHex(config.hairColor);
  const hairLine = shade(hair, -0.18);
  const shirt = clothHex(config.shirtColor);
  const shirtLine = shade(shirt, -0.16);
  const bottom = clothHex(config.bottomColor);
  const bottomLine = shade(bottom, -0.16);
  const shoe = clothHex(config.shoeColor);
  const shoeLine = shade(shoe, -0.18);
  const hat = clothHex(config.hatColor);
  const hatLine = shade(hat, -0.18);
  const dims = buildDims(config.build);

  // Full frames the whole figure; bust re-frames to head + shoulders (square).
  const viewBox = mode === 'bust' ? '32 36 136 136' : `0 0 ${VB_W} ${VB_H}`;
  const bustBgId = 'ga_bust_bg';

  const shortBottom = config.bottom === 'shorts';

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={viewBox}>
        <Defs>
          <RadialGradient id={bustBgId} cx="100" cy="70" r="90" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={shade(shirt, 0.34)} />
            <Stop offset="1" stopColor={shade(shirt, 0.08)} />
          </RadialGradient>
        </Defs>

        {background && mode === 'bust' && (
          <Rect x="0" y="0" width={VB_W} height={VB_H} fill={`url(#${bustBgId})`} />
        )}

        {/* ── z-order: back → front ─────────────────────────────────────── */}

        {/* Long hair volume behind the head/shoulders. */}
        {hairBack(config.hair, hair, hairLine)}

        {/* Legs + shoes (drawn first so the shirt/shorts overlap the tops). */}
        {legsAndShoes({ dims, shortBottom, bottom, bottomLine, skin: SK, skinShadow: SKS, shoe, shoeLine })}

        {/* Bottoms (waistband over the leg tops). */}
        {bottoms({ dims, shortBottom, bottom, bottomLine })}

        {/* Arms behind the torso sides, then the shirt on top. */}
        {arms({ dims, skin: SK, skinLine: SKL, shirt, shirtLine })}
        {torso({ dims, shirt, shirtLine, style: config.shirt })}

        {/* Neck + head. */}
        <Rect x={CX - 12} y={HEAD_CY + 22} width={24} height={20} rx={6} fill={SK} />
        <Rect x={CX - 12} y={HEAD_CY + 22} width={24} height={9} fill={SKS} opacity={0.5} />
        {/* Ears */}
        <Ellipse cx={CX - HEAD_RX + 2} cy={HEAD_CY + 4} rx={6} ry={9} fill={SK} stroke={SKL} strokeWidth={1.2} />
        <Ellipse cx={CX + HEAD_RX - 2} cy={HEAD_CY + 4} rx={6} ry={9} fill={SK} stroke={SKL} strokeWidth={1.2} />
        {/* Head */}
        <Ellipse cx={CX} cy={HEAD_CY} rx={HEAD_RX} ry={HEAD_RY} fill={SK} stroke={SKL} strokeWidth={1.4} />
        {/* Soft cheek/jaw shading */}
        <Path d={`M${CX - 24} ${HEAD_CY + 10} Q${CX} ${HEAD_CY + 40} ${CX + 24} ${HEAD_CY + 10}`} fill="none" stroke={SKS} strokeWidth={3} strokeOpacity={0.35} strokeLinecap="round" />

        {/* Face */}
        {face({ skinLine: SKL })}
        {facialHairLayer(config.facialHair, hair, hairLine)}

        {/* Hair on top / front. */}
        {hairFront(config.hair, hair, hairLine)}

        {/* Accessory then hat, on top of everything. */}
        {accessoryLayer(config.accessory)}
        {hatLayer(config.hat, hat, hatLine)}
      </Svg>
    </View>
  );
}

// ── Body parts ───────────────────────────────────────────────────────────────

function legsAndShoes({ dims, shortBottom, bottom, bottomLine, skin, skinShadow, shoe, shoeLine }: {
  dims: Build; shortBottom: boolean; bottom: string; bottomLine: string; skin: string; skinShadow: string; shoe: string; shoeLine: string;
}) {
  const legHW = 12;
  const inseam = 6;                       // gap between legs at the crotch
  const lx = CX - inseam - legHW;         // left leg outer
  const rx = CX + inseam;                 // right leg inner→outer
  const legTop = HIP_Y - 4;
  const skinBottom = ANKLE_Y;
  const kneeCut = shortBottom ? KNEE_Y - 6 : skinBottom;   // shorts end above knee
  return (
    <G>
      {/* Bare shin skin (only visible with shorts). */}
      {shortBottom && (
        <>
          <Rect x={lx} y={kneeCut} width={legHW} height={skinBottom - kneeCut} rx={5} fill={skin} stroke={skinShadow} strokeWidth={0.8} />
          <Rect x={rx} y={kneeCut} width={legHW} height={skinBottom - kneeCut} rx={5} fill={skin} stroke={skinShadow} strokeWidth={0.8} />
        </>
      )}
      {/* Trouser legs (full length when not shorts). */}
      {!shortBottom && (
        <>
          <Rect x={lx} y={legTop} width={legHW} height={skinBottom - legTop} rx={6} fill={bottom} stroke={bottomLine} strokeWidth={1.2} />
          <Rect x={rx} y={legTop} width={legHW} height={skinBottom - legTop} rx={6} fill={bottom} stroke={bottomLine} strokeWidth={1.2} />
        </>
      )}
      {/* Shoes */}
      {[lx, rx].map((x, i) => (
        <Path key={i}
          d={`M${x - 1} ${ANKLE_Y - 2} L${x + legHW + 1} ${ANKLE_Y - 2} L${x + legHW + 4} ${ANKLE_Y + 14} Q${x + legHW + 4} ${ANKLE_Y + 19} ${x + legHW - 2} ${ANKLE_Y + 19} L${x - 3} ${ANKLE_Y + 19} Q${x - 6} ${ANKLE_Y + 19} ${x - 5} ${ANKLE_Y + 12} Z`}
          fill={shoe} stroke={shoeLine} strokeWidth={1.4} strokeLinejoin="round" />
      ))}
      {/* Sole */}
      {[lx, rx].map((x, i) => (
        <Rect key={`s${i}`} x={x - 6} y={ANKLE_Y + 17} width={legHW + 12} height={4} rx={2} fill={shade(shoe, -0.35)} />
      ))}
    </G>
  );
}

function bottoms({ dims, shortBottom, bottom, bottomLine }: {
  dims: Build; shortBottom: boolean; bottom: string; bottomLine: string;
}) {
  const hipHW = dims.hipHW;
  const bottomY = shortBottom ? KNEE_Y - 6 : HIP_Y + 20;   // shorts are a short skirt-ish block
  // A rounded "pelvis" block that the leg tops emerge from.
  return (
    <G>
      <Path
        d={`M${CX - hipHW} ${WAIST_Y - 6}
            L${CX + hipHW} ${WAIST_Y - 6}
            L${CX + hipHW - 2} ${bottomY}
            Q${CX + 8} ${bottomY + 8} ${CX} ${bottomY - 2}
            Q${CX - 8} ${bottomY + 8} ${CX - hipHW + 2} ${bottomY} Z`}
        fill={bottom} stroke={bottomLine} strokeWidth={1.4} strokeLinejoin="round" />
      {/* Waistband */}
      <Rect x={CX - hipHW} y={WAIST_Y - 8} width={hipHW * 2} height={7} rx={3} fill={shade(bottom, -0.12)} />
    </G>
  );
}

function arms({ dims, skin, skinLine, shirt, shirtLine }: {
  dims: Build; skin: string; skinLine: string; shirt: string; shirtLine: string;
}) {
  const s = dims.shoulderHW;
  const armW = 13;
  const sleeveBottom = SHOULDER_Y + 46;
  const handY = WAIST_Y - 4;
  return (
    <G>
      {[-1, 1].map((dir) => {
        const shoulderX = CX + dir * (s - 4);
        const handX = CX + dir * (dims.waistHW + 12);
        return (
          <G key={dir}>
            {/* Upper-arm sleeve (shirt colour) */}
            <Path
              d={`M${shoulderX - dir * armW / 2} ${SHOULDER_Y}
                  Q${shoulderX + dir * armW} ${SHOULDER_Y + 10} ${shoulderX + dir * armW / 2} ${sleeveBottom}
                  L${shoulderX - dir * armW / 2} ${sleeveBottom} Z`}
              fill={shirt} stroke={shirtLine} strokeWidth={1.2} strokeLinejoin="round" />
            {/* Forearm (skin) down to the hand */}
            <Path
              d={`M${shoulderX + dir * armW / 2} ${sleeveBottom}
                  L${shoulderX - dir * armW / 2} ${sleeveBottom}
                  L${handX - dir * armW / 2} ${handY}
                  L${handX + dir * armW / 2} ${handY} Z`}
              fill={skin} stroke={skinLine} strokeWidth={1.1} strokeLinejoin="round" />
            {/* Hand */}
            <Circle cx={handX} cy={handY + 3} r={7} fill={skin} stroke={skinLine} strokeWidth={1.1} />
          </G>
        );
      })}
    </G>
  );
}

function torso({ dims, shirt, shirtLine, style }: {
  dims: Build; shirt: string; shirtLine: string; style: string;
}) {
  const s = dims.shoulderHW - 6;   // shirt is a touch narrower than the arm span
  const w = dims.waistHW;
  const top = SHOULDER_Y - 4;
  const bot = WAIST_Y;
  return (
    <G>
      <Path
        d={`M${CX - s} ${top}
            Q${CX} ${top - 8} ${CX + s} ${top}
            L${CX + w} ${bot}
            L${CX - w} ${bot} Z`}
        fill={shirt} stroke={shirtLine} strokeWidth={1.6} strokeLinejoin="round" />
      {/* Collar / neckline per shirt style */}
      {style === 'vneck' ? (
        <Path d={`M${CX - 12} ${top + 2} L${CX} ${top + 20} L${CX + 12} ${top + 2}`} fill="none" stroke={shirtLine} strokeWidth={2} strokeLinejoin="round" />
      ) : (
        <>
          <Path d={`M${CX - 13} ${top + 1} L${CX - 5} ${top + 12} L${CX + 5} ${top + 12} L${CX + 13} ${top + 1}`} fill={shade(shirt, -0.1)} stroke={shirtLine} strokeWidth={1.2} strokeLinejoin="round" />
          {/* Placket buttons for polo / quarter-zip */}
          <Path d={`M${CX} ${top + 12} L${CX} ${top + 42}`} stroke={shirtLine} strokeWidth={1.6} />
          {style === 'quarterzip'
            ? <Circle cx={CX} cy={top + 14} r={2.4} fill={shade(shirt, -0.3)} />
            : (<><Circle cx={CX} cy={top + 22} r={1.8} fill={shade(shirt, -0.3)} /><Circle cx={CX} cy={top + 34} r={1.8} fill={shade(shirt, -0.3)} /></>)}
        </>
      )}
      {/* Striped polo: two chest bands */}
      {style === 'striped' && (
        <>
          <Rect x={CX - w - 2} y={top + 46} width={(w + s)} height={9} fill={shade(shirt, -0.22)} opacity={0.9} />
          <Rect x={CX - w - 2} y={top + 62} width={(w + s)} height={6} fill={shade(shirt, 0.18)} opacity={0.8} />
        </>
      )}
    </G>
  );
}

function face({ skinLine }: { skinLine: string }) {
  const eyeY = HEAD_CY + 2;
  return (
    <G>
      {/* Brows */}
      <Path d={`M${CX - 18} ${eyeY - 9} q6 -4 12 0`} fill="none" stroke={skinLine} strokeWidth={2.2} strokeLinecap="round" />
      <Path d={`M${CX + 6} ${eyeY - 9} q6 -4 12 0`} fill="none" stroke={skinLine} strokeWidth={2.2} strokeLinecap="round" />
      {/* Eyes: white + iris */}
      <Ellipse cx={CX - 12} cy={eyeY} rx={5} ry={5.5} fill="#ffffff" stroke={skinLine} strokeWidth={0.8} />
      <Ellipse cx={CX + 12} cy={eyeY} rx={5} ry={5.5} fill="#ffffff" stroke={skinLine} strokeWidth={0.8} />
      <Circle cx={CX - 11} cy={eyeY + 0.5} r={2.6} fill="#2a1c12" />
      <Circle cx={CX + 13} cy={eyeY + 0.5} r={2.6} fill="#2a1c12" />
      {/* Nose */}
      <Path d={`M${CX} ${eyeY + 4} l-3 8 q3 3 6 0`} fill="none" stroke={skinLine} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      {/* Smile */}
      <Path d={`M${CX - 11} ${eyeY + 18} q11 9 22 0`} fill="none" stroke={skinLine} strokeWidth={2.2} strokeLinecap="round" />
    </G>
  );
}

function facialHairLayer(kind: string, hair: string, hairLine: string) {
  if (kind === 'none') return null;
  const y = HEAD_CY + 2;
  if (kind === 'stubble') {
    return <Path d={`M${CX - 22} ${y + 8} Q${CX} ${HEAD_CY + HEAD_RY + 2} ${CX + 22} ${y + 8} Q${CX} ${y + 30} ${CX - 22} ${y + 8}`} fill={hair} opacity={0.28} />;
  }
  if (kind === 'mustache') {
    return <Path d={`M${CX - 12} ${y + 15} Q${CX} ${y + 12} ${CX} ${y + 16} Q${CX} ${y + 12} ${CX + 12} ${y + 15} Q${CX + 6} ${y + 21} ${CX} ${y + 18} Q${CX - 6} ${y + 21} ${CX - 12} ${y + 15} Z`} fill={hair} stroke={hairLine} strokeWidth={0.6} />;
  }
  if (kind === 'goatee') {
    return (
      <G>
        <Path d={`M${CX - 10} ${y + 15} Q${CX} ${y + 13} ${CX + 10} ${y + 15} Q${CX + 5} ${y + 19} ${CX} ${y + 17} Q${CX - 5} ${y + 19} ${CX - 10} ${y + 15} Z`} fill={hair} />
        <Path d={`M${CX - 8} ${y + 22} Q${CX} ${HEAD_CY + HEAD_RY + 4} ${CX + 8} ${y + 22} Q${CX} ${y + 30} ${CX - 8} ${y + 22} Z`} fill={hair} stroke={hairLine} strokeWidth={0.6} />
      </G>
    );
  }
  // full beard
  return <Path d={`M${CX - HEAD_RX + 2} ${y - 2} Q${CX - HEAD_RX + 2} ${HEAD_CY + HEAD_RY + 12} ${CX} ${HEAD_CY + HEAD_RY + 14} Q${CX + HEAD_RX - 2} ${HEAD_CY + HEAD_RY + 12} ${CX + HEAD_RX - 2} ${y - 2} Q${CX} ${y + 22} ${CX - HEAD_RX + 2} ${y - 2} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
}

function hairBack(style: string, hair: string, hairLine: string) {
  if (style === 'long') {
    return <Path d={`M${CX - HEAD_RX - 3} ${HEAD_CY - 18} Q${CX - HEAD_RX - 10} ${HEAD_CY + 60} ${CX - HEAD_RX + 6} ${HEAD_CY + 70} L${CX + HEAD_RX - 6} ${HEAD_CY + 70} Q${CX + HEAD_RX + 10} ${HEAD_CY + 60} ${CX + HEAD_RX + 3} ${HEAD_CY - 18} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  if (style === 'ponytail') {
    return <Path d={`M${CX + HEAD_RX - 6} ${HEAD_CY - 6} q22 6 18 34 q-4 20 -16 26 q10 -18 4 -34 q-4 -14 -14 -18 Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  return null;
}

function hairFront(style: string, hair: string, hairLine: string) {
  if (style === 'none') return null;
  const topY = HEAD_CY - HEAD_RY;
  if (style === 'buzz') {
    return <Path d={`M${CX - HEAD_RX + 1} ${HEAD_CY - 6} Q${CX} ${topY - 4} ${CX + HEAD_RX - 1} ${HEAD_CY - 6} Q${CX} ${HEAD_CY - 20} ${CX - HEAD_RX + 1} ${HEAD_CY - 6} Z`} fill={hair} opacity={0.85} />;
  }
  if (style === 'short') {
    return <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 2} Q${CX - HEAD_RX - 2} ${topY + 4} ${CX - 10} ${topY} Q${CX} ${topY - 6} ${CX + 10} ${topY} Q${CX + HEAD_RX + 2} ${topY + 4} ${CX + HEAD_RX} ${HEAD_CY - 2} Q${CX + 18} ${HEAD_CY - 16} ${CX + 6} ${HEAD_CY - 12} Q${CX} ${HEAD_CY - 16} ${CX - 8} ${HEAD_CY - 11} Q${CX - 18} ${HEAD_CY - 16} ${CX - HEAD_RX} ${HEAD_CY - 2} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  if (style === 'swoop') {
    return <Path d={`M${CX - HEAD_RX} ${HEAD_CY} Q${CX - HEAD_RX - 3} ${topY + 2} ${CX} ${topY - 2} Q${CX + HEAD_RX + 4} ${topY} ${CX + HEAD_RX} ${HEAD_CY - 4} Q${CX + 6} ${HEAD_CY - 10} ${CX - 20} ${HEAD_CY - 6} Q${CX - 6} ${HEAD_CY - 14} ${CX - HEAD_RX} ${HEAD_CY} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  if (style === 'curly') {
    // A ring of overlapping puffs across the hairline.
    const puffs = [-28, -19, -9, 1, 11, 21, 29];
    return (
      <G>
        {puffs.map((dx, i) => (
          <Circle key={i} cx={CX + dx} cy={HEAD_CY - HEAD_RY + 10 + (i % 2 === 0 ? 0 : 4)} r={11} fill={hair} stroke={hairLine} strokeWidth={0.8} />
        ))}
        <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 4} Q${CX} ${HEAD_CY - HEAD_RY} ${CX + HEAD_RX} ${HEAD_CY - 4} Q${CX} ${HEAD_CY - 12} ${CX - HEAD_RX} ${HEAD_CY - 4} Z`} fill={hair} />
      </G>
    );
  }
  if (style === 'long') {
    return <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 2} Q${CX} ${topY - 6} ${CX + HEAD_RX} ${HEAD_CY - 2} Q${CX + 8} ${HEAD_CY - 12} ${CX - 4} ${HEAD_CY - 10} Q${CX - 18} ${HEAD_CY - 14} ${CX - HEAD_RX} ${HEAD_CY - 2} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  if (style === 'ponytail') {
    return <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 4} Q${CX} ${topY - 4} ${CX + HEAD_RX} ${HEAD_CY - 4} Q${CX} ${HEAD_CY - 14} ${CX - HEAD_RX} ${HEAD_CY - 4} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />;
  }
  if (style === 'bun') {
    return (
      <G>
        <Circle cx={CX} cy={topY - 2} r={11} fill={hair} stroke={hairLine} strokeWidth={1} />
        <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 4} Q${CX} ${topY} ${CX + HEAD_RX} ${HEAD_CY - 4} Q${CX} ${HEAD_CY - 14} ${CX - HEAD_RX} ${HEAD_CY - 4} Z`} fill={hair} stroke={hairLine} strokeWidth={1} />
      </G>
    );
  }
  return null;
}

function accessoryLayer(kind: string) {
  if (kind === 'none') return null;
  const eyeY = HEAD_CY + 2;
  const tint = kind === 'sunglasses' ? '#1c1c22' : '#8fd0ff';
  const frame = kind === 'sunglasses' ? '#111114' : '#3a3a42';
  const op = kind === 'sunglasses' ? 0.95 : 0.35;
  return (
    <G>
      <Rect x={CX - 19} y={eyeY - 6} width={14} height={11} rx={4} fill={tint} fillOpacity={op} stroke={frame} strokeWidth={1.6} />
      <Rect x={CX + 5} y={eyeY - 6} width={14} height={11} rx={4} fill={tint} fillOpacity={op} stroke={frame} strokeWidth={1.6} />
      <Path d={`M${CX - 5} ${eyeY - 1} h10`} stroke={frame} strokeWidth={1.6} />
      <Path d={`M${CX - 19} ${eyeY - 2} l-6 -2`} stroke={frame} strokeWidth={1.6} strokeLinecap="round" />
      <Path d={`M${CX + 19} ${eyeY - 2} l6 -2`} stroke={frame} strokeWidth={1.6} strokeLinecap="round" />
    </G>
  );
}

function hatLayer(kind: string, hat: string, hatLine: string) {
  if (kind === 'none') return null;
  const topY = HEAD_CY - HEAD_RY;
  if (kind === 'visor') {
    return (
      <G>
        <Path d={`M${CX - HEAD_RX - 2} ${HEAD_CY - 12} Q${CX} ${HEAD_CY - 18} ${CX + HEAD_RX + 2} ${HEAD_CY - 12} L${CX + HEAD_RX} ${HEAD_CY - 6} L${CX - HEAD_RX} ${HEAD_CY - 6} Z`} fill={hat} stroke={hatLine} strokeWidth={1.2} strokeLinejoin="round" />
        <Ellipse cx={CX} cy={HEAD_CY - 6} rx={HEAD_RX + 8} ry={7} fill={shade(hat, -0.12)} stroke={hatLine} strokeWidth={1.2} />
      </G>
    );
  }
  if (kind === 'beanie') {
    return (
      <G>
        <Path d={`M${CX - HEAD_RX - 1} ${HEAD_CY - 2} Q${CX - HEAD_RX - 3} ${topY - 8} ${CX} ${topY - 10} Q${CX + HEAD_RX + 3} ${topY - 8} ${CX + HEAD_RX + 1} ${HEAD_CY - 2} Z`} fill={hat} stroke={hatLine} strokeWidth={1.4} strokeLinejoin="round" />
        <Rect x={CX - HEAD_RX - 2} y={HEAD_CY - 6} width={(HEAD_RX + 2) * 2} height={9} rx={3} fill={shade(hat, 0.12)} stroke={hatLine} strokeWidth={1.2} />
      </G>
    );
  }
  if (kind === 'bucket') {
    return (
      <G>
        <Path d={`M${CX - HEAD_RX + 2} ${HEAD_CY - 4} Q${CX} ${topY - 12} ${CX + HEAD_RX - 2} ${HEAD_CY - 4} Z`} fill={hat} stroke={hatLine} strokeWidth={1.4} strokeLinejoin="round" />
        <Ellipse cx={CX} cy={HEAD_CY - 3} rx={HEAD_RX + 12} ry={10} fill={hat} stroke={hatLine} strokeWidth={1.4} />
        <Ellipse cx={CX} cy={HEAD_CY - 6} rx={HEAD_RX - 2} ry={6} fill={shade(hat, -0.1)} />
      </G>
    );
  }
  // cap (default)
  return (
    <G>
      {/* Crown */}
      <Path d={`M${CX - HEAD_RX} ${HEAD_CY - 4} Q${CX - HEAD_RX - 2} ${topY - 6} ${CX} ${topY - 8} Q${CX + HEAD_RX + 2} ${topY - 6} ${CX + HEAD_RX} ${HEAD_CY - 4} Q${CX} ${HEAD_CY - 12} ${CX - HEAD_RX} ${HEAD_CY - 4} Z`} fill={hat} stroke={hatLine} strokeWidth={1.4} strokeLinejoin="round" />
      {/* Button */}
      <Circle cx={CX} cy={topY - 6} r={2.6} fill={shade(hat, -0.2)} />
      {/* Front-facing brim */}
      <Ellipse cx={CX} cy={HEAD_CY - 3} rx={HEAD_RX + 3} ry={8} fill={shade(hat, -0.14)} stroke={hatLine} strokeWidth={1.2} />
    </G>
  );
}
