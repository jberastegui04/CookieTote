import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Caption, LinkRow, Section, Segment, SpeedSlider, ToggleRow, VoiceList } from './controls';
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
  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          style={styles.back}
          onPress={p.onClose}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityHint="Returns to the camera"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
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
          label="Speech"
          hint="Speaks what's ahead after each scan"
          value={p.prefs.speech}
          onChange={(v) => p.onPrefs({ speech: v })}
        />
        <ToggleRow
          label="Sonar beeps"
          hint="Plays tones while sonar is on"
          value={p.prefs.beeps}
          onChange={(v) => p.onPrefs({ beeps: v })}
        />
        <ToggleRow
          label="Haptics"
          hint="Vibrates for warnings and sonar"
          value={p.prefs.haptics}
          onChange={(v) => p.onPrefs({ haptics: v })}
        />
        <SpeedSlider value={p.prefs.speed} onChange={(i) => p.onPrefs({ speed: i })} />

        <Section title="GUIDANCE VOICE" />
        <Caption>The voice that reads obstacle warnings. Tap one to hear it.</Caption>
        <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
        <LinkRow
          label={CLONE_LABEL[p.cloneStep]}
          hint={p.cloneStep === 'idle' ? 'Hears a consent notice first, then records for thirty seconds' : undefined}
          onPress={p.onClone}
          active={p.cloneStep === 'recording'}
        />

        <Section title="HELP" />
        <LinkRow label="Replay setup" hint="Goes through the first-launch setup again" onPress={p.onReplaySetup} />
        <Text style={styles.body}>
          Warns about things standing still in your path. It does not replace a cane, and it does not detect curbs,
          drop-offs, moving cars, or street crossings.
        </Text>
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
