import type { TextStyle } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';

// Space taken by the status bar and the home indicator. The app is portrait only, so the
// values at launch hold for the whole session.
export const SAFE = {
  top: initialWindowMetrics?.insets.top ?? 47,
  bottom: initialWindowMetrics?.insets.bottom ?? 34,
};

// Spacing scale (4-point grid). Related things sit closer together than unrelated ones.
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const GUTTER = 20; // left and right margin on every screen

// Yellow on near-black: the classic low-vision high-contrast pair. Dark cuts glare, yellow is the
// color the eye finds first. Every text/background pair here is at least 7:1.
export const C = {
  accent: '#FFD60A', // buttons, selected options, big numbers, the outline on the camera
  onAccent: '#0B0B0C', // text and icons on accent (14:1)
  ink: '#FFFFFF', // main text (19:1 on bg)
  ink2: '#C7C7CC', // secondary text (12:1 on bg, 10:1 on card)
  bg: '#0B0B0C',
  card: '#1C1C1E', // rows and inputs
  glass: 'rgba(11,11,12,0.9)', // cards and chips over the camera picture
  border: '#48484A',
  off: '#636366', // switch track when off
  tint: '#2E2809', // dark yellow fill behind a selected row (white on it is 15:1)
  walker: '#64D2FF', // Walker, the voice assistant: his own color, like his own voice (11:1 on bg)
  onWalker: '#0B0B0C',
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
