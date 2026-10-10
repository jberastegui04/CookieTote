import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Caption, Header, Section, Segment, Tap, ToggleRow, VoiceList } from './controls';
import type { Prefs } from './prefs';
import { useReduceMotion } from './motion';
import Logo from './Logo';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Mode = 'indoor' | 'outdoor';
type Voice = { id: string; name: string };
export type Vision = 'see' | 'large';

type Props = {
  mode: Mode;
  onMode: (m: Mode) => void;
  onVision: (v: Vision) => void;
  voices: Voice[];
  voiceId: string | null;
  onPickVoice: (v: Voice) => void;
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  onFinish: () => void;
};

// First launch: a welcome screen, then three short steps. Each choice can be changed later in Settings.
export default function Setup(p: Props) {
  const [step, setStep] = useState(0);
  const reduceMotion = useReduceMotion();
  // Each step fades and rises in a little. Skipped when Reduce Motion is on.
  const enter = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const titles = ['Welcome', 'Step 1 of 3. How much can you see?', 'Step 2 of 3. Where will you use it?', 'Step 3 of 3. How should it alert you?'];
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
        <StatusBar style="light" />
        <Animated.View style={fadeIn}>
          <ScrollView bounces={false} contentContainerStyle={styles.welcome}>
            <View style={styles.hero}>
              <Logo inverse width={128} />
              <Text style={styles.appName} accessibilityRole="header">
                WatchIt
              </Text>
              <Text style={styles.tagline}>Hear what's in your path.</Text>
            </View>
            <View style={styles.body}>
              {[
                ['Tap anywhere', "Hear what's ahead and how far."],
                ['Turn on Guide', 'A voice tells you what is ahead as you walk.'],
                ['Two-finger double tap', 'Repeats the last warning.'],
              ].map(([t, b]) => (
                <View key={t} style={styles.howTo} accessible>
                  <View style={styles.accent} />
                  <View style={styles.howToText}>
                    <Text style={styles.howToTitle}>{t}</Text>
                    <Text style={styles.howToBody}>{b}</Text>
                  </View>
                </View>
              ))}
              <Text style={styles.footnote}>
                Not a cane replacement. Does not detect curbs, drop-offs, or moving cars.
              </Text>
            </View>
          </ScrollView>
          <View style={styles.footer}>
            <BigButton label="Get started" hint="Starts a three step setup" onPress={() => setStep(1)} />
          </View>
        </Animated.View>
      </View>
    );
  }

  const header = (title: string, sub: string) => (
    <Header
      title={title}
      sub={sub}
      onBack={() => setStep(step - 1)}
      backHint="Goes to the previous step"
      step={step}
      steps={3}
    />
  );

  if (step === 1) {
    const choices: { v: Vision; label: string; hint: string }[] = [
      { v: 'see', label: 'I can see the screen', hint: 'Shows the camera with tags on objects' },
      { v: 'large', label: 'I see little or nothing', hint: 'Big distance number and voice, no camera picture' },
    ];
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        {header('How much can you see?', 'Tap one. You can change it later in Settings.')}
        <Animated.View style={fadeIn}>
          <ScrollView contentContainerStyle={styles.content}>
            {choices.map((c) => (
              <Tap
                key={c.v}
                style={styles.choice}
                onPress={() => {
                  p.onVision(c.v);
                  setStep(2);
                }}
                accessibilityRole="button"
                accessibilityLabel={c.label}
                accessibilityHint={c.hint}
              >
                <Text style={styles.choiceText}>{c.label}</Text>
              </Tap>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    );
  }

  if (step === 2) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        {header('Where will you use it?', 'This sets how far ahead it warns you.')}
        <Animated.View style={fadeIn}>
          <ScrollView contentContainerStyle={styles.content}>
            <Segment
              value={p.mode}
              onChange={p.onMode}
              options={[
                { value: 'indoor', label: 'Indoor', hint: 'Warns at about 2 meters' },
                { value: 'outdoor', label: 'Outdoor', hint: 'Warns at about 4 meters' },
              ]}
            />
            <Caption>Indoor warns at about 2 m. Outdoor warns at about 4 m.</Caption>
          </ScrollView>
          <View style={styles.footer}>
            <BigButton label="Continue" hint="Goes to step 3" onPress={() => setStep(3)} />
          </View>
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {header('How should it alert you?', 'Turn on what helps. Tap a voice to hear it.')}
      <Animated.View style={fadeIn}>
        <ScrollView contentContainerStyle={styles.content}>
          <ToggleRow
            label="Guidance voice"
            hint="When off, the phone's own voice reads warnings instead"
            value={p.prefs.speech}
            onChange={(v) => p.onPrefs({ speech: v })}
          />
          <ToggleRow
            label="Haptics"
            hint="Vibrates for warnings and the guide"
            value={p.prefs.haptics}
            onChange={(v) => p.onPrefs({ haptics: v })}
          />
          <Section title="VOICE" />
          <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
          <Caption>You can add a trusted person's voice later, in Settings.</Caption>
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
  // Blue hero at the top of the welcome screen, running up under the status bar.
  hero: {
    backgroundColor: C.blue,
    paddingTop: SAFE.top + SPACE.xxl,
    paddingBottom: SPACE.xxl,
    paddingHorizontal: GUTTER,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  appName: { color: '#fff', fontSize: 48, marginTop: SPACE.xl, ...font('heavy') },
  tagline: { color: '#fff', fontSize: 24, marginTop: SPACE.xs, ...font('regular') },
  body: { paddingHorizontal: GUTTER, paddingTop: SPACE.xxl },
  howTo: { flexDirection: 'row', gap: SPACE.lg, marginBottom: SPACE.xl },
  accent: { width: 6, borderRadius: 3, backgroundColor: C.blue },
  howToText: { flex: 1 },
  howToTitle: { color: C.ink, fontSize: 23, ...font('bold') },
  howToBody: { color: C.ink2, fontSize: 19, marginTop: SPACE.xs, ...font('regular') },
  footnote: { color: C.ink2, fontSize: 17, lineHeight: 24, marginTop: SPACE.sm, ...font('regular') },
  choice: {
    backgroundColor: C.blue,
    borderRadius: 24,
    minHeight: 128,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: GUTTER,
    marginBottom: SPACE.lg,
  },
  choiceText: { color: '#fff', fontSize: 28, textAlign: 'center', ...font('bold') },
  big: { backgroundColor: C.blue, minHeight: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  bigText: { color: '#fff', fontSize: 28, ...font('bold') },
});
