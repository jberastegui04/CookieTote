import * as Haptics from 'expo-haptics';

// A light tap for every button press, unless Haptics is off in Settings. App.tsx keeps this in sync.
let enabled = true;

export function setTapHaptics(on: boolean) {
  enabled = on;
}

export function tapHaptic() {
  if (enabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// A softer tick, for each notch of the speed slider.
export function notchHaptic() {
  if (enabled) Haptics.selectionAsync().catch(() => {});
}
