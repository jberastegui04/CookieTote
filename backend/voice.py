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
    # Walker, the voice assistant, and the app's default voice ("Chris": relaxed, American). Mirrors
    # WALKER_VOICE_ID in app/App.tsx.
    {"id": "iP95p4xoKVk53GoZ742B", "name": "Walker"},
    {"id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah"},
    {"id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice"},
    {"id": "SAz9YHcvj6GT2YYXdXww", "name": "River"},
    {"id": "JBFqnCBsd6RMkjVDRZzb", "name": "George"},
]
SAMPLE_SENTENCE = "Chair, about 1 meter, slightly left"


def sample_sentence(name: str) -> str:
    """What a voice says when you tap it in the app: its own name first, so you know which one it is."""
    return f"Hi, I'm {name}. {SAMPLE_SENTENCE}."
# Cloned voices, recorded in the app from trusted people who agreed to it. New ones are named
# "Trusted voice", "Trusted voice 2", ... until the user renames them in Settings.
CLONE_NAME = "Trusted voice"
MAX_CLONES = 5
NAME_MAX_CHARS = 30
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
    """Cloned voices first (custom: true, the app can rename or delete them), then the premade list."""
    return [{**v, "custom": True} for v in cloned_voices()] + [{**v, "custom": False} for v in VOICES]


def _clone_name(existing: list[dict]) -> str:
    taken = {v["name"] for v in existing}
    n = 1
    while (name := CLONE_NAME if n == 1 else f"{CLONE_NAME} {n}") in taken:
        n += 1
    return name


def _custom_id(voice_id: str) -> None:
    """Raises KeyError unless the id is one of the cloned voices (never touch the premade ones)."""
    if voice_id not in {v["id"] for v in cloned_voices()}:
        raise KeyError(voice_id)


def rename_voice(voice_id: str, name: str) -> dict:
    _custom_id(voice_id)
    # The edit endpoint wants multipart form data; files=(None, value) sends a plain field that way.
    res = requests.post(
        f"https://api.elevenlabs.io/v1/voices/{voice_id}/edit",
        headers=_headers(),
        files={"name": (None, name)},
        timeout=10,
    )
    res.raise_for_status()
    return {"id": voice_id, "name": name, "custom": True}


def delete_voice(voice_id: str) -> None:
    _custom_id(voice_id)
    res = requests.delete(f"https://api.elevenlabs.io/v1/voices/{voice_id}", headers=_headers(), timeout=10)
    res.raise_for_status()
    for key in [k for k in _cache if k[0] == voice_id]:
        del _cache[key]


def clone_voice(audio: bytes, filename: str, content_type: str, name: str = "") -> dict:
    """Instant voice clone from one recording, added next to the others. Raises on failure."""
    existing = cloned_voices()
    if len(existing) >= MAX_CLONES:
        raise VoiceRejected(f"You have {MAX_CLONES} trusted voices. Delete one in Settings first.")
    name = name.strip()[:NAME_MAX_CHARS] or _clone_name(existing)
    res = requests.post(
        "https://api.elevenlabs.io/v1/voices/add",
        headers=_headers(),
        data={
            "name": name,
            "description": "Cyclops. Recorded in the app with the speaker's consent.",
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
    return {"id": voice_id, "name": name, "custom": True}


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


# Speech to text for "find the red bench" (Michael). The key needs the Speech to Text permission.
STT_MODEL_ID = "scribe_v2"


def transcribe(audio: bytes, filename: str, content_type: str) -> tuple[str, list[str]]:
    """Text of a short spoken request, and what each voice said (in the order they first spoke), so
    the caller can keep the user's words when someone nearby is talking too. Raises requests
    exceptions on failure."""
    res = requests.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers=_headers(),
        data={"model_id": STT_MODEL_ID, "diarize": "true", "tag_audio_events": "false"},
        files={"file": (filename, audio, content_type)},
        timeout=15,
    )
    res.raise_for_status()
    body = res.json()
    by_speaker: dict[str, list[str]] = {}
    for w in body.get("words") or []:
        if w.get("type") == "word":
            by_speaker.setdefault(w.get("speaker_id") or "", []).append(w["text"])
    return (body.get("text") or "").strip(), [" ".join(ws) for ws in by_speaker.values()]
