"""ElevenLabs speech for the describe sentence (Juan). Returns base64 WAV, or None so the app uses expo-speech."""
import base64
import io
import os
import time
import wave

import requests

# Flash is ElevenLabs' low-latency model.
MODEL_ID = "eleven_flash_v2_5"
# Short list for the app's voice picker. All premade ElevenLabs voices. The first is the default
# unless ELEVENLABS_VOICE_ID is set in .env.
VOICES = [
    {"id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah"},
    {"id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice"},
    {"id": "SAz9YHcvj6GT2YYXdXww", "name": "River"},
    {"id": "JBFqnCBsd6RMkjVDRZzb", "name": "George"},
]
SAMPLE_SENTENCE = "Chair, about 1 meter, slightly left"
# One cloned voice at a time, recorded in the app from a trusted person who agreed to it.
CLONE_NAME = "Trusted voice"
# Raw 16 kHz audio, wrapped in a WAV below. Plenty for speech, and no decoder delay on the phone.
SAMPLE_RATE = 16000
# ElevenLabs clips start speaking almost immediately. The phone's player can clip the first and
# last syllable while it spins up and winds down, so pad both ends with silence.
PAD_S = 0.2

# Sentences repeat a lot ("Path clear"), so keep clips in memory and skip the API call next time.
_cache: dict[tuple[str, str], bytes] = {}  # (voice_id, sentence) -> WAV bytes


def default_voice_id() -> str:
    return os.getenv("ELEVENLABS_VOICE_ID") or VOICES[0]["id"]


def _headers() -> dict:
    return {"xi-api-key": os.getenv("ELEVENLABS_API_KEY", "")}


def cloned_voices() -> list[dict]:
    """Voices cloned on this ElevenLabs account, newest first. Empty if the call fails."""
    try:
        res = requests.get("https://api.elevenlabs.io/v1/voices", headers=_headers(), timeout=5)
        res.raise_for_status()
    except requests.RequestException as e:
        print(f"ElevenLabs voice list failed: {e}")
        return []
    cloned = [v for v in res.json()["voices"] if v.get("category") == "cloned"]
    return [{"id": v["voice_id"], "name": v["name"]} for v in reversed(cloned)]


def list_voices() -> list[dict]:
    """Cloned voices first, then the premade list."""
    return cloned_voices() + VOICES


def clone_voice(audio: bytes, filename: str, content_type: str) -> dict:
    """Instant voice clone from one recording. Replaces the previous clone. Raises on failure."""
    for old in cloned_voices():
        if old["name"] == CLONE_NAME:
            requests.delete(f"https://api.elevenlabs.io/v1/voices/{old['id']}", headers=_headers(), timeout=5)
    res = requests.post(
        "https://api.elevenlabs.io/v1/voices/add",
        headers=_headers(),
        data={
            "name": CLONE_NAME,
            "description": "Obstacle Alert. Recorded in the app with the speaker's consent.",
            "remove_background_noise": "true",
        },
        files={"files": (filename, audio, content_type)},
        timeout=60,
    )
    res.raise_for_status()
    voice_id = res.json()["voice_id"]
    # ElevenLabs checks new clones in the background and may refuse to speak with one (for example a
    # recording of another AI voice). Try once now so the app hears about it, instead of silently
    # falling back to the phone's voice later.
    time.sleep(2)
    try:
        _tts_wav(SAMPLE_SENTENCE, voice_id)
    except requests.HTTPError as e:
        requests.delete(f"https://api.elevenlabs.io/v1/voices/{voice_id}", headers=_headers(), timeout=5)
        detail = e.response.json().get("detail", {}) if e.response is not None else {}
        if isinstance(detail, dict) and detail.get("code") == "voice_access_denied":
            raise VoiceRejected("ElevenLabs flagged this recording. Record a real person in a quiet room.")
        raise
    return {"id": voice_id, "name": CLONE_NAME}


class VoiceRejected(Exception):
    pass


def _to_wav(pcm: bytes) -> bytes:
    pad = b"\x00\x00" * int(SAMPLE_RATE * PAD_S)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pad + pcm + pad)
    return buf.getvalue()


def _tts_wav(sentence: str, voice_id: str) -> bytes:
    """WAV bytes for the sentence. Raises requests.RequestException on failure."""
    if (voice_id, sentence) in _cache:
        return _cache[voice_id, sentence]
    res = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": f"pcm_{SAMPLE_RATE}"},
        headers=_headers(),
        json={"text": sentence, "model_id": MODEL_ID},
        timeout=5,
    )
    res.raise_for_status()
    _cache[voice_id, sentence] = _to_wav(res.content)
    return _cache[voice_id, sentence]


def speak_wav(sentence: str, voice_id: str | None = None) -> bytes | None:
    """WAV bytes for the sentence, or None if ElevenLabs is unavailable."""
    if not os.getenv("ELEVENLABS_API_KEY"):
        return None
    try:
        return _tts_wav(sentence, voice_id or default_voice_id())
    except requests.RequestException as e:
        print(f"ElevenLabs failed, app will use expo-speech: {e}")
        return None


def speak_b64(sentence: str, voice_id: str | None = None) -> str | None:
    wav = speak_wav(sentence, voice_id)
    return base64.b64encode(wav).decode() if wav else None
