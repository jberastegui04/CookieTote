import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
import Settings, { type SettingsPage } from './Settings';
import FindPicker from './FindPicker';
import { loadFindTargets, type LowObstacle, type PathCheck } from './find';
import FindScreen from './FindScreen';
import { setTapHaptics, tapHaptic } from './feedback';
import { useReduceMotion } from './motion';
import { ViewfinderCorners } from './texture';
import { WalkerBubble, WalkerButton, type WalkerState } from './Walker';
import {
  findLine,
  LINES,
  cleanName,
  isYes,
  MENU,
  onOffLine,
  parseCommand,
  sectionFromSpeech,
  settingFromSpeech,
  speedLine,
  unitsLine,
  voiceLine,
  warnLine,
  type Section,
  type SettingChange,
} from './walkerCommands';
import { trackUpdate, trackView, type Candidate, type Track } from './tracker';
import Setup from './Setup';
import { DEFAULT_PREFS, formatDistance, SPEEDS, type Prefs } from './prefs';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

// Your laptop's address on the same Wi-Fi, set in app/.env (see README).
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

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
  // Up to 3 other things the detector is sure of, nearest first (already in `sentence`).
  objects?: {
    label: string;
    count: number;
    direction: 'left' | 'ahead' | 'right';
    distance_m: number | null;
    box: [number, number, number, number];
  }[];
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
  candidates?: Candidate[]; // every candidate this frame, best first; the tracker follows one
  // low: foot-height only (find.ts). box: the nearest obstacle's outline, like LowObstacle's.
  obstacle: SonarResult & { low?: LowObstacle | null; box?: [number, number, number, number] | null };
  path?: PathCheck | null; // the straight line to the target (find.ts)
  stale?: boolean; // app-side: the tracker hasn't seen it for a moment, so the box is drawn faded
  locked?: boolean; // app-side: the tracker locked onto it (2 confident sightings in a row)
};

type Status = 'idle' | 'capturing' | 'thinking' | 'error';

type Voice = { id: string; name: string; custom?: boolean }; // custom: a trusted voice the user recorded
// Voice cloning: tap to hear the consent notice, tap again to record, tap again to stop and upload.
type CloneStep = 'idle' | 'confirm' | 'recording' | 'uploading';
const CLONE_MAX_MS = 30000;
// Recording a voice through Walker (no hands): there's no tapping to stop, so it's shorter, and stops by itself.
const CLONE_HANDS_FREE_MS = 15000;
// Said when the server refuses a voice change for lack of the app key (on the /say list).
const NEEDS_APP_KEY = 'Adding voices is locked on this phone. The app key is missing.';
// Said (without VoiceOver) just before a voice recording starts. On the /say list in backend/main.py.
const CLONE_RECORDING_CUE = 'Recording. Speak naturally. Tap again to stop.';
const VOICE_KEY = 'voice_id';
const SETUP_KEY = 'setup_done';
// For the demo, setup opens on every launch (last choices already selected). Set to false so it only shows once.
const ALWAYS_SHOW_SETUP = true;
const PREFS_KEY = 'prefs';
// The obstacle tag and card clear after this, so an old warning doesn't linger once you've passed it.
const RESULT_SHOW_MS = 5000;
// Free ngrok links answer with an HTML warning page unless this header is sent. X-App-Key lets the
// public Space tell this app from anyone with the link; it's only checked for adding, renaming and
// deleting voices (APP_KEY on the server, EXPO_PUBLIC_APP_KEY in app/.env).
const APP_KEY = process.env.EXPO_PUBLIC_APP_KEY;
const HEADERS: Record<string, string> = {
  'ngrok-skip-browser-warning': 'true',
  ...(APP_KEY ? { 'X-App-Key': APP_KEY } : {}),
};

// Guide mode: a frame to /sonar every GUIDE_PERIOD_MS at most, and a voice that speaks only when the
// situation changes (open / far / close / stop, with a direction), plus a reminder now and then.
// 300 ms once capture got fast (small pictureSize); the GPU answers in about 0.1 s.
const GUIDE_PERIOD_MS = 300;
// Up to this many frames waiting on the server at once; answers older than the newest applied are dropped.
const GUIDE_IN_FLIGHT = 2;
// A frame stuck on the network longer than this is dropped; newer frames are already on their way.
// Measured 18:46: the round trip is usually 0.3 s, but one in ten took about 3 s on venue Wi-Fi.
const FRAME_TIMEOUT_MS = 2000;

// Small 4:3 photos for the guide and Find. A full-size capture took about 0.7 s a frame (measured
// 18:46), and the models only use about 500 px; 480 px wide reads the same distances as 768
// (checked on the measured photos). 4:3 because the bearing math assumes that field of view.
function pickFastSize(sizes: string[]): string | undefined {
  if (sizes.includes('640x480')) return '640x480';
  const fits = sizes
    .map((s) => {
      const m = s.match(/^(\d+)x(\d+)$/);
      return m ? { s, a: Math.max(+m[1], +m[2]), b: Math.min(+m[1], +m[2]) } : null;
    })
    .filter((x): x is { s: string; a: number; b: number } => !!x && Math.abs(x.a / x.b - 4 / 3) < 0.02 && x.b >= 480 && x.a <= 1600)
    .sort((x, y) => x.a * x.b - y.a * y.b);
  return fits[0]?.s;
}
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
// The nearest obstacle keeps the microphone. A more urgent reading (far -> close -> stop)
// replaces the current warning at once; a less urgent one, or the same urgency on the other
// side, only after this many frames in a row agree (about one frame a second). Otherwise one
// noisy frame makes the voice jump to the next thing before the user has dealt with this one.
const DOWNGRADE_STREAK = 2;
// Find mode: repeat the sentence this often while it hasn't changed, and pulse harder as the
// target nears the center of the frame (bearing 0).
const FIND_REMIND_MS = 3000;
const FIND_AHEAD_DEG = 8;
const FIND_CENTERED_DEG = 5; // within this, you're facing it (FIND_CENTERED_DEG in pipeline.py)
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
// Open-vocabulary targets ("green dragon toy") can't be on the /say allow-list, so those say "It".
const clockPhrase = (target: string, offsetDeg: number, openVocab: boolean) => {
  const hour = ((Math.round(offsetDeg / 30) + 12) % 12) || 12;
  return openVocab ? `It's at ${hour} o'clock.` : `${capitalize(target)} at ${hour} o'clock.`;
};
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180; // to (-180, 180]
// Each gyro reading moves the heading this fraction of the way to the new value (1 = no smoothing).
const HEADING_SMOOTHING = 0.5;
// The heading is where the CAMERA points, worked out from all three of the motion sensor's angles.
// It used to be the sensor's yaw alone, which is only that when the phone lies flat. Held upright,
// the way Find is used, yaw also swings when the phone tips sideways like a steering wheel: 5 degrees
// of wrist reads as a 14 degree turn with the phone at 70 degrees, 27 at 80. The camera hasn't turned
// at all, but the box slid across the screen and the voice said "slightly left". And tipped back past
// upright (camera pointing a little up) yaw flips by 180. Set to false to go back to yaw alone.
const HEADING_FROM_CAMERA = true;
// Find runs in two phases. SEARCH: standing still and turning; only the target is spoken, and
// obstacles are ignored (false "Stop"s while turning on the spot were confusing). APPROACH: walking
// toward it; something close starts a detour (see Detour below), otherwise target drift. Phrases
// are on the /say list.
type FindPhase = 'search' | 'approach';
const HANDOFF_PHRASE = "Got it. Walk toward it. I'll warn you about anything in the way.";
const LOST_PHRASE = 'Lost it. Stop and turn slowly.';
const STAND_STILL_PHRASE = 'Stand still while I look.';
// Nothing in sight after a full turn: suggest a few steps forward (obstacle warnings on while they
// walk), then search again. Both phrases are on the /say list (ARRIVAL_PHRASES in backend/main.py).
const FULL_TURN_DEG = 330;
const EXPLORE_MS = 7000;
const SPIN_NOISE_DEG = 1; // heading changes under this between checks are hand shake, not turning
const NOT_IN_SIGHT_PHRASE = 'Not in sight from here. Walk forward a few steps, then stop.';
const SEARCH_AGAIN_PHRASE = 'Now stop, and turn slowly again.';
const HANDOFF_CENTERED_MS = 1000; // facing it this long (and seen recently) hands off to Approach
const HANDOFF_SEEN_WITHIN_MS = 3000;
const APPROACH_DRIFT_MS = 2000; // how often the drift sentence may repeat
// How often an unchanged phrase is repeated while walking toward the target. Was 2 s, which with a
// 2 s phrase meant the voice never stopped.
const APPROACH_REMIND_MS = 3000;
const URGENT_REMIND_MS = 2000; // Stop, close-by warnings and detour steps keep repeating quickly
// A breath after every phrase before the next one starts. Directions were running into each other
// with no pause, which is too much to take in while walking. Safety speech doesn't wait. Nothing is
// queued meanwhile: when the pause ends, the voice says whatever is true then.
// 900 felt too slow on the phone; each clip already carries 0.2 s of silence at both ends.
const VOICE_GAP_MS = 400;
const LOST_AFTER_MS = 4000; // not seen this long, and out of view: back to Search
// Walking detection in Search (user acceleration, gravity removed): a smoothed level above this
// for WALK_SUSTAIN_MS means they're walking, and the app asks them to stand still, once.
// Measured on an iPhone: standing and turning slowly stayed at 0.08-0.38 (one 0.3 s blip to 0.55);
// walking peaked at 0.7-1.7 and dipped to about 0.5 at the ends. Short walks were about 1 s over.
const WALK_LEVEL = 0.6;
const WALK_SUSTAIN_MS = 800;
// Approach detour: something close (or a stop) while walking toward the target. The user keeps
// the phone pointed at the target and steps sideways, toward the open side the server reports
// (or away from the obstacle). Target phrases and pulses are muted so nothing argues with the
// step instruction. Once the obstacle reads clear for DETOUR_CLEAR_FRAMES answers in a row, the
// voice says to turn back toward the target and the normal approach takes over. Phrases are on
// the /say list (DETOUR_PHRASES in backend/main.py); change both together.
// side is null when no side was confirmed open: then it only warns ("Stop. Something right in front
// of you."), never "Step to your …", since stepping into space nobody checked is worse than stopping.
// lowSeenAt: when a low obstacle (below) last kept this detour going, 0 if none did. startX: the
// obstacle box's center across the picture when the step was said; lastBox: its box last seen.
// said: the step phrase, kept word for word while the detour lasts (the voice repeats new wording).
type Detour = {
  side: 'left' | 'right' | null;
  startedAt: number;
  clearFrames: number;
  lowSeenAt: number;
  startX: number | null;
  startHeading: number | null; // the gyro heading then, so turning the phone isn't taken for a step
  lastBox: [number, number, number, number] | null;
  said: Situation | null;
};
const DETOUR_CLEAR_FRAMES = 2;
// Dodged. Stepping left makes the obstacle slide right in the picture. Once its box is wholly on the
// right half and has moved DODGE_SHIFT since the step was said, or it leaves the picture out the
// right side (last seen center past DODGE_EXIT_X from the middle, touching the lane's right end), it's passed: "Clear. Now turn
// right..." at once, instead of repeating the step. For DODGE_IGNORE_MS after, something wholly on
// that half doesn't start a new detour (it's the same thing, still beside you). Mirrored for right.
const DODGE_SHIFT = 0.1;
const DODGE_EXIT_X = 0.1;
const DODGE_IGNORE_MS = 4000;
// The server only looks for obstacles across this part of the width (LANE_X in pipeline.py), so a box
// this close to one of its ends was leaving out that side.
const LANE_LEFT = 0.2;
const LANE_RIGHT = 0.8;
const LANE_EDGE_SLACK = 0.03;
// The step phrase repeats this often (Stop still every URGENT_REMIND_MS): once is usually enough.
const DETOUR_REMIND_MS = 4000;
// Straight-line check (`path` from /find): lined up with the target in Approach, is the corridor to it
// open? Said once after the hand-off, again after a detour ends, and otherwise only when the answer
// flips (open <-> something in the way) for PATH_CHANGE_FRAMES answers in a row. It replaces Find's
// old "Something ahead, about 3 meters" warning, which looked at a fixed strip of the screen instead
// of the way to the target. Phrases are PATH_PHRASES in backend/main.py; change both together.
const PATH_CHANGE_FRAMES = 2;
const PATH_OPEN_PHRASE = 'Path to it looks open.';
function pathPhrase(p: PathCheck, units: Units): string {
  if (p.clear || p.distance_m === null) return PATH_OPEN_PHRASE;
  const n =
    units === 'feet'
      ? Math.max(1, Math.min(20, Math.round(p.distance_m * FEET_PER_METER)))
      : Math.max(1, Math.min(5, Math.round(p.distance_m)));
  const unit = units === 'feet' ? (n === 1 ? 'foot' : 'feet') : n === 1 ? 'meter' : 'meters';
  return `Something in the way, about ${n} ${unit}.${p.pass ? ` Go around it on the ${p.pass}.` : ''}`;
}
// Low obstacles (obstacle.low from /find: a box, a bin, a step, only at foot height). With the phone
// held up at the target, roughly the last 1.5 m of floor isn't in the picture, so these slide out the
// bottom of the frame before they ever read "close", and depth reads them too far up close (a box
// 0.5 m away read 1.3 m). So in Approach they start a detour from LOW_DETOUR_M (scaled by "Warn me"),
// or at once when they reach the bottom edge. And a detour one started holds for LOW_PASS_MS after it
// was last seen: dropping out of the picture doesn't mean it's out of the way.
const LOW_DETOUR_M = 2;
const LOW_PASS_MS = 3000;
// A low reading mostly inside the tracked target's box is the target itself (the server leaves the
// target out only on frames where it detected it).
const LOW_IN_TARGET = 0.5;
const lowPhrase = (obstacle: Side, step: 'left' | 'right' | null) =>
  `Something low ${obstacle === 'ahead' ? 'ahead' : `on your ${obstacle}`}.${step ? ` Step to your ${step}.` : ''}`;
// Fraction of box a's area that lies inside box b (both x, y, width, height).
function insideFraction(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 && a[2] * a[3] > 0 ? (w * h) / (a[2] * a[3]) : 0;
}
const DETOUR_STUCK_MS = 8000; // still blocked after this long: say to back up, and start over
const DETOUR_STUCK_PHRASE = 'Still blocked. Back up a step.';
// Find also says when something is ahead further out (the server reports up to about 3.5 m while
// finding): once per distance step, and nothing may talk over it until this long after the voice
// started saying it; then back to the target.
const FIND_AHEAD_HOLD_MS = 2500;
const detourPhrase = (obstacle: Side, step: 'left' | 'right', stop: boolean) =>
  stop
    ? `Stop. Step to your ${step}.`
    : `Something close ${obstacle === 'ahead' ? 'ahead' : `on your ${obstacle}`}. Step to your ${step}.`;
const detourClearPhrase = (stepped: 'left' | 'right') =>
  `Clear. Now turn ${stepped === 'left' ? 'right' : 'left'} until it's in front of you.`;
// Centered and this close: you've arrived. Find stops and says to reach forward.
const ARRIVE_DISTANCE_M = 0.7;
// Also arrived when the centered box is at least this wide (fraction of the frame): metric depth
// is unreliable inches from a textureless object (it read 2 m with the dragon at the lens), but a
// box this big only happens within reach.
const ARRIVE_BOX_WIDTH = 0.6;
const ARRIVE_BOX_DEPTH_M = 1.2; // with a big box, depth must say at least this close (or the box spills off both sides)

// Walker, the voice assistant: fixed spoken commands (walkerCommands.ts) through POST /transcribe.
// After a tap he records until you've spoken and paused, measured against the room's own noise so a
// loud venue doesn't keep him listening forever.
const WALKER_MAX_MS = 7000;
const WALKER_NO_SPEECH_MS = 5000; // nothing said by then: stop listening
const WALKER_SILENCE_MS = 1100; // quiet this long after speaking: done
const WALKER_SPEECH_DB = 15; // this many dB over the quietest level so far counts as talking
const WALKER_QUIET_DB = 8; // back under this counts as a pause
const WALKER_WAIT_MS = 3000; // how long he waits for the guide or Find to finish talking first
// One voice for everything: Walker, the guide and Find all speak in the chosen voice, which starts as
// Walker's own, "Chris", a relaxed American ElevenLabs voice. It's changed in Settings. His lines are
// on the server's /say list. If ElevenLabs can't be reached, or Guidance voice is off, a built-in
// American voice, a little slower and lower: the first of these the phone has, better quality first.
const WALKER_VOICE_ID = 'iP95p4xoKVk53GoZ742B';
const WALKER_FALLBACK_VOICES = ['Evan', 'Nathan', 'Tom', 'Alex', 'Aaron'];
const WALKER_FALLBACK_RATE = 0.92;
const WALKER_FALLBACK_PITCH = 0.9;
type Heard = { text: string; target: string | null; description: string | null; open_vocab?: boolean };
// Safety speech that Walker never holds back or talks over: Stop, close-by warnings, detours.
const isUrgent = (s: Situation | null) =>
  !!s && (s.stop || s.key.startsWith('close') || s.key.startsWith('detour'));

// Said when Find starts. On the /say list for every target (STATUS_PHRASES in backend/main.py).
const findingPhrase = (target: string) => `Finding ${target}. Turn slowly.`;
const FINDING_IT = 'Finding it. Turn slowly.';
// Up and down. The gyro remembers which way the target is left and right, but nothing knew its
// height. Walking toward something lower than the phone (on a table, on the floor) it slides out
// of the bottom of the picture, and a blind user can't see that happen: Find just lost it. So
// while the target sits low (or high) in the picture, the voice says to tilt before it is gone; and if
// it disappears right after sitting there, the voice says where it went instead of "No match yet".
// Phrases are on the /say list (FRAMING_PHRASES in backend/main.py); change both together.
// Left and right. The voice says what to do, in two sizes ("turn a little left" up to
// FIND_SMALL_TURN_DEG, "turn left" beyond, same as find_sentence in pipeline.py), and the moment the
// turn brings the target dead ahead it says LINED_UP_PHRASE, cutting the turn instruction that is now
// out of date. No words can say how far to turn; this says when to stop. Both on the /say list.
const FIND_SMALL_TURN_DEG = 15;
const LINED_UP_PHRASE = 'Straight ahead.';
const LINED_UP_EVERY_MS = 3000; // not more often than this, however the hand wobbles
const TURN_WORDS = /turn (a little )?(left|right)|slightly (left|right)|to your (left|right)|o'clock/; // says it's off to one side
type Tilt = 'up' | 'down';
const TILT_START = 0.72; // box center this far down the picture (0 top, 1 bottom): tilt down. Mirrored for up.
const TILT_STOP = 0.62; // keep saying it until the center is back inside this
const OFF_FRAME_BLANKS = 2; // answers in a row without it before saying it went out of the picture
const OFF_FRAME_MEMORY_MS = 10000; // how long that is believed
const tiltPhrase = (dir: Tilt) => `Tilt the phone ${dir} a little.`;
const offFramePhrase = (dir: Tilt) =>
  dir === 'down' ? "It's below the camera. Tilt the phone down." : "It's above the camera. Tilt the phone up.";
// The server's "how far" wording (_find_how_far in backend/pipeline.py), for when the app corrects
// the distance up close (track.near in tracker.ts). Same words, so the result stays on the /say list.
function howFar(meters: number, units: Units): string {
  if (meters <= 0.5) return 'very close';
  if (units === 'feet') {
    const raw = meters * 3.28084;
    const feet = raw < 10 ? Math.round(raw) : 5 * Math.round(raw / 5);
    return `about ${feet} ${feet === 1 ? 'foot' : 'feet'}`;
  }
  const m = meters < 3.25 ? Math.round(meters * 2) / 2 : Math.round(meters);
  return `about ${m} ${m === 1 ? 'meter' : 'meters'}`;
}
// "Found it, ahead, about 2 meters." with its distance replaced.
// The server's Find sentence (find_sentence in backend/pipeline.py), taken apart and put back
// together, so the app can change the direction (from the gyro) or the distance (from the box) and
// still say something on the /say list. Three wordings exist, newest first; the app answers in
// whichever one the server it is talking to uses, so wordings (and voices) are never mixed:
//   walk      "Chair, turn a little left and walk about 2 meters."  /  "Chair, very close, a little to your left."
//   comma     "Chair, turn left, about 2 meters."   (was heard as "turn left about 2 meters")
//   slightly  "Chair, slightly left, about 2 meters."
// Straight ahead is the same in all three: "Chair, ahead, about 2 meters."
type Wording = 'walk' | 'comma' | 'slightly';
type FindParts = { name: string; side: 'left' | 'right' | null; small: boolean; far: string };
function wordingOf(sentence: string): Wording | null {
  if (sentence.includes('slightly ')) return 'slightly';
  if (sentence.includes(' and walk ') || /, very close, (turn |a little to your |to your )/.test(sentence)) return 'walk';
  if (/, turn [a-z ]+, /.test(sentence)) return 'comma';
  return null; // "ahead", or not a sighting: says nothing about the wording
}
function parseFind(sentence: string): FindParts | null {
  const comma = sentence.indexOf(', ');
  const far = sentence.match(/very close|(?:about|more than) [\d.]+ (?:meters?|feet|foot)/);
  if (comma < 0 || !far) return null;
  const side = sentence.match(/\b(left|right)\b/);
  return {
    name: sentence.slice(0, comma),
    side: side ? (side[1] as 'left' | 'right') : null,
    small: /a little |slightly /.test(sentence),
    far: far[0],
  };
}
function findSentence(p: FindParts, wording: Wording): string {
  if (!p.side) return `${p.name}, ahead, ${p.far}.`;
  if (wording === 'slightly') return `${p.name}, slightly ${p.side}, ${p.far}.`;
  const turn = p.small ? `turn a little ${p.side}` : `turn ${p.side}`;
  if (wording === 'comma') return `${p.name}, ${turn}, ${p.far}.`;
  // Within reach it says where the target is, not a turn (see find_sentence).
  if (p.far === 'very close') return `${p.name}, very close, ${p.small ? 'a little ' : ''}to your ${p.side}.`;
  return `${p.name}, ${turn} and walk ${p.far}.`;
}
// A Find sentence with its distance replaced.
function withHowFar(sentence: string, meters: number, units: Units, wording: Wording): string {
  const p = parseFind(sentence);
  return p ? findSentence({ ...p, far: howFar(meters, units) }, wordingOf(sentence) ?? wording) : sentence;
}
// An obstacle in the target's direction, no nearer than the target less this, is the target
// (FIND_SELF_M in pipeline.py; the app repeats the check once it has corrected the distance).
const FIND_SELF_M = 0.6;
// Arrival says where to reach: "You're there. Reach forward and a little left, at waist height."
// Side: from the target's bearing (it no longer has to be dead center to count as arrived, only
// within FIND_SMALL_TURN_DEG). Height: how far above or below the phone the target is, from the
// camera's tilt (motion sensor), where the box sits in the picture, and the distance; the phone is
// taken to be at about chest height. Phrases are REACH_PHRASES in backend/main.py.
const V_HALF_FOV_DEG = 33; // top or bottom edge of the 3:4 picture (26 at the sides)
type Band = 'head' | 'chest' | 'waist' | 'knee' | 'floor';
type Reach = { side: 'left' | 'right' | null; band: Band | null };
const BAND_WORDS: Record<Band, string> = {
  head: 'at head height',
  chest: 'at chest height',
  waist: 'at waist height',
  knee: 'at knee height',
  floor: 'near the floor',
};
// Meters above (+) or below (-) the phone. With the phone at about 1.3 m: head 1.6, chest 1.3, waist
// 1.0, knee 0.5, floor 0; each band runs to the midpoint with the next (a table top lands in waist,
// a chair seat in knee).
const bandFor = (rel: number): Band =>
  rel > 0.15 ? 'head' : rel > -0.15 ? 'chest' : rel > -0.6 ? 'waist' : rel > -1.05 ? 'knee' : 'floor';
const reachPhrase = (r: Reach) =>
  `You're there. Reach forward${r.side ? ` and a little ${r.side}` : ''}${r.band ? `, ${BAND_WORDS[r.band]}` : ''}.`;
// The older arrival line, still said when the server doesn't know the new ones yet.
const arrivalPhrase = (target: string, openVocab: boolean) =>
  openVocab
    ? "You're there. It's right in front of you."
    : `You're there. The ${target} is right in front of you. Reach forward.`;

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

// How urgent a guide situation is: stop > close > far > open. Used to decide whether a new
// reading may replace the current warning right away (see DOWNGRADE_STREAK).
function urgency(s: Situation | null): number {
  if (!s) return 0;
  if (s.stop) return 3;
  if (s.key.startsWith('close')) return 2;
  if (s.key.startsWith('far')) return 1;
  return 0;
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
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Photos come back portrait 3:4; the preview fills the screen and crops the sides.
const PHOTO_ASPECT = 3 / 4;
// Describe's object boxes (objectMarks): skip one when more than this fraction of the smaller of it
// and a box already drawn overlaps; tags are sized from their text (no layout pass) and kept clear
// of the top bar and the card at the bottom.
const OBJECT_OVERLAP_MAX = 0.5;
const OBJECT_TAG_H = 32;
const OBJECT_TAG_PAD = 10;
const OBJECT_TAG_CHAR_W = 9.5; // about one character of the 16 pt bold tag text
const TAG_CHAR_W = 12; // the same for the obstacle's 20 pt tag
const BOTTOM_CARD_H = 240;
type Rect = { left: number; top: number; width: number; height: number };
// How much of the smaller of two rectangles the other covers, 0 to 1.
function overlapFraction(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return w > 0 && h > 0 && smaller > 0 ? (w * h) / smaller : 0;
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [fontsLoaded, fontError] = useFonts({
    AtkinsonHyperlegibleNext_400Regular,
    AtkinsonHyperlegibleNext_600SemiBold,
    AtkinsonHyperlegibleNext_700Bold,
    AtkinsonHyperlegibleNext_800ExtraBold,
  });
  const cameraRef = useRef<CameraView>(null);
  const [fastPictureSize, setFastPictureSize] = useState<string | undefined>(undefined);
  const player = useAudioPlayer(null);
  const lastClip = useRef<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DescribeResult | null>(null);
  // Voice picker. The list comes from GET /voices; the choice is remembered on the phone.
  const [voices, setVoices] = useState<Voice[]>([]);
  // "Say the name" for a trusted voice: same 3 second recording and /transcribe as Find.
  const [newVoiceId, setNewVoiceId] = useState<string | null>(null); // Settings opens it to be named
  const [nameState, setNameState] = useState<'idle' | 'listening' | 'working'>('idle');
  const [voiceId, setVoiceId] = useState<string | null>(WALKER_VOICE_ID);
  // The chosen voice has to exist. If it was deleted, here or on another phone, go back to the
  // default one instead of quietly speaking in the phone's own voice.
  useEffect(() => {
    if (voices.length && voiceId && !voices.some((v) => v.id === voiceId)) fallBackToDefaultVoice();
  }, [voices, voiceId]);
  // Walker's voice until the user picks another in Settings; one voice for everything.
  const voiceIdRef = useRef<string | null>(WALKER_VOICE_ID);
  const screenReader = useRef(false);
  const [cloneStep, setCloneStep] = useState<CloneStep>('idle');
  const [cloneMaxS, setCloneMaxS] = useState(CLONE_MAX_MS / 1000); // shown on the Record row while recording
  const cloneStepRef = useRef<CloneStep>('idle');
  const cloneTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // the current step's timeout
  const cloneStarting = useRef(false); // between the second tap and the recorder actually running
  const defaultVoice = useRef<string | null>(null); // from GET /voices
  const deletedVoices = useRef(new Set<string>()); // deleted on this phone; never listed again
  // Metering gives Walker the sound level, so he can stop listening when you stop talking.
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });

  // Guide mode. The loops below run for a long time, so they read refs instead of state.
  const [guideOn, setGuideOn] = useState(false);
  const [guideDistance, setGuideDistance] = useState<number | null>(null);
  const [guideSide, setGuideSide] = useState<Side | null>(null);
  const [guideText, setGuideText] = useState('');
  const guideOnRef = useRef(false);
  const cameraBusy = useRef(false); // one photo at a time, shared by describe and guide
  const quietUntil = useRef(0); // guide stays quiet while a describe sentence is being spoken
  const situation = useRef<Situation | null>(null); // newest reading, sorted; null until the first one
  const recentDirections = useRef<Side[]>([]); // last few readings, so one noisy frame can't flip the side
  const clearStreak = useRef(0);
  const downgradeStreak = useRef(0); // frames in a row saying something less urgent than the current warning
  // Find mode: where a chosen object is. Shares the frame loop and the voice with the guide.
  const [findOn, setFindOn] = useState(false);
  const [findTarget, setFindTarget] = useState<string | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const [findInfo, setFindInfo] = useState<FindResult | null>(null);
  // "Say what to find": a 3 second recording goes to /transcribe, then Find starts with the answer.
  const [speakState, setSpeakState] = useState<'idle' | 'listening' | 'working'>('idle');
  const findDescriptionRef = useRef<string | null>(null);
  const findOpenVocabRef = useRef(false); // target isn't one of the server's named objects
  const knownTargets = useRef<Set<string>>(new Set());
  const [arrived, setArrived] = useState<string | null>(null); // target just reached, until the next action
  const findOnRef = useRef(false);
  const findTargetRef = useRef<string | null>(null);
  const headingRef = useRef<number | null>(null); // phone heading in degrees, clockwise, from the gyro
  const yawFix = useRef(0); // radians added to the sensor's yaw to get the camera's heading (HEADING_FROM_CAMERA)
  const elevationRef = useRef<number | null>(null); // how far the camera points above (+) or below (-) level, degrees
  const [headingNow, setHeadingNow] = useState<number | null>(null); // same, as state, so the screen follows the turn
  const targetHeadingRef = useRef<number | null>(null); // heading the target was last seen at
  const trackRef = useRef<Track | null>(null); // the object Find is following (tracker.ts)
  const findMisses = useRef(0);
  const findPhaseRef = useRef<FindPhase>('search');
  const lastFoundAt = useRef(0); // when the target was last in a frame
  const lastSentence = useRef<string | null>(null); // last server sentence with the target in view
  const centeredSince = useRef<number | null>(null);
  const lastDriftAt = useRef(0);
  const walkLevel = useRef(0);
  const movingSince = useRef<number | null>(null);
  const saidStandStill = useRef(false);
  const spinDeg = useRef(0); // degrees turned in Search since the target was last seen
  const spinFrom = useRef<number | null>(null);
  const exploreUntil = useRef(0); // after a full turn with no sighting: walking a few steps until then
  const findBlanks = useRef(0); // answers in a row with the target not in the frame
  const detourRef = useRef<Detour | null>(null); // stepping around something in Approach
  const dodgedRef = useRef<{ side: 'left' | 'right'; until: number } | null>(null); // just passed something on that side
  const tiltRef = useRef<Tilt | null>(null); // the target sits low or high in the picture: which way to tilt
  const wentOff = useRef<{ dir: Tilt; at: number } | null>(null); // it was last seen there, and when
  // The voice is on tilting right now; the left/right drift phrase waits for it.
  const framingLive = () => !!situation.current && /^(tilt|offframe):/.test(situation.current.key);
  // Last "Something ahead, about 3 meters" in Find; spokenAt is null until voiceLoop has said it.
  const aheadWarned = useRef<{ key: string; spokenAt: number | null } | null>(null);
  // While this is true nothing else (target guidance, drift) may take the situation from it.
  // Straight-line check (see PATH_CHANGE_FRAMES): what was last said, whether it's due regardless
  // (after the hand-off or a detour), answers in a row that disagree with it, and whether this
  // approach has had a path answer at all (then the old far-ahead warning stays quiet).
  const pathRef = useRef({ said: null as 'open' | 'blocked' | null, due: false, streak: 0, seen: false });
  // The path phrase just set; held like the far-ahead warning so target guidance can't replace it unsaid.
  const pathHold = useRef<{ key: string; spokenAt: number | null } | null>(null);
  const pathHoldLive = (now: number) => {
    const w = pathHold.current;
    return !!w && situation.current?.key === w.key && (w.spokenAt === null || now - w.spokenAt < FIND_AHEAD_HOLD_MS);
  };
  const aheadHoldLive = (now: number) => {
    const w = aheadWarned.current;
    return !!w && situation.current?.key === w.key && (w.spokenAt === null || now - w.spokenAt < FIND_AHEAD_HOLD_MS);
  };
  const motionSub = useRef<{ remove: () => void } | null>(null);
  const arriveSound = useAudioPlayer(require('./assets/arrive.wav'));
  // Lock-on: a short rising two-note chime (G5, D6) when the tracker locks onto the target.
  const lockSound = useAudioPlayer(require('./assets/lock.wav'));
  // The guide voice: one phrase at a time, files cached per voice, and the phone's voice as fallback.
  const speechBusy = useRef(false);
  const speakingStop = useRef(false);
  const speechToken = useRef(0);
  const speechCut = useRef(0); // bumped when a phrase is cut on purpose (a Stop), so its wait ends
  const speakingText = useRef<string | null>(null); // what the voice is saying right now
  const offCenter = useRef(false); // the target has been off to one side since the last "Straight ahead."
  const linedUpAt = useRef(0);
  // A server that hasn't been redeployed still says "slightly left"; the app matches it, so the two
  // wordings (and the two voices: unknown phrases fall back to the phone's) are never mixed.
  const wording = useRef<Wording>('walk');
  const [walkerState, setWalkerState] = useState<WalkerState>('idle');
  const walkerStateRef = useRef<WalkerState>('idle');
  const [walkerText, setWalkerText] = useState<string | null>(null);
  const walkerDone = useRef(false); // tapped again while listening: stop recording now
  // While Walker listens and thinks, the guide and Find hold their routine sentences (not safety
  // ones), so they don't end up in the recording.
  const walkerHolds = useRef(false);
  const walkerVoice = useRef<string | undefined>(undefined); // identifier of his built-in fallback voice
  const walkerPlaying = useRef(false); // his ElevenLabs clip is on the player
  const walkerCancel = useRef(false); // stopWalker: cut him off now
  const voicesRef = useRef<Voice[]>([]); // the voice list, for the settings menu's async loop
  // Settings' page and the section Walker is reading, kept here so the spoken menu and the screen
  // move together both ways (see onSettingsPage).
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('main');
  const settingsPageRef = useRef<SettingsPage>('main');
  const [settingsFocus, setSettingsFocus] = useState<Section | null>(null);
  const menuActive = useRef(false); // Walker's spoken settings menu is running
  const menuJump = useRef<'voices' | 'sound' | null>(null); // a tap moved the screen; the menu follows
  // Each start of Find, the voice loop, or the pulse loop bumps its counter, and an older copy still
  // running sees that and quits. So starting Find again while finding (Walker: "find the door") never
  // leaves two loops talking at once.
  const findGen = useRef(0);
  const voiceGen = useRef(0);
  const pulseGen = useRef(0); // the newest speakPhrase; an older one finishing doesn't clear speechBusy
  const phraseFiles = useRef(new Map<string, string>());
  const sampleFiles = useRef(new Map<string, string>()); // voice id -> saved sample WAV
  const latestSample = useRef<string | null>(null); // only the last voice tapped gets played

  // Screens and layout. Settings opens over the camera so the guide keeps working.
  const [showSettings, setShowSettings] = useState(false);
  const { width: screenW, height: screenH } = useWindowDimensions();
  // null until the saved answer loads, so the camera doesn't flash before setup.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  // Just tapped through the welcome: the poster is drawn over the camera, fading out (a crossfade).
  const [welcomeLeaving, setWelcomeLeaving] = useState(false);
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
    // Walker's fallback voice: the first of WALKER_FALLBACK_VOICES this phone has in American English,
    // enhanced quality first. Else the phone's default, slowed and lowered.
    Speech.getAvailableVoicesAsync()
      .then((list) => {
        const us = list.filter((x) => x.language === 'en-US');
        const ranked = [...us].sort((a, b) => Number(b.quality === 'Enhanced') - Number(a.quality === 'Enhanced'));
        for (const name of WALKER_FALLBACK_VOICES) {
          const v = ranked.find((x) => x.name === name);
          if (v) {
            walkerVoice.current = v.identifier;
            return;
          }
        }
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader.current = on));
    AsyncStorage.multiGet([SETUP_KEY, PREFS_KEY])
      .then(([[, savedSetup], [, savedPrefs]]) => {
        setSetupDone(!ALWAYS_SHOW_SETUP && savedSetup === '1');
        if (savedPrefs) {
          const loaded = { ...DEFAULT_PREFS, ...JSON.parse(savedPrefs) };
          prefsRef.current = loaded;
          setPrefs(loaded);
          setTapHaptics(loaded.haptics);
        }
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
    loadFindTargets()
      .then((t) => (knownTargets.current = new Set(t)))
      .catch(() => {});
    loadVoices()
      .then((data) => {
        fetchPhrase(SCANNING); // so the first "Scanning." is already in the chosen voice
        prefetchWalker();
      })
      .catch(() => {});
    // Stop the guide loops if the screen goes away.
    return () => {
      guideOnRef.current = false;
      findOnRef.current = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);

  // If the font fails to load, carry on with the system font rather than a blank screen.
  if (setupDone === null || (!fontsLoaded && !fontError)) return <View style={[styles.screen, styles.blank]} />;

  if (!setupDone) {
    return (
      <Setup onShown={welcomeCue} onFinish={finishSetup} />
    );
  }

  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar style="light" />
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>To find things and see what is ahead.</Text>
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

  // "Scanning." in the chosen voice, like the warnings that follow. Not awaited, so the photo isn't delayed.
  function sayStatus(text: string) {
    tell(text);
  }


  // Opening Settings silences the app and pauses the guide; closing it turns the guide back on.
  function showSettingsPage(page: SettingsPage) {
    settingsPageRef.current = page;
    setSettingsPage(page);
  }

  // A tap moved Settings to another page. If Walker's menu is running, he follows: the voice page
  // makes him read the voices; back from it, he returns to Sound and touch. He drops whatever he was
  // saying or listening for, so the next thing heard is about the new page.
  function onSettingsPage(page: SettingsPage) {
    const prev = settingsPageRef.current;
    showSettingsPage(page);
    if (!menuActive.current) return;
    const jump = page === 'voice' && prev !== 'voice' ? 'voices' : page === 'main' && prev === 'voice' ? 'sound' : null;
    if (!jump) return;
    menuJump.current = jump;
    stopWalker();
    if (walkerStateRef.current === 'listening') walkerDone.current = true;
  }

  function openSettings() {
    showSettingsPage('main');
    setSettingsFocus(null);
    loadVoices().catch(() => {}); // the team shares the voices; another phone may have changed them
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
    if (walkerStateRef.current === 'listening') walkerDone.current = true; // ends the settings menu
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
  // VoiceOver re-reading the button). Otherwise the chosen voice, through the same queue as the
  // guide and Find, so nothing talks over it: it cuts what's playing, and the loops wait until it's
  // done. Every message is on the /say list (STATUS_PHRASES in backend/main.py); one that isn't
  // falls back to the phone's voice.
  function tell(text: string) {
    if (screenReader.current) {
      AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: false });
      return;
    }
    player.pause();
    Speech.stop();
    speakPhrase(text, false);
  }

  // The Settings every request carries (see the README's settings table). distance_m always comes back
  // in meters; units only changes the spoken sentences.
  function appendSettings(form: FormData) {
    form.append('mode', 'indoor'); // indoor only: the indoor depth model and warning distance
    form.append('warning', prefsRef.current.warning);
    form.append('units', prefsRef.current.units);
  }

  // The welcome poster is up: after a moment (so VoiceOver can read the screen first), Walker says to
  // tap anywhere. With VoiceOver on he says "double tap", which is what VoiceOver needs.
  function welcomeCue() {
    setTimeout(() => {
      walkerReply(screenReader.current ? LINES.welcomeVO : LINES.welcome);
    }, 900);
  }

  function finishSetup() {
    AsyncStorage.setItem(SETUP_KEY, '1').catch(() => {});
    setSetupDone(true);
    if (permission?.granted) setWelcomeLeaving(true); // no crossfade into the camera-permission screen
    // Walker explains the basics once the camera is up.
    stopWalker();
    setTimeout(() => walkerReply(LINES.introHowTo), 700);
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

  // Each step's timeout (the consent step expiring, the 30 s cap on a recording) belongs to that
  // step. Left running, an old one fired in the middle of the next recording and cut it short.
  function setClone(step: CloneStep) {
    if (cloneTimer.current) clearTimeout(cloneTimer.current);
    cloneTimer.current = null;
    cloneStepRef.current = step;
    setCloneStep(step);
  }

  async function loadVoices() {
    const res = await fetch(`${API_URL}/voices`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data: { default: string; voices: Voice[] } = await res.json();
    // ElevenLabs' own list can trail a delete by a moment; a voice deleted here stays gone.
    const list = data.voices.filter((v) => !deletedVoices.current.has(v.id));
    defaultVoice.current = data.default;
    setVoices(list);
    return { ...data, voices: list };
  }

  function fallBackToDefaultVoice() {
    const id = defaultVoice.current ?? voices.find((v) => !v.custom)?.id ?? null;
    if (!id) return;
    voiceIdRef.current = id;
    setVoiceId(id);
    AsyncStorage.setItem(VOICE_KEY, id).catch(() => {});
  }

  function chooseVoice(v: Voice) {
    voiceIdRef.current = v.id;
    setVoiceId(v.id);
    AsyncStorage.setItem(VOICE_KEY, v.id).catch(() => {});
    fetchPhrase(SCANNING);
  }

  async function renameVoice(id: string, name: string) {
    const clean = name.trim().slice(0, 30);
    if (!clean) return;
    setVoices((prev) => prev.map((v) => (v.id === id ? { ...v, name: clean } : v)));
    sampleFiles.current.delete(id); // its sample says its name, so fetch the new one next time
    try {
      const form = new FormData();
      form.append('name', clean);
      const res = await fetch(`${API_URL}/voices/${id}/name`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      AccessibilityInfo.announceForAccessibility(`Named ${clean}`);
    } catch (e) {
      console.warn(e);
      await loadVoices().catch(() => {}); // put the old name back
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not rename the voice. Try again.');
    }
  }

  async function deleteVoice(id: string) {
    const name = voices.find((v) => v.id === id)?.name ?? 'The voice';
    // Gone from both lists at once, so it can't be picked while the server works. (It used to stay
    // listed, and tappable, until the server had answered twice; picking it left the app on a voice
    // that no longer exists.) The effect on `voices` moves off it if it was the voice in use.
    deletedVoices.current.add(id);
    setVoices((prev) => prev.filter((v) => v.id !== id));
    sampleFiles.current.delete(id);
    try {
      const res = await fetch(`${API_URL}/voices/${id}`, { method: 'DELETE', headers: HEADERS });
      // 404: already deleted, from another phone (the team shares one set of voices).
      if (!res.ok && res.status !== 404) throw new Error(`Server ${res.status}`);
      await loadVoices().catch(() => {});
      await notify(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility(`${name} deleted`);
    } catch (e) {
      console.warn(e);
      deletedVoices.current.delete(id);
      await loadVoices().catch(() => {}); // it's still there: list it again
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not delete the voice. Try again.');
    }
  }

  // Records until you stop talking (listenUntilQuiet) and returns what was said, cleaned up for a
  // name ("mom." -> "Mom"). Null if nothing was heard. Blind users can also type with VoiceOver or
  // the keyboard's dictation key.
  async function sayName(): Promise<string | null> {
    if (nameState !== 'idle') return null;
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      tell('Microphone access is needed to say the name.');
      return null;
    }
    setNameState('listening');
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      await buzz(Haptics.ImpactFeedbackStyle.Medium);
      AccessibilityInfo.announceForAccessibility('Listening');
      walkerDone.current = false; // listenUntilQuiet also stops on Walker's tap-again flag
      const heard = await listenUntilQuiet();
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      if (heard.interrupted || !heard.spoke) {
        setNameState('idle');
        tell('Could not hear the name. Try again, or type it.');
        return null;
      }
      if (!recorder.uri) throw new Error('No recording');
      setNameState('working');
      const form = new FormData();
      form.append('audio', new File(recorder.uri));
      const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data: { text: string } = await res.json();
      setNameState('idle');
      const name = data.text
        .replace(/[.,!?"]/g, '')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 30);
      if (!name) {
        tell("I didn't catch that. Try again.");
        return null;
      }
      return name;
    } catch (e) {
      console.warn(e);
      setNameState('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not hear the name. Try again, or type it.');
      return null;
    }
  }

  // One button, three taps: consent notice, start recording, stop and upload.
  // handsFree: Walker started it by voice. He has already said that recording is starting, so no
  // "tap again to stop" cue, and it stops by itself after CLONE_HANDS_FREE_MS.
  async function cloneTap(handsFree = false) {
    const step = cloneStepRef.current;
    if (step === 'uploading') return;
    if (step === 'idle') {
      setClone('confirm');
      const notice =
        'This records a trusted person for thirty seconds and makes a voice from it. ' +
        'Only record someone who has agreed. Double tap again to start recording.';
      tell(notice);
      cloneTimer.current = setTimeout(() => {
        if (cloneStepRef.current === 'confirm') setClone('idle');
      }, 20000);
      return;
    }
    if (step === 'confirm') {
      if (cloneStarting.current) return; // a second tap while the cue below is still playing
      cloneStarting.current = true;
      setClone('confirm'); // same step, but its 20 s expiry must not fire while this starts
      try {
        // Cut the consent notice. It plays in the app's ElevenLabs voice through the player, which
        // Speech.stop() alone doesn't touch, so it kept talking into the recording.
        player.pause();
        Speech.stop();
        const { granted } = await requestRecordingPermissionsAsync();
        if (!granted) {
          setClone('idle');
          tell('Microphone access is needed to record a voice.');
          return;
        }
        if (guideOnRef.current) toggleGuide();
        if (findOnRef.current) stopFind();
        // Without VoiceOver nothing said that recording had begun. Said before the microphone
        // opens, so the app's voice isn't in the sample. (VoiceOver users get the announcement below.)
        if (!screenReader.current && !handsFree) await speakPhrase(CLONE_RECORDING_CUE, true);
        try {
          // iOS only records when the audio session allows it; turned back off after the recording.
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorder.prepareToRecordAsync();
          recorder.record();
        } catch (e) {
          console.warn(e);
          setClone('idle');
          tell('Could not start recording.');
          return;
        }
        setClone('recording');
        await notify(Haptics.NotificationFeedbackType.Success);
        AccessibilityInfo.announceForAccessibility('Recording. Speak naturally. Double tap to stop.');
        cloneTimer.current = setTimeout(() => {
          if (cloneStepRef.current === 'recording') cloneTap();
        }, handsFree ? CLONE_HANDS_FREE_MS : CLONE_MAX_MS);
        setCloneMaxS((handsFree ? CLONE_HANDS_FREE_MS : CLONE_MAX_MS) / 1000);
      } finally {
        cloneStarting.current = false;
      }
      return;
    }
    // step === 'recording': stop and upload.
    setClone('uploading');
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (!recorder.uri) throw new Error('No recording');
      tell('Adding the voice, please wait.');
      const form = new FormData();
      form.append('audio', new File(recorder.uri));
      form.append('consent', 'true');
      const res = await fetch(`${API_URL}/voices/clone`, { method: 'POST', body: form, headers: HEADERS });
      if (res.status === 422) {
        // The backend explains why ElevenLabs refused this recording, in plain words.
        const { detail } = await res.json();
        throw new Error(String(detail), { cause: 'spoken' });
      }
      // 401/403: the server wants the app key (EXPO_PUBLIC_APP_KEY in app/.env) and didn't get it.
      if (res.status === 401 || res.status === 403) throw new Error(NEEDS_APP_KEY, { cause: 'spoken' });
      if (!res.ok) throw new Error(`Server ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const added: Voice = await res.json();
      // Listed even if ElevenLabs' own list hasn't caught up yet; otherwise the naming page never opens.
      await loadVoices().catch(() => {});
      setVoices((prev) => (prev.some((v) => v.id === added.id) ? prev : [added, ...prev]));
      chooseVoice(added);
      setNewVoiceId(added.id);
      setClone('idle');
      await notify(Haptics.NotificationFeedbackType.Success);
      tell(screenReader.current ? 'Voice added. Playing a sample. Then say or type a name for it.' : 'Voice added.');
      await sleep(1200);
      await playSample(added.id);
    } catch (e) {
      console.warn(e);
      setClone('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      await notify(Haptics.NotificationFeedbackType.Error);
      const spoken = e instanceof Error && e.cause === 'spoken' ? e.message : 'Could not add the voice. Try again.';
      tell(spoken);
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
    stopWalker(); // his voice and the sample never overlap
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
    downgradeStreak.current = 0;
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
  // quiet: Walker started it and has already said so in his own voice.
  function startFind(target: string, description: string | null = null, openVocab?: boolean, quiet = false) {
    setShowTargets(false);
    if (guideOnRef.current) toggleGuide();
    findTargetRef.current = target;
    findDescriptionRef.current = description;
    findOpenVocabRef.current = openVocab ?? (knownTargets.current.size > 0 && !knownTargets.current.has(target));
    setFindTarget(target);
    findOnRef.current = true;
    setFindOn(true);
    setArrived(null);
    situation.current = null;
    setFindInfo(null);
    buzz(Haptics.ImpactFeedbackStyle.Light);
    // Known targets by name; anything else ("exit sign") can't be on the /say list, so "it".
    if (!quiet) tell(findOpenVocabRef.current ? FINDING_IT : findingPhrase(target));
    quietUntil.current = Date.now() + 1800;
    targetHeadingRef.current = null;
    trackRef.current = null;
    findMisses.current = 0;
    findBlanks.current = 0;
    findPhaseRef.current = 'search';
    lastFoundAt.current = 0;
    lastSentence.current = null;
    centeredSince.current = null;
    lastDriftAt.current = 0;
    walkLevel.current = 0;
    movingSince.current = null;
    spinDeg.current = 0;
    spinFrom.current = null;
    exploreUntil.current = 0;
    saidStandStill.current = false;
    detourRef.current = null;
    dodgedRef.current = null;
    aheadWarned.current = null;
    pathRef.current = { said: null, due: false, streak: 0, seen: false };
    pathHold.current = null;
    tiltRef.current = null;
    wentOff.current = null;
    offCenter.current = false;
    linedUpAt.current = 0;
    startHeading();
    const gen = ++findGen.current;
    frameLoop(
      () => findOnRef.current && findGen.current === gen,
      '/find',
      (): Record<string, string> =>
        findDescriptionRef.current ? { target, description: findDescriptionRef.current } : { target },
      applyFind,
    );
    voiceLoop();
    pulseLoop();
    const open = findOpenVocabRef.current;
    fetchPhrase(open ? 'No match yet. Turn slowly.' : `No ${target} yet. Turn slowly.`)
      .then(() => fetchPhrase(LINED_UP_PHRASE))
      .then(() => fetchPhrase(HANDOFF_PHRASE))
      .then(() => fetchPhrase(arrivalPhrase(target, open)))
      .then(() => fetchPhrase(reachPhrase({ side: null, band: 'waist' })))
      .then(() => fetchPhrase(reachPhrase({ side: null, band: 'chest' })))
      .then(() => fetchPhrase(LOST_PHRASE))
      .then(() => fetchPhrase(STAND_STILL_PHRASE))
      .then(() => fetchPhrase(detourPhrase('right', 'left', false)))
      .then(() => fetchPhrase(detourPhrase('left', 'right', false)))
      .then(() => fetchPhrase(detourClearPhrase('left')))
      .then(() => fetchPhrase(detourClearPhrase('right')))
      .then(() => fetchPhrase(lowPhrase('ahead', 'left')))
      .then(() => fetchPhrase(lowPhrase('ahead', 'right')))
      .then(() => fetchPhrase(lowPhrase('ahead', null)))
      .then(() => fetchPhrase(classify(3, 'ahead', null, guideSettings()).text))
      .then(() => fetchPhrase(classify(2, 'ahead', null, guideSettings()).text))
      .then(() => fetchPhrase(tiltPhrase('down')))
      .then(() => fetchPhrase(tiltPhrase('up')))
      .then(() => fetchPhrase(offFramePhrase('down')))
      .then(() => fetchPhrase(offFramePhrase('up')));
  }

  // Search -> Approach: facing the target. Said once, with a double pulse.
  function handoff() {
    findPhaseRef.current = 'approach';
    centeredSince.current = null;
    detourRef.current = null;
    dodgedRef.current = null;
    aheadWarned.current = null;
    pathRef.current = { said: null, due: true, streak: 0, seen: false };
    pathHold.current = null;
    lastDriftAt.current = Date.now();
    interruptForStop({ key: 'handoff', text: HANDOFF_PHRASE, stop: true });
    situation.current = { key: 'handoff', text: HANDOFF_PHRASE, stop: false };
    buzz(Haptics.ImpactFeedbackStyle.Heavy);
    setTimeout(() => buzz(Haptics.ImpactFeedbackStyle.Heavy), 160);
  }

  // Approach -> Search: not seen for a while and out of view.
  function lost() {
    findPhaseRef.current = 'search';
    spinDeg.current = 0;
    spinFrom.current = null;
    exploreUntil.current = 0;
    targetHeadingRef.current = null;
    trackRef.current = null;
    lastFoundAt.current = 0;
    lastSentence.current = null;
    centeredSince.current = null;
    findBlanks.current = 0;
    saidStandStill.current = false;
    detourRef.current = null;
    dodgedRef.current = null;
    aheadWarned.current = null;
    pathRef.current = { said: null, due: false, streak: 0, seen: false };
    pathHold.current = null;
    tiltRef.current = null;
    wentOff.current = null;
    situation.current = { key: 'lost', text: LOST_PHRASE, stop: false };
  }

  // The last server sentence ("Door, turn a little left, about 2 meters.") with its direction replaced by
  // where the target is now, from the gyro. Keeps the server's exact distance wording, so the
  // result is still on the /say list.
  function driftSentence(off: number): string | null {
    const base = lastSentence.current;
    if (!base) return null;
    const p = parseFind(base);
    if (!p) return base;
    const a = Math.abs(off);
    const side = a <= FIND_AHEAD_DEG ? null : off > 0 ? 'right' : 'left';
    return findSentence({ ...p, side, small: a <= FIND_SMALL_TURN_DEG }, wording.current);
  }

  // Walker has the floor: he's listening, thinking or talking, or someone has started talking to him
  // hands-free. Find pauses completely meanwhile (no photos, voice or buzzing) and carries on after.
  function walkerBusy() {
    return walkerStateRef.current !== 'idle' || walkerHolds.current;
  }

  function setWalker(state: WalkerState) {
    walkerStateRef.current = state;
    setWalkerState(state);
  }

  // Walker: press and hold anywhere (or tap his button), say what you need ("find the little green
  // dragon", "start walking", "units feet"), and he answers in his own voice and does it. Again while
  // he listens stops early; while he talks, stops him. Safety speech always wins: he waits for it, and
  // stops listening if it starts.
  async function walkerTap() {
    const state = walkerStateRef.current;
    if (state === 'listening') {
      walkerDone.current = true;
      return;
    }
    if (state === 'talking') {
      stopWalker();
      return;
    }
    if (state === 'thinking') return;
    try {
      await walkerSession();
    } catch (e) {
      // Nothing above catches this (it's called from a press handler), so a failed microphone,
      // request or clip used to surface as an unhandled promise error and leave him stuck.
      console.warn(e);
      walkerHolds.current = false;
      await micIdle();
      setWalker('idle');
      notify(Haptics.NotificationFeedbackType.Error).catch(() => {});
      tell(LINES.cantHear);
    }
  }

  // Listens for one command and does it.
  async function walkerSession() {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      await walkerReply(LINES.mic);
      return;
    }
    setWalkerText(null);
    setWalker('listening'); // also makes the hands-free loop let go of the microphone
    walkerHolds.current = true;
    const heard = await walkerListen();
    walkerHolds.current = false;
    if (heard === 'interrupted') {
      setWalker('idle'); // safety speech started; it matters more than the command
      return;
    }
    if (!heard) {
      await walkerReply(LINES.cantHear);
      return;
    }
    await walkerRespond(heard);
  }

  // The audio mode after a recording: microphone off, playback on the speaker.
  function micIdle() {
    return setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }

  // Records one command and sends it to /transcribe. Null if that failed or nothing was said,
  // 'interrupted' if safety speech started while recording.
  async function walkerListen(): Promise<Heard | null | 'interrupted'> {
    try {
      walkerDone.current = false;
      await waitForQuiet(); // don't record the guide's own voice
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      await buzz(Haptics.ImpactFeedbackStyle.Medium);
      AccessibilityInfo.announceForAccessibility('Listening');
      const heard = await finishCommand(await listenUntilQuiet());
      return heard === 'silent' ? null : heard;
    } catch (e) {
      console.warn(e);
      await micIdle();
      notify(Haptics.NotificationFeedbackType.Error);
      return null;
    }
  }

  // Stops the command recording and sends it to /transcribe, unless nothing was said ('silent') or
  // safety speech cut in ('interrupted').
  async function finishCommand(r: { interrupted: boolean; spoke: boolean }): Promise<Heard | 'silent' | 'interrupted'> {
    await recorder.stop().catch(() => {});
    await micIdle();
    await buzz(Haptics.ImpactFeedbackStyle.Light);
    if (r.interrupted) return 'interrupted';
    if (!r.spoke || !recorder.uri) return 'silent';
    setWalker('thinking');
    return await transcribeClip(recorder.uri);
  }

  async function transcribeClip(uri: string): Promise<Heard> {
    const form = new FormData();
    form.append('audio', new File(uri));
    const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form, headers: HEADERS });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    return (await res.json()) as Heard;
  }

  // What he does with what was heard.
  async function walkerRespond(h: Heard) {
    const cmd = parseCommand(h.text, voices);
    if (cmd.action === 'wake') {
      await walkerReply(cmd.reply); // "Yeah? What do you need?"
      await walkerSession();
      return;
    }
    if (cmd.action === 'find' && !h.target) {
      await walkerReply(LINES.whatToFind);
      await walkerSession();
      return;
    }
    const reply =
      cmd.action !== 'find'
        ? cmd.reply
        : !h.open_vocab && h.target && knownTargets.current.has(h.target)
          ? findLine(h.target)
          : LINES.findIt;
    await walkerReply(reply);
    walkerDo(cmd, h);
  }

  // He says it (bubble and voice), then goes back to idle.
  async function walkerReply(text: string) {
    setWalkerText(text);
    setWalker('talking');
    await walkerSpeak(text);
    setWalker('idle');
  }

  // Waits (up to WALKER_WAIT_MS) until the guide, Find, or a describe answer has finished talking.
  async function waitForQuiet() {
    const start = Date.now();
    while ((speechBusy.current || describePlaying()) && Date.now() - start < WALKER_WAIT_MS) await sleep(100);
  }

  // Records until you've spoken and then paused, you tap again, or WALKER_MAX_MS. Levels are in dB
  // (about -160 to 0) and compared with the quietest moment so far, the room's own noise. Says whether
  // anyone spoke, and whether safety speech started meanwhile (the recording is then dropped).
  async function listenUntilQuiet(noSpeechMs = WALKER_NO_SPEECH_MS): Promise<{ interrupted: boolean; spoke: boolean }> {
    const start = Date.now();
    let floor = Infinity;
    let spoke = false;
    let quietSince: number | null = null;
    while (!walkerDone.current && Date.now() - start < WALKER_MAX_MS) {
      await sleep(100);
      if (speechBusy.current) return { interrupted: true, spoke };
      const level = recorder.getStatus().metering;
      if (level === undefined) continue;
      floor = Math.min(floor, level);
      if (level > floor + WALKER_SPEECH_DB) {
        spoke = true;
        quietSince = null;
      } else if (spoke && level < floor + WALKER_QUIET_DB) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince > WALKER_SILENCE_MS) return { interrupted: false, spoke };
      } else if (!spoke && Date.now() - start > noSpeechMs) {
        return { interrupted: false, spoke };
      }
    }
    return { interrupted: false, spoke };
  }

  // Walker says something in his own voice, never the user's chosen one, and resolves when he's done.
  // With VoiceOver on, VoiceOver says it instead, so the two never double up. He waits for the guide
  // or Find to finish first, and stops at once if a safety warning comes in.
  // Cuts Walker off mid-sentence (a voice sample is about to play, or setup moved on).
  function stopWalker() {
    walkerCancel.current = true;
    Speech.stop();
    if (walkerPlaying.current) player.pause();
  }

  async function walkerSpeak(text: string) {
    walkerCancel.current = false;
    if (screenReader.current) {
      AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: false });
      await sleep(Math.min(6000, 600 + text.length * 55)); // about how long VoiceOver takes
      return;
    }
    await waitForQuiet();
    const token = ++speechToken.current;
    speechBusy.current = true;
    const urgentBefore = situation.current?.key;
    const urgentNow = () => {
      const s = situation.current;
      return isUrgent(s) && s!.key !== urgentBefore;
    };
    try {
      const uri = prefsRef.current.speech ? await fetchPhrase(text) : null; // the chosen voice
      if (uri) {
        walkerPlaying.current = true;
        player.replace({ uri });
        for (let i = 0; i < 80 && !player.isLoaded; i++) await sleep(25);
        player.setPlaybackRate(1); // the speed setting is for the guide, not him
        player.play();
        for (let i = 0; i < 10 && !player.playing; i++) await sleep(50);
        for (let i = 0; i < 200 && player.playing && !walkerCancel.current; i++) {
          await sleep(100);
          if (urgentNow()) player.pause();
        }
        return;
      }
      let done = false;
      Speech.speak(text, {
        voice: walkerVoice.current,
        rate: WALKER_FALLBACK_RATE,
        pitch: WALKER_FALLBACK_PITCH,
        onDone: () => {
          done = true;
        },
        onStopped: () => {
          done = true;
        },
        onError: () => {
          done = true;
        },
      });
      for (let i = 0; i < 200 && !done && !walkerCancel.current; i++) {
        await sleep(100);
        if (urgentNow()) Speech.stop();
      }
    } finally {
      walkerPlaying.current = false;
      if (speechToken.current === token) {
        speechBusy.current = false;
        speakingStop.current = false;
      }
    }
  }

  // Walker's most likely first lines, in his voice, so his first answer isn't late.
  async function prefetchWalker() {
    for (const text of [LINES.welcome, LINES.introHowTo, LINES.yes, LINES.findIt, LINES.describe, LINES.stop, LINES.cantHear, LINES.unknown]) {
      await fetchPhrase(text);
    }
  }

  // Settings, hands free (say "settings"): Walker lists the sections, reads the one you pick with its
  // current values ("Haptics: on."), then listens for changes ("feet", "haptics off", "faster").
  // "Voice" opens the voice menu: every voice plays, then pick one by name or record a new one.
  // "Done" (or "back") goes back one level. Anything else is tried as another section, then as a
  // normal command ("find the door" closes Settings and does it), so nothing is a dead end.
  // Ends when Settings closes, or after three silent tries.
  async function settingsMenu() {
    const live = () => settingsOpen.current;
    let level: 'top' | Section | 'voices' = 'top';
    // Moves the screen with him: the voice page for the voices, otherwise Settings scrolled to the
    // section he's reading.
    const setLevel = (next: 'top' | Section | 'voices') => {
      level = next;
      showSettingsPage(next === 'voices' ? 'voice' : 'main');
      setSettingsFocus(next === 'top' || next === 'voices' ? null : next);
    };
    // A tap moved the screen (onSettingsPage): go where it went.
    const followTap = async () => {
      const jump = menuJump.current;
      menuJump.current = null;
      if (jump === 'voices') {
        await enterVoices();
        return true;
      }
      if (jump === 'sound') {
        setLevel('sound');
        lines = readSection('sound');
        return true;
      }
      return false;
    };
    let lines: string[] = [MENU.sections];
    let silent = 0;
    // Default voices, then custom ones (each plays and says its own name), as on the screen.
    const enterVoices = async () => {
      setLevel('voices');
      const defaults = voicesRef.current.filter((v) => !v.custom);
      const own = voicesRef.current.filter((v) => v.custom);
      await walkerReply(MENU.defaultVoices);
      for (const v of defaults) {
        if (!live() || menuJump.current) return;
        await pickSampleAndWait(v.id);
      }
      if (!live() || menuJump.current) return;
      await walkerReply(MENU.customVoices);
      if (own.length === 0) await walkerReply(MENU.noCustom);
      for (const v of own) {
        if (!live() || menuJump.current) return;
        await pickSampleAndWait(v.id);
      }
      lines = [MENU.voiceAsk];
    };
    menuActive.current = true;
    menuJump.current = null;
    try {
      while (live() && silent < 3) {
        if (await followTap()) continue;
        for (const line of lines) {
          if (!live() || menuJump.current) break;
          await walkerReply(line);
        }
        if (menuJump.current) continue;
        const heard = live() ? await walkerHear() : null;
        if (!live()) return;
        if (menuJump.current) continue;
        if (!heard) {
          silent += 1;
          lines = [level === 'top' ? MENU.sections : level === 'voices' ? MENU.voiceAsk : askFor(level)];
          continue;
        }
        silent = 0;
        if (level === 'top') {
          const picked = sectionFromSpeech(heard.text);
          if (picked === 'done' || picked === 'back') return closeMenu();
          if (picked) {
            setLevel(picked);
            // The values themselves say what can change ("Haptics: on."), so he just listens; the
            // options are read out only if nothing is said. Help has no values, so it keeps its prompt.
            lines = picked === 'help' ? [...readSection(picked), askFor(picked)] : readSection(picked);
            continue;
          }
          if (await otherCommand(heard)) return;
          lines = [LINES.didntCatch];
          continue;
        }
        const change = settingFromSpeech(heard.text, voicesRef.current);
        if (change?.kind === 'done' || change?.kind === 'back') {
          if (level === 'voices') {
            setLevel('sound');
            lines = readSection('sound');
          } else {
            setLevel('top');
            lines = [MENU.sections];
          }
          continue;
        }
        if (change?.kind === 'replay') {
          replaySetup();
          return;
        }
        if (change?.kind === 'voices' || (change?.kind === 'list' && level === 'voices')) {
          await enterVoices();
          continue;
        }
        if (change?.kind === 'rename') {
          setLevel('voices');
          lines = [await renameHandsFree(change.voice)];
          continue;
        }
        if (change?.kind === 'record') {
          const name = await recordVoiceHandsFree();
          setLevel('voices');
          lines = name ? [voiceLine(name), MENU.voiceAsk] : [MENU.voiceAsk];
          continue;
        }
        if (change && change.kind !== 'list') {
          lines = [await applyChange(change)]; // "Haptics: off." then listening again
          continue;
        }
        // Not a setting here: another section ("distance"), or a normal command.
        const other = sectionFromSpeech(heard.text);
        if (other && other !== 'done' && other !== 'back') {
          setLevel(other);
          lines = other === 'help' ? [...readSection(other), askFor(other)] : readSection(other);
          continue;
        }
        if (await otherCommand(heard)) return;
        lines = [LINES.didntCatch];
      }
    } finally {
      menuActive.current = false;
    }
  }

  // A normal Walker command said inside Settings ("find the door", "what's in front of me"): closes
  // Settings and does it. False if it wasn't one.
  async function otherCommand(heard: Heard): Promise<boolean> {
    const cmd = parseCommand(heard.text, voicesRef.current);
    if (cmd.action === 'none' || cmd.action === 'wake' || cmd.action === 'settings') return false;
    closeSettings();
    await walkerRespond(heard);
    return true;
  }

  // Plays a voice's sample ("Hi, I'm Sarah…") without choosing it, and waits until it's done.
  async function pickSampleAndWait(id: string) {
    await playSample(id);
    for (let i = 0; i < 20 && !player.playing; i++) await sleep(50);
    for (let i = 0; i < 100 && player.playing; i++) await sleep(100);
  }

  // Renames a custom voice by voice: which one (if it wasn't named already), then the new name.
  // Default voices can't be renamed. Returns what Walker says to confirm.
  async function renameHandsFree(named: Voice | null): Promise<string> {
    let target = named;
    if (!target) {
      await walkerReply(MENU.renameWhich);
      const which = await walkerHear();
      const change = which ? settingFromSpeech(`use ${which.text}`, voicesRef.current) : null;
      target = change?.kind === 'voice' ? (change.voice as Voice) : null;
    }
    if (!target) return LINES.didntCatch;
    if (!target.custom) return MENU.onlyCustom;
    await walkerReply(MENU.renameAsk);
    const said = await walkerHear();
    const name = said ? cleanName(said.text) : '';
    if (!name) return LINES.didntCatch;
    await renameVoice(target.id, name);
    return voiceLine(name);
  }

  // Records a trusted voice by voice: consent first ("Say yes to start"), then the usual recording
  // (its own cue, 30 seconds, stops by itself), and a spoken name. The new voice's name, or null.
  async function recordVoiceHandsFree(): Promise<string | null> {
    await walkerReply(MENU.recordConsent);
    const yes = await walkerHear();
    if (!yes || !isYes(yes.text)) {
      await walkerReply(MENU.recordSkipped);
      return null;
    }
    const before = voiceIdRef.current;
    await walkerReply(MENU.recordStart);
    setClone('confirm');
    await cloneTap(true); // records 15 seconds, stops by itself, then adds the voice and plays it
    for (let i = 0; i < 1200 && cloneStepRef.current !== 'idle'; i++) await sleep(100); // up to 2 minutes
    const added = voiceIdRef.current;
    if (!added || added === before) return null; // it failed, and said why
    await sleep(1500); // the "Voice added." sample starts a moment later
    for (let i = 0; i < 100 && player.playing; i++) await sleep(100);
    await walkerReply(MENU.nameAsk);
    const said = await walkerHear();
    const name = said ? cleanName(said.text) : '';
    if (!name) return voicesRef.current.find((v) => v.id === added)?.name ?? null;
    await renameVoice(added, name);
    return name;
  }

  async function closeMenu() {
    await walkerReply(MENU.closing);
    closeSettings();
  }

  // One spoken answer: shows "Listening…", records until a pause, and sends it to /transcribe.
  async function walkerHear() {
    setWalkerText(null);
    setWalker('listening');
    walkerHolds.current = true;
    const heard = await walkerListen();
    walkerHolds.current = false;
    setWalker('idle');
    return heard && heard !== 'interrupted' ? heard : null;
  }

  function askFor(section: Section) {
    return section === 'distance' ? MENU.distanceAsk : section === 'sound' ? MENU.soundAsk : MENU.helpAsk;
  }

  // The section's settings with their current values, as Walker reads them.
  function readSection(section: Section): string[] {
    const p = prefsRef.current;
    if (section === 'distance') return [unitsLine(p.units), warnLine(p.warning)];
    if (section === 'help') return [MENU.helpRead];
    const name = voicesRef.current.find((v) => v.id === voiceIdRef.current)?.name ?? 'Walker';
    return [onOffLine('Guidance voice', p.speech), onOffLine('Haptics', p.haptics), voiceLine(name), speedLine(p.speed)];
  }

  // Makes the change and returns what Walker says to confirm it.
  async function applyChange(change: SettingChange): Promise<string> {
    switch (change.kind) {
      case 'units':
        updatePrefs({ units: change.units });
        return unitsLine(change.units);
      case 'warning':
        updatePrefs({ warning: change.warning });
        return warnLine(change.warning);
      case 'haptics':
        updatePrefs({ haptics: change.on });
        return onOffLine('Haptics', change.on);
      case 'speech':
        updatePrefs({ speech: change.on });
        return onOffLine('Guidance voice', change.on);
      case 'speed': {
        const speed = Math.max(0, Math.min(SPEEDS.length - 1, prefsRef.current.speed + change.delta));
        updatePrefs({ speed });
        return speedLine(speed);
      }
      case 'voice':
        await pickVoice(change.voice); // plays it ("Hi, I'm George.")
        for (let i = 0; i < 20 && !player.playing; i++) await sleep(50);
        for (let i = 0; i < 100 && player.playing; i++) await sleep(100);
        return voiceLine(change.voice.name);
      default:
        return LINES.didntCatch;
    }
  }

  // What Walker was asked to do. He has already said it, so nothing here announces it again.
  function walkerDo(cmd: ReturnType<typeof parseCommand>, heard: { target: string | null; description: string | null; open_vocab?: boolean }) {
    switch (cmd.action) {
      case 'find':
        if (!heard.target) break;
        if (findOnRef.current) stopFind(false); // already finding something else: switch
        startFind(heard.target, heard.description, heard.open_vocab ?? false, true);
        break;
      case 'describe':
        if (findOnRef.current) stopFind(false);
        scan();
        break;
      case 'repeat':
        repeatLast();
        break;
      case 'settings':
        if (findOnRef.current) stopFind(false);
        openSettings();
        settingsMenu();
        break;
      case 'stop':
        if (findOnRef.current) stopFind(false);
        if (guideOnRef.current) toggleGuide();
        break;
      case 'units':
        updatePrefs({ units: cmd.units });
        break;
      case 'warning':
        updatePrefs({ warning: cmd.warning });
        break;
      case 'voice':
        pickVoice(cmd.voice); // picks it and plays its sample, so you hear the new guide voice
        break;
    }
  }

  // Tap, say "find the red bench", done. Records until you stop talking (listenUntilQuiet, the same
  // as Walker: about a second of quiet ends it, so a slow speaker isn't cut off and a quick one
  // doesn't wait), sends it to /transcribe, and starts Find with what came back. Works with
  // VoiceOver because nothing has to be held.
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
      walkerDone.current = false; // listenUntilQuiet also stops on Walker's tap-again flag
      const heard = await listenUntilQuiet();
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      if (heard.interrupted || !heard.spoke) {
        // Nothing said, or a safety warning started over it: don't send an empty or mixed clip.
        setSpeakState('idle');
        tell("I didn't catch what to find. Try again, like: find the red chair.");
        return;
      }
      if (!recorder.uri) throw new Error('No recording');
      setSpeakState('working');
      const form = new FormData();
      form.append('audio', new File(recorder.uri));
      const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data: { text: string; target: string | null; description: string | null; open_vocab?: boolean } =
        await res.json();
      setSpeakState('idle');
      if (!data.text) {
        tell("I didn't catch that. Try again.");
        return;
      }
      // The server sends no target when it heard something that doesn't sound like a thing to find
      // (someone nearby talking, say). Ask again rather than search for the wrong thing.
      if (!data.target) {
        tell("I didn't catch what to find. Try again, like: find the red chair.");
        return;
      }
      startFind(data.target, data.description, data.open_vocab ?? false);
    } catch (e) {
      console.warn(e);
      setSpeakState('idle');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not understand. Try again, or type it.');
    }
  }

  // Gyro heading while Find is on. Degrees, clockwise, relative (no compass needed).
  async function startHeading() {
    headingRef.current = null;
    yawFix.current = 0;
    try {
      if (!(await DeviceMotion.isAvailableAsync())) return;
      // 20 readings a second; FindScreen glides the box between them so it moves smoothly.
      DeviceMotion.setUpdateInterval(50);
      motionSub.current = DeviceMotion.addListener((m) => {
        if (m.acceleration) {
          const g = Math.hypot(m.acceleration.x, m.acceleration.y, m.acceleration.z);
          walkLevel.current = walkLevel.current * 0.85 + g * 0.15;
          if (walkLevel.current > WALK_LEVEL) movingSince.current ??= Date.now();
          else movingSince.current = null;
        }
        if (m.rotation) {
          // On iOS alpha, beta, gamma are yaw (about vertical), pitch and roll, applied in that
          // order. The camera looks out of the back of the phone; its compass direction is yaw
          // plus this term. Pointing almost straight down it has no direction, so the last one holds.
          if (Platform.OS === 'ios') {
            // Upright it's 0; flat on a table, camera down, it's -90.
            const up = -Math.cos(m.rotation.beta) * Math.cos(m.rotation.gamma);
            elevationRef.current = (Math.asin(Math.max(-1, Math.min(1, up))) * 180) / Math.PI;
          }
          if (HEADING_FROM_CAMERA && Platform.OS === 'ios') {
            const side = Math.sin(m.rotation.gamma);
            const forward = Math.sin(m.rotation.beta) * Math.cos(m.rotation.gamma);
            if (Math.hypot(side, forward) > 0.3) yawFix.current = Math.atan2(side, forward);
          }
          const raw = -YAW_SIGN * ((m.rotation.alpha + yawFix.current) * 180) / Math.PI;
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
    elevationRef.current = null;
    setHeadingNow(null);
    targetHeadingRef.current = null;
    trackRef.current = null;
  }

  // How far to turn to face the remembered target, in degrees (right is positive), or null.
  function targetOffset(): number | null {
    if (headingRef.current === null || targetHeadingRef.current === null) return null;
    return wrapDeg(targetHeadingRef.current - headingRef.current);
  }

  // Runs several times a second until Find stops. Haptics from the gyro (stronger and faster as
  // you turn toward the target, double pulse when facing it), and the phase rules that need to
  // react between server answers: hand-off, "stand still", drift, and lost.
  async function pulseLoop() {
    const gen = ++pulseGen.current;
    while (findOnRef.current && pulseGen.current === gen) {
      if (walkerBusy()) {
        await sleep(200); // no buzzing while Walker listens or talks
        continue;
      }
      const off = targetOffset();
      const now = Date.now();
      // Lined up (see LINED_UP_PHRASE). Said straight away, not through the voice loop: it is only
      // worth saying this instant. It cuts a turn instruction, and stays silent rather than talk over
      // anything else (a Stop, a detour step, the tilt prompt).
      if (off !== null && !detourRef.current) {
        const a = Math.abs(off);
        if (a > FIND_AHEAD_DEG) offCenter.current = true;
        else if (a <= FIND_CENTERED_DEG && offCenter.current && now - linedUpAt.current > LINED_UP_EVERY_MS) {
          offCenter.current = false;
          const saying = speakingText.current;
          if (!speechBusy.current || (saying !== null && TURN_WORDS.test(saying))) {
            linedUpAt.current = now;
            if (speechBusy.current) {
              speechCut.current += 1;
              player.pause();
              Speech.stop();
            }
            speakPhrase(LINED_UP_PHRASE, false);
          }
        }
      }
      if (findPhaseRef.current === 'search') {
        // How far they've turned without a sighting. Seen recently (or no gyro): start counting again.
        const h = headingRef.current;
        if (h === null || now - lastFoundAt.current <= HANDOFF_SEEN_WITHIN_MS) {
          spinDeg.current = 0;
          spinFrom.current = h;
          exploreUntil.current = 0; // it showed up: back to normal search
        } else {
          const d = spinFrom.current === null ? 0 : Math.abs(wrapDeg(h - spinFrom.current));
          if (d >= SPIN_NOISE_DEG) {
            spinDeg.current += d;
            spinFrom.current = h;
          } else if (spinFrom.current === null) {
            spinFrom.current = h;
          }
        }
        if (exploreUntil.current) {
          if (now > exploreUntil.current) {
            exploreUntil.current = 0;
            spinDeg.current = 0;
            spinFrom.current = h;
            situation.current = { key: `searchagain:${now}`, text: SEARCH_AGAIN_PHRASE, stop: false };
          }
        } else if (spinDeg.current >= FULL_TURN_DEG) {
          // A full circle and nothing: it isn't visible from here. A few steps, then look again.
          exploreUntil.current = now + EXPLORE_MS;
          spinDeg.current = 0;
          situation.current = { key: `explore:${now}`, text: NOT_IN_SIGHT_PHRASE, stop: false };
        }
        if (
          !exploreUntil.current &&
          !saidStandStill.current && movingSince.current !== null && now - movingSince.current > WALK_SUSTAIN_MS
        ) {
          saidStandStill.current = true;
          situation.current = { key: 'standstill', text: STAND_STILL_PHRASE, stop: false };
        }
        const seenRecently = now - lastFoundAt.current <= HANDOFF_SEEN_WITHIN_MS;
        if (off !== null && seenRecently && Math.abs(off) <= FIND_AHEAD_DEG) {
          centeredSince.current ??= now;
          // (Not on top of "Straight ahead."; it starts as soon as that has been said.)
          if (now - centeredSince.current >= HANDOFF_CENTERED_MS && speakingText.current !== LINED_UP_PHRASE) handoff();
        } else {
          centeredSince.current = null;
        }
      } else {
        if (now - lastFoundAt.current > LOST_AFTER_MS && (off === null || Math.abs(off) > CAMERA_HALF_FOV_DEG)) {
          lost();
        } else if (detourRef.current) {
          // Stepping around something: the step instruction is the only voice, and no pulses.
          await sleep(300);
          continue;
        } else if (
          off !== null && Math.abs(off) > FIND_AHEAD_DEG && now - lastDriftAt.current > APPROACH_DRIFT_MS && !aheadHoldLive(now) && !pathHoldLive(now) && !framingLive()
        ) {
          // Drifted off the target: say where it is now, from the gyro, without waiting for a frame.
          const text = driftSentence(off);
          if (text && !(situation.current?.stop)) {
            lastDriftAt.current = now;
            situation.current = { key: `drift:${off > 0 ? 'right' : 'left'}:${now}`, text, stop: false };
          }
        }
      }
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
  async function arrive(target: string, reach: Reach) {
    const openVocab = findOpenVocabRef.current;
    stopFind(false);
    setArrived(target);
    notify(Haptics.NotificationFeedbackType.Success);
    arriveSound.seekTo(0).then(() => arriveSound.play()).catch(() => {});
    // Where to reach, if this server has the line; otherwise the older one, so the moment that
    // matters most is never left to the phone's own voice.
    const text = reachPhrase(reach);
    const [uri] = await Promise.all([fetchPhrase(text), sleep(450)]);
    await speakPhrase(uri || !prefsRef.current.speech ? text : arrivalPhrase(target, openVocab), true);
  }

  function stopFind(announce = true) {
    findOnRef.current = false;
    setFindOn(false);
    findPhaseRef.current = 'search';
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
  // voiceId: the user's chosen voice unless given (Walker passes his own).
  async function fetchPhrase(text: string, voiceId: string | null = voiceIdRef.current): Promise<string | null> {
    const key = `${voiceId ?? ''}|${text}`;
    const cached = phraseFiles.current.get(key);
    if (cached) return cached;
    try {
      const voice = voiceId ? `&voice_id=${encodeURIComponent(voiceId)}` : '';
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
    const token = ++speechToken.current;
    speechBusy.current = true;
    speakingStop.current = stop;
    speakingText.current = text;
    try {
      const uri = prefsRef.current.speech ? await fetchPhrase(text) : null;
      if (uri) {
        const cut = speechCut.current;
        await playUri(uri);
        // Wait for the clip to end. If the player is slow to report that it started, this used to
        // give up after half a second, and the next phrase then cut this one off mid-word. Now the
        // clip's own length is the fallback clock.
        const started = Date.now();
        const lengthMs = player.duration > 0 ? (player.duration * 1000) / SPEEDS[prefsRef.current.speed].rate : 0;
        let seenPlaying = false;
        for (;;) {
          await sleep(50);
          const elapsed = Date.now() - started;
          if (speechToken.current !== token || speechCut.current !== cut) break; // cut on purpose
          if (player.playing) seenPlaying = true;
          else if (seenPlaying) break; // finished
          else if (elapsed > Math.max(600, lengthMs + 300)) break; // never said it was playing: trust the clock
          if (elapsed > 12000) break;
        }
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
      if (speechToken.current === token) {
        speechBusy.current = false;
        speakingStop.current = false;
        speakingText.current = null;
      }
    }
  }

  // Cuts whatever the voice is saying so a "stop" can be spoken right away.
  function interruptForStop(next: Situation) {
    if (next.stop && speechBusy.current && !speakingStop.current) {
      speechCut.current += 1;
      player.pause();
      Speech.stop();
    }
  }

  function applyGuide(data: SonarResult, _heading: number | null) {
    if (data.clear || data.distance_m === null) {
      recentDirections.current = [];
      downgradeStreak.current = 0;
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
    // The current warning holds until the user has dealt with it. Anything as urgent or more
    // (and the same phrase, so distance updates keep flowing) replaces it at once; anything
    // less urgent, or the same urgency on another side, needs DOWNGRADE_STREAK frames.
    const held = situation.current;
    const heldRank = held && held.key !== OPEN.key ? urgency(held) : 0;
    const nextRank = urgency(next);
    const sameThing = !held || held.key === next.key || held.key === OPEN.key;
    const bump = nextRank > heldRank || (nextRank === heldRank && next.key.startsWith('far'));
    if (!sameThing && !bump) {
      downgradeStreak.current += 1;
      if (downgradeStreak.current < DOWNGRADE_STREAK) {
        setGuideDistance(data.distance_m);
        setGuideSide(side);
        return;
      }
    }
    downgradeStreak.current = 0;
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
    if (walkerBusy()) return; // a frame from before Walker was called; Find is paused
    const target = findTargetRef.current ?? data.target;
    const phase = findPhaseRef.current;
    const serverFound = data.found; // before the tracker fills in a locked target below
    findBlanks.current = data.found ? 0 : findBlanks.current + 1;
    // The tracker follows one object across answers (tracker.ts); older servers send no candidates.
    const candidates =
      data.candidates ??
      (data.found && data.box && data.bearing_deg !== null
        ? [{ box: data.box, score: data.match_score ?? 1, bearing_deg: data.bearing_deg, distance_m: data.distance_m }]
        : []);
    const wasLocked = trackRef.current?.locked ?? false;
    trackRef.current = trackUpdate(trackRef.current, candidates, headingAtCapture, Date.now());
    if (!wasLocked && trackRef.current?.locked) {
      // Two confident sightings in a row: it's the object. Success buzz plus the lock chime, once.
      // Guidance toward it can key off trackRef.current.locked.
      notify(Haptics.NotificationFeedbackType.Success);
      lockSound.seekTo(0).then(() => lockSound.play()).catch(() => {});
    }
    // Up close the depth model overstates the distance (it read 2 m with the object at the lens).
    // By then the tracker has learned the object's real size and reads the distance off its box
    // (track.near). When it has one for this frame's object, that replaces the server's number in
    // the sentence, the arrival check, and the "is that obstacle just the target" check below.
    const near = trackRef.current?.matched === candidates[0] ? (trackRef.current?.near ?? null) : null;
    if (data.found && near !== null) {
      data = { ...data, distance_m: near, sentence: withHowFar(data.sentence, near, guideSettings().units ?? 'meters', wording.current) };
    }
    if (data.found) wording.current = wordingOf(data.sentence) ?? wording.current;
    // Up and down (see TILT_START). From the box actually seen in this frame.
    const seen = data.found ? (trackRef.current?.matched?.box ?? data.box) : null;
    if (seen) {
      const cy = seen[1] + seen[3] / 2;
      const was = tiltRef.current;
      tiltRef.current =
        cy > (was === 'down' ? TILT_STOP : TILT_START) ? 'down' : cy < 1 - (was === 'up' ? TILT_STOP : TILT_START) ? 'up' : null;
      wentOff.current = tiltRef.current ? { dir: tiltRef.current, at: Date.now() } : null;
    }
    // Not in the last couple of answers, right after sitting at the bottom (or top) of the picture:
    // it left that way. The remembered direction is still good, so this is not a miss or a loss.
    const offFrame =
      !data.found && findBlanks.current >= OFF_FRAME_BLANKS && wentOff.current && Date.now() - wentOff.current.at < OFF_FRAME_MEMORY_MS
        ? wentOff.current.dir
        : null;
    // Once locked, the voice follows the track, not the frame. The open-vocabulary detector's
    // score for a small or oddly worded target wanders in and out of "no match" from frame to
    // frame, which used to say "No match yet. Turn slowly." right after the lock chime. A locked
    // track still in view counts as a sighting at its bearing and blended distance.
    const track = trackRef.current;
    const view =
      !data.found && !offFrame && track?.locked ? trackView(track, headingAtCapture ?? headingRef.current, Date.now()) : null;
    if (view?.box && track) {
      const bearing = view.bearing_deg;
      data = {
        ...data,
        found: true,
        bearing_deg: bearing,
        distance_m: track.distance,
        centered: Math.abs(bearing) <= FIND_CENTERED_DEG,
        box: view.box,
        sentence: driftSentence(bearing) ?? lastSentence.current ?? data.sentence,
      };
    }
    if (data.found && data.bearing_deg !== null) {
      lastFoundAt.current = Date.now();
      lastSentence.current = data.sentence;
      // Remember which way the phone pointed, even if an obstacle takes the sentence below. With a
      // gyro, that's the tracked object, so haptics and drift point where the box is drawn.
      if (headingAtCapture !== null) {
        targetHeadingRef.current = trackRef.current?.world ?? wrapDeg(headingAtCapture + data.bearing_deg);
      }
    }
    // Obstacles only matter in Approach: in Search you're standing still and turning, and the
    // warnings were noise. Something close (or a stop) starts a detour: step sideways, keep the
    // phone on the target, and turn back once the obstacle reads clear for a couple of answers.
    // Only what's clearly nearer than the target can be in the way (a wall beside it isn't). The
    // server leaves the rest out when it detected the target this frame; when only the tracker has
    // it, the same check here against the tracked distance (the server's depth, so the same scale).
    const trackedAt = !serverFound && data.found ? data.distance_m : null;
    const pastTarget = (d: number | null) => trackedAt !== null && d !== null && d >= trackedAt - FIND_SELF_M;
    // Just stepped past something: while it's still beside you (wholly on that half), it isn't new.
    const dodged = dodgedRef.current && Date.now() < dodgedRef.current.until ? dodgedRef.current.side : null;
    const besideDodged = (box: [number, number, number, number] | null | undefined) =>
      !!box && (dodged === 'right' ? box[0] >= 0.5 : dodged === 'left' ? box[0] + box[2] <= 0.5 : false);
    const o = pastTarget(data.obstacle.distance_m) || besideDodged(data.obstacle.box)
      ? { ...data.obstacle, clear: true, distance_m: null, direction: null, open: null, box: null }
      : data.obstacle;
    // A low obstacle near enough to act on (see LOW_DETOUR_M), unless it's the target itself.
    const low =
      o.low &&
      (o.low.edge || o.low.distance_m <= LOW_DETOUR_M * WARNING_SCALE[guideSettings().warning ?? 'normal']) &&
      !pastTarget(o.low.distance_m) &&
      !besideDodged(o.low.box) &&
      !(!serverFound && data.box && insideFraction(o.low.box, data.box) >= LOW_IN_TARGET)
        ? o.low
        : null;
    // Exception: the few steps after "Not in sight from here". They're walking, so warn about what's
    // close (no detour: there's no target to turn back to), and don't repeat "Turn slowly".
    if (phase === 'search' && exploreUntil.current && !data.found) {
      const r = !o.clear && o.distance_m !== null
        ? classify(o.distance_m, o.direction ?? 'ahead', o.open ?? null, guideSettings())
        : null;
      if (r && (r.stop || r.key.startsWith('close'))) {
        if (r.stop) {
          interruptForStop(r);
          buzz(Haptics.ImpactFeedbackStyle.Heavy);
        }
        situation.current = r;
      } else if (low) {
        const key = `close:low:${low.direction}`;
        if (situation.current?.key !== key) buzz(Haptics.ImpactFeedbackStyle.Heavy);
        situation.current = { key, text: lowPhrase(low.direction, null), stop: false };
      }
      setFindInfo(data);
      return;
    }
    // Approach only: in Search the phone is swinging round, and a wall 3 m ahead would be
    // announced mid-turn (movingSince trips on the swing, not just on walking).
    // The server already drops an obstacle that is the target itself, by comparing depths, which
    // fails for the same reason up close ("Stop" with the thing you asked for in front of you).
    // With the corrected distance: nothing nearer than the target, in its direction, is in the way.
    const isTarget =
      near !== null &&
      o.distance_m !== null &&
      (o.direction ?? 'ahead') === data.direction &&
      near <= o.distance_m + FIND_SELF_M;
    const reading =
      phase === 'approach' && !o.clear && o.distance_m !== null && !isTarget
        ? classify(o.distance_m, o.direction ?? 'ahead', o.open ?? null, guideSettings())
        : null;
    const close = phase === 'approach' && reading && (reading.stop || reading.key.startsWith('close')) ? reading : null;
    // A low obstacle starts or keeps a detour too, said as "Something low ..." unless something else
    // is nearer or it's a Stop.
    const lowDanger =
      phase === 'approach' && low && !close?.stop && (!close || low.distance_m <= (o.distance_m ?? Infinity)) ? low : null;
    const danger: Situation | null = lowDanger
      ? { key: `close:low:${lowDanger.direction}`, text: lowPhrase(lowDanger.direction, null), stop: false }
      : close;
    const now = Date.now();
    const detour = detourRef.current;
    if (phase === 'approach' && low && detour) detour.lowSeenAt = now;
    // Passed it (see DODGE_SHIFT): say to turn back toward the target, once, and move on.
    const passed = (d: Detour & { side: 'left' | 'right' }) => {
      detourRef.current = null;
      pathRef.current.due = true; // check the way again once lined back up
      dodgedRef.current = { side: d.side === 'left' ? 'right' : 'left', until: now + DODGE_IGNORE_MS };
      situation.current = { key: `detour:clear:${now}`, text: detourClearPhrase(d.side), stop: false };
      lastDriftAt.current = now; // let "Clear" finish before the drift sentence takes over
      setFindInfo(data);
    };
    const dangerBox = lowDanger ? lowDanger.box : (o.box ?? null);
    const dangerX = dangerBox ? dangerBox[0] + dangerBox[2] / 2 : null;
    if (danger && detour?.side && dangerBox && dangerX !== null) {
      detour.startX ??= dangerX;
      detour.startHeading ??= headingAtCapture;
      detour.lastBox = dangerBox;
      // Turning the phone left also slides things right; take that part out (the picture is about
      // 2 * CAMERA_HALF_FOV_DEG wide), so only the step counts.
      const turned =
        detour.startHeading !== null && headingAtCapture !== null
          ? wrapDeg(detour.startHeading - headingAtCapture) / (2 * CAMERA_HALF_FOV_DEG)
          : 0;
      const shift = dangerX - detour.startX - turned; // right is positive
      const slid =
        detour.side === 'left'
          ? dangerBox[0] >= 0.5 && shift >= DODGE_SHIFT
          : dangerBox[0] + dangerBox[2] <= 0.5 && -shift >= DODGE_SHIFT;
      if (slid && !danger.stop) {
        passed({ ...detour, side: detour.side });
        return;
      }
    }
    if (danger) {
      const obstacleSide: Side = lowDanger ? lowDanger.direction : (o.direction ?? 'ahead');
      // Only say which way to step when the server confirmed that side is open (nothing within the
      // warning distance). Otherwise just warn, and after DETOUR_STUCK_MS say to back up, which
      // retraces ground the user just walked.
      const open = lowDanger ? lowDanger.open : (o.open ?? null);
      const say = (side: 'left' | 'right' | null) =>
        side
          ? {
              key: `detour:${side}:${danger.stop}:${lowDanger ? 'low' : ''}`,
              text: lowDanger ? lowPhrase(obstacleSide, side) : detourPhrase(obstacleSide, side, danger.stop),
              stop: danger.stop,
            }
          : { ...danger, key: `detour:hold:${danger.key}` };
      if (!detour || (detour.side === null && open)) {
        // New detour, or a held one that now has a confirmed open side to step to.
        const next = say(open);
        detourRef.current = {
          side: open,
          startedAt: detour?.startedAt ?? now,
          clearFrames: 0,
          lowSeenAt: low ? now : (detour?.lowSeenAt ?? 0),
          startX: dangerX,
          startHeading: headingAtCapture,
          lastBox: dangerBox,
          said: next,
        };
        if (danger.stop) interruptForStop(next);
        situation.current = next;
        buzz(Haptics.ImpactFeedbackStyle.Heavy);
      } else {
        detour.clearFrames = 0;
        if (dangerBox) detour.lastBox = dangerBox;
        if (now - detour.startedAt > DETOUR_STUCK_MS) {
          // Stepping didn't help (or they didn't step): back up and try again from scratch.
          detour.startedAt = now;
          situation.current = { key: `detour:stuck:${now}`, text: DETOUR_STUCK_PHRASE, stop: false };
        } else {
          // Same words as before unless it became a Stop: "Something low ahead" turning into "...on
          // your right" as they step is progress, and new words would be said again at once.
          const next = detour.said && detour.said.stop === danger.stop ? detour.said : say(detour.side);
          detour.said = next;
          if (danger.stop && !situation.current?.stop) interruptForStop(next);
          situation.current = next;
        }
      }
      setFindInfo(data);
      return;
    }
    if (detour) {
      // Gone out the side it was sliding toward (last seen past the middle and touching that edge of
      // the lane), not under the bottom: passed, no need to wait.
      const b = detour.lastBox;
      const outSide =
        b !== null &&
        (detour.side === 'left'
          ? b[0] + b[2] / 2 >= 0.5 + DODGE_EXIT_X && b[0] + b[2] >= LANE_RIGHT - LANE_EDGE_SLACK
          : b[0] + b[2] / 2 <= 0.5 - DODGE_EXIT_X && b[0] <= LANE_LEFT + LANE_EDGE_SLACK);
      if (detour.side && outSide) {
        passed({ ...detour, side: detour.side });
        return;
      }
      detour.clearFrames += 1;
      // A low obstacle that dropped out of the bottom of the picture still counts for LOW_PASS_MS.
      if (detour.clearFrames >= DETOUR_CLEAR_FRAMES && now - detour.lowSeenAt >= LOW_PASS_MS) {
        detourRef.current = null;
        pathRef.current.due = true; // check the way again once lined back up
        if (detour.side) {
          situation.current = { key: `detour:clear:${now}`, text: detourClearPhrase(detour.side), stop: false };
          lastDriftAt.current = now; // let "Clear" finish before the drift sentence takes over
        }
        // No side: they only stopped, so the normal approach (and drift) simply resumes.
      }
      // One clear frame isn't enough to call it; keep the step instruction until then.
      setFindInfo(data);
      return;
    }
    // Something further out straight ahead ("Something ahead, about 3 meters."): said once per
    // distance step and held long enough to be spoken; then the target guidance carries on.
    // Only until the server sends the straight-line check (PATH_CHANGE_FRAMES), which replaces it.
    if (phase === 'approach' && serverFound && data.path) pathRef.current.seen = true;
    if (reading && reading.key.startsWith('far:ahead') && !pathRef.current.seen) {
      const warned = aheadWarned.current;
      if (!warned || warned.key !== reading.key) {
        // spokenAt is filled in by voiceLoop once it has actually been said; until then (and for
        // FIND_AHEAD_HOLD_MS after) nothing else may take the situation, or it would be lost.
        aheadWarned.current = { key: reading.key, spokenAt: null };
        situation.current = reading;
        buzz(Haptics.ImpactFeedbackStyle.Medium);
        setFindInfo(data);
        return;
      }
      if (aheadHoldLive(now)) {
        setFindInfo(data);
        return;
      }
    } else if (!reading) {
      aheadWarned.current = null;
    }
    if (offFrame) {
      setFindInfo(data);
      situation.current = { key: `offframe:${offFrame}`, text: offFramePhrase(offFrame), stop: false };
      return;
    }
    if (data.found && data.bearing_deg !== null) {
      findMisses.current = 0;
      setFindInfo(data);
      // The target's angle above or below level: the camera's tilt plus where the box sits in the
      // picture. Arrival goes by distance along the floor, so something low (on a seat, on the
      // floor) counts when you're standing next to it, not only when the phone is next to it.
      const elevation =
        elevationRef.current === null
          ? null
          : elevationRef.current + (data.box ? (0.5 - (data.box[1] + data.box[3] / 2)) * 2 * V_HALF_FOV_DEG : 0);
      const level = elevation === null ? 1 : Math.cos((elevation * Math.PI) / 180);
      const nearByDepth = data.distance_m !== null && data.distance_m * level <= ARRIVE_DISTANCE_M;
      // A big box alone isn't enough: a door (0.9 m wide) is 60% of the frame from 1.5 m away, a
      // couch from farther. Also need depth to agree (within ARRIVE_BOX_DEPTH_M), or the box to spill
      // past both frame edges, which is the at-the-lens case where depth misreads.
      const spills = data.box !== null && data.box[0] <= 0.02 && data.box[0] + data.box[2] >= 0.98;
      const nearBySize =
        data.box !== null &&
        data.box[2] >= ARRIVE_BOX_WIDTH &&
        ((data.distance_m !== null && data.distance_m <= ARRIVE_BOX_DEPTH_M) || spills);
      if (Math.abs(data.bearing_deg) <= FIND_SMALL_TURN_DEG && (nearByDepth || nearBySize)) {
        arrive(target, {
          side: Math.abs(data.bearing_deg) <= FIND_AHEAD_DEG ? null : data.bearing_deg > 0 ? 'right' : 'left',
          // Height only when the distance can be trusted (not the at-the-lens case).
          band:
            elevation !== null && nearByDepth && data.distance_m !== null
              ? bandFor(data.distance_m * Math.sin((elevation * Math.PI) / 180))
              : null,
        });
        return;
      }
      if (phase === 'approach') {
        const off = targetOffset() ?? data.bearing_deg;
        // The straight-line check, when lined up and it's due or has changed (PATH_CHANGE_FRAMES).
        const path = serverFound && !tiltRef.current && Math.abs(off) <= FIND_AHEAD_DEG ? (data.path ?? null) : null;
        const p = pathRef.current;
        const pathState = path ? (path.clear ? 'open' : 'blocked') : null;
        if (pathState && pathState === p.said && !p.due) p.streak = 0;
        else if (pathState) p.streak += 1;
        if (path && pathState && (p.due || (pathState !== p.said && p.streak >= PATH_CHANGE_FRAMES))) {
          p.said = pathState;
          p.due = false;
          p.streak = 0;
          const text = pathPhrase(path, guideSettings().units ?? 'meters');
          pathHold.current = { key: `path:${text}`, spokenAt: null };
          situation.current = { key: `path:${text}`, text, stop: false };
          if (pathState === 'blocked') buzz(Haptics.ImpactFeedbackStyle.Medium);
        } else if (pathHoldLive(Date.now())) {
          // Still saying it; target guidance waits.
        } else if (tiltRef.current) {
          // About to leave the picture: fix that first. Left and right is remembered, this isn't.
          situation.current = { key: `tilt:${tiltRef.current}`, text: tiltPhrase(tiltRef.current), stop: false };
        } else if (Math.abs(off) > FIND_AHEAD_DEG) {
          // Drifted off it; the live direction comes from the gyro.
          const text = driftSentence(off) ?? data.sentence;
          lastDriftAt.current = Date.now();
          situation.current = { key: `drift:${off > 0 ? 'right' : 'left'}`, text, stop: false };
        } else {
          // On course: the voice stays quiet and the pulses guide (double tap when lined up).
          // It speaks again when there is something to do: turn, tilt, an obstacle, arrival.
          situation.current = { key: 'oncourse', text: '', stop: false };
        }
      } else {
        situation.current = { key: data.sentence, text: data.sentence, stop: false };
      }
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
    // If we know where it was, guide by the gyro: clock position, and the screen's arrow and
    // meter follow the remembered direction.
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
      const text = clockPhrase(target, off, findOpenVocabRef.current);
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
      if (endpoint === '/find' && walkerBusy()) {
        await sleep(150); // Find pauses while Walker has the floor
        continue;
      }
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
          // Sharper frames only in Search; in Approach the target is near and speed matters.
          const sharp =
            findOnRef.current && findPhaseRef.current === 'search' && findBlanks.current >= FIND_BLANKS_FOR_SHARP;
          const width = sharp ? FIND_SHARP_WIDTH_PX : SONAR_WIDTH_PX;
          // Already small (pictureSize): send as is. The server applies the rotation tag.
          const small = photo.width && photo.height && Math.min(photo.width, photo.height) <= width;
          uri = small ? photo.uri : await shrink(photo.uri, width);
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
          appendSettings(form);
          for (const [k, v] of Object.entries(fields())) form.append(k, v);
          inFlight += 1;
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), FRAME_TIMEOUT_MS);
          // Not awaited: the next capture starts while this one is on its way.
          fetch(`${API_URL}${endpoint}`, { method: 'POST', body: form, headers: HEADERS, signal: abort.signal })
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
              clearTimeout(timer);
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
    const gen = ++voiceGen.current;
    let lastText: string | null = null;
    let lastSpokenAt = 0;
    let lastEndedAt = 0;
    while (loopsOn() && voiceGen.current === gen) {
      const s = situation.current;
      // Routine sentences wait while someone is talking to Walker. Safety ones never wait.
      const findPaused = findOnRef.current && walkerBusy();
      if (!s || !s.text || describePlaying() || speechBusy.current || findPaused || (!isUrgent(s) && walkerHolds.current)) {
        await sleep(100);
        continue;
      }
      // A pause after each phrase (VOICE_GAP_MS). Safety speech and the hand-off cue don't wait for it.
      if (!isUrgent(s) && s.key !== 'handoff' && Date.now() - lastEndedAt < VOICE_GAP_MS) {
        await sleep(100);
        continue;
      }
      // "Changed" means the words changed. Two parts of Find write the same sentence under different
      // keys (and some keys carry a timestamp), which made the voice repeat itself straight away.
      const changed = s.text !== lastText;
      const remindAfter = findOnRef.current
        ? isUrgent(s)
          ? s.key.startsWith('detour:') && !s.stop
            ? DETOUR_REMIND_MS
            : URGENT_REMIND_MS
          : findPhaseRef.current === 'approach'
          ? APPROACH_REMIND_MS
          : FIND_REMIND_MS
        : s.key.startsWith('far')
          ? GUIDE_REMIND_MS
          : GUIDE_REMIND_CLOSE_MS;
      // Said once, never reminded: the phase cues, and in Find the "Something ahead, about 3
      // meters" warning (the hold already keeps it from being talked over).
      const oneShot =
        s.key === 'handoff' ||
        s.key === 'lost' ||
        s.key === 'standstill' ||
        s.key.startsWith('detour:clear') ||
        s.key.startsWith('detour:stuck') ||
        s.key.startsWith('path:') ||
        (findOnRef.current && s.key.startsWith('far:'));
      const remind = s.key !== OPEN.key && !oneShot && Date.now() - lastSpokenAt > remindAfter;
      if (!changed && !remind) {
        // The same words were the last thing said: that counts as said, so the far-ahead hold can end.
        if (aheadWarned.current?.key === s.key && aheadWarned.current.spokenAt === null) aheadWarned.current.spokenAt = Date.now();
        if (pathHold.current?.key === s.key && pathHold.current.spokenAt === null) pathHold.current.spokenAt = Date.now();
        await sleep(100);
        continue;
      }
      lastText = s.text;
      lastSpokenAt = Date.now();
      if (aheadWarned.current && aheadWarned.current.key === s.key) aheadWarned.current.spokenAt = Date.now();
      if (pathHold.current && pathHold.current.key === s.key) pathHold.current.spokenAt = Date.now();
      setGuideText(s.text);
      await speakPhrase(s.text, s.stop);
      lastEndedAt = Date.now();
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
      appendSettings(form);
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
  // The tracked object, moved by the live gyro: the box follows it instead of each raw answer.
  const tracked = findOn && findInfo ? trackView(trackRef.current, headingNow, Date.now()) : null;
  if (tracked && findInfo) {
    const off = tracked.bearing_deg;
    liveFind = {
      ...findInfo,
      found: true,
      bearing_deg: Math.max(-CAMERA_HALF_FOV_DEG, Math.min(CAMERA_HALF_FOV_DEG, off)),
      direction: Math.abs(off) <= FIND_AHEAD_DEG ? 'ahead' : off > 0 ? 'right' : 'left',
      centered: Math.abs(off) <= 5,
      box: tracked.box,
      distance_m: trackRef.current?.distance ?? findInfo.distance_m,
      stale: tracked.stale,
      locked: tracked.locked,
    };
  } else if (findOn && findInfo && findInfo.bearing_deg !== null && targetHeading !== null && headingNow !== null) {
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
        ? formatDistance(distance, prefs.units)
        : findOn
          ? capitalize(findTarget ?? 'Find')
          : arrived
            ? "You're there"
            : guideOn || (resultVisible && result?.clear)
            ? 'Path looks open'
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
            ? guideText || null
            : resultVisible && result?.clear
            ? null
            : 'Tap anywhere';
  const label = findOn ? capitalize(findTarget ?? '') : found?.label ? capitalize(found.label) : null;

  // Where a box lands on screen: the 3:4 photo is scaled to cover the screen.
  const toScreen = ([x, y, w, h]: [number, number, number, number]): Rect => {
    const scale = Math.max(screenW / PHOTO_ASPECT, screenH); // displayed photo height
    const photoW = scale * PHOTO_ASPECT;
    const offX = (screenW - photoW) / 2;
    const offY = (screenH - scale) / 2;
    return { left: offX + x * photoW, top: offY + y * scale, width: w * photoW, height: h * scale };
  };
  // The obstacle (or find target) box.
  const shownBox = findOn ? (liveFind?.box ?? null) : found?.box;
  const box = shownBox && !busy ? toScreen(shownBox) : null;
  const obstacleTagTop = box ? Math.max(SAFE.top + 72, box.top - 48) : 0;
  const obstacleTag = label ?? 'Obstacle';
  const obstacleTagText = `${obstacleTag}${distance != null ? ` · ${formatDistance(distance, prefs.units)}` : ''}`;
  // Its tag stays on screen: a box near the right edge used to push it half off.
  const obstacleTagW = obstacleTagText.length * TAG_CHAR_W + 28;
  const obstacleTagLeft = box ? Math.max(GUTTER, Math.min(box.left, screenW - GUTTER - obstacleTagW)) : 0;

  // Describe's other named things (result.objects), lighter than the obstacle box and kept tidy: one
  // box per group (the server sends its nearest member; the tag says how many), no box that mostly
  // covers or sits under one already drawn, and a tag that would collide goes below its box, inside
  // it, or is left off (the box stays).
  const objectMarks: { key: string; box: Rect; tag: { left: number; top: number; text: string } | null }[] = [];
  if (!guideOn && !findOn && !busy && resultVisible && result?.objects?.length) {
    const tagRect = (left: number, top: number, text: string): Rect => ({
      left,
      top,
      width: text.length * OBJECT_TAG_CHAR_W + 2 * OBJECT_TAG_PAD,
      height: OBJECT_TAG_H,
    });
    const drawn: Rect[] = box ? [box] : [];
    const tags: Rect[] = box ? [{ left: obstacleTagLeft, top: obstacleTagTop, width: obstacleTagW, height: 40 }] : [];
    const minTop = SAFE.top + 72; // below the top bar
    const maxBottom = screenH - BOTTOM_CARD_H; // above the card
    for (const o of result.objects) {
      const r = toScreen(o.box);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cx > screenW || cy < 0 || cy > screenH) continue; // cropped off the screen
      if (drawn.some((d) => overlapFraction(r, d) > OBJECT_OVERLAP_MAX)) continue;
      drawn.push(r);
      const name = capitalize(o.label);
      const text = `${o.count > 1 ? `${name} ×${o.count}` : name}${o.distance_m != null ? ` · ${formatDistance(o.distance_m, prefs.units)}` : ''}`;
      const left = Math.max(GUTTER, Math.min(r.left, screenW - GUTTER - tagRect(0, 0, text).width));
      const spot = [r.top - OBJECT_TAG_H - 4, r.top + r.height + 4, r.top + 6]
        .map((top) => tagRect(left, top, text))
        .find((t) => t.top >= minTop && t.top + t.height <= maxBottom && !tags.some((u) => overlapFraction(t, u) > 0));
      if (spot) tags.push(spot);
      objectMarks.push({ key: `${o.label}:${o.direction}`, box: r, tag: spot ? { left, top: spot.top, text } : null });
    }
  }

  const topBar = (
    <View style={styles.topBar} pointerEvents="box-none">
      <Pressable
        style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
        onPress={openSettings}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        accessibilityHint="Opens settings"
      >
        <Text style={styles.chipText}>Settings</Text>
      </Pressable>
    </View>
  );

  const findButton = (
    <View style={styles.modeCell}>
      <Pressable
        style={({ pressed }) => [styles.guide, styles.guideOn, pressed && styles.pressed]}
        onPress={openFindPicker}
        accessibilityRole="button"
        accessibilityLabel="Find"
        accessibilityHint="Pick something to find, like a chair. A voice tells you which way to turn."
      >
        <Text style={[styles.guideText, styles.guideTextOn]} numberOfLines={1} adjustsFontSizeToFit>
          Find
        </Text>
      </Pressable>
    </View>
  );

  // Find and Guide side by side; Find is the main feature, so it comes first and is filled, the two things you start while walking.
  const walkerButton = (
    <WalkerButton state={walkerState} onPress={walkerTap} size={76} />
  );
  const walkerBubble = <WalkerBubble state={walkerState} text={walkerText} />;

  const modeButtons = (
    <View style={styles.modeRow}>
      {findButton}
      {walkerButton}
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
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={false}
        // Small photos while the guide or Find runs (see pickFastSize); describe taps get full size.
        pictureSize={guideOn || findOn ? fastPictureSize : undefined}
        onCameraReady={() => {
          cameraRef.current
            ?.getAvailablePictureSizesAsync()
            .then((sizes) => setFastPictureSize(pickFastSize(sizes)))
            .catch(() => {});
        }}
      />

      {/* The whole screen is one big tap target. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={scan}
        // Press and hold anywhere talks to Walker (the Find screen has its own). Works with or
        // without VoiceOver (with it on, that's double-tap and hold). Repeating the last warning is
        // "Walker, repeat that", or the magic tap with VoiceOver.
        onLongPress={() => {
          tapHaptic();
          walkerTap();
        }}
        delayLongPress={600}
        accessibilityRole="button"
        accessibilityLabel="Describe what's ahead"
        accessibilityHint="Double tap to scan. Double tap and hold to talk to Walker."
        accessibilityState={{ busy: status === 'capturing' || status === 'thinking' }}
      />

      {findOn && findTarget ? (
        <FindScreen target={findTarget} units={prefs.units} description={findDescriptionRef.current} result={liveFind} onStop={() => stopFind(false)} paused={walkerState !== 'idle'} onHold={walkerTap} walker={walkerButton} walkerBubble={walkerBubble} />
      ) : (
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
            <ViewfinderCorners style={styles.viewfinder} />
            {objectMarks.map((m) => (
              <View key={m.key} style={StyleSheet.absoluteFill} pointerEvents="none">
                <View style={[styles.objectBox, m.box]} />
                {m.tag ? (
                  <View style={[styles.objectTag, { left: m.tag.left, top: m.tag.top }]}>
                    <Text style={styles.objectTagText} numberOfLines={1}>
                      {m.tag.text}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
            {box ? (
              <>
                <View style={[styles.box, box]} />
                <View style={[styles.tag, { left: obstacleTagLeft, top: obstacleTagTop }]}>
                  <Text style={styles.tagText}>{obstacleTagText}</Text>
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
            {walkerBubble}
            {modeButtons}
          </View>
        </>
      )}

      {showSettings ? (
        <Settings
          prefs={prefs}
          onPrefs={updatePrefs}
          voices={voices}
          onRenameVoice={renameVoice}
          onDeleteVoice={deleteVoice}
          onSayName={sayName}
          newVoiceId={newVoiceId}
          onNewVoiceShown={() => setNewVoiceId(null)}
          nameState={nameState}
          voiceId={voiceId}
          onPickVoice={pickVoice}
          cloneStep={cloneStep}
          onClone={() => cloneTap()}
          cloneMaxS={cloneMaxS}
          onReplaySetup={replaySetup}
          page={settingsPage}
          onPage={onSettingsPage}
          focus={settingsFocus}
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

      {welcomeLeaving ? <Setup leaving onGone={() => setWelcomeLeaving(false)} /> : null}
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
    backgroundColor: C.accent,
    minHeight: 80,
    alignSelf: 'stretch',
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: C.onAccent, fontSize: 26, ...font('bold') },
  topShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 180 },
  // Between the top chips and the card and buttons at the bottom.
  viewfinder: { top: SAFE.top + 76, bottom: SAFE.bottom + 250, left: GUTTER, right: GUTTER },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 320 },
  topBar: {
    position: 'absolute',
    top: SAFE.top + SPACE.sm,
    left: GUTTER,
    right: GUTTER,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  chip: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 24,
    justifyContent: 'center',
    backgroundColor: C.glass,
  },
  chipText: { color: C.ink, fontSize: 18, ...font('semibold') },
  box: { position: 'absolute', borderWidth: 5, borderColor: C.accent, borderRadius: 18 },
  tag: {
    position: 'absolute',
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagText: { color: C.onAccent, fontSize: 20, ...font('bold') },
  // Describe's other named things: same colors, thinner and a little see-through, so the obstacle
  // box stays the one that stands out.
  objectBox: { position: 'absolute', borderWidth: 3, borderColor: C.accent, borderRadius: 14, opacity: 0.8 },
  objectTag: {
    position: 'absolute',
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingHorizontal: OBJECT_TAG_PAD,
    height: OBJECT_TAG_H,
    justifyContent: 'center',
    opacity: 0.9,
  },
  objectTagText: { color: C.onAccent, fontSize: 16, ...font('bold') },
  bottom: { position: 'absolute', left: GUTTER, right: GUTTER, bottom: SAFE.bottom + SPACE.sm, gap: SPACE.md },
  card: {
    backgroundColor: C.glass,
    borderRadius: 22,
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
    backgroundColor: C.accent,
  },
  headline: { color: C.accent, fontSize: 34, ...font('bold') },
  headlineNumber: { fontSize: 56, ...font('heavy') },
  detail: { color: C.ink2, fontSize: 18, marginTop: SPACE.xs, ...font('semibold') },
  // Fixed height (not minHeight) so Guide and Find always match, whatever the label says.
  guide: { height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  modeRow: { flexDirection: 'row', gap: SPACE.md },
  modeCell: { flex: 1 },
  guideOn: { backgroundColor: C.accent, borderBottomWidth: 5, borderBottomColor: C.accentDeep },
  guideOff: { backgroundColor: C.glass, borderWidth: 2, borderColor: C.accent },
  guideText: { fontSize: 26, ...font('bold') },
  guideTextOn: { color: C.onAccent },
  guideTextOff: { color: C.accent },
});
