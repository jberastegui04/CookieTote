import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { tapHaptic } from './feedback';
import { useReduceMotion } from './motion';
import Logo from './Logo';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Props = {
  onShown: () => void; // the poster is up: Walker says to tap anywhere
  onFinish: () => void;
};

// The welcome: a poster, all yellow, the mark big in the middle, the name, one line, and the safety
// note. The whole screen is one button, so nobody has to find "Get started": tap anywhere (with
// VoiceOver, double tap anywhere, since VoiceOver lands on it straight away). Walker says so out
// loud, then walks you through the basics on the camera screen. The voice is changed in Settings.
export default function Setup(p: Props) {
  const reduceMotion = useReduceMotion();
  // Fades and rises in a little. Skipped when Reduce Motion is on.
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (!reduceMotion) Animated.timing(enter, { toValue: 1, duration: 240, useNativeDriver: true }).start();
    p.onShown();
  }, []);

  const fadeIn = {
    flex: 1,
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
  };

  return (
    <Pressable
      style={[styles.screen, styles.poster]}
      onPress={() => {
        tapHaptic();
        p.onFinish();
      }}
      accessibilityRole="button"
      accessibilityLabel="Cyclops. Get started"
      accessibilityHint="Double tap anywhere to begin"
    >
      <StatusBar style="dark" />
      <Animated.View style={[fadeIn, styles.posterBody]}>
        <View style={styles.posterMiddle}>
          <Logo inverse width={230} />
          <Text style={styles.posterName}>CYCLOPS</Text>
          <Text style={styles.posterLine}>Find things. Avoid obstacles.</Text>
        </View>
        <Text style={styles.posterNote}>Not a cane. Does not detect curbs, drop-offs or moving cars.</Text>
        {/* Looks like a button for those who can see it; the whole screen is the real one. */}
        <View style={styles.posterButton}>
          <Text style={styles.posterButtonText}>Tap anywhere to start</Text>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  poster: { backgroundColor: C.accent },
  posterBody: { paddingHorizontal: GUTTER, paddingTop: SAFE.top, paddingBottom: SAFE.bottom + SPACE.sm },
  posterMiddle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  posterName: { color: C.onAccent, fontSize: 54, letterSpacing: 8, marginTop: SPACE.xl, ...font('heavy') },
  posterLine: { color: C.onAccent, fontSize: 22, marginTop: SPACE.sm, textAlign: 'center', ...font('semibold') },
  posterNote: { color: C.onAccent, fontSize: 17, lineHeight: 23, textAlign: 'center', marginBottom: SPACE.lg, ...font('regular') },
  // Black on the yellow poster, so it reads as the one thing to press.
  posterButton: {
    backgroundColor: C.onAccent,
    minHeight: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterButtonText: { color: C.accent, fontSize: 24, ...font('bold') },
});
