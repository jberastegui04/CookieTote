// Choices from Settings that the app remembers on the phone.
export type Prefs = {
  speech: boolean; // speak the guidance sentence after a scan
  beeps: boolean; // sonar tones (haptics can stay on without them)
  haptics: boolean; // vibration for warnings and sonar
  speed: number; // index into SPEEDS, for spoken warnings
};

export const DEFAULT_PREFS: Prefs = { speech: true, beeps: true, haptics: true, speed: 2 };

export const SPEEDS = [
  { rate: 0.8, name: 'Slowest' },
  { rate: 0.9, name: 'Slower' },
  { rate: 1, name: 'Normal' },
  { rate: 1.15, name: 'Faster' },
  { rate: 1.3, name: 'Fastest' },
];
