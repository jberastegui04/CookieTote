import type { TextStyle } from 'react-native';

// Colors from the Figma file. Every text/background pair here is at least 7:1.
export const C = {
  blue: '#0047B3', // buttons, selected options, big numbers
  bright: '#3D8BFF', // obstacle outline on the camera picture (dark blue disappears there)
  ink: '#111111', // main text
  ink2: '#3C3C43', // secondary text
  bg: '#FFFFFF',
  card: '#F2F2F7',
  border: '#C7C7CC',
  off: '#8E8E93', // switch track when off
};

// Atkinson Hyperlegible Next, made for low vision readers. Loaded with useFonts in App.tsx;
// set to false to fall back to the system font.
export const USE_ATKINSON = true;

const FAMILY = {
  regular: 'AtkinsonHyperlegibleNext_400Regular',
  semibold: 'AtkinsonHyperlegibleNext_600SemiBold',
  bold: 'AtkinsonHyperlegibleNext_700Bold',
  heavy: 'AtkinsonHyperlegibleNext_800ExtraBold',
};
const WEIGHT = { regular: '400', semibold: '600', bold: '700', heavy: '800' } as const;

export function font(w: keyof typeof WEIGHT): TextStyle {
  return USE_ATKINSON ? { fontFamily: FAMILY[w] } : { fontWeight: WEIGHT[w] };
}
