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


async def read_image(image: UploadFile, mode: str) -> Image.Image:
    if mode not in ("indoor", "outdoor"):
        raise HTTPException(400, "mode must be indoor or outdoor")
    try:
        img = Image.open(io.BytesIO(await image.read()))
        # Phone photos can be stored sideways with a rotation tag. Apply it so up is up.
        return ImageOps.exif_transpose(img).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(400, "image must be a photo")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/describe")
async def describe(
    image: UploadFile = File(...), mode: str = Form("indoor"), voice_id: str | None = Form(None)
):
    result = pipeline.describe(await read_image(image, mode), mode)
    # Null if ElevenLabs is unavailable, so the app speaks the sentence with expo-speech.
    result["audio_b64"] = await run_in_threadpool(voice.speak_b64, result["sentence"], voice_id)
    return result


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
    return pipeline.sonar(await read_image(image, mode), mode)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
