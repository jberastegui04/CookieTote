import io

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

import pipeline

load_dotenv()
app = FastAPI(title="Obstacle Alert API")


async def read_image(image: UploadFile, mode: str) -> Image.Image:
    if mode not in ("indoor", "outdoor"):
        raise HTTPException(400, "mode must be indoor or outdoor")
    try:
        return Image.open(io.BytesIO(await image.read())).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(400, "image must be a photo")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/describe")
async def describe(image: UploadFile = File(...), mode: str = Form("indoor")):
    result = pipeline.describe(await read_image(image, mode), mode)
    # TODO (Juan): ElevenLabs mp3 of result["sentence"] as base64 (cache by sentence text).
    # Null for now, so the app speaks the sentence with expo-speech.
    result["audio_b64"] = None
    return result


@app.post("/sonar")
async def sonar(image: UploadFile = File(...), mode: str = Form("indoor")):
    return pipeline.sonar(await read_image(image, mode), mode)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
