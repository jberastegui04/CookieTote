# Obstacle Alert

Hackathon project (Knight Hacks IX, 36 hours). Mobile app that warns blind and low vision users about stationary obstacles in their walking path, with spoken distance and direction, a stereo tone panned toward the obstacle, and haptics.

## Layout
- `app/`: Expo SDK 57, React Native, TypeScript. Single screen in `App.tsx`. Read `app/AGENTS.md` before touching Expo APIs: they change every SDK, so check the versioned docs instead of trusting memory. Add packages with `npx expo install`, never `npm install <pkg>`.
- `backend/`: Python FastAPI. `main.py` (routes), `pipeline.py` (depth + detection, currently a stub), `tone.py` (stereo tone).

## API contract (keep app and backend in sync)
`POST /analyze` multipart: `image` (jpeg), `mode` ("indoor" | "outdoor")
Returns JSON: `sentence`, `distance_m` (number | null), `direction` ("left" | "center" | "right" | null), `height_band` ("foot" | "waist" | "head" | null), `label` (string | null), `audio_url` (path to a WAV).

## Plan
- Depth Anything V2 metric model (indoor or outdoor variant by mode) finds anything in a center lane closer than 2 m indoors / 4 m outdoors, split into foot, waist, head bands. An object detector adds a label when it can. Warn even when unlabeled.
- ElevenLabs Flash model speaks the sentence. Cache clips by sentence text so repeats are instant.
- Target end-to-end latency under 3 seconds.

## Accessibility rules (non-negotiable)
- Every touchable has `accessibilityLabel` and `accessibilityRole`. Test with VoiceOver on.
- Black background, yellow accent (#FFD60A), large bold type, contrast at least 7:1.
- The whole screen is the scan button. Never require precise taps.
- Spoken feedback for waiting, nothing found, and no connection.
- Claims stay modest: helps with stationary obstacles; does not replace a cane or help with street crossings.

## Conventions
- Small commits, push often. Never commit `.env`.
- Run `npx tsc --noEmit` in `app/` before pushing.
