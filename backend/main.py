import io
import time
from collections import deque

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool
from PIL import Image, ImageOps, UnidentifiedImageError

import pipeline
import voice

load_dotenv()
app = FastAPI(title="Obstacle Alert API")


# The models shrink everything to about 500 px, so anything bigger only costs decode time.
MAX_IMAGE_PX = 1280


def decode_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.draft("RGB", (MAX_IMAGE_PX, MAX_IMAGE_PX))  # JPEG decodes straight to a smaller size
    # Phone photos can be stored sideways with a rotation tag. Apply it so up is up.
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_IMAGE_PX, MAX_IMAGE_PX))
    return img


async def read_frame(image: UploadFile, mode: str, warning: str, units: str = "meters") -> tuple[Image.Image, str]:
    """Checks the settings, decodes the photo, and resolves mode "auto" to the scene it shows."""
    if mode not in ("indoor", "outdoor", "auto"):
        raise HTTPException(400, "mode must be indoor, outdoor, or auto")
    if warning not in pipeline.WARNING_SCALE:
        raise HTTPException(400, f"warning must be one of: {', '.join(pipeline.WARNING_SCALE)}")
    if units not in pipeline.UNITS:
        raise HTTPException(400, f"units must be one of: {', '.join(pipeline.UNITS)}")
    try:
        img = await run_in_threadpool(decode_image, await image.read())
    except UnidentifiedImageError:
        raise HTTPException(400, "image must be a photo")
    if mode == "auto":
        mode = await run_in_threadpool(pipeline.guess_scene, img)
    return img, mode


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/describe")
async def describe(
    image: UploadFile = File(...),
    mode: str = Form("indoor"),
    voice_id: str | None = Form(None),
    warning: str = Form("normal"),
    units: str = Form("meters"),
):
    img, mode = await read_frame(image, mode, warning, units)
    # Models run in a worker thread so a sonar frame and a tap don't wait on each other.
    result = await run_in_threadpool(pipeline.describe, img, mode, warning, units)
    result["scene"] = mode
    # Null if ElevenLabs is unavailable, so the app speaks the sentence with expo-speech.
    result["audio_b64"] = await run_in_threadpool(voice.speak_b64, result["sentence"], voice_id)
    return result


def guide_phrases() -> set[str]:
    """Every sentence guide mode can say, plus "Scanning.". Mirrors classify(), OPEN, and SCANNING in app/App.tsx."""
    # "Scanning." is said at the start of every tap-to-describe, in the same voice as the answer.
    phrases = {"Path looks open.", "Stop. Something right in front of you.", "Scanning."}
    phrases |= {f"Stop. Something right in front of you. More room on the {s}." for s in ("left", "right")}
    for where in ("ahead", "on your left", "on your right"):
        phrases.add(f"Something close {where}.")
        for m in range(1, 5):
            phrases.add(f"Something {where}, about {m} {'meter' if m == 1 else 'meters'}.")
        # Feet versions for the Units setting: whole feet, as pipeline.feet_words says them.
        for ft in range(1, 21):
            phrases.add(f"Something {where}, about {ft} {'foot' if ft == 1 else 'feet'}.")
    return phrases


# The Space is public, so /say only speaks guide and find phrases: otherwise anyone with the link
# could make a cloned trusted voice say anything, and spend the ElevenLabs credits doing it.
# Find mode's arrival line, one per target. Mirrors arrivalPhrase() in app/App.tsx.
ARRIVAL_PHRASES = {f"You're there. The {t} is right in front of you. Reach forward." for t in pipeline.FIND_TARGETS}
# Clock directions from the remembered heading. Mirrors clockPhrase() in app/App.tsx.
CLOCK_PHRASES = {f"{t.capitalize()} at {h} o'clock." for t in pipeline.FIND_TARGETS for h in range(1, 13)}
# Open-vocabulary targets ("door") can't be listed, so for those the app says "It" instead of the name.
CLOCK_PHRASES |= {f"It's at {h} o'clock." for h in range(1, 13)}
ARRIVAL_PHRASES |= {"You're there. It's right in front of you."}
GUIDE_PHRASES = guide_phrases() | pipeline.find_phrases() | ARRIVAL_PHRASES | CLOCK_PHRASES


@app.get("/say")
async def say(text: str, voice_id: str | None = None):
    """WAV of a guide-mode phrase in the chosen voice. Cached by (voice, text)."""
    text = text.strip()
    if text not in GUIDE_PHRASES:
        raise HTTPException(400, "not a guide phrase")
    wav = await run_in_threadpool(voice.speak_wav, text, voice_id)
    if wav is None:
        raise HTTPException(503, "voice unavailable")
    return Response(content=wav, media_type="audio/wav")


@app.get("/find/targets")
def find_targets():
    return {"targets": list(pipeline.FIND_TARGETS)}


@app.post("/find")
async def find(
    image: UploadFile = File(...),
    mode: str = Form("indoor"),
    target: str | None = Form(None),
    description: str | None = Form(None),
    warning: str = Form("normal"),
    units: str = Form("meters"),
):
    """target from the picker, and/or a description like "red bench" (which can name the target itself)."""
    description = (description or "").strip()[: pipeline.DESCRIPTION_MAX_CHARS] or None
    asked = (target or "").strip().lower() or None
    known = pipeline.target_from(asked if asked in pipeline.FIND_TARGETS else None, description)
    if known is None:
        # Not one of the 13 DETR knows: search for the words themselves ("door", "exit sign").
        known = pipeline.open_query(description or asked)
        if known is None:
            raise HTTPException(400, "say what to find in plain words, like 'door' or 'red bench'")
        description = None
    target = known
    img, mode = await read_frame(image, mode, warning, units)
    result = await run_in_threadpool(pipeline.find, img, mode, target, description, warning, units)
    result["scene"] = mode
    return result


# A spoken Find request is a few seconds. Both limits keep the public Space from being a free
# transcription service on the ElevenLabs credits.
TRANSCRIBE_MAX_BYTES = 500_000
TRANSCRIBE_PER_MINUTE = 20
_transcribe_times: deque[float] = deque()


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Spoken Find request ("find the red bench") -> text, target, and description for /find."""
    data = await audio.read()
    if not data or len(data) > TRANSCRIBE_MAX_BYTES:
        raise HTTPException(400, "send a short recording (a few seconds)")
    now = time.monotonic()
    while _transcribe_times and now - _transcribe_times[0] > 60:
        _transcribe_times.popleft()
    if len(_transcribe_times) >= TRANSCRIBE_PER_MINUTE:
        raise HTTPException(429, "too many requests, try again in a minute")
    _transcribe_times.append(now)
    try:
        text = await run_in_threadpool(
            voice.transcribe, data, audio.filename or "request.m4a", audio.content_type or "audio/m4a"
        )
    except requests.HTTPError as e:
        detail = e.response.text[:300] if e.response is not None else str(e)
        raise HTTPException(502, f"ElevenLabs speech-to-text refused: {detail}")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs unreachable: {e}")
    target, description = pipeline.parse_request(text)
    open_vocab = target is None
    if open_vocab:
        # Not one of the 13: /find searches for the words themselves ("door", "exit sign").
        target = pipeline.open_query(description)
    return {"text": text, "target": target, "description": description, "open_vocab": open_vocab and target is not None}


@app.get("/voices")
async def voices():
    return {"default": voice.default_voice_id(), "voices": await run_in_threadpool(voice.list_voices)}


@app.post("/voices/clone")
async def clone_voice(audio: UploadFile = File(...), consent: str = Form("false")):
    """Clone a trusted person's voice from a short recording. Needs an ElevenLabs plan with cloning."""
    if consent != "true":
        raise HTTPException(400, "consent must be true: only record a person who has agreed")
    data = await audio.read()
    if len(data) < 20_000:
        raise HTTPException(400, "recording too short")
    try:
        return await run_in_threadpool(
            voice.clone_voice, data, audio.filename or "voice.m4a", audio.content_type or "audio/m4a"
        )
    except voice.VoiceRejected as e:
        raise HTTPException(422, str(e))
    except requests.HTTPError as e:
        detail = e.response.text[:300] if e.response is not None else str(e)
        raise HTTPException(502, f"ElevenLabs refused the clone: {detail}")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs unreachable: {e}")


@app.get("/voices/{voice_id}/sample.wav")
async def voice_sample(voice_id: str):
    if voice_id not in {v["id"] for v in voice.list_voices()}:
        raise HTTPException(404, "unknown voice")
    wav = await run_in_threadpool(voice.speak_wav, voice.SAMPLE_SENTENCE, voice_id)
    if wav is None:
        raise HTTPException(503, "voice unavailable")
    return Response(content=wav, media_type="audio/wav")


@app.post("/sonar")
async def sonar(image: UploadFile = File(...), mode: str = Form("indoor"), warning: str = Form("normal")):
    img, mode = await read_frame(image, mode, warning)
    result = await run_in_threadpool(pipeline.sonar, img, mode, warning)
    result["scene"] = mode
    return result


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
