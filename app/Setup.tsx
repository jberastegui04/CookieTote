import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Header, Tap, VoiceList } from './controls';
import { useReduceMotion } from './motion';
import Logo from './Logo';
import { DotGrid } from './texture';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Voice = { id: string; name: string };

type Props = {
  voices: Voice[];
  voiceId: string | null;
  onPickVoice: (v: Voice) => void;
  onStart: () => void; // Get started: Walker introduces himself and asks for a voice
  onFinish: () => void;
  walker: ReactNode; // Walker's bubble, shown while he talks
};

// First launch: a welcome screen, then one step: pick a voice. Everything else, like indoor or
// outdoor and haptics, is in Settings.
export default function Setup(p: Props) {
  const [step, setStep] = useState(0);
  const reduceMotion = useReduceMotion();
  // Each step fades and rises in a little. Skipped when Reduce Motion is on.
  const enter = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const titles = ['Welcome', 'Pick a voice.'];
    AccessibilityInfo.announceForAccessibility(titles[step]);
    if (reduceMotion) {
      enter.setValue(1);
      return;
    }
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 240, useNativeDriver: true }).start();
  }, [step]);

  const fadeIn = {
    flex: 1,
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
  };

  // The welcome is a poster: all yellow, the mark big in the middle, the name, one line, and a
  // black Get started. What each feature does is in Walker's help ("Hey Walker, help").
  if (step === 0) {
    return (
      <View style={[styles.screen, styles.poster]}>
        <StatusBar style="dark" />
        <Animated.View style={[fadeIn, styles.posterBody]}>
          <View style={styles.posterMiddle}>
            <Logo inverse width={230} />
            <Text style={styles.posterName} accessibilityRole="header" accessibilityLabel="Cyclops">
              CYCLOPS
            </Text>
            <Text style={styles.posterLine}>Find things. Avoid obstacles.</Text>
          </View>
          <Text style={styles.posterNote}>Not a cane. Does not detect curbs, drop-offs or moving cars.</Text>
          <Tap
            style={styles.posterButton}
            onPress={() => {
              setStep(1);
              p.onStart();
            }}
            accessibilityRole="button"
            accessibilityLabel="Get started"
            accessibilityHint="Then pick a voice"
          >
            <Text style={styles.posterButtonText}>Get started</Text>
          </Tap>
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <DotGrid />
      <StatusBar style="light" />
      <Header title="Pick a voice" sub="Tap one to hear it." onBack={() => setStep(0)} backHint="Goes back to the welcome screen" />
      <Animated.View style={fadeIn}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.walker}>{p.walker}</View>
          <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
        </ScrollView>
        <View style={styles.footer}>
          <BigButton label="Finish" hint="Opens the camera" onPress={p.onFinish} />
        </View>
      </Animated.View>
    </View>
  );
}

function BigButton(p: { label: string; hint: string; onPress: () => void }) {
  return (
    <Tap style={styles.big} onPress={p.onPress} accessibilityRole="button" accessibilityLabel={p.label} accessibilityHint={p.hint}>
      <Text style={styles.bigText}>{p.label}</Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: GUTTER, paddingTop: SPACE.xl, paddingBottom: SPACE.xl },
  footer: { paddingHorizontal: GUTTER, paddingTop: SPACE.md, paddingBottom: SAFE.bottom + SPACE.sm },
  poster: { backgroundColor: C.accent },
  walker: { marginBottom: SPACE.md },
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
  posterButtonText: { color: C.accent, fontSize: 28, ...font('bold') },
  big: {
    backgroundColor: C.accent,
    minHeight: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 5,
    borderBottomColor: C.accentDeep,
  },
  bigText: { color: C.onAccent, fontSize: 28, ...font('bold') },
});
