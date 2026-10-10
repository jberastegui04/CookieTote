# [We will decide at some point]

A mobile app that warns blind and low vision users about what's in their path. It works on any phone with no special hardware, using only the camera.

Most apps only warn about things they can name. This one uses depth to find anything physically in your way, at foot, waist, or head height, and tells you how far away it is and which side it's on.

## Features

**Describe mode.** Tap anywhere on the screen. The app takes one photo, finds the closest obstacle in your walking path, and speaks it, for example "chair, about one meter, slightly left" or "obstacle at head height, one meter ahead."

**Sonar mode.** A toggle you leave on while walking. The app checks depth about once a second and plays beeps and haptics that speed up as you get closer. A single beep in one ear means an obstacle on that side; a lower double beep in both ears means it's straight ahead, followed by a softer beep in the ear with more room. Under about 0.7 m straight ahead it says "Stop. Obstacle ahead, very close." Otherwise no speech, so you can keep moving. Readings are a second or two old, so warnings start a bit further out and you still walk carefully.

**Indoor and outdoor setting.** Applies to both modes. Swaps the depth model and the warning distance (about 2 m indoors, about 4 m outdoors).

**Limits.** This helps with stationary obstacles. It does not replace a cane, and outdoors it does not detect curbs, drop-offs, moving cars, or street crossings.

**Trusted voice.** Record a family member or friend for 30 seconds, with their consent, and warnings play in their voice (ElevenLabs instant cloning). Four premade voices are offered too.

**Built for VoiceOver.** Every element is labeled, every state is spoken or felt, and a two finger double tap (magic tap) repeats the last warning.

## How it works

1. The phone sends a photo to the backend.
2. Depth Anything V2 (Hugging Face) estimates distance for every pixel.
3. We check a lane down the middle of the frame, split into foot, waist, and head height, and find the closest thing within the warning distance.
4. An object detector adds a name if it recognizes the obstacle. If not, we still warn.
5. Describe mode builds a short sentence and ElevenLabs speaks it. Sonar mode only returns distance and direction, and the phone handles the beeps and haptics.

## Repo layout

```
backend/
  main.py           API server and endpoints (Juan)
  pipeline.py       depth, lane logic, detection (Michael)
  voice.py          ElevenLabs speech with a cache (Juan)
  tone.py           makes the left, center, and right sonar tones
  requirements.txt
  .env              API keys, never committed
app/                Expo app (Agustin for UI, Juan for networking, audio, haptics)
design/             link to the Figma file and exported screens (Agustin)
```

## API

Both endpoints take a POST with the photo as a form upload in a field called `image`, plus a `mode` field set to `indoor` or `outdoor` (defaults to `indoor`).

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

Fast result for sonar mode. Depth only, no detection, no speech. Called about once a second. Send small frames (around 384 px wide).

| Field | Type | Meaning |
|---|---|---|
| `clear` | boolean | true if nothing is in the path |
| `distance_m` | number or null | distance to the closest obstacle |
| `direction` | string or null | `left`, `ahead`, or `right` |
| `open` | string or null | `left` or `right` if that side has nothing within the warning distance, else null |

### GET /voices

The voices the app offers, cloned ones first, for example `{"default": "EXAV…", "voices": [{"id": "EXAV…", "name": "Sarah"}, …]}`.

### POST /voices/clone

Form upload: `audio` (a recording of about 30 seconds, m4a or wav) and `consent`, which must be `true`. Makes an ElevenLabs instant clone named "Trusted voice", replacing the previous one, and returns `{"id", "name"}`. Needs an ElevenLabs plan that includes instant voice cloning (Starter or above); on the free plan ElevenLabs refuses and the endpoint returns 502 with the reason.

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

The backend runs on a Hugging Face Space at `https://michaelmccamy-obstacle-alert-api.hf.space` (paid CPU upgrade on Michael's account credits, sleeps after an hour idle, so the first request after that takes about a minute). To redeploy after changing the backend, log in with a write token (`hf auth login`), then from `backend/` run `python deploy_space.py`. It uploads the code (never `.env`), copies the ElevenLabs key into the Space's secrets, and rebuilds in a few minutes.

### App

```
cd app
npm install
npx expo start
```

Scan the QR code with Expo Go. The app uses expo-camera, expo-speech, expo-haptics, and expo-audio (the replacement for expo-av). Add any new package with `npx expo install <package>`, not `npm install`.

Set `EXPO_PUBLIC_API_URL` in `app/.env` to the ngrok link or the deployed backend link.

## Accessibility rules

- Every touchable element has an `accessibilityLabel`, `accessibilityHint`, and `accessibilityRole`. The sonar toggle uses the switch role so VoiceOver says on or off.
- The camera overlay is visual only, so it's hidden from VoiceOver with `accessible={false}`.
- Status changes (scanning, sonar on, no connection) are announced with `AccessibilityInfo.announceForAccessibility`.
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

## Challenges

- Hugging Face Best Use of Open Source AI
- ElevenLabs
- Figma Best Design
- GoDaddy Registry domain
- DEV Writing Challenge (after the event)

**Stretch only.** Live sonar with LiDAR on Pro iPhones, and a Tiger Data hazard map. Adobe Prettiest Hack if ahead.

**How it's different.** Apple's distance features only work on Pro iPhones, and other apps only warn about things they can name. Ours works on any phone and warns about anything in your way.
