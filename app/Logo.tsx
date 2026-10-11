import Svg, { Circle, Path, Polygon } from 'react-native-svg';
import { C } from './theme';

// The Cyclops mark: one eye in a ring, with a compass needle rising from the iris through the top of
// the ring (left half solid, right half outlined). Redrawn from the team's logo in the app's colors,
// so it stays sharp at any size. The eye and the top of the needle are drawn over a thicker outline in
// the background color, which cuts the small gaps where they cross the ring; the needle's base and
// sides join the eye. `inverse` draws it dark, for
// yellow backgrounds. Decorative only; VoiceOver skips it.
const CY = 108;
const EYE = `M10 ${CY} C 52 46, 148 46, 190 ${CY} C 148 170, 52 170, 10 ${CY} Z`;

export default function Logo({ width = 140, inverse = false }: { width?: number; inverse?: boolean }) {
  const main = inverse ? C.onAccent : C.accent;
  const back = inverse ? C.accent : C.bg;
  return (
    <Svg width={width} height={width} viewBox="0 0 200 200" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx={100} cy={CY} r={86} stroke={main} strokeWidth={12} fill="none" />
      <Path d={EYE} stroke={back} strokeWidth={22} fill="none" />
      <Path d={EYE} stroke={main} strokeWidth={9} fill="none" />
      <Circle cx={100} cy={CY} r={41} fill={back} />
      {/* Cuts the gap only where the needle crosses the outer ring; lower down it joins the eye. */}
      <Polygon points="100,6 87.4,40 112.6,40" fill={back} stroke={back} strokeWidth={12} strokeLinejoin="round" />
      <Polygon points="100,8 76,69 124,69" fill={back} stroke={main} strokeWidth={5} strokeLinejoin="round" />
      <Polygon points="100,8 76,69 100,69" fill={main} stroke={main} strokeWidth={5} strokeLinejoin="round" />
      <Circle cx={100} cy={CY} r={36} stroke={main} strokeWidth={9} fill="none" />
      <Circle cx={100} cy={CY} r={21} fill={main} />
      <Circle cx={109} cy={CY - 9} r={7.5} fill={back} />
    </Svg>
  );
}
