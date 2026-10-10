"""ElevenLabs speech for the describe sentence (Juan). Returns base64 mp3, or None so the app uses expo-speech."""
import base64
import os

import requests

# Flash is ElevenLabs' low-latency model.
MODEL_ID = "eleven_flash_v2_5"
# "Sarah" (premade, reassuring). Set ELEVENLABS_VOICE_ID in .env to use another voice.
DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"

# Sentences repeat a lot ("Path clear"), so keep clips in memory and skip the API call next time.
_cache: dict[str, str] = {}


def speak_b64(sentence: str) -> str | None:
    if sentence in _cache:
        return _cache[sentence]
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        return None
    voice_id = os.getenv("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE_ID
    try:
        res = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            params={"output_format": "mp3_44100_64"},
            headers={"xi-api-key": key},
            json={"text": sentence, "model_id": MODEL_ID},
            timeout=5,
        )
        res.raise_for_status()
    except requests.RequestException as e:
        print(f"ElevenLabs failed, app will use expo-speech: {e}")
        return None
    _cache[sentence] = base64.b64encode(res.content).decode()
    return _cache[sentence]
