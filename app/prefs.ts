// Choices from Settings that the app remembers on the phone.
export type Prefs = {
  speech: boolean; // ElevenLabs voice for warnings and the guide (off: the phone's own voice)
  haptics: boolean; // vibration for warnings and the guide
  speed: number; // index into SPEEDS, for everything the app says (directions, Walker, voice samples)
  warning: Warning; // the "Warn me" setting, sent with every request
  units: Units; // spoken sentences and on-screen distances
};

export type Warning = 'close' | 'normal' | 'early';
export type Units = 'meters' | 'feet';

export const DEFAULT_PREFS: Prefs = { speech: true, haptics: true, speed: 2, warning: 'normal', units: 'meters' };

// distance_m from the server is always meters; this is what the screen shows.
export function formatDistance(meters: number, units: Units) {
  return units === 'feet' ? `${Math.round(meters * 3.28084)} ft` : `${meters.toFixed(1)} m`;
}

export const SPEEDS = [
  { rate: 0.8, name: 'Slowest' },
  { rate: 0.9, name: 'Slower' },
  { rate: 1, name: 'Normal' },
  { rate: 1.15, name: 'Faster' },
  { rate: 1.3, name: 'Fastest' },
];
