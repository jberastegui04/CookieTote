import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
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
// Free ngrok links answer with an HTML warning page unless this header is sent.
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Same warning distances as backend/pipeline.py.
const WARN_DISTANCE_M: Record<Mode, number> = { indoor: 2, outdoor: 4 };
const SONAR_PERIOD_MS = 1000;
// A reading older than this is too stale to keep beeping about.
const SONAR_STALE_MS = 3000;
// Under this, with sonar on and the obstacle straight ahead, say so out loud (at most every few seconds).
const STOP_DISTANCE_M = 0.7;
const STOP_REPEAT_MS = 4000;
// After the "ahead" double beep, a softer single beep in the ear with more room. Try it in the
// blindfold test; set to false if it confuses people.
const GUIDE_CUE = true;

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

// Beeps speed up as the obstacle gets closer: slow at the warning distance, rapid at half a meter.
function beepGapMs(distance: number, mode: Mode) {
  const t = Math.min(1, Math.max(0, (distance - 0.5) / (WARN_DISTANCE_M[mode] - 0.5)));
  return 150 + t * 850;
}

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

  // Sonar. The loops below run for a long time, so they read refs instead of state.
  const [sonarOn, setSonarOn] = useState(false);
  const [sonarDistance, setSonarDistance] = useState<number | null>(null);
  const sonarOnRef = useRef(false);
  const modeRef = useRef<Mode>('indoor');
  const cameraBusy = useRef(false); // one photo at a time, shared by describe and sonar
  const quietUntil = useRef(0); // no beeps while a describe sentence is being spoken
  const reading = useRef<{ distance: number; direction: Side; open: 'left' | 'right' | null; at: number } | null>(null);
  const recentDirections = useRef<Side[]>([]); // last few readings, so one noisy frame can't flip the ear
  const lastStopAt = useRef(0);
  // Three short tones, panned left, center, and right (made by backend/tone.py).
  const toneLeft = useAudioPlayer(require('./assets/tones/left.wav'));
  const toneAhead = useAudioPlayer(require('./assets/tones/center.wav'));
  const toneRight = useAudioPlayer(require('./assets/tones/right.wav'));

  useEffect(() => {
    // Play warnings even when the phone's silent switch is on.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    AccessibilityInfo.isScreenReaderEnabled().then((on) => (screenReader.current = on));
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader.current = on));
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
    // Stop the sonar loops if the screen goes away.
    return () => {
      sonarOnRef.current = false;
      sub.remove();
    };
  }, []);

  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.title}>Camera access needed</Text>
        <Pressable
          style={styles.button}
          onPress={requestPermission}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
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

  async function playUri(uri: string, headers?: Record<string, string>) {
    player.replace({ uri, headers });
    // Starting before the clip has loaded cuts off the first word.
    for (let i = 0; i < 80 && !player.isLoaded; i++) await sleep(25);
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
    Speech.speak(data.sentence);
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
      if (sonarOnRef.current) toggleSonar();
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
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility('Voice added. Playing a sample.');
      Speech.speak('Voice added.');
      await sleep(1200);
      await playUri(`${API_URL}/voices/${added.id}/sample.wav`, HEADERS);
    } catch (e) {
      console.warn(e);
      setClone('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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

  // Steps to the next voice, plays its sample sentence, and remembers the choice.
  async function nextVoice() {
    if (voices.length === 0) return;
    const i = voices.findIndex((v) => v.id === voiceIdRef.current);
    const next = voices[(i + 1) % voices.length];
    chooseVoice(next);
    AccessibilityInfo.announceForAccessibility(`Voice: ${next.name}`);
    Haptics.selectionAsync();
    quietUntil.current = Date.now() + 1500; // keep sonar quiet while the sample plays
    try {
      await playUri(`${API_URL}/voices/${next.id}/sample.wav`, HEADERS);
    } catch (e) {
      console.warn(e);
    }
  }

  function toggleSonar() {
    const on = !sonarOnRef.current;
    sonarOnRef.current = on;
    setSonarOn(on);
    reading.current = null;
    recentDirections.current = [];
    setSonarDistance(null);
    AccessibilityInfo.announceForAccessibility(on ? 'Sonar on' : 'Sonar off');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (on) {
      sonarLoop();
      beepLoop();
    }
  }

  // True from a tap until the spoken sentence has finished, plus a short pause after it.
  function speaking() {
    if (player.playing) quietUntil.current = Math.max(quietUntil.current, Date.now() + 600);
    return Date.now() < quietUntil.current;
  }

  // About once a second: small photo to /sonar, remember the newest reading.
  async function sonarLoop() {
    let failures = 0;
    while (sonarOnRef.current) {
      const started = Date.now();
      // No sonar photos while the voice is talking: taking one can make the speech stutter.
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
            reading.current = null;
            recentDirections.current = [];
          } else {
            // Direction is the majority of the last three readings; distance is always the newest.
            recentDirections.current = [...recentDirections.current, data.direction ?? 'ahead'].slice(-3);
            reading.current = {
              distance: data.distance_m,
              direction: majority(recentDirections.current),
              open: data.open ?? null,
              at: Date.now(),
            };
          }
          if (sonarOnRef.current) setSonarDistance(reading.current?.distance ?? null);
        } catch (e) {
          console.warn(e);
          failures += 1;
          // Say it once, on the third miss in a row, instead of every second.
          if (failures === 3) {
            reading.current = null;
            setSonarDistance(null);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            AccessibilityInfo.announceForAccessibility('Sonar lost connection');
            Speech.speak('Sonar lost connection');
          }
        } finally {
          cameraBusy.current = false;
        }
      }
      await sleep(Math.max(0, SONAR_PERIOD_MS - (Date.now() - started)));
    }
  }

  // Beep and buzz toward the newest reading, faster when closer. Silent when the path is clear.
  async function beepLoop() {
    while (sonarOnRef.current) {
      const r = reading.current;
      if (!r || Date.now() - r.at > SONAR_STALE_MS || speaking()) {
        await sleep(150);
        continue;
      }
      if (r.direction === 'ahead') {
        // Straight ahead: double beep in both ears, heavy buzz, and a spoken stop when very close.
        toneAhead.seekTo(0).then(() => toneAhead.play()).catch(() => {});
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        if (r.distance <= STOP_DISTANCE_M && Date.now() - lastStopAt.current > STOP_REPEAT_MS) {
          lastStopAt.current = Date.now();
          tell(`Stop. Obstacle ahead, very close.${r.open ? ` More room on the ${r.open}.` : ''}`);
          await sleep(1800);
          continue;
        }
        if (GUIDE_CUE && r.open) {
          await sleep(320);
          const guide = r.open === 'left' ? toneLeft : toneRight;
          guide.volume = 0.35;
          guide.seekTo(0).then(() => guide.play()).catch(() => {});
        }
      } else {
        const tone = r.direction === 'left' ? toneLeft : toneRight;
        tone.volume = 1;
        tone.seekTo(0).then(() => tone.play()).catch(() => {});
        Haptics.impactAsync(r.distance < 1 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium);
      }
      await sleep(beepGapMs(r.distance, modeRef.current));
    }
  }

  async function scan() {
    if (status === 'capturing' || status === 'thinking') return;
    try {
      setStatus('capturing');
      quietUntil.current = Date.now() + 8000;
      tell('Scanning');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // If sonar is mid-photo, wait for it; the camera takes one picture at a time.
      while (cameraBusy.current) await sleep(50);
      cameraBusy.current = true;
      let photo;
      try {
        photo = await cameraRef.current?.takePictureAsync({ quality: 0.5, shutterSound: !sonarOnRef.current });
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
        await Haptics.impactAsync(style);
      }
      // Covers the moment before the clip starts; speaking() keeps sonar quiet until it ends.
      quietUntil.current = Date.now() + (data.audio_b64 ? 1500 : 3500);
      await say(data);
    } catch (e) {
      console.warn(e);
      setStatus('error');
      quietUntil.current = Date.now() + 2500;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      tell('No connection. Try again.');
    }
  }

  const headline =
    status === 'thinking' || status === 'capturing'
      ? 'Checking…'
      : status === 'error'
        ? 'Could not reach the server'
        : sonarOn
          ? sonarDistance != null
            ? `${sonarDistance.toFixed(1)} m`
            : 'Clear'
          : result?.distance_m != null
            ? `${result.distance_m.toFixed(1)} m`
            : 'Tap anywhere';

  return (
    <View
      style={styles.screen}
      accessibilityActions={[{ name: 'magicTap', label: 'Repeat the last warning' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'magicTap') repeatLast();
      }}
    >
      <StatusBar style="light" />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" animateShutter={false} />

      {/* The whole screen is one big tap target. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={scan}
        accessibilityRole="button"
        accessibilityLabel="Describe what's ahead"
        accessibilityHint="Double tap to scan"
        accessibilityState={{ busy: status === 'capturing' || status === 'thinking' }}
      />

      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable
          style={[styles.modeToggle, sonarOn && styles.toggleOn]}
          onPress={toggleSonar}
          accessibilityRole="switch"
          accessibilityState={{ checked: sonarOn }}
          accessibilityLabel="Sonar"
          accessibilityHint="Beeps faster as you get closer to an obstacle"
        >
          <Text style={[styles.modeText, sonarOn && styles.toggleOnText]}>
            {sonarOn ? 'SONAR ON' : 'SONAR OFF'}
          </Text>
        </Pressable>
        <Pressable
          style={styles.modeToggle}
          onPress={() => {
            const next = mode === 'indoor' ? 'outdoor' : 'indoor';
            modeRef.current = next;
            setMode(next);
          }}
          accessibilityRole="switch"
          accessibilityLabel={`${mode} mode`}
          accessibilityHint="Double tap to switch between indoor and outdoor"
        >
          <Text style={styles.modeText}>{mode === 'indoor' ? 'INDOOR' : 'OUTDOOR'}</Text>
        </Pressable>
        {voices.length > 0 ? (
          <Pressable
            style={styles.modeToggle}
            onPress={nextVoice}
            accessibilityRole="button"
            accessibilityLabel={`Voice, ${voices.find((v) => v.id === voiceId)?.name ?? 'default'}`}
            accessibilityHint="Double tap to hear the next voice"
          >
            <Text style={styles.modeText}>
              VOICE: {(voices.find((v) => v.id === voiceId)?.name ?? '').toUpperCase()}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.modeToggle, cloneStep === 'recording' && styles.recording]}
          onPress={cloneTap}
          accessibilityRole="button"
          accessibilityLabel={
            cloneStep === 'recording'
              ? 'Stop recording'
              : cloneStep === 'uploading'
                ? 'Adding the voice'
                : cloneStep === 'confirm'
                  ? 'Start recording a trusted voice'
                  : 'Record a trusted voice'
          }
          accessibilityHint={
            cloneStep === 'idle' ? 'Hears a consent notice first, then records for thirty seconds' : undefined
          }
          accessibilityState={{ busy: cloneStep === 'uploading' }}
        >
          <Text style={styles.modeText}>
            {cloneStep === 'recording'
              ? 'STOP'
              : cloneStep === 'uploading'
                ? 'ADDING…'
                : cloneStep === 'confirm'
                  ? 'TAP TO RECORD'
                  : 'CLONE VOICE'}
          </Text>
        </Pressable>
      </View>

      {/* Visual only (for sighted viewers and the projector). Everything here is also spoken. */}
      <View style={styles.bottomPanel} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={styles.distance}>{headline}</Text>
        {!sonarOn && result?.sentence ? <Text style={styles.sentence}>{result.sentence}</Text> : null}
      </View>
    </View>
  );
}

const ACCENT = '#FFD60A';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 24 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', textAlign: 'center' },
  button: { backgroundColor: ACCENT, paddingVertical: 18, paddingHorizontal: 32, borderRadius: 16 },
  buttonText: { color: '#000', fontSize: 22, fontWeight: '700' },
  topBar: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  modeToggle: {
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderColor: ACCENT,
    borderWidth: 2,
    borderRadius: 999,
    minHeight: 64,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  toggleOn: { backgroundColor: ACCENT },
  recording: { borderColor: '#FF453A', backgroundColor: 'rgba(255,69,58,0.35)' },
  toggleOnText: { color: '#000' },
  modeText: { color: ACCENT, fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  bottomPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 24,
    paddingBottom: 48,
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  distance: { color: ACCENT, fontSize: 64, fontWeight: '800' },
  sentence: { color: '#fff', fontSize: 24, fontWeight: '600', marginTop: 8 },
});
