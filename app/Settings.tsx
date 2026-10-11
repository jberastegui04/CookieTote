import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Caption, Header, LinkRow, Section, Segment, SpeedSlider, Tap, ToggleRow, VoiceList } from './controls';
import type { Prefs } from './prefs';
import { Enter } from './motion';
import { DotGrid } from './texture';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type Mode = 'auto' | 'indoor' | 'outdoor';
type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
type Voice = { id: string; name: string; custom?: boolean };
type Listen = 'idle' | 'listening' | 'working';

type Props = {
  mode: Mode;
  onMode: (m: Mode) => void;
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  voices: Voice[];
  voiceId: string | null;
  onPickVoice: (v: Voice) => void;
  onRenameVoice: (id: string, name: string) => void;
  onDeleteVoice: (id: string) => void;
  onSayName: () => Promise<string | null>;
  nameState: Listen;
  newVoiceId: string | null; // just recorded: open its page so it gets a name
  onNewVoiceShown: () => void;
  cloneStep: CloneStep;
  onClone: () => void;
  onReplaySetup: () => void;
  onClose: () => void;
};

const CLONE_LABEL: Record<CloneStep, string> = {
  idle: 'Record a new trusted voice',
  confirm: 'Tap to start recording',
  recording: 'Stop recording',
  uploading: 'Adding the voice…',
};

const SAY_NAME_LABEL: Record<Listen, string> = {
  idle: 'Say the name',
  listening: 'Listening… say it now',
  working: 'Working it out…',
};

export default function Settings(p: Props) {
  // The voice list opens as its own page, like a row in iPhone Settings, and each trusted voice
  // opens its own page from there (rename, delete).
  const [page, setPage] = useState<'main' | 'voice' | 'edit'>('main');
  const [editId, setEditId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false); // the page was opened for a voice just recorded

  // Settings slides up when it opens; coming back to it from a sub-page just fades.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  // Pages opened from a list slide in from the right; going back to the list fades.
  const lastPage = useRef(page);
  const backFromEdit = lastPage.current === 'edit';
  useEffect(() => {
    lastPage.current = page;
  }, [page]);

  useEffect(() => {
    if (p.newVoiceId && p.voices.some((v) => v.id === p.newVoiceId && v.custom)) {
      setEditId(p.newVoiceId);
      setNaming(true);
      setPage('edit');
      p.onNewVoiceShown();
    }
  }, [p.newVoiceId, p.voices]);
  // Seconds into a voice recording, so the row shows that it is running (it used to just say "Stop recording").
  const [recordedS, setRecordedS] = useState(0);
  useEffect(() => {
    if (p.cloneStep !== 'recording') return;
    const started = Date.now();
    setRecordedS(0);
    const tick = setInterval(() => setRecordedS(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(tick);
  }, [p.cloneStep]);
  const [showLimits, setShowLimits] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const voiceName = p.voices.find((v) => v.id === p.voiceId)?.name ?? 'Default';

  const editing = page === 'edit' ? p.voices.find((v) => v.id === editId && v.custom) : undefined;

  if (editing) {
    // Still has the server's placeholder name ("Trusted voice 2") right after recording.
    const unnamed = naming && editing.name.startsWith('Trusted voice');
    const confirmDelete = () =>
      Alert.alert(`Delete ${editing.name}?`, 'The voice is removed. You can record it again later.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setPage('voice');
            p.onDeleteVoice(editing.id);
          },
        },
      ]);
    return (
      <Enter key="edit" from="right" style={styles.screen} accessibilityViewIsModal>
        <DotGrid />
        <Header
          title={unnamed ? 'Name the new voice' : editing.name}
          sub={unnamed ? 'Say it or type it.' : undefined}
          onBack={() => {
            setNaming(false);
            setPage('voice');
          }}
          backHint="Returns to the voices"
        />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Section title="NAME" />
          <LinkRow
            label={SAY_NAME_LABEL[p.nameState]}
            hint='Listens until you stop talking. Say just the name, like "Mom".'
            onPress={async () => {
              const name = await p.onSayName();
              if (name) p.onRenameVoice(editing.id, name);
            }}
            active={p.nameState !== 'idle'}
          />
          <Text style={[styles.subLabel, styles.nameLabel]}>Or type it</Text>
          <TextInput
            key={editing.name} // refills the box after a spoken rename
            style={[styles.input, nameFocused && styles.inputFocused]}
            defaultValue={editing.name}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            onEndEditing={(e) => {
              const name = e.nativeEvent.text.trim();
              if (name && name !== editing.name) p.onRenameVoice(editing.id, name);
            }}
            placeholder="Like Mom"
            placeholderTextColor={C.ink2}
            maxLength={30}
            returnKeyType="done"
            autoCapitalize="words"
            accessibilityLabel={`Name, ${editing.name}`}
            accessibilityHint="Type a new name, or use the microphone key on the keyboard."
          />
          <Section title="REMOVE" />
          <Tap
            style={styles.delete}
            onPress={confirmDelete}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${editing.name}`}
            accessibilityHint="Asks before deleting"
          >
            <Text style={styles.deleteText}>Delete this voice</Text>
          </Tap>
        </ScrollView>
      </Enter>
    );
  }

  if (page !== 'main') {
    const own = p.voices.filter((v) => v.custom);
    return (
      <Enter key="voice" from={backFromEdit ? 'fade' : 'right'} style={styles.screen} accessibilityViewIsModal>
        <DotGrid />
        <Header
          title="Walker's voice"
          sub="He uses it for everything. Tap one to hear it."
          onBack={() => setPage('main')}
          backHint="Returns to settings"
        />
        <ScrollView contentContainerStyle={styles.content}>
          <Section title="VOICES" />
          <VoiceList voices={p.voices} selected={p.voiceId} onPick={p.onPickVoice} />
          <Section title="YOUR OWN" />
          {own.map((v) => (
            <LinkRow
              key={v.id}
              label={v.name}
              value="Edit"
              hint="Rename or delete this voice"
              onPress={() => {
                setEditId(v.id);
                setNaming(false);
                setPage('edit');
              }}
            />
          ))}
          <LinkRow
            label={p.cloneStep === 'recording' ? `Recording… ${recordedS} of 30 s. Tap to stop` : CLONE_LABEL[p.cloneStep]}
            // VoiceOver hears a fixed label, or it would read the row again every second.
            a11yLabel={CLONE_LABEL[p.cloneStep]}
            hint={p.cloneStep === 'idle' ? 'Hears a consent notice first, then records for thirty seconds' : undefined}
            onPress={p.onClone}
            active={p.cloneStep === 'recording'}
          />
          <Caption>Only record people who agree. Up to five.</Caption>
        </ScrollView>
      </Enter>
    );
  }

  return (
    <Enter key="main" from={opened.current ? 'fade' : 'up'} style={styles.screen} accessibilityViewIsModal>
      <DotGrid />
      <Header title="Settings" onBack={p.onClose} backHint="Returns to the camera" />
      <ScrollView contentContainerStyle={styles.content}>

        <Section title="WHERE ARE YOU?" />
        <Segment
          value={p.mode}
          onChange={p.onMode}
          options={[
            { value: 'auto', label: 'Auto', hint: 'Works out indoor or outdoor from the camera' },
            { value: 'indoor', label: 'Indoor', hint: 'Warns at about 2 meters' },
            { value: 'outdoor', label: 'Outdoor', hint: 'Warns at about 4 meters' },
          ]}
        />

        <Section title="DISTANCE" />
        <Segment
          value={p.prefs.units}
          onChange={(units) => p.onPrefs({ units })}
          options={[
            { value: 'meters', label: 'Meters', hint: 'Distances in meters' },
            { value: 'feet', label: 'Feet', hint: 'Distances in feet' },
          ]}
        />
        <View style={styles.gap} />
        <Text style={styles.subLabel}>Warn me</Text>
        <Segment
          value={p.prefs.warning}
          onChange={(warning) => p.onPrefs({ warning })}
          options={[
            { value: 'close', label: 'Close', hint: 'Warns later, when things are nearer' },
            { value: 'normal', label: 'Normal', hint: 'The usual warning distance' },
            { value: 'early', label: 'Early', hint: 'Warns sooner, so you have more time to stop' },
          ]}
        />

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
          label="Walker's voice"
          value={voiceName}
          hint="Opens the list of voices. Walker, the guide and Find all use the one you pick."
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
    </Enter>
  );
}

const styles = StyleSheet.create({
  gap: { height: SPACE.lg },
  nameLabel: { marginTop: SPACE.xl },
  input: {
    minHeight: 72,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: C.ink2,
    backgroundColor: C.card,
    paddingHorizontal: GUTTER,
    color: C.ink,
    fontSize: 22,
    ...font('semibold'),
  },
  inputFocused: { borderColor: C.accent, borderWidth: 3 },
  delete: {
    minHeight: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: C.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { color: C.ink, fontSize: 22, ...font('bold') },
  subLabel: { color: C.ink, fontSize: 20, marginBottom: SPACE.sm, ...font('bold') },
  screen: { ...StyleSheet.absoluteFill, backgroundColor: C.bg },
  // The first section heading adds its own space above, so the content starts close to the band.
  content: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm, paddingBottom: SAFE.bottom + SPACE.xxl },
  body: { color: C.ink2, fontSize: 18, lineHeight: 26, marginTop: SPACE.xs, ...font('regular') },
});
