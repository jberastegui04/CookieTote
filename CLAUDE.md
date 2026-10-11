# Obstacle Alert

Hackathon project (Knight Hacks IX, 36 hours). Mobile app that warns blind and low vision users about stationary obstacles in their walking path, on any phone using only the camera. Team of three, all new to hackathons: favor the simplest thing that works, give exact commands, and push back on added scope. `README.md` has the full plan, schedule, and cut order.

## Features
- Describe mode: tap anywhere, one photo goes to `/describe`, the app speaks one short sentence ("chair, about one meter, slightly left").
- Guide mode (was sonar; the `/sonar` endpoint keeps its name): a toggle. About once a second the app sends a frame to `/sonar`, sorts the reading into open / far / close / stop with a direction, and a voice (the selected ElevenLabs voice via `GET /say`, cached; expo-speech fallback) speaks short general phrases only when the situation changes, plus a reminder every 5 s. Never talks over itself; only "stop" interrupts. One haptic on stop. No beeps or tones.
- Find mode: tap Find, pick a target from `GET /find/targets`, frames go to `POST /find` (same frame loop as the guide). The voice speaks `sentence` on change or every 3 s; once seen, the target's heading is remembered from the gyro (expo-sensors DeviceMotion yaw, `YAW_SIGN` to flip); out of view the app says "Chair at 2 o'clock" and a gyro pulse loop runs (stronger and faster toward 0, double pulse when centered); within 0.7 m centered it dings and says the arrival phrase. Clock and arrival phrases are on the `/say` allow-list in `main.py`. While walking (Approach phase), a close or stop `obstacle` starts a detour: "Something close on your right. Step to your left." (toward `open`, else away from the obstacle), target phrases and pulses muted, then "Clear. Now turn right until it's in front of you." after 2 clear answers; "Still blocked. Back up a step." after 8 s. Detour phrases are `DETOUR_PHRASES` in `main.py`. Up and down: while the target's box sits low or high in the picture (center past 0.72 / 0.28) in Approach the voice says "Tilt the phone down a little." (or up), and if it vanishes right after, "It's below the camera. Tilt the phone down." for up to 10 s instead of counting misses (`FRAMING_PHRASES` in `main.py`). Guide and Find never run together.
- Indoor / outdoor setting: swaps the depth model and the warning distance (2 m indoors, 4 m outdoors).

## Layout and owners
- `app/`: Expo SDK 57, React Native, TypeScript. Single screen in `App.tsx`. Agustin owns screens and overlay; Juan owns networking, audio, haptics. Read `app/AGENTS.md` before touching Expo APIs: they change every SDK, so check the versioned docs instead of trusting memory. Audio is `expo-audio` (not `expo-av`). Add packages with `npx expo install`, never `npm install <pkg>`.
- `backend/main.py` (Juan): FastAPI routes. `backend/voice.py` (Juan): ElevenLabs speech, cached by sentence. `python main.py` starts it on port 8000.
- `backend/pipeline.py` (Michael): `describe(image, mode)` and `sonar(image, mode)` take a PIL image and return a dict. Currently fake answers.
- `design/` (Agustin): Figma link and exported screens.

## API contract (keep app, backend, and README in sync; do not change field names)
`/describe`, `/sonar`, `/find`: POST multipart with `image` (photo), plus optional `mode` ("indoor" | "outdoor" | "auto", default indoor; auto guesses the scene), `warning` ("close" | "normal" | "early", scales the 2 m / 4 m warning distance by 0.75 / 1 / 1.5), and `units` ("meters" | "feet", spoken sentences only; `distance_m` stays meters). Every response includes `scene` ("indoor" | "outdoor"), the mode actually used. Feet guide phrases ("Something ahead, about 6 feet.") are on the /say allowlist.

`POST /describe` returns `clear` (boolean), `sentence` (string), `label` (string | null), `distance_m` (number rounded to 0.5 | null), `direction` ("left" | "ahead" | "right" | null), `height` ("foot" | "waist" | "head" | null), `box` ([x, y, width, height], each 0 to 1 of the image | null), `audio_b64` (base64 ElevenLabs WAV | null; when null the app uses expo-speech). `main.py` adds `audio_b64`; the pipeline returns the rest.

`POST /describe` also takes an optional `voice_id` form field (an id from `GET /voices`).

`POST /sonar` returns `clear`, `distance_m`, `direction`, `open` only.

Both `/describe` and `/sonar` include `open` ("left" | "right" | null): a side column with nothing inside the warning distance. Sentences end with "More room on the left" when set (never "clear"). `GET /say?text=&voice_id=` returns a WAV of a guide or find phrase; it only accepts the app's own phrases (`GUIDE_PHRASES` in `backend/main.py`), so new spoken wording must be added there. Everything the app says goes through the chosen voice, including status messages from `tell()` (`STATUS_PHRASES`); the phone's own voice is only a fallback when ElevenLabs is unavailable or the phrase isn't listed.

`POST /transcribe` takes `audio` (a few seconds, under 500 KB) and returns `text`, `target` (null if nothing Find knows), and `description`, ready for `/find`. Uses ElevenLabs speech-to-text with speaker labels: if several people are heard, it keeps the one who said "find" / "where is" (else the first speaker) and drops words before the last one. `target` is null when an unknown object is described in more than 4 words (likely overheard talk); the app asks again. The key needs the Speech to Text permission.

Walker (voice control, Agustin; `app/Walker.tsx`, `app/walkerCommands.ts`): press and hold anywhere (the camera screen or the Find screen; Find pauses) or tap the Walker button, then say a command. It records until a pause, sends it to `POST /transcribe`, and maps `text` to a fixed command (find, start walking / stop, describe, repeat, settings, units, warn me, use <voice>, help). No always-on listening (a hands-free "Hey Walker" was tried and dropped as unreliable). Press and hold used to repeat the last warning; that's now "Walker, repeat that", or the magic tap with VoiceOver. He speaks his lines (`LINES`, mirrored by `WALKER_PHRASES` on the /say list) in his own ElevenLabs voice "Chris" (`WALKER_VOICE_ID`), never the chosen guide voice; a built-in American iOS voice if that fails; VoiceOver announcements when VoiceOver is on. Safety speech wins: he waits for the guide or Find, routine guide sentences hold while he listens, and a Stop, close or detour warning cuts him off.

`POST /find` (Find mode) takes `image`, `mode`, `target` (from `GET /find/targets`) and/or `description` (free text like "red bench"; it can name the target itself) and returns `found`, `target`, `description`, `match` ("yes" | "possible" | "no" | null), `match_score`, `direction`, `bearing_deg` (right positive), `distance_m`, `centered`, `box`, `sentence`, and `obstacle` (the `/sonar` fields; its "Stop" wins over Find; the target's own pixels are left out). `obstacle.low` is the nearest foot-height-only thing in the lane (`distance_m`, `direction`, `box`, `edge`, `open`) or null; `edge` means it reaches the bottom of the frame. In Approach the app detours around a low one from 2 m or at the edge ("Something low ahead. Step to your left."), and holds the detour 3 s after it drops out of view. The 79 COCO objects in `pipeline.FIND_TARGETS` (everything DETR was trained on except "orange", a color word) use DETR; any other plain-words target goes to OWLv2 (`open_vocab: true`), and its sentences are the generic "Found it / Possible match / No match yet". For open-vocab targets the app must say "It's at 3 o'clock." and "You're there. It's right in front of you." (the target name can't be on the /say allowlist).

`GET /voices` returns `default` (id) and `voices` ([{id, name, custom}], cloned first; `custom` is true for trusted voices). `GET /voices/{id}/sample.wav` returns a sample WAV. `POST /voices/clone` (form: `audio`, `consent=true`, optional `name`) adds an ElevenLabs instant clone ("Trusted voice", "Trusted voice 2", ... when unnamed), up to 5; needs a paid ElevenLabs plan. `POST /voices/{id}/name` (form: `name`) renames a trusted voice and `DELETE /voices/{id}` deletes one; both 404 for the premade voices. Voice clips are cached by (voice_id, sentence). Clone, rename and delete need header `X-App-Key` = `APP_KEY` (server env / Space secret), which the app sends from `EXPO_PUBLIC_APP_KEY`.

## Models (Hugging Face, public, no token)
- `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` and `...-Outdoor-Small-hf` for depth. Anything in a center lane closer than the warning distance counts, split into foot, waist, head bands.
- `facebook/detr-resnet-50` adds a label when it can. Warn even when unlabeled.
- ElevenLabs Flash speaks the sentence. Cache clips by sentence text. The key lives only in `backend/.env`.

## Accessibility rules (non-negotiable)
- Every touchable has `accessibilityLabel`, `accessibilityHint`, and `accessibilityRole`. The guide toggle uses the switch role. Test with VoiceOver on.
- The whole screen is the scan button. Never require precise taps. Magic tap repeats the last warning.
- Status changes are announced with `AccessibilityInfo.announceForAccessibility`. Nothing is shown only on screen. The camera overlay is hidden from VoiceOver.
- App audio starts a moment after a tap so it doesn't overlap VoiceOver.
- Yellow (#FFD60A) on near-black (#0B0B0C), dark text on yellow buttons; colors live in `app/theme.ts` (use `C.*`, no hard-coded hex). Large bold text (Atkinson Hyperlegible Next once installed), contrast at least 7:1.
- Claims stay modest: stationary obstacles only; does not replace a cane; no curbs, drop-offs, moving cars, or street crossings.

## Conventions
- Small commits, push often. Never commit `.env`.
- Run `npx tsc --noEmit` in `app/` before pushing.
