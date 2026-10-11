import io
import os
import time
from collections import deque

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
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


def log_reading(
    endpoint: str, img: Image.Image, mode: str, warning: str, result: dict, started: float, timing: str | None = None
) -> None:
    """One line per frame in the Space's logs: what was decided, never the image. For tracing a wrong "Stop".
    Also stamps result["server_ms"] (time since the upload finished arriving; FastAPI reads the whole
    body before the endpoint runs) and logs the phone's timing of its previous frame, for lag work."""
    result["server_ms"] = round((time.perf_counter() - started) * 1000)
    o = result.get("obstacle", result)
    obstacle = "clear" if o.get("clear") else f"{o.get('distance_m')}m-{o.get('direction')}"
    extra = ""
    if "target" in result:
        extra = f" found={result['found']} match={result['match']} bearing={result['bearing_deg']} dist={result['distance_m']}"
    phone = f" phone[{timing[:120]}]" if timing else ""
    print(
        f"{endpoint} {img.size[0]}x{img.size[1]} scene={mode} warning={warning} obstacle={obstacle}{extra}"
        f" server_ms={result['server_ms']}{phone}",
        flush=True,
    )


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
    started = time.perf_counter()
    img, mode = await read_frame(image, mode, warning, units)
    # Models run in a worker thread so a sonar frame and a tap don't wait on each other.
    result = await run_in_threadpool(pipeline.describe, img, mode, warning, units)
    result["scene"] = mode
    log_reading("describe", img, mode, warning, result, started)
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
# Find's two phases: Search (standing still, target only) hands off to Approach (walking, guide + target).
ARRIVAL_PHRASES |= {
    "Got it. Walk toward it. I'll warn you about anything in the way.",
    "Lost it. Stop and turn slowly.",
    "Stand still while I look.",
    # A full turn with no sighting (App.tsx NOT_IN_SIGHT_PHRASE / SEARCH_AGAIN_PHRASE).
    "Not in sight from here. Walk forward a few steps, then stop.",
    "Now stop, and turn slowly again.",
}
# Approach detour: something in the way while walking toward the target. Mirrors the DETOUR_*
# phrases in app/App.tsx. The user keeps the phone pointed at the target and steps sideways.
DETOUR_PHRASES = {
    "Something close on your right. Step to your left.",
    "Something close on your left. Step to your right.",
    "Something close ahead. Step to your left.",
    "Something close ahead. Step to your right.",
    "Stop. Step to your left.",
    "Stop. Step to your right.",
    "Clear. Now turn right until it's in front of you.",
    "Clear. Now turn left until it's in front of you.",
    "Still blocked. Back up a step.",
}
# Short status messages the app says with tell(), so they come in the chosen voice like everything
# else (otherwise the phone's own voice cuts in). Mirrors the tell() calls in app/App.tsx.
STATUS_PHRASES = {
    "Find off", "Still checking.", "Nothing to repeat yet. Tap anywhere to scan.",
    "Lost connection.", "No connection. Try again.",
    "Finding it. Turn slowly.",
    "Microphone access is needed to say what to find.", "I didn't catch that. Try again.",
    "I didn't catch what to find. Try again, like: find the red chair.", "Could not understand. Try again, or type it.",
    "Microphone access is needed to say the name.", "Could not hear the name. Try again, or type it.",
    "Could not rename the voice. Try again.", "Could not delete the voice. Try again.",
    "This records a trusted person for thirty seconds and makes a voice from it. "
    "Only record someone who has agreed. Double tap again to start recording.",
    "Microphone access is needed to record a voice.", "Could not start recording.",
    "Recording. Speak naturally. Tap again to stop.",
    "Adding the voice, please wait.", "Voice added.", "Could not add the voice. Try again.",
    # The reasons /voices/clone gives when it refuses (voice.VoiceRejected), which the app says aloud.
    "ElevenLabs flagged this recording. Record a real person in a quiet room.",
    f"You have {voice.MAX_CLONES} trusted voices. Delete one in Settings first.",
}
STATUS_PHRASES |= {f"Finding {t}. Turn slowly." for t in pipeline.FIND_TARGETS}
# Walker, the voice assistant (Agustin): his fixed lines, spoken in his own voice. Mirrors LINES and
# findLine in app/walkerCommands.ts.
WALKER_PHRASES = {
    "Sure thing. Let's find it.", "What should I look for?",
    "Alright, guide's on. I'll let you know what's in your way.", "Okay, guide's off.",
    "Let me take a look.", "Here it is again.", "Opening settings.", "Okay, stopping everything.",
    "Got it. Feet it is.", "Got it. Meters it is.", "Got it. I'll give you a heads up early.",
    "Got it. Normal warnings.", "Got it. I'll only warn you when things are close.", "Got it. Here's the new voice.",
    "You can say: find the door. Start walking, or stop. What is in front of me. Repeat that. "
    "Units feet, or meters. Warn me early, normal, or close. Use, and a voice name. Or settings.",
    "Sorry, say help for options.", "Yeah? What do you need?", "Sorry, I didn't catch that.",
    "Sorry, I couldn't hear you. Try again.", "I need the microphone to hear you.",
}
WALKER_PHRASES |= {f"Sure thing. Let's find the {t}." for t in pipeline.FIND_TARGETS}
# Find: keeping the target in the picture up and down. Mirrors tiltPhrase and offFramePhrase in app/App.tsx.
FRAMING_PHRASES = {
    "Tilt the phone down a little.", "Tilt the phone up a little.",
    "It's below the camera. Tilt the phone down.", "It's above the camera. Tilt the phone up.",
}
GUIDE_PHRASES = (
    guide_phrases() | pipeline.find_phrases() | ARRIVAL_PHRASES | CLOCK_PHRASES | DETOUR_PHRASES | STATUS_PHRASES
    | WALKER_PHRASES | FRAMING_PHRASES
)


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
    timing: str | None = Form(None),  # the phone's timing of its previous frame, logged for lag work
):
    """target from the picker, and/or a description like "red bench" (which can name the target itself)."""
    started = time.perf_counter()
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
    log_reading("find", img, mode, warning, result, started, timing)
    return result


# A spoken request (Find, or a voice-navigation command) is a few seconds. Both limits keep the
# public Space from being a free transcription service on the ElevenLabs credits. 60 a minute, shared
# by everyone, leaves room for voice navigation with several phones testing at once.
TRANSCRIBE_MAX_BYTES = 500_000
TRANSCRIBE_PER_MINUTE = 60
_transcribe_times: deque[float] = deque()


# Words that start a Find request. When several people are heard, the one who said one of these is
# the user; the text is cut to start at the last one, so chatter before "find" is dropped.
ASK_WORDS = {"find", "where", "where's", "look", "looking", "search", "show", "take", "locate"}
# Text with no ask word that describes something outside the 13 in more words than this is more
# likely overheard talk than a request ("he said the game was great"), so nothing is searched and
# the user is asked again. With an ask word ("find the green dragon toy on the shelf") any length
# is a request.
OPEN_VOCAB_MAX_WORDS = 4


def asks(text: str) -> bool:
    return any(w.strip(".,!?").lower() in ASK_WORDS for w in text.split())


def pick_request(full: str, by_speaker: list[str]) -> str:
    """The user's words out of everything heard: the speaker who asked, else whoever spoke first."""
    text = full
    if len(by_speaker) > 1:
        asked = [s for s in by_speaker if asks(s)]
        text = asked[-1] if asked else by_speaker[0]
    words = text.split()
    starts = [i for i, w in enumerate(words) if w.strip(".,!?").lower() in ASK_WORDS]
    return " ".join(words[starts[-1]:]) if starts else text


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
        full, by_speaker = await run_in_threadpool(
            voice.transcribe, data, audio.filename or "request.m4a", audio.content_type or "audio/m4a"
        )
    except requests.HTTPError as e:
        detail = e.response.text[:300] if e.response is not None else str(e)
        raise HTTPException(502, f"ElevenLabs speech-to-text refused: {detail}")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs unreachable: {e}")
    text = pick_request(full, by_speaker)
    target, description = pipeline.parse_request(text)
    open_vocab = target is None
    if open_vocab and description and not asks(text) and len(description.split()) > OPEN_VOCAB_MAX_WORDS:
        # Doesn't sound like a thing to find. The app asks again instead of searching for it.
        return {"text": text, "heard": full, "target": None, "description": description, "open_vocab": False}
    if open_vocab:
        # Not one of the 13: /find searches for the words themselves ("door", "exit sign").
        target = pipeline.open_query(description)
    # heard: everything said, before the cut to the request. Walker needs it to hear his name.
    return {"text": text, "heard": full, "target": target, "description": description, "open_vocab": open_vocab and target is not None}


@app.get("/voices")
async def voices():
    return {"default": voice.default_voice_id(), "voices": await run_in_threadpool(voice.list_voices)}


# The Space is public, so changing the voices (clone, rename, delete) needs a key the app sends as
# X-App-Key (APP_KEY in .env and the Space's secrets, EXPO_PUBLIC_APP_KEY in app/.env). With no
# APP_KEY set, as on a laptop, everything is open.
def require_app_key(x_app_key: str | None = Header(None)):
    expected = os.getenv("APP_KEY")
    if expected and x_app_key != expected:
        raise HTTPException(401, "this app isn't allowed to change voices")


@app.post("/voices/clone", dependencies=[Depends(require_app_key)])
async def clone_voice(audio: UploadFile = File(...), consent: str = Form("false"), name: str = Form("")):
    """Clone a trusted person's voice from a short recording. Needs an ElevenLabs plan with cloning."""
    if consent != "true":
        raise HTTPException(400, "consent must be true: only record a person who has agreed")
    data = await audio.read()
    if len(data) < 20_000:
        raise HTTPException(400, "recording too short")
    try:
        return await run_in_threadpool(
            voice.clone_voice, data, audio.filename or "voice.m4a", audio.content_type or "audio/m4a", name
        )
    except voice.VoiceRejected as e:
        raise HTTPException(422, str(e))
    except requests.HTTPError as e:
        detail = e.response.text[:300] if e.response is not None else str(e)
        raise HTTPException(502, f"ElevenLabs refused the clone: {detail}")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs unreachable: {e}")


@app.post("/voices/{voice_id}/name", dependencies=[Depends(require_app_key)])
async def rename_voice(voice_id: str, name: str = Form(...)):
    """Rename a trusted (cloned) voice. The premade voices can't be renamed."""
    name = name.strip()[: voice.NAME_MAX_CHARS]
    if not name:
        raise HTTPException(400, "name is empty")
    try:
        return await run_in_threadpool(voice.rename_voice, voice_id, name)
    except KeyError:
        raise HTTPException(404, "not a trusted voice")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs refused the rename: {e}")


@app.delete("/voices/{voice_id}", dependencies=[Depends(require_app_key)])
async def delete_voice(voice_id: str):
    """Delete a trusted (cloned) voice. The premade voices can't be deleted."""
    try:
        await run_in_threadpool(voice.delete_voice, voice_id)
    except KeyError:
        raise HTTPException(404, "not a trusted voice")
    except requests.RequestException as e:
        raise HTTPException(502, f"ElevenLabs refused the delete: {e}")
    return {"deleted": voice_id}


@app.get("/voices/{voice_id}/sample.wav")
async def voice_sample(voice_id: str):
    if voice_id not in {v["id"] for v in voice.list_voices()}:
        raise HTTPException(404, "unknown voice")
    wav = await run_in_threadpool(voice.speak_wav, voice.SAMPLE_SENTENCE, voice_id)
    if wav is None:
        raise HTTPException(503, "voice unavailable")
    return Response(content=wav, media_type="audio/wav")


@app.post("/sonar")
async def sonar(
    image: UploadFile = File(...),
    mode: str = Form("indoor"),
    warning: str = Form("normal"),
    timing: str | None = Form(None),  # the phone's timing of its previous frame, logged for lag work
):
    started = time.perf_counter()
    img, mode = await read_frame(image, mode, warning)
    result = await run_in_threadpool(pipeline.sonar, img, mode, warning)
    result["scene"] = mode
    log_reading("sonar", img, mode, warning, result, started, timing)
    return result


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
