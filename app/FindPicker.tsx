import { useEffect, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Caption, Header, LinkRow, Section, Tap } from './controls';
import { capitalize, DESCRIPTION_MAX_CHARS, loadFindTargets, targetFromDescription } from './find';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Props = {
  onPick: (target: string, description?: string) => void;
  onSpeak: () => void;
  speakState: 'idle' | 'listening' | 'working';
  onClose: () => void;
};

const SPEAK_LABEL = {
  idle: 'Say what to find',
  listening: 'Listening… say it now',
  working: 'Working it out…',
};

// Three ways to pick what Find looks for: say it (recorded, sent to /transcribe), type a
// description ("red bench"), or tap one of the objects from GET /find/targets.
export default function FindPicker(p: Props) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function load() {
    setFailed(false);
    loadFindTargets()
      .then(setTargets)
      .catch((e) => {
        console.warn(e);
        setFailed(true);
      });
  }

  useEffect(load, []);

  function findDescribed() {
    const description = text.trim();
    if (!description) return;
    if (!targets) {
      setProblem('The list of objects is still loading. Try again in a moment.');
      AccessibilityInfo.announceForAccessibility('The list is still loading. Try again in a moment.');
      return;
    }
    // One of the objects the server knows, if the words name one; otherwise the words themselves
    // ("door", "exit sign"), which the server searches for with an open-vocabulary detector.
    const target = targetFromDescription(description, targets) ?? description;
    p.onPick(target, description);
  }

  const canSubmit = text.trim().length > 0;

  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <Header
        title="Find something"
        sub="Say it, type it, or pick one. A voice tells you which way to turn."
        onBack={p.onClose}
        backHint="Returns to the camera"
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Section title="SAY IT" />
        <LinkRow
          label={SPEAK_LABEL[p.speakState]}
          hint='Records for three seconds. Say something like "find the chair".'
          onPress={p.onSpeak}
          active={p.speakState !== 'idle'}
        />
        <Caption>For example "find the red bench" or "where is the table".</Caption>
        <Section title="OR TYPE IT" />
        <TextInput
          style={[styles.input, focused && styles.inputFocused]}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setProblem(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={findDescribed}
          placeholder="Describe it, like red bench"
          placeholderTextColor={C.ink2}
          maxLength={DESCRIPTION_MAX_CHARS}
          returnKeyType="search"
          autoCapitalize="none"
          accessibilityLabel="Describe what to find"
          accessibilityHint="Type or use the microphone key on the keyboard. For example, red bench, or person in a dark hoodie."
        />
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        <Tap
          style={[styles.findIt, !canSubmit && styles.findItOff]}
          onPress={findDescribed}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Find it"
          accessibilityHint="Starts looking for what you described"
          accessibilityState={{ disabled: !canSubmit }}
        >
          <Text style={[styles.findItText, !canSubmit && styles.findItTextOff]}>Find it</Text>
        </Tap>

        <Section title="OR PICK ONE" />
        {targets ? (
          targets.map((t) => (
            <LinkRow key={t} label={capitalize(t)} hint={`Starts looking for a ${t}`} onPress={() => p.onPick(t)} />
          ))
        ) : failed ? (
          <>
            <Caption>Couldn't reach the server.</Caption>
            <View style={styles.retry}>
              <LinkRow label="Try again" hint="Loads the list again" onPress={load} />
            </View>
          </>
        ) : (
          <Caption>Loading the list. If the server was asleep, this can take about a minute.</Caption>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill, backgroundColor: C.bg },
  content: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm, paddingBottom: SAFE.bottom + SPACE.xxl },
  input: {
    minHeight: 72,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: C.ink2,
    backgroundColor: C.bg,
    paddingHorizontal: GUTTER,
    color: C.ink,
    fontSize: 22,
    ...font('semibold'),
  },
  inputFocused: { borderColor: C.blue, borderWidth: 3 },
  problem: { color: C.ink, fontSize: 18, lineHeight: 24, marginTop: SPACE.sm, ...font('bold') },
  findIt: {
    minHeight: 72,
    borderRadius: 36,
    backgroundColor: C.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACE.md,
  },
  // Disabled until something is typed: outlined instead of filled, still readable.
  findItOff: { backgroundColor: C.bg, borderWidth: 2, borderColor: C.border },
  findItText: { color: '#fff', fontSize: 24, ...font('bold') },
  findItTextOff: { color: C.ink2 },
  retry: { marginTop: SPACE.lg },
});
