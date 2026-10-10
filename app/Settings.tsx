import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Caption, LinkRow, Section, Segment, SpeedSlider, ToggleRow, VoiceList } from './controls';
import { tapHaptic } from './feedback';
import type { Prefs } from './prefs';
import { C, font } from './theme';

type Mode = 'indoor' | 'outdoor';
type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
type Voice = { id: string; name: string };

type Props = {
  mode: Mode;
  onMode: (m: Mode) => void;
  cameraPicture: boolean;
  onCameraPicture: (on: boolean) => void;
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  voices: Voice[];
  voiceId: string | null;
  onPickVoice: (v: Voice) => void;
  cloneStep: CloneStep;
  onClone: () => void;
  onReplaySetup: () => void;
  onClose: () => void;
};

const CLONE_LABEL: Record<CloneStep, string> = {
  idle: 'Record a trusted voice',
  confirm: 'Tap to start recording',
  recording: 'Stop recording',
  uploading: 'Adding the voice…',
};

export default function Settings(p: Props) {
  // The voice list opens as its own page, like a row in iPhone Settings.
  const [page, setPage] = useState<'main' | 'voice'>('main');
  const [showLimits, setShowLimits] = useState(false);
  const voiceName = p.voices.find((v) => v.id === p.voiceId)?.name ?? 'Default';

  const back = (onPress: () => void, hint: string) => (
    <Pressable
      style={styles.back}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      accessibilityRole="button" accessibilityLabel="Back" accessibilityHint={hint}>
      <Text style={styles.backText}>‹ Back</Text>
    </Pressable>
  );

  if (page === 'voice') {
    return (
      <View style={styles.screen} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          {back(() => setPage('main'), 'Returns to settings')}
          <Text style={styles.title} accessibilityRole="header">
            Voice
          </Text>
          <Caption>The voice that reads warnings and guides you while you walk. Tap one to hear it.</Caption>
          <Section title="VOICES" />
          <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
          <Section title="YOUR OWN" />
          <LinkRow
            label={CLONE_LABEL[p.cloneStep]}
            hint={p.cloneStep === 'idle' ? 'Hears a consent notice first, then records for thirty seconds' : undefined}
            onPress={p.onClone}
            active={p.cloneStep === 'recording'}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <ScrollView contentContainerStyle={styles.content}>
        {back(p.onClose, 'Returns to the camera')}
        <Text style={styles.title} accessibilityRole="header">
          Settings
        </Text>

        <Section title="WHERE ARE YOU?" />
        <Segment
          value={p.mode}
          onChange={p.onMode}
          options={[
            { value: 'indoor', label: 'Indoor', hint: 'Warns at about 2 meters' },
            { value: 'outdoor', label: 'Outdoor', hint: 'Warns at about 4 meters' },
          ]}
        />
        <Caption>Indoor warns at about 2 m. Outdoor warns at about 4 m.</Caption>

        <Section title="SCREEN" />
        <ToggleRow
          label="Camera picture"
          hint="When off, the screen shows only a big distance number"
          value={p.cameraPicture}
          onChange={p.onCameraPicture}
        />
        <Caption>Turn off to show only the big distance number.</Caption>

        <Section title="SOUND & TOUCH" />
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
        <LinkRow
          label="Voice"
          value={voiceName}
          hint="Opens the list of voices"
          onPress={() => setPage('voice')}
        />
        <SpeedSlider value={p.prefs.speed} onChange={(i) => p.onPrefs({ speed: i })} />

        <Section title="HELP" />
        <LinkRow label="Replay setup" value="Play" hint="Goes through the first-launch setup again" onPress={p.onReplaySetup} />
        <LinkRow
          label="What it can't see"
          value={showLimits ? 'Hide' : 'Read'}
          hint="Shows what the app does not detect"
          onPress={() => setShowLimits(!showLimits)}
        />
        {showLimits ? (
          <Text style={styles.body}>
            Warns about things standing still in your path. It does not replace a cane, and it does not detect curbs,
            drop-offs, moving cars, or street crossings.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 60 },
  back: {
    alignSelf: 'flex-start',
    minHeight: 56,
    paddingHorizontal: 24,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: C.blue,
    justifyContent: 'center',
  },
  backText: { color: C.blue, fontSize: 21, ...font('bold') },
  title: { color: C.ink, fontSize: 38, marginTop: 16, marginBottom: 4, ...font('heavy') },
  body: { color: C.ink2, fontSize: 18, lineHeight: 26, marginTop: 6, ...font('regular') },
});
