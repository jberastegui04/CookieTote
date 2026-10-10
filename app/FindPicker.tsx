import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Caption, Header, LinkRow, Section } from './controls';
import { capitalize, loadFindTargets } from './find';
import { C, GUTTER, SAFE, SPACE } from './theme';

type Props = {
  onPick: (target: string) => void;
  onSpeak: () => void;
  speakState: 'idle' | 'listening' | 'working';
  onClose: () => void;
};

const SPEAK_LABEL = {
  idle: 'Say what to find',
  listening: 'Listening… say it now',
  working: 'Working it out…',
};

// Full-screen list of things Find can look for, from GET /find/targets. Tapping one starts Find.
export default function FindPicker(p: Props) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

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

  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <Header
        title="Find something"
        sub="Pick what to look for. A voice tells you which way to turn."
        onBack={p.onClose}
        backHint="Returns to the camera"
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="SAY IT" />
        <LinkRow
          label={SPEAK_LABEL[p.speakState]}
          hint='Records for three seconds. Say something like "find the chair".'
          onPress={p.onSpeak}
          active={p.speakState !== 'idle'}
        />
        <Caption>For example "find the red bench" or "where is the table".</Caption>
        <Section title="OR PICK" />
        {targets ? (
          targets.map((t) => (
            <LinkRow
              key={t}
              label={capitalize(t)}
              hint={`Starts looking for a ${t}`}
              onPress={() => p.onPick(t)}
            />
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
  retry: { marginTop: SPACE.lg },
});
