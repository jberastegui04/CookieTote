import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { tapHaptic } from './feedback';
import { useReduceMotion } from './motion';
import Logo from './Logo';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Props = {
  onShown?: () => void; // the poster is up: Walker says to tap anywhere
  onFinish?: () => void; // tapped: the camera screen takes over
  // The same poster drawn over the camera as it opens, fading out: the crossfade into the app.
  leaving?: boolean;
  onGone?: () => void;
};

const LEAVE_MS = 650;

// The welcome: a poster, all yellow, the mark big in the middle, the name, and the safety note. The
// whole screen is one button, so nobody has to find "Get started": tap anywhere (with VoiceOver,
// double tap anywhere, since VoiceOver lands on it straight away). Walker says so out loud, then
// walks you through the basics on the camera screen. The voice is changed in Settings.
export default function Setup(p: Props) {
  const reduceMotion = useReduceMotion();
  // 0 -> 1 as it appears (fades and rises a little); 1 -> 0 as it leaves (fades and grows a little,
  // so the camera shows through). Reduce Motion: a plain fade out, nothing on the way in.
  const shown = useRef(new Animated.Value(p.leaving || reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (p.leaving) {
      Animated.timing(shown, { toValue: 0, duration: LEAVE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start(
        () => p.onGone?.(),
      );
      return;
    }
    if (!reduceMotion) Animated.timing(shown, { toValue: 1, duration: 240, useNativeDriver: true }).start();
    p.onShown?.();
  }, []);

  const motion = p.leaving
    ? { opacity: shown, transform: reduceMotion ? [] : [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [1.08, 1] }) }] }
    : { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] };

  return (
    <Animated.View
      style={[styles.screen, styles.poster, p.leaving && styles.over, p.leaving ? motion : null]}
      pointerEvents={p.leaving ? 'none' : 'auto'}
      accessibilityElementsHidden={p.leaving}
      importantForAccessibility={p.leaving ? 'no-hide-descendants' : 'auto'}
    >
      <Pressable
        style={styles.fill}
        onPress={() => {
          tapHaptic();
          p.onFinish?.();
        }}
        accessibilityRole="button"
        accessibilityLabel="Cyclops. Get started"
        accessibilityHint="Double tap anywhere to begin"
      >
        {p.leaving ? null : <StatusBar style="dark" />}
        <Animated.View style={[styles.fill, styles.posterBody, p.leaving ? null : motion]}>
          <View style={styles.posterMiddle}>
            <Logo inverse width={230} />
            <Text style={styles.posterName}>CYCLOPS</Text>
          </View>
          <TapHint reduce={reduceMotion || !!p.leaving} />
          <Text style={styles.posterNote}>Not a cane. Does not detect curbs, drop-offs or moving cars.</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

// "Tap anywhere to begin" with a tap ripple above it: a dot, and a ring that grows out of it and
// fades, like a finger tapping the screen, while the words breathe in time. Still with Reduce Motion.
const RIPPLE_MS = 1800;
const TEXT_SIZE = 20;
function TapHint({ reduce }: { reduce: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: RIPPLE_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(300),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const ring = (delay: number) => {
    const local = delay === 0 ? t : t.interpolate({ inputRange: [0, delay, 1], outputRange: [0, 0, 1], extrapolate: 'clamp' });
    return {
      opacity: local.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 0.7, 0] }),
      transform: [{ scale: local.interpolate({ inputRange: [0, 1], outputRange: [0.4, 2.6] }) }],
    };
  };
  const breathe = reduce ? 1 : t.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0.55, 1, 0.55] });
  const dotPulse = reduce ? 1 : t.interpolate({ inputRange: [0, 0.12, 0.3, 1], outputRange: [1, 0.75, 1, 1] });
  return (
    <View style={styles.hint} pointerEvents="none">
      <View style={styles.rippleBox}>
        {reduce ? null : (
          <>
            <Animated.View style={[styles.ring, ring(0)]} />
            <Animated.View style={[styles.ring, ring(0.25)]} />
          </>
        )}
        <Animated.View style={[styles.dot, { transform: [{ scale: dotPulse }] }]} />
      </View>
      <Animated.Text style={[styles.hintText, { opacity: breathe }]}>Tap anywhere to begin</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  poster: { backgroundColor: C.accent },
  over: { ...StyleSheet.absoluteFill },
  fill: { flex: 1 },
  posterBody: { paddingHorizontal: GUTTER, paddingTop: SAFE.top, paddingBottom: SAFE.bottom + SPACE.sm },
  posterMiddle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Two sizes only: the name, and everything else (TEXT_SIZE).
  posterName: { color: C.onAccent, fontSize: 48, letterSpacing: 8, marginTop: SPACE.xl, ...font('heavy') },
  posterNote: { color: C.onAccent, fontSize: TEXT_SIZE, lineHeight: 26, textAlign: 'center', marginTop: SPACE.lg, ...font('regular') },
  hint: { alignItems: 'center' },
  rippleBox: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
  ring: { position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 3, borderColor: C.onAccent },
  dot: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.onAccent },
  hintText: { color: C.onAccent, fontSize: TEXT_SIZE, ...font('bold') },
});
