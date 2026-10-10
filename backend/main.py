import io

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, ImageOps, UnidentifiedImageError

import pipeline
from voice import speak_b64

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
async def describe(image: UploadFile = File(...), mode: str = Form("indoor")):
    result = pipeline.describe(await read_image(image, mode), mode)
    # Null if ElevenLabs is unavailable, so the app speaks the sentence with expo-speech.
    result["audio_b64"] = await run_in_threadpool(speak_b64, result["sentence"])
    return result


@app.post("/sonar")
async def sonar(image: UploadFile = File(...), mode: str = Form("indoor")):
    return pipeline.sonar(await read_image(image, mode), mode)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
