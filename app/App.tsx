import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';

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
  audio_b64: string | null;
};

type Status = 'idle' | 'capturing' | 'thinking' | 'error';

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [mode, setMode] = useState<Mode>('indoor');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DescribeResult | null>(null);

  useEffect(() => {
    // Play warnings even when the phone's silent switch is on.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
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

  async function scan() {
    if (status === 'capturing' || status === 'thinking') return;
    try {
      setStatus('capturing');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.5 });
      if (!photo) throw new Error('No photo');

      setStatus('thinking');
      const form = new FormData();
      // React Native's fetch uploads a file from { uri, name, type }.
      form.append('image', { uri: photo.uri, name: 'frame.jpg', type: 'image/jpeg' } as any);
      form.append('mode', mode);

      const res = await fetch(`${API_URL}/describe`, {
        method: 'POST',
        body: form,
        // Without this, ngrok's free plan can answer with an HTML warning page instead of our JSON.
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
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
      // TODO (Juan): play data.audio_b64 (ElevenLabs mp3) when it's not null.
      Speech.speak(data.sentence);
    } catch (e) {
      console.warn(e);
      setStatus('error');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Speech.speak('No connection. Try again.');
    }
  }

  const headline =
    status === 'thinking' || status === 'capturing'
      ? 'Checking…'
      : status === 'error'
        ? 'Could not reach the server'
        : result?.distance_m != null
          ? `${result.distance_m.toFixed(1)} m`
          : 'Tap anywhere';

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* The whole screen is one big tap target. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={scan}
        accessibilityRole="button"
        accessibilityLabel="Scan what's ahead"
        accessibilityHint="Takes a photo and announces the closest obstacle"
      />

      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable
          style={styles.modeToggle}
          onPress={() => setMode(mode === 'indoor' ? 'outdoor' : 'indoor')}
          accessibilityRole="switch"
          accessibilityLabel={`${mode} mode`}
          accessibilityHint="Double tap to switch between indoor and outdoor"
        >
          <Text style={styles.modeText}>{mode === 'indoor' ? 'INDOOR' : 'OUTDOOR'}</Text>
        </Pressable>
      </View>

      <View style={styles.bottomPanel} pointerEvents="none">
        <Text style={styles.distance} accessibilityLiveRegion="polite">
          {headline}
        </Text>
        {result?.sentence ? <Text style={styles.sentence}>{result.sentence}</Text> : null}
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
  topBar: { position: 'absolute', top: 60, left: 0, right: 0, alignItems: 'center' },
  modeToggle: {
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderColor: ACCENT,
    borderWidth: 2,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
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
