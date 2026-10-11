import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Caption, Header, LinkRow, Section, Segment, SpeedSlider, Tap, ToggleRow, VoiceList, HOLD_MS, HoldContext } from './controls';
import type { Prefs } from './prefs';
import { Enter } from './motion';
import { DotGrid } from './texture';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
type Voice = { id: string; name: string; custom?: boolean };
type Listen = 'idle' | 'listening' | 'working';

type Props = {
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
  cloneMaxS: number; // how long this recording runs (shorter when started through Walker)
  onReplaySetup: () => void;
  onClose: () => void;
  onHold: () => void; // press and hold anywhere: talk to Walker
  // Which page is showing, kept by the app so Walker's spoken menu and the screen stay in step:
  // saying "voice" opens the voice page, and tapping it moves Walker there too.
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  focus: 'distance' | 'sound' | 'help' | null; // the section Walker is reading: scrolled into view
};

export type SettingsPage = 'main' | 'voice' | 'edit';

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

// Press and hold anywhere on any Settings page talks to Walker: on a row (through HoldContext) or
// on empty space (the Pressable here, which VoiceOver doesn't see as an element of its own).
export default function Settings(p: Props) {
  return (
    <HoldContext.Provider value={p.onHold}>
      <Pressable style={StyleSheet.absoluteFill} onLongPress={p.onHold} delayLongPress={HOLD_MS} accessible={false} accessibilityViewIsModal>
        <SettingsPages {...p} />
      </Pressable>
    </HoldContext.Provider>
  );
}

function SettingsPages(p: Props) {
  // The voice list opens as its own page, like a row in iPhone Settings, and each trusted voice
  // opens its own page from there (rename, delete).
  const page = p.page;
  const setPage = p.onPage;
  // Where each main-page section starts, so the one Walker is reading can be scrolled into view.
  const mainScroll = useRef<ScrollView>(null);
  const sectionY = useRef<Record<string, number>>({});
  useEffect(() => {
    if (page !== 'main' || !p.focus) return;
    const y = sectionY.current[p.focus];
    if (y !== undefined) mainScroll.current?.scrollTo({ y: Math.max(0, y - SPACE.sm), animated: true });
  }, [p.focus, page]);
  const markSection = (key: string) => (e: { nativeEvent: { layout: { y: number } } }) => {
    sectionY.current[key] = e.nativeEvent.layout.y;
  };
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
    // Default voices come with the app; custom ones were recorded here and are the only ones that can
    // be renamed or deleted (their Edit button).
    const defaults = p.voices.filter((v) => !v.custom);
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
          <Section title="DEFAULT VOICES" />
          <VoiceList voices={defaults} selected={p.voiceId} onPick={p.onPickVoice} />
          <Section title="CUSTOM VOICES" />
          <VoiceList
            voices={own}
            selected={p.voiceId}
            onPick={p.onPickVoice}
            onEdit={(v) => {
              setEditId(v.id);
              setNaming(false);
              setPage('edit');
            }}
            empty={p.voices.length ? 'No custom voices yet.' : ' '}
          />
          <LinkRow
            label={p.cloneStep === 'recording' ? `Recording… ${recordedS} of ${p.cloneMaxS} s. Tap to stop` : CLONE_LABEL[p.cloneStep]}
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
      <ScrollView ref={mainScroll} contentContainerStyle={styles.content}>

        <View onLayout={markSection('distance')}>
          <Section title="DISTANCE" />
        </View>
        <Text style={styles.subLabel}>Units</Text>
        <Segment
          value={p.prefs.units}
          onChange={(units) => p.onPrefs({ units })}
          options={[
            { value: 'meters', label: 'Meters', hint: 'Distances in meters' },
            { value: 'feet', label: 'Feet', hint: 'Distances in feet' },
          ]}
        />
        <View style={styles.gap} />
        <Text style={styles.subLabel}>Obstacle Detection</Text>
        <Segment
          value={p.prefs.warning}
          onChange={(warning) => p.onPrefs({ warning })}
          options={[
            { value: 'close', label: 'Close', hint: 'Warns later, when things are nearer' },
            { value: 'normal', label: 'Normal', hint: 'The usual warning distance' },
            { value: 'early', label: 'Far', hint: 'Warns from farther away, so you have more time to stop' },
          ]}
        />

        <View onLayout={markSection('sound')}>
          <Section title="SOUND & TOUCH" />
        </View>
        <ToggleRow
          label="Haptics"
          hint="Vibrates for warnings and while finding"
          value={p.prefs.haptics}
          onChange={(v) => p.onPrefs({ haptics: v })}
        />
        <LinkRow
          label="Walker's voice"
          value={voiceName}
          hint="Opens the list of voices. Walker and Find use the one you pick."
          onPress={() => setPage('voice')}
        />
        <SpeedSlider value={p.prefs.speed} onChange={(i) => p.onPrefs({ speed: i })} />

        <View onLayout={markSection('help')}>
          <Section title="HELP" />
        </View>
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
