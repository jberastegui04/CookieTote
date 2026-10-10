import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import {
  useFonts,
  AtkinsonHyperlegibleNext_400Regular,
  AtkinsonHyperlegibleNext_600SemiBold,
  AtkinsonHyperlegibleNext_700Bold,
  AtkinsonHyperlegibleNext_800ExtraBold,
} from '@expo-google-fonts/atkinson-hyperlegible-next';
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
import { DeviceMotion } from 'expo-sensors';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Settings from './Settings';
import FindPicker from './FindPicker';
import FindScreen from './FindScreen';
import { setTapHaptics, tapHaptic } from './feedback';
import { useReduceMotion } from './motion';
import Setup, { type Vision } from './Setup';
import { DEFAULT_PREFS, SPEEDS, type Prefs } from './prefs';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

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

// Matches POST /find in the README.
type FindResult = {
  found: boolean;
  target: string;
  description: string | null; // the user's words, if they described it
  match: 'yes' | 'possible' | 'no' | null; // how well the best candidate fits the description
  match_score: number | null;
  direction: Side | null;
  bearing_deg: number | null; // right is positive
  distance_m: number | null;
  centered: boolean;
  box: [number, number, number, number] | null;
  sentence: string;
  obstacle: SonarResult;
};

type Status = 'idle' | 'capturing' | 'thinking' | 'error';

type Voice = { id: string; name: string };
// Voice cloning: tap to hear the consent notice, tap again to record, tap again to stop and upload.
type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
const CLONE_MAX_MS = 30000;
const VOICE_KEY = 'voice_id';
const MODE_KEY = 'mode';
const CAMERA_KEY = 'camera_picture';
const SETUP_KEY = 'setup_done';
// For the demo, setup opens on every launch (last choices already selected). Set to false so it only shows once.
const ALWAYS_SHOW_SETUP = true;
const PREFS_KEY = 'prefs';
// The obstacle tag and card clear after this, so an old warning doesn't linger once you've passed it.
const RESULT_SHOW_MS = 5000;
// Free ngrok links answer with an HTML warning page unless this header is sent.
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Guide mode: a frame to /sonar about once a second, and a voice that speaks only when the
// situation changes (open / far / close / stop, with a direction), plus a reminder now and then.
const GUIDE_PERIOD_MS = 500;
// Up to this many frames waiting on the server at once; answers older than the newest applied are dropped.
const GUIDE_IN_FLIGHT = 2;
// Reminders while the situation hasn't changed: sooner when something is close.
const GUIDE_REMIND_MS = 5000;
const GUIDE_REMIND_CLOSE_MS = 2500;
// Skip the camera's processing step for guide frames (much faster delivery). If frames come out
// sideways (the guide says "ahead" for things clearly to one side), set this to false.
const GUIDE_SKIP_PROCESSING = true;
// "Stop" when straight ahead and this close; "close" under CLOSE_DISTANCE_M in any direction.
// Both scale with the "Warn me" setting, like the server's warning distance (close / normal / early).
const STOP_DISTANCE_M = 0.7;
const CLOSE_DISTANCE_M = 1.2;
const WARNING_SCALE = { close: 0.75, normal: 1, early: 1.5 } as const;
type Warning = keyof typeof WARNING_SCALE;
type Units = 'meters' | 'feet';
const FEET_PER_METER = 3.281;
// Settings that may not exist yet in prefs.ts (they're being added); defaults until they do.
type GuideSettings = { units?: Units; warning?: Warning };
// "Path looks open" needs this many clear readings in a row, so one noisy frame can't say it.
const OPEN_STREAK = 2;
// Find mode: repeat the sentence this often while it hasn't changed, and pulse harder as the
// target nears the center of the frame (bearing 0).
const FIND_REMIND_MS = 3000;
const FIND_AHEAD_DEG = 8;
const FIND_NEAR_DEG = 16;
// Remembered heading. The camera sees about 52 degrees, so once the target has been seen the app
// notes which way the phone was pointing (gyro) and keeps guiding by that when it's out of view:
// "Chair at 2 o'clock", and pulses several times a second from the gyro, not from the frames.
const CAMERA_HALF_FOV_DEG = 26;
// The gyro's yaw grows counterclockwise; heading here grows clockwise (like a compass). If turning
// right makes the clock position drift the wrong way on a real phone, flip this to -1.
const YAW_SIGN = 1;
// Out-of-view misses in a row before a remembered heading is dropped (the target may have been a false hit).
const FIND_MISS_LIMIT = 3;
// After this many answers in a row with nothing found, Find sends sharper frames, so small or
// far-off things (a bottle across the room) have a chance. Costs some upload time per frame.
const FIND_BLANKS_FOR_SHARP = 2;
const FIND_SHARP_WIDTH_PX = 1024;
const clockPhrase = (target: string, offsetDeg: number) => {
  const hour = ((Math.round(offsetDeg / 30) + 12) % 12) || 12;
  return `${capitalize(target)} at ${hour} o'clock.`;
};
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180; // to (-180, 180]
// Each gyro reading moves the heading this fraction of the way to the new value (1 = no smoothing).
const HEADING_SMOOTHING = 0.5;
// Centered and this close: you've arrived. Find stops and says to reach forward.
const ARRIVE_DISTANCE_M = 0.7;
const arrivalPhrase = (target: string) => `You're there. The ${target} is right in front of you. Reach forward.`;

type Situation = { key: string; text: string; stop: boolean };
const OPEN: Situation = { key: 'open', text: 'Path looks open.', stop: false };

function classify(
  distance: number,
  direction: Side,
  open: 'left' | 'right' | null,
  settings: GuideSettings = {},
): Situation {
  const scale = WARNING_SCALE[settings.warning ?? 'normal'];
  if (direction === 'ahead' && distance <= STOP_DISTANCE_M * scale) {
    return {
      key: `stop:${open ?? ''}`,
      text: `Stop. Something right in front of you.${open ? ` More room on the ${open}.` : ''}`,
      stop: true,
    };
  }
  const where = direction === 'ahead' ? 'ahead' : `on your ${direction}`;
  if (distance <= CLOSE_DISTANCE_M * scale) {
    return { key: `close:${direction}`, text: `Something close ${where}.`, stop: false };
  }
  // backend/main.py only speaks these exact phrases (GUIDE_PHRASES); change both together.
  if (settings.units === 'feet') {
    const feet = Math.max(1, Math.min(20, Math.round(distance * FEET_PER_METER)));
    const unit = feet === 1 ? 'foot' : 'feet';
    return { key: `far:${direction}:${feet}ft`, text: `Something ${where}, about ${feet} ${unit}.`, stop: false };
  }
  const meters = Math.max(1, Math.min(4, Math.round(distance)));
  const unit = meters === 1 ? 'meter' : 'meters';
  return { key: `far:${direction}:${meters}`, text: `Something ${where}, about ${meters} ${unit}.`, stop: false };
}

// Said at the start of every scan, in the chosen voice. The backend's /say allows it (main.py).
const SCANNING = 'Scanning.';

// Phrases worth fetching as soon as guide mode turns on, so the first warning isn't late.
function commonPhrases(settings: GuideSettings): string[] {
  const far = settings.units === 'feet' ? [1.52, 2.13, 3.05] : [2, 3]; // 5, 7, 10 feet or 2, 3 meters
  return [
    OPEN.text,
    classify(0.5, 'ahead', null, settings).text,
    classify(0.5, 'ahead', 'left', settings).text,
    classify(0.5, 'ahead', 'right', settings).text,
    classify(1, 'ahead', null, settings).text,
    classify(1, 'left', null, settings).text,
    classify(1, 'right', null, settings).text,
    ...far.flatMap((d) => (['ahead', 'left', 'right'] as Side[]).map((side) => classify(d, side, null, settings).text)),
  ];
}

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
// Guide frames: at 384 px the depth model read 10 to 28% farther than at the size it was
// calibrated on (table at 1.37 m read 1.68 at 384, 1.39 at 512).
const SONAR_WIDTH_PX = 512;

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
  const [fontsLoaded, fontError] = useFonts({
    AtkinsonHyperlegibleNext_400Regular,
    AtkinsonHyperlegibleNext_600SemiBold,
    AtkinsonHyperlegibleNext_700Bold,
    AtkinsonHyperlegibleNext_800ExtraBold,
  });
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
  // Find mode: where a chosen object is. Shares the frame loop and the voice with the guide.
  const [findOn, setFindOn] = useState(false);
  const [findTarget, setFindTarget] = useState<string | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const [findInfo, setFindInfo] = useState<FindResult | null>(null);
  // "Say what to find": a 3 second recording goes to /transcribe, then Find starts with the answer.
  const [speakState, setSpeakState] = useState<'idle' | 'listening' | 'working'>('idle');
  const findDescriptionRef = useRef<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(null); // target just reached, until the next action
  const findOnRef = useRef(false);
  const findTargetRef = useRef<string | null>(null);
  const headingRef = useRef<number | null>(null); // phone heading in degrees, clockwise, from the gyro
  const [headingNow, setHeadingNow] = useState<number | null>(null); // same, as state, so the screen follows the turn
  const targetHeadingRef = useRef<number | null>(null); // heading the target was last seen at
  const findMisses = useRef(0);
  const findBlanks = useRef(0); // answers in a row with the target not in the frame
  const motionSub = useRef<{ remove: () => void } | null>(null);
  const arriveSound = useAudioPlayer(require('./assets/arrive.wav'));
  // The guide voice: one phrase at a time, files cached per voice, and the phone's voice as fallback.
  const speechBusy = useRef(false);
  const speakingStop = useRef(false);
  const phraseFiles = useRef(new Map<string, string>());
  const sampleFiles = useRef(new Map<string, string>()); // voice id -> saved sample WAV
  const latestSample = useRef<string | null>(null); // only the last voice tapped gets played

  // Screens and layout. Settings opens over the camera so the guide keeps working.
  const [showSettings, setShowSettings] = useState(false);
  // Off: no camera picture, just the big number (for people who see little of the screen).
  const [cameraPicture, setCameraPicture] = useState(true);
  const { width: screenW, height: screenH } = useWindowDimensions();
  // null until the saved answer loads, so the camera doesn't flash before setup.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const prefsRef = useRef<Prefs>(DEFAULT_PREFS);
  const settingsOpen = useRef(false);
  const guideWasOn = useRef(false);
  // The last result stays (magic tap repeats it), but its on-screen tag hides after a few seconds.
  const [resultVisible, setResultVisible] = useState(false);

  useEffect(() => {
    if (!result) return;
    setResultVisible(true);
    const t = setTimeout(() => setResultVisible(false), RESULT_SHOW_MS);
    return () => clearTimeout(t);
  }, [result]);

  // While the guide is on, a soft halo pulses around its button. Still (not pulsing) with Reduce Motion.
  const reduceMotion = useReduceMotion();
  const halo = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!guideOn || reduceMotion) {
      halo.stopAnimation();
      halo.setValue(guideOn ? 0.6 : 0);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0.2, duration: 900, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [guideOn, reduceMotion]);

  useEffect(() => {
    // Play warnings even when the phone's silent switch is on.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    AccessibilityInfo.isScreenReaderEnabled().then((on) => (screenReader.current = on));
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader.current = on));
    AsyncStorage.multiGet([MODE_KEY, CAMERA_KEY, SETUP_KEY, PREFS_KEY])
      .then(([[, savedMode], [, savedCamera], [, savedSetup], [, savedPrefs]]) => {
        setSetupDone(!ALWAYS_SHOW_SETUP && savedSetup === '1');
        if (savedPrefs) {
          const loaded = { ...DEFAULT_PREFS, ...JSON.parse(savedPrefs) };
          prefsRef.current = loaded;
          setPrefs(loaded);
          setTapHaptics(loaded.haptics);
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
        fetchPhrase(SCANNING); // so the first "Scanning." is already in the chosen voice
      })
      .catch(() => {});
    // Stop the guide loops if the screen goes away.
    return () => {
      guideOnRef.current = false;
      findOnRef.current = false;
      sub.remove();
    };
  }, []);

  // If the font fails to load, carry on with the system font rather than a blank screen.
  if (setupDone === null || (!fontsLoaded && !fontError)) return <View style={[styles.screen, styles.blank]} />;

  if (!setupDone) {
    return (
      <Setup
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
          onPress={() => {
            tapHaptic();
            requestPermission();
          }}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
          accessibilityHint="Shows the camera permission prompt"
        >
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  // "Scanning." in the chosen voice, like the warnings that follow (a /say phrase, cached per voice).
  // With VoiceOver on, it goes through VoiceOver instead. Not awaited, so the photo isn't delayed.
  function sayStatus(text: string) {
    if (screenReader.current) {
      tell(text);
      return;
    }
    Speech.stop();
    const cached = prefsRef.current.speech ? phraseFiles.current.get(`${voiceIdRef.current ?? ''}|${text}`) : undefined;
    if (cached) {
      playUri(cached).catch(() => {});
    } else {
      Speech.speak(text, { rate: SPEEDS[prefsRef.current.speed].rate });
      if (prefsRef.current.speech) fetchPhrase(text); // ready in the chosen voice next time
    }
  }

  // Opening Settings silences the app and pauses the guide; closing it turns the guide back on.
  function openSettings() {
    tapHaptic();
    settingsOpen.current = true;
    Speech.stop();
    player.pause();
    guideWasOn.current = guideOnRef.current;
    if (guideOnRef.current) toggleGuide();
    setShowSettings(true);
  }

  function closeSettings() {
    settingsOpen.current = false;
    setShowSettings(false);
    if (guideWasOn.current && !guideOnRef.current) toggleGuide();
    guideWasOn.current = false;
  }

  // The Find button opens the target picker (FindPicker loads GET /find/targets itself).
  // Like Settings, it silences the app and pauses the guide.
  function openFindPicker() {
    tapHaptic();
    Speech.stop();
    player.pause();
    if (guideOnRef.current) toggleGuide();
    setShowTargets(true);
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
  }

  function chooseVision(v: Vision) {
    // Only those who can see the screen get the camera picture; the others get the big number.
    changeCameraPicture(v === 'see');
  }

  function finishSetup() {
    AsyncStorage.setItem(SETUP_KEY, '1').catch(() => {});
    setSetupDone(true);
  }

  function replaySetup() {
    settingsOpen.current = false;
    guideWasOn.current = false; // setup replaces the camera screen, so the guide stays off
    setShowSettings(false);
    setSetupDone(false);
  }

  function updatePrefs(change: Partial<Prefs>) {
    const next = { ...prefsRef.current, ...change };
    prefsRef.current = next;
    setPrefs(next);
    setTapHaptics(next.haptics);
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
  }

  // Units and "Warn me" from Settings, for the guide's own phrases and thresholds.
  function guideSettings(): GuideSettings {
    const p = prefsRef.current as Prefs & GuideSettings;
    return { units: p.units ?? 'meters', warning: p.warning ?? 'normal' };
  }

  // Vibration for warnings and the guide, unless turned off in Settings.
  function buzz(style: Haptics.ImpactFeedbackStyle) {
    return prefsRef.current.haptics ? Haptics.impactAsync(style) : Promise.resolve();
  }

  function notify(type: Haptics.NotificationFeedbackType) {
    return prefsRef.current.haptics ? Haptics.notificationAsync(type) : Promise.resolve();
  }

  // No spoken echo here or in other taps: VoiceOver already reads the new state of what was tapped.
  function changeCameraPicture(on: boolean) {
    setCameraPicture(on);
    AsyncStorage.setItem(CAMERA_KEY, on ? 'on' : 'off').catch(() => {});
  }

  async function playUri(uri: string, headers?: Record<string, string>) {
    player.replace({ uri, headers });
    // Starting before the clip has loaded cuts off the first word.
    for (let i = 0; i < 80 && !player.isLoaded; i++) await sleep(25);
    player.setPlaybackRate(SPEEDS[prefsRef.current.speed].rate);
    player.play();
  }

  // Plays the ElevenLabs clip if the backend sent one and Guidance voice is on,
  // otherwise the phone's built-in voice.
  async function say(data: DescribeResult) {
    Speech.stop();
    if (data.audio_b64 && prefsRef.current.speech) {
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
    fetchPhrase(SCANNING);
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
      if (findOnRef.current) stopFind();
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
      sampleFiles.current.delete(added.id); // a new recording replaces the old trusted voice
      await playSample(added.id);
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
    await playSample(v.id);
  }

  // The iPhone player won't stream a WAV from a server without range requests (ours sends the
  // whole file), so samples are downloaded once per voice and played from the phone.
  async function playSample(id: string) {
    latestSample.current = id;
    quietUntil.current = Date.now() + 3000; // keep the guide quiet while the sample plays
    try {
      let uri = sampleFiles.current.get(id);
      if (!uri) {
        const res = await fetch(`${API_URL}/voices/${id}/sample.wav`, { headers: HEADERS });
        if (!res.ok) throw new Error(`Sample ${res.status}`);
        const file = new File(Paths.cache, `sample-${hashKey(id)}-${Date.now()}.wav`);
        file.write(new Uint8Array(await res.arrayBuffer()));
        uri = file.uri;
        sampleFiles.current.set(id, uri);
      }
      if (latestSample.current !== id) return; // a different voice was tapped while this loaded
      Speech.stop();
      await playUri(uri);
    } catch (e) {
      console.warn(e);
    }
  }

  function loopsOn() {
    return guideOnRef.current || findOnRef.current;
  }

  function toggleGuide() {
    const on = !guideOnRef.current;
    if (on && findOnRef.current) stopFind(false);
    setArrived(null);
    guideOnRef.current = on;
    setGuideOn(on);
    situation.current = null;
    recentDirections.current = [];
    clearStreak.current = 0;
    setGuideDistance(null);
    setGuideSide(null);
    setGuideText('');
    buzz(Haptics.ImpactFeedbackStyle.Light);
    if (on) {
      quietUntil.current = Date.now() + 1500;
      frameLoop(() => guideOnRef.current, '/sonar', () => ({}), applyGuide);
      voiceLoop();
      prefetchPhrases();
    }
  }

  // Find mode: pick a target in FindPicker, then frames go to /find until Stop finding.
  function startFind(target: string, description: string | null = null) {
    setShowTargets(false);
    if (guideOnRef.current) toggleGuide();
    findTargetRef.current = target;
    findDescriptionRef.current = description;
    setFindTarget(target);
    findOnRef.current = true;
    setFindOn(true);
    setArrived(null);
    situation.current = null;
    setFindInfo(null);
    buzz(Haptics.ImpactFeedbackStyle.Light);
    tell(`Finding ${target}. Turn slowly.`);
    quietUntil.current = Date.now() + 1800;
    targetHeadingRef.current = null;
    findMisses.current = 0;
    findBlanks.current = 0;
    startHeading();
    frameLoop(
      () => findOnRef.current,
      '/find',
      (): Record<string, string> =>
        findDescriptionRef.current ? { target, description: findDescriptionRef.current } : { target },
      applyFind,
    );
    voiceLoop();
    pulseLoop();
    fetchPhrase(`No ${target} yet. Turn slowly.`).then(() => fetchPhrase(arrivalPhrase(target)));
  }

  // Tap, say "find the red bench", done. Records for 3 seconds, sends it to /transcribe, and
  // starts Find with what came back. Works with VoiceOver because nothing has to be held.
  async function speakToFind() {
    if (speakState !== 'idle') return;
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      tell('Microphone access is needed to say what to find.');
      return;
    }
    setSpeakState('listening');
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      await buzz(Haptics.ImpactFeedbackStyle.Medium);
      AccessibilityInfo.announceForAccessibility('Listening');
      await sleep(3000);
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      if (!recorder.uri) throw new Error('No recording');
      setSpeakState('working');
      const form = new FormData();
      form.append('audio', new File(recorder.uri));
      const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data: { text: string; target: string | null; description: string | null } = await res.json();
      setSpeakState('idle');
      if (!data.text) {
        tell("I didn't catch that. Try again.");
        return;
      }
      if (!data.target) {
        tell('I can find chairs, tables, benches, couches and people. Say one of those.');
        return;
      }
      startFind(data.target, data.description);
    } catch (e) {
      console.warn(e);
      setSpeakState('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not understand. Try again, or pick from the list.');
    }
  }

  // Gyro heading while Find is on. Degrees, clockwise, relative (no compass needed).
  async function startHeading() {
    headingRef.current = null;
    try {
      if (!(await DeviceMotion.isAvailableAsync())) return;
      // 20 readings a second; FindScreen glides the box between them so it moves smoothly.
      DeviceMotion.setUpdateInterval(50);
      motionSub.current = DeviceMotion.addListener((m) => {
        if (m.rotation) {
          const raw = -YAW_SIGN * (m.rotation.alpha * 180) / Math.PI;
          const prev = headingRef.current;
          // Light smoothing takes the hand shake out of the box without noticeable lag.
          headingRef.current = prev === null ? raw : wrapDeg(prev + HEADING_SMOOTHING * wrapDeg(raw - prev));
          setHeadingNow(headingRef.current);
        }
      });
    } catch (e) {
      console.warn(e);
    }
  }

  function stopHeading() {
    motionSub.current?.remove();
    motionSub.current = null;
    headingRef.current = null;
    setHeadingNow(null);
    targetHeadingRef.current = null;
  }

  // How far to turn to face the remembered target, in degrees (right is positive), or null.
  function targetOffset(): number | null {
    if (headingRef.current === null || targetHeadingRef.current === null) return null;
    return wrapDeg(targetHeadingRef.current - headingRef.current);
  }

  // Haptics from the gyro, several times a second: stronger and faster as you turn toward the
  // target, a double pulse when you're facing it. Runs until Find stops.
  async function pulseLoop() {
    while (findOnRef.current) {
      const off = targetOffset();
      if (off === null) {
        await sleep(200);
        continue;
      }
      const a = Math.abs(off);
      if (a <= FIND_AHEAD_DEG) {
        buzz(Haptics.ImpactFeedbackStyle.Heavy);
        if (a <= 5) setTimeout(() => buzz(Haptics.ImpactFeedbackStyle.Heavy), 140);
        await sleep(350);
      } else if (a <= CAMERA_HALF_FOV_DEG) {
        buzz(Haptics.ImpactFeedbackStyle.Medium);
        await sleep(500);
      } else if (a <= 90) {
        buzz(Haptics.ImpactFeedbackStyle.Light);
        await sleep(800);
      } else {
        await sleep(300);
      }
    }
  }

  // Centered and within reach: stop, ding, buzz, and say so.
  async function arrive(target: string) {
    stopFind(false);
    setArrived(target);
    notify(Haptics.NotificationFeedbackType.Success);
    arriveSound.seekTo(0).then(() => arriveSound.play()).catch(() => {});
    await sleep(450);
    await speakPhrase(arrivalPhrase(target), true);
  }

  function stopFind(announce = true) {
    findOnRef.current = false;
    setFindOn(false);
    stopHeading();
    situation.current = null;
    setFindInfo(null);
    if (announce) {
      buzz(Haptics.ImpactFeedbackStyle.Light);
      tell('Find off');
    }
  }

  // True from a describe tap (or a voice sample) until that clip has finished, plus a short pause.
  // Guide phrases don't count: the guide keeps taking frames while it talks.
  function describePlaying() {
    if (player.playing && !speechBusy.current) {
      quietUntil.current = Math.max(quietUntil.current, Date.now() + 600);
    }
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
    for (const text of commonPhrases(guideSettings())) {
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

  // Cuts whatever the voice is saying so a "stop" can be spoken right away.
  function interruptForStop(next: Situation) {
    if (next.stop && speechBusy.current && !speakingStop.current) {
      player.pause();
      Speech.stop();
    }
  }

  function applyGuide(data: SonarResult, _heading: number | null) {
    if (data.clear || data.distance_m === null) {
      recentDirections.current = [];
      clearStreak.current += 1;
      if (clearStreak.current >= OPEN_STREAK) situation.current = OPEN;
      setGuideDistance(null);
      setGuideSide(null);
      return;
    }
    clearStreak.current = 0;
    // Direction is the majority of the last three readings; distance is always the newest.
    recentDirections.current = [...recentDirections.current, data.direction ?? 'ahead'].slice(-3);
    const side = majority(recentDirections.current);
    const next = classify(data.distance_m, side, data.open ?? null, guideSettings());
    interruptForStop(next);
    situation.current = next;
    // A pulse on every reading, stronger when closer. Never waits on speech.
    buzz(
      data.distance_m < 1
        ? Haptics.ImpactFeedbackStyle.Heavy
        : data.distance_m < 2
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light,
    );
    setGuideDistance(data.distance_m);
    setGuideSide(side);
  }

  function applyFind(data: FindResult, headingAtCapture: number | null) {
    const target = findTargetRef.current ?? data.target;
    findBlanks.current = data.found ? 0 : findBlanks.current + 1;
    if (data.found && data.bearing_deg !== null && headingAtCapture !== null) {
      // Remember which way the phone pointed, even if an obstacle takes the sentence below.
      targetHeadingRef.current = wrapDeg(headingAtCapture + data.bearing_deg);
    }
    // An obstacle in the way wins over the target: "Stop" interrupts, "close" just takes the next
    // turn to speak, so you can step around it and let the clock point you back.
    const o = data.obstacle;
    const danger =
      !o.clear && o.distance_m !== null
        ? classify(o.distance_m, o.direction ?? 'ahead', o.open ?? null, guideSettings())
        : null;
    if (danger && (danger.stop || danger.key.startsWith('close'))) {
      setFindInfo(data);
      interruptForStop(danger);
      situation.current = danger;
      if (danger.stop) buzz(Haptics.ImpactFeedbackStyle.Heavy);
      return;
    }
    if (data.found && data.bearing_deg !== null) {
      // Seen: remember which way the phone pointed, plus where in the frame it was.
      findMisses.current = 0;
      if (headingAtCapture !== null) targetHeadingRef.current = wrapDeg(headingAtCapture + data.bearing_deg);
      setFindInfo(data);
      if (data.centered && data.distance_m !== null && data.distance_m <= ARRIVE_DISTANCE_M) {
        arrive(target);
        return;
      }
      situation.current = { key: data.sentence, text: data.sentence, stop: false };
      // No gyro: pulse from the frame instead.
      if (headingRef.current === null) {
        const off = Math.abs(data.bearing_deg);
        buzz(
          off <= FIND_AHEAD_DEG
            ? Haptics.ImpactFeedbackStyle.Heavy
            : off <= FIND_NEAR_DEG
              ? Haptics.ImpactFeedbackStyle.Medium
              : Haptics.ImpactFeedbackStyle.Light,
        );
        if (data.centered) setTimeout(() => buzz(Haptics.ImpactFeedbackStyle.Heavy), 140);
      }
      return;
    }
    // Not in this frame. If we know where it was, guide by the gyro: clock position, and the
    // screen's arrow and meter follow the remembered direction.
    const off = targetOffset();
    if (off !== null) {
      if (Math.abs(off) <= CAMERA_HALF_FOV_DEG) {
        // It should be in view and isn't: a few misses in a row and we stop trusting the memory.
        findMisses.current += 1;
        if (findMisses.current >= FIND_MISS_LIMIT) {
          targetHeadingRef.current = null;
          setFindInfo(data);
          situation.current = { key: data.sentence, text: data.sentence, stop: false };
          return;
        }
      } else {
        findMisses.current = 0;
      }
      const text = clockPhrase(target, off);
      const clamped = Math.max(-CAMERA_HALF_FOV_DEG, Math.min(CAMERA_HALF_FOV_DEG, off));
      setFindInfo({
        ...data,
        found: true,
        direction: Math.abs(off) <= FIND_AHEAD_DEG ? 'ahead' : off > 0 ? 'right' : 'left',
        bearing_deg: clamped,
        centered: Math.abs(off) <= 5,
        sentence: text,
      });
      situation.current = { key: text, text, stop: false };
      return;
    }
    setFindInfo(data);
    situation.current = { key: data.sentence, text: data.sentence, stop: false };
  }

  // Frames for the guide and for find: capture, shrink, send. Up to two frames wait on the server
  // at once, and an answer is applied only if it's newer than the last one applied.
  async function frameLoop<T>(
    isOn: () => boolean,
    endpoint: string,
    fields: () => Record<string, string>,
    apply: (data: T, headingAtCapture: number | null) => void,
  ) {
    let seq = 0;
    let applied = 0;
    let inFlight = 0;
    let failures = 0;

    const fail = () => {
      failures += 1;
      // Say it once, on the third miss in a row, instead of every frame.
      if (failures === 3) {
        situation.current = null;
        setGuideDistance(null);
        setGuideSide(null);
        notify(Haptics.NotificationFeedbackType.Error);
        tell('Lost connection.');
      }
    };

    while (isOn()) {
      const started = Date.now();
      // No frames while a describe clip is playing (taking one can make it stutter), and no more
      // than GUIDE_IN_FLIGHT frames waiting on the server.
      if (!cameraBusy.current && !describePlaying() && inFlight < GUIDE_IN_FLIGHT) {
        cameraBusy.current = true;
        const headingAtCapture = headingRef.current;
        let uri: string | null = null;
        try {
          const photo = await cameraRef.current?.takePictureAsync({
            quality: 0.3,
            shutterSound: false,
            skipProcessing: GUIDE_SKIP_PROCESSING,
          });
          if (!photo) throw new Error('No photo');
          const sharp = findOnRef.current && findBlanks.current >= FIND_BLANKS_FOR_SHARP;
          uri = await shrink(photo.uri, sharp ? FIND_SHARP_WIDTH_PX : SONAR_WIDTH_PX);
        } catch (e) {
          console.warn(e);
          fail();
        } finally {
          cameraBusy.current = false;
        }
        if (uri) {
          const n = ++seq;
          const form = new FormData();
          form.append('image', new File(uri));
          form.append('mode', modeRef.current);
          for (const [k, v] of Object.entries(fields())) form.append(k, v);
          inFlight += 1;
          // Not awaited: the next capture starts while this one is on its way.
          fetch(`${API_URL}${endpoint}`, { method: 'POST', body: form, headers: HEADERS })
            .then(async (res) => {
              if (!res.ok) throw new Error(`Server ${res.status}`);
              const data = (await res.json()) as T;
              if (n <= applied || !isOn()) return;
              applied = n;
              failures = 0;
              apply(data, headingAtCapture);
            })
            .catch((e) => {
              console.warn(e);
              fail();
            })
            .finally(() => {
              inFlight -= 1;
            });
        }
      }
      await sleep(Math.max(50, GUIDE_PERIOD_MS - (Date.now() - started)));
    }
  }

  // Speaks when the situation changes, reminds while something is there (sooner when it's close),
  // and never talks over a describe sentence or over itself.
  async function voiceLoop() {
    let lastKey: string | null = null;
    let lastSpokenAt = 0;
    while (loopsOn()) {
      const s = situation.current;
      if (!s || describePlaying() || speechBusy.current) {
        await sleep(100);
        continue;
      }
      const changed = s.key !== lastKey;
      const remindAfter = findOnRef.current
        ? FIND_REMIND_MS
        : s.key.startsWith('far')
          ? GUIDE_REMIND_MS
          : GUIDE_REMIND_CLOSE_MS;
      const remind = s.key !== OPEN.key && Date.now() - lastSpokenAt > remindAfter;
      if (!changed && !remind) {
        await sleep(100);
        continue;
      }
      lastKey = s.key;
      lastSpokenAt = Date.now();
      setGuideText(s.text);
      await speakPhrase(s.text, s.stop);
    }
  }

  async function scan() {
    if (status === 'capturing' || status === 'thinking') return;
    try {
      setStatus('capturing');
      setArrived(null);
      quietUntil.current = Date.now() + 8000;
      sayStatus(SCANNING);
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      // If the guide is mid-photo, wait for it; the camera takes one picture at a time.
      while (cameraBusy.current) await sleep(50);
      cameraBusy.current = true;
      let photo;
      try {
        photo = await cameraRef.current?.takePictureAsync({ quality: 0.5, shutterSound: !loopsOn() });
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
      // Covers the moment before the clip starts; describePlaying() keeps the guide quiet until it ends.
      quietUntil.current = Date.now() + (data.audio_b64 ? 1500 : 3500);
      // Nothing is spoken if Settings opened while this scan was out.
      if (!settingsOpen.current) await say(data);
    } catch (e) {
      console.warn(e);
      setStatus('error');
      quietUntil.current = Date.now() + 2500;
      await notify(Haptics.NotificationFeedbackType.Error);
      tell('No connection. Try again.');
    }
  }

  const busy = status === 'thinking' || status === 'capturing';
  // The last /find answer is a second or so old. Between answers, move its bearing, direction and
  // box by how much the phone has turned since that frame was captured (the gyro), so the outline
  // stays on the object and the arrow points the right way while the user turns.
  let liveFind = findInfo;
  const targetHeading = targetHeadingRef.current;
  if (findOn && findInfo && findInfo.bearing_deg !== null && targetHeading !== null && headingNow !== null) {
    const off = wrapDeg(targetHeading - headingNow);
    const shift = (off - findInfo.bearing_deg) / (2 * CAMERA_HALF_FOV_DEG); // fraction of the frame width
    const inView = Math.abs(off) <= CAMERA_HALF_FOV_DEG;
    liveFind = {
      ...findInfo,
      bearing_deg: Math.max(-CAMERA_HALF_FOV_DEG, Math.min(CAMERA_HALF_FOV_DEG, off)),
      direction: Math.abs(off) <= FIND_AHEAD_DEG ? 'ahead' : off > 0 ? 'right' : 'left',
      centered: Math.abs(off) <= 5,
      box: inView && findInfo.box ? [findInfo.box[0] + shift, findInfo.box[1], findInfo.box[2], findInfo.box[3]] : null,
    };
  }

  const found = !guideOn && !findOn && resultVisible && result != null && !result.clear ? result : null;
  const distance = findOn ? (findInfo?.distance_m ?? null) : guideOn ? guideDistance : (found?.distance_m ?? null);
  const showNumber = !busy && status !== 'error' && distance != null;
  const direction = findOn ? (liveFind?.direction ?? null) : guideOn ? guideSide : (found?.direction ?? null);

  const headline = busy
    ? 'Checking…'
    : status === 'error'
      ? 'No connection'
      : showNumber && distance != null
        ? `${distance.toFixed(1)} m`
        : findOn
          ? capitalize(findTarget ?? 'Find')
          : arrived
            ? "You're there"
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
        : findOn
          ? findInfo?.sentence ?? 'Turn slowly'
          : arrived
            ? `Reach forward for the ${arrived}`
            : guideOn
            ? guideText || 'The voice tells you what changes'
            : resultVisible && result?.clear
            ? 'Nothing in your path'
            : 'Tap anywhere to describe';
  const label = findOn ? capitalize(findTarget ?? '') : found?.label ? capitalize(found.label) : null;

  // Where the obstacle (or find target) box lands on screen: the 3:4 photo is scaled to cover the screen.
  let box: { left: number; top: number; width: number; height: number } | null = null;
  const shownBox = findOn ? (liveFind?.box ?? null) : found?.box;
  if (shownBox && !busy) {
    const [x, y, w, h] = shownBox;
    const scale = Math.max(screenW / PHOTO_ASPECT, screenH); // displayed photo height
    const photoW = scale * PHOTO_ASPECT;
    const offX = (screenW - photoW) / 2;
    const offY = (screenH - scale) / 2;
    box = { left: offX + x * photoW, top: offY + y * scale, width: w * photoW, height: h * scale };
  }

  const topBar = (
    <View style={styles.topBar} pointerEvents="box-none">
      <Pressable
        style={({ pressed }) => [styles.chip, !cameraPicture && styles.chipLarge, pressed && styles.pressed]}
        onPress={() => {
          tapHaptic();
          changeMode(mode === 'indoor' ? 'outdoor' : 'indoor');
        }}
        accessibilityRole="button"
        accessibilityLabel={mode === 'indoor' ? 'Indoor' : 'Outdoor'}
        accessibilityHint="Double tap to switch between indoor and outdoor"
      >
        <Text style={styles.chipText}>{mode === 'indoor' ? 'Indoor' : 'Outdoor'}</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.chip, !cameraPicture && styles.chipLarge, pressed && styles.pressed]}
        onPress={openSettings}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        accessibilityHint="Opens settings"
      >
        <Text style={styles.chipText}>Settings</Text>
      </Pressable>
    </View>
  );

  const guideButton = (
    <View>
      {guideOn ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            !cameraPicture && styles.haloLarge,
            { opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) },
          ]}
        />
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.guide,
          guideOn ? styles.guideOn : styles.guideOff,
          !cameraPicture && styles.guideLarge,
          pressed && styles.pressed,
        ]}
        onPress={toggleGuide}
        accessibilityRole="switch"
        accessibilityState={{ checked: guideOn }}
        accessibilityLabel="Guide"
        accessibilityHint="A voice tells you about obstacles while you walk. Walk slowly while it's on."
      >
        <Text style={[styles.guideText, guideOn ? styles.guideTextOn : styles.guideTextOff]}>
          {guideOn ? 'Guide on' : 'Guide off'}
        </Text>
      </Pressable>
    </View>
  );

  const findButton = (
    <Pressable
      style={({ pressed }) => [styles.guide, styles.guideOff, styles.find, !cameraPicture && styles.guideLarge, pressed && styles.pressed]}
      onPress={openFindPicker}
      accessibilityRole="button"
      accessibilityLabel="Find"
      accessibilityHint="Pick something to find, like a chair. A voice tells you which way to turn."
    >
      <Text style={[styles.guideText, styles.guideTextOff]}>Find</Text>
    </Pressable>
  );

  // Guide and Find side by side, the two things you start while walking.
  const modeButtons = (
    <View style={styles.modeRow}>
      <View style={styles.modeCell}>{guideButton}</View>
      {findButton}
    </View>
  );

  return (
    <View
      style={styles.screen}
      accessibilityActions={[{ name: 'magicTap', label: 'Repeat the last warning' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'magicTap') repeatLast();
      }}
    >
      <StatusBar style={cameraPicture || showSettings || showTargets || findOn ? 'light' : 'dark'} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" animateShutter={false} />
      {/* Camera picture off: cover the preview. The camera still runs underneath. */}
      {!cameraPicture ? <View style={styles.cover} pointerEvents="none" /> : null}

      {/* The whole screen is one big tap target. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={scan}
        // Press and hold anywhere repeats the last warning. Works with or without VoiceOver
        // (with it on, that's double-tap and hold). Magic tap still does the same.
        onLongPress={() => {
          tapHaptic();
          repeatLast();
        }}
        delayLongPress={600}
        accessibilityRole="button"
        accessibilityLabel="Describe what's ahead"
        accessibilityHint="Double tap to scan. Double tap and hold to repeat the last warning."
        accessibilityState={{ busy: status === 'capturing' || status === 'thinking' }}
      />

      {findOn && findTarget ? (
        <FindScreen target={findTarget} description={findDescriptionRef.current} result={liveFind} cameraPicture={cameraPicture} onStop={() => stopFind(false)} />
      ) : cameraPicture ? (
        <>
          {/* Overlay drawing only; everything here is also spoken, so VoiceOver skips it. */}
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <LinearGradient colors={['rgba(0,0,0,0.7)', 'transparent']} style={styles.topShade} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.88)']} style={styles.bottomShade} />
            {box ? (
              <>
                <View style={[styles.glow, box]} />
                <View style={[styles.box, box]} />
                <View style={[styles.tag, { left: box.left, top: Math.max(SAFE.top + 72, box.top - 48) }]}>
                  <Text style={styles.tagText}>
                    {label ?? 'Obstacle'}
                    {distance != null ? ` · ${distance.toFixed(1)} m` : ''}
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
            {modeButtons}
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
            {modeButtons}
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
          onClose={closeSettings}
        />
      ) : null}

      {showTargets ? (
        <FindPicker
          onPick={startFind}
          onSpeak={speakToFind}
          speakState={speakState}
          onClose={() => setShowTargets(false)}
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
  topShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 180 },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 320 },
  topBar: {
    position: 'absolute',
    top: SAFE.top + SPACE.sm,
    left: GUTTER,
    right: GUTTER,
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
  box: { position: 'absolute', borderWidth: 5, borderColor: C.bright, borderRadius: 18, backgroundColor: 'rgba(61,139,255,0.08)' },
  // Soft glow around the outline, like the Figma (iOS draws it from the shadow).
  glow: {
    position: 'absolute',
    borderWidth: 10,
    borderColor: 'rgba(61,139,255,0.45)',
    borderRadius: 22,
    margin: -5,
    shadowColor: C.bright,
    shadowOpacity: 1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  tag: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagText: { color: C.blue, fontSize: 20, ...font('bold') },
  bottom: { position: 'absolute', left: GUTTER, right: GUTTER, bottom: SAFE.bottom + SPACE.sm, gap: SPACE.md },
  // Blue edge on the left ties the card to the Guide button and the outline.
  card: {
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 22,
    borderLeftWidth: 6,
    borderLeftColor: C.blue,
    paddingHorizontal: GUTTER,
    paddingVertical: SPACE.lg,
  },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  halo: {
    position: 'absolute',
    top: -8,
    bottom: -8,
    left: -8,
    right: -8,
    borderRadius: 46,
    backgroundColor: C.bright,
  },
  haloLarge: { borderRadius: 56 },
  headline: { color: C.blue, fontSize: 34, ...font('bold') },
  headlineNumber: { fontSize: 56, ...font('heavy') },
  detail: { color: C.ink2, fontSize: 18, marginTop: SPACE.xs, ...font('semibold') },
  guide: { minHeight: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  guideLarge: { minHeight: 96, borderRadius: 48 },
  find: { flex: 1 },
  modeRow: { flexDirection: 'row', gap: SPACE.md },
  modeCell: { flex: 1 },
  guideOn: { backgroundColor: C.blue },
  guideOff: { backgroundColor: 'rgba(255,255,255,0.94)', borderWidth: 2, borderColor: C.blue },
  guideText: { fontSize: 26, ...font('bold') },
  guideTextOn: { color: '#fff' },
  guideTextOff: { color: C.blue },
  // Below the top chips (48 tall), above the home indicator.
  large: {
    ...StyleSheet.absoluteFill,
    paddingTop: SAFE.top + SPACE.sm + 48 + SPACE.xl,
    paddingHorizontal: GUTTER,
    paddingBottom: SAFE.bottom + SPACE.sm,
  },
  largeMiddle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  largeLabel: { color: C.ink, fontSize: 34, ...font('bold') },
  largeHeadline: { color: C.blue, fontSize: 56, textAlign: 'center', ...font('heavy') },
  largeNumber: { fontSize: 120 },
  largeDetail: { color: C.ink, fontSize: 30, textAlign: 'center', ...font('bold') },
  arrow: { color: C.ink, fontSize: 96, marginTop: 8, ...font('heavy') },
});
