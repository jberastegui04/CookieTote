import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Tap } from './controls';
import { tapHaptic } from './feedback';
import { formatDistance, type Units } from './prefs';
import { capitalize, HALF_FOV_DEG, type FindResult } from './find';
import { Enter, useReduceMotion } from './motion';
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
  onStop: () => void;
  paused?: boolean; // Walker has the floor; Find picks up again when he's done
  onHold?: () => void; // press and hold anywhere: talk to Walker (Find pauses)
  walker?: ReactNode; // Walker's button, next to Stop finding
  walkerBubble?: ReactNode; // what Walker is doing, above the buttons
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

  const headline = p.paused
    ? 'Paused'
    : !r
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
  const detail = p.paused ? 'Walker is listening' : !found ? 'Turn slowly · Hold to talk to Walker' : matchNote;
  const arrow = !p.paused && found && r.direction ? ARROW[r.direction] : null;
  const distance = found && r.distance_m != null ? `${formatDistance(r.distance_m, p.units)} away` : null;

  // The 3:4 photo is scaled to cover the screen, so a tall phone shows only the middle of what
  // the camera sees (about 60% of its width).
  const scale = Math.max(screenW / PHOTO_ASPECT, screenH);
  const photoW = scale * PHOTO_ASPECT;
  // Bearing meter: where the target sits left to right. Its ends are the edges of the screen, so
  // the dot reaches an end just as the box's center reaches that edge. (It used to span the camera's
  // whole view, 26 degrees each way, so the box left the screen with the dot only part way along.)
  const edgeDeg = HALF_FOV_DEG * Math.min(1, screenW / photoW);
  const bearing = found && r.bearing_deg != null ? r.bearing_deg : null;
  const dotFrac = bearing == null ? 0.5 : Math.min(1, Math.max(0, (bearing + edgeDeg) / (2 * edgeDeg)));

  // Outline the target on the camera view, same mapping as the obstacle box.
  let box: { left: number; top: number; width: number; height: number } | null = null;
  if (found && r.box) {
    const [x, y, w, h] = r.box;
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


  return (
    <Enter from="fade" style={styles.screen} accessibilityViewIsModal>
      {/* Drawing only; the find loop speaks the same thing. */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {box ? (
          <>
            {/* Searching: a thin dashed outline. Locked on: solid. One box, no glow. */}
            <Animated.View style={[styles.box, !r?.locked && styles.boxSearching, boxStyle]} />
            <Animated.View style={[styles.tag, { left: boxLeft, top: tagTop, opacity: r?.stale ? 0.6 : 1 }]}>
              {/* Short words, not the name: a described target ("person in a dark hoodie") is too long for a
                  tag. "Looking…" until the server locks on, then "Found". */}
              <Text style={styles.tagText}>
                {r?.locked ? '● Found' : 'Looking…'}
                {r?.distance_m != null ? ` · ${formatDistance(r.distance_m, p.units)}` : ''}
              </Text>
            </Animated.View>
          </>
        ) : null}

        <View style={styles.band}>
          <Text style={styles.bandLabel}>FINDING</Text>
          <Text style={styles.bandTarget}>{p.description ? capitalize(p.description) : name}</Text>
        </View>

        <View style={styles.middle}>
          <View style={styles.card}>
            <View style={styles.headRow}>
              {arrow ? <Text style={styles.arrow}>{arrow}</Text> : null}
              <Text style={styles.headline}>{headline}</Text>
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
            {distance ? <Text style={styles.distance}>{distance}</Text> : null}
          </View>
        </View>
      </View>

      {/* Press and hold anywhere to talk to Walker: no small button to find while searching. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onLongPress={() => {
          tapHaptic();
          p.onHold?.();
        }}
        delayLongPress={500}
        accessibilityRole="button"
        accessibilityLabel={`Finding ${p.description ?? p.target}`}
        accessibilityHint="Double tap and hold to talk to Walker, to find something else or stop"
      />

      <View style={styles.bottom} pointerEvents="box-none">
        {p.walkerBubble}
        <View style={styles.bottomRow}>
          <Tap
            style={styles.stop}
            onPress={p.onStop}
            accessibilityRole="button"
            accessibilityLabel={`Stop finding the ${p.target}`}
            accessibilityHint="Returns to the camera"
          >
            <Text style={styles.stopText}>Stop finding</Text>
          </Tap>
          {p.walker}
        </View>
      </View>
    </Enter>
  );
}

const DOT = 32;

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill },
  band: {
    backgroundColor: C.accent,
    paddingTop: SAFE.top + SPACE.lg,
    paddingBottom: SPACE.xl,
    paddingHorizontal: GUTTER,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  bandLabel: { color: C.onAccent, fontSize: 18, letterSpacing: 1, ...font('bold') },
  bandTarget: { color: C.onAccent, fontSize: 40, marginTop: SPACE.xs, ...font('heavy') },
  // The card sits just above the Stop button.
  middle: {
    position: 'absolute',
    left: GUTTER,
    right: GUTTER,
    bottom: SAFE.bottom + SPACE.sm + 80 + SPACE.md,
  },
  card: {
    backgroundColor: C.glass,
    borderRadius: 22,
    paddingHorizontal: GUTTER,
    paddingVertical: SPACE.lg,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  arrow: { color: C.accent, fontSize: 48, ...font('heavy') },
  headline: { color: C.ink, fontSize: 30, flexShrink: 1, ...font('heavy') },
  detail: { color: C.ink2, fontSize: 19, marginTop: SPACE.xs, ...font('semibold') },
  meter: { height: DOT, marginTop: SPACE.lg, marginHorizontal: DOT / 2, justifyContent: 'center' },
  track: { height: 10, borderRadius: 5, backgroundColor: C.border },
  trackOn: { backgroundColor: C.accent },
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
    backgroundColor: C.bg,
    borderWidth: 4,
    borderColor: C.accent,
  },
  dotOn: { backgroundColor: C.accent, borderColor: C.onAccent },
  distance: { color: C.accent, fontSize: 40, marginTop: SPACE.md, ...font('heavy') },
  bottom: { position: 'absolute', left: GUTTER, right: GUTTER, bottom: SAFE.bottom + SPACE.sm, gap: SPACE.md },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  stop: {
    flex: 1,
    minHeight: 80,
    borderRadius: 40,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 5,
    borderBottomColor: C.accentDeep,
  },
  stopText: { color: C.onAccent, fontSize: 26, ...font('bold') },
  box: { position: 'absolute', borderWidth: 5, borderColor: C.accent, borderRadius: 18 },
  boxSearching: { borderWidth: 3, borderStyle: 'dashed' },
  tag: {
    position: 'absolute',
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagText: { color: C.onAccent, fontSize: 20, ...font('bold') },
});
