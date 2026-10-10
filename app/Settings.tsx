import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Caption, Header, LinkRow, Section, Segment, SpeedSlider, ToggleRow, VoiceList } from './controls';
import type { Prefs } from './prefs';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

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

  if (page === 'voice') {
    return (
      <View style={styles.screen} accessibilityViewIsModal>
        <Header
          title="Voice"
          sub="Reads warnings and guides you while you walk. Tap one to hear it."
          onBack={() => setPage('main')}
          backHint="Returns to settings"
        />
        <ScrollView contentContainerStyle={styles.content}>
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
      <Header title="Settings" onBack={p.onClose} backHint="Returns to the camera" />
      <ScrollView contentContainerStyle={styles.content}>

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
  // The first section heading adds its own space above, so the content starts close to the band.
  content: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm, paddingBottom: SAFE.bottom + SPACE.xxl },
  body: { color: C.ink2, fontSize: 18, lineHeight: 26, marginTop: SPACE.xs, ...font('regular') },
});
