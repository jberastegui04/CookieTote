# Cyclops

Cyclops helps blind and low vision people get around indoors using only their phone's camera. It warns about anything in their path, says how far away it is and which side it's on, and can guide them to a specific object like a chair, a door, or "the red bench."

It works on any phone. No LiDAR, no extra hardware.

Built in a weekend at Knight Hacks IX (October 2026).

## Why

Most assistive camera apps tell you what's around you, and they only warn about things they can name. Apple's distance features need a Pro iPhone with LiDAR, and a cane misses anything above waist height.

Cyclops uses depth instead of labels. If something is physically in your way at foot, waist, or head height, it warns you, whether or not it knows what the thing is.

## Features

**Describe.** Tap anywhere and hear one sentence, like "Chair, about 1 meter, slightly left."

**Guide.** Leave it on while you walk. It speaks only when something changes, with short phrases like "Something ahead, about 2 meters" or "Stop. Something right in front of you. More room on the right." One buzz on stop.

**Find.** Say or pick what you're looking for. Turn slowly until it locks on with a chime, then follow the voice ("Turn a little right and walk about 3 meters"). It checks whether the path to the target is open, steers you around things in the way, calls out low obstacles early, and tells you where to reach when you arrive.

**Walker.** A voice assistant. Press and hold anywhere and say things like "find the door," "start walking," or "repeat that." He also walks new users through setup.

**Trusted voices.** With their consent, record a family member or friend for 30 seconds and warnings play in their voice. The app only ever speaks its own phrases, so a cloned voice can't be made to say anything else.

**Built for VoiceOver.** Every control is labeled and every state is spoken or felt. Distances can be spoken in meters or feet, and the warning distance can be set closer or earlier.

## How it works

The phone sends camera frames to a backend running on a Hugging Face Space with a T4 GPU. Depth Anything V2 estimates the distance to every pixel, and the backend checks a walking lane down the middle of the frame, split into foot, waist, and head height. DETR names common objects, OWLv2 finds anything else by name, and SigLIP matches descriptions. The phone turns the result into speech, tones, and haptics, and uses its gyroscope to remember where a target is when you turn away.

| Use | Model |
|---|---|
| Depth | Depth Anything V2 Metric (indoor and outdoor) |
| Object labels | DETR ResNet-50 |
| Find anything by name | OWLv2 |
| Find by description | SigLIP |
| Speech, speech to text, voice cloning | ElevenLabs |

The app is built with Expo (React Native), and the backend with FastAPI and PyTorch.

## Running it

### Backend

Needs Python 3.10 or newer.

```
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Fill in `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `backend/.env`. The server starts on port 8000.

### App

```
cd app
npm install
npx expo start --tunnel
```

Set `EXPO_PUBLIC_API_URL` in `app/.env` to your backend's URL, then scan the QR code with Expo Go.

## Limits

Cyclops is for stationary obstacles and does not replace a cane. It does not detect curbs, drop-offs, moving cars, or street crossings. Depth from a single camera is unreliable a few inches from blank surfaces, on shiny floors, and right near the ground.
