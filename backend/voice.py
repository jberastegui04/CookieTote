"""ElevenLabs speech for the describe sentence (Juan). Returns base64 WAV, or None so the app uses expo-speech."""
import base64
import io
import os
import wave

import requests

# Flash is ElevenLabs' low-latency model.
MODEL_ID = "eleven_flash_v2_5"
# "Sarah" (premade, reassuring). Set ELEVENLABS_VOICE_ID in .env to use another voice.
DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"
# Raw 16 kHz audio, wrapped in a WAV below. Plenty for speech, and no decoder delay on the phone.
SAMPLE_RATE = 16000
# ElevenLabs clips start speaking almost immediately. The phone's player can clip the first and
# last syllable while it spins up and winds down, so pad both ends with silence.
PAD_S = 0.2

# Sentences repeat a lot ("Path clear"), so keep clips in memory and skip the API call next time.
_cache: dict[str, str] = {}


def _to_wav(pcm: bytes) -> bytes:
    pad = b"\x00\x00" * int(SAMPLE_RATE * PAD_S)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pad + pcm + pad)
    return buf.getvalue()


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
            params={"output_format": f"pcm_{SAMPLE_RATE}"},
            headers={"xi-api-key": key},
            json={"text": sentence, "model_id": MODEL_ID},
            timeout=5,
        )
        res.raise_for_status()
    except requests.RequestException as e:
        print(f"ElevenLabs failed, app will use expo-speech: {e}")
        return None
    _cache[sentence] = base64.b64encode(_to_wav(res.content)).decode()
    return _cache[sentence]
