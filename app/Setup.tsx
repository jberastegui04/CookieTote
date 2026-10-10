import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Caption, Section, Segment, VoiceList } from './controls';
import { C, font } from './theme';

type Mode = 'indoor' | 'outdoor';
type Voice = { id: string; name: string };
export type Vision = 'see' | 'large' | 'none';

type Props = {
  mode: Mode;
  onMode: (m: Mode) => void;
  onVision: (v: Vision) => void;
  voices: Voice[];
  voiceId: string | null;
  onPickVoice: (v: Voice) => void;
  onFinish: () => void;
};

// First launch: a welcome screen, then three short steps. Each choice can be changed later in Settings.
export default function Setup(p: Props) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const titles = ['Welcome', 'Step 1 of 3. How much can you see?', 'Step 2 of 3. Where will you use it?', 'Step 3 of 3. Pick a guidance voice.'];
    AccessibilityInfo.announceForAccessibility(titles[step]);
  }, [step]);

  if (step === 0) {
    return (
      <View style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.icon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.iconRing}>
              <View style={styles.iconDot} />
            </View>
          </View>
          <Text style={styles.appName} accessibilityRole="header">
            WatchIt
          </Text>
          <Text style={styles.tagline}>Hear what's in your path.</Text>
          {[
            ['Tap anywhere', "Hear what's ahead and how far."],
            ['Turn on Sonar', 'Beeps speed up near things.'],
            ['Two-finger double tap', 'Repeats the last warning.'],
          ].map(([t, b]) => (
            <View key={t} style={styles.howTo} accessible>
              <Text style={styles.howToTitle}>{t}</Text>
              <Text style={styles.howToBody}>{b}</Text>
            </View>
          ))}
          <Text style={styles.footnote}>
            Not a cane replacement. Does not detect curbs, drop-offs, or moving cars.
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <BigButton label="Get started" hint="Starts a three step setup" onPress={() => setStep(1)} />
        </View>
      </View>
    );
  }

  const header = (title: string, sub: string) => (
    <>
      <View style={styles.headRow}>
        <Pressable
          style={styles.back}
          onPress={() => setStep(step - 1)}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityHint="Goes to the previous step"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.stepCount}>Step {step} of 3</Text>
      </View>
      <View style={styles.progress} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[1, 2, 3].map((i) => (
          <View key={i} style={[styles.progressBar, i <= step && styles.progressOn]} />
        ))}
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.sub}>{sub}</Text>
    </>
  );

  if (step === 1) {
    const choices: { v: Vision; label: string; hint: string }[] = [
      { v: 'see', label: 'I can see the screen', hint: 'Shows the camera with tags on objects' },
      { v: 'large', label: 'I need large text', hint: 'Shows a big distance number, no camera picture' },
      { v: 'none', label: "I can't see the screen", hint: 'Sound and vibration first' },
    ];
    return (
      <View style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.content}>
          {header('How much can you see?', 'Tap one. You can change it later in Settings.')}
          {choices.map((c) => (
            <Pressable
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
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  if (step === 2) {
    return (
      <View style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.content}>
          {header('Where will you use it?', 'This sets how far ahead it warns you.')}
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
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        {header('Pick a guidance voice', 'This voice reads obstacle warnings. Tap one to hear it.')}
        <Section title="VOICES" />
        <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
      </ScrollView>
      <View style={styles.footer}>
        <BigButton label="Finish" hint="Opens the camera" onPress={p.onFinish} />
      </View>
    </View>
  );
}

function BigButton(p: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable
      style={styles.big}
      onPress={p.onPress}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint={p.hint}
    >
      <Text style={styles.bigText}>{p.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 30 },
  footer: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },
  icon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: C.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 30,
  },
  iconRing: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.blue },
  appName: { color: C.ink, fontSize: 44, marginTop: 20, ...font('heavy') },
  tagline: { color: C.ink, fontSize: 24, marginBottom: 24, ...font('regular') },
  howTo: { marginBottom: 18 },
  howToTitle: { color: C.ink, fontSize: 23, ...font('bold') },
  howToBody: { color: C.ink2, fontSize: 19, marginTop: 2, ...font('regular') },
  footnote: { color: C.ink2, fontSize: 17, lineHeight: 24, marginTop: 12, ...font('regular') },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: {
    minHeight: 56,
    paddingHorizontal: 24,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: C.blue,
    justifyContent: 'center',
  },
  backText: { color: C.blue, fontSize: 21, ...font('bold') },
  stepCount: { color: C.ink2, fontSize: 18, ...font('semibold') },
  progress: { flexDirection: 'row', gap: 8, marginTop: 16 },
  progressBar: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#D1D1D6' },
  progressOn: { backgroundColor: C.blue },
  title: { color: C.ink, fontSize: 34, marginTop: 20, ...font('heavy') },
  sub: { color: C.ink2, fontSize: 19, marginTop: 6, marginBottom: 20, lineHeight: 26, ...font('regular') },
  choice: {
    backgroundColor: C.blue,
    borderRadius: 20,
    minHeight: 130,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  choiceText: { color: '#fff', fontSize: 28, textAlign: 'center', ...font('bold') },
  big: { backgroundColor: C.blue, minHeight: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  bigText: { color: '#fff', fontSize: 28, ...font('bold') },
});
