import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Tap } from './controls';
import { formatDistance, type Units } from './prefs';
import { capitalize, HALF_FOV_DEG, type FindResult } from './find';
import { useReduceMotion } from './motion';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

// The box moves on every gyro reading (about 20 a second) and every server answer. Gliding to each
// new spot over a bit more than one reading blends them into continuous motion instead of jumps.
const GLIDE_MS = 80;

// An animated number that glides to `target`. Jumps straight there the first time (so the box
// doesn't fly in from the corner) and always when Reduce Motion is on.
function useGlide(target: number | null, reduce: boolean) {
  const value = useRef(new Animated.Value(target ?? 0)).current;
  const showing = useRef(false);
  useEffect(() => {
    if (target == null) {
      showing.current = false;
      return;
    }
    if (!showing.current || reduce) {
      value.stopAnimation();
      value.setValue(target);
      showing.current = true;
      return;
    }
    Animated.timing(value, {
      toValue: target,
      duration: GLIDE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // left/top/width/height can't use the native driver
    }).start();
  }, [target, reduce, value]);
  return value;
}

type Props = {
  target: string;
  units: Units;
  description?: string | null; // the user's words from the picker, like "red bench"
  result: FindResult | null; // newest POST /find answer; null until the first one arrives
  cameraPicture: boolean; // false: plain white screen with bigger text (camera still runs underneath)
  onStop: () => void;
};

// Photos come back portrait 3:4; the preview fills the screen and crops the sides.
const PHOTO_ASPECT = 3 / 4;
const ARROW = { left: '←', ahead: '↑', right: '→' } as const;

// Shown over the camera while Find is on. The words here are also spoken by the find loop, so
// VoiceOver skips the drawing and lands on the one control: Stop finding.
export default function FindScreen(p: Props) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const r = p.result;
  const name = capitalize(p.target);
  const found = r?.found === true;

  const headline = !r
    ? 'Looking…'
    : !found
      ? p.description
        ? 'No match yet'
        : `No ${p.target} yet`
      : r.centered
        ? 'Straight ahead'
        : r.direction === 'left'
          ? 'Turn left'
          : r.direction === 'right'
            ? 'Turn right'
            : 'Almost facing it';
  // With a description: how well what's in view fits it. Only while it's actually in the frame.
  const matchNote = p.description && found && r.box ? (r.match === 'yes' ? 'Looks like a match' : r.match === 'possible' ? 'Possible match' : null) : null;
  const detail = !r ? 'Hold the phone up and turn slowly.' : !found ? 'Turn slowly.' : matchNote;
  const arrow = found && r.direction ? ARROW[r.direction] : null;
  const distance = found && r.distance_m != null ? `${formatDistance(r.distance_m, p.units)} away` : null;

  // Bearing meter: where the target sits left to right, from -26 to 26 degrees.
  const bearing = found && r.bearing_deg != null ? r.bearing_deg : null;
  const dotFrac = bearing == null ? 0.5 : Math.min(1, Math.max(0, (bearing + HALF_FOV_DEG) / (2 * HALF_FOV_DEG)));

  // Outline the target on the camera view, same mapping as the obstacle box.
  let box: { left: number; top: number; width: number; height: number } | null = null;
  if (p.cameraPicture && found && r.box) {
    const [x, y, w, h] = r.box;
    const scale = Math.max(screenW / PHOTO_ASPECT, screenH);
    const photoW = scale * PHOTO_ASPECT;
    const offX = (screenW - photoW) / 2;
    const offY = (screenH - scale) / 2;
    box = { left: offX + x * photoW, top: offY + y * scale, width: w * photoW, height: h * scale };
  }

  const reduce = useReduceMotion();
  const boxLeft = useGlide(box?.left ?? null, reduce);
  const boxTop = useGlide(box?.top ?? null, reduce);
  const boxWidth = useGlide(box?.width ?? null, reduce);
  const boxHeight = useGlide(box?.height ?? null, reduce);
  const tagTop = useGlide(box ? Math.max(SAFE.top + 140, box.top - 48) : null, reduce);
  const dot = useGlide(found ? dotFrac : null, reduce);
  // Faded while the tracker is coasting (no answer has matched it for a moment), so it reads as "about here".
  const boxStyle = { left: boxLeft, top: boxTop, width: boxWidth, height: boxHeight, opacity: r?.stale ? 0.45 : 1 };

  const large = !p.cameraPicture;

  return (
    <View style={styles.screen} accessibilityViewIsModal>
      {/* Drawing only; the find loop speaks the same thing. */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {box ? (
          <>
            <Animated.View style={[styles.glow, boxStyle]} />
            <Animated.View style={[styles.box, boxStyle]} />
            <Animated.View style={[styles.tag, { left: boxLeft, top: tagTop, opacity: r?.stale ? 0.6 : 1 }]}>
              <Text style={styles.tagText}>
                {name}
                {r?.distance_m != null ? ` · ${formatDistance(r.distance_m, p.units)}` : ''}
              </Text>
            </Animated.View>
          </>
        ) : null}

        <View style={styles.band}>
          <Text style={styles.bandLabel}>FINDING</Text>
          <Text style={styles.bandTarget}>{p.description ? capitalize(p.description) : name}</Text>
        </View>

        <View style={[styles.middle, large && styles.middleLarge]}>
          <View style={[styles.card, large && styles.cardLarge]}>
            <View style={styles.headRow}>
              {arrow ? <Text style={[styles.arrow, large && styles.arrowLarge]}>{arrow}</Text> : null}
              <Text style={[styles.headline, large && styles.headlineLarge]}>{headline}</Text>
            </View>
            {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            {found ? (
              <View style={styles.meter}>
                <View style={[styles.track, r.centered && styles.trackOn]} />
                <View style={styles.centerMark} />
                <Animated.View
                  style={[
                    styles.dot,
                    r.centered && styles.dotOn,
                    { left: dot.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
                  ]}
                />
              </View>
            ) : null}
            {distance ? <Text style={[styles.distance, large && styles.distanceLarge]}>{distance}</Text> : null}
          </View>
        </View>
      </View>

      <View style={styles.bottom} pointerEvents="box-none">
        <Tap
          style={[styles.stop, large && styles.stopLarge]}
          onPress={p.onStop}
          accessibilityRole="button"
          accessibilityLabel={`Stop finding the ${p.target}`}
          accessibilityHint="Returns to the camera"
        >
          <Text style={styles.stopText}>Stop finding</Text>
        </Tap>
      </View>
    </View>
  );
}

const DOT = 32;

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill },
  band: {
    backgroundColor: C.blue,
    paddingTop: SAFE.top + SPACE.lg,
    paddingBottom: SPACE.xl,
    paddingHorizontal: GUTTER,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  bandLabel: { color: '#fff', fontSize: 18, letterSpacing: 1, ...font('bold') },
  bandTarget: { color: '#fff', fontSize: 40, marginTop: SPACE.xs, ...font('heavy') },
  // The card sits just above the Stop button.
  middle: {
    position: 'absolute',
    left: GUTTER,
    right: GUTTER,
    bottom: SAFE.bottom + SPACE.sm + 80 + SPACE.md,
  },
  middleLarge: { top: SAFE.top + 160, justifyContent: 'center' },
  card: {
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 22,
    paddingHorizontal: GUTTER,
    paddingVertical: SPACE.lg,
  },
  cardLarge: { backgroundColor: C.card, paddingVertical: SPACE.xxl },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  arrow: { color: C.blue, fontSize: 48, ...font('heavy') },
  arrowLarge: { fontSize: 80 },
  headline: { color: C.ink, fontSize: 30, flexShrink: 1, ...font('heavy') },
  headlineLarge: { fontSize: 40 },
  detail: { color: C.ink2, fontSize: 19, marginTop: SPACE.xs, ...font('semibold') },
  meter: { height: DOT, marginTop: SPACE.lg, marginHorizontal: DOT / 2, justifyContent: 'center' },
  track: { height: 10, borderRadius: 5, backgroundColor: '#D1D1D6' },
  trackOn: { backgroundColor: C.blue },
  centerMark: {
    position: 'absolute',
    left: '50%',
    marginLeft: -2,
    width: 4,
    height: DOT,
    borderRadius: 2,
    backgroundColor: C.ink,
  },
  dot: {
    position: 'absolute',
    marginLeft: -DOT / 2,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: C.blue,
  },
  dotOn: { backgroundColor: C.blue, borderColor: '#fff' },
  distance: { color: C.blue, fontSize: 40, marginTop: SPACE.md, ...font('heavy') },
  distanceLarge: { fontSize: 64 },
  bottom: { position: 'absolute', left: GUTTER, right: GUTTER, bottom: SAFE.bottom + SPACE.sm },
  stop: { minHeight: 80, borderRadius: 40, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  stopLarge: { minHeight: 96, borderRadius: 48 },
  stopText: { color: '#fff', fontSize: 26, ...font('bold') },
  box: { position: 'absolute', borderWidth: 5, borderColor: C.bright, borderRadius: 18 },
  glow: {
    position: 'absolute',
    borderWidth: 10,
    borderColor: 'rgba(61,139,255,0.45)',
    borderRadius: 22,
    margin: -5,
    shadowColor: C.bright,
    shadowOpacity: 1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  tag: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagText: { color: C.blue, fontSize: 20, ...font('bold') },
});
