import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Settings from './Settings';
import Setup, { type Vision } from './Setup';
import { DEFAULT_PREFS, SPEEDS, type Prefs } from './prefs';
import { C, font } from './theme';

// Your laptop's address on the same Wi-Fi, set in app/.env (see README).
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

type Mode = 'indoor' | 'outdoor';

// Matches POST /describe in the README. Keep in sync with backend/main.py.
type DescribeResult = {
  clear: boolean;
  sentence: string;
  label: string | null;
  distance_m: number | null;
  direction: 'left' | 'ahead' | 'right' | null;
  height: 'foot' | 'waist' | 'head' | null;
  box: [number, number, number, number] | null;
  audio_b64: string | null; // WAV, base64
};

// Matches POST /sonar in the README.
type SonarResult = {
  clear: boolean;
  distance_m: number | null;
  direction: 'left' | 'ahead' | 'right' | null;
  open: 'left' | 'right' | null; // side with clearly more room, if any
};
type Side = 'left' | 'ahead' | 'right';

type Status = 'idle' | 'capturing' | 'thinking' | 'error';

type Voice = { id: string; name: string };
// Voice cloning: tap to hear the consent notice, tap again to record, tap again to stop and upload.
type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
const CLONE_MAX_MS = 30000;
const VOICE_KEY = 'voice_id';
const MODE_KEY = 'mode';
const CAMERA_KEY = 'camera_picture';
const SETUP_KEY = 'setup_done';
const PREFS_KEY = 'prefs';
// The obstacle tag and card clear after this, so an old warning doesn't linger once you've passed it.
const RESULT_SHOW_MS = 5000;
// Free ngrok links answer with an HTML warning page unless this header is sent.
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Guide mode: a frame to /sonar about once a second, and a voice that speaks only when the
// situation changes (open / far / close / stop, with a direction), plus a reminder now and then.
const GUIDE_PERIOD_MS = 1000;
const GUIDE_REMIND_MS = 5000;
// "Stop" when straight ahead and this close; "close" under CLOSE_DISTANCE_M in any direction.
const STOP_DISTANCE_M = 0.7;
const CLOSE_DISTANCE_M = 1.2;
// "Path looks open" needs this many clear readings in a row, so one noisy frame can't say it.
const OPEN_STREAK = 2;

type Situation = { key: string; text: string; stop: boolean };
const OPEN: Situation = { key: 'open', text: 'Path looks open.', stop: false };

function classify(distance: number, direction: Side, open: 'left' | 'right' | null): Situation {
  if (direction === 'ahead' && distance <= STOP_DISTANCE_M) {
    return {
      key: `stop:${open ?? ''}`,
      text: `Stop. Something right in front of you.${open ? ` More room on the ${open}.` : ''}`,
      stop: true,
    };
  }
  const where = direction === 'ahead' ? 'ahead' : `on your ${direction}`;
  if (distance <= CLOSE_DISTANCE_M) {
    return { key: `close:${direction}`, text: `Something close ${where}.`, stop: false };
  }
  const meters = Math.max(1, Math.min(4, Math.round(distance)));
  const unit = meters === 1 ? 'meter' : 'meters';
  // backend/main.py only speaks these exact phrases (GUIDE_PHRASES); change both together.
  return { key: `far:${direction}:${meters}`, text: `Something ${where}, about ${meters} ${unit}.`, stop: false };
}

// Phrases worth fetching as soon as guide mode turns on, so the first warning isn't late.
const COMMON_PHRASES = [
  OPEN.text,
  classify(0.5, 'ahead', null).text,
  classify(0.5, 'ahead', 'left').text,
  classify(0.5, 'ahead', 'right').text,
  classify(1, 'ahead', null).text,
  classify(1, 'left', null).text,
  classify(1, 'right', null).text,
  classify(2, 'ahead', null).text,
  classify(2, 'left', null).text,
  classify(2, 'right', null).text,
];

function hashKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function majority(items: Side[]): Side {
  const counts = new Map<Side, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best = items[items.length - 1];
  for (const [k, n] of counts) if (n > (counts.get(best) ?? 0)) best = k;
  return best;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The models shrink every photo to about 500 px, so a full-size photo (1 to 2 MB) only makes the
// upload slow, which is what you feel outside on weak Wi-Fi or mobile data.
const DESCRIBE_WIDTH_PX = 768;
const SONAR_WIDTH_PX = 384;

async function shrink(uri: string, width: number): Promise<string> {
  const image = await ImageManipulator.manipulate(uri).resize({ width }).renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
  return saved.uri;
}

const DIRECTION_WORD = { left: 'slightly left', ahead: 'ahead', right: 'slightly right' } as const;
const ARROW = { left: '←', ahead: '↑', right: '→' } as const;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Photos come back portrait 3:4; the preview fills the screen and crops the sides.
const PHOTO_ASPECT = 3 / 4;

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const player = useAudioPlayer(null);
  const lastClip = useRef<File | null>(null);
  const [mode, setMode] = useState<Mode>('indoor');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DescribeResult | null>(null);
  // Voice picker. The list comes from GET /voices; the choice is remembered on the phone.
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const voiceIdRef = useRef<string | null>(null);
  const screenReader = useRef(false);
  const [cloneStep, setCloneStep] = useState<CloneStep>('idle');
  const cloneStepRef = useRef<CloneStep>('idle');
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Guide mode. The loops below run for a long time, so they read refs instead of state.
  const [guideOn, setGuideOn] = useState(false);
  const [guideDistance, setGuideDistance] = useState<number | null>(null);
  const [guideSide, setGuideSide] = useState<Side | null>(null);
  const [guideText, setGuideText] = useState('');
  const guideOnRef = useRef(false);
  const modeRef = useRef<Mode>('indoor');
  const cameraBusy = useRef(false); // one photo at a time, shared by describe and guide
  const quietUntil = useRef(0); // guide stays quiet while a describe sentence is being spoken
  const situation = useRef<Situation | null>(null); // newest reading, sorted; null until the first one
  const recentDirections = useRef<Side[]>([]); // last few readings, so one noisy frame can't flip the side
  const clearStreak = useRef(0);
  // The guide voice: one phrase at a time, files cached per voice, and the phone's voice as fallback.
  const speechBusy = useRef(false);
  const speakingStop = useRef(false);
  const phraseFiles = useRef(new Map<string, string>());

  // Screens and layout. Settings opens over the camera so the guide keeps working.
  const [showSettings, setShowSettings] = useState(false);
  // Off: no camera picture, just the big number (for people who see little of the screen).
  const [cameraPicture, setCameraPicture] = useState(true);
  const { width: screenW, height: screenH } = useWindowDimensions();
  // null until the saved answer loads, so the camera doesn't flash before setup.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const prefsRef = useRef<Prefs>(DEFAULT_PREFS);
  // The last result stays (magic tap repeats it), but its on-screen tag hides after a few seconds.
  const [resultVisible, setResultVisible] = useState(false);

  useEffect(() => {
    if (!result) return;
    setResultVisible(true);
    const t = setTimeout(() => setResultVisible(false), RESULT_SHOW_MS);
    return () => clearTimeout(t);
  }, [result]);

  useEffect(() => {
    // Play warnings even when the phone's silent switch is on.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    AccessibilityInfo.isScreenReaderEnabled().then((on) => (screenReader.current = on));
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader.current = on));
    AsyncStorage.multiGet([MODE_KEY, CAMERA_KEY, SETUP_KEY, PREFS_KEY])
      .then(([[, savedMode], [, savedCamera], [, savedSetup], [, savedPrefs]]) => {
        setSetupDone(savedSetup === '1');
        if (savedPrefs) {
          const loaded = { ...DEFAULT_PREFS, ...JSON.parse(savedPrefs) };
          prefsRef.current = loaded;
          setPrefs(loaded);
        }
        if (savedMode === 'indoor' || savedMode === 'outdoor') {
          modeRef.current = savedMode;
          setMode(savedMode);
        }
        if (savedCamera === 'off') setCameraPicture(false);
      })
      .catch(() => setSetupDone(false));
    AsyncStorage.getItem(VOICE_KEY)
      .then((saved) => {
        if (saved) {
          voiceIdRef.current = saved;
          setVoiceId(saved);
        }
      })
      .catch(() => {});
    loadVoices()
      .then((data) => {
        if (!voiceIdRef.current) {
          voiceIdRef.current = data.default;
          setVoiceId(data.default);
        }
      })
      .catch(() => {});
    // Stop the guide loops if the screen goes away.
    return () => {
      guideOnRef.current = false;
      sub.remove();
    };
  }, []);

  if (setupDone === null) return <View style={[styles.screen, styles.blank]} />;

  if (!setupDone) {
    return (
      <Setup
        mode={mode}
        onMode={changeMode}
        onVision={chooseVision}
        voices={voices}
        voiceId={voiceId}
        onPickVoice={pickVoice}
        onFinish={finishSetup}
      />
    );
  }

  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar style="dark" />
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>The camera looks ahead to find obstacles in your path.</Text>
        <Pressable
          style={styles.button}
          onPress={requestPermission}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
          accessibilityHint="Shows the camera permission prompt"
        >
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  // Short status messages. With VoiceOver on, an interrupting announcement (so it cuts off
  // VoiceOver re-reading the button); otherwise the phone's built-in voice.
  function tell(text: string) {
    if (screenReader.current) {
      AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: false });
    } else {
      Speech.stop();
      Speech.speak(text);
    }
  }

  function changeMode(next: Mode) {
    modeRef.current = next;
    setMode(next);
    AsyncStorage.setItem(MODE_KEY, next).catch(() => {});
    tell(next === 'indoor' ? 'Indoor' : 'Outdoor');
  }

  function chooseVision(v: Vision) {
    // Only those who can see the screen get the camera picture; the others get the big number.
    changeCameraPicture(v === 'see', false);
  }

  function finishSetup() {
    AsyncStorage.setItem(SETUP_KEY, '1').catch(() => {});
    setSetupDone(true);
  }

  function replaySetup() {
    setShowSettings(false);
    setSetupDone(false);
  }

  function updatePrefs(change: Partial<Prefs>) {
    const next = { ...prefsRef.current, ...change };
    prefsRef.current = next;
    setPrefs(next);
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
  }

  // Vibration for warnings and the guide, unless turned off in Settings.
  function buzz(style: Haptics.ImpactFeedbackStyle) {
    return prefsRef.current.haptics ? Haptics.impactAsync(style) : Promise.resolve();
  }

  function notify(type: Haptics.NotificationFeedbackType) {
    return prefsRef.current.haptics ? Haptics.notificationAsync(type) : Promise.resolve();
  }

  function changeCameraPicture(on: boolean, announce = true) {
    setCameraPicture(on);
    AsyncStorage.setItem(CAMERA_KEY, on ? 'on' : 'off').catch(() => {});
    if (announce) tell(on ? 'Camera picture on' : 'Camera picture off');
  }

  async function playUri(uri: string, headers?: Record<string, string>) {
    player.replace({ uri, headers });
    // Starting before the clip has loaded cuts off the first word.
    for (let i = 0; i < 80 && !player.isLoaded; i++) await sleep(25);
    player.setPlaybackRate(SPEEDS[prefsRef.current.speed].rate);
    player.play();
  }

  // Plays the ElevenLabs clip if the backend sent one, otherwise the phone's built-in voice.
  async function say(data: DescribeResult) {
    Speech.stop();
    if (data.audio_b64) {
      try {
        // The player needs a file, so save the clip to the cache folder first. The backend sends
        // WAV (base64 starts with "UklGR", which is "RIFF"); older backends sent mp3.
        const ext = data.audio_b64.startsWith('UklGR') ? 'wav' : 'mp3';
        const clip = new File(Paths.cache, `warning-${Date.now()}.${ext}`);
        clip.write(data.audio_b64, { encoding: 'base64' });
        await playUri(clip.uri);
        if (lastClip.current?.exists) lastClip.current.delete();
        lastClip.current = clip;
        return;
      } catch (e) {
        console.warn(e);
      }
    }
    Speech.speak(data.sentence, { rate: SPEEDS[prefsRef.current.speed].rate });
  }

  function setClone(step: CloneStep) {
    cloneStepRef.current = step;
    setCloneStep(step);
  }

  async function loadVoices() {
    const res = await fetch(`${API_URL}/voices`, { headers: HEADERS });
    const data: { default: string; voices: Voice[] } = await res.json();
    setVoices(data.voices);
    return data;
  }

  function chooseVoice(v: Voice) {
    voiceIdRef.current = v.id;
    setVoiceId(v.id);
    AsyncStorage.setItem(VOICE_KEY, v.id).catch(() => {});
  }

  // One button, three taps: consent notice, start recording, stop and upload.
  async function cloneTap() {
    const step = cloneStepRef.current;
    if (step === 'uploading') return;
    if (step === 'idle') {
      setClone('confirm');
      const notice =
        'This records a trusted person for thirty seconds and makes a voice from it. ' +
        'Only record someone who has agreed. Double tap again to start recording.';
      AccessibilityInfo.announceForAccessibility(notice);
      Speech.speak(notice);
      setTimeout(() => {
        if (cloneStepRef.current === 'confirm') setClone('idle');
      }, 20000);
      return;
    }
    if (step === 'confirm') {
      Speech.stop();
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setClone('idle');
        Speech.speak('Microphone access is needed to record a voice.');
        return;
      }
      if (guideOnRef.current) toggleGuide();
      try {
        // iOS only records when the audio session allows it; turned back off after the recording.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (e) {
        console.warn(e);
        setClone('idle');
        Speech.speak('Could not start recording.');
        return;
      }
      setClone('recording');
      await notify(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility('Recording. Speak naturally. Double tap to stop.');
      setTimeout(() => {
        if (cloneStepRef.current === 'recording') cloneTap();
      }, CLONE_MAX_MS);
      return;
    }
    // step === 'recording': stop and upload.
    setClone('uploading');
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (!recorder.uri) throw new Error('No recording');
      AccessibilityInfo.announceForAccessibility('Adding the voice, please wait.');
      Speech.speak('Adding the voice, please wait.');
      const form = new FormData();
      form.append('audio', new File(recorder.uri));
      form.append('consent', 'true');
      const res = await fetch(`${API_URL}/voices/clone`, { method: 'POST', body: form, headers: HEADERS });
      if (res.status === 422) {
        // The backend explains why ElevenLabs refused this recording, in plain words.
        const { detail } = await res.json();
        throw new Error(String(detail), { cause: 'spoken' });
      }
      if (!res.ok) throw new Error(`Server ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const added: Voice = await res.json();
      await loadVoices().catch(() => setVoices((prev) => [added, ...prev]));
      chooseVoice(added);
      setClone('idle');
      await notify(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility('Voice added. Playing a sample.');
      Speech.speak('Voice added.');
      await sleep(1200);
      await playUri(`${API_URL}/voices/${added.id}/sample.wav`, HEADERS);
    } catch (e) {
      console.warn(e);
      setClone('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      await notify(Haptics.NotificationFeedbackType.Error);
      const spoken = e instanceof Error && e.cause === 'spoken' ? e.message : 'Could not add the voice. Try again.';
      AccessibilityInfo.announceForAccessibility(spoken);
      Speech.speak(spoken);
    }
  }

  // Magic tap (two-finger double tap with VoiceOver on) repeats the last warning.
  async function repeatLast() {
    const last = result;
    if (status === 'capturing' || status === 'thinking') {
      tell('Still checking.');
      return;
    }
    if (!last) {
      tell('Nothing to repeat yet. Tap anywhere to scan.');
      return;
    }
    quietUntil.current = Date.now() + (last.audio_b64 ? 1500 : 3500);
    await say(last);
  }

  // Picks a voice from the list, plays its sample sentence, and remembers the choice.
  async function pickVoice(v: Voice) {
    chooseVoice(v);
    AccessibilityInfo.announceForAccessibility(`Voice: ${v.name}`);
    Haptics.selectionAsync();
    quietUntil.current = Date.now() + 1500; // keep the guide quiet while the sample plays
    try {
      await playUri(`${API_URL}/voices/${v.id}/sample.wav`, HEADERS);
    } catch (e) {
      console.warn(e);
    }
  }

  function toggleGuide() {
    const on = !guideOnRef.current;
    guideOnRef.current = on;
    setGuideOn(on);
    situation.current = null;
    recentDirections.current = [];
    clearStreak.current = 0;
    setGuideDistance(null);
    setGuideSide(null);
    setGuideText('');
    buzz(Haptics.ImpactFeedbackStyle.Light);
    tell(on ? 'Guide on. Walk slowly.' : 'Guide off');
    if (on) {
      quietUntil.current = Date.now() + 1500;
      guideLoop();
      guideVoiceLoop();
      prefetchPhrases();
    }
  }

  // True from a tap until the spoken sentence has finished, plus a short pause after it.
  function speaking() {
    if (player.playing) quietUntil.current = Math.max(quietUntil.current, Date.now() + 600);
    return Date.now() < quietUntil.current;
  }

  // Fetches the phrase in the chosen voice from GET /say, once per voice, and keeps the file.
  async function fetchPhrase(text: string): Promise<string | null> {
    const key = `${voiceIdRef.current ?? ''}|${text}`;
    const cached = phraseFiles.current.get(key);
    if (cached) return cached;
    try {
      const voice = voiceIdRef.current ? `&voice_id=${encodeURIComponent(voiceIdRef.current)}` : '';
      const res = await fetch(`${API_URL}/say?text=${encodeURIComponent(text)}${voice}`, { headers: HEADERS });
      if (!res.ok) return null;
      const file = new File(Paths.cache, `phrase-${hashKey(key)}.wav`);
      file.write(new Uint8Array(await res.arrayBuffer()));
      phraseFiles.current.set(key, file.uri);
      return file.uri;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  async function prefetchPhrases() {
    for (const text of COMMON_PHRASES) {
      if (!guideOnRef.current) return;
      await fetchPhrase(text);
    }
  }

  // Says one phrase and waits for it to finish. ElevenLabs voice if available, else the phone's.
  async function speakPhrase(text: string, stop: boolean) {
    speechBusy.current = true;
    speakingStop.current = stop;
    try {
      const uri = prefsRef.current.speech ? await fetchPhrase(text) : null;
      if (uri) {
        await playUri(uri);
        for (let i = 0; i < 10 && !player.playing; i++) await sleep(50);
        for (let i = 0; i < 100 && player.playing; i++) await sleep(100);
      } else {
        await new Promise<void>((resolve) => {
          Speech.speak(text, {
            rate: SPEEDS[prefsRef.current.speed].rate,
            onDone: resolve,
            onStopped: resolve,
            onError: () => resolve(),
          });
        });
      }
    } catch (e) {
      console.warn(e);
    } finally {
      speechBusy.current = false;
      speakingStop.current = false;
    }
  }

  // About once a second: small photo to /sonar, sort the reading into a situation.
  async function guideLoop() {
    let failures = 0;
    while (guideOnRef.current) {
      const started = Date.now();
      // No photos while a describe sentence is playing: taking one can make the speech stutter.
      if (!cameraBusy.current && !speaking()) {
        cameraBusy.current = true;
        try {
          const photo = await cameraRef.current?.takePictureAsync({ quality: 0.1, shutterSound: false });
          if (!photo) throw new Error('No photo');
          const form = new FormData();
          form.append('image', new File(await shrink(photo.uri, SONAR_WIDTH_PX)));
          form.append('mode', modeRef.current);
          const res = await fetch(`${API_URL}/sonar`, { method: 'POST', body: form, headers: HEADERS });
          if (!res.ok) throw new Error(`Server ${res.status}`);
          const data: SonarResult = await res.json();
          failures = 0;
          if (data.clear || data.distance_m === null) {
            recentDirections.current = [];
            clearStreak.current += 1;
            if (clearStreak.current >= OPEN_STREAK) situation.current = OPEN;
            if (guideOnRef.current) {
              setGuideDistance(null);
              setGuideSide(null);
            }
          } else {
            clearStreak.current = 0;
            // Direction is the majority of the last three readings; distance is always the newest.
            recentDirections.current = [...recentDirections.current, data.direction ?? 'ahead'].slice(-3);
            const side = majority(recentDirections.current);
            const next = classify(data.distance_m, side, data.open ?? null);
            // Only "stop" interrupts: cut whatever else is being said so it can be spoken now.
            if (next.stop && speechBusy.current && !speakingStop.current) {
              player.pause();
              Speech.stop();
            }
            situation.current = next;
            if (guideOnRef.current) {
              setGuideDistance(data.distance_m);
              setGuideSide(side);
            }
          }
        } catch (e) {
          console.warn(e);
          failures += 1;
          // Say it once, on the third miss in a row, instead of every second.
          if (failures === 3) {
            situation.current = null;
            setGuideDistance(null);
            setGuideSide(null);
            notify(Haptics.NotificationFeedbackType.Error);
            tell('Guide lost connection.');
          }
        } finally {
          cameraBusy.current = false;
        }
      }
      await sleep(Math.max(0, GUIDE_PERIOD_MS - (Date.now() - started)));
    }
  }

  // Speaks when the situation changes, reminds every few seconds while something is there,
  // and never talks over a describe sentence or over itself.
  async function guideVoiceLoop() {
    let lastKey: string | null = null;
    let lastSpokenAt = 0;
    while (guideOnRef.current) {
      const s = situation.current;
      if (!s || speaking() || speechBusy.current) {
        await sleep(100);
        continue;
      }
      const changed = s.key !== lastKey;
      const remind = s.key !== OPEN.key && Date.now() - lastSpokenAt > GUIDE_REMIND_MS;
      if (!changed && !remind) {
        await sleep(100);
        continue;
      }
      lastKey = s.key;
      lastSpokenAt = Date.now();
      setGuideText(s.text);
      if (s.stop) buzz(Haptics.ImpactFeedbackStyle.Heavy);
      await speakPhrase(s.text, s.stop);
    }
  }

  async function scan() {
    if (status === 'capturing' || status === 'thinking') return;
    try {
      setStatus('capturing');
      quietUntil.current = Date.now() + 8000;
      tell('Scanning');
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      // If the guide is mid-photo, wait for it; the camera takes one picture at a time.
      while (cameraBusy.current) await sleep(50);
      cameraBusy.current = true;
      let photo;
      try {
        photo = await cameraRef.current?.takePictureAsync({ quality: 0.5, shutterSound: !guideOnRef.current });
      } finally {
        cameraBusy.current = false;
      }
      if (!photo) throw new Error('No photo');

      setStatus('thinking');
      const form = new FormData();
      // Expo's fetch rejects React Native's old { uri, name, type } parts; it needs a real File.
      form.append('image', new File(await shrink(photo.uri, DESCRIBE_WIDTH_PX)));
      form.append('mode', mode);
      if (voiceIdRef.current) form.append('voice_id', voiceIdRef.current);

      const res = await fetch(`${API_URL}/describe`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data: DescribeResult = await res.json();
      setResult(data);
      setStatus('idle');

      if (data.distance_m !== null) {
        // Stronger buzz the closer the obstacle is.
        const style =
          data.distance_m < 1 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium;
        await buzz(style);
      }
      // Covers the moment before the clip starts; speaking() keeps the guide quiet until it ends.
      quietUntil.current = Date.now() + (data.audio_b64 ? 1500 : 3500);
      if (prefsRef.current.speech) await say(data);
    } catch (e) {
      console.warn(e);
      setStatus('error');
      quietUntil.current = Date.now() + 2500;
      await notify(Haptics.NotificationFeedbackType.Error);
      tell('No connection. Try again.');
    }
  }

  const busy = status === 'thinking' || status === 'capturing';
  const found = !guideOn && resultVisible && result != null && !result.clear ? result : null;
  const distance = guideOn ? guideDistance : (found?.distance_m ?? null);
  const showNumber = !busy && status !== 'error' && distance != null;
  const direction = guideOn ? guideSide : (found?.direction ?? null);

  const headline = busy
    ? 'Checking…'
    : status === 'error'
      ? 'No connection'
      : showNumber && distance != null
        ? `${distance.toFixed(1)} m`
        : guideOn || (resultVisible && result?.clear)
          ? 'Path clear'
          : 'Ready';
  const detail = busy
    ? 'Hold still'
    : status === 'error'
      ? 'Tap to try again'
      : showNumber
        ? [direction && DIRECTION_WORD[direction], !guideOn && found?.height ? `${found.height} height` : null]
            .filter(Boolean)
            .join(' · ')
        : guideOn
          ? guideText || 'The voice tells you what changes'
          : resultVisible && result?.clear
            ? 'Nothing in your path'
            : 'Tap anywhere to describe';
  const label = found?.label ? capitalize(found.label) : null;

  // Where the obstacle box lands on screen: the 3:4 photo is scaled to cover the screen.
  let box: { left: number; top: number; width: number; height: number } | null = null;
  if (found?.box && !busy) {
    const [x, y, w, h] = found.box;
    const scale = Math.max(screenW / PHOTO_ASPECT, screenH); // displayed photo height
    const photoW = scale * PHOTO_ASPECT;
    const offX = (screenW - photoW) / 2;
    const offY = (screenH - scale) / 2;
    box = { left: offX + x * photoW, top: offY + y * scale, width: w * photoW, height: h * scale };
  }

  const topBar = (
    <View style={styles.topBar} pointerEvents="box-none">
      <Pressable
        style={[styles.chip, !cameraPicture && styles.chipLarge]}
        onPress={() => changeMode(mode === 'indoor' ? 'outdoor' : 'indoor')}
        accessibilityRole="button"
        accessibilityLabel={mode === 'indoor' ? 'Indoor' : 'Outdoor'}
        accessibilityHint="Double tap to switch between indoor and outdoor"
      >
        <Text style={styles.chipText}>{mode === 'indoor' ? 'Indoor' : 'Outdoor'}</Text>
      </Pressable>
      <Pressable
        style={[styles.chip, !cameraPicture && styles.chipLarge]}
        onPress={() => setShowSettings(true)}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        accessibilityHint="Opens settings"
      >
        <Text style={styles.chipText}>Settings</Text>
      </Pressable>
    </View>
  );

  const guideButton = (
    <Pressable
      style={[styles.guide, guideOn ? styles.guideOn : styles.guideOff, !cameraPicture && styles.guideLarge]}
      onPress={toggleGuide}
      accessibilityRole="switch"
      accessibilityState={{ checked: guideOn }}
      accessibilityLabel="Guide"
      accessibilityHint="A voice tells you about obstacles while you walk"
    >
      <Text style={[styles.guideText, guideOn ? styles.guideTextOn : styles.guideTextOff]}>
        {guideOn ? 'Guide on' : 'Guide off'}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={styles.screen}
      accessibilityActions={[{ name: 'magicTap', label: 'Repeat the last warning' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'magicTap') repeatLast();
      }}
    >
      <StatusBar style={cameraPicture && !showSettings ? 'light' : 'dark'} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" animateShutter={false} />
      {/* Camera picture off: cover the preview. The camera still runs underneath. */}
      {!cameraPicture ? <View style={styles.cover} pointerEvents="none" /> : null}

      {/* The whole screen is one big tap target. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={scan}
        accessibilityRole="button"
        accessibilityLabel="Describe what's ahead"
        accessibilityHint="Double tap to scan"
        accessibilityState={{ busy: status === 'capturing' || status === 'thinking' }}
      />

      {cameraPicture ? (
        <>
          {/* Overlay drawing only; everything here is also spoken, so VoiceOver skips it. */}
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <View style={styles.topShade} />
            {box ? (
              <>
                <View style={[styles.box, box]} />
                <View style={[styles.tag, { left: box.left, top: Math.max(110, box.top - 48) }]}>
                  <Text style={styles.tagText}>
                    {label ?? 'Obstacle'}
                    {found?.distance_m != null ? ` · ${found.distance_m.toFixed(1)} m` : ''}
                  </Text>
                </View>
              </>
            ) : null}
          </View>
          {topBar}
          <View style={styles.bottom} pointerEvents="box-none">
            {/* Visual only (for sighted viewers and the projector). Everything here is also spoken. */}
            <View
              style={styles.card}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={[styles.headline, showNumber && styles.headlineNumber]}>
                {headline}
              </Text>
              {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            </View>
            {guideButton}
          </View>
        </>
      ) : (
        <>
          {topBar}
          <View style={styles.large} pointerEvents="box-none">
            <View
              style={styles.largeMiddle}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {label && showNumber ? <Text style={styles.largeLabel}>{label}</Text> : null}
              <Text
                style={[styles.largeHeadline, showNumber && styles.largeNumber]}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {headline}
              </Text>
              {detail ? <Text style={styles.largeDetail}>{detail}</Text> : null}
              {showNumber && direction ? (
                <Text style={styles.arrow}>
                  {ARROW[direction]}
                </Text>
              ) : null}
            </View>
            {guideButton}
          </View>
        </>
      )}

      {showSettings ? (
        <Settings
          mode={mode}
          onMode={changeMode}
          cameraPicture={cameraPicture}
          onCameraPicture={changeCameraPicture}
          prefs={prefs}
          onPrefs={updatePrefs}
          voices={voices}
          voiceId={voiceId}
          onPickVoice={pickVoice}
          cloneStep={cloneStep}
          onClone={cloneTap}
          onReplaySetup={replaySetup}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  blank: { backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 24, backgroundColor: C.bg },
  title: { color: C.ink, fontSize: 30, textAlign: 'center', ...font('heavy') },
  body: { color: C.ink2, fontSize: 20, textAlign: 'center', lineHeight: 28, ...font('regular') },
  button: {
    backgroundColor: C.blue,
    minHeight: 80,
    alignSelf: 'stretch',
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontSize: 26, ...font('bold') },
  cover: { ...StyleSheet.absoluteFill, backgroundColor: C.bg },
  topShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 140, backgroundColor: 'rgba(0,0,0,0.3)' },
  topBar: {
    position: 'absolute',
    top: 54,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  chip: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 24,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  chipLarge: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1.5 },
  chipText: { color: C.ink, fontSize: 18, ...font('semibold') },
  box: { position: 'absolute', borderWidth: 5, borderColor: C.bright, borderRadius: 18 },
  tag: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagText: { color: C.blue, fontSize: 20, ...font('bold') },
  bottom: { position: 'absolute', left: 20, right: 20, bottom: 40, gap: 12 },
  card: { backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 22, paddingHorizontal: 20, paddingVertical: 16 },
  headline: { color: C.blue, fontSize: 34, ...font('bold') },
  headlineNumber: { fontSize: 56, ...font('heavy') },
  detail: { color: C.ink2, fontSize: 18, marginTop: 2, ...font('semibold') },
  guide: { minHeight: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  guideLarge: { minHeight: 96, borderRadius: 48 },
  guideOn: { backgroundColor: C.blue },
  guideOff: { backgroundColor: 'rgba(255,255,255,0.94)', borderWidth: 2, borderColor: C.blue },
  guideText: { fontSize: 26, ...font('bold') },
  guideTextOn: { color: '#fff' },
  guideTextOff: { color: C.blue },
  large: { ...StyleSheet.absoluteFill, paddingTop: 130, paddingHorizontal: 20, paddingBottom: 40 },
  largeMiddle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  largeLabel: { color: C.ink, fontSize: 34, ...font('bold') },
  largeHeadline: { color: C.blue, fontSize: 56, textAlign: 'center', ...font('heavy') },
  largeNumber: { fontSize: 120 },
  largeDetail: { color: C.ink, fontSize: 30, textAlign: 'center', ...font('bold') },
  arrow: { color: C.ink, fontSize: 96, marginTop: 8, ...font('heavy') },
});
