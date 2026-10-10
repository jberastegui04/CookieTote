import Svg, { Circle, Path } from 'react-native-svg';
import { C } from './theme';

// The WatchIt eye: a smooth almond with a round pupil and a small highlight, so it reads
// friendly rather than staring. `inverse` draws it dark, for yellow backgrounds.
// Decorative only; VoiceOver skips it.
export default function Logo({ width = 140, inverse = false }: { width?: number; inverse?: boolean }) {
  const main = inverse ? C.onAccent : C.accent;
  const back = inverse ? C.accent : C.bg;
  return (
    <Svg
      width={width}
      height={width * 0.6}
      viewBox="0 0 120 72"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path d="M4 36 C 28 2, 92 2, 116 36 C 92 70, 28 70, 4 36 Z" fill={main} />
      <Circle cx={60} cy={36} r={22} fill={back} />
      <Circle cx={60} cy={36} r={12} fill={main} />
      <Circle cx={65} cy={31} r={4} fill={back} />
    </Svg>
  );
}
