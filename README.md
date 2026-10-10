# Obstacle Alert

Hold the phone forward, tap anywhere, and hear what's in your path: "Cabinet door at head height, 1.5 meters, slightly left," with a tone panned toward it and haptics that get stronger as it gets closer. Built at Knight Hacks IX.

```
app/       Expo (React Native) phone app      Juan, Agustin
backend/   FastAPI + Hugging Face models      Michael
```

## Run the backend (laptop)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add keys
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Check http://localhost:8000/health. Right now `/analyze` returns a fake obstacle plus a real stereo tone, so the app works end to end before the models are in.

## Run the app (phone)

1. Install **Expo Go** on your phone. Phone and laptop on the same Wi-Fi.
2. Find the laptop's IP: `ipconfig getifaddr en0` (Mac).
3. Then:

```bash
cd app
cp .env.example .env          # set EXPO_PUBLIC_API_URL=http://<laptop IP>:8000
npm install
npx expo start
```

4. Scan the QR code with your phone camera. Tap anywhere: you should hear a tone in the left ear and see "1.5 m".

If venue Wi-Fi blocks phone-to-laptop traffic, use `npx expo start --tunnel` for the app and a tunnel (like ngrok) or a Hugging Face Space for the backend.

## Checkpoints

- **1am:** phone sends a photo and plays back audio (this skeleton already does it)
- **1pm:** full loop on a real phone over the deployed backend
- **6pm:** blindfold test together
- **11pm:** bulk done

## Rules

- Never commit `.env` or API keys.
- Pull before you start, commit small, push often.
- Keep VoiceOver on when testing the app.
