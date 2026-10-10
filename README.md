# [We will decide at some point]

A mobile app that warns blind and low vision users about what's in their path. It works on any phone with no special hardware.

Most apps only warn about things they can name. This one uses depth to find anything physically in your way, at foot, waist, or head height, and tells you how far away it is and which side it's on.

## Features

**Describe mode.** Tap anywhere on the screen. The app takes one photo, finds the closest obstacle in your walking path, and speaks it, for example "chair, about one meter, slightly left" or "obstacle at head height, one meter ahead."

**Sonar mode.** A toggle you leave on while walking. The app checks depth about once a second and plays beeps and haptics that speed up as you get closer. The tone plays from the obstacle's side (left, center, or right). No speech, so you can keep moving.

**Indoor and outdoor setting.** Applies to both modes. Swaps the depth model and the warning distance (about 2 m indoors, about 4 m outdoors).

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
  requirements.txt
  .env              API keys, never committed
app/                Expo app (Agustin for UI, Juan for networking, audio, haptics)
design/             link to the Figma file and exported screens (Agustin)
```

## API

Both endpoints take a POST with the photo as a form upload in a field called `image`, plus a `mode` field set to `indoor` or `outdoor` (defaults to `indoor`).

### POST /describe

Full result for describe mode. Slower, called once per tap.

| Field | Type | Meaning |
|---|---|---|
| `clear` | boolean | true if nothing is in the path within the warning distance |
| `sentence` | string | what to say, for example "chair, about one meter, slightly left" |
| `label` | string or null | object name if the detector recognized it, otherwise null |
| `distance_m` | number or null | distance to the closest obstacle, rounded to 0.5 m |
| `direction` | string or null | `left`, `ahead`, or `right` |
| `height` | string or null | `foot`, `waist`, or `head` |
| `box` | list of 4 numbers or null | obstacle outline for the overlay, as x, y, width, height in 0 to 1 of the image |
| `audio_b64` | string or null | ElevenLabs mp3 of the sentence, base64. Null until ElevenLabs is added, so the app falls back to expo-speech |

### POST /sonar

Fast result for sonar mode. Depth only, no detection, no speech. Called about once a second. Send small frames (around 384 px wide).

| Field | Type | Meaning |
|---|---|---|
| `clear` | boolean | true if nothing is in the path |
| `distance_m` | number or null | distance to the closest obstacle |
| `direction` | string or null | `left`, `ahead`, or `right` |

## Pipeline interface

`pipeline.py` exposes two functions that `main.py` imports.

| Function | Takes | Returns |
|---|---|---|
| `describe(image, mode)` | a PIL image and `indoor` or `outdoor` | a dict with the /describe fields except `audio_b64` |
| `sonar(image, mode)` | a PIL image and `indoor` or `outdoor` | a dict with the /sonar fields |

`main.py` adds `audio_b64` by sending the sentence to ElevenLabs. Until the real pipeline works, `pipeline.py` returns fake answers so the app can be built in parallel.

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
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

`requirements.txt` should include fastapi, uvicorn, python-multipart, transformers, torch, pillow, numpy, python-dotenv, and requests.

`main.py` starts the server itself on port 8000, so `python main.py` is all you need.

Put keys in `backend/.env` and never commit it.

```
HF_TOKEN=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
```

To reach the backend from a phone, run `ngrok http 8000` and share the link.

### App

```
cd app
npm install
npx expo install expo-camera expo-speech expo-haptics expo-av
npx expo start
```

Scan the QR code with Expo Go. Set `EXPO_PUBLIC_API_URL` in `app/.env` to the ngrok link or the deployed backend link.

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

**How it's different.** Apple's distance features only work on Pro iPhones, and other apps only warn about things they can name. Ours works on any phone and warns about anything in your way.
