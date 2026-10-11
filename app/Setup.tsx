import { useEffect, useRef, useState } from 'react';
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
  onFinish: () => void;
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

  if (step === 0) {
    return (
      <View style={styles.screen}>
        <DotGrid />
        <StatusBar style="light" />
        <Animated.View style={fadeIn}>
          <ScrollView bounces={false} contentContainerStyle={styles.welcome}>
            <View style={styles.hero}>
              <Logo inverse width={128} />
              <Text style={styles.appName} accessibilityRole="header">
                WatchIt
              </Text>
              <Text style={styles.tagline}>Find things. Avoid obstacles.</Text>
            </View>
            <View style={styles.body}>
              {[
                ['Find', 'Say what you need. A voice leads you to it.'],
                ['Guide', 'Warns you about what is ahead.'],
                ['Tap anywhere', 'Hear what is in front of you.'],
                ['Press and hold', 'Talk to Walker. Say what you need.'],
              ].map(([t, b]) => (
                <View key={t} style={styles.howTo} accessible>
                  <View style={styles.howToHead}>
                    <View style={styles.tick} />
                    <Text style={styles.howToTitle}>{t}</Text>
                  </View>
                  <Text style={styles.howToBody}>{b}</Text>
                </View>
              ))}
              <Text style={styles.footnote}>
                Not a cane. Does not detect curbs, drop-offs or moving cars.
              </Text>
            </View>
          </ScrollView>
          <View style={styles.footer}>
            <BigButton label="Get started" hint="Then pick a voice" onPress={() => setStep(1)} />
          </View>
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
  welcome: { paddingBottom: SPACE.xl },
  // Yellow hero at the top of the welcome screen, running up under the status bar.
  hero: {
    backgroundColor: C.accent,
    paddingTop: SAFE.top + SPACE.xxl,
    paddingBottom: SPACE.xxl,
    paddingHorizontal: GUTTER,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  appName: { color: C.onAccent, fontSize: 48, marginTop: SPACE.xl, ...font('heavy') },
  tagline: { color: C.onAccent, fontSize: 24, marginTop: SPACE.xs, ...font('regular') },
  body: { paddingHorizontal: GUTTER, paddingTop: SPACE.xxl },
  howTo: { marginBottom: SPACE.xl },
  // The same small yellow square as the section labels in Settings.
  howToHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  tick: { width: 10, height: 10, borderRadius: 2, backgroundColor: C.accent },
  howToTitle: { color: C.accent, fontSize: 24, ...font('bold') },
  howToBody: { color: C.ink2, fontSize: 19, marginTop: SPACE.xs, marginLeft: 10 + SPACE.sm, ...font('regular') },
  footnote: { color: C.ink2, fontSize: 17, lineHeight: 24, marginTop: SPACE.sm, ...font('regular') },
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
