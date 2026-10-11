// Walker's fixed commands: what was heard (from POST /transcribe) -> one action and what Walker says.
// Plain phrase matching, no AI deciding what to tap. Find uses /transcribe's own target and
// description, so here it only needs to recognize that it's a find.
import type { Units, Warning } from './prefs';

type Voice = { id: string; name: string };

// Everything Walker can say. He says these in his own ElevenLabs voice, so each one is on the
// server's /say list (WALKER_PHRASES in backend/main.py); keep the two in sync.
export const WALKER_HELP =
  'You can say: find the door. Start walking, or stop. What is in front of me. Repeat that. ' +
  'Units feet, or meters. Warn me early, normal, or close. Use, and a voice name. Or settings.';
export const LINES = {
  findIt: "Sure thing. Let's find it.",
  whatToFind: 'What should I look for?',
  guideOn: "Alright, guide's on. I'll let you know what's in your way.",
  guideOff: "Okay, guide's off.",
  describe: 'Let me take a look.',
  repeat: 'Here it is again.',
  settings: 'Opening settings.',
  stop: 'Okay, stopping everything.',
  feet: 'Got it. Feet it is.',
  meters: 'Got it. Meters it is.',
  early: "Got it. I'll give you a heads up early.",
  normal: 'Got it. Normal warnings.',
  close: "Got it. I'll only warn you when things are close.",
  voice: "Got it. Here's the new voice.",
  help: WALKER_HELP,
  unknown: 'Sorry, say help for options.',
  yes: 'Yeah? What do you need?',
  didntCatch: "Sorry, I didn't catch that.",
  cantHear: "Sorry, I couldn't hear you. Try again.",
  mic: 'I need the microphone to hear you.',
};
// For the 13 known targets; anything else is LINES.findIt.
export const findLine = (target: string) => `Sure thing. Let's find the ${target}.`;

export type WalkerCommand =
  | { action: 'find' }
  | { action: 'wake'; reply: string } // just his name: he answers and listens for the command
  | { action: 'guide_on' | 'guide_off' | 'describe' | 'repeat' | 'settings' | 'stop' | 'none'; reply: string }
  | { action: 'units'; units: Units; reply: string }
  | { action: 'warning'; warning: Warning; reply: string }
  | { action: 'voice'; voice: Voice; reply: string };

// Speech to text sometimes writes his name like these.
const NAMES = ['walker', 'walkers', 'wocker', 'walter'];

// Checked in the order of parseCommand; the first match wins. Find comes first so "help me find the
// door" isn't read as asking for help.
const FIND = ['find', 'where is', "where's", 'where are', 'locate', 'search for', 'look for', 'looking for', 'take me to'];
const HELP = ['help', 'what can i say', 'what can you do', 'options'];
const GUIDE = ['start walking', 'walk with me', 'stop walking', 'guide', 'guiding', 'guidance', 'navigate', 'navigation'];
const OFF = ['off', 'stop', 'end', 'disable', 'quit', 'cancel', 'no more'];
const DESCRIBE = [
  "what's in front", 'what is in front', "what's ahead", 'what is ahead', 'what do you see', 'what can you see',
  'describe', "what's this", 'what is this', "what's that", 'what is that', 'scan', 'look around',
];
const REPEAT = ['repeat', 'say that again', 'say it again', 'what did you say'];
const STOP = ['stop', 'cancel', 'never mind', 'nevermind', 'quit', "that's enough", 'enough'];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const has = (text: string, phrases: string[]) => phrases.some((p) => new RegExp(`\\b${p}\\b`).test(text));

export function parseCommand(heard: string, voices: Voice[]): WalkerCommand {
  let w = words(heard);
  // Drop everything up to the last time his name was said ("hey Walker, ..."), and VoiceOver's "listening".
  let named = -1;
  w.forEach((x, i) => {
    if (NAMES.includes(x)) named = i;
  });
  if (named >= 0) w = w.slice(named + 1);
  while (w.length && ['listening', 'hey', 'hi', 'ok', 'okay', 'so', 'um', 'uh', 'please', 'yo'].includes(w[0])) w = w.slice(1);
  const text = w.join(' ');
  if (!text) return named >= 0 ? { action: 'wake', reply: LINES.yes } : { action: 'none', reply: LINES.didntCatch };

  if (has(text, FIND)) return { action: 'find' };
  if (has(text, HELP)) return { action: 'none', reply: LINES.help };

  if (has(text, ['units', 'feet', 'foot', 'meters', 'metres', 'meter', 'metric'])) {
    if (has(text, ['feet', 'foot'])) return { action: 'units', units: 'feet', reply: LINES.feet };
    if (has(text, ['meters', 'metres', 'meter', 'metric'])) return { action: 'units', units: 'meters', reply: LINES.meters };
  }
  if (has(text, ['warn me', 'warning', 'warnings', 'warn'])) {
    if (has(text, ['early', 'earlier', 'sooner'])) return { action: 'warning', warning: 'early', reply: LINES.early };
    if (has(text, ['normal', 'default', 'regular', 'usual'])) return { action: 'warning', warning: 'normal', reply: LINES.normal };
    if (has(text, ['close', 'closer', 'later', 'late'])) return { action: 'warning', warning: 'close', reply: LINES.close };
  }
  // "use Sarah", "switch to Mom", "change the voice to George". Longest names first, so "Trusted
  // voice 2" wins over "Trusted voice".
  if (has(text, ['use', 'switch to', 'change', 'voice'])) {
    const byLength = [...voices].sort((a, b) => b.name.length - a.name.length);
    const v = byLength.find((x) => has(text, [words(x.name).join(' ')]));
    if (v) return { action: 'voice', voice: v, reply: LINES.voice };
  }

  if (has(text, GUIDE)) {
    if (has(text, OFF)) return { action: 'guide_off', reply: LINES.guideOff };
    return { action: 'guide_on', reply: LINES.guideOn };
  }
  if (has(text, DESCRIBE)) return { action: 'describe', reply: LINES.describe };
  if (has(text, REPEAT)) return { action: 'repeat', reply: LINES.repeat };
  if (has(text, ['settings'])) return { action: 'settings', reply: LINES.settings };
  if (has(text, STOP)) return { action: 'stop', reply: LINES.stop };
  return { action: 'none', reply: LINES.unknown };
}
