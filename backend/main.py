import io

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


async def read_image(image: UploadFile, mode: str) -> Image.Image:
    if mode not in ("indoor", "outdoor"):
        raise HTTPException(400, "mode must be indoor or outdoor")
    try:
        return await run_in_threadpool(decode_image, await image.read())
    except UnidentifiedImageError:
        raise HTTPException(400, "image must be a photo")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/describe")
async def describe(
    image: UploadFile = File(...), mode: str = Form("indoor"), voice_id: str | None = Form(None)
):
    # Models run in a worker thread so a sonar frame and a tap don't wait on each other.
    result = await run_in_threadpool(pipeline.describe, await read_image(image, mode), mode)
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
    return phrases


# The Space is public, so /say only speaks guide and find phrases: otherwise anyone with the link
# could make a cloned trusted voice say anything, and spend the ElevenLabs credits doing it.
GUIDE_PHRASES = guide_phrases() | pipeline.find_phrases()


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
async def find(image: UploadFile = File(...), mode: str = Form("indoor"), target: str = Form(...)):
    target = target.strip().lower()
    if target not in pipeline.FIND_TARGETS:
        raise HTTPException(400, f"target must be one of: {', '.join(pipeline.FIND_TARGETS)}")
    return await run_in_threadpool(pipeline.find, await read_image(image, mode), mode, target)


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
async def sonar(image: UploadFile = File(...), mode: str = Form("indoor")):
    return await run_in_threadpool(pipeline.sonar, await read_image(image, mode), mode)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
