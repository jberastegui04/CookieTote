import { StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Path, Pattern, Rect } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import { C } from './theme';

// Small visual details that give the screens some texture without getting in the way of reading.
// All decorative: VoiceOver skips them and they never take touches.
// How far in from each side the bright line starts fading.
const GUTTER_FADE = 8;

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

// A thin yellow line under headers, brightest in the middle and fading out to both sides, with a
// soft glow above it. Below the text, so it never touches the lettering.
export function GlowEdge({ style }: { style?: ViewStyle }) {
  const fade = ['transparent', C.accent, 'transparent'] as const;
  return (
    <View style={[styles.glowEdge, style]} pointerEvents="none" {...hidden}>
      <LinearGradient colors={fade} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.glowSoft} />
      <LinearGradient colors={fade} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.glowLine} />
    </View>
  );
}

// A barely-there dot grid behind dark screens, so they read as a surface rather than empty black.
export function DotGrid() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="dots" patternUnits="userSpaceOnUse" width={22} height={22}>
            <Circle cx={11} cy={11} r={1.1} fill={C.ink} opacity={0.09} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#dots)" />
      </Svg>
    </View>
  );
}

// Four corner brackets, like a camera's focus frame, over the camera picture.
export function ViewfinderCorners({ style }: { style?: ViewStyle }) {
  const arm = 34;
  const w = 4;
  const corner = (d: string, pos: ViewStyle) => (
    <Svg width={arm} height={arm} style={[styles.corner, pos]}>
      <Path d={d} stroke={C.ink} strokeOpacity={0.55} strokeWidth={w} strokeLinecap="round" fill="none" />
    </Svg>
  );
  const e = w / 2;
  return (
    <View style={[StyleSheet.absoluteFill, style]} pointerEvents="none" {...hidden}>
      {corner(`M${e} ${arm} V${e} H${arm}`, { top: 0, left: 0 })}
      {corner(`M0 ${e} H${arm - e} V${arm}`, { top: 0, right: 0 })}
      {corner(`M${e} 0 V${arm - e} H${arm}`, { bottom: 0, left: 0 })}
      {corner(`M0 ${arm - e} H${arm - e} V0`, { bottom: 0, right: 0 })}
    </View>
  );
}

const styles = StyleSheet.create({
  corner: { position: 'absolute' },
  glowEdge: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 14, justifyContent: 'flex-end' },
  glowSoft: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 14, opacity: 0.18 },
  glowLine: { height: 3, marginHorizontal: GUTTER_FADE },
});
