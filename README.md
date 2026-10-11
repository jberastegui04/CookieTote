# Cyclops

A mobile app that warns blind and low vision users about what's in their path. It works on any phone with no special hardware, using only the camera.

Most apps only warn about things they can name. This one uses depth to find anything physically in your way, at foot, waist, or head height, and tells you how far away it is and which side it's on.

## Features

**Describe mode.** Tap anywhere on the screen. The app takes one photo, finds the closest obstacle in your walking path, and speaks it, for example "chair, about one meter, slightly left" or "obstacle at head height, one meter ahead."

**Guide mode.** A toggle you leave on while walking. The app checks depth about once a second and a voice of your choosing (including a cloned trusted voice) tells you what changed, in short general phrases: "Something ahead, about 2 meters", "Something close on your left", "Stop. Something right in front of you. More room on the right", "Path looks open". It speaks only when the situation changes, with a reminder every few seconds while something is there, and never talks over itself. One buzz on "stop". No beeps. Readings are a second or two old, so warnings start a bit further out and you still walk carefully.

**Find mode.** Tap Find, pick an object (chair, table, person, and a few more), and the voice tells you which way to turn: "Chair, turn a little right and walk about 3 meters." (or "turn right" for a bigger turn), then "Straight ahead." the moment you're lined up. Once it has seen the object, the app remembers which way the phone was pointing (gyro), so when you turn away it says "Chair at 2 o'clock" and keeps pulsing toward it several times a second, stronger and faster as you face it, with a double pulse when you're lined up. Within reach, it dings and says "You're there. Reach forward." An obstacle right in front still says "Stop" over everything.

**Indoor and outdoor setting.** Applies to both modes. Swaps the depth model and the warning distance (about 2 m indoors, about 4 m outdoors).

**Limits.** This helps with stationary obstacles. It does not replace a cane, and outdoors it does not detect curbs, drop-offs, moving cars, or street crossings.

**Trusted voices.** Record family members or friends for 30 seconds each, with their consent, and warnings play in their voice (ElevenLabs instant cloning). Four premade voices are offered too.

**Built for VoiceOver.** Every element is labeled, every state is spoken or felt, and a two finger double tap (magic tap) repeats the last warning.

## How it works

1. The phone sends a photo to the backend.
2. Depth Anything V2 (Hugging Face) estimates distance for every pixel.
3. We check a lane down the middle of the frame, split into foot, waist, and head height, and find the closest thing within the warning distance.
4. An object detector adds a name if it recognizes the obstacle. If not, we still warn.
5. Describe mode builds a short sentence and ElevenLabs speaks it. Guide mode gets distance, direction and open side back about once a second, and the phone turns changes into short spoken phrases in the chosen voice.

## Repo layout

```
backend/
  main.py           API server and endpoints (Juan)
  pipeline.py       depth, lane logic, detection (Michael)
  voice.py          ElevenLabs speech with a cache (Juan)
  requirements.txt
  .env              API keys, never committed
app/                Expo app (Agustin for UI, Juan for networking, audio, haptics)
design/             link to the Figma file and exported screens (Agustin)
```

## API

`/describe`, `/sonar` and `/find` take a POST with the photo as a form upload in a field called `image`, plus these optional settings fields:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `indoor` (default), `outdoor`, `auto` | `auto` guesses the scene from the photo (SigLIP; right on all 25 venue photos) and every response says which it used in `scene` |
| `warning` | `close`, `normal` (default), `early` | the "Warn me" setting: warning distance indoors 1.5 / 2 / 3 m, outdoors 3 / 4 / 6 m |
| `units` | `meters` (default), `feet` | spoken sentences only (`/describe`, `/find`); `distance_m` is always meters |

Every response also includes `scene` (`indoor` or `outdoor`), the mode actually used.

### POST /describe

Full result for describe mode. Slower, called once per tap. Also takes an optional `voice_id` form field (one of the ids from `GET /voices`); if missing, the backend uses `ELEVENLABS_VOICE_ID` from `.env` or the first voice in the list.

| Field | Type | Meaning |
|---|---|---|
| `clear` | boolean | true if nothing is in the path within the warning distance |
| `sentence` | string | what to say, for example "chair, about one meter, slightly left" |
| `label` | string or null | object name if the detector recognized it, otherwise null |
| `distance_m` | number or null | distance to the closest obstacle, rounded to 0.5 m |
| `direction` | string or null | `left`, `ahead`, or `right` |
| `height` | string or null | `foot`, `waist`, or `head` |
| `box` | list of 4 numbers or null | obstacle outline for the overlay, as x, y, width, height in 0 to 1 of the image |
| `open` | string or null | `left` or `right` if that side of the lane has nothing within the warning distance, else null. The sentence ends with "More room on the left" when set (never "clear": it only checks a narrow strip and can't see low objects) |
| `audio_b64` | string or null | ElevenLabs WAV of the sentence (16 kHz mono, short silence at both ends), base64. Null if the key is missing or ElevenLabs fails, so the app falls back to expo-speech |

### POST /sonar

Fast result for guide mode (the endpoint keeps its old name). Depth only, no detection, no speech. Called about once a second. Send small frames (around 384 px wide).

| Field | Type | Meaning |
|---|---|---|
| `clear` | boolean | true if nothing is in the path |
| `distance_m` | number or null | distance to the closest obstacle |
| `direction` | string or null | `left`, `ahead`, or `right` |
| `open` | string or null | `left` or `right` if that side has nothing within the warning distance, else null |

### POST /find

Find mode: where a chosen object is, plus the usual obstacle reading from the same frame. Form upload: `image` (about 512 px wide, like guide frames), `mode`, and `target` (one of `GET /find/targets`) and/or `description` (free text up to 60 characters, like "red bench" or "person in a dark hoodie"). A description can name the target itself ("the red sofa" finds a couch); `target` is only required when it doesn't. With a description, every candidate of that object is scored against the words (SigLIP), and the best match wins. The sentence then says "Found it", "Possible match", or "No match yet", never the user's own words, so the cloned voice can't be made to say arbitrary text.

| Field | Type | Meaning |
|---|---|---|
| `found` | boolean | true if the target is in the frame |
| `target` | string | the object looked for (from `target`, or named in `description`) |
| `description` | string or null | the description, if one was sent |
| `match` | string or null | with a description: `yes` (score at least 0.1), `possible` (0.01 to 0.1), or `no`; for an open-vocabulary target: `yes` (OWLv2 score at least 0.4 and not a far-off speck), `possible` (0.2 to 0.4), or `no`; null for a plain known target |
| `candidates` | list | every candidate this frame (up to 5), best first; each has `box`, `score`, `bearing_deg`, `distance_m`. The first is the one `box` and `sentence` describe. The app's tracker (`app/tracker.ts`) uses them to keep following the same object across answers |
| `open_vocab` | boolean | true when the target isn't one of the 79 built-in objects and OWLv2 searched for the words instead |
| `match_score` | number or null | the best candidate's score against the description, 0 to 1 |
| `direction` | string or null | `left`, `ahead` (within 8° of center), or `right` |
| `bearing_deg` | number or null | degrees off center, right is positive, about -26 to 26; drives the centering haptic |
| `distance_m` | number or null | distance to the target, rounded to 0.5 |
| `centered` | boolean | within 5° of center: you're facing it |
| `box` | list of 4 numbers or null | the target's outline, x, y, width, height in 0 to 1 of the image |
| `sentence` | string | what to say, e.g. "Chair, turn a little right and walk about 3 meters." or "No chair yet. Turn slowly." |
| `obstacle` | object | the same fields as `/sonar` (the target itself left out) plus `box`, the obstacle's outline; a "Stop" from it wins over Find. Plus `low`: the nearest foot-height-only thing in the lane (`distance_m`, `direction`, `box`, `edge`, `open`) or null. `edge` is true when it reaches the bottom of the frame, about to slip out of view |
| `path` | object or null | when found: is the straight line to the target open? `clear`, `distance_m` (nearest thing in a corridor 0.4 m either side of the line, out to the target or 3.5 m), `side` (where it sits in the corridor), `pass` ("left" / "right" when that side was seen to have room, else null) |

### POST /transcribe

Spoken Find request to text (ElevenLabs speech-to-text, `scribe_v2`). Form upload: `audio`, a recording of a few seconds (m4a or wav, under 500 KB). Returns `{"text": "Find the red bench.", "target": "bench", "description": "red bench"}`: filler like "can you find me the … please" is dropped, and `target` is null when the request names nothing Find knows (for example "door"), so the app can say so. Then call `/find` with that `target` and `description`. Limited to 20 requests a minute so the public Space can't be used as a free transcription service. 502 if ElevenLabs refuses; the API key needs the **Speech to Text** permission.

### GET /find/targets

`{"targets": ["chair", "bench", …]}`, the 79 everyday objects DETR finds fast and reliably (all of COCO except "orange"). Anything else ("door", "exit sign", "trash can") also works: `/find` sends the words to OWLv2 (open-vocabulary, on the GPU) and answers with "Found it", "Possible match" or "No match yet", never the user's own words. `/transcribe` returns those words as `target` with `open_vocab: true`.

### GET /say?text=…&voice_id=…

A WAV of a guide or find phrase in the chosen voice. Only the app's own phrases are accepted (anything else is a 400), so nobody can make a cloned voice say arbitrary things through the public Space. 503 if ElevenLabs is unavailable, and the app then uses the phone's own voice. Cached by voice and text, so repeated phrases cost nothing.

Adding, renaming and deleting voices need an `X-App-Key` header matching `APP_KEY` on the server (the Space is public; this keeps strangers from deleting the trusted voices). The app sends it from `EXPO_PUBLIC_APP_KEY` in `app/.env`. With no `APP_KEY` set, as on a laptop, the check is off.

### GET /voices

The voices the app offers, cloned ones first, for example `{"default": "EXAV…", "voices": [{"id": "EXAV…", "name": "Sarah"}, …]}`.

### POST /voices/clone

Form upload: `audio` (a recording of about 30 seconds, m4a or wav) and `consent`, which must be `true`. Optional `name`. Adds an ElevenLabs instant clone next to the others (up to 5; unnamed ones are "Trusted voice", "Trusted voice 2", ...) and returns `{"id", "name", "custom": true}`. `POST /voices/{id}/name` (form: `name`) renames a trusted voice and `DELETE /voices/{id}` deletes one; both return 404 for the premade voices. `GET /voices` marks trusted voices with `"custom": true`. Needs an ElevenLabs plan that includes instant voice cloning (Starter or above); on the free plan ElevenLabs refuses and the endpoint returns 502 with the reason.

### GET /voices/{voice_id}/sample.wav

A WAV of a sample sentence in that voice, for the picker. Cached after the first call.

## Pipeline interface

`pipeline.py` exposes two functions that `main.py` imports.

| Function | Takes | Returns |
|---|---|---|
| `describe(image, mode)` | a PIL image and `indoor` or `outdoor` | a dict with the /describe fields except `audio_b64` |
| `sonar(image, mode)` | a PIL image and `indoor` or `outdoor` | a dict with the /sonar fields |

`main.py` adds `audio_b64` by sending the sentence to ElevenLabs (`voice.py`), which keeps repeated sentences in memory.

## Models

| Use | Model |
|---|---|
| Depth, indoor | `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` |
| Depth, outdoor | `depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf` |
| Object labels | `facebook/detr-resnet-50` |

Check each model card on Hugging Face if a name doesn't load.

## Setup

### Backend

```
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

You need Python 3.10 or newer (check with `python3 --version`).

`main.py` starts the server itself on port 8000, so `python main.py` is all you need. Check it with `curl http://localhost:8000/health`.

Copy `backend/.env.example` to `backend/.env`, fill in the keys, and never commit it. The keys stay on the backend only, never in the app.

```
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
```

The Hugging Face models are public, so they need no token.

To reach the backend from a phone, run `ngrok http 8000` and share the link.

### Deployed backend

The backend runs on a Hugging Face Space at `https://michaelmccamy-obstacle-alert-api.hf.space` (T4 GPU, about $0.40 an hour on Michael's account credits; `SPACE_HARDWARE` in `deploy_space.py` switches back to the CPU upgrade. Sleeps after an hour idle, so the first request after that takes about a minute). To redeploy after changing the backend, log in with a write token (`hf auth login`), then from `backend/` run `python deploy_space.py`. It uploads the code (never `.env`), copies the ElevenLabs key into the Space's secrets, and rebuilds in a few minutes.

### App

```
cd app
npm install
npx expo start
```

Scan the QR code with Expo Go. The app uses expo-camera, expo-speech, expo-haptics, and expo-audio (the replacement for expo-av). Add any new package with `npx expo install <package>`, not `npm install`.

Set `EXPO_PUBLIC_API_URL` in `app/.env` to the ngrok link or the deployed backend link.

## Accessibility rules

- Every touchable element has an `accessibilityLabel`, `accessibilityHint`, and `accessibilityRole`. The guide toggle uses the switch role so VoiceOver says on or off.
- The camera overlay is visual only, so it's hidden from VoiceOver with `accessible={false}`.
- Status changes (scanning, guide on, no connection) are announced with `AccessibilityInfo.announceForAccessibility`.
- Magic tap repeats the last warning.
- Nothing is shown only on screen. Every state is spoken or felt.
- Keep VoiceOver labels short and start app audio a moment after the tap so the two don't overlap.
- Every color passes 7 to 1 contrast.
- Test with VoiceOver on. Set the Accessibility Shortcut so a triple click of the side button toggles it.

## Team

| Person | Owns |
|---|---|
| Michael | Model pipeline in `pipeline.py`, depth, lane and height logic, detection labels, indoor and outdoor models, threshold tuning |
| Juan | API in `main.py`, ElevenLabs, deployment, app networking, sonar loop, tones, haptics |
| Agustin | Figma, app screens and overlay, onboarding, settings, VoiceOver labels with Juan, submission materials |

## Plan

| Time | Goal |
|---|---|
| Now to 12am | Repo, accounts, keys, read the rules |
| 12am to 2am | MVP. Tap, photo, real depth distance, spoken result |
| 2am | Checkpoint. MVP works on a real phone |
| 2am to 3am | Sonar endpoint, latency timing, list of app states |
| 3am to 9am | Sleep |
| 9am to 12pm | Height bands, labels, deploy, ElevenLabs, sonar loop, real main screen |
| 12pm | Checkpoint. Both modes work on the deployed backend with the real UI |
| 1pm to 4pm | Indoor and outdoor, direction tones, haptics, magic tap, onboarding, settings, VoiceOver |
| 4pm | Checkpoint. All main features in |
| 4pm to 6pm | Latency, voice cloning if stable, sound and haptics page, icon, animation |
| 6pm to 7pm | Dinner and blindfold test |
| 7pm to 8pm | Fixes, stable demo build, outdoor clip |

**Cut order if behind.** Voice cloning, then outdoor mode, then settings, then onboarding. Never cut describe, sonar, or the main screen.

**Backlog (after the demo).** One LLM call per Find request (not per frame) to map a free description like "my MacBook" or "the thing I drink from" onto the built-in object names, falling back to open-vocabulary words. Per-frame vision models are too slow for the 2 fps loop and give no box or distance.

## Challenges

- Hugging Face Best Use of Open Source AI
- ElevenLabs
- Figma Best Design
- GoDaddy Registry domain
- DEV Writing Challenge (after the event)

**Stretch only.** Live sonar with LiDAR on Pro iPhones, and a Tiger Data hazard map. Adobe Prettiest Hack if ahead.

**How it's different.** Apple's distance features only work on Pro iPhones, and other apps only warn about things they can name. Ours works on any phone and warns about anything in your way.
