import io
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image

from pipeline import analyze_image, to_sentence
from tone import make_tone

load_dotenv()
app = FastAPI(title="Obstacle Alert API")

# In-memory audio clips for the demo. Fine for a hackathon, not for production.
AUDIO: dict[str, bytes] = {}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/analyze")
async def analyze(image: UploadFile = File(...), mode: str = Form("indoor")):
    if mode not in ("indoor", "outdoor"):
        raise HTTPException(400, "mode must be indoor or outdoor")
    img = Image.open(io.BytesIO(await image.read())).convert("RGB")

    obstacle = analyze_image(img, mode)
    sentence = to_sentence(obstacle)

    # TODO (Juan): add the ElevenLabs voice clip for `sentence` (cache by sentence text).
    clip_id = uuid.uuid4().hex
    AUDIO[clip_id] = make_tone(obstacle.direction, obstacle.distance_m)
    if len(AUDIO) > 50:
        AUDIO.pop(next(iter(AUDIO)))

    return {
        "sentence": sentence,
        "distance_m": obstacle.distance_m,
        "direction": obstacle.direction,
        "height_band": obstacle.height_band,
        "label": obstacle.label,
        "audio_url": f"/audio/{clip_id}.wav",
    }


@app.get("/audio/{clip_id}.wav")
def audio(clip_id: str):
    data = AUDIO.get(clip_id)
    if data is None:
        raise HTTPException(404)
    return Response(content=data, media_type="audio/wav")
