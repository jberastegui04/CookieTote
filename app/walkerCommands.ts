// Walker's fixed commands: what was heard (from POST /transcribe) -> one action and what Walker says.
// Plain phrase matching, no AI deciding what to tap. Find uses /transcribe's own target and
// description, so here it only needs to recognize that it's a find.
import { SPEEDS, type Units, type Warning } from './prefs';

type Voice = { id: string; name: string; custom?: boolean };

// Everything Walker can say. He says these in the chosen voice (his own unless changed in Settings),
// so each one is on the server's /say list (WALKER_PHRASES in backend/main.py); keep the two in sync.
export const WALKER_HELP =
  'You can say: find the door. Stop. What is in front of me. Repeat that. Settings. ' +
  'Units feet, or meters. Warn me close, normal, or far. Or use, and a voice name.';
export const LINES = {
  findIt: "Sure thing. Let's find it.",
  whatToFind: 'What should I look for?',
  describe: 'Let me take a look.',
  repeat: 'Here it is again.',
  settings: 'Opening settings.',
  stop: 'Okay, stopping everything.',
  feet: 'Got it. Feet it is.',
  meters: 'Got it. Meters it is.',
  early: "Got it. I'll warn you from farther away.",
  normal: 'Got it. Normal warnings.',
  close: "Got it. I'll only warn you when things are close.",
  voice: "Got it. Here's the new voice.",
  help: WALKER_HELP,
  unknown: 'Sorry, say help for options.',
  yes: 'Yeah? What do you need?',
  didntCatch: "Sorry, I didn't catch that.",
  cantHear: "Sorry, I couldn't hear you. Try again.",
  mic: 'I need the microphone to hear you.',
  // Setup: on the welcome poster (welcomeVO goes through VoiceOver, so it needn't be on the /say
  // list), then on the camera screen once setup is done.
  welcome: 'Welcome to Cyclops. Tap anywhere to begin.',
  welcomeVO: 'Welcome to Cyclops. Double tap anywhere to begin.',
  introHowTo:
    "Tap the screen to hear what's in front of you. Press and hold anywhere to talk to me, like: find the door. You can change my voice in Settings. Ask me for help any time.",
};

// Settings, hands free (say "settings"): Walker lists the sections, reads the one you pick with its
// current values ("Haptics: on."), and changes them as you say. "Done" goes back one level. All on
// the /say list; the server builds the same "Label: value." lines, and allows "Voice: <name>." for
// any name on the voice list (names change as voices are added).
export const MENU = {
  sections: 'Settings. Say a section: distance, sound and touch, or help. Or say done to go back.',
  closing: 'Closing settings.',
  distanceAsk: 'Say close, normal, or far. Or feet, or meters. Or say done to go back.',
  soundAsk: 'Say haptics on or off, guidance voice on or off, faster or slower, or voice to pick a different one. Or say done to go back.',
  // The voice menu (say "voice"): every voice plays, then pick one by name, or record a new one.
  defaultVoices: 'Default voices.',
  customVoices: 'Custom voices.',
  noCustom: 'No custom voices yet.',
  voiceAsk:
    'Say the name you like. Say record to make a new one, or rename to rename a custom voice. Or say done to go back.',
  renameWhich: 'Which custom voice?',
  renameAsk: 'Say the new name.',
  onlyCustom: 'Only custom voices can be renamed.',
  recordConsent:
    "I'll record someone you trust for fifteen seconds and make a voice from it. Only record someone who has agreed. Say yes to start.",
  recordStart: 'Recording now, for fifteen seconds. Have them speak naturally.',
  recordSkipped: "Okay, I won't record.",
  nameAsk: 'Say a name for this voice.',
  helpRead:
    'It warns about things standing still in your path. It does not replace a cane, and it does not detect curbs, drop-offs, moving cars, or street crossings.',
  helpAsk: 'Say replay setup. Or say done to go back.',
};
// "Warn me" is close, normal or far out loud and on screen ('early' underneath, as the server calls it).
export const WARN_WORD: Record<Warning, string> = { close: 'close', normal: 'normal', early: 'far' };
export const unitsLine = (units: Units) => `Units: ${units}.`;
export const warnLine = (warning: Warning) => `Warn me: ${WARN_WORD[warning]}.`;
export const onOffLine = (label: 'Guidance voice' | 'Haptics', on: boolean) => `${label}: ${on ? 'on' : 'off'}.`;
export const speedLine = (index: number) => `Speech speed: ${SPEEDS[index].name.toLowerCase()}.`;
export const voiceLine = (name: string) => `Voice: ${name}.`;

export type Section = 'distance' | 'sound' | 'help';
export type SettingChange =
  | { kind: 'units'; units: Units }
  | { kind: 'warning'; warning: Warning }
  | { kind: 'haptics'; on: boolean }
  | { kind: 'speech'; on: boolean }
  | { kind: 'speed'; delta: 1 | -1 }
  | { kind: 'voice'; voice: Voice }
  | { kind: 'voices' } // "voice": open the voice menu
  | { kind: 'record' } // record a new trusted voice
  | { kind: 'list' } // play the voices again
  | { kind: 'rename'; voice: Voice | null } // rename a custom voice (named in the same breath, or asked for)
  | { kind: 'replay' }
  | { kind: 'back' }
  | { kind: 'done' };
// For the 13 known targets; anything else is LINES.findIt.
export const findLine = (target: string) => `Sure thing. Let's find the ${target}.`;

export type WalkerCommand =
  | { action: 'find' }
  | { action: 'wake'; reply: string } // just his name: he answers and listens for the command
  | { action: 'describe' | 'repeat' | 'settings' | 'stop' | 'none'; reply: string }
  | { action: 'units'; units: Units; reply: string }
  | { action: 'warning'; warning: Warning; reply: string }
  | { action: 'voice'; voice: Voice; reply: string };

// Speech to text sometimes writes his name like these.
const NAMES = ['walker', 'walkers', 'wocker', 'walter'];

// Checked in the order of parseCommand; the first match wins. Find comes first so "help me find the
// door" isn't read as asking for help.
const FIND = ['find', 'where is', "where's", 'where are', 'locate', 'search for', 'look for', 'looking for', 'take me to'];
const HELP = ['help', 'what can i say', 'what can you do', 'options'];
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
    if (has(text, ['far', 'farther', 'further', 'early', 'earlier', 'sooner'])) return { action: 'warning', warning: 'early', reply: LINES.early };
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

  if (has(text, DESCRIBE)) return { action: 'describe', reply: LINES.describe };
  if (has(text, REPEAT)) return { action: 'repeat', reply: LINES.repeat };
  if (has(text, ['settings'])) return { action: 'settings', reply: LINES.settings };
  if (has(text, STOP)) return { action: 'stop', reply: LINES.stop };
  return { action: 'none', reply: LINES.unknown };
}

const OFF_WORDS = ['off', 'disable', 'no', 'stop'];
const ON_WORDS = ['on', 'enable', 'yes', 'start'];

// Which section was named, or 'done' / 'back', or null.
export function sectionFromSpeech(heard: string): Section | 'done' | 'back' | null {
  const text = words(heard).join(' ');
  if (has(text, ['done', 'close', 'exit', 'finish', 'finished', "that's all", "that's it", 'nothing'])) return 'done';
  if (has(text, ['back', 'go back'])) return 'back';
  if (has(text, ['distance', 'distances', 'units', 'warning', 'warnings', 'warn'])) return 'distance';
  if (has(text, ['sound', 'touch', 'voice', 'voices', 'haptics', 'vibration', 'speed'])) return 'sound';
  if (has(text, ['help', 'limits', "can't see", 'cannot see'])) return 'help';
  return null;
}

// A change said inside a section ("feet", "haptics off", "faster", "use George"), or null.
export function settingFromSpeech(heard: string, voices: Voice[]): SettingChange | null {
  const text = words(heard).join(' ');
  if (has(text, ['done', 'exit', 'go back', "that's all", "that's it"])) return { kind: 'done' }; // not "close": that's a warning distance
  if (has(text, ['back', 'sections'])) return { kind: 'back' };
  if (has(text, ['replay setup', 'replay', 'setup again'])) return { kind: 'replay' };
  if (has(text, ['haptics', 'haptic', 'vibration', 'vibrate'])) {
    if (has(text, OFF_WORDS)) return { kind: 'haptics', on: false };
    if (has(text, ON_WORDS)) return { kind: 'haptics', on: true };
  }
  if (has(text, ['guidance voice', 'natural voice', 'guidance'])) {
    if (has(text, OFF_WORDS)) return { kind: 'speech', on: false };
    if (has(text, ON_WORDS)) return { kind: 'speech', on: true };
  }
  if (has(text, ['faster', 'quicker', 'speed up'])) return { kind: 'speed', delta: 1 };
  if (has(text, ['slower', 'slow down'])) return { kind: 'speed', delta: -1 };
  if (has(text, ['rename', 'change the name', 'new name', 'call it'])) {
    const byLength = [...voices].sort((a, b) => b.name.length - a.name.length);
    return { kind: 'rename', voice: byLength.find((x) => has(text, [words(x.name).join(' ')])) ?? null };
  }
  if (has(text, ['record', 'recording', 'new voice', 'make a voice', 'make one', 'add a voice'])) return { kind: 'record' };
  if (has(text, ['list', 'again', 'hear them', 'play them', 'all of them'])) return { kind: 'list' };
  const cmd = parseCommand(text.includes('warn') || has(text, ['feet', 'foot', 'meters', 'metres', 'meter']) ? text : `use ${text}`, voices);
  if (has(text, ['close', 'closer']) && !text.includes('warn')) return { kind: 'warning', warning: 'close' };
  if (cmd.action === 'units') return { kind: 'units', units: cmd.units };
  if (cmd.action === 'warning') return { kind: 'warning', warning: cmd.warning };
  if (cmd.action === 'voice') return { kind: 'voice', voice: cmd.voice };
  if (has(text, ['far', 'farther', 'further', 'early', 'earlier', 'sooner'])) return { kind: 'warning', warning: 'early' };
  if (has(text, ['normal'])) return { kind: 'warning', warning: 'normal' };
  if (has(text, ['close', 'closer'])) return { kind: 'warning', warning: 'close' };
  if (has(text, ['voice', 'voices', 'different voice', 'change voice', 'my voice'])) return { kind: 'voices' };
  return null;
}

export const isYes = (heard: string) =>
  has(words(heard).join(' '), ['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'start', 'go', 'go ahead', 'do it']);

// A spoken name, tidied for the voice list: "mom." -> "Mom".
export function cleanName(heard: string): string {
  return heard
    .replace(/[.,!?"]/g, '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 30);
}
