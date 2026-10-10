# Obstacle Alert

Hackathon project (Knight Hacks IX, 36 hours). Mobile app that warns blind and low vision users about stationary obstacles in their walking path, on any phone using only the camera. Team of three, all new to hackathons: favor the simplest thing that works, give exact commands, and push back on added scope. `README.md` has the full plan, schedule, and cut order.

## Features
- Describe mode: tap anywhere, one photo goes to `/describe`, the app speaks one short sentence ("chair, about one meter, slightly left").
- Guide mode (was sonar; the `/sonar` endpoint keeps its name): a toggle. About once a second the app sends a frame to `/sonar`, sorts the reading into open / far / close / stop with a direction, and a voice (the selected ElevenLabs voice via `GET /say`, cached; expo-speech fallback) speaks short general phrases only when the situation changes, plus a reminder every 5 s. Never talks over itself; only "stop" interrupts. One haptic on stop. No beeps or tones.
- Indoor / outdoor setting: swaps the depth model and the warning distance (2 m indoors, 4 m outdoors).

## Layout and owners
- `app/`: Expo SDK 57, React Native, TypeScript. Single screen in `App.tsx`. Agustin owns screens and overlay; Juan owns networking, audio, haptics. Read `app/AGENTS.md` before touching Expo APIs: they change every SDK, so check the versioned docs instead of trusting memory. Audio is `expo-audio` (not `expo-av`). Add packages with `npx expo install`, never `npm install <pkg>`.
- `backend/main.py` (Juan): FastAPI routes. `backend/voice.py` (Juan): ElevenLabs speech, cached by sentence. `python main.py` starts it on port 8000.
- `backend/pipeline.py` (Michael): `describe(image, mode)` and `sonar(image, mode)` take a PIL image and return a dict. Currently fake answers.
- `design/` (Agustin): Figma link and exported screens.

## API contract (keep app, backend, and README in sync; do not change field names)
Both endpoints: POST multipart with `image` (photo) and `mode` ("indoor" | "outdoor", defaults to indoor).

`POST /describe` returns `clear` (boolean), `sentence` (string), `label` (string | null), `distance_m` (number rounded to 0.5 | null), `direction` ("left" | "ahead" | "right" | null), `height` ("foot" | "waist" | "head" | null), `box` ([x, y, width, height], each 0 to 1 of the image | null), `audio_b64` (base64 ElevenLabs WAV | null; when null the app uses expo-speech). `main.py` adds `audio_b64`; the pipeline returns the rest.

`POST /describe` also takes an optional `voice_id` form field (an id from `GET /voices`).

`POST /sonar` returns `clear`, `distance_m`, `direction`, `open` only.

Both `/describe` and `/sonar` include `open` ("left" | "right" | null): a side column with nothing inside the warning distance. Sentences end with "More room on the left" when set (never "clear"). `GET /say?text=&voice_id=` returns a WAV of a short phrase for guide mode.

`GET /voices` returns `default` (id) and `voices` ([{id, name}], cloned first). `GET /voices/{id}/sample.wav` returns a sample WAV. `POST /voices/clone` (form: `audio`, `consent=true`) makes one ElevenLabs instant clone, "Trusted voice", replacing the previous one; needs a paid ElevenLabs plan. Voice clips are cached by (voice_id, sentence).

## Models (Hugging Face, public, no token)
- `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` and `...-Outdoor-Small-hf` for depth. Anything in a center lane closer than the warning distance counts, split into foot, waist, head bands.
- `facebook/detr-resnet-50` adds a label when it can. Warn even when unlabeled.
- ElevenLabs Flash speaks the sentence. Cache clips by sentence text. The key lives only in `backend/.env`.

## Accessibility rules (non-negotiable)
- Every touchable has `accessibilityLabel`, `accessibilityHint`, and `accessibilityRole`. The guide toggle uses the switch role. Test with VoiceOver on.
- The whole screen is the scan button. Never require precise taps. Magic tap repeats the last warning.
- Status changes are announced with `AccessibilityInfo.announceForAccessibility`. Nothing is shown only on screen. The camera overlay is hidden from VoiceOver.
- App audio starts a moment after a tap so it doesn't overlap VoiceOver.
- Blue (#0047B3) on white, matching the Figma file; colors live in `app/theme.ts`. Large bold text (Atkinson Hyperlegible Next once installed), contrast at least 7:1.
- Claims stay modest: stationary obstacles only; does not replace a cane; no curbs, drop-offs, moving cars, or street crossings.

## Conventions
- Small commits, push often. Never commit `.env`.
- Run `npx tsc --noEmit` in `app/` before pushing.
