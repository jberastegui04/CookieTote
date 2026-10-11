import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
import { loadFindTargets } from './find';
import FindScreen from './FindScreen';
import { setTapHaptics, tapHaptic } from './feedback';
import { useReduceMotion } from './motion';
import { WalkerBubble, WalkerButton, type WalkerState } from './Walker';
import { findLine, LINES, parseCommand, saidWalker } from './walkerCommands';
import { trackUpdate, trackView, type Candidate, type Track } from './tracker';
import Setup, { type Vision } from './Setup';
import { DEFAULT_PREFS, formatDistance, SPEEDS, type Prefs } from './prefs';
import { C, font, GUTTER, SAFE, SPACE } from './theme';

// Your laptop's address on the same Wi-Fi, set in app/.env (see README).
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

// The Where are you setting. 'auto' lets the server guess from the photo; it says what it used in `scene`.
type Mode = 'auto' | 'indoor' | 'outdoor';
type Scene = 'indoor' | 'outdoor';

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
  candidates?: Candidate[]; // every candidate this frame, best first; the tracker follows one
  obstacle: SonarResult;
  stale?: boolean; // app-side: the tracker hasn't seen it for a moment, so the box is drawn faded
  locked?: boolean; // app-side: the tracker locked onto it (2 confident sightings in a row)
};

type Status = 'idle' | 'capturing' | 'thinking' | 'error';

type Voice = { id: string; name: string; custom?: boolean }; // custom: a trusted voice the user recorded
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
// Find runs in two phases. SEARCH: standing still and turning; only the target is spoken, and
// obstacles are ignored (false "Stop"s while turning on the spot were confusing). APPROACH: walking
// toward it; something close starts a detour (see Detour below), otherwise target drift. Phrases
// are on the /say list.
type FindPhase = 'search' | 'approach';
const HANDOFF_PHRASE = "Got it. Walk toward it. I'll warn you about anything in the way.";
const LOST_PHRASE = 'Lost it. Stop and turn slowly.';
const STAND_STILL_PHRASE = 'Stand still while I look.';
const HANDOFF_CENTERED_MS = 1000; // facing it this long (and seen recently) hands off to Approach
const HANDOFF_SEEN_WITHIN_MS = 3000;
const APPROACH_DRIFT_MS = 2000; // how often the drift sentence may repeat
const APPROACH_REMIND_MS = 2000;
const LOST_AFTER_MS = 4000; // not seen this long, and out of view: back to Search
// Walking detection in Search (user acceleration, gravity removed): a smoothed level above this
// for a second means they're walking, and the app asks them to stand still, once.
const WALK_LEVEL = 0.5;
const WALK_SUSTAIN_MS = 1000;
// Approach detour: something close (or a stop) while walking toward the target. The user keeps
// the phone pointed at the target and steps sideways, toward the open side the server reports
// (or away from the obstacle). Target phrases and pulses are muted so nothing argues with the
// step instruction. Once the obstacle reads clear for DETOUR_CLEAR_FRAMES answers in a row, the
// voice says to turn back toward the target and the normal approach takes over. Phrases are on
// the /say list (DETOUR_PHRASES in backend/main.py); change both together.
// side is null when no side was confirmed open: then it only warns ("Stop. Something right in front
// of you."), never "Step to your …", since stepping into space nobody checked is worse than stopping.
type Detour = { side: 'left' | 'right' | null; startedAt: number; clearFrames: number };
const DETOUR_CLEAR_FRAMES = 2;
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
// His own voice, never the user's chosen guide voice: "Chris", a relaxed American ElevenLabs voice
// (his lines are on the server's /say list). If ElevenLabs can't be reached, a built-in American
// voice, a little slower and lower: the first of these the phone has, the better quality first.
const WALKER_VOICE_ID = 'iP95p4xoKVk53GoZ742B';
const WALKER_FALLBACK_VOICES = ['Evan', 'Nathan', 'Tom', 'Alex', 'Aaron'];
const WALKER_FALLBACK_RATE = 0.92;
const WALKER_FALLBACK_PITCH = 0.9;
// Hands-free "Hey Walker" (Settings > Walker). Expo Go has no wake-word engine, so the app keeps a
// short recording going and watches the level meter for talking. Only a clip with speech in it goes
// to /transcribe, and Walker only acts if his name is in it.
const WAKE_RESTART_MS = 4000; // nothing said this long: start a fresh clip, so clips stay small
const WAKE_MIN_SPEECH_MS = 400; // shorter is a cough or a bump
const WAKE_MAX_SPEECH_MS = 6000; // longer is a conversation, not a command: dropped
const WAKE_SILENCE_MS = 900; // a pause this long ends what was said
const WAKE_MIN_GAP_MS = 3000; // at most one clip to /transcribe this often (the limit is shared)
type Heard = { text: string; heard?: string; target: string | null; description: string | null; open_vocab?: boolean };
// Safety speech that Walker never holds back or talks over: Stop, close-by warnings, detours.
const isUrgent = (s: Situation | null) =>
  !!s && (s.stop || s.key.startsWith('close') || s.key.startsWith('detour'));

// Said when Find starts. On the /say list for every target (STATUS_PHRASES in backend/main.py).
const findingPhrase = (target: string) => `Finding ${target}. Turn slowly.`;
const FINDING_IT = 'Finding it. Turn slowly.';
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
  const [fastPictureSize, setFastPictureSize] = useState<string | undefined>(undefined);
  const fastPictureSizeRef = useRef<string | undefined>(undefined); // same, for the frame loop's timing log
  fastPictureSizeRef.current = fastPictureSize;
  const player = useAudioPlayer(null);
  const lastClip = useRef<File | null>(null);
  const [mode, setMode] = useState<Mode>('auto');
  const [scene, setScene] = useState<Scene | null>(null); // from the newest response
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DescribeResult | null>(null);
  // Voice picker. The list comes from GET /voices; the choice is remembered on the phone.
  const [voices, setVoices] = useState<Voice[]>([]);
  // "Say the name" for a trusted voice: same 3 second recording and /transcribe as Find.
  const [newVoiceId, setNewVoiceId] = useState<string | null>(null); // Settings opens it to be named
  const [nameState, setNameState] = useState<'idle' | 'listening' | 'working'>('idle');
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const voiceIdRef = useRef<string | null>(null);
  const screenReader = useRef(false);
  const [cloneStep, setCloneStep] = useState<CloneStep>('idle');
  const cloneStepRef = useRef<CloneStep>('idle');
  // Metering gives Walker the sound level, so he can stop listening when you stop talking.
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  // A second recorder for hands-free "Hey Walker", so it never gets in the way of the one above.
  const wakeRecorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });

  // Guide mode. The loops below run for a long time, so they read refs instead of state.
  const [guideOn, setGuideOn] = useState(false);
  const [guideDistance, setGuideDistance] = useState<number | null>(null);
  const [guideSide, setGuideSide] = useState<Side | null>(null);
  const [guideText, setGuideText] = useState('');
  const guideOnRef = useRef(false);
  const modeRef = useRef<Mode>('auto');
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
  const findBlanks = useRef(0); // answers in a row with the target not in the frame
  const detourRef = useRef<Detour | null>(null); // stepping around something in Approach
  // Last "Something ahead, about 3 meters" in Find; spokenAt is null until voiceLoop has said it.
  const aheadWarned = useRef<{ key: string; spokenAt: number | null } | null>(null);
  // While this is true nothing else (target guidance, drift) may take the situation from it.
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
  const [walkerState, setWalkerState] = useState<WalkerState>('idle');
  const walkerStateRef = useRef<WalkerState>('idle');
  const [walkerText, setWalkerText] = useState<string | null>(null);
  const walkerDone = useRef(false); // tapped again while listening: stop recording now
  // While Walker listens and thinks, the guide and Find hold their routine sentences (not safety
  // ones), so they don't end up in the recording.
  const walkerHolds = useRef(false);
  const walkerVoice = useRef<string | undefined>(undefined); // identifier of his built-in fallback voice
  const walkerPlaying = useRef(false); // his ElevenLabs clip is on the player
  const wakeGen = useRef(0); // bumped to stop the hands-free loop
  const wakeRecording = useRef(false); // the hands-free clip has the microphone
  const lastWakeSent = useRef(0);
  const pickerOpen = useRef(false); // the Find picker is up (mirrors showTargets)
  const otherMic = useRef(false); // spoken Find, naming or recording a voice has the microphone
  // The audio mode only needs setting again after something else changed it (those recordings turn
  // recording off when they finish); setting it on every clip could blip the audio playing.
  const wakeNeedsMode = useRef(true);
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
    AsyncStorage.multiGet([MODE_KEY, CAMERA_KEY, SETUP_KEY, PREFS_KEY])
      .then(([[, savedMode], [, savedCamera], [, savedSetup], [, savedPrefs]]) => {
        setSetupDone(!ALWAYS_SHOW_SETUP && savedSetup === '1');
        if (savedPrefs) {
          const loaded = { ...DEFAULT_PREFS, ...JSON.parse(savedPrefs) };
          prefsRef.current = loaded;
          setPrefs(loaded);
          setTapHaptics(loaded.haptics);
        }
        if (savedMode === 'auto' || savedMode === 'indoor' || savedMode === 'outdoor') {
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
    loadFindTargets()
      .then((t) => (knownTargets.current = new Set(t)))
      .catch(() => {});
    loadVoices()
      .then((data) => {
        if (!voiceIdRef.current) {
          voiceIdRef.current = data.default;
          setVoiceId(data.default);
        }
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

  // Hands-free "Hey Walker" runs while it's on in Settings and the camera screen is up.
  useEffect(() => {
    pickerOpen.current = showTargets;
  }, [showTargets]);
  useEffect(() => {
    otherMic.current = speakState !== 'idle' || nameState !== 'idle' || cloneStep !== 'idle';
    if (!otherMic.current) wakeNeedsMode.current = true;
  }, [speakState, nameState, cloneStep]);
  useEffect(() => {
    if (!setupDone || !permission?.granted || !prefs.heyWalker) return;
    wakeLoop();
    return () => {
      wakeGen.current++;
    };
  }, [setupDone, permission?.granted, prefs.heyWalker]);

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
    form.append('mode', modeRef.current);
    form.append('warning', prefsRef.current.warning);
    form.append('units', prefsRef.current.units);
  }

  // Every response says which scene it used; with Auto, that's what the top chip shows.
  function noteScene(data: unknown) {
    const sc = (data as { scene?: unknown }).scene;
    if (sc === 'indoor' || sc === 'outdoor') setScene(sc);
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

  async function renameVoice(id: string, name: string) {
    const clean = name.trim().slice(0, 30);
    if (!clean) return;
    setVoices((prev) => prev.map((v) => (v.id === id ? { ...v, name: clean } : v)));
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
    try {
      const res = await fetch(`${API_URL}/voices/${id}`, { method: 'DELETE', headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      sampleFiles.current.delete(id);
      const data = await loadVoices();
      // Deleted the voice in use: go back to the default one.
      if (voiceIdRef.current === id) {
        voiceIdRef.current = data.default;
        setVoiceId(data.default);
        AsyncStorage.setItem(VOICE_KEY, data.default).catch(() => {});
      }
      await notify(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility(`${name} deleted`);
    } catch (e) {
      console.warn(e);
      notify(Haptics.NotificationFeedbackType.Error);
      tell('Could not delete the voice. Try again.');
    }
  }

  // Records 3 seconds and returns what was said, cleaned up for a name ("mom." -> "Mom"). Null if
  // nothing was heard. Blind users can also type with VoiceOver or the keyboard's dictation key.
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
      await sleep(3000);
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      await buzz(Haptics.ImpactFeedbackStyle.Light);
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
  async function cloneTap() {
    const step = cloneStepRef.current;
    if (step === 'uploading') return;
    if (step === 'idle') {
      setClone('confirm');
      const notice =
        'This records a trusted person for thirty seconds and makes a voice from it. ' +
        'Only record someone who has agreed. Double tap again to start recording.';
      tell(notice);
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
        tell('Microphone access is needed to record a voice.');
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
        tell('Could not start recording.');
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
      if (!res.ok) throw new Error(`Server ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const added: Voice = await res.json();
      await loadVoices().catch(() => setVoices((prev) => [added, ...prev]));
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
    saidStandStill.current = false;
    detourRef.current = null;
    aheadWarned.current = null;
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
      .then(() => fetchPhrase(HANDOFF_PHRASE))
      .then(() => fetchPhrase(arrivalPhrase(target, open)))
      .then(() => fetchPhrase(LOST_PHRASE))
      .then(() => fetchPhrase(STAND_STILL_PHRASE))
      .then(() => fetchPhrase(detourPhrase('right', 'left', false)))
      .then(() => fetchPhrase(detourPhrase('left', 'right', false)))
      .then(() => fetchPhrase(detourClearPhrase('left')))
      .then(() => fetchPhrase(detourClearPhrase('right')))
      .then(() => fetchPhrase(classify(3, 'ahead', null, guideSettings()).text))
      .then(() => fetchPhrase(classify(2, 'ahead', null, guideSettings()).text));
  }

  // Search -> Approach: facing the target. Said once, with a double pulse.
  function handoff() {
    findPhaseRef.current = 'approach';
    centeredSince.current = null;
    detourRef.current = null;
    aheadWarned.current = null;
    lastDriftAt.current = Date.now();
    interruptForStop({ key: 'handoff', text: HANDOFF_PHRASE, stop: true });
    situation.current = { key: 'handoff', text: HANDOFF_PHRASE, stop: false };
    buzz(Haptics.ImpactFeedbackStyle.Heavy);
    setTimeout(() => buzz(Haptics.ImpactFeedbackStyle.Heavy), 160);
  }

  // Approach -> Search: not seen for a while and out of view.
  function lost() {
    findPhaseRef.current = 'search';
    targetHeadingRef.current = null;
    trackRef.current = null;
    lastFoundAt.current = 0;
    lastSentence.current = null;
    centeredSince.current = null;
    findBlanks.current = 0;
    saidStandStill.current = false;
    detourRef.current = null;
    aheadWarned.current = null;
    situation.current = { key: 'lost', text: LOST_PHRASE, stop: false };
  }

  // The last server sentence ("Door, slightly left, about 2 meters.") with its direction replaced by
  // where the target is now, from the gyro. Keeps the server's exact distance wording, so the
  // result is still on the /say list.
  function driftSentence(off: number): string | null {
    const base = lastSentence.current;
    if (!base) return null;
    const parts = base.slice(0, -1).split(', ');
    if (parts.length !== 3) return base;
    const where = Math.abs(off) <= FIND_AHEAD_DEG ? 'ahead' : off > 0 ? 'slightly right' : 'slightly left';
    return `${parts[0]}, ${where}, ${parts[2]}.`;
  }

  function setWalker(state: WalkerState) {
    walkerStateRef.current = state;
    setWalkerState(state);
  }

  // Walker: tap (or say "Hey Walker"), say what you need ("find the little green dragon", "start
  // walking", "units feet"), and he answers in his own voice and does it. Tap again while he listens
  // to stop early, or while he talks to stop him. Safety speech always wins: he waits for it, and
  // stops listening if it starts.
  async function walkerTap() {
    const state = walkerStateRef.current;
    if (state === 'listening') {
      walkerDone.current = true;
      return;
    }
    if (state === 'talking') {
      Speech.stop(); // walkerSpeak resolves when he stops
      if (walkerPlaying.current) player.pause();
      return;
    }
    if (state === 'thinking') return;
    await walkerSession();
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

  // The audio mode between recordings: hands-free keeps the microphone ready (and playback on the
  // speaker, not the earpiece).
  function micIdle() {
    return setAudioModeAsync({
      allowsRecording: prefsRef.current.heyWalker,
      playsInSilentMode: true,
      shouldRouteThroughEarpiece: false,
    }).catch(() => {});
  }

  // Records one command and sends it to /transcribe. Null if that failed, 'interrupted' if safety
  // speech started while recording.
  async function walkerListen(): Promise<Heard | null | 'interrupted'> {
    try {
      walkerDone.current = false;
      for (let i = 0; i < 20 && wakeRecording.current; i++) await sleep(50); // hands-free clip lets go first
      await waitForQuiet(); // don't record the guide's own voice
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      await buzz(Haptics.ImpactFeedbackStyle.Medium);
      AccessibilityInfo.announceForAccessibility('Listening');
      const interrupted = await listenUntilQuiet();
      await recorder.stop();
      await micIdle();
      await buzz(Haptics.ImpactFeedbackStyle.Light);
      if (interrupted) return 'interrupted';
      if (!recorder.uri) throw new Error('No recording');
      setWalker('thinking');
      return await transcribeClip(recorder.uri);
    } catch (e) {
      console.warn(e);
      await micIdle();
      notify(Haptics.NotificationFeedbackType.Error);
      return null;
    }
  }

  async function transcribeClip(uri: string): Promise<Heard> {
    const form = new FormData();
    form.append('audio', new File(uri));
    const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form, headers: HEADERS });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    return (await res.json()) as Heard;
  }

  // What he does with what was heard, from a tap or hands-free. `heard` is everything said (newer
  // servers); `text` is cut to start at the request, which loses "Hey Walker".
  async function walkerRespond(h: Heard) {
    const all = h.heard ?? h.text;
    const cmd = parseCommand(saidWalker(all) ? all : h.text, voices);
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
  // (about -160 to 0) and compared with the quietest moment so far, the room's own noise. Returns
  // true if safety speech started meanwhile (the recording is then dropped).
  async function listenUntilQuiet(): Promise<boolean> {
    const start = Date.now();
    let floor = Infinity;
    let spoke = false;
    let quietSince: number | null = null;
    while (!walkerDone.current && Date.now() - start < WALKER_MAX_MS) {
      await sleep(100);
      if (speechBusy.current) return true;
      const level = recorder.getStatus().metering;
      if (level === undefined) continue;
      floor = Math.min(floor, level);
      if (level > floor + WALKER_SPEECH_DB) {
        spoke = true;
        quietSince = null;
      } else if (spoke && level < floor + WALKER_QUIET_DB) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince > WALKER_SILENCE_MS) return false;
      } else if (!spoke && Date.now() - start > WALKER_NO_SPEECH_MS) {
        return false;
      }
    }
    return false;
  }

  // Walker says something in his own voice, never the user's chosen one, and resolves when he's done.
  // With VoiceOver on, VoiceOver says it instead, so the two never double up. He waits for the guide
  // or Find to finish first, and stops at once if a safety warning comes in.
  async function walkerSpeak(text: string) {
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
      const uri = await fetchPhrase(text, WALKER_VOICE_ID);
      if (uri) {
        walkerPlaying.current = true;
        player.replace({ uri });
        for (let i = 0; i < 80 && !player.isLoaded; i++) await sleep(25);
        player.setPlaybackRate(1); // the speed setting is for the guide, not him
        player.play();
        for (let i = 0; i < 10 && !player.playing; i++) await sleep(50);
        for (let i = 0; i < 200 && player.playing; i++) {
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
      for (let i = 0; i < 200 && !done; i++) {
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
    for (const text of [LINES.yes, LINES.findIt, LINES.guideOn, LINES.guideOff, LINES.describe, LINES.stop, LINES.cantHear, LINES.unknown]) {
      await fetchPhrase(text, WALKER_VOICE_ID);
    }
  }

  // Hands-free "Hey Walker": one short clip at a time while nothing else is using the microphone or
  // talking. A clip with speech in it goes to /transcribe; Walker answers only if his name is in it.
  async function wakeLoop() {
    const gen = ++wakeGen.current;
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return;
    while (wakeGen.current === gen) {
      if (!canWake()) {
        await sleep(300);
        continue;
      }
      let clip: 'speech' | 'none' = 'none';
      wakeRecording.current = true;
      try {
        if (wakeNeedsMode.current) {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
          wakeNeedsMode.current = false;
        }
        await wakeRecorder.prepareToRecordAsync();
        wakeRecorder.record();
        clip = await wakeListen(gen);
      } catch (e) {
        console.warn(e);
        wakeNeedsMode.current = true;
        await sleep(1000);
      } finally {
        await wakeRecorder.stop().catch(() => {});
        wakeRecording.current = false;
        if (walkerStateRef.current === 'idle') walkerHolds.current = false;
      }
      if (clip !== 'speech' || !wakeRecorder.uri || Date.now() - lastWakeSent.current < WAKE_MIN_GAP_MS) continue;
      lastWakeSent.current = Date.now();
      try {
        const h = await transcribeClip(wakeRecorder.uri);
        if (saidWalker(h.heard ?? h.text) && canWake()) await walkerRespond(h);
      } catch (e) {
        console.warn(e);
      }
    }
  }

  // Hands-free listens when nothing else needs the microphone, on the camera screen with the app open.
  // It keeps listening while the guide or Find talks (they talk every few seconds, which would leave
  // no gap for "Hey Walker"); wakeListen just doesn't count the app's own voice as someone talking.
  function canWake() {
    return (
      prefsRef.current.heyWalker &&
      walkerStateRef.current === 'idle' &&
      !settingsOpen.current &&
      !pickerOpen.current &&
      !otherMic.current &&
      AppState.currentState === 'active'
    );
  }

  // Waits for someone talking, then for a pause after it. 'speech' if they said something short enough
  // to be a command; 'none' to start a fresh clip. Loud moments while the app itself is talking don't
  // count, so its own voice never gets a clip sent (and the app never says "Walker", so its voice in
  // the background can't wake him). Once someone starts talking, the guide's and Find's routine
  // sentences hold (walkerHolds) so they don't talk over the request; safety warnings still play.
  async function wakeListen(gen: number): Promise<'speech' | 'none'> {
    const start = Date.now();
    let floor = Infinity;
    let speechStart: number | null = null;
    let quietSince: number | null = null;
    while (wakeGen.current === gen) {
      await sleep(100);
      if (!canWake()) return 'none';
      const now = Date.now();
      const level = wakeRecorder.getStatus().metering;
      if (level === undefined) {
        if (now - start > WAKE_RESTART_MS) return 'none';
        continue;
      }
      const appTalking = speechBusy.current || describePlaying();
      if (!appTalking) floor = Math.min(floor, level);
      if (level > floor + WALKER_SPEECH_DB) {
        if (speechStart === null && !appTalking) {
          speechStart = now;
          walkerHolds.current = true;
        }
        quietSince = null;
        if (speechStart !== null && now - speechStart > WAKE_MAX_SPEECH_MS) return 'none';
      } else if (speechStart !== null && level < floor + WALKER_QUIET_DB) {
        quietSince ??= now;
        if (now - quietSince > WAKE_SILENCE_MS) {
          return quietSince - speechStart >= WAKE_MIN_SPEECH_MS ? 'speech' : 'none';
        }
      } else if (speechStart === null && now - start > WAKE_RESTART_MS) {
        return 'none';
      }
    }
    return 'none';
  }

  // What Walker was asked to do. He has already said it, so nothing here announces it again.
  function walkerDo(cmd: ReturnType<typeof parseCommand>, heard: { target: string | null; description: string | null; open_vocab?: boolean }) {
    switch (cmd.action) {
      case 'find':
        if (!heard.target) break;
        if (findOnRef.current) stopFind(false); // already finding something else: switch
        startFind(heard.target, heard.description, heard.open_vocab ?? false, true);
        break;
      case 'guide_on':
        if (!guideOnRef.current) toggleGuide();
        break;
      case 'guide_off':
        if (guideOnRef.current) toggleGuide();
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
      const off = targetOffset();
      const now = Date.now();
      if (findPhaseRef.current === 'search') {
        if (!saidStandStill.current && movingSince.current !== null && now - movingSince.current > WALK_SUSTAIN_MS) {
          saidStandStill.current = true;
          situation.current = { key: 'standstill', text: STAND_STILL_PHRASE, stop: false };
        }
        const seenRecently = now - lastFoundAt.current <= HANDOFF_SEEN_WITHIN_MS;
        if (off !== null && seenRecently && Math.abs(off) <= FIND_AHEAD_DEG) {
          centeredSince.current ??= now;
          if (now - centeredSince.current >= HANDOFF_CENTERED_MS) handoff();
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
          off !== null && Math.abs(off) > FIND_AHEAD_DEG && now - lastDriftAt.current > APPROACH_DRIFT_MS && !aheadHoldLive(now)
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
  async function arrive(target: string) {
    stopFind(false);
    setArrived(target);
    notify(Haptics.NotificationFeedbackType.Success);
    arriveSound.seekTo(0).then(() => arriveSound.play()).catch(() => {});
    await sleep(450);
    await speakPhrase(arrivalPhrase(target, findOpenVocabRef.current), true);
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
      if (speechToken.current === token) {
        speechBusy.current = false;
        speakingStop.current = false;
      }
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
    const target = findTargetRef.current ?? data.target;
    const phase = findPhaseRef.current;
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
    // Once locked, the voice follows the track, not the frame. The open-vocabulary detector's
    // score for a small or oddly worded target wanders in and out of "no match" from frame to
    // frame, which used to say "No match yet. Turn slowly." right after the lock chime. A locked
    // track still in view counts as a sighting at its bearing and blended distance.
    const track = trackRef.current;
    const view = !data.found && track?.locked ? trackView(track, headingAtCapture ?? headingRef.current, Date.now()) : null;
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
    const o = data.obstacle;
    // Approach only: in Search the phone is swinging round, and a wall 3 m ahead would be
    // announced mid-turn (movingSince trips on the swing, not just on walking).
    const reading =
      phase === 'approach' && !o.clear && o.distance_m !== null
        ? classify(o.distance_m, o.direction ?? 'ahead', o.open ?? null, guideSettings())
        : null;
    const danger = phase === 'approach' && reading && (reading.stop || reading.key.startsWith('close')) ? reading : null;
    const now = Date.now();
    const detour = detourRef.current;
    if (danger) {
      const obstacleSide: Side = o.direction ?? 'ahead';
      // Only say which way to step when the server confirmed that side is open (nothing within the
      // warning distance). Otherwise just warn, and after DETOUR_STUCK_MS say to back up, which
      // retraces ground the user just walked.
      const open = o.open ?? null;
      const say = (side: 'left' | 'right' | null) =>
        side
          ? { key: `detour:${side}:${danger.stop}`, text: detourPhrase(obstacleSide, side, danger.stop), stop: danger.stop }
          : { ...danger, key: `detour:hold:${danger.key}` };
      if (!detour || (detour.side === null && open)) {
        // New detour, or a held one that now has a confirmed open side to step to.
        detourRef.current = { side: open, startedAt: detour?.startedAt ?? now, clearFrames: 0 };
        const next = say(open);
        if (danger.stop) interruptForStop(next);
        situation.current = next;
        buzz(Haptics.ImpactFeedbackStyle.Heavy);
      } else {
        detour.clearFrames = 0;
        if (now - detour.startedAt > DETOUR_STUCK_MS) {
          // Stepping didn't help (or they didn't step): back up and try again from scratch.
          detour.startedAt = now;
          situation.current = { key: `detour:stuck:${now}`, text: DETOUR_STUCK_PHRASE, stop: false };
        } else {
          const next = say(detour.side);
          if (danger.stop && !situation.current?.stop) interruptForStop(next);
          situation.current = next;
        }
      }
      setFindInfo(data);
      return;
    }
    if (detour) {
      detour.clearFrames += 1;
      if (detour.clearFrames >= DETOUR_CLEAR_FRAMES) {
        detourRef.current = null;
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
    if (reading && reading.key.startsWith('far:ahead')) {
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
    if (data.found && data.bearing_deg !== null) {
      findMisses.current = 0;
      setFindInfo(data);
      const nearByDepth = data.distance_m !== null && data.distance_m <= ARRIVE_DISTANCE_M;
      // A big box alone isn't enough: a door (0.9 m wide) is 60% of the frame from 1.5 m away, a
      // couch from farther. Also need depth to agree (within ARRIVE_BOX_DEPTH_M), or the box to spill
      // past both frame edges, which is the at-the-lens case where depth misreads.
      const spills = data.box !== null && data.box[0] <= 0.02 && data.box[0] + data.box[2] >= 0.98;
      const nearBySize =
        data.box !== null &&
        data.box[2] >= ARRIVE_BOX_WIDTH &&
        ((data.distance_m !== null && data.distance_m <= ARRIVE_BOX_DEPTH_M) || spills);
      if (data.centered && (nearByDepth || nearBySize)) {
        arrive(target);
        return;
      }
      if (phase === 'approach') {
        const off = targetOffset() ?? data.bearing_deg;
        if (Math.abs(off) > FIND_AHEAD_DEG) {
          // Drifted off it; the live direction comes from the gyro.
          const text = driftSentence(off) ?? data.sentence;
          lastDriftAt.current = Date.now();
          situation.current = { key: `drift:${off > 0 ? 'right' : 'left'}`, text, stop: false };
        } else {
          situation.current = { key: data.sentence, text: data.sentence, stop: false };
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
    // Lag measurement: each frame's timings ride along with the next frame as `timing`, and the
    // server logs them (see log_reading in backend/main.py). gap = since the previous capture
    // started, net = round trip minus the server's own time (upload + download), age = capture to use.
    let lastTiming = '';
    let lastCaptureAt = 0;

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
        const t0 = Date.now();
        const gap = lastCaptureAt ? t0 - lastCaptureAt : 0;
        lastCaptureAt = t0;
        let t1 = t0;
        let t2 = t0;
        let px = '?'; // the photo's own size: shows whether pictureSize took effect
        let uri: string | null = null;
        try {
          const photo = await cameraRef.current?.takePictureAsync({
            quality: 0.3,
            shutterSound: false,
            skipProcessing: GUIDE_SKIP_PROCESSING,
          });
          if (!photo) throw new Error('No photo');
          t1 = Date.now();
          px = `${photo.width}x${photo.height}`;
          // Sharper frames only in Search; in Approach the target is near and speed matters.
          const sharp =
            findOnRef.current && findPhaseRef.current === 'search' && findBlanks.current >= FIND_BLANKS_FOR_SHARP;
          const width = sharp ? FIND_SHARP_WIDTH_PX : SONAR_WIDTH_PX;
          // Already small (pictureSize): send as is. The server applies the rotation tag.
          const small = photo.width && photo.height && Math.min(photo.width, photo.height) <= width;
          uri = small ? photo.uri : await shrink(photo.uri, width);
          t2 = Date.now();
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
          if (lastTiming) form.append('timing', lastTiming);
          inFlight += 1;
          const sentAt = Date.now();
          const waiting = inFlight;
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), FRAME_TIMEOUT_MS);
          // Not awaited: the next capture starts while this one is on its way.
          fetch(`${API_URL}${endpoint}`, { method: 'POST', body: form, headers: HEADERS, signal: abort.signal })
            .then(async (res) => {
              if (!res.ok) throw new Error(`Server ${res.status}`);
              const data = (await res.json()) as T;
              const rt = Date.now() - sentAt;
              const srv = (data as { server_ms?: number }).server_ms ?? 0;
              lastTiming = `gap=${gap} cap=${t1 - t0} shrink=${t2 - t1} rt=${rt} srv=${srv} net=${rt - srv} age=${Date.now() - t0} inflight=${waiting} px=${px} size=${fastPictureSizeRef.current ?? 'full'}`;
              noteScene(data);
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
    let lastKey: string | null = null;
    let lastSpokenAt = 0;
    while (loopsOn() && voiceGen.current === gen) {
      const s = situation.current;
      if (!s || describePlaying() || speechBusy.current || (walkerHolds.current && !isUrgent(s))) {
        await sleep(100);
        continue;
      }
      const changed = s.key !== lastKey;
      const remindAfter = findOnRef.current
        ? findPhaseRef.current === 'approach'
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
        (findOnRef.current && s.key.startsWith('far:'));
      const remind = s.key !== OPEN.key && !oneShot && Date.now() - lastSpokenAt > remindAfter;
      if (!changed && !remind) {
        await sleep(100);
        continue;
      }
      lastKey = s.key;
      lastSpokenAt = Date.now();
      if (aheadWarned.current && aheadWarned.current.key === s.key) aheadWarned.current.spokenAt = Date.now();
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
      appendSettings(form);
      if (voiceIdRef.current) form.append('voice_id', voiceIdRef.current);

      const res = await fetch(`${API_URL}/describe`, { method: 'POST', body: form, headers: HEADERS });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data: DescribeResult = await res.json();
      noteScene(data);
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
            ? guideText || null
            : resultVisible && result?.clear
            ? null
            : 'Tap anywhere';
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

  const sceneName = scene === 'outdoor' ? 'Outdoor' : 'Indoor';
  const whereText = mode === 'auto' ? (scene ? sceneName : 'Auto') : mode === 'indoor' ? 'Indoor' : 'Outdoor';
  const whereLabel =
    mode === 'auto' ? (scene ? `${sceneName}, detected automatically` : 'Indoor or outdoor, detected automatically') : whereText;

  const topBar = (
    <View style={styles.topBar} pointerEvents="box-none">
      {/* Where the app thinks you are. Not a button: change it in Settings. */}
      <View
        style={[styles.chip, !cameraPicture && styles.chipLarge]}
        accessible
        accessibilityRole="text"
        accessibilityLabel={whereLabel}
      >
        <Text style={styles.chipText}>{whereText}</Text>
      </View>
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
    <View style={styles.modeCell}>
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
        <Text
          style={[styles.guideText, guideOn ? styles.guideTextOn : styles.guideTextOff]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {guideOn ? 'Guide on' : 'Guide off'}
        </Text>
      </Pressable>
    </View>
  );

  const findButton = (
    <View style={styles.modeCell}>
      <Pressable
        style={({ pressed }) => [styles.guide, styles.guideOn, !cameraPicture && styles.guideLarge, pressed && styles.pressed]}
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
    <WalkerButton state={walkerState} onPress={walkerTap} size={cameraPicture ? 76 : 96} armed={prefs.heyWalker} />
  );
  const walkerBubble = <WalkerBubble state={walkerState} text={walkerText} />;

  const modeButtons = (
    <View style={styles.modeRow}>
      {findButton}
      {guideButton}
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
        <FindScreen target={findTarget} units={prefs.units} description={findDescriptionRef.current} result={liveFind} cameraPicture={cameraPicture} onStop={() => stopFind(false)} walker={walkerButton} walkerBubble={walkerBubble} />
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
                <View style={[styles.box, box]} />
                <View style={[styles.tag, { left: box.left, top: Math.max(SAFE.top + 72, box.top - 48) }]}>
                  <Text style={styles.tagText}>
                    {label ?? 'Obstacle'}
                    {distance != null ? ` · ${formatDistance(distance, prefs.units)}` : ''}
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
            {walkerBubble}
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
            {walkerBubble}
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
          onRenameVoice={renameVoice}
          onDeleteVoice={deleteVoice}
          onSayName={sayName}
          newVoiceId={newVoiceId}
          onNewVoiceShown={() => setNewVoiceId(null)}
          nameState={nameState}
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
    backgroundColor: C.accent,
    minHeight: 80,
    alignSelf: 'stretch',
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: C.onAccent, fontSize: 26, ...font('bold') },
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
    backgroundColor: C.glass,
  },
  chipLarge: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1.5 },
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
  haloLarge: { borderRadius: 56 },
  headline: { color: C.accent, fontSize: 34, ...font('bold') },
  headlineNumber: { fontSize: 56, ...font('heavy') },
  detail: { color: C.ink2, fontSize: 18, marginTop: SPACE.xs, ...font('semibold') },
  // Fixed height (not minHeight) so Guide and Find always match, whatever the label says.
  guide: { height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  guideLarge: { height: 96, borderRadius: 48 },
  modeRow: { flexDirection: 'row', gap: SPACE.md },
  modeCell: { flex: 1 },
  guideOn: { backgroundColor: C.accent },
  guideOff: { backgroundColor: C.glass, borderWidth: 2, borderColor: C.accent },
  guideText: { fontSize: 26, ...font('bold') },
  guideTextOn: { color: C.onAccent },
  guideTextOff: { color: C.accent },
  // Below the top chips (48 tall), above the home indicator.
  large: {
    ...StyleSheet.absoluteFill,
    paddingTop: SAFE.top + SPACE.sm + 48 + SPACE.xl,
    paddingHorizontal: GUTTER,
    paddingBottom: SAFE.bottom + SPACE.sm,
  },
  largeMiddle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  largeLabel: { color: C.ink, fontSize: 34, ...font('bold') },
  largeHeadline: { color: C.accent, fontSize: 56, textAlign: 'center', ...font('heavy') },
  largeNumber: { fontSize: 120 },
  largeDetail: { color: C.ink, fontSize: 30, textAlign: 'center', ...font('bold') },
  arrow: { color: C.ink, fontSize: 96, marginTop: 8, ...font('heavy') },
});
